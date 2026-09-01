package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// The cluster the wildcard DNS record actually points at, which is the Rancher
// serving the extension -- and the only cluster this controller has credentials
// for. See reconcileEnvironment.
const HostClusterID = "local"

// Condition types on an Environment.
const (
	// ConditionResolved is whether the controller could work out what to build.
	ConditionResolved = "Resolved"
	// ConditionProvisioned is whether every object it needs now exists.
	ConditionProvisioned = "Provisioned"
)

// clusterDefaults describes the host cluster: what ingress class it runs, what
// domain it answers on, how it issues certificates, and which nested CIDRs are
// free of its own.
//
// Read off the host cluster by hostDefaults(), not handed over by the extension.
// See that function for why.
type clusterDefaults struct {
	BaseDomain    string
	ServerVersion string
	IngressClass  string
	StorageClass  string
	ClusterIssuer string
	IssuerKind    string

	ACME *acmeSource

	NestedPodCIDR     string
	NestedServiceCIDR string
}

// reconcileEnvironments brings every Environment's objects into line with its
// spec.
//
// A full pass rather than watches, for the same reason the hop resync is one:
// the job is idempotent and converges from any starting state, so a missed event
// costs one interval rather than needing recovery code.
func (c *controller) reconcileEnvironments(ctx context.Context) error {
	envs, err := c.envs.List(ctx)
	if err != nil {
		// A cluster where the CRD is not installed is not an error: the hop
		// resync is this controller's other job and must keep running.
		if apierrors.IsNotFound(err) {
			return nil
		}

		return fmt.Errorf("listing environments: %w", err)
	}

	for i := range envs {
		env := &envs[i]

		// One environment failing must not stop the others.
		if err := c.reconcileEnvironment(ctx, env); err != nil {
			log.Printf("%s: %v", env.Name, err)
		}
	}

	// Only reached on a successful list, which is the whole safety property --
	// see reapBundles.
	return c.reapBundles(ctx, envs)
}

func (c *controller) reconcileEnvironment(ctx context.Context, env *Environment) error {
	// Deletion is the garbage collector's job: every object carries an owner
	// reference back to the Environment, so removing it collects the lot --
	// including the build Job's pods, which the extension has to sweep by hand
	// because a DELETE on a Job defaults to Orphan propagation.
	if env.DeletionTimestamp != nil {
		return nil
	}

	spec, hop, err := c.resolve(ctx, env)
	if err != nil {
		setCondition(env, ConditionResolved, "False", "ResolveFailed", err.Error())

		return c.writeStatus(ctx, env)
	}

	delivery, err := c.backendFor(ctx, env)
	if err != nil {
		setCondition(env, ConditionResolved, "False", "ClusterNotFound", err.Error())

		return c.writeStatus(ctx, env)
	}

	setCondition(env, ConditionResolved, "True", "Resolved", "")

	// Named once and remembered, rather than derived from the clock each pass.
	// The build Job's name is part of what desiredObjects() renders, and a name
	// that moved every pass would mean a backend that upserts creating and
	// deleting a Job forever.
	if env.Status.BuildID == "" {
		env.Status.BuildID = strconv.FormatInt(time.Now().Unix(), 10)
	}

	password, err := c.ensurePassword(ctx, spec)
	if err != nil {
		setCondition(env, ConditionProvisioned, "False", "ProvisionFailed", err.Error())
		_ = c.writeStatus(ctx, env)

		return err
	}

	if err := delivery.Apply(ctx, spec, password, env.Status.BuildID, env.Spec.Running); err != nil {
		setCondition(env, ConditionProvisioned, "False", "ProvisionFailed", err.Error())
		_ = c.writeStatus(ctx, env)

		return err
	}

	// The hop lives on the host cluster, whichever cluster the workload runs on,
	// so it is always written directly and never through a Bundle.
	if err := c.applyHop(ctx, spec, hop); err != nil {
		setCondition(env, ConditionProvisioned, "False", "HopFailed", err.Error())
		_ = c.writeStatus(ctx, env)

		return err
	}

	setCondition(env, ConditionProvisioned, "True", "Provisioned", provisionedMessage(env))

	seen, err := delivery.Observe(ctx, spec, env.Spec.Running)
	if err != nil {
		return err
	}

	return c.recordStatus(ctx, env, spec, hop, seen)
}

