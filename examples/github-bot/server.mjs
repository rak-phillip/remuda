#!/usr/bin/env node
// A GitHub webhook receiver that drives Remuda. See README.md for configuration.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  HOST_CLUSTER, planCreate, planFor, verifySignature
} from './plan.mjs';
import { remudaClient } from './remuda.mjs';

const MAX_BODY = 5 * 1024 * 1024;

const config = loadConfig(process.env);
const remuda = remudaClient({
  rancherUrl: config.rancherUrl,
  apiServer:  config.apiServer,
  token:      config.token,
  tokenFile:  config.tokenFile,
  dryRun:     config.dryRun,
});
const github = githubClient(config);

function loadConfig(env) {
  const missing = [];
  const cfg = {
    port:            Number(env.PORT || 8787),
    secret:          env.WEBHOOK_SECRET,
    rancherUrl:      env.RANCHER_URL,
    apiServer:       env.KUBE_API_SERVER,
    token:           env.REMUDA_TOKEN,
    tokenFile:       env.REMUDA_TOKEN_FILE,
    dryRun:          env.REMUDA_DRY_RUN === '1',
    clusterId:       env.TARGET_CLUSTER || HOST_CLUSTER,
    namePrefix:      env.NAME_PREFIX,
    maxEnvironments: Number(env.MAX_ENVIRONMENTS || 5),
    githubToken:     env.GITHUB_TOKEN,
    postComments:    env.POST_COMMENTS === '1',
    watch:           env.WATCH !== '0',
  };

  if (!cfg.secret) {
    missing.push('WEBHOOK_SECRET');
  }

  if (!cfg.rancherUrl && !cfg.apiServer) {
    missing.push('RANCHER_URL or KUBE_API_SERVER');
  }

  if (!cfg.token && !cfg.tokenFile) {
    missing.push('REMUDA_TOKEN or REMUDA_TOKEN_FILE');
  }

  if (cfg.clusterId !== HOST_CLUSTER) {
    cfg.pins = {
      ingressClass:      env.PIN_INGRESS_CLASS,
      storageClass:      env.PIN_STORAGE_CLASS,
      nestedPodCidr:     env.PIN_NESTED_POD_CIDR,
      nestedServiceCidr: env.PIN_NESTED_SERVICE_CIDR,
    };

    // At startup rather than on the first pull request: a downstream Environment
    // missing one of these sits at Resolved=False forever, and the person who
    // added the label is told nothing they can act on.
    Object.entries(cfg.pins).filter(([, value]) => !value).forEach(([key]) => missing.push(`PIN_${ key.replace(/[A-Z]/g, (c) => `_${ c }`).toUpperCase() }`));
  }

  if (missing.length) {
    console.error(`missing configuration: ${ missing.join(', ') }`);
    process.exit(1);
  }

  return cfg;
}

function githubClient({ githubToken, postComments }) {
  async function api(method, path, body) {
    const res = await fetch(`https://api.github.com${ path }`, {
      method,
      headers: {
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':           'remuda-github-bot',
        ...(githubToken ? { Authorization: `Bearer ${ githubToken }` } : {}),
      },
      body:   body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`GitHub ${ method } ${ path }: ${ res.status } ${ await res.text() }`);
    }

    return res.json();
  }

  return {
    pullRequest: (repo, number) => api('GET', `/repos/${ repo }/pulls/${ number }`),

    async comment(repo, number, body) {
      // Printed rather than posted unless POST_COMMENTS=1. A mock pointed at a
      // real public pull request must not write to it.
      if (!postComments || !githubToken) {
        console.log(`\n--- comment on ${ repo }#${ number } (not posted) ---\n${ body }\n---\n`);

        return;
      }

      await api('POST', `/repos/${ repo }/issues/${ number }/comments`, { body });
    },
  };
}

const target = config.clusterId === HOST_CLUSTER ? '' : ` on \`${ config.clusterId }\``;
const dryNote = () => (remuda.dryRun ? '\n\n_Dry run: the API server validated this and persisted nothing._' : '');

