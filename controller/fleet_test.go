package main

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"
)

func testFleetBackend() *fleetBackend {
	return &fleetBackend{
		clusterID: "c-m-qfnvhpnb",
		workspace: DefaultFleetWorkspace,
		uid:       "8b1a9953-c461-4f5e-9b8f-1a2b3c4d5e6f",
	}
}

// bundleSpec digs the spec out of a rendered Bundle, which is unstructured
// because Fleet's types are not vendored.
func bundleSpec(t *testing.T, f *fleetBackend, spec *renderSpec) map[string]any {
	t.Helper()

	bundle, err := f.bundleFor(spec, desiredObjects(spec, "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	out, ok := bundle.Object["spec"].(map[string]any)
	if !ok {
		t.Fatal("the bundle has no spec")
	}

	return out
}

func TestBundleTargetsByClusterLabel(t *testing.T) {
	// The Fleet Cluster's own name is the *provisioning* cluster's -- a display
	// name someone chose -- while everything else here speaks in c-m-... ids.
	// Selecting on the label avoids having to translate between the two.
	spec := bundleSpec(t, testFleetBackend(), testSpec())

	targets, ok := spec["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("targets = %v", spec["targets"])
	}

	selector, _ := targets[0].(map[string]any)["clusterSelector"].(map[string]any)
	labels, _ := selector["matchLabels"].(map[string]any)

	if labels[LabelFleetCluster] != "c-m-qfnvhpnb" {
		t.Errorf("matchLabels = %v", labels)
	}
}

func TestBundleLeavesFleetsDefaultsAlone(t *testing.T) {
	spec := bundleSpec(t, testFleetBackend(), testSpec())

	// correctDrift unset means Fleet reports drift and does not revert it, which
	// is the same posture provision() takes on the host cluster: these are dev
	// instances people poke at, and reverting a hand-raised limit every thirty
	// seconds would be worse than useless.
	//
	// keepResources unset means deleting the Bundle takes the workload with it,
	// which is the whole deletion story downstream.
	//
	// deleteNamespace unset because rancher-remuda on the far side is shared by
	// every environment on that cluster, and the first delete must not take it.
	for _, key := range []string{"correctDrift", "keepResources", "deleteNamespace"} {
		if _, found := spec[key]; found {
			t.Errorf("%s is set; Fleet's default is the behaviour we want", key)
		}
	}

	if spec["defaultNamespace"] != "rancher-remuda" {
		t.Errorf("defaultNamespace = %v", spec["defaultNamespace"])
	}
}

func TestBundleResourcesCarryApiVersionAndKind(t *testing.T) {
	// A typed object out of client-go has an empty TypeMeta. The direct backend
	// does not care, because the client it calls already knows the type; a
	// serialised manifest very much does, and one without them is not applyable.
	spec := bundleSpec(t, testFleetBackend(), testSpec())

	resources, _ := spec["resources"].([]any)
	if len(resources) == 0 {
		t.Fatal("the bundle carries no resources")
	}

	for _, raw := range resources {
		entry, _ := raw.(map[string]any)
		content, _ := entry["content"].(string)

		var object map[string]any
		if err := yaml.Unmarshal([]byte(content), &object); err != nil {
			t.Fatalf("%v: %v", entry["name"], err)
		}

		if object["apiVersion"] == "" || object["apiVersion"] == nil {
			t.Errorf("%v has no apiVersion", entry["name"])
		}

		if object["kind"] == "" || object["kind"] == nil {
			t.Errorf("%v has no kind", entry["name"])
		}

		// Rendered objects always carry a null creationTimestamp and an empty
		// status, and Fleet passes both through to an API server that would
		// rather not be told.
		metadata, _ := object["metadata"].(map[string]any)
		if _, found := metadata["creationTimestamp"]; found {
			t.Errorf("%v carries a creationTimestamp", entry["name"])
		}

		if _, found := object["status"]; found {
			t.Errorf("%v carries a status", entry["name"])
		}
	}
}

func TestBundleCarriesNoOwnerReferences(t *testing.T) {
	// The Environment does not exist on the target cluster, so an owner
	// reference naming its UID points at nothing -- and the collector there
	// deletes a dependent whose owner is missing, taking the whole environment
	// down seconds after Fleet creates it.
	//
	// renderSpec.OwnerRef is left zero for the Fleet path, and meta() skips it.
	spec := testSpec()
	spec.OwnerRef.UID = ""

	rendered := bundleSpec(t, testFleetBackend(), spec)

	for _, raw := range rendered["resources"].([]any) {
		entry, _ := raw.(map[string]any)

		if strings.Contains(entry["content"].(string), "ownerReferences") {
			t.Errorf("%v carries an owner reference into a cluster the owner is not on", entry["name"])
		}
	}
}

func TestBundleIsKeyedToTheEnvironmentUID(t *testing.T) {
	// The reaper matches on the UID, not the name: an environment deleted and
	// recreated under the same name would otherwise have its fresh Bundle reaped
	// by a sweep that had seen the old one.
	f := testFleetBackend()

	bundle, err := f.bundleFor(testSpec(), desiredObjects(testSpec(), "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	if got := bundle.GetLabels()[LabelEnvironmentUID]; got != f.uid {
		t.Errorf("uid label = %q, want %q", got, f.uid)
	}

	if got := bundle.GetLabels()[LabelManaged]; got != "true" {
		t.Errorf("managed label = %q -- the reaper lists on it", got)
	}
}

func TestBundleRefusesToShareTheMirroredIssuer(t *testing.T) {
	// A Bundle owns everything it declares, and the mirrored Issuer is one per
	// namespace. Two environments' Bundles both declaring it would revert each
	// other for as long as both existed, which is a far worse failure than
	// saying so up front.
	spec := testSpec()
	spec.ACME = map[string]any{"email": "a@b.c"}

	// No client is touched: the check happens before anything is read or written,
	// which is what makes this testable at all.
	err := testFleetBackend().Apply(context.Background(), spec, "pw", "1", true)
	if err == nil {
		t.Fatal("a shared Issuer was accepted into a Bundle")
	}

	for _, want := range []string{"ClusterIssuer", "c-m-qfnvhpnb"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not mention %q: %v", want, err)
		}
	}
}

func TestBundleStopsByRenderingZeroReplicas(t *testing.T) {
	// There is no Deployment here to patch, so spec.running has to reach the far
	// side as part of what the Bundle describes.
	f := testFleetBackend()

	stopped, err := f.bundleFor(testSpec(), desiredObjects(testSpec(), "pw", "1", 0))
	if err != nil {
		t.Fatal(err)
	}

	running, err := f.bundleFor(testSpec(), desiredObjects(testSpec(), "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	if renderedString(stopped) == renderedString(running) {
		t.Fatal("a stopped environment renders the same Bundle as a running one")
	}

	if !strings.Contains(renderedString(stopped), "replicas: 0") {
		t.Error("a stopped environment does not render zero replicas")
	}
}

func renderedString(bundle interface{ UnstructuredContent() map[string]any }) string {
	raw, _ := yaml.Marshal(bundle.UnstructuredContent())

	return string(raw)
}

func TestRequirePinnedNamesEveryMissingField(t *testing.T) {
	// Fleet delivers to the target cluster; it does not read it back. Nothing
	// here can see that cluster's ingress class, its default StorageClass, or the
	// CIDRs its own k3s uses -- and remuda-config describes the host, which would
	// be the wrong answer rather than a missing one.
	env := &Environment{}
	env.Name = "multi-idp"
	env.Spec.ClusterID = "c-m-qfnvhpnb"

	err := requirePinned(env, &renderSpec{})
	if err == nil {
		t.Fatal("a downstream environment with nothing pinned was accepted")
	}

	for _, want := range []string{
		"spec.ingressClass", "spec.storageClass", "spec.nestedPodCidr", "spec.nestedServiceCidr",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not name %s: %v", want, err)
		}
	}

	// Named individually rather than as a lump, so a spec missing one field is
	// not told to go and set four.
	partial := requirePinned(env, &renderSpec{
		IngressClass: "nginx", StorageClass: "local-path", NestedPodCIDR: "10.44.0.0/16",
	})
	if partial == nil || !strings.Contains(partial.Error(), "spec.nestedServiceCidr") {
		t.Errorf("a single missing field was not reported cleanly: %v", partial)
	}

	if strings.Contains(partial.Error(), "spec.ingressClass") {
		t.Error("a field that is set was reported missing")
	}

	if err := requirePinned(env, &renderSpec{
		IngressClass: "nginx", StorageClass: "local-path",
		NestedPodCIDR: "10.44.0.0/16", NestedServiceCIDR: "10.45.0.0/16",
	}); err != nil {
		t.Errorf("a fully pinned spec was rejected: %v", err)
	}
}

func TestHostClusterDetection(t *testing.T) {
	// Empty means the schema default, which is `local`.
	for _, id := range []string{"", "local"} {
		if !isHostCluster(id) {
			t.Errorf("%q should be the host cluster", id)
		}
	}

	if isHostCluster("c-m-qfnvhpnb") {
		t.Error("a downstream cluster was treated as the host")
	}

	downstream := &Environment{}
	downstream.Spec.ClusterID = "c-m-qfnvhpnb"

	// The host cluster can read everything, so there is nothing to warn about.
	if got := provisionedMessage(&Environment{}); got != "" {
		t.Errorf("provisioned message = %q, want none for the host cluster", got)
	}

	if !strings.Contains(provisionedMessage(downstream), "build state") {
		t.Error("a downstream environment is not told its build state is unobservable")
	}
}

func TestSameBundleSpecIgnoresFleetsOwnFields(t *testing.T) {
	// Measured against a live Fleet: the API server defaults
	// targetCustomizationMode into the stored spec, so a whole-spec DeepEqual
	// against what we rendered never matches and every reconcile writes -- which
	// re-renders a BundleDeployment on every agent, every interval.
	rendered := map[string]any{
		"defaultNamespace": "rancher-remuda",
		"targets":          []any{map[string]any{"clusterName": "prak-test2"}},
		"resources":        []any{map[string]any{"name": "00-secret.yaml", "content": "x"}},
	}

	stored := map[string]any{
		"defaultNamespace":        "rancher-remuda",
		"targets":                 []any{map[string]any{"clusterName": "prak-test2"}},
		"resources":               []any{map[string]any{"name": "00-secret.yaml", "content": "x"}},
		"targetCustomizationMode": "",
	}

	if !sameBundleSpec(stored, rendered) {
		t.Error("a field Fleet defaulted in was read as a difference")
	}

	// A real change still has to be noticed, or stop/start would never reach the
	// far side.
	changed := map[string]any{
		"defaultNamespace":        "rancher-remuda",
		"targets":                 []any{map[string]any{"clusterName": "prak-test2"}},
		"resources":               []any{map[string]any{"name": "00-secret.yaml", "content": "replicas: 0"}},
		"targetCustomizationMode": "",
	}

	if sameBundleSpec(changed, rendered) {
		t.Error("a changed resource was read as unchanged")
	}

	if sameBundleSpec(map[string]any{}, rendered) {
		t.Error("an empty spec was read as matching")
	}
}

func TestFleetApplyStripsTheOwnerReference(t *testing.T) {
	// Measured on a real downstream cluster: the objects arrived carrying an
	// owner reference to an Environment that exists only on the host, and
	// survived solely because that cluster had no Environment CRD for its
	// collector to resolve. Installing one there would have deleted the lot.
	//
	// Apply must therefore strip it -- and must not mutate the caller's spec,
	// which the host-side bootstrap Secret still needs it for.
	spec := testSpec()
	before := spec.OwnerRef

	f := testFleetBackend()
	target := *spec
	target.OwnerRef = metav1.OwnerReference{}

	bundle, err := f.bundleFor(&target, desiredObjects(&target, "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	rendered, _ := yaml.Marshal(bundle.Object)
	if strings.Contains(string(rendered), "ownerReferences") {
		t.Error("the Bundle carries an owner reference into another cluster")
	}

	if spec.OwnerRef != before {
		t.Error("Apply mutated the caller's spec, which the host-side Secret still needs")
	}
}
