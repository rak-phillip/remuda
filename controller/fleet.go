package main

import (
	"context"
	"fmt"
	"log"
	"reflect"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/yaml"
)

// Fleet is how an environment reaches a cluster this controller has no
// credentials for.
//
// Every Rancher ships Fleet, and every registered cluster runs a Fleet agent
// that pulls its work. So a Bundle here becomes objects there with nothing
// stored on this side -- no kubeconfig, no API token, no rotation. That is the
// entire reason the downstream path is Fleet rather than a credential: it costs
// the person installing this exactly nothing.
var (
	fleetBundles = schema.GroupVersionResource{
		Group: "fleet.cattle.io", Version: "v1alpha1", Resource: "bundles",
	}

	mgmtClusters = schema.GroupVersionResource{
		Group: "management.cattle.io", Version: "v3", Resource: "clusters",
	}
)

const (
	// LabelFleetCluster is how a Fleet Cluster records which management cluster
	// it stands for.
	//
	// Targeting on this rather than on the Fleet Cluster's own name avoids a
	// second lookup: that name is the *provisioning* cluster's, which is the
	// display name a person chose, not the c-m-... id every other part of this
	// controller uses.
	LabelFleetCluster = "management.cattle.io/cluster-name"

	// LabelEnvironmentUID keys a Bundle to the exact Environment that asked for
	// it. Not the name: an environment deleted and recreated under the same name
	// would otherwise have its fresh Bundle reaped by a sweep that saw the old.
	LabelEnvironmentUID = "remuda.rancher.io/environment-uid"

	// DefaultFleetWorkspace is where Rancher files a downstream cluster's Fleet
	// objects unless someone has moved it. `local` lives in fleet-local instead,
	// which is why the workspace is read rather than assumed.
	DefaultFleetWorkspace = "fleet-default"
)

// observation is what a backend could find out about a running environment.
// Fields it cannot answer are left empty rather than guessed.
type observation struct {
	Build string
	Run   string
}

// backend is how an environment's objects get to the cluster they run on.
//
// Two implementations, and the split is about credentials rather than taste.
// direct writes with typed clients and is only ever used for the cluster this
// controller runs on. fleet writes a Bundle and lets the agent on the far side
// apply it, which is what removes the need to hold a credential for every
// cluster Rancher knows about.
type backend interface {
	Apply(ctx context.Context, spec *renderSpec, password, buildID string, running bool) error
	Observe(ctx context.Context, spec *renderSpec, running bool) (observation, error)
	Release(ctx context.Context, spec *renderSpec) error
}

// directBackend is the host cluster, where the controller has real credentials.
type directBackend struct{ c *controller }

func (d *directBackend) Apply(ctx context.Context, spec *renderSpec, password, buildID string, running bool) error {
	if err := d.c.provision(ctx, spec, password, buildID, replicasFor(running)); err != nil {
		return err
	}

	return d.c.setRunning(ctx, spec, running)
}

func (d *directBackend) Observe(ctx context.Context, spec *renderSpec, _ bool) (observation, error) {
	return d.c.observeDirect(ctx, spec)
}

// Release does nothing: every object the direct backend creates carries an owner
// reference back to the Environment, so deleting that collects them.
func (d *directBackend) Release(context.Context, *renderSpec) error { return nil }

// fleetBackend delivers to a cluster this controller cannot talk to.
type fleetBackend struct {
	c         *controller
	clusterID string
	workspace string
	uid       string
}

func bundleName(environment string) string { return "remuda-" + environment }

// ownedBundleFields are the parts of a Bundle spec this controller sets.
// Everything else in there belongs to Fleet -- see sameBundleSpec.
var ownedBundleFields = []string{"defaultNamespace", "targets", "resources"}

// sameBundleSpec reports whether a stored Bundle already says what we want it
// to, ignoring anything Fleet maintains for itself.
func sameBundleSpec(current, desired any) bool {
	from := func(v any) map[string]any {
		out, _ := v.(map[string]any)

		return out
	}

	a, b := from(current), from(desired)

	for _, key := range ownedBundleFields {
		if !reflect.DeepEqual(a[key], b[key]) {
			return false
		}
	}

	return true
}

