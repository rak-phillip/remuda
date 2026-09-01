# remuda-controller

Serves Remuda's scriptable API, and keeps the cross-cluster hop pointing at the right place.

The extension discovers a downstream cluster's ingress addresses once, when an environment is
created, and writes them into an EndpointSlice on the management cluster. Those are node addresses,
and node addresses change — scaling a pool or replacing a machine leaves the hop dialling somewhere
that no longer exists.

The UI repairs this too, but only while an environment's detail page is open **and in the
foreground**; browsers throttle timers in background tabs. This controller removes that condition.

## The Environment API

`environments.remuda.rancher.io/v1alpha1` is how anything that is not the browser creates, deletes,
starts and stops an environment. The CRD ships with this chart; see
`deploy/examples/environment.yaml`.

```bash
kubectl apply -f environment.yaml
kubectl get environments -n rancher-remuda
kubectl patch environment multi-idp -n rancher-remuda --type=merge -p '{"spec":{"running":false}}'
kubectl delete environment multi-idp -n rancher-remuda
```

The same objects are reachable through Rancher with an API token and no kubeconfig, over the Steve
path the extension already uses:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://<rancher>/k8s/clusters/local/v1/remuda.rancher.io.environments/rancher-remuda/multi-idp
```

Authentication and RBAC come from Rancher either way, per namespace, which is the reason the API is
a CRD rather than an HTTP server bolted onto this controller.

### Spec is intent, status is fact

Only `repo` and `branch` are required. Every other field is either defaulted by the schema
(`running`, `clusterId`, the three volume sizes) or left empty for the controller to resolve from
the target cluster — the base domain, the backend image for that branch, the ingress class, the
storage class, the issuer, and a pair of nested CIDRs that clear the host cluster's.

Setting a resolvable field **pins** it and skips that piece of discovery. Whatever was used, pinned
or resolved, is written back to `status.resolved`, so `kubectl get environment -o yaml` shows what
an environment is actually running with rather than only what was asked for.

`status.run` is read back from the backend Deployment rather than from `spec.running`, so an
environment someone scaled by hand reads as stopped here. That is deliberate: there is no second
copy of the truth to drift from the first.

### Why the CRD lives in `templates/`

Helm installs `crds/` once and never upgrades it. For a schema still at `v1alpha1` that would mean
every field added later silently failing to reach an existing install, surfacing as the API server
dropping the field. It is a template with `helm.sh/resource-policy: keep` instead, which upgrades
normally and still survives an uninstall along with every Environment under it.

### What the controller does with one

Every pass, for each Environment: resolve what the spec left out, create whatever is missing, scale
both Deployments to match `spec.running`, and write back what it found.

**Create-if-absent, not apply.** These are dev instances people poke at — an image swapped by hand,
a resource limit raised to get one build through — and a controller that reverted those every 30
seconds would be worse than useless. Replicas are the one exception, because that is the field
`spec.running` actually means.

**Deletion is the garbage collector's job.** Every object carries an owner reference back to its
Environment, so `kubectl delete environment` collects the lot — build pods included. The extension
has to sweep those by hand, because a `DELETE` on a Job defaults to Orphan propagation and the
stranded pod then blocks its PVCs from ever finalising.

**The build Job is only ever started once.** A Job is immutable, so a rebuild is a fresh Job with a
fresh name; doing that on a schedule would rebuild every environment every interval. Triggering a
rebuild is still the UI's.

### Resolution reads the host cluster

The controller discovers the host's own defaults for itself, in `hostDefaults`: its ingress class
and default StorageClass, `server-url` and `server-version`, its ClusterIssuer or the namespaced
ACME Issuer to mirror, and a nested CIDR pair that misses the ranges its own k3s occupies. Nothing
is handed to it.

This used to read the `remuda-config` ConfigMap instead, on the reasoning that the extension had
already discovered all of it in the browser. That was wrong in a way no test caught. The extension
writes that ConfigMap to the cluster an environment **targets**, while this controller only ever
runs on — and reads — the host. Targeting the host cluster hid it, because there the two are the
same cluster. Every downstream environment on a Rancher where nobody had first created a local one
therefore sat at `Resolved=False` forever, told to create an environment through the extension,
which is exactly what its owner had just done.

`remuda-config` still exists, still on the target cluster, and is now purely the extension's
prefill: it is what makes the create form come back with the answers you gave last time. Nothing
reads it here.

The one thing never guessed is the nested CIDR pair. A nested k3s sharing the host cluster's CIDRs
cannot reach its own CoreDNS, and nothing in the environment recovers from that — so the candidate
list in `hostdefaults.go` and `NESTED_CIDR_CANDIDATES` in `discovery.ts` have to stay in step.
Whichever of the two resolves an environment must reach the same answer, or the same spec produces a
different nested k3s depending on who created it.

### Downstream clusters go through Fleet

An environment on any other cluster is delivered as a `fleet.cattle.io` Bundle targeting it, and the
Fleet agent that every registered cluster already runs applies it. **Nothing is configured and no
credential is stored** — that is the whole reason this is Fleet rather than a Rancher API token in a
Secret.

The Bundle is named `remuda-<environment>` and lives in the cluster's Fleet workspace, read from
`spec.fleetWorkspaceName` on the management `Cluster` (`fleet-local` for the host, `fleet-default`
for most others). It targets by the `management.cattle.io/cluster-name` label rather than by the
Fleet cluster's own name, which is the display name someone chose rather than the `c-m-…` id
everything else here speaks in.

Three Bundle fields are deliberately left at Fleet's defaults. **`correctDrift`** is off, so Fleet
*reports* drift and does not revert it — the same posture the host path takes, because these are dev
instances people poke at. **`keepResources`** is off, so deleting the Bundle takes the workload.
**`deleteNamespace`** is off, because `rancher-remuda` on the far side is shared.

Deleting a Bundle is a sweep rather than a finalizer. A Bundle lives in a Fleet workspace while its
Environment lives in `rancher-remuda`, and Kubernetes forbids an owner reference across namespaces,
so nothing collects it on its own. A finalizer would need write access to the spec that this
controller deliberately does not have, and would wedge every Environment in `Terminating` if the
chart were ever uninstalled with environments still running. `reapBundles` runs after a **successful**
list and removes Bundles whose Environment is gone, keyed on its UID rather than its name.

#### What a downstream environment must pin

Fleet delivers; it does not read back. So nothing here can see the target cluster's ingress class,
its default StorageClass, or the CIDRs its own k3s uses — and `hostDefaults` describes the *host*,
which would be a wrong answer rather than a missing one. A downstream Environment therefore has to
set `ingressClass`, `storageClass`, `nestedPodCidr` and `nestedServiceCidr`, and says so in a
condition naming exactly which are absent. The extension can see all four and writes them in.

#### What is lost downstream

- **Build state.** Measured against a live Fleet: it tracks Deployments and PVCs but not Jobs, so
  `status.build` is `Unknown` and the `Provisioned` condition says so. Lost to *this controller*, not
  to the extension — a browser holds a Rancher session for every cluster, so both the list and the
  detail page read the target's Jobs directly and show the real state.
- **`Stopping`.** Fleet reports whether a Deployment matches its spec, not whether a pod is still
  terminating — so a stop reads `Stopped` at once, and the window where the backend still holds the
  RWO data volume is invisible.
- **Hand-scaling.** `kubectl scale` on the far side still reads `Ready` here. Fleet notices and puts
  it in the Bundle's `modifiedStatus`; `status.run` does not.

## How the hop resync works

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
