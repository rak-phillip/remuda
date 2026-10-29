package main

import (
	"context"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

// The UID of an environment deleted moments ago, whose name has just been
// reused. testSpec() and testFleetBackend() are the new one.
const earlierUID = "0f0f0f0f-0000-4000-8000-000000000000"

func bundleOwnedBy(uid string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "fleet.cattle.io/v1alpha1",
		"kind":       "Bundle",
		"metadata": map[string]any{
			"name":      bundleName("multi-idp"),
			"namespace": DefaultFleetWorkspace,
			"labels": map[string]any{
				LabelManaged:        "true",
				LabelName:           "multi-idp",
				LabelEnvironmentUID: uid,
			},
		},
		"spec": map[string]any{},
	}}
}

func fleetWith(objects ...runtime.Object) (*fleetBackend, *dynamicfake.FakeDynamicClient) {
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{fleetBundles: "BundleList"}, objects...)

	f := testFleetBackend()
	f.c = &controller{dyn: dyn}

	return f, dyn
}

func TestFleetApplyRefusesAnEarlierEnvironmentsBundle(t *testing.T) {
	f, dyn := fleetWith(bundleOwnedBy(earlierUID))
	ctx := context.Background()

	err := f.Apply(ctx, testSpec(), "pw", "1", true)
	if err == nil || !strings.Contains(err.Error(), "earlier environment") {
		t.Fatalf("Apply = %v, want it to wait for the earlier bundle", err)
	}

	// Removed rather than adopted: adopting it relabelled it with the new UID
	// and kept the old release, data volume and all.
	_, err = dyn.Resource(fleetBundles).Namespace(DefaultFleetWorkspace).Get(ctx, bundleName("multi-idp"), metav1.GetOptions{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("the earlier bundle is still there: %v", err)
	}

	// Once it is gone, the next pass delivers this environment from nothing.
	if err := f.Apply(ctx, testSpec(), "pw", "1", true); err != nil {
		t.Fatalf("second Apply = %v", err)
	}

	got, err := dyn.Resource(fleetBundles).Namespace(DefaultFleetWorkspace).Get(ctx, bundleName("multi-idp"), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}

	if uid := got.GetLabels()[LabelEnvironmentUID]; uid != f.uid {
		t.Errorf("bundle UID label = %q, want %q", uid, f.uid)
	}
}

func TestFleetApplyUpdatesItsOwnBundle(t *testing.T) {
	f, _ := fleetWith(bundleOwnedBy(testFleetBackend().uid))

	if err := f.Apply(context.Background(), testSpec(), "pw", "1", true); err != nil {
		t.Errorf("Apply = %v; the bundle is this environment's own", err)
	}
}

func TestEnsurePasswordDiscardsAnEarlierEnvironmentsSecret(t *testing.T) {
	spec := testSpec()

	stale := spec.bootstrapSecret("old-password")
	stale.StringData = nil
	stale.Data = map[string][]byte{"password": []byte("old-password")}
	stale.OwnerReferences[0].UID = types.UID(earlierUID)

	core := fake.NewSimpleClientset(stale)
	c := &controller{core: core}
	ctx := context.Background()

	if _, err := c.ensurePassword(ctx, spec); err == nil {
		t.Fatal("ensurePassword handed out the password of an earlier environment's Rancher")
	}

	_, err := core.CoreV1().Secrets(spec.Namespace).Get(ctx, spec.bootstrapSecretName(), metav1.GetOptions{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("the stale secret is still there: %v", err)
	}

	password, err := c.ensurePassword(ctx, spec)
	if err != nil || password == "" || password == "old-password" {
		t.Errorf("ensurePassword = %q, %v; want a fresh password", password, err)
	}
}

func TestEnsurePasswordKeepsItsOwnSecret(t *testing.T) {
	spec := testSpec()

	own := spec.bootstrapSecret("pw")
	own.StringData = nil
	own.Data = map[string][]byte{"password": []byte("pw")}

	c := &controller{core: fake.NewSimpleClientset(own)}

	if password, err := c.ensurePassword(context.Background(), spec); err != nil || password != "pw" {
		t.Errorf("ensurePassword = %q, %v; want its own password back", password, err)
	}
}

func TestOwnedByAnother(t *testing.T) {
	want := testSpec().OwnerRef
	earlier := want
	earlier.UID = types.UID(earlierUID)

	if ownedByAnother(nil, want) {
		t.Error("an object with no owner is nobody else's")
	}

	if ownedByAnother([]metav1.OwnerReference{want}, want) {
		t.Error("an object owned by this environment is someone else's")
	}

	if !ownedByAnother([]metav1.OwnerReference{earlier}, want) {
		t.Error("an object owned by the earlier environment is not recognised")
	}

	other := earlier
	other.Name = "someone-else"

	if ownedByAnother([]metav1.OwnerReference{other}, want) {
		t.Error("an owner with a different name is not an earlier incarnation of this one")
	}
}