// applyHop creates the objects that let the host cluster front a downstream
// environment. Create-if-absent like everything else, and a no-op when there is
// no hop to build.
func (c *controller) applyHop(ctx context.Context, spec *renderSpec, hop *Hop) error {
	if hop == nil {
		return nil
	}

	for _, m := range spec.hopObjects(hop) {
		if err := c.ensure(ctx, m.GVK.Kind, m.Name, c.createFor(ctx, spec.Namespace, m)); err != nil {
			return err
		}
	}

	return nil
}

// provisionedMessage says what this environment's delivery cannot tell you.
//
// Empty for the host cluster, where everything is readable. Downstream the build
// Job runs on a cluster nothing mirrors Jobs back from, so status.build stays
// Unknown -- and a reader deserves to be told that rather than left wondering
// why it never moves.
func provisionedMessage(env *Environment) string {
	if isHostCluster(env.Spec.ClusterID) {
		return ""
	}

	return "delivered by Fleet; build state is not observable from the host cluster"
}

func isHostCluster(clusterID string) bool {
	return clusterID == "" || clusterID == HostClusterID
}

// resolve fills in everything the spec left to the controller.
//
// A field set in the spec is a pin and wins outright; everything else comes from
// the cluster's recorded defaults. What it settles on is written to
// status.resolved, so the answer is visible without re-deriving it.
func (c *controller) resolve(ctx context.Context, env *Environment) (*renderSpec, *Hop, error) {
	host := isHostCluster(env.Spec.ClusterID)

	defaults, err := c.hostDefaults(ctx)
	if err != nil {
		return nil, nil, err
	}

	spec := &renderSpec{
		Name:          env.Name,
		Namespace:     env.Namespace,
		Owner:         env.Spec.Owner,
		Repo:          env.Spec.Repo,
		Branch:        env.Spec.Branch,
		GitSecretName: env.Spec.GitSecretName,
		EntryPort:     env.Spec.EntryPort,
		DataSizeGB:    env.Spec.DataSizeGB,
		UISizeGB:      env.Spec.UISizeGB,
		CacheSizeGB:   env.Spec.CacheSizeGB,
		OwnerRef:      ownerRefFor(env),
	}

	// BackendImage and the hostname are host-cluster answers wherever the
	// workload runs: the image is chosen against the host Rancher's own version,
	// and the hostname comes off the host's wildcard, which is the only DNS that
	// resolves to anything either way.
	spec.BackendImage = pick(env.Spec.BackendImage, BackendImageForBranch(env.Spec.Branch, defaults.ServerVersion))

	// Everything below describes the *target* cluster, and hostDefaults only
	// ever describes the host -- so for a downstream environment these can only
	// come from the spec. See requirePinned.
	if host {
		spec.IngressClass = pick(env.Spec.IngressClass, defaults.IngressClass)
		spec.StorageClass = pick(env.Spec.StorageClass, defaults.StorageClass)
		spec.ClusterIssuer = pick(env.Spec.ClusterIssuer, defaults.ClusterIssuer)
		spec.IssuerKind = pick(env.Spec.IssuerKind, defaults.IssuerKind)
		spec.NestedPodCIDR = pick(env.Spec.NestedPodCIDR, defaults.NestedPodCIDR)
		spec.NestedServiceCIDR = pick(env.Spec.NestedServiceCIDR, defaults.NestedServiceCIDR)

		spec.ACME = env.Spec.ACME
		if spec.ACME == nil && defaults.ACME != nil {
			spec.ACME = defaults.ACME.Spec
		}

		// A pinned ACME spec with no issuer name would produce an Ingress
		// annotated for an issuer that was never created.
		if spec.ACME != nil && spec.ClusterIssuer == "" {
			spec.ClusterIssuer = IssuerName
			spec.IssuerKind = "Issuer"
		}
	} else {
		spec.IngressClass = env.Spec.IngressClass
		spec.StorageClass = env.Spec.StorageClass
		spec.NestedPodCIDR = env.Spec.NestedPodCIDR
		spec.NestedServiceCIDR = env.Spec.NestedServiceCIDR

		// No issuer on the target, deliberately. A downstream environment is
		// fronted from the host cluster and TLS terminates there, so the target
		// needs no cert-manager at all -- and falling back to the host's issuer
		// here would annotate the downstream Ingress for an issuer on a
		// different cluster. ingress() omits TLS and annotations entirely when
		// ClusterIssuer is empty, so there is nothing else to do.
		spec.ClusterIssuer = env.Spec.ClusterIssuer
		spec.IssuerKind = env.Spec.IssuerKind
		spec.ACME = env.Spec.ACME
	}

	spec.Hostname = env.Spec.Hostname
	if spec.Hostname == "" {
		if defaults.BaseDomain == "" {
			return nil, nil, fmt.Errorf("no spec.hostname, and this Rancher's server-url gives no domain to compose one from")
		}

		spec.Hostname = env.Name + "." + defaults.BaseDomain
	}

	if !host {
		if err := requirePinned(env, spec); err != nil {
			return nil, nil, err
		}
	}

	if spec.IngressClass == "" {
		return nil, nil, fmt.Errorf("no spec.ingressClass, and the host cluster publishes no IngressClass to fall back on")
	}

	if spec.NestedPodCIDR == "" || spec.NestedServiceCIDR == "" {
		// Defaulting these blindly is the one shortcut that must not be taken:
		// a nested k3s sharing the host's CIDRs cannot reach its own CoreDNS,
		// and nothing in the environment recovers from it.
		return nil, nil, fmt.Errorf("no nested CIDRs in spec, and none could be picked that miss the host cluster's own")
	}

	hop, err := c.resolveHop(ctx, env, defaults)
	if err != nil {
		return nil, nil, err
	}

	return spec, hop, nil
}

