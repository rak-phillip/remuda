#!/usr/bin/env node
// Remuda from a terminal, for an agent working in a dashboard checkout.
//
// Nothing here is part of Remuda. It is an ordinary client of the Environment
// CRD -- the same API the extension uses -- which is the
// point: anything holding a token can do what this does.
//
// Zero dependencies. Node 20 or newer.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { remudaClient, RemudaError } from './client.mjs';
import {
  DOWNSTREAM_PINS, HOST_CLUSTER, SOURCE, SOURCE_LABEL, cloneUrl, detectAgent, environmentFor, environmentName,
  line, missingPins, repoSlug, summarize,
} from './env.mjs';

const CONFIG_PATH = process.env.REMUDA_CONFIG || join(homedir(), '.config', 'remuda', 'config.json');

const die = (message) => {
  console.error(`remuda: ${ message }`);
  process.exit(1);
};

/**
 * Configuration, from the environment or from a file.
 *
 * The file exists so a demo -- or a day's work -- does not begin by exporting a
 * token into a shell an agent cannot see. The environment still wins, so CI and
 * one-off overrides behave the way anyone would expect.
 */
function config() {
  let file = {};

  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    file = {};
  }

  const pins = { ...(file.pins || {}) };
  const fromEnv = {
    ingressClass:      process.env.PIN_INGRESS_CLASS,
    storageClass:      process.env.PIN_STORAGE_CLASS,
    nestedPodCidr:     process.env.PIN_NESTED_POD_CIDR,
    nestedServiceCidr: process.env.PIN_NESTED_SERVICE_CIDR,
  };

  for (const [key, value] of Object.entries(fromEnv)) {
    if (value) {
      pins[key] = value;
    }
  }

  return {
    rancherUrl: process.env.RANCHER_URL || file.rancherUrl,
    token:      process.env.REMUDA_TOKEN || file.token,
    clusterId:  process.env.REMUDA_CLUSTER || file.clusterId || HOST_CLUSTER,
    owner:      process.env.REMUDA_OWNER || file.owner,
    dryRun:     process.env.REMUDA_DRY_RUN === '1',
    pins,
  };
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/**
 * What the checkout in this directory is asking to have built.
 *
 * The remote matters as much as the branch. A build pod clones anonymously over
 * HTTPS with no credentials, so it can only ever see what is pushed to a public
 * remote -- which makes "is this branch actually on a remote?" the one check
 * worth making before creating anything. Getting it wrong costs five minutes and
 * a build Job that ends in `couldn't find remote ref`.
 */
export function checkout() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

  if (!branch || branch === 'HEAD') {
    return { error: 'not on a branch (detached HEAD, or not a git repository)' };
  }

  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  const remotes = git('remote').split('\n').filter(Boolean);
  // Whatever the branch tracks, else `origin`, and only then whatever is first.
  // A dashboard checkout carries a remote per colleague, and the first one
  // alphabetically is somebody else's fork -- which is a perfectly plausible
  // clone URL for a branch that is not on it.
  const remote = upstream ? upstream.split('/')[0] : (remotes.includes('origin') ? 'origin' : (remotes[0] || ''));

  if (!remote) {
    return { branch, error: 'no git remote to build from' };
  }

  const repo = cloneUrl(git('remote', 'get-url', remote));
  const pushed = !!git('ls-remote', '--heads', remote, branch);
  const local = git('rev-parse', 'HEAD');
  const tracked = upstream ? git('rev-parse', upstream) : '';

  return {
    branch,
    remote,
    repo,
    slug:    repoSlug(repo),
    pushed,
    upstream,
    // A pushed branch whose head is behind the checkout builds the *pushed*
    // commit, which is a surprise worth naming rather than a failure.
    behind:  !!(tracked && local && tracked !== local),
    error:   pushed ? '' : `${ branch } is not on ${ remote } -- push it first, the build clones from the remote`,
  };
}

function connect() {
  const cfg = config();

  if (!cfg.rancherUrl || !cfg.token) {
    die(`no Rancher configured. Set RANCHER_URL and REMUDA_TOKEN, or write ${ CONFIG_PATH }`);
  }

  return { cfg, api: remudaClient({ rancherUrl: cfg.rancherUrl, token: cfg.token, dryRun: cfg.dryRun }) };
}

