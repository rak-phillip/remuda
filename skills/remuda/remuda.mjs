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
  DOWNSTREAM_PINS, ESTIMATED_DISK_GB, HOST_CLUSTER, backendOrigin, cloneUrl, detectAgent, diskShortfall,
  environmentFor, environmentName, line, missingPins, repoSlug, summarize,
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

/**
 * The flags each command accepts, and whether each takes a value.
 *
 * Declared rather than inferred. The parser used to take any `--anything`, so
 * `create --help` read as a create with a stray flag and built an environment
 * from whatever checkout it was run in -- which on 2026-10-14 put a Remuda
 * build of this repository onto a shared cluster that was already short on
 * disk. An unknown flag is now an error, and `--help` is help everywhere.
 */
const FLAGS = {
  doctor: {},
  list:   {},
  get:    {},
  create: {
    name: 'value', branch: 'value', repo: 'value', cluster: 'value', owner: 'value', backendUrl: 'value',
    timeout: 'value', prime: 'bool', noWait: 'bool', print: 'bool', force: 'bool',
  },
  wait:     { timeout: 'value' },
  rebuild:  {},
  stop:     {},
  start:    {},
  delete:   {},
  password: {},
  name:     { branch: 'value', repo: 'value', name: 'value' },
};

const camel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${ c.toLowerCase() }`);

function flags(command, argv) {
  const known = FLAGS[command] || {};
  const out = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }

    const [raw, inline] = arg.slice(2).split(/=(.*)/s);
    const key = camel(raw);
    const kind = known[key];

    if (!kind) {
      const accepted = Object.keys(known).map((k) => `--${ kebab(k) }`).join(' ');

      throw new Error(`${ command } does not take --${ raw }${ accepted ? ` (it takes ${ accepted })` : '' }. See: remuda ${ command } --help`);
    }

    if (kind === 'bool') {
      if (inline !== undefined) {
        throw new Error(`--${ raw } is a switch and takes no value`);
      }

      out[key] = true;
    } else if (inline !== undefined) {
      out[key] = inline;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      throw new Error(`--${ raw } needs a value`);
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

  if (s.backend) {
    console.log(`backend   ${ s.backend }`);
    console.log(`login     use ${ s.backend }'s own credentials -- this is that Rancher, not a copy of it`);
  } else if (password) {
    console.log(`login     admin / ${ password }`);
  }

  if (s.prime) {
    console.log('edition   Rancher Prime');
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

    const disks = await api.nodeDisk(cfg.clusterId);

    for (const d of disks) {
      console.log(`disk      ${ d.name }: ${ (d.availableBytes / 1e9).toFixed(1) } GB free of ${ (d.capacityBytes / 1e9).toFixed(1) } GB`);
    }

    const short = diskShortfall(disks, ESTIMATED_DISK_GB.ownBackend);

    if (short) {
      console.log(`disk      LOW -- another environment would leave ${ short.node } with ${ short.afterGb } GB, under the ${ short.floorGb } GB where pods get evicted`);
    }

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
    const env = await api.get(flags('get', argv)._[0] || die('get needs a name'));

    report(env, await api.password(env).catch(() => ''));
  },

  async create(argv) {
    const opts = flags('create', argv);
    const backend = opts.backendUrl ? backendOrigin(opts.backendUrl) : {};

    if (backend.error) {
      die(backend.error);
    }

    if (backend.origin && opts.prime) {
      die('--prime needs a backend of the environment\'s own; with --backend-url that Rancher decides whether it is Prime');
    }

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
    const absent = missingPins(clusterId, cfg.pins, { externalBackend: !!backend.origin });

    if (absent.length) {
      die(`cluster ${ clusterId } is not the host cluster, so it needs ${ absent.join(', ') } -- Fleet cannot read them back. Set them in ${ CONFIG_PATH }`);
    }

    const body = environmentFor({
      repo,
      branch,
      clusterId,
      agent: detectAgent(process.env),
      owner: opts.owner || cfg.owner,
      name:       opts.name,
      pins:       cfg.pins,
      backendUrl: backend.origin,
      prime:      opts.prime,
    });

    if (opts.print) {
      console.log(JSON.stringify(body, null, 2));

      return;
    }

    // local-path enforces no PVC size, so nothing else stops a node filling up
    // until its kubelet starts evicting environments. --force skips this the
    // same way it skips the pushed-branch check.
    const short = diskShortfall(
      await api.nodeDisk(clusterId), backend.origin ? ESTIMATED_DISK_GB.externalBackend : ESTIMATED_DISK_GB.ownBackend
    );

    if (short && !opts.force) {
      die(`${ short.node } has ${ short.availableGb } GB free of ${ short.capacityGb } GB; this environment would leave about ${ short.afterGb } GB, ` +
        `under the ${ short.floorGb } GB where Kubernetes starts evicting pods. Free space first (delete, not stop -- stop keeps the volumes), or pass --force`);
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
    const opts = flags('wait', argv);
    const { api } = connect();
    const name = opts._[0] || die('wait needs a name');
    const env = await follow(api, name, Number(opts.timeout || 20));

    report(env, await api.password(env).catch(() => ''));
  },

  async rebuild(argv) {
    const { api } = connect();
    const name = flags('rebuild', argv)._[0] || die('rebuild needs a name');

    await api.rebuild(name);
    console.log(`${ api.dryRun ? 'dry run: would rebuild' : 'rebuild requested for' } ${ name }`);
  },

  async stop(argv) {
    const { api } = connect();
    const name = flags('stop', argv)._[0] || die('stop needs a name');

    await api.stop(name);
    console.log(`stopped ${ name } (volumes, hostname and password are kept; the URL answers 503)`);
  },

  async start(argv) {
    const { api } = connect();
    const name = flags('start', argv)._[0] || die('start needs a name');

    await api.start(name);
    console.log(`starting ${ name }`);
  },

  async delete(argv) {
    const { api } = connect();
    const name = flags('delete', argv)._[0] || die('delete needs a name');

    await api.remove(name);
    console.log(`deleted ${ name } -- every object it owns goes with it`);
  },

  async password(argv) {
    const { api } = connect();
    const env = await api.get(flags('password', argv)._[0] || die('password needs a name'));
    if (env?.spec?.backendUrl) {
      console.log(`none -- ${ env.metadata.name } fronts ${ env.spec.backendUrl }; log in with that Rancher's own credentials`);

      return;
    }

    const password = await api.password(env);

    console.log(password ? `admin / ${ password }` : 'no bootstrap secret yet');
  },

  name(argv) {
    const opts = flags('name', argv);
    const here = checkout();

    console.log(environmentName(opts.repo || here.repo, opts.branch || here.branch, opts.name));
  },
};

