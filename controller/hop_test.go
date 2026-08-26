package main

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
)

func testHop() *Hop {
	return &Hop{
		HostClusterID:   "local",
		TargetClusterID: "c-m-qfnvhpnb",
		Addresses:       []string{"44.244.38.142"},
		AddressType:     ExternalIP,
		Port:            443,
		IngressClass:    "traefik",
		ClusterIssuer:   "remuda-le",
		IssuerKind:      "Issuer",
	}
}

func TestExposure(t *testing.T) {
	// A local target is already on the cluster the wildcard resolves to.
	if mode, _ := Exposure(true, "traefik", "example.com"); mode != ExposureLocal {
		t.Errorf("local = %q", mode)
	}

	if mode, _ := Exposure(false, "traefik", "example.com"); mode != ExposureHop {
		t.Errorf("downstream with a usable host ingress = %q, want %q", mode, ExposureHop)
	}

	// Each fallback carries why, so the message can say which condition applied
	// rather than announcing an unexplained change of address.
	for _, c := range []struct {
		class, domain, reason string
	}{
		// A Rancher in docker starts k3s with traefik and servicelb disabled, so
		// it has no IngressClass at all.
		{"", "example.com", "noHostIngress"},
		// Only traefik and nginx can be told to reach a backend over HTTPS
		// without verifying its certificate.
		{"haproxy", "example.com", "hostClassUnsupported"},
		// A Rancher reached by IP has no domain to hang an environment under.
		{"traefik", "44.244.21.248", "baseDomainIsIp"},
	} {
		mode, reason := Exposure(false, c.class, c.domain)

		if mode != ExposureDirect || reason != c.reason {
			t.Errorf("Exposure(false, %q, %q) = %q/%q, want direct/%s", c.class, c.domain, mode, reason, c.reason)
		}
	}
}

func TestIsIPLiteral(t *testing.T) {
	for _, ip := range []string{"44.244.21.248", "10.0.5.35", "::1"} {
		if !IsIPLiteral(ip) {
			t.Errorf("%q should be an address", ip)
		}
	}

	for _, name := range []string{"example.com", "44.244.21.248.sslip.io", ""} {
		if IsIPLiteral(name) {
			t.Errorf("%q should be a name", name)
		}
	}
}

func TestHopSupported(t *testing.T) {
	for _, class := range []string{"traefik", "nginx", "rke2-ingress-nginx", "Traefik"} {
		if !HopSupported(class) {
			t.Errorf("%q should be frontable", class)
		}
	}

	for _, class := range []string{"", "haproxy", "istio"} {
		if HopSupported(class) {
			t.Errorf("%q cannot skip upstream certificate verification", class)
		}
	}
}

func TestHopObjectsForTraefik(t *testing.T) {
	spec := testSpec()
	objects := spec.hopObjects(testHop())

	kinds := map[string]manifest{}
	for _, m := range objects {
		kinds[m.GVK.Kind] = m
	}

	// traefik needs a ServersTransport to skip verification; nginx does the same
	// job with an annotation and no extra object.
	if _, found := kinds["ServersTransport"]; !found {
		t.Error("traefik got no ServersTransport, so the hop would fail certificate verification")
	}

	for _, kind := range []string{"Service", "EndpointSlice", "Ingress"} {
		if _, found := kinds[kind]; !found {
			t.Errorf("no %s", kind)
		}
	}

	// Its backend is a node on another cluster, so there is nothing here to
	// select and the addresses are supplied by hand in the EndpointSlice.
	svc := kinds["Service"].Object.(*corev1.Service)
	if svc.Spec.Selector != nil {
		t.Errorf("the hop Service has a selector: %v", svc.Spec.Selector)
	}

	// Read back by the resync straight off the Service, because the
	// environment's record lives on a cluster it has no credentials for.
	if svc.Labels[LabelTargetCluster] != "c-m-qfnvhpnb" || svc.Labels[LabelEntryPort] != "443" {
		t.Errorf("labels = %v", svc.Labels)
	}

	// Node-addressed by construction: AddressesFor() reads nodes. The pinned
	// label exists for hops the extension built from a LoadBalancer, and this
	// controller must never claim one.
	if _, found := svc.Labels[LabelAddressesPinned]; found {
		t.Error("a controller-built hop claims to be pinned, so the resync would skip its own work")
	}

	slice := kinds["EndpointSlice"].Object.(*discoveryv1.EndpointSlice)
	if slice.Labels[discoveryv1.LabelServiceName] != spec.hopName() {
		t.Error("the EndpointSlice is not attached to the Service, so the Ingress would 503")
	}

	if len(slice.Endpoints) != 1 || slice.Endpoints[0].Addresses[0] != "44.244.38.142" {
		t.Errorf("endpoints = %+v", slice.Endpoints)
	}
}

func TestHopIngressTerminatesTLSOnTheHost(t *testing.T) {
	spec := testSpec()
	objects := spec.hopObjects(testHop())

	var ingress manifest
	for _, m := range objects {
		if m.GVK.Kind == "Ingress" {
			ingress = m
		}
	}

	body := ingress.Object.(interface{ GetAnnotations() map[string]string })
	if body.GetAnnotations()["cert-manager.io/issuer"] != "remuda-le" {
		t.Errorf("annotations = %v", body.GetAnnotations())
	}
}

func TestHopMirrorsTheHostIssuerNotTheTargets(t *testing.T) {
	// Sharing one ACME field between the two once wrote the host's Issuer onto a
	// cluster that has no cert-manager at all.
	hop := testHop()
	hop.ACME = map[string]any{"email": "host@example.com"}

	spec := testSpec()
	spec.ACME = map[string]any{"email": "target@example.com"}

	for _, m := range spec.hopObjects(hop) {
		if m.GVK.Kind != "Issuer" {
			continue
		}

		if !m.Shared {
			t.Error("the mirrored Issuer is not marked shared, so a delete sweep could claim it")
		}

		rendered := renderedString(m.Object.(interface{ UnstructuredContent() map[string]any }))

		if !strings.Contains(rendered, "host@example.com") {
			t.Error("the hop's Issuer does not carry the host's ACME spec")
		}

		if strings.Contains(rendered, "target@example.com") {
			t.Error("the hop's Issuer carries the TARGET cluster's ACME spec")
		}

		return
	}

	t.Error("no Issuer was mirrored for a host that has only a namespaced one")
}
