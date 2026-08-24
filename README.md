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

**Wildcard DNS** for the base domain, pointing at the management cluster's ingress, is the only thing
needed **once, on the management cluster** — the one serving this Rancher. The base domain is derived
from the host Rancher's `server-url`, so for a Rancher at `https://example.ui.rancher.space` add
`*.example.ui.rancher.space`. A downstream cluster needs no DNS record of its own; see
[Downstream clusters](#downstream-clusters).

A management cluster that cannot do this — one reached by IP, or a Rancher running in Docker, whose
k3s has no ingress controller at all — is not out of luck. Environments on a **downstream** cluster
fall back to being reached directly there; see [Direct exposure](#direct-exposure-the-fallback). Only
an environment targeting `local` genuinely needs the management cluster to be able to serve it.

### TLS needs no setup

A Rancher installed with Let's Encrypt already has an `Issuer` named `rancher` in `cattle-system`,
created by its own Helm chart for the server certificate. That Issuer cannot be used directly —
`cert-manager.io/issuer` resolves in the **Ingress's own namespace**, so an Issuer in `cattle-system`
is invisible to an Ingress in `rancher-remuda`, and only a `ClusterIssuer` crosses namespaces.

So Remuda copies its ACME configuration into an `Issuer` of its own, `remuda-le`, in the environment's
namespace. That Issuer is created once per namespace and shared by every environment in it, and it is
never removed when one environment is deleted. cert-manager registers a fresh ACME account against the
same email address as the cluster's existing issuer. The create form says when this is happening, and
names the Issuer it copied.

For a downstream environment the Issuer is created on the **management** cluster, because that is
where the hop terminates TLS.

> This was not always true. Until `v0.1.5` the extension looked only for a `ClusterIssuer`, found none
> on a stock Rancher, and created environments with no `tls:` block at all — traefik then served
> `CN=TRAEFIK DEFAULT CERT` and the browser refused it. Every cluster it had been developed against
> had a hand-made `ClusterIssuer`, so the out-of-the-box path had never once run.

**A `ClusterIssuer` still wins if you have one.** It is explicit operator configuration and is used
as-is, with nothing copied. Create one if you want every namespace on the cluster to share a single ACME
account, or to use an issuer other than the one Rancher configured for itself:

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

With neither a `ClusterIssuer` nor an ACME `Issuer` anywhere on the cluster, an environment is still
created, but with no TLS — the create form warns before you get there.

> Let's Encrypt limits certificates per **registered domain** (50/week). Where many instances share
> one domain, churning environments will eat into that shared budget. Use the staging ACME endpoint
> for routine testing, or a DNS-01 wildcard certificate.

### Downstream clusters

An environment's hostname normally comes off the management cluster's single wildcard, so that
wildcard can never point at a downstream cluster. Rather than ask for a second DNS record per cluster,
the extension creates a **hop** on the management cluster: a selector-less Service, an EndpointSlice
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

### Direct exposure (the fallback)

The hop asks two things of the management cluster: an ingress controller that can be pointed upstream
over HTTPS, and a base domain that can carry a subdomain. A Rancher running in **Docker** has neither.
Its embedded k3s starts with traefik and servicelb disabled — `kube-system` holds coredns and nothing
else — so there is no `IngressClass` to write into the hop's Ingress, and one cannot usefully be
installed either: the container's :443 belongs to the Rancher process, no servicelb exists to fill a
LoadBalancer, and NodePorts are not published by the `docker run`. Such a Rancher is also typically
reached by IP, and `my-feature.13.53.41.140` is not a hostname that any DNS record can make resolve.

When either condition holds, a downstream environment is exposed **directly** instead: no hop, and
the hostname is built from the target cluster's own ingress address using
[sslip.io](https://sslip.io), which resolves any address embedded in a name. So an environment on a
cluster whose ingress answers on `44.247.97.31` becomes `my-feature.44.247.97.31.sslip.io`, served by
the Ingress that already sits next to the workload — exactly as a `local` environment is. Nothing has
to be registered, and nothing is written to the management cluster at all.

The create form says which of the conditions applied and where the environment will answer. Three
things follow from it:

- **TLS terminates on the target cluster**, not the management cluster, so its issuer is the one that
  matters. A cluster without cert-manager gets an environment without TLS, and the form says so.
- **The address is part of the hostname**, and is baked into the UI bundle's asset URLs at build time.
  Replacing the target's node means recreating the environment; there is nothing to repoint. (This is
  what the hop buys, and why it stays the default wherever it can work.)
- **The base domain is only a default.** Type a domain the team controls and it is used instead, with
  the wildcard record pointed at the target cluster's ingress — the same arrangement, without the
  dependency on a third party's DNS.

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

A build needs roughly **5.5 GiB of memory** at the Job's 4 CPU limit, which is why it requests
4Gi and is capped at 7Gi.

That memory figure is tied to the CPU limit rather than to the heap ceiling. Node reads the cgroup
CPU quota for `os.availableParallelism()`, and webpack's minifier opens that many worker isolates,
so peak memory scales with the CPU cap. Benchmarked against `rancher/dashboard` master on node 24:

| CPU limit | Peak memory | webpack wall time |
| --------- | ----------- | ----------------- |
| 2         | 4.3 GiB     | 44s               |
| 4         | 5.3 GiB     | 27s               |
| 8         | 6.0 GiB     | 26s               |
| uncapped  | 7.4 GiB     | 25s               |

So raising `limits.cpu` buys very little wall time above 4 and costs real memory, and removing it
lets the build fan out to the node's core count. Lowering it to 2 saves ~1 GiB at roughly a 60%
longer webpack run. The `--max_old_space_size=4096` heap ceiling is close to irrelevant to the peak
by comparison -- 3072 and 2048 land within ~700 MiB of it -- but the build does OOM at 1024.

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

One command ships everything:

```bash
yarn version --new-version 0.2.0
git push && git push --tags
```

`yarn version` bumps the root `package.json`, then runs two lifecycle hooks before it commits:

- **`preversion`** — `yarn lint && yarn test && yarn build-pkg remuda`. A version that does not build
  never gets tagged. `v0.1.0` published an empty bundle because nothing checked this.
- **`version`** — `scripts/bump-version --sync --stage`, which copies the new version into
  `pkg/remuda/package.json` and the controller's `Chart.yaml`, and stages exactly those files.

Yarn then commits all of it as `v0.2.0` and tags it, which is the tag `release.yml` triggers on.

> Use `--new-version`. A bare `yarn version 0.2.0` ignores the argument and prompts instead.

`scripts/bump-version` rewrites the version in the three files that carry it — the root
`package.json`, `pkg/remuda/package.json`, and the controller's `Chart.yaml` (`version` and
`appVersion`). **Use it rather than editing those by hand**; missing one is the easiest way to fail a
release.

The same script enforces this, so CI and the bump can never disagree about which files carry a
version:

```bash
scripts/bump-version --check          # do they agree with each other?
scripts/bump-version --check 0.2.0    # do they all equal 0.2.0?
```

CI runs the first form on every push, so a hand-edited version fails on the commit that caused it.
`release.yml` runs the second against the tag, so a mistyped tag fails immediately rather than
halfway through.

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
