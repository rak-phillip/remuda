package main

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func TestBaseDomainFromServerURL(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"https://prak.ui.rancher.space", "prak.ui.rancher.space"},
		{"http://prak.ui.rancher.space/", "prak.ui.rancher.space"},
		{"https://prak.ui.rancher.space/dashboard/c/_/remuda", "prak.ui.rancher.space"},
		{"https://13.53.41.140", "13.53.41.140"},
		{"", ""},
	} {
		if got := baseDomainFromServerURL(tc.in); got != tc.want {
			t.Errorf("baseDomainFromServerURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWidenToSixteen(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		// A node's slice of the pod CIDR, and the kubernetes Service's ClusterIP:
		// neither states the cluster-wide range, so both are rounded out.
		{"10.42.0.0/24", "10.42.0.0/16"},
		{"10.43.0.1", "10.43.0.0/16"},
		{"", ""},
		{"not-an-address", ""},
	} {
		if got := widenToSixteen(tc.in); got != tc.want {
			t.Errorf("widenToSixteen(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCidrsOverlapTreatsUnparseableAsColliding(t *testing.T) {
	if !cidrsOverlap("10.42.0.0/16", "10.42.0.0/16") {
		t.Error("identical ranges should overlap")
	}

	if cidrsOverlap("10.44.0.0/16", "10.42.0.0/16") {
		t.Error("disjoint /16s should not overlap")
	}

	// An unknown host range must push us on to the next candidate rather than
	// risk handing the nested k3s the host's own addresses.
	if !cidrsOverlap("10.44.0.0/16", "garbage") {
		t.Error("an unparseable range should be treated as overlapping")
	}
}

func TestPickNestedCidrsAvoidsTheHost(t *testing.T) {
	// k3s defaults. The first candidate is already clear of them.
	pod, svc := pickNestedCidrs("10.42.0.0/16", "10.43.0.0/16")
	if pod != "10.44.0.0/16" || svc != "10.45.0.0/16" {
		t.Errorf("k3s defaults = %q/%q, want 10.44.0.0/16/10.45.0.0/16", pod, svc)
	}

	// A host that already occupies the first candidate must push us past it.
	pod, svc = pickNestedCidrs("10.44.0.0/16", "10.45.0.0/16")
	if pod != "10.46.0.0/16" || svc != "10.47.0.0/16" {
		t.Errorf("host on the first candidate = %q/%q, want 10.46.0.0/16/10.47.0.0/16", pod, svc)
	}

	// Nothing readable is not a reason to refuse: fall back to the first pair
	// and let the environment report a real collision if there is one.
	pod, svc = pickNestedCidrs("", "")
	if pod != "10.44.0.0/16" || svc != "10.45.0.0/16" {
		t.Errorf("unknown host = %q/%q, want the first candidate", pod, svc)
	}
}

// dynamicScheme lists every custom type hostDefaults and resolveHop read.
func dynamicScheme() (*runtime.Scheme, map[schema.GroupVersionResource]string) {
	return runtime.NewScheme(), map[schema.GroupVersionResource]string{
		mgmtSettings:              "SettingList",
		mgmtNodes:                 "NodeList",
		certManagerClusterIssuers: "ClusterIssuerList",
		certManagerIssuers:        "IssuerList",
	}
}

func setting(name, value string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "management.cattle.io/v3",
		"kind":       "Setting",
		"metadata":   map[string]any{"name": name},
		"value":      value,
	}}
}

func acmeIssuer(namespace, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Issuer",
		"metadata":   map[string]any{"name": name, "namespace": namespace},
		"spec": map[string]any{"acme": map[string]any{
			"email":  "someone@example.com",
			"server": "https://acme-v02.api.letsencrypt.org/directory",
		}},
	}}
}

func ingressClass(name string, isDefault bool) *networkingv1.IngressClass {
	class := &networkingv1.IngressClass{ObjectMeta: metav1.ObjectMeta{Name: name}}

	if isDefault {
		class.Annotations = map[string]string{"ingressclass.kubernetes.io/is-default-class": "true"}
	}

	return class
}

func storageClass(name string, isDefault bool) *storagev1.StorageClass {
	class := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: name}}

	if isDefault {
		class.Annotations = map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}
	}

	return class
}

