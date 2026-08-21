# Rancher Dev Environments

A Rancher UI extension that deploys a Rancher instance running a **dashboard branch**, so QA,
designers and other developers can click through work-in-progress UI changes without anyone
standing up a backend by hand.

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

## Per-cluster prerequisites

1. **Wildcard DNS** for the base domain, pointing at the cluster's ingress. The base domain is
   derived from the host Rancher's `server-url`, so for a Rancher at
   `https://example.ui.rancher.space` add `*.example.ui.rancher.space`.
2. **A cert-manager `ClusterIssuer`.** A namespaced `Issuer` will not work — environments live in
   their own namespace.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: dev-envs-le }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: { name: dev-envs-le-account }
    solvers: [{ http01: { ingress: { class: traefik } } }]
```

Without an issuer an environment is still created, but with no TLS.

> Let's Encrypt limits certificates per **registered domain** (50/week). Where many instances share
> one domain, churning environments will eat into that shared budget. Use the staging ACME endpoint
> for routine testing, or a DNS-01 wildcard certificate.

## Resource cost

A build needs roughly **6-8 GiB of memory** and takes **8-15 minutes cold** (`node_modules` is
~855 MB and the dashboard build already runs with `--max_old_space_size=4096`). A rebuild reusing the
cache volume is faster. The Rancher backend itself is privileged and boots an embedded k3s, so it
also takes several minutes to become ready.

Budget accordingly: a single 8 CPU / 32 GiB node comfortably runs one build at a time.

## Development

```bash
yarn install
API=https://your-rancher yarn dev     # https://127.0.0.1:8005
yarn test
yarn lint
yarn build-pkg rancher-dev-envs
```

## Caveats

- The backend pod sets `automountServiceAccountToken: false`. Rancher's single-container image
  chooses between embedded-k3s and in-cluster mode partly on whether a service account token is
  present, and without this it can try to drive the *host* cluster. Verify embedded-k3s startup in
  the pod logs the first time you deploy to a new cluster.
- The bundle volume is written by the build Job and read by nginx. With a `ReadWriteOnce` storage
  class both pods must land on the same node; this is automatic with node-local storage, but on a
  multi-node cluster with network-backed RWO storage prefer an RWX class. An nginx pod stuck
  `Pending` is usually this.
- Deploying into the `local` management cluster works but is discouraged — the environment competes
  with the Rancher running the extension. The create form warns but does not block.
