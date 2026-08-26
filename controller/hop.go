package main

import (
	"fmt"
	"net"
	"regexp"
	"strconv"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// The hop is how the host cluster fronts an environment running somewhere else.
//
// An environment's hostname always comes off the host Rancher's own wildcard, so
// it only ever resolves to the host cluster. For a downstream target that means
// the Ingress created next to the workload is correct and simply never receives
// traffic -- something on the host has to accept the request and forward it.
//
// A Go port of the extension's hopManifests(). These objects live on the host
// cluster next to the Environment, so unlike anything a Bundle carries they do
// take an owner reference and the collector sweeps them.

// DefaultHopPort is where a downstream ingress answers HTTPS unless told
// otherwise. 443 covers a hostPort DaemonSet, which is what RKE2 and k3s both
// run; a target behind a NodePort Service has to say so in spec.hopPort.
const DefaultHopPort = 443

var (
	traefikClass = regexp.MustCompile(`(?i)traefik`)
	nginxClass   = regexp.MustCompile(`(?i)nginx`)
)

// HopSupported reports whether an ingress class can be told to reach its backend
// over HTTPS without verifying the certificate.
//
// The hop arrives at the downstream ingress on its HTTPS port and meets whatever
// certificate that ingress serves by default -- self-signed, for a hostname it
// was never issued for. So the host ingress has to both speak TLS upstream and
// skip verification, and every controller spells that differently. These two are
// the ones that can.
func HopSupported(ingressClass string) bool {
	return traefikClass.MatchString(ingressClass) || nginxClass.MatchString(ingressClass)
}

// IsIPLiteral reports whether a base domain is an address rather than a name.
//
// A Rancher reached by IP has no domain to hang an environment under, so there
// is nothing for the host to match a hop Ingress against.
func IsIPLiteral(domain string) bool {
	return net.ParseIP(domain) != nil
}

// Exposure decides how an environment is reached, and says why when the answer
// is the fallback.
//
// `direct` is not a failure: it means the host cluster cannot front this
// environment, so the environment is named off the target cluster's own ingress
// instead and the Ingress written beside the workload serves it -- exactly as it
// does for a local one. What the controller cannot do is *discover* that
// cluster's address, which is why resolve() insists it be pinned.
func Exposure(targetsLocal bool, hostIngressClass, hostBaseDomain string) (string, string) {
	switch {
	case targetsLocal:
		return ExposureLocal, ""
	case hostIngressClass == "":
		return ExposureDirect, "noHostIngress"
	case !HopSupported(hostIngressClass):
		return ExposureDirect, "hostClassUnsupported"
	case IsIPLiteral(hostBaseDomain):
		return ExposureDirect, "baseDomainIsIp"
	default:
		return ExposureHop, ""
	}
}

func (s *renderSpec) hopName() string { return s.Name + "-hop" }

// hopMeta is shared by every object the hop owns.
//
// The target cluster and port are recorded as labels so the host cluster is
// self-describing: the resync reads them straight off the Service rather than
// needing the environment's record, which for a downstream environment lives on
// a cluster it has no credentials for.
func (s *renderSpec) hopMeta(hop *Hop) metav1.ObjectMeta {
	meta := s.meta(s.hopName(), RoleHop)

	meta.Labels[LabelTargetCluster] = hop.TargetClusterID
	meta.Labels[LabelEntryPort] = strconv.Itoa(hop.Port)

	// Node-addressed by construction: AddressesFor() is the only thing that
	// feeds this, and it reads nodes. The label exists for hops the extension
	// built from a LoadBalancer, which this controller must not recompute.
	delete(meta.Labels, LabelAddressesPinned)

	return meta
}

// hopObjects is everything the host cluster needs to front one downstream
// environment.
//
// Four objects. The Service is deliberately selector-less: its backend is a node
// on another cluster, so there is nothing here to select and the addresses are
// supplied by hand in the EndpointSlice instead. That is also why the
// EndpointSlice is the only one of the four that is ever rewritten -- replacing a
// downstream node changes the addresses and nothing else.
//
// ExternalName would be the obvious shortcut and is not usable: traefik gates it
// behind allowExternalNameServices, and it cannot express an IP anyway.
func (s *renderSpec) hopObjects(hop *Hop) []manifest {
	traefik := traefikClass.MatchString(hop.IngressClass)
	out := []manifest{}

	// TLS terminates here, not on the target, so the mirrored Issuer belongs on
	// the host cluster next to this Ingress. Written before the Ingress that
	// references it, and shared -- one per namespace, never swept with an
	// individual environment.
	if hop.ACME != nil && hop.IssuerKind == "Issuer" {
		out = append(out, manifest{
			GVK:    gvk("cert-manager.io", "v1", "Issuer"),
			Name:   IssuerName,
			Object: s.issuerFrom(hop.ACME),
			Shared: true,
		})
	}

	// traefik needs a ServersTransport to skip verification; nginx does the same
	// job with an Ingress annotation and no extra object.
	if traefik {
		out = append(out, manifest{
			GVK:    gvk("traefik.io", "v1alpha1", "ServersTransport"),
			Name:   s.hopName(),
			Object: s.hopServersTransport(),
		})
	}

	out = append(out,
		manifest{GVK: gvk("", "v1", "Service"), Name: s.hopName(), Object: s.hopService(hop, traefik)},
		manifest{GVK: gvk("discovery.k8s.io", "v1", "EndpointSlice"), Name: s.hopName(), Object: s.hopEndpointSlice(hop)},
		manifest{GVK: gvk("networking.k8s.io", "v1", "Ingress"), Name: s.hopName(), Object: s.hopIngress(hop)},
	)

	return out
}

func (s *renderSpec) hopServersTransport() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "traefik.io/v1alpha1",
		"kind":       "ServersTransport",
		"metadata": map[string]any{
			"name":      s.hopName(),
			"namespace": s.Namespace,
			"labels":    toAnyMap(s.labels(RoleHop)),
		},
		"spec": map[string]any{"insecureSkipVerify": true},
	}}
}

