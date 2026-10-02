# Remuda skill for coding agents

A skill for Claude Code, Codex, pi and other coding agents that creates and manages environments from a
dashboard checkout. Nothing here is part of Remuda: it is an ordinary client of the Environment CRD,
which is the point — anything holding a token can do what this does.

Zero dependencies. Node 20 or newer.

## Install

The skill is a plain [Agent Skills](https://agentskills.io) directory: a `SKILL.md` plus the script it
runs. Link it into whichever agent you use:

```sh
ln -s "$PWD/skills/remuda" ~/.claude/skills/remuda   # Claude Code
ln -s "$PWD/skills/remuda" ~/.agents/skills/remuda   # Codex and pi
```

A symlink rather than a copy, so the skill moves with the repository. Both directories are read from
every project, which is what makes it usable from a `rancher/dashboard` checkout.

## Configure

```sh
mkdir -p ~/.config/remuda
cat > ~/.config/remuda/config.json <<'JSON'
{
  "rancherUrl": "https://<rancher>",
  "token": "token-xxxxx:yyyyy",
  "clusterId": "local"
}
JSON
chmod 600 ~/.config/remuda/config.json
```

`RANCHER_URL`, `REMUDA_TOKEN`, `REMUDA_CLUSTER`, `REMUDA_OWNER` and `REMUDA_DRY_RUN=1` override the
file. A cluster other than `local` also needs the four pins Fleet cannot read back, either as
`PIN_INGRESS_CLASS`, `PIN_STORAGE_CLASS`, `PIN_NESTED_POD_CIDR`, `PIN_NESTED_SERVICE_CIDR` or as a
`pins` object in the file:

```json
{
  "clusterId": "c-m-xxxxxxxx",
  "pins": {
    "ingressClass": "traefik",
    "storageClass": "local-path",
    "nestedPodCidr": "10.44.0.0/16",
    "nestedServiceCidr": "10.45.0.0/16"
  }
}
```

The nested pair must miss the ranges the **target** cluster's own k3s or RKE2 occupies — usually
`10.42.0.0/16` and `10.43.0.0/16`, which is why `10.44`/`10.45` is the first candidate the extension
and the controller both try. A nested k3s sharing its host's CIDRs cannot reach its own CoreDNS and
nothing in the environment recovers from it.

## What it marks an environment with

Every Environment it creates carries the label `remuda.rancher.io/source: agent-skill`, whichever agent
ran it, and the annotation `remuda.rancher.io/agent` naming that agent. The person it belongs to is
`spec.owner`, from `--owner`, `REMUDA_OWNER` or `owner` in the config file.

The agent comes from what the agent sets for its own child processes: `AI_AGENT` (Claude Code, pi), then
`CLAUDECODE`, `PI_CODING_AGENT` or `CODEX_THREAD_ID`, else `unknown`. `REMUDA_AGENT` overrides all of
them.

## Proving it out

```sh
node --test                                   # the naming and spec logic
node remuda.mjs doctor                        # configuration, controller, checkout
REMUDA_DRY_RUN=1 node remuda.mjs create       # ?dryRun=All: the real API server admits,
                                              # defaults and validates, and persists nothing
node remuda.mjs create --print                # the Environment it would send, and no request
```

## The token

A Rancher API token whose user can, on the host (`local`) cluster:

| Resource | Namespace | Verbs |
| --- | --- | --- |
| `environments.remuda.rancher.io` | `rancher-remuda` | `get`, `list`, `create`, `patch`, `delete` |
| `secrets` | `rancher-remuda` | `get` |

`patch` covers rebuild, stop and start, which are each one merge patch of the spec. An environment on a
downstream cluster keeps its bootstrap password beside the workload, so the token also needs `get` on
Secrets in `rancher-remuda` on that cluster. Nothing else: the controller creates the objects an
environment is made of, and deleting the Environment collects them.

The environment's URL is public and its Rancher is a real one. The skill prints the bootstrap password
to the terminal and nowhere else; treat environments as exposed.
