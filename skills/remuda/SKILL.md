---
name: remuda
description: Create, inspect and tear down Remuda dev environments - a running Rancher serving a dashboard branch - from a git checkout. Use when asked to spin up, build, preview, rebuild, stop or delete an environment for a branch or PR, to get a URL and login for work in progress, or to hand a branch to QA or a designer to click through. Triggers on "remuda", "dev environment", "preview environment", "spin up an environment", "environment for this branch".
---

# Remuda

Remuda builds a dashboard branch and runs a Rancher backend serving it, and hands back one HTTPS URL
and a bootstrap password. This skill drives the `Environment` CRD directly — the same API the Rancher
extension uses.

`remuda.mjs` lives beside this file; `<skill-dir>` below means this skill's own directory, wherever it
was installed. Run it with `node`; it needs Node 20 or newer and nothing else.

```sh
node <skill-dir>/remuda.mjs doctor
```

## Before anything else

Run `doctor` on the first use in a session. It prints the configured Rancher, the target cluster, the
required pins, whether `remuda-controller` is installed, and what this checkout would build. Three of
its answers are the only ones worth stopping on:

- **`controller MISSING`** — the Environment API is not installed on that Rancher. Nothing can be
  created. Tell the user to create one environment from the Remuda extension's Create page in the
  Rancher UI; submitting that form is what installs the controller. Logging in or opening the
  Environments list does not. Do not try to install a Helm chart yourself.
- **`(unset)` for the Rancher or the token** — ask for them rather than guessing. They go in
  `~/.config/remuda/config.json` or in `RANCHER_URL` / `REMUDA_TOKEN`.
- **a pin `(unset -- required for a downstream cluster)`** — an environment on any cluster but `local`
  must pin `ingressClass`, `storageClass`, `nestedPodCidr` and `nestedServiceCidr`, because Fleet
  delivers to that cluster and cannot read anything back from it. The values come from the target
  cluster, not from the host.

## Creating one

From a dashboard checkout, with the branch pushed:

```sh
node <skill-dir>/remuda.mjs create            # this checkout's remote and branch
node <skill-dir>/remuda.mjs create --no-wait  # return as soon as it is accepted
node <skill-dir>/remuda.mjs create --branch task/17295-multi-idp --repo https://github.com/rak-phillip/dashboard
```

**The branch must be pushed to a remote.** The build pod clones anonymously over HTTPS with no
credentials, so an unpushed branch — or one only on a private remote — fails in the build Job several
minutes later with `couldn't find remote ref`. `create` refuses up front; if the user wants it
anyway, `--force`. If the branch is pushed but behind the local checkout, the build uses the pushed
commit and the tool says so — offer to push before creating.

Creating is not the slow part. **Expect 8–9 minutes** before the URL answers: roughly 4.5 minutes of
build (`yarn install` then webpack) and another ~3.5 minutes for the nested k3s inside the backend pod
to install its system charts. `create` follows it and prints each state change. `503 API Aggregation
not ready` throughout that window is the nested cluster still coming up, not a fault — never report it
as a failure.

Do not start several environments at once without saying what it costs: a build needs ~5.5 GiB and 4
CPUs, and one build at a time is comfortable on an 8-CPU node.

## Reading one back

```sh
node <skill-dir>/remuda.mjs list
node <skill-dir>/remuda.mjs get <name>        # state, URL, and the admin password
node <skill-dir>/remuda.mjs wait <name>       # follow one that is still coming up
```

`build=Unknown` is normal and permanent for an environment on a downstream cluster: Fleet tracks
Deployments and PVCs but not Jobs. The URL answering is the signal that matters on both paths, and it
is what `wait` waits for. Report `Unknown` as "not visible from here", never as a problem.

The login is always `admin` plus the generated password. **Print the password when the user asked for
the environment**; it is theirs. Do not paste it into a commit message, a PR comment, or anything else
that leaves the terminal.

## Changing one

```sh
node <skill-dir>/remuda.mjs rebuild <name>    # build the branch's current head again
node <skill-dir>/remuda.mjs stop <name>       # scale to zero, keep the data and the URL
node <skill-dir>/remuda.mjs start <name>
node <skill-dir>/remuda.mjs delete <name>     # takes everything it owns with it
```

After pushing new commits to a branch that already has an environment, `rebuild` is the right move —
not a second `create`. A rebuild reuses the yarn cache volume and is faster than the first build.

`delete` is not recoverable and takes the volumes, so confirm the name with the user before running
it, even when they named it themselves. `stop` is the reversible one; suggest it when someone wants an
environment "out of the way".

## Reporting back

Give the user the URL, the login, and the state, and keep it to a few lines. When something is still
coming up, say which phase it is in rather than that it is broken. A `Resolved: ...` problem line names
exactly which field the controller could not settle — pass that through verbatim; it is the actionable
part.