// resolveHop works out how the host cluster should front a downstream
// environment, and returns nil when it should not front one at all.
//
// Everything here describes the *host*: its ingress class, its issuer, its
// wildcard. hostDefaults reads exactly that, which is why it is the right source
// here and the wrong one for the target's own settings.
//
// The addresses are the target's, and are the one part that drifts -- replacing
// a node changes them -- which is what reconcileAll's resync exists for. They
// come from the nodes Rancher already mirrors, so no downstream credential is
// involved.
func (c *controller) resolveHop(ctx context.Context, env *Environment, defaults *clusterDefaults) (*Hop, error) {
	mode, reason := Exposure(isHostCluster(env.Spec.ClusterID), defaults.IngressClass, defaults.BaseDomain)

	if mode == ExposureLocal {
		return nil, nil
	}

	if mode == ExposureDirect {
		// The environment has to be named off the target cluster's own ingress
		// instead, and that address is exactly what this controller cannot see:
		// ingressEntry() finds it by reading the target's Services and
		// DaemonSets, and management.cattle.io mirrors nodes only.
		if env.Spec.Hostname == "" || env.Spec.EntryPort == 0 {
			return nil, fmt.Errorf(
				"the host cluster cannot front an environment on %s (%s), so it has to be reached on "+
					"that cluster's own ingress -- pin spec.hostname and spec.entryPort, which the "+
					"extension discovers for you",
				env.Spec.ClusterID, reason)
		}

		// Fully pinned, so there is nothing left to discover and the Ingress
		// beside the workload serves it directly, exactly as it does for local.
		return nil, nil
	}

	nodes, err := c.nodesFor(ctx, env.Spec.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("reading nodes for %s: %w", env.Spec.ClusterID, err)
	}

	entry := AddressesFor(nodes)
	if len(entry.Addresses) == 0 {
		return nil, fmt.Errorf("no ready node on %s publishes an address to dial", env.Spec.ClusterID)
	}

	port := env.Spec.HopPort
	if port == 0 {
		port = DefaultHopPort
	}

	hop := &Hop{
		HostClusterID:   HostClusterID,
		TargetClusterID: env.Spec.ClusterID,
		Addresses:       entry.Addresses,
		AddressType:     entry.AddressType,
		Port:            port,
		IngressClass:    defaults.IngressClass,
		ClusterIssuer:   defaults.ClusterIssuer,
		IssuerKind:      defaults.IssuerKind,
	}

	if defaults.ACME != nil {
		hop.ACME = defaults.ACME.Spec

		// The host mirrors rather than owning a ClusterIssuer, so the Ingress
		// has to name the mirrored one.
		if hop.ClusterIssuer == "" {
			hop.ClusterIssuer = IssuerName
			hop.IssuerKind = "Issuer"
		}
	}

	return hop, nil
}

