# Remuda

A Rancher UI extension that deploys a Rancher instance running a **dashboard branch**, so QA,
designers and other developers can click through work-in-progress UI changes without anyone
standing up a backend by hand. (A *remuda* is the string of spare horses a ranch keeps so a rider
always has a fresh one ready.)

Give it a repo and a branch — including a personal fork such as
`github.com/rak-phillip/dashboard` @ `task/17295-multi-idp` — and it builds the dashboard in the
target cluster, deploys a Rancher backend configured to serve that bundle, and hands back one HTTPS
URL and a bootstrap password.

## Why a build, rather than a published bundle

`rancher/dashboard`'s `build-and-upload-branch.yaml` is gated on
`github.repository_owner == 'rancher'`, so a fork branch never produces a bundle on
`releases.rancher.com`. The extension therefore builds the branch itself, in-cluster.

## How the UI swap works

1. The build Job clones the branch and runs the dashboard build with
   `RESOURCE_BASE=https://<host>/ui-bundle`. Asset URLs are absolute and baked in at build time, so
   the serving location has to be decided before the build runs.
2. nginx serves the result at `https://<host>/ui-bundle/`, on the same ingress and certificate as
   the backend — same origin, so no CORS.
3. The Rancher backend runs with `CATTLE_UI_DASHBOARD_INDEX` and `CATTLE_UI_OFFLINE_PREFERRED=false`.
   Every Rancher setting can be overridden by a `CATTLE_<NAME>` env var, so no post-deploy API calls
   or authentication into the dev instance are needed.

`ui-offline-preferred` is set to `false` rather than `dynamic` deliberately: `dynamic` gates on a
download check wrapped in a `sync.Once`, so if the bundle is not up at that instant Rancher falls
back to its embedded UI for the life of the process — and the bundle is built asynchronously.

The index is fetched **server-side** by the Rancher pod, so it points at the in-cluster Service.
The assets are fetched by the **browser**, so they point at the public host. Each URL is only used
where it is reachable.

## Running Rancher inside Kubernetes

The backend image is the single-container Rancher, which starts its own k3s in the pod. Two things
about that are not obvious, and between them they are why an environment would come up and then
never become usable. Both are handled in `utils/manifests.ts`; this is the record of why.

### The nested k3s needs its own CIDRs

Embedded k3s defaults to podCIDR `10.42.0.0/16` and serviceCIDR `10.43.0.0/16` -- the same defaults
the host k3s is almost certainly using. Both clusters' routes and iptables rules then live in the
pod's single network namespace, and the nested pods cannot reach their own CoreDNS. From there:
system charts never install, the `remotedialer-proxy` chart never brings up `app=api-extension`,
`Service/imperative-api-extension` has no endpoints, and steve answers every request with
`503 API Aggregation not ready` until Rancher gives up and fatals.

Plain `docker run` never shows this, because Docker's bridge is `172.17.x.x` and nothing overlaps.

The fix is a ConfigMap mounted at `/etc/rancher/k3s/config.yaml` setting non-overlapping
`cluster-cidr` / `service-cidr` / `cluster-dns`. That file is read because Rancher launches the
nested cluster as a **subprocess of the real k3s binary** -- `exec.Command("k3s", "server", ...)` in
`rancher/norman`'s `pkg/kwrapper/k8s/k3s_linux.go` -- so k3s does its own CLI parsing. It is also the
only lever available: the image entrypoint ends with `exec catatonit -- rancher ... "${@}"`, so
trailing args go to `rancher`, never to `k3s`.

The pair is chosen at create time against the host's own ranges (`pickNestedCidrs`), so a host that
already uses `10.44`/`10.45` gets the next candidate instead.

### The node's inotify limits have to be raised

`fs.inotify.max_user_instances` defaults to **128**, is counted **per-uid across the whole host**,
and is **not a namespaced sysctl**. Every nested k3s on a node runs its own apiserver, kubelet and
containerd, and they all draw from that one budget.

When it runs out, what fails is the nested containerd's CRI plugin:

```
failed to create CRI service: failed to create cni conf monitor for default:
failed to create fsnotify watcher: too many open files
```

The nested cluster then has **no node at all** and every pod in it sits `Pending` -- including
CoreDNS, which makes it look like the CIDR problem above. It is worth checking the two apart:
`kubectl get nodes` inside the pod returns `No resources found` for this one.