// A stock ROA Rancher: k3s, traefik, local-path, and no ClusterIssuer at all --
// only the namespaced ACME Issuer Rancher provisions for its own certificate.
// This is the shape that produced the bug, because the extension had never
// written a remuda-config anywhere the controller could read.
func stockHost() *controller {
	scheme, resources := dynamicScheme()

	core := fake.NewSimpleClientset(
		ingressClass("traefik", true),
		storageClass("local-path", true),
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "ip-10-0-20-18"},
			Spec:       corev1.NodeSpec{PodCIDR: "10.42.0.0/24"},
		},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "kubernetes", Namespace: "default"},
			Spec:       corev1.ServiceSpec{ClusterIP: "10.43.0.1"},
		},
	)

	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, resources,
		setting("server-url", "https://prak.ui.rancher.space"),
		setting("server-version", "v2.16-abcdef-head"),
		acmeIssuer("cattle-system", "rancher"),
	)

	return &controller{core: core, dyn: dyn}
}

func TestHostDefaultsReadsAStockRancher(t *testing.T) {
	defaults, err := stockHost().hostDefaults(context.Background())
	if err != nil {
		t.Fatalf("hostDefaults: %v", err)
	}

	if defaults.BaseDomain != "prak.ui.rancher.space" {
		t.Errorf("BaseDomain = %q", defaults.BaseDomain)
	}

	if defaults.ServerVersion != "v2.16-abcdef-head" {
		t.Errorf("ServerVersion = %q", defaults.ServerVersion)
	}

	if defaults.IngressClass != "traefik" {
		t.Errorf("IngressClass = %q", defaults.IngressClass)
	}

	if defaults.StorageClass != "local-path" {
		t.Errorf("StorageClass = %q", defaults.StorageClass)
	}

	// No ClusterIssuer, so the namespaced one is mirrored rather than named.
	if defaults.ClusterIssuer != IssuerName || defaults.IssuerKind != "Issuer" {
		t.Errorf("issuer = %q/%q, want %q/Issuer", defaults.ClusterIssuer, defaults.IssuerKind, IssuerName)
	}

	if defaults.ACME == nil || defaults.ACME.Source != "cattle-system/rancher" {
		t.Fatalf("ACME = %+v, want a mirror of cattle-system/rancher", defaults.ACME)
	}

	if defaults.NestedPodCIDR != "10.44.0.0/16" || defaults.NestedServiceCIDR != "10.45.0.0/16" {
		t.Errorf("nested CIDRs = %q/%q", defaults.NestedPodCIDR, defaults.NestedServiceCIDR)
	}
}

func TestHostDefaultsPrefersAClusterIssuer(t *testing.T) {
	scheme, resources := dynamicScheme()
	clusterIssuer := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "ClusterIssuer",
		"metadata":   map[string]any{"name": "letsencrypt"},
	}}

	c := &controller{
		core: fake.NewSimpleClientset(),
		dyn:  dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, resources, clusterIssuer, acmeIssuer("cattle-system", "rancher")),
	}

	defaults, err := c.hostDefaults(context.Background())
	if err != nil {
		t.Fatalf("hostDefaults: %v", err)
	}

	if defaults.ClusterIssuer != "letsencrypt" || defaults.IssuerKind != "ClusterIssuer" {
		t.Errorf("issuer = %q/%q, want letsencrypt/ClusterIssuer", defaults.ClusterIssuer, defaults.IssuerKind)
	}

	// Explicit operator configuration wins outright: nothing is mirrored.
	if defaults.ACME != nil {
		t.Errorf("ACME = %+v, want nil when a ClusterIssuer exists", defaults.ACME)
	}
}

// A cluster with no cert-manager has no issuer types at all, and every other
// lookup can fail too. None of that is fatal -- resolve() reports what is
// actually missing far better than a failed list call would.
func TestHostDefaultsDegradesOnABareCluster(t *testing.T) {
	scheme, resources := dynamicScheme()
	c := &controller{
		core: fake.NewSimpleClientset(),
		dyn:  dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, resources),
	}

	defaults, err := c.hostDefaults(context.Background())
	if err != nil {
		t.Fatalf("hostDefaults on a bare cluster: %v", err)
	}

	if defaults.IngressClass != "" || defaults.BaseDomain != "" || defaults.ACME != nil {
		t.Errorf("bare cluster = %+v, want zero values", defaults)
	}

	// Still a usable pair, so an environment starts and reports a real collision
	// rather than being refused up front.
	if defaults.NestedPodCIDR != "10.44.0.0/16" {
		t.Errorf("NestedPodCIDR = %q, want the first candidate", defaults.NestedPodCIDR)
	}
}

// mgmtNode is a downstream node as Rancher mirrors it: the real node status
// nested one level deeper, under internalNodeStatus.
func mgmtNode(clusterID, name, externalIP string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "management.cattle.io/v3",
		"kind":       "Node",
		"metadata":   map[string]any{"name": name, "namespace": clusterID},
		"status": map[string]any{
			"internalNodeStatus": map[string]any{
				"addresses": []any{
					map[string]any{"type": "InternalIP", "address": "10.0.13.249"},
					map[string]any{"type": "ExternalIP", "address": externalIP},
				},
				"conditions": []any{
					map[string]any{"type": "Ready", "status": "True"},
				},
			},
		},
	}}
}

