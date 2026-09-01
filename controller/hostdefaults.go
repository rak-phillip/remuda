package main

import (
	"context"
	"net"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Rancher keeps server-url and server-version here. Cluster-scoped.
var mgmtSettings = schema.GroupVersionResource{
	Group:    "management.cattle.io",
	Version:  "v3",
	Resource: "settings",
}

var certManagerClusterIssuers = schema.GroupVersionResource{
	Group:    "cert-manager.io",
	Version:  "v1",
	Resource: "clusterissuers",
}

// Nested CIDR pairs to try, in order, mirroring NESTED_CIDR_CANDIDATES in
// discovery.ts. The two must stay in step: whichever of the extension and this
// controller resolves an environment has to reach the same answer, or the same
// spec produces a different nested k3s depending on who created it.
var nestedCidrCandidates = [][2]string{
	{"10.44.0.0/16", "10.45.0.0/16"},
	{"10.46.0.0/16", "10.47.0.0/16"},
	{"10.48.0.0/16", "10.49.0.0/16"},
	{"172.30.0.0/16", "172.31.0.0/16"},
}

// hostDefaults describes the host cluster, read from the host cluster.
//
// This used to be the remuda-config ConfigMap, on the theory that the extension
// had already discovered all of it and writing it down was cheaper than
// re-deriving it. That was wrong in a way no test caught: the extension writes
// that ConfigMap to the cluster the environment *targets*, while this controller
// only ever runs on -- and reads -- the host. Targeting the host cluster hid it,
// because there the two are the same cluster. Every downstream environment on a
// Rancher where nobody had first created a local one therefore stalled at
// ResolveFailed forever, with an error telling the user to do the thing they had
// just done.
//
// Reading the host directly removes the coupling rather than repairing it. It
// also makes an Environment created by kubectl work: the hop needs the *host's*
// ingress class and issuer, and no field on the spec can supply those.
//
// Every lookup here degrades to a zero value rather than an error. A cluster
// with no cert-manager has no issuer types at all, and resolve() already reports
// a missing ingress class or base domain far better than "the list call failed"
// would.
func (c *controller) hostDefaults(ctx context.Context) (*clusterDefaults, error) {
	out := &clusterDefaults{
		BaseDomain:    baseDomainFromServerURL(c.setting(ctx, "server-url")),
		ServerVersion: c.setting(ctx, "server-version"),
		IngressClass:  c.firstIngressClass(ctx),
		StorageClass:  c.defaultStorageClass(ctx),
	}

	clusterIssuer, issuerKind, acme := c.issuer(ctx)
	out.ClusterIssuer = clusterIssuer
	out.IssuerKind = issuerKind
	out.ACME = acme

	out.NestedPodCIDR, out.NestedServiceCIDR = pickNestedCidrs(c.hostCidrs(ctx))

	return out, nil
}

// setting reads one management.cattle.io Setting, preferring the configured
// value over the shipped default exactly as the extension does.
func (c *controller) setting(ctx context.Context, name string) string {
	obj, err := c.dyn.Resource(mgmtSettings).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return ""
	}

	if value, ok, _ := unstructured.NestedString(obj.Object, "value"); ok && value != "" {
		return value
	}

	fallback, _, _ := unstructured.NestedString(obj.Object, "default")

	return fallback
}

// baseDomainFromServerURL strips the scheme and path off server-url.
//
// Deliberately server-url and never a saved override: what the base domain is
// used for is deciding whether the host can front an environment at all, and
// that is a question about this Rancher's own name. See Exposure.
func baseDomainFromServerURL(serverURL string) string {
	domain := strings.TrimPrefix(strings.TrimPrefix(serverURL, "https://"), "http://")

	if slash := strings.Index(domain, "/"); slash >= 0 {
		domain = domain[:slash]
	}

	return domain
}

// firstIngressClass prefers the one marked default, and falls back to the first
// by name.
//
// Sorted, unlike the extension's equivalent, because an API server list has no
// promised order and an ingress class picked at random is an environment that
// works or does not depending on the pass. The extension reads through Steve,
// which sorts for it.
func (c *controller) firstIngressClass(ctx context.Context) string {
	list, err := c.core.NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	if err != nil || len(list.Items) == 0 {
		return ""
	}

	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		if list.Items[i].Annotations["ingressclass.kubernetes.io/is-default-class"] == "true" {
			return list.Items[i].Name
		}

		names = append(names, list.Items[i].Name)
	}

	sort.Strings(names)

	return names[0]
}

func (c *controller) defaultStorageClass(ctx context.Context) string {
	list, err := c.core.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil || len(list.Items) == 0 {
		return ""
	}

	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		if list.Items[i].Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
			return list.Items[i].Name
		}

		names = append(names, list.Items[i].Name)
	}

	sort.Strings(names)

	return names[0]
}