// requirePinned names the fields a downstream environment cannot be resolved
// without.
//
// Fleet delivers objects to the target cluster; it does not read it back. So
// nothing here can see that cluster's ingress class, its default StorageClass,
// or the CIDRs its own k3s already uses -- and hostDefaults describes the host,
// which would be the wrong answer rather than a missing one.
//
// The extension can see all four, because the browser holds a Rancher session
// for every cluster, and writes them into the spec. A hand-written Environment
// has to say them out loud.
func requirePinned(env *Environment, spec *renderSpec) error {
	var missing []string

	for _, field := range []struct {
		name  string
		value string
	}{
		{"spec.ingressClass", spec.IngressClass},
		{"spec.storageClass", spec.StorageClass},
		{"spec.nestedPodCidr", spec.NestedPodCIDR},
		{"spec.nestedServiceCidr", spec.NestedServiceCIDR},
	} {
		if field.value == "" {
			missing = append(missing, field.name)
		}
	}

	if len(missing) == 0 {
		return nil
	}

	return fmt.Errorf(
		"%s runs on %s, which this controller delivers to through Fleet and cannot read back -- "+
			"so %s must be set in the spec; the extension discovers them for you",
		env.Name, env.Spec.ClusterID, strings.Join(missing, ", "))
}

// provision creates whatever is missing, and leaves whatever is there alone.
//
// Create-if-absent rather than apply, deliberately. An environment is a dev
// instance people poke at -- an image swapped by hand, a resource limit raised
// to get one build through -- and a controller that reverted those every 30
// seconds would be worse than useless. Replicas are the exception, because that
// is the field spec.running actually means; see setRunning.
func (c *controller) provision(ctx context.Context, spec *renderSpec, password, buildID string, replicas int32) error {
	for _, m := range desiredObjects(spec, password, buildID, replicas) {
		create := c.createFor(ctx, spec.Namespace, m)

		if m.Shared {
			// One per namespace, shared by every environment in it. The second
			// environment in a namespace would otherwise abort its whole create
			// on the Issuer the first one quite correctly left behind.
			if err := c.ensure(ctx, m.GVK.Kind, m.Name, create); err != nil {
				return err
			}

			continue
		}

		if err := c.ensure(ctx, m.GVK.Kind, m.Name, create); err != nil {
			return err
		}
	}

	return nil
}