// The regression test for the whole class of failure.
//
// A downstream environment, on a Rancher where no local environment was ever
// created -- so there was no remuda-config for the controller to read, and there
// never would be, because the extension writes that ConfigMap to the *target*
// cluster. resolve() used to fail here before it looked at a single field,
// telling the user to create an environment through the extension, which is
// exactly what they had just done.
func TestResolveDownstreamNeedsNoConfigMap(t *testing.T) {
	scheme, resources := dynamicScheme()

	core := fake.NewSimpleClientset(
		ingressClass("traefik", true),
		storageClass("local-path", true),
	)

	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, resources,
		setting("server-url", "https://prak.ui.rancher.space"),
		setting("server-version", "v2.16-abcdef-head"),
		acmeIssuer("cattle-system", "rancher"),
		mgmtNode("c-m-zxt2njmt", "machine-1", "44.248.233.166"),
	)

	c := &controller{core: core, dyn: dyn}

	// What the extension sends for a downstream target: everything describing
	// the target cluster pinned, because the controller cannot read that cluster.
	env := &Environment{
		ObjectMeta: metav1.ObjectMeta{Name: "prak-test", Namespace: Namespace},
		Spec: EnvironmentSpec{
			Repo:              "https://github.com/rak-phillip/dashboard",
			Branch:            "task/17295-login-page",
			Running:           true,
			ClusterID:         "c-m-zxt2njmt",
			Hostname:          "prak-test.34.208.139.229.sslip.io",
			HopPort:           443,
			IngressClass:      "traefik",
			StorageClass:      "local-path",
			NestedPodCIDR:     "10.44.0.0/16",
			NestedServiceCIDR: "10.45.0.0/16",
		},
	}

	spec, hop, err := c.resolve(context.Background(), env)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if spec.Hostname != "prak-test.34.208.139.229.sslip.io" {
		t.Errorf("Hostname = %q", spec.Hostname)
	}

	// The target needs no cert-manager: TLS terminates on the host, on the hop.
	if spec.ClusterIssuer != "" {
		t.Errorf("target ClusterIssuer = %q, want empty", spec.ClusterIssuer)
	}

	if hop == nil {
		t.Fatal("no hop, want the host cluster to front this environment")
	}

	// The host's ingress class and issuer, which is the pair no field on the
	// spec can supply and the only reason the controller needs to read the host.
	if hop.IngressClass != "traefik" {
		t.Errorf("hop.IngressClass = %q, want traefik", hop.IngressClass)
	}

	if hop.ClusterIssuer != IssuerName || hop.IssuerKind != "Issuer" {
		t.Errorf("hop issuer = %q/%q, want %q/Issuer", hop.ClusterIssuer, hop.IssuerKind, IssuerName)
	}

	if len(hop.Addresses) != 1 || hop.Addresses[0] != "44.248.233.166" {
		t.Errorf("hop.Addresses = %v, want the downstream ExternalIP", hop.Addresses)
	}

	if hop.Port != 443 {
		t.Errorf("hop.Port = %d, want 443", hop.Port)
	}
}

// The counterpart: a Rancher reached by IP has no domain to hang an environment
// under, so the host cannot front it and the target's own ingress has to.
func TestResolveDownstreamFallsBackToDirectOnAnIPRancher(t *testing.T) {
	scheme, resources := dynamicScheme()

	c := &controller{
		core: fake.NewSimpleClientset(ingressClass("traefik", true)),
		dyn: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, resources,
			setting("server-url", "https://13.53.41.140"),
		),
	}

	env := &Environment{
		ObjectMeta: metav1.ObjectMeta{Name: "prak-test", Namespace: Namespace},
		Spec: EnvironmentSpec{
			Repo:              "https://github.com/rak-phillip/dashboard",
			Branch:            "main",
			Running:           true,
			ClusterID:         "c-m-zxt2njmt",
			Hostname:          "prak-test.44.248.233.166.sslip.io",
			EntryPort:         443,
			IngressClass:      "traefik",
			StorageClass:      "local-path",
			NestedPodCIDR:     "10.44.0.0/16",
			NestedServiceCIDR: "10.45.0.0/16",
		},
	}

	_, hop, err := c.resolve(context.Background(), env)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if hop != nil {
		t.Errorf("hop = %+v, want none: the environment is reached directly", hop)
	}
}
