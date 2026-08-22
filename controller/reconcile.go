package main

import "sort"

// Labels the extension puts on every hop object. The controller reads them
// rather than the environment's own record, because that record lives in a
// ConfigMap on the *target* cluster -- reading it would need credentials for a
// cluster this controller deliberately never talks to.
const (
	LabelManaged       = "remuda.rancher.io/managed"
	LabelName          = "remuda.rancher.io/name"
	LabelRole          = "remuda.rancher.io/role"
	LabelTargetCluster = "remuda.rancher.io/target-cluster"
	LabelEntryPort     = "remuda.rancher.io/entry-port"

	RoleHop   = "hop"
	Namespace = "rancher-remuda"
)

// Address types on a node, in the order a hop should prefer them.
const (
	ExternalIP = "ExternalIP"
	InternalIP = "InternalIP"
)

// NodeAddresses is one node as far as this controller cares: whether it is
// ready, and what addresses it publishes.
type NodeAddresses struct {
	Ready     bool
	Addresses map[string]string
}

// Entry is where a hop should send traffic.
type Entry struct {
	Addresses   []string
	AddressType string
}

// AddressesFor picks the addresses a hop should dial for a set of nodes.
//
// ExternalIP is preferred, which is the opposite of what looks safest and was
// measured the hard way: from the management cluster, a downstream node's
// InternalIP is not routable at all -- node-driver nodes get their own VPC, so
// sharing 10.0.0.0/16 with the management node means nothing. A node with no
// ExternalIP is on a private network by construction, which is exactly when
// InternalIP is both the only and the correct answer.
//
// Only ready nodes count. A node being replaced is briefly still present and
// NotReady, and sending traffic to it is the failure this controller exists to
// prevent.
func AddressesFor(nodes []NodeAddresses) Entry {
	for _, want := range []string{ExternalIP, InternalIP} {
		var found []string

		for _, n := range nodes {
			if !n.Ready {
				continue
			}

			if address := n.Addresses[want]; address != "" {
				found = append(found, address)
			}
		}

		if len(found) > 0 {
			sort.Strings(found)

			return Entry{Addresses: found, AddressType: want}
		}
	}

	return Entry{}
}

// Differs reports whether a hop is sending traffic somewhere other than where it
// should be.
//
// An empty desired set is never a difference. It means every node in the target
// cluster is unready or unreadable, and rewriting the EndpointSlice to nothing
// on the strength of that would take a working environment down -- the opposite
// of the job. Leaving the stale addresses in place is strictly better: they are
// at worst already broken.
func Differs(current, desired []string) bool {
	if len(desired) == 0 {
		return false
	}

	a := append([]string(nil), current...)
	b := append([]string(nil), desired...)
	sort.Strings(a)
	sort.Strings(b)

	if len(a) != len(b) {
		return true
	}

	for i := range a {
		if a[i] != b[i] {
			return true
		}
	}

	return false
}