Because the budget is host-global, this gets worse with each environment on a node, which is what
made it present as intermittent. A pod cannot fix it with `securityContext.sysctls` -- those only
accept namespaced sysctls -- so the backend runs a privileged init container that writes
`/proc/sys/fs/inotify/*` directly. It is best-effort and echoes the resulting values, so
`kubectl logs <pod> -c raise-inotify-limits` says what actually took effect.

### dnsPolicy stays at ClusterFirst

Setting `dnsPolicy: Default` looks tempting while the CIDRs collide, because the container then
stops using a `10.43.0.10` that means two different things. Once the CIDRs are separated it is
actively wrong: the node's resolvers do not resolve `*.svc.cluster.local`, which is exactly what
`CATTLE_UI_DASHBOARD_INDEX` points at.

## Prerequisites

These are needed **once, on the management cluster** — the one serving this Rancher. A downstream
cluster needs neither of them; see [Downstream clusters](#downstream-clusters).

1. **Wildcard DNS** for the base domain, pointing at the management cluster's ingress. The base
   domain is derived from the host Rancher's `server-url`, so for a Rancher at
   `https://example.ui.rancher.space` add `*.example.ui.rancher.space`.
2. **A cert-manager `ClusterIssuer`.** A namespaced `Issuer` will not work — environments live in
   their own namespace.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: remuda-le }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: { name: remuda-le-account }
    solvers: [{ http01: { ingress: { class: traefik } } }]
```

Without an issuer an environment is still created, but with no TLS.

> Let's Encrypt limits certificates per **registered domain** (50/week). Where many instances share
> one domain, churning environments will eat into that shared budget. Use the staging ACME endpoint
> for routine testing, or a DNS-01 wildcard certificate.

### Downstream clusters

An environment's hostname always comes off the management cluster's single wildcard, so that wildcard
can never point at a downstream cluster. Rather than ask for a second DNS record per cluster, the
extension creates a **hop** on the management cluster: a selector-less Service, an EndpointSlice
carrying the downstream cluster's ingress addresses, and an Ingress for the environment's hostname
(plus a `ServersTransport` where the management cluster runs traefik).

The practical effect is that a downstream cluster needs **no wildcard DNS and no cert-manager** — TLS
terminates on the management cluster. What it does need:

- An **ingress controller reachable from outside the cluster on :443**, via a LoadBalancer Service, a
  NodePort, or a host port. RKE2's bundled traefik qualifies as-is.
- A **default StorageClass**. The create form offers to install local-path if there is none.

Two consequences worth knowing:

- **Hostnames are unique across every cluster at once**, because they all share one wildcard. The
  create form refuses a name already claimed.
- **The hop uses the node's public address** where it has one, so traffic between the two clusters
  leaves the VPC. It is encrypted, but the downstream ingress serves its own self-signed certificate
  and the management cluster does not verify it. Treat these environments as exposed. The create form
  says so, naming the address.

> The hop is repaired automatically only while an environment's detail page is open **and in the
> foreground** — browsers throttle timers in background tabs. If a downstream node is replaced while
> nobody is looking, the environment stays unreachable until that page is opened again, or until
> someone presses **Re-sync networking**.

### remuda-controller (optional)

`controller/` is a small Go controller that removes that condition, reconciling every hop on the
management cluster whether or not anyone is looking. It writes EndpointSlices and nothing else —
the split is that **the UI discovers topology once at create; the controller refreshes addresses
forever** — and it reads downstream node addresses from `nodes.management.cattle.io`, so it needs no
downstream credentials.

It ships as its own chart, separate from the UIPlugin chart, because that one is regenerated from an
upstream template on every publish and cannot carry extra templates:

```bash
helm install remuda-controller ./deploy/chart/remuda-controller -n cattle-remuda-system --create-namespace
```

Everything works without it; the hop is simply repaired only while a detail page is in the
foreground. See `controller/README.md`.

## Resource cost

A build needs roughly **6-8 GiB of memory** (`node_modules` is ~855 MB and the dashboard build
already runs with `--max_old_space_size=4096`).

Measured on a single 8 CPU / 32 GiB node, cold, with no cache: **4.6 minutes** end to end for the
build Job, of which webpack was ~2.5 minutes and the rest `yarn install`. A rebuild reusing the cache
volume is faster.

The Rancher backend is slower to be *useful* than to be *ready*: its pod reports ready in seconds,
but the nested cluster still has to install its system charts. Measured cold on an 8 CPU / 32 GiB
node: **~3m45s** from pod start to `/dashboard/` returning 200, with no restarts. Expect
`503 API Aggregation not ready` throughout that window — that is the nested cluster still coming up,
not a problem with the bundle.

A quick way to tell a healthy start from a stuck one, from inside the backend pod:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes                                  # local-node Ready, within ~1 min
kubectl get apiservice v1.ext.cattle.io            # AVAILABLE True once charts land
```

