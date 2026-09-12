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

## As a GitHub Actions workflow

`action.mjs` is the same bot as a workflow step, and `workflow.yml` is the workflow. There is no
server, no public endpoint and no webhook secret — GitHub runs the step for the event itself — and
comments come from `github-actions[bot]` through the run's own token.

It listens for `pull_request_target` rather than `pull_request`, so the workflow and its secrets come
from the base repository and a pull request cannot rewrite either. That is only safe because the job
never checks out the pull request: the one thing it runs is this directory, pinned to a commit.

On the repository the pull requests are opened against:

1. Put `workflow.yml` at `.github/workflows/remuda.yml` on the **default branch**, with `RANCHER_URL`
   and the pinned commit filled in. `issue_comment` only runs workflows from the default branch.
2. `gh label create remuda --repo <owner>/<repo> --description "Build a Remuda environment for this pull request"`
3. `gh secret set REMUDA_TOKEN --repo <owner>/<repo>`, with a Rancher API token that can manage
   Environments.

A run holds its runner until the environment answers, so the comment with the URL comes from it, for
up to `WATCH_TIMEOUT_MINUTES` (default 20). A later event on the same pull request cancels that wait.

To try the step locally, have the simulator write the event and run it the way Actions would:

```sh
export GITHUB_EVENT_PATH=/tmp/event.json
export GITHUB_EVENT_NAME="$(node simulate.mjs label --pr <owner>/<repo>#<n> --event-file "$GITHUB_EVENT_PATH")"
RANCHER_URL=https://<rancher> REMUDA_TOKEN=token-xxxxx:yyyy REMUDA_DRY_RUN=1 node action.mjs
```

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