func (f *fleetBackend) bundles() dynamic.ResourceInterface {
	return f.c.dyn.Resource(fleetBundles).Namespace(f.workspace)
}

// Apply upserts the environment's Bundle.
//
// running feeds straight into the render rather than into a separate scale step:
// there is no Deployment here to patch, so stopping an environment means the
// Bundle now describes zero replicas and the agent reconciles the difference.
func (f *fleetBackend) Apply(ctx context.Context, spec *renderSpec, password, buildID string, running bool) error {
	// Rendered without the owner reference, because the Environment it names
	// lives here and the objects are going somewhere else. An owner reference is
	// resolved by UID on the cluster it is written to, so carried across it names
	// nothing -- and a collector that can resolve the kind deletes every
	// dependent whose owner is missing. Measured: the objects survive on a
	// cluster with no Environment CRD, which is luck rather than design, and it
	// would stop being true the moment one were installed there.
	//
	// Nothing collects the downstream objects as a result; deleting the Bundle
	// is what removes them, which is what Release does.
	target := *spec
	target.OwnerRef = metav1.OwnerReference{}

	objects := desiredObjects(&target, password, buildID, replicasFor(running))

	// The mirrored Issuer is one per namespace, shared by every environment in
	// it. A Bundle owns everything it declares, so two environments' Bundles both
	// declaring it would fight over one object -- each reverting the other, for
	// as long as both exist. Failing loudly beats that.
	for _, m := range objects {
		if m.Shared {
			return fmt.Errorf(
				"this cluster has no ClusterIssuer, so %s would have to be mirrored into it -- "+
					"which Fleet cannot share between environments; pin spec.clusterIssuer to a "+
					"ClusterIssuer that already exists on %s", m.Name, f.clusterID)
		}
	}

	desired, err := f.bundleFor(&target, objects)
	if err != nil {
		return err
	}

	current, err := f.bundles().Get(ctx, bundleName(spec.Name), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		if _, err := f.bundles().Create(ctx, desired, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("creating the bundle: %w", err)
		}

		log.Printf("%s: created Bundle %s/%s for %s", spec.Name, f.workspace, bundleName(spec.Name), f.clusterID)

		return nil
	}

	if err != nil {
		return fmt.Errorf("reading the bundle: %w", err)
	}

	// Rewriting an identical Bundle would re-render a BundleDeployment on every
	// agent every interval, which is the same churn writeStatus() avoids here.
	//
	// Compared field by field rather than whole-spec, because the two are never
	// equal: Fleet's own schema defaults targetCustomizationMode into the stored
	// object, so a DeepEqual against what we rendered always differs and every
	// pass writes. Owning three named fields also means a default Fleet adds
	// later cannot silently reintroduce the churn.
	if sameBundleSpec(current.Object["spec"], desired.Object["spec"]) {
		return nil
	}

	// Merged onto what is stored rather than replacing it, so the fields Fleet
	// maintains for itself survive the update instead of being cleared and
	// re-defaulted.
	merged := current.DeepCopy()
	mergedSpec, _ := merged.Object["spec"].(map[string]any)

	if mergedSpec == nil {
		mergedSpec = map[string]any{}
		merged.Object["spec"] = mergedSpec
	}

	for _, key := range ownedBundleFields {
		mergedSpec[key] = desired.Object["spec"].(map[string]any)[key]
	}

	merged.SetLabels(desired.GetLabels())

	if _, err := f.bundles().Update(ctx, merged, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("updating the bundle: %w", err)
	}

	log.Printf("%s: updated Bundle %s/%s", spec.Name, f.workspace, bundleName(spec.Name))

	return nil
}