function flags(argv) {
  const out = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

      if (inline !== undefined) {
        out[camel] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out[camel] = argv[++i];
      } else {
        out[camel] = true;
      }
    } else {
      out._.push(arg);
    }
  }

  return out;
}

const report = (env, password) => {
  const s = summarize(env);

  console.log(`name      ${ s.name }`);
  console.log(`branch    ${ s.branch }  (${ repoSlug(s.repo) || s.repo })`);
  console.log(`cluster   ${ s.cluster }`);
  console.log(`state     run=${ s.run } build=${ s.build }`);
  console.log(`url       ${ s.url || '(not resolved yet)' }`);

  if (s.bundle) {
    console.log(`bundle    ${ s.bundle }`);
  }

  if (password) {
    console.log(`login     admin / ${ password }`);
  }

  for (const problem of s.problems) {
    console.log(`problem   ${ problem }`);
  }
};

/**
 * Follow an environment until it answers.
 *
 * The URL returning 200 is the finish line, not `status.build`: Fleet does not
 * track Jobs, so a downstream environment reports `build=Unknown` for its whole
 * life and would never satisfy a build-state check. Expect
 * `503 API Aggregation not ready` for the first few minutes -- that is the
 * nested cluster installing its system charts, not a fault.
 */
async function follow(api, name, minutes) {
  const deadline = Date.now() + (minutes * 60_000);
  let last = '';

  while (Date.now() < deadline) {
    const env = await api.get(name);
    const s = summarize(env);
    const state = `run=${ s.run } build=${ s.build }${ s.url ? '' : ' (resolving)' }`;

    if (state !== last) {
      console.log(`[${ new Date().toISOString().slice(11, 19) }] ${ state }`);
      last = state;
    }

    for (const problem of s.problems) {
      console.log(`  ! ${ problem }`);
    }

    if (s.url) {
      try {
        const res = await fetch(`${ s.url }/dashboard/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });

        if (res.status >= 200 && res.status < 400) {
          console.log(`[${ new Date().toISOString().slice(11, 19) }] answering ${ res.status }`);

          return env;
        }
      } catch { /* not up yet; the loop is the retry */ }
    }

    await new Promise((r) => setTimeout(r, 15_000));
  }

  console.log(`still not answering after ${ minutes }m -- check the build Job and the backend pod`);

  return api.get(name);
}

const COMMANDS = {
  async doctor() {
    const cfg = config();

    console.log(`config    ${ CONFIG_PATH }`);
    console.log(`rancher   ${ cfg.rancherUrl || '(unset)' }`);
    console.log(`token     ${ cfg.token ? `${ cfg.token.split(':')[0] }:…` : '(unset)' }`);
    console.log(`cluster   ${ cfg.clusterId }`);

    if (cfg.clusterId !== HOST_CLUSTER) {
      for (const pin of DOWNSTREAM_PINS) {
        console.log(`pin       ${ pin } = ${ cfg.pins[pin] || '(unset -- required for a downstream cluster)' }`);
      }
    }

    const { api } = connect();

    console.log(`controller ${ await api.ready() ? 'installed (Environment API answers)' : 'MISSING -- create one environment from the Remuda extension in the Rancher UI to install it' }`);

    const here = checkout();

    console.log(`checkout  ${ here.error ? `${ here.branch || '?' } -- ${ here.error }` : `${ here.slug } @ ${ here.branch }` }`);
  },

  async list() {
    const { api } = connect();
    const res = await api.list();
    const items = res?.items || [];

    if (!items.length) {
      console.log('no environments');

      return;
    }

    console.log(['NAME'.padEnd(34), 'RUN'.padEnd(9), 'BUILD'.padEnd(9), 'CLUSTER'.padEnd(14), 'URL'].join(' '));
    items.forEach((env) => console.log(line(env)));
  },

  async get(argv) {
    const { api } = connect();
    const env = await api.get(flags(argv)._[0] || die('get needs a name'));

    report(env, await api.password(env).catch(() => ''));
  },

  async create(argv) {
    const opts = flags(argv);
    const { cfg, api } = connect();
    const here = checkout();
    const repo = opts.repo || here.repo;
    const branch = opts.branch || here.branch;

    if (!repo || !branch) {
      die(here.error || 'need --repo and --branch outside a git checkout');
    }

    // Only enforced when the branch is the one in this checkout: --branch names
    // something the caller looked up elsewhere, and re-checking it here would
    // reject a perfectly good branch on a remote this checkout has never seen.
    if (!opts.repo && !opts.branch && !here.pushed && !opts.force) {
      die(here.error);
    }

    if (here.behind && !opts.repo && !opts.branch) {
      console.log(`note: ${ here.upstream } is behind this checkout -- the build uses the pushed commit`);
    }

    const clusterId = opts.cluster || cfg.clusterId;
    const absent = missingPins(clusterId, cfg.pins);

    if (absent.length) {
      die(`cluster ${ clusterId } is not the host cluster, so it needs ${ absent.join(', ') } -- Fleet cannot read them back. Set them in ${ CONFIG_PATH }`);
    }

    const body = environmentFor({
      repo,
      branch,
      clusterId,
      agent: detectAgent(process.env),
      owner: opts.owner || cfg.owner,
      name:  opts.name,
      pins:  cfg.pins,
    });

    if (opts.print) {
      console.log(JSON.stringify(body, null, 2));

      return;
    }

    const { created, environment } = await api.create(body);

    console.log(`${ api.dryRun ? 'dry run: would create' : (created ? 'created' : 'already exists') } ${ body.metadata.name }`);

    if (api.dryRun) {
      return;
    }

    const env = opts.noWait ? environment : await follow(api, body.metadata.name, Number(opts.timeout || 20));

    report(env, await api.password(env).catch(() => ''));
  },

  async wait(argv) {
    const opts = flags(argv);
    const { api } = connect();
    const name = opts._[0] || die('wait needs a name');
    const env = await follow(api, name, Number(opts.timeout || 20));

    report(env, await api.password(env).catch(() => ''));
  },

  async rebuild(argv) {
    const { api } = connect();
    const name = flags(argv)._[0] || die('rebuild needs a name');

    await api.rebuild(name);
    console.log(`${ api.dryRun ? 'dry run: would rebuild' : 'rebuild requested for' } ${ name }`);
  },

  async stop(argv) {
    const { api } = connect();
    const name = flags(argv)._[0] || die('stop needs a name');

    await api.stop(name);
    console.log(`stopped ${ name } (volumes, hostname and password are kept; the URL answers 503)`);
  },

  async start(argv) {
    const { api } = connect();
    const name = flags(argv)._[0] || die('start needs a name');

    await api.start(name);
    console.log(`starting ${ name }`);
  },

  async delete(argv) {
    const { api } = connect();
    const name = flags(argv)._[0] || die('delete needs a name');

    await api.remove(name);
    console.log(`deleted ${ name } -- every object it owns goes with it`);
  },

  async password(argv) {
    const { api } = connect();
    const env = await api.get(flags(argv)._[0] || die('password needs a name'));
    const password = await api.password(env);

    console.log(password ? `admin / ${ password }` : 'no bootstrap secret yet');
  },

  name(argv) {
    const opts = flags(argv);
    const here = checkout();

    console.log(environmentName(opts.repo || here.repo, opts.branch || here.branch, opts.name));
  },
};

const [command, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || !COMMANDS[command]) {
  console.log(`remuda <command>

  doctor                     configuration, controller, and this checkout
  create [--name N] [--branch B] [--repo URL] [--cluster ID] [--owner O]
         [--no-wait] [--timeout 20] [--print] [--force]
  list
  get <name>                 state, URL and login
  wait <name> [--timeout 20]
  rebuild <name>             build the branch's current head again
  stop <name> | start <name>
  delete <name>
  password <name>
  name [--branch B]          the environment name a branch would get

Configuration: RANCHER_URL, REMUDA_TOKEN, REMUDA_CLUSTER, PIN_*, REMUDA_DRY_RUN=1,
or ${ CONFIG_PATH }`);
  process.exit(command && command !== '--help' ? 1 : 0);
}

// Promise.resolve, because `name` is the one command that answers without a
// network call and so is not async.
Promise.resolve(COMMANDS[command](rest)).catch((e) => {
  if (e instanceof RemudaError && e.status === 404) {
    die(`${ e.message }\n  (a 404 on the collection means remuda-controller is not installed on this Rancher)`);
  }

  die(e.message);
});
