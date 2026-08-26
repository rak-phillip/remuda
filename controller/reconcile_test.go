package main

import (
	"reflect"
	"testing"
)

func node(ready bool, addresses map[string]string) NodeAddresses {
	return NodeAddresses{Ready: ready, Addresses: addresses}
}

func TestAddressesForPrefersExternal(t *testing.T) {
	// Measured, not assumed: from the management cluster a downstream node's
	// InternalIP is not routable at all, because node-driver nodes get their own
	// VPC. Preferring it produces a hop that silently never connects.
	got := AddressesFor([]NodeAddresses{
		node(true, map[string]string{InternalIP: "10.0.12.23", ExternalIP: "52.12.200.3"}),
	})

	want := Entry{Addresses: []string{"52.12.200.3"}, AddressType: ExternalIP}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAddressesForFallsBackToInternal(t *testing.T) {
	// A node with no public address is on a private network by construction,
	// which is exactly when InternalIP is both the only and the correct answer.
	got := AddressesFor([]NodeAddresses{
		node(true, map[string]string{InternalIP: "10.0.16.140"}),
	})

	want := Entry{Addresses: []string{"10.0.16.140"}, AddressType: InternalIP}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAddressesForSkipsUnreadyNodes(t *testing.T) {
	// A node being replaced is briefly still present and NotReady. Sending
	// traffic to it is the failure this controller exists to prevent.
	got := AddressesFor([]NodeAddresses{
		node(false, map[string]string{ExternalIP: "52.12.200.3"}),
		node(true, map[string]string{ExternalIP: "52.12.200.9"}),
	})

	if !reflect.DeepEqual(got.Addresses, []string{"52.12.200.9"}) {
		t.Fatalf("got %v, want only the ready node", got.Addresses)
	}
}

func TestAddressesForDoesNotMixFamilies(t *testing.T) {
	// Half the endpoints being unroutable is worse than all of them being one
	// thing: traffic would succeed or hang depending on which was picked.
	got := AddressesFor([]NodeAddresses{
		node(true, map[string]string{InternalIP: "10.0.12.23", ExternalIP: "52.12.200.3"}),
		node(true, map[string]string{InternalIP: "10.0.12.24"}),
	})

	if got.AddressType != ExternalIP || len(got.Addresses) != 1 {
		t.Fatalf("got %+v, want only the ExternalIP", got)
	}
}

func TestAddressesForEmptyWhenNothingIsReady(t *testing.T) {
	got := AddressesFor([]NodeAddresses{node(false, map[string]string{ExternalIP: "52.12.200.3"})})

	if len(got.Addresses) != 0 {
		t.Fatalf("got %+v, want nothing", got)
	}
}

func TestDiffers(t *testing.T) {
	cases := []struct {
		name             string
		current, desired []string
		want             bool
	}{
		{"identical", []string{"a"}, []string{"a"}, false},
		{"ordering is not drift", []string{"a", "b"}, []string{"b", "a"}, false},
		{"replaced node", []string{"52.12.200.3"}, []string{"52.12.200.9"}, true},
		{"edited by hand", []string{"203.0.113.99"}, []string{"52.12.200.3"}, true},
		{"slice emptied", nil, []string{"52.12.200.3"}, true},
		{"scaled up", []string{"a"}, []string{"a", "b"}, true},
		// Every node unready or unreadable. Rewriting to nothing would take a
		// working environment down -- the opposite of the job.
		{"nothing desired is never drift", []string{"52.12.200.3"}, nil, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Differs(c.current, c.desired); got != c.want {
				t.Fatalf("Differs(%v, %v) = %v, want %v", c.current, c.desired, got, c.want)
			}
		})
	}
}

func TestHopIsPinnedOnlyForALoadBalancer(t *testing.T) {
	// The extension sets this when it took the address off a LoadBalancer
	// Service. Recomputing that from nodes replaces a working address with nodes
	// that are usually not listening on the port -- so the hop works until the
	// first resync and then stops, which is worse than either answer alone.
	if !HopIsPinned(map[string]string{LabelAddressesPinned: "true"}) {
		t.Error("a load-balancer hop should be left alone")
	}

	// Everything else is node-addressed and is this controller's to maintain.
	// That includes a hop recorded before the label existed, which is the safe
	// default: stale node addresses are at worst already broken.
	for _, labels := range []map[string]string{
		nil,
		{},
		{LabelTargetCluster: "c-m-abc"},
		{LabelAddressesPinned: "false"},
	} {
		if HopIsPinned(labels) {
			t.Errorf("%v should not be treated as pinned", labels)
		}
	}
}