func (s *renderSpec) hopService(hop *Hop, traefik bool) *corev1.Service {
	meta := s.hopMeta(hop)

	if traefik {
		meta.Annotations = map[string]string{
			"traefik.ingress.kubernetes.io/service.serversscheme": "https",
			// Namespace-qualified and provider-suffixed: traefik's own naming
			// for a CRD reference from the Ingress provider.
			"traefik.ingress.kubernetes.io/service.serverstransport": fmt.Sprintf("%s-%s@kubernetescrd", s.Namespace, s.hopName()),
		}
	}

	port := int32(hop.Port)

	return &corev1.Service{
		ObjectMeta: meta,
		Spec: corev1.ServiceSpec{
			// No selector on purpose -- see hopObjects.
			Ports: []corev1.ServicePort{{
				Name:       "https",
				Port:       port,
				TargetPort: intstr.FromInt32(port),
				Protocol:   corev1.ProtocolTCP,
			}},
		},
	}
}

func (s *renderSpec) hopEndpointSlice(hop *Hop) *discoveryv1.EndpointSlice {
	meta := s.hopMeta(hop)

	// Without kubernetes.io/service-name the Service has no backends at all and
	// the Ingress 503s.
	meta.Labels[discoveryv1.LabelServiceName] = s.hopName()

	ready := true
	endpoints := make([]discoveryv1.Endpoint, 0, len(hop.Addresses))

	for _, address := range hop.Addresses {
		endpoints = append(endpoints, discoveryv1.Endpoint{
			Addresses:  []string{address},
			Conditions: discoveryv1.EndpointConditions{Ready: &ready},
		})
	}

	name, port, protocol := "https", int32(hop.Port), corev1.ProtocolTCP

	return &discoveryv1.EndpointSlice{
		ObjectMeta:  meta,
		AddressType: discoveryv1.AddressTypeIPv4,
		Ports:       []discoveryv1.EndpointPort{{Name: &name, Port: &port, Protocol: &protocol}},
		Endpoints:   endpoints,
	}
}

func (s *renderSpec) hopIngress(hop *Hop) *networkingv1.Ingress {
	meta := s.hopMeta(hop)
	prefix := networkingv1.PathTypePrefix

	annotations := IssuerAnnotations(hop.ClusterIssuer, hop.IssuerKind)
	if annotations == nil {
		annotations = map[string]string{}
	}

	if nginxClass.MatchString(hop.IngressClass) {
		annotations["nginx.ingress.kubernetes.io/backend-protocol"] = "HTTPS"
	}

	if len(annotations) > 0 {
		meta.Annotations = annotations
	}

	ingress := &networkingv1.Ingress{
		ObjectMeta: meta,
		Spec: networkingv1.IngressSpec{
			IngressClassName: &hop.IngressClass,
			Rules: []networkingv1.IngressRule{{
				Host: s.Hostname,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						// One path, not two. The downstream Ingress already
						// splits /ui-bundle from '/', and re-splitting it here
						// would duplicate a decision in a second place that has
						// to be kept in step.
						Paths: []networkingv1.HTTPIngressPath{{
							Path:     "/",
							PathType: &prefix,
							Backend: networkingv1.IngressBackend{
								Service: &networkingv1.IngressServiceBackend{
									Name: s.hopName(),
									Port: networkingv1.ServiceBackendPort{Number: int32(hop.Port)},
								},
							},
						}},
					},
				},
			}},
		},
	}

	// TLS terminates here, which is why the target cluster needs no cert-manager
	// at all -- see resolve().
	if hop.ClusterIssuer != "" {
		ingress.Spec.TLS = []networkingv1.IngressTLS{{
			Hosts:      []string{s.Hostname},
			SecretName: s.hopName() + "-tls",
		}}
	}

	return ingress
}

func toAnyMap(in map[string]string) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}

	return out
}