const USAGE = `remuda <command> [--help]

  doctor                     configuration, controller, disk, and this checkout
  create [--name N] [--branch B] [--repo URL] [--cluster ID] [--owner O]
         [--backend-url URL]   only build the UI, in front of an existing Rancher
         [--prime]             run the backend as Rancher Prime
         [--no-wait] [--timeout 20] [--print] [--force]
  list
  get <name>                 state, URL and login
  wait <name> [--timeout 20]
  rebuild <name>             build the branch's current head again
  stop <name> | start <name>
  delete <name>
  password <name>
  name [--branch B]          the environment name a branch would get

create builds from this checkout's remote and branch unless --repo/--branch say
otherwise. --print shows the Environment without creating it. --force skips the
pushed-branch and disk checks.

Configuration: RANCHER_URL, REMUDA_TOKEN, REMUDA_CLUSTER, PIN_*, REMUDA_DRY_RUN=1,
or ${ CONFIG_PATH }`;

const [command, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h' || !COMMANDS[command]) {
  console.log(USAGE);
  process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
}

// Parsed once up front, before anything can touch the network, so a flag the
// command does not know -- or a request for help -- can never fall through to
// doing the command. Each command parses again for its own use; that is cheap
// and keeps them readable on their own.
try {
  if (flags(command, rest).help) {
    console.log(USAGE);
    process.exit(0);
  }
} catch (e) {
  die(e.message);
}

// Promise.resolve, because `name` is the one command that answers without a
// network call and so is not async.
Promise.resolve(COMMANDS[command](rest)).catch((e) => {
  if (e instanceof RemudaError && e.status === 404) {
    die(`${ e.message }\n  (a 404 on the collection means remuda-controller is not installed on this Rancher)`);
  }

  die(e.message);
});