// bundleFor renders an environment into a Fleet Bundle.
//
// One resource file per object, numbered. Fleet wraps the lot in a chart and
// applies it with Helm's own kind ordering, so the numbering is for whoever
// reads `kubectl get bundle -o yaml` rather than for Fleet. Helm's ordering
// already honours every dependency desiredObjects() sequences by hand.
//
// Three fields are deliberately left unset:
//
//   - correctDrift, so Fleet reports drift and does not revert it. That is the
//     same posture provision() takes on the host cluster: these are dev
//     instances people poke at, and reverting a hand-raised limit every thirty
//     seconds would be worse than useless. Fleet actually improves on the direct
//     backend here, which cannot see drift at all.
//   - keepResources, so deleting the Bundle takes the workload with it. That is
//     the whole deletion story for a downstream environment.
//   - deleteNamespace, because rancher-remuda on the far side is shared by every
//     environment on that cluster and the first delete must not take it.
func (f *fleetBackend) bundleFor(spec *renderSpec, objects []manifest) (*unstructured.Unstructured, error) {
	resources := make([]any, 0, len(objects))

	for i, m := range objects {
		content, err := yamlFor(m)
		if err != nil {
			return nil, err
		}

		resources = append(resources, map[string]any{
			"name":    fmt.Sprintf("%02d-%s-%s.yaml", i, lower(m.GVK.Kind), m.Name),
			"content": string(content),
		})
	}

	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": fleetBundles.GroupVersion().String(),
		"kind":       "Bundle",
		"metadata": map[string]any{
			"name":      bundleName(spec.Name),
			"namespace": f.workspace,
			"labels": map[string]any{
				LabelManaged:        "true",
				LabelName:           spec.Name,
				LabelEnvironmentUID: f.uid,
			},
		},
		"spec": map[string]any{
			"defaultNamespace": spec.Namespace,
			"targets": []any{map[string]any{
				"clusterSelector": map[string]any{
					"matchLabels": map[string]any{LabelFleetCluster: f.clusterID},
				},
			}},
			"resources": resources,
		},
	}}, nil
}

// yamlFor renders one object the way Fleet needs it: with an apiVersion and a
// kind, which a typed object out of client-go does not carry.
func yamlFor(m manifest) ([]byte, error) {
	object, err := runtime.DefaultUnstructuredConverter.ToUnstructured(m.Object)
	if err != nil {
		return nil, fmt.Errorf("encoding %s %s: %w", m.GVK.Kind, m.Name, err)
	}

	object["apiVersion"] = m.GVK.GroupVersion().String()
	object["kind"] = m.GVK.Kind

	// Always null on a freshly rendered object, and Fleet passes it through to an
	// API server that would rather not be told.
	if metadata, ok := object["metadata"].(map[string]any); ok {
		delete(metadata, "creationTimestamp")
	}

	delete(object, "status")

	return yaml.Marshal(object)
}

// Observe derives an environment's state from its Bundle, because there is no
// Deployment here to read.
//
// spec.running comes first and short-circuits, because a Deployment scaled to
// zero is "ready" as far as Fleet is concerned: zero replicas is what the Bundle
// asked for and zero replicas is what it got.
//
// Two things are lost against the direct backend, and both are worth naming
// rather than papering over:
//
//   - Stopping. Fleet reports whether a Deployment matches its spec, not whether
//     a pod is still terminating. So a stop reads as Stopped immediately, and the
//     window where the backend's pod still holds the RWO data volume is
//     invisible. A start issued inside it still produces a pod stuck Pending on a
//     volume attached elsewhere; there is simply no longer a status that says so.
//   - Hand-scaling. status.run becomes a report of intent plus delivery rather
//     than of reality: `kubectl scale` on the far side still reads Ready here.
//     Fleet notices and says so in the Bundle's modified count, but not here.
//
// Build state is not observable at all. The build Job runs on the far side and
// nothing mirrors a Job back, so this reports Unknown rather than guessing.
func (f *fleetBackend) Observe(ctx context.Context, spec *renderSpec, running bool) (observation, error) {
	out := observation{Build: BuildUnknown}

	if !running {
		out.Run = RunStopped

		return out, nil
	}

	bundle, err := f.bundles().Get(ctx, bundleName(spec.Name), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		out.Run = RunPending

		return out, nil
	}

	if err != nil {
		return out, fmt.Errorf("reading the bundle: %w", err)
	}

	ready, _, _ := unstructured.NestedInt64(bundle.Object, "status", "summary", "ready")
	desired, _, _ := unstructured.NestedInt64(bundle.Object, "status", "summary", "desiredReady")

	// Zero desired means the selector matched no cluster: registered with Rancher
	// but not with Fleet, or still registering. Pending rather than Ready, since
	// nothing has been delivered anywhere.
	if desired == 0 || ready < desired {
		out.Run = RunPending

		return out, nil
	}

	out.Run = RunReady

	return out, nil
}