`No resources found` from the first command means the nested kubelet never registered — see
[the inotify note](#the-nodes-inotify-limits-have-to-be-raised).

One build at a time is comfortable on such a node.

## Installing

Add the Helm repository once, in **Apps → Repositories → Create → Helm Repository**:

```
Index URL   https://rak-phillip.github.io/remuda/
```

**Remuda** then appears under **Extensions**, and `remuda-controller` under **Apps → Charts**.

Two things worth knowing before installing:

- The extension bundle is fetched at runtime from `raw.githubusercontent.com`, so the cluster running
  `ui-plugin-server` needs egress to GitHub. For an air-gapped install use the Extension Catalog Image
  at `ghcr.io/rak-phillip/ui-extension-remuda` instead, via **Extensions → Manage Extension Catalogs**.
- The controller is optional. Without it the cross-cluster hop is still repaired, but only while an
  environment's detail page is open and in the foreground.

## Releasing

One tag ships everything:

```bash
scripts/bump-version 0.2.0
git commit -am 'Release 0.2.0'
git tag v0.2.0 && git push && git push --tags
```

`scripts/bump-version` rewrites the version in the three files that carry it — the root
`package.json`, `pkg/remuda/package.json`, and the controller's `Chart.yaml` (`version` and
`appVersion`). `.github/workflows/release.yml` refuses to publish if any of them disagrees with the
tag, so a mistyped tag fails immediately rather than halfway through.

The tag is `vX.Y.Z`, but the Rancher tooling matches on `<package name>-<version>`. The workflow
derives `remuda-X.Y.Z` and passes that down; the upstream scripts never see the `v` form.

What a tag produces:

| Job | Artifact | Lands in |
|---|---|---|
| `charts` | Extension chart + plugin bundle | `gh-pages` → the Helm repo above |
| `catalog` | Extension Catalog Image | `ghcr.io/rak-phillip/ui-extension-remuda` |
| `controller-image` | Controller image | `ghcr.io/rak-phillip/remuda-controller` |
| `controller-chart` | Controller chart | `gh-pages`, merged into the same index |

`controller-chart` runs strictly after `charts`, because both push to `gh-pages`.

### First-time repository setup

Needed once, before the first tag. The publish script aborts without the branch, and the index is
only reachable over rate-limited `raw.githubusercontent.com` without Pages:

```bash
git switch --orphan gh-pages && git commit --allow-empty -m 'Initialise Helm repository'
git push -u origin gh-pages && git switch main

gh api -X POST repos/rak-phillip/remuda/pages \
  -f 'source[branch]=gh-pages' -f 'source[path]=/'
```

## Development

```bash
yarn install
API=https://your-rancher yarn dev     # https://127.0.0.1:8005
yarn test
yarn lint
yarn build-pkg remuda
```

## Caveats

- The backend pod sets `automountServiceAccountToken: false`. Rancher's single-container image
  chooses between embedded-k3s and in-cluster mode partly on whether a service account token is
  present, and without this it can try to drive the *host* cluster. Verify embedded-k3s startup in
  the pod logs the first time you deploy to a new cluster.
- The init container raises a **host-wide** limit, and nothing lowers it again when the environment
  is deleted. That is deliberate -- it is a ceiling, not an allocation -- but it does mean a node
  keeps the raised value until it reboots.
- The bundle volume is written by the build Job and read by nginx. With a `ReadWriteOnce` storage
  class both pods must land on the same node; this is automatic with node-local storage, but on a
  multi-node cluster with network-backed RWO storage prefer an RWX class. An nginx pod stuck
  `Pending` is usually this.
- Deploying into the `local` management cluster works but is discouraged — the environment competes
  with the Rancher running the extension. The create form warns but does not block.