// createFor turns a rendered object into the typed client call that creates it.
//
// A type switch rather than a dynamic client: these are the eight kinds an
// environment is made of, they are not going to grow by surprise, and the typed
// clients give the compiler something to check.
func (c *controller) createFor(ctx context.Context, namespace string, m manifest) func() error {
	switch object := m.Object.(type) {
	case *corev1.Secret:
		return func() error {
			_, err := c.core.CoreV1().Secrets(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *corev1.ConfigMap:
		return func() error {
			_, err := c.core.CoreV1().ConfigMaps(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *corev1.PersistentVolumeClaim:
		return func() error {
			_, err := c.core.CoreV1().PersistentVolumeClaims(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *corev1.Service:
		return func() error {
			_, err := c.core.CoreV1().Services(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *appsv1.Deployment:
		return func() error {
			_, err := c.core.AppsV1().Deployments(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *discoveryv1.EndpointSlice:
		return func() error {
			_, err := c.core.DiscoveryV1().EndpointSlices(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *networkingv1.Ingress:
		return func() error {
			_, err := c.core.NetworkingV1().Ingresses(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *batchv1.Job:
		return func() error {
			_, err := c.core.BatchV1().Jobs(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	case *unstructured.Unstructured:
		// The mirrored cert-manager Issuer and traefik's ServersTransport.
		// Unstructured because neither project's types are vendored and two
		// objects do not justify the dependencies.
		//
		// Dispatched on the GVK rather than on the Go type, which both share --
		// assuming it was always the Issuer sent a ServersTransport to
		// cert-manager's endpoint and got "the API version in the data does not
		// match the expected API version" back.
		resource, ok := dynamicResources[object.GroupVersionKind()]
		if !ok {
			return func() error {
				return fmt.Errorf("no resource mapping for %s", object.GroupVersionKind())
			}
		}

		return func() error {
			_, err := c.dyn.Resource(resource).Namespace(namespace).Create(ctx, object, metav1.CreateOptions{})

			return err
		}
	default:
		return func() error {
			return fmt.Errorf("no way to create a %T", m.Object)
		}
	}
}

// ensurePassword returns this environment's bootstrap password, generating one
// on the first pass and reading it back on every pass after.
//
// The Secret is the store, not a copy of it. Generating a fresh password each
// pass and letting create-if-absent throw it away happens to work while the only
// backend creates once -- but it means the value in hand disagrees with the
// value in the cluster from the second pass onward, and any backend that
// rewrites rather than creates would lock the owner out of a Rancher already
// bootstrapped with the old one.
func (c *controller) ensurePassword(ctx context.Context, spec *renderSpec) (string, error) {
	existing, err := c.core.CoreV1().Secrets(spec.Namespace).Get(ctx, spec.bootstrapSecretName(), metav1.GetOptions{})
	if err == nil {
		if password := string(existing.Data["password"]); password != "" {
			return password, nil
		}

		// Present but empty. Generating a replacement would not help -- the
		// backend has already read whatever is there -- so say so rather than
		// quietly bootstrapping with a password nobody has.
		return "", fmt.Errorf("%s has no password key", spec.bootstrapSecretName())
	}

	if !apierrors.IsNotFound(err) {
		return "", fmt.Errorf("reading the bootstrap secret: %w", err)
	}

	password, err := generatePassword()
	if err != nil {
		return "", err
	}

	// Written here rather than left to the delivery backend, because for a
	// downstream environment the backend writes it somewhere this controller
	// cannot read back -- so the next pass would generate a different one, and
	// keep rewriting the password under a Rancher that has already been
	// bootstrapped with the last.
	//
	// It doubles as the copy status.bootstrapSecret names, which is the only way
	// the owner of a downstream environment can actually read their password.
	created, err := c.core.CoreV1().Secrets(spec.Namespace).Create(ctx, spec.bootstrapSecret(password), metav1.CreateOptions{})
	if err == nil {
		log.Printf("%s: created Secret %s", spec.Name, spec.bootstrapSecretName())

		return password, nil
	}

	if !apierrors.IsAlreadyExists(err) {
		return "", fmt.Errorf("creating the bootstrap secret: %w", err)
	}

	// Lost a race with another pass. Whoever won holds the real value.
	created, err = c.core.CoreV1().Secrets(spec.Namespace).Get(ctx, spec.bootstrapSecretName(), metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("re-reading the bootstrap secret: %w", err)
	}

	return string(created.Data["password"]), nil
}

// ensure runs create and treats "already exists" as the success it is.
func (c *controller) ensure(ctx context.Context, kind, name string, create func() error) error {
	err := create()

	switch {
	case err == nil:
		log.Printf("%s: created %s %s", name, kind, name)

		return nil
	case apierrors.IsAlreadyExists(err):
		return nil
	default:
		return fmt.Errorf("creating %s %s: %w", kind, name, err)
	}
}

// setRunning scales both Deployments to match spec.running.
//
// Everything else is deliberately left in place -- the volumes, the Services,
// the Ingress -- so a stopped environment keeps its data, its hostname and its
// bootstrap password, and gives back only what costs something while idle.
//
// Order matters in one direction. nginx comes up first on a start so the bundle
// is already being served when the backend fetches ui-dashboard-index. On a stop
// the backend goes first, because it is the one holding the volume and the
// memory.
func (c *controller) setRunning(ctx context.Context, spec *renderSpec, running bool) error {
	names := []string{spec.Name, spec.uiName()}

	if running {
		names = []string{spec.uiName(), spec.Name}
	}

	replicas := replicasFor(running)

	for _, name := range names {
		if err := c.scale(ctx, spec.Namespace, name, replicas); err != nil {
			return err
		}
	}

	return nil
}

func (c *controller) scale(ctx context.Context, namespace, name string, replicas int32) error {
	deployment, err := c.core.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		// A Deployment that cannot be read is skipped rather than treated as a
		// failure: provision() creates them, and this pass may simply have
		// arrived first.
		if apierrors.IsNotFound(err) {
			return nil
		}

		return err
	}

	if deployment.Spec.Replicas != nil && *deployment.Spec.Replicas == replicas {
		return nil
	}

	deployment.Spec.Replicas = &replicas

	if _, err := c.core.AppsV1().Deployments(namespace).Update(ctx, deployment, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("scaling %s to %d: %w", name, replicas, err)
	}

	log.Printf("%s: scaled to %d", name, replicas)

	return nil
}

// observe reads the environment's real state back and records it.
// observeDirect reads an environment's real state back off the cluster it runs
// on. Only available for the host cluster; see fleetBackend.Observe for what
// replaces it downstream.
func (c *controller) observeDirect(ctx context.Context, spec *renderSpec) (observation, error) {
	jobs, err := c.jobsFor(ctx, spec.Name)
	if err != nil {
		return observation{}, err
	}

	deployment, err := c.core.AppsV1().Deployments(spec.Namespace).Get(ctx, spec.Name, metav1.GetOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return observation{}, err
	}

	if apierrors.IsNotFound(err) {
		deployment = nil
	}

	return observation{Build: BuildStateOf(jobs), Run: RunStateOf(deployment)}, nil
}

// recordStatus writes back what the environment resolved to and what it is
// doing, whichever backend found it out.
func (c *controller) recordStatus(
	ctx context.Context, env *Environment, spec *renderSpec, hop *Hop, seen observation,
) error {
	exposure := ExposureLocal

	switch {
	case hop != nil:
		exposure = ExposureHop
	case !isHostCluster(env.Spec.ClusterID):
		// Downstream with no hop means the host could not front it and the spec
		// pinned its own address instead -- see resolveHop.
		exposure = ExposureDirect
	}

	env.Status.URL = spec.EnvironmentURL()
	env.Status.SharedBundleURL = spec.SharedBundleURL()
	env.Status.Build = seen.Build
	env.Status.Run = seen.Run
	env.Status.BootstrapSecret = spec.bootstrapSecretName()
	env.Status.ObservedGeneration = env.Generation
	env.Status.Resolved = ResolvedSpec{
		BackendImage:      spec.BackendImage,
		Hostname:          spec.Hostname,
		EntryPort:         spec.EntryPort,
		IngressClass:      spec.IngressClass,
		StorageClass:      spec.StorageClass,
		ClusterIssuer:     spec.ClusterIssuer,
		IssuerKind:        spec.IssuerKind,
		NestedPodCIDR:     spec.NestedPodCIDR,
		NestedServiceCIDR: spec.NestedServiceCIDR,
		Exposure:          exposure,
		Hop:               hop,
	}

	return c.writeStatus(ctx, env)
}

func (c *controller) jobsFor(ctx context.Context, name string) ([]batchv1.Job, error) {
	list, err := c.core.BatchV1().Jobs(Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s,%s=%s", LabelName, name, LabelRole, RoleBuild),
	})
	if err != nil {
		return nil, fmt.Errorf("listing build jobs: %w", err)
	}

	return list.Items, nil
}

// BuildStateOf reads the state of the most recent build.
func BuildStateOf(jobs []batchv1.Job) string {
	if len(jobs) == 0 {
		return BuildUnknown
	}

	// Newest first, so a rebuild's state wins over the build it replaced.
	sort.Slice(jobs, func(i, j int) bool {
		return jobs[j].CreationTimestamp.Before(&jobs[i].CreationTimestamp)
	})

	switch latest := jobs[0]; {
	case latest.Status.Succeeded > 0:
		return BuildReady
	case latest.Status.Failed > 0:
		return BuildFailed
	default:
		return BuildBuilding
	}
}

// RunStateOf reads whether the workload is running from the backend Deployment.
//
// Desired replicas is the entire record of stopped-ness: an environment someone
// stopped with `kubectl scale` reads as stopped here, and there is no second
// copy of the truth to drift from the first.
//
// Stopping is worth separating from Stopped because the backend's pod holds the
// RWO data volume until it is gone, and a start issued in that window produces a
// pod stuck Pending on a volume still attached elsewhere.
func RunStateOf(backend *appsv1.Deployment) string {
	if backend == nil {
		return RunPending
	}

	// Absent only if the object arrives unnormalised; the API server defaults it
	// to 1. Reading that as stopped would be the damaging way to be wrong.
	desired := int32(1)
	if backend.Spec.Replicas != nil {
		desired = *backend.Spec.Replicas
	}

	if desired == 0 {
		if backend.Status.Replicas > 0 {
			return RunStopping
		}

		return RunStopped
	}

	if backend.Status.ReadyReplicas > 0 {
		return RunReady
	}

	return RunPending
}

// writeStatus writes only when something changed. A controller that rewrote an
// identical status every pass would produce a resourceVersion bump every 30
// seconds on every environment, which is noise for anything watching.
func (c *controller) writeStatus(ctx context.Context, env *Environment) error {
	current, err := c.envs.Get(ctx, env.Name)
	if err != nil {
		return err
	}

	if reflect.DeepEqual(current.Status, env.Status) {
		return nil
	}

	current.Status = env.Status

	return c.envs.UpdateStatus(ctx, current)
}

// setCondition records a condition, leaving lastTransitionTime alone when only
// the message changed -- the timestamp is meant to say when the state last
// flipped, not when it was last confirmed.
func setCondition(env *Environment, kind, status, reason, message string) {
	next := Condition{
		Type:               kind,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
		ObservedGeneration: env.Generation,
	}

	for i, existing := range env.Status.Conditions {
		if existing.Type != kind {
			continue
		}

		if existing.Status == status {
			next.LastTransitionTime = existing.LastTransitionTime
		}

		env.Status.Conditions[i] = next

		return
	}

	env.Status.Conditions = append(env.Status.Conditions, next)
}

func ownerRefFor(env *Environment) metav1.OwnerReference {
	controller := true

	return metav1.OwnerReference{
		APIVersion: environments.GroupVersion().String(),
		Kind:       "Environment",
		Name:       env.Name,
		UID:        env.UID,
		Controller: &controller,
	}
}

// generatePassword produces the Rancher bootstrap password.
//
// URL-safe base64 of 15 random bytes: 120 bits, and no character that has to be
// escaped when someone pastes it into a login form or a shell.
func generatePassword() (string, error) {
	buf := make([]byte, 15)

	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generating a bootstrap password: %w", err)
	}

	return strings.TrimRight(base64.URLEncoding.EncodeToString(buf), "="), nil
}

// replicasFor is the whole of what spec.running means to a Deployment.
func replicasFor(running bool) int32 {
	if running {
		return 1
	}

	return 0
}

func pick(value, fallback string) string {
	if value != "" {
		return value
	}

	return fallback
}
