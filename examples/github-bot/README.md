# Remuda GitHub bot (prototype)

A pull request gets an environment when a maintainer labels it `remuda`, and loses it when it
closes. Nothing here is part of Remuda: it is an ordinary client of the Environment CRD, which is the
point — anything holding a token can do what this does.

Zero dependencies. Node 20 or newer.

## What it does

| GitHub delivery | Environment operation |
| --- | --- |
| `pull_request.labeled` with `remuda` | create `<repo>-pr-<number>` from the head repository and branch |
| `pull_request.reopened`, still labelled | create |
| `pull_request.synchronize`, labelled, **same repository** | rebuild (merge patch of `spec.rebuildRequest`) |
| `pull_request.synchronize`, labelled, **fork** | nothing — waits for a maintainer's `/remuda rebuild` |
| `pull_request.unlabeled` `remuda`, or `pull_request.closed` | delete |
| comment `/remuda up` · `rebuild` · `down` from an OWNER, MEMBER or COLLABORATOR | create · rebuild · delete |

The Environment it creates is three fields — `repo`, `branch`, `owner` — plus labels and an annotation
linking back to the pull request. The controller resolves everything else. A downstream target adds
the four fields Fleet cannot read back, from `PIN_*` configuration.

## Proving it out locally

The simulator sends the deliveries GitHub would, built from a **real** pull request (fetched with
your `gh` login) and signed with the webhook secret. `REMUDA_DRY_RUN=1` sends every write with
`?dryRun=All`, so the real API server admits, defaults and validates each Environment exactly as it
would — and persists nothing. Comments are printed, not posted, unless `POST_COMMENTS=1`.

```sh
cd examples/github-bot
node --test                                   # the planning and client logic

export WEBHOOK_SECRET=local-secret
RANCHER_URL=https://<rancher> REMUDA_TOKEN=token-xxxxx:yyyy \
  REMUDA_DRY_RUN=1 GITHUB_TOKEN="$(gh auth token)" node server.mjs &

node simulate.mjs label --pr rancher/dashboard#18994
node simulate.mjs push                       # a fork: skipped, with the reason
node simulate.mjs comment-up                 # resolves the PR through the GitHub API
node simulate.mjs untrusted-comment          # refused
node simulate.mjs bad-signature              # 401
node simulate.mjs close
```

Drop `REMUDA_DRY_RUN` and the same commands create a real environment, and the bot follows it until
it answers and prints the URL.

To take real deliveries from GitHub on a laptop, point a repository webhook at a forwarder such as
`gh webhook forward --repo <you>/<repo> --events pull_request,issue_comment --url http://localhost:8787/webhook`
(the `cli/gh-webhook` extension) or smee.io.

## Configuration

| Variable | |
| --- | --- |
| `WEBHOOK_SECRET` | required; the repository webhook's secret |
| `RANCHER_URL` + `REMUDA_TOKEN` | from outside the cluster: a Rancher API token |
| `KUBE_API_SERVER` + `REMUDA_TOKEN_FILE` | from inside it: `https://kubernetes.default.svc` and the projected ServiceAccount token, read per request because it rotates. Set `NODE_EXTRA_CA_CERTS` to the ServiceAccount's `ca.crt`. |
| `TARGET_CLUSTER` | default `local`; anything else requires `PIN_INGRESS_CLASS`, `PIN_STORAGE_CLASS`, `PIN_NESTED_POD_CIDR`, `PIN_NESTED_SERVICE_CIDR` |
| `MAX_ENVIRONMENTS` | default 5; counted over Environments labelled `remuda.rancher.io/source=github` |
| `NAME_PREFIX` | default: the repository name |
| `GITHUB_TOKEN` | reads the pull request for `/remuda up`; posts comments only with `POST_COMMENTS=1` |
| `REMUDA_DRY_RUN=1` | validate writes against the real API server, persist nothing |
| `WATCH=0` | do not follow a new environment until it answers |

## Running it for real

Run it as a Deployment on the host cluster with the ServiceAccount in `rbac.yaml`, which can touch
Environments in `rancher-remuda` and nothing else, and expose `/webhook` through an Ingress on the
same wildcard the environments use. A GitHub App rather than a repository webhook gives it its own
identity for comments and a token that is not a person's.

Before pointing it at a public repository:

- **The build runs the branch's code.** `yarn install` executes install scripts from the pull request
  inside the build pod, on your cluster's network. That is why a label, not a pull request, is the
  trigger, and why a fork's later pushes wait for a maintainer.
- **An environment is a public Rancher.** The bot never posts the bootstrap password, but the URL is
  in a public comment. Treat environments as exposed.
- **Acknowledge fast.** GitHub gives a delivery ten seconds. This prototype does the API calls inline,
  which fits; a production bot should acknowledge first and work from a queue.
- **The API server does not check name length.** A name over 46 characters is admitted and then
  breaks the build Job. `environmentName` caps it; any other client has to do the same.
- **Rebuilds need a current controller.** An older CRD drops `spec.rebuildRequest` without an error;
  the client notices by reading the field back.
