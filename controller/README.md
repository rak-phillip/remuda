# remuda-controller

Keeps the cross-cluster hop pointing at the right place.

The extension discovers a downstream cluster's ingress addresses once, when an environment is
created, and writes them into an EndpointSlice on the management cluster. Those are node addresses,
and node addresses change — scaling a pool or replacing a machine leaves the hop dialling somewhere
that no longer exists.

The UI repairs this too, but only while an environment's detail page is open **and in the
foreground**; browsers throttle timers in background tabs. This controller removes that condition.

## How it works

It runs entirely on the management cluster. Rancher mirrors every downstream node into
`nodes.management.cattle.io`, namespaced by cluster ID, so downstream addresses are readable here —
no kubeconfig secrets, no tokens, no cross-cluster auth.

Every 30 seconds it lists Services in `rancher-remuda` labelled `remuda.rancher.io/role=hop`, reads
the target cluster and entry port off their labels, resolves that cluster's ready node addresses, and
updates the matching EndpointSlice if it differs.

It writes **EndpointSlices and nothing else**. The Service, Ingress and ServersTransport describe
topology that does not drift, and leaving them to the UI keeps the blast radius narrow:

> The UI discovers topology once at create; the controller refreshes addresses forever.

## Why a resync rather than watches

The whole job is "make these EndpointSlices match those node addresses", which is idempotent and
converges from any starting state. A periodic full pass is simpler than reacting to individual
events, and it recovers from a missed watch with no extra code. Node replacement takes minutes; 30s
is well inside it.

## Two rules worth not breaking

**ExternalIP is preferred over InternalIP.** This is the opposite of what looks safest and was
measured the hard way: from the management cluster, a downstream node's InternalIP is not routable at
all, because node-driver nodes get their own VPC. Sharing `10.0.0.0/16` with the management node
means nothing. A node with no ExternalIP is on a private network by construction, which is exactly
when InternalIP is right.

**An empty desired set is never drift.** It means every node in the target cluster is unready or
unreadable. Rewriting the EndpointSlice to nothing on the strength of that would take a working
environment down — the opposite of the job. Stale addresses are at worst already broken.

## Running it locally

```bash
KUBECONFIG=~/.kube/config go run . -once      # one pass, then exit
KUBECONFIG=~/.kube/config go run .            # loop
go test ./...
```

`-once` is the useful one for checking what it would do: it logs only when it actually changes
something, so silence means everything already agreed.
