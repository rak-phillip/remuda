// Command remuda-controller keeps the cross-cluster hop pointing at the right
// place.
//
// The extension discovers a downstream cluster's ingress addresses once, when an
// environment is created, and writes them into an EndpointSlice on the
// management cluster. Those addresses are node addresses, and node addresses
// change -- scaling a pool, replacing a machine, or anything else that swaps the
// node out leaves the hop dialling somewhere that no longer exists.
//
// The UI repairs this too, but only while an environment's detail page is open
// and in the foreground; browsers throttle timers in background tabs. This
// controller removes that condition.
//
// It runs entirely on the management cluster. Rancher mirrors every downstream
// node into `nodes.management.cattle.io`, namespaced by cluster ID, so the
// downstream addresses are readable here -- no kubeconfig secrets, no tokens, no
// cross-cluster auth. It writes EndpointSlices and nothing else: the Service,
// Ingress and ServersTransport describe topology that does not drift, and
// leaving them to the UI keeps the blast radius narrow.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// The mirrored downstream nodes. Namespaced by cluster ID.
var mgmtNodes = schema.GroupVersionResource{
	Group:    "management.cattle.io",
	Version:  "v3",
	Resource: "nodes",
}

func main() {
	var interval time.Duration
	var once bool

	flag.DurationVar(&interval, "interval", 30*time.Second, "how often to reconcile every hop")
	flag.BoolVar(&once, "once", false, "reconcile a single time and exit")
	flag.Parse()

	config, err := restConfig()
	if err != nil {
		log.Fatalf("could not build a client config: %v", err)
	}

	core, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("could not build a core client: %v", err)
	}

	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		log.Fatalf("could not build a dynamic client: %v", err)
	}

	ctx := context.Background()
	c := &controller{core: core, dyn: dyn}

	if once {
		if err := c.reconcileAll(ctx); err != nil {
			log.Fatalf("reconcile failed: %v", err)
		}

		return
	}

	// A plain resync rather than watches. The entire job is "make these
	// EndpointSlices match those node addresses", which is idempotent and
	// converges from any starting state -- so a periodic full pass is both
	// simpler and more robust than reacting to individual events, and it
	// recovers from a missed watch without any extra code. Node replacement is
	// measured in minutes; 30s is well inside it.
	log.Printf("reconciling every %s", interval)

	for {
		if err := c.reconcileAll(ctx); err != nil {
			log.Printf("reconcile failed, will retry: %v", err)
		}

		time.Sleep(interval)
	}
}

func restConfig() (*rest.Config, error) {
	if config, err := rest.InClusterConfig(); err == nil {
		return config, nil
	}

	path := os.Getenv("KUBECONFIG")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}

		path = filepath.Join(home, ".kube", "config")
	}

	return clientcmd.BuildConfigFromFlags("", path)
}

type controller struct {
	core kubernetes.Interface
	dyn  dynamic.Interface
}

// reconcileAll walks every hop Service and repoints the ones that have drifted.
func (c *controller) reconcileAll(ctx context.Context) error {
	services, err := c.core.CoreV1().Services(Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s", LabelRole, RoleHop),
	})
	if err != nil {
		return fmt.Errorf("listing hop services: %w", err)
	}

	for i := range services.Items {
		svc := &services.Items[i]

		// One environment failing must not stop the others: they are unrelated,
		// and the usual cause is a target cluster that is temporarily gone.
		if err := c.reconcile(ctx, svc.Name, svc.Labels); err != nil {
			log.Printf("%s: %v", svc.Name, err)
		}
	}

	return nil
}

func (c *controller) reconcile(ctx context.Context, name string, labels map[string]string) error {
	target := labels[LabelTargetCluster]
	if target == "" {
		return fmt.Errorf("no %s label, cannot tell which cluster to look at", LabelTargetCluster)
	}

	port, err := strconv.Atoi(labels[LabelEntryPort])
	if err != nil {
		return fmt.Errorf("no usable %s label: %w", LabelEntryPort, err)
	}

	nodes, err := c.nodesFor(ctx, target)
	if err != nil {
		return fmt.Errorf("reading nodes for %s: %w", target, err)
	}

	entry := AddressesFor(nodes)

	slice, err := c.core.DiscoveryV1().EndpointSlices(Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("reading EndpointSlice: %w", err)
	}

	var current []string
	for _, e := range slice.Endpoints {
		current = append(current, e.Addresses...)
	}

	if !Differs(current, entry.Addresses) {
		return nil
	}

	slice.AddressType = discoveryv1.AddressTypeIPv4
	slice.Endpoints = endpointsFor(entry.Addresses)
	slice.Ports = portsFor(int32(port))

	if _, err := c.core.DiscoveryV1().EndpointSlices(Namespace).Update(ctx, slice, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("updating EndpointSlice: %w", err)
	}

	log.Printf("%s: %v -> %v (%s)", name, current, entry.Addresses, entry.AddressType)

	return nil
}

// nodesFor reads a cluster's mirrored nodes off the management cluster.
func (c *controller) nodesFor(ctx context.Context, clusterID string) ([]NodeAddresses, error) {
	list, err := c.dyn.Resource(mgmtNodes).Namespace(clusterID).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	nodes := make([]NodeAddresses, 0, len(list.Items))

	for i := range list.Items {
		nodes = append(nodes, nodeAddresses(&list.Items[i]))
	}

	return nodes, nil
}

// nodeAddresses pulls the bits that matter out of a mirrored node.
//
// Rancher nests the real Kubernetes node status under `internalNodeStatus`, so
// both the addresses and the Ready condition live one level deeper than they
// would on a core Node.
func nodeAddresses(node *unstructured.Unstructured) NodeAddresses {
	out := NodeAddresses{Addresses: map[string]string{}}

	addresses, _, _ := unstructured.NestedSlice(node.Object, "status", "internalNodeStatus", "addresses")
	for _, raw := range addresses {
		if entry, ok := raw.(map[string]any); ok {
			kind, _ := entry["type"].(string)
			address, _ := entry["address"].(string)

			if kind != "" && address != "" {
				out.Addresses[kind] = address
			}
		}
	}

	conditions, _, _ := unstructured.NestedSlice(node.Object, "status", "internalNodeStatus", "conditions")
	for _, raw := range conditions {
		if entry, ok := raw.(map[string]any); ok {
			if kind, _ := entry["type"].(string); kind == "Ready" {
				status, _ := entry["status"].(string)
				out.Ready = status == "True"
			}
		}
	}

	return out
}

func endpointsFor(addresses []string) []discoveryv1.Endpoint {
	ready := true
	out := make([]discoveryv1.Endpoint, 0, len(addresses))

	for _, address := range addresses {
		out = append(out, discoveryv1.Endpoint{
			Addresses:  []string{address},
			Conditions: discoveryv1.EndpointConditions{Ready: &ready},
		})
	}

	return out
}

func portsFor(port int32) []discoveryv1.EndpointPort {
	name := "https"
	protocol := corev1.ProtocolTCP

	return []discoveryv1.EndpointPort{{
		Name:     &name,
		Port:     &port,
		Protocol: &protocol,
	}}
}