// Release removes the Bundle, which Fleet turns into removing the workload.
//
// Needed because a Bundle lives in a Fleet workspace namespace while its
// Environment lives in rancher-remuda, and Kubernetes forbids an owner reference
// across namespaces -- so nothing collects it on its own.
func (f *fleetBackend) Release(ctx context.Context, spec *renderSpec) error {
	err := f.bundles().Delete(ctx, bundleName(spec.Name), metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("deleting the bundle: %w", err)
	}

	return nil
}

// backendFor picks how this environment's objects should be delivered.
func (c *controller) backendFor(ctx context.Context, env *Environment) (backend, error) {
	if id := env.Spec.ClusterID; id == "" || id == HostClusterID {
		return &directBackend{c: c}, nil
	}

	workspace, err := c.fleetWorkspace(ctx, env.Spec.ClusterID)
	if err != nil {
		return nil, err
	}

	return &fleetBackend{
		c:         c,
		clusterID: env.Spec.ClusterID,
		workspace: workspace,
		uid:       string(env.UID),
	}, nil
}

// fleetWorkspace says which namespace a cluster's Fleet objects belong in.
//
// Read rather than assumed: `local` lives in fleet-local, everything else
// defaults to fleet-default, and an operator can move a cluster into a workspace
// of their own.
func (c *controller) fleetWorkspace(ctx context.Context, clusterID string) (string, error) {
	cluster, err := c.dyn.Resource(mgmtClusters).Get(ctx, clusterID, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return "", fmt.Errorf(
			"no cluster %q -- check spec.clusterId against `kubectl get clusters.management.cattle.io`", clusterID)
	}

	if err != nil {
		return "", fmt.Errorf("reading cluster %s: %w", clusterID, err)
	}

	workspace, _, _ := unstructured.NestedString(cluster.Object, "spec", "fleetWorkspaceName")
	if workspace == "" {
		return DefaultFleetWorkspace, nil
	}

	return workspace, nil
}

// reapBundles removes Bundles whose Environment is gone.
//
// A finalizer would be the idiomatic answer and is the wrong one here. It needs
// write access to the spec, which this controller deliberately does not have --
// what it reports goes to the status subresource and nowhere else -- and it
// leaves every Environment wedged in Terminating if the chart is ever
// uninstalled while environments still exist. A sweep costs at most one interval
// of delay and cannot wedge anything, which suits a controller that is already a
// full resync converging from any state.
//
// Only ever called after a *successful* list. An Environment that could not be
// read is not an Environment that was deleted, and reaping on a failed list
// would tear down every downstream environment the moment the CRD hiccupped.
func (c *controller) reapBundles(ctx context.Context, live []Environment) error {
	alive := map[string]bool{}
	for i := range live {
		alive[string(live[i].UID)] = true
	}

	bundles, err := c.dyn.Resource(fleetBundles).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{
		LabelSelector: LabelManaged + "=true",
	})
	if err != nil {
		// A cluster without Fleet is not an error: the host-cluster path is
		// unaffected and there is nothing here to reap.
		if apierrors.IsNotFound(err) {
			return nil
		}

		return fmt.Errorf("listing bundles: %w", err)
	}

	for i := range bundles.Items {
		bundle := &bundles.Items[i]

		uid := bundle.GetLabels()[LabelEnvironmentUID]
		if uid == "" || alive[uid] {
			continue
		}

		err := c.dyn.Resource(fleetBundles).Namespace(bundle.GetNamespace()).
			Delete(ctx, bundle.GetName(), metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			log.Printf("%s/%s: could not reap: %v", bundle.GetNamespace(), bundle.GetName(), err)

			continue
		}

		log.Printf("%s/%s: reaped, its environment is gone", bundle.GetNamespace(), bundle.GetName())
	}

	return nil
}

func lower(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'A' && r <= 'Z' {
			out[i] = r + ('a' - 'A')
		}
	}

	return string(out)
}