async function execute(plan, payload) {
  const repo = payload.repository.full_name;
  const number = payload.pull_request?.number ?? payload.issue?.number;
  const name = plan.name;

  switch (plan.action) {
  case 'create': {
    let body = plan.body;

    if (plan.needsPullRequest) {
      const resolved = planCreate(await github.pullRequest(repo, number), config, plan.reason);

      if (resolved.action !== 'create') {
        return { outcome: 'ignored', reason: resolved.reason };
      }

      body = resolved.body;
    }

    // A cap on the bot's own environments. Each one holds several GiB while it
    // builds, and a busy repository labels faster than anyone deletes.
    const mine = ((await remuda.list())?.items || []).map((env) => env.metadata.name);

    if (!mine.includes(body.metadata.name) && mine.length >= config.maxEnvironments) {
      await github.comment(repo, number, `Remuda is at its limit of ${ config.maxEnvironments } environments from GitHub (${ mine.join(', ') }). Remove the \`remuda\` label from one of those pull requests to free a slot.`);

      return { outcome: 'refused', reason: 'at capacity', environments: mine };
    }

    const { created, environment } = await remuda.create(body);
    const { repo: clone, branch } = body.spec;

    await github.comment(repo, number, created ? `**Remuda** is building \`${ name }\` from \`${ clone }\` @ \`${ branch }\`${ target }. It will comment again with the URL once the environment answers, usually within ten minutes.\n\nThe bootstrap password is not posted here; it is on the environment's page in Remuda.${ dryNote() }` : `Remuda already has \`${ name }\` for this pull request${ environment?.status?.url ? `, at ${ environment.status.url }` : '' }. Comment \`/remuda rebuild\` to build the latest commit.`);

    if (created && config.watch && !remuda.dryRun) {
      watch(repo, number, name).catch((e) => console.error(`${ name }: watch failed: ${ e.message }`));
    }

    return { outcome: created ? 'created' : 'exists', environment: summarise(environment) };
  }

  case 'rebuild': {
    const result = await remuda.rebuild(name, { sha: plan.sha });

    if (!result.found) {
      return { outcome: 'not-found', reason: `no environment ${ name } to rebuild` };
    }

    if (!result.supported) {
      await github.comment(repo, number, `Remuda could not rebuild \`${ name }\`: this server's remuda-controller predates rebuilds, and its CRD dropped the request. Upgrade the remuda-controller chart.`);

      return { outcome: 'unsupported', reason: 'the CRD pruned spec.rebuildRequest' };
    }

    await github.comment(repo, number, `Rebuilding \`${ name }\` from the latest commit on the branch.${ dryNote() }`);

    return { outcome: 'rebuild-requested', environment: summarise(result.environment) };
  }

  case 'delete': {
    const { found } = await remuda.remove(name);

    if (found) {
      await github.comment(repo, number, `Removed \`${ name }\` (${ plan.reason }).${ dryNote() }`);
    }

    return { outcome: found ? 'deleted' : 'not-found' };
  }

  default:
    return { outcome: 'ignored' };
  }
}

/**
 * Follow a new environment until it answers, then say where.
 *
 * Downstream, status.build stays Unknown on the host -- Fleet does not carry Jobs
 * back -- so a running backend is the most this can wait for there, and the
 * bundle may still be building when it reports.
 */
async function watch(repo, number, name, { intervalMs = 15000, timeoutMs = 20 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    let env;

    try {
      env = await remuda.get(name);
    } catch (e) {
      if (e.status === 404) {
        return;
      }

      continue;
    }

    const failed = (env.status?.conditions || []).find((c) => c.status === 'False');

    if (failed) {
      await github.comment(repo, number, `Remuda could not provision \`${ name }\`: ${ failed.message || failed.reason }`);

      return;
    }

    const { run, build, url } = env.status || {};

    if (build === 'Failed') {
      await github.comment(repo, number, `The UI build for \`${ name }\` failed. Its logs are on the build Job's pod.`);

      return;
    }

    if (url && run === 'Ready' && build !== 'Building') {
      await github.comment(repo, number, `\`${ name }\` is up at ${ url }${ build === 'Unknown' ? ' (the UI bundle may still be finishing its build)' : '' }.`);

      return;
    }
  }

  await github.comment(repo, number, `\`${ name }\` has not answered after twenty minutes. Check it in Remuda.`);
}

function summarise(environment) {
  return environment && {
    name:   environment.metadata?.name,
    spec:   environment.spec,
    status: environment.status,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async(req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, { ok: true, dryRun: remuda.dryRun });
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    return send(res, 404, { error: 'not found' });
  }

  let raw;

  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, 413, { error: e.message });
  }

  if (!verifySignature(config.secret, raw, req.headers['x-hub-signature-256'])) {
    console.warn('rejected a delivery with a missing or wrong signature');

    return send(res, 401, { error: 'bad signature' });
  }

  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'] || randomUUID();

  if (event === 'ping') {
    return send(res, 200, { delivery, pong: true });
  }

  let payload;

  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'body is not JSON' });
  }

  const plan = planFor(event, payload, config);
  const planned = { action: plan.action, name: plan.name, reason: plan.reason };

  console.log(`${ delivery } ${ event }.${ payload.action }: ${ plan.action }${ plan.name ? ` ${ plan.name }` : '' } -- ${ plan.reason }`);

  try {
    send(res, 200, { delivery, plan: planned, ...await execute(plan, payload) });
  } catch (e) {
    console.error(`${ delivery }: ${ e.message }`);
    // A 5xx marks the delivery failed in GitHub's UI, which offers Redeliver --
    // that is the whole retry story for a webhook.
    send(res, 502, {
      delivery, plan: planned, error: e.message, status: e.status
    });
  }
});

server.listen(config.port, () => {
  const where = config.rancherUrl || config.apiServer;

  console.log(`remuda github bot listening on :${ config.port }, driving ${ where }${ target }${ config.dryRun ? ' (DRY RUN)' : '' }${ config.postComments ? ', posting comments' : ', printing comments' }`);
});