// issuer answers how the host can issue certificates, in the same order of
// preference as issuerFor() in discovery.ts.
//
// A ClusterIssuer wins because it is explicit operator configuration that
// already works across namespaces. Failing that, a namespaced ACME Issuer is
// mirrored into rancher-remuda -- which is what makes TLS work on a stock
// Rancher, where the only issuer is cattle-system/rancher and it is invisible to
// an Ingress in any other namespace.
func (c *controller) issuer(ctx context.Context) (string, string, *acmeSource) {
	if name := c.firstClusterIssuer(ctx); name != "" {
		return name, "ClusterIssuer", nil
	}

	acme := c.firstAcmeIssuer(ctx)
	if acme == nil {
		return "", "", nil
	}

	return IssuerName, "Issuer", acme
}

func (c *controller) firstClusterIssuer(ctx context.Context) string {
	list, err := c.dyn.Resource(certManagerClusterIssuers).List(ctx, metav1.ListOptions{})
	if err != nil || len(list.Items) == 0 {
		return ""
	}

	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].GetName())
	}

	sort.Strings(names)

	return names[0]
}

// firstAcmeIssuer finds a namespaced Issuer with an ACME block, whose config is
// then copied onto the mirrored Issuer.
func (c *controller) firstAcmeIssuer(ctx context.Context) *acmeSource {
	list, err := c.dyn.Resource(certManagerIssuers).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}

	items := list.Items
	sort.Slice(items, func(a, b int) bool {
		if items[a].GetNamespace() != items[b].GetNamespace() {
			return items[a].GetNamespace() < items[b].GetNamespace()
		}

		return items[a].GetName() < items[b].GetName()
	})

	for i := range items {
		spec, ok, _ := unstructured.NestedMap(items[i].Object, "spec", "acme")
		if !ok || spec == nil {
			continue
		}

		return &acmeSource{
			Source: items[i].GetNamespace() + "/" + items[i].GetName(),
			Spec:   spec,
		}
	}

	return nil
}

// hostCidrs reads back as much of the host's own addressing as it publishes.
//
// Neither value states the cluster-wide range: a node carries its own /24 slice
// of the pod CIDR, and the kubernetes Service carries one address out of the
// service CIDR. widenToSixteen rounds both out, erring towards claiming more of
// the host than it really uses -- which only ever rejects a candidate.
func (c *controller) hostCidrs(ctx context.Context) (string, string) {
	var podCIDR string

	if nodes, err := c.core.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil {
		for i := range nodes.Items {
			if nodes.Items[i].Spec.PodCIDR != "" {
				podCIDR = nodes.Items[i].Spec.PodCIDR

				break
			}
		}
	}

	var serviceIP string

	if svc, err := c.core.CoreV1().Services("default").Get(ctx, "kubernetes", metav1.GetOptions{}); err == nil {
		serviceIP = svc.Spec.ClusterIP
	}

	return widenToSixteen(podCIDR), widenToSixteen(serviceIP)
}

// widenToSixteen widens an address or CIDR to its containing /16.
func widenToSixteen(cidr string) string {
	address, _, _ := strings.Cut(cidr, "/")

	octets := strings.Split(address, ".")
	if len(octets) != 4 {
		return ""
	}

	return octets[0] + "." + octets[1] + ".0.0/16"
}

// pickNestedCidrs chooses a candidate pair that does not collide with the host's.
//
// Falls back to the first candidate when every one of them overlaps. At that
// point there is nothing better to do than let the environment start and report
// the failure, rather than refuse to create it.
func pickNestedCidrs(hostPodCIDR, hostServiceCIDR string) (string, string) {
	hostRanges := make([]string, 0, 2)

	for _, r := range []string{hostPodCIDR, hostServiceCIDR} {
		if r != "" {
			hostRanges = append(hostRanges, r)
		}
	}

	for _, candidate := range nestedCidrCandidates {
		collides := false

		for _, host := range hostRanges {
			if cidrsOverlap(candidate[0], host) || cidrsOverlap(candidate[1], host) {
				collides = true

				break
			}
		}

		if !collides {
			return candidate[0], candidate[1]
		}
	}

	return nestedCidrCandidates[0][0], nestedCidrCandidates[0][1]
}

// cidrsOverlap reports whether two CIDRs share any address.
//
// An unparseable CIDR is treated as overlapping, so an unknown host range moves
// us on to the next candidate rather than risking the collision.
func cidrsOverlap(a, b string) bool {
	_, netA, errA := net.ParseCIDR(a)
	_, netB, errB := net.ParseCIDR(b)

	if errA != nil || errB != nil {
		return true
	}

	return netA.Contains(netB.IP) || netB.Contains(netA.IP)
}

// acmeSource is the ACME config to mirror, and where it was copied from.
type acmeSource struct {
	Source string
	Spec   map[string]any
}
