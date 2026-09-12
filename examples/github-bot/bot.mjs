// Everything the bot does once it has an event: turn a plan into Environment API
// calls and pull-request comments.
//
// Shared by server.mjs, which receives webhooks, and action.mjs, which runs as a
// GitHub Actions step. The two differ only in how an event arrives and whether
// anything waits for the follow-up, which is why neither of those lives here.

import { HOST_CLUSTER, planCreate } from './plan.mjs';
import { remudaClient } from './remuda.mjs';

const pinVariable = (key) => `PIN_${ key.replace(/[A-Z]/g, (c) => `_${ c }`).toUpperCase() }`;

/**
 * Configuration from environment variables, with every problem found at once.
 *
 * Returns rather than exits, so each entrypoint reports a problem in its own
 * terms: a line on stderr for the server, an error annotation on the run for
 * Actions. `needsSecret` is false under Actions, where GitHub is the one running
 * the step and there is no delivery to authenticate.
 */
export function loadConfig(env, { needsSecret = true } = {}) {
  const missing = [];
  const config = {
    port:            Number(env.PORT || 8787),
    secret:          env.WEBHOOK_SECRET,
    rancherUrl:      env.RANCHER_URL,
    apiServer:       env.KUBE_API_SERVER,
    token:           env.REMUDA_TOKEN,
    tokenFile:       env.REMUDA_TOKEN_FILE,
    dryRun:          env.REMUDA_DRY_RUN === '1',
    clusterId:       env.TARGET_CLUSTER || HOST_CLUSTER,
    namePrefix:      env.NAME_PREFIX || undefined,
    maxEnvironments: Number(env.MAX_ENVIRONMENTS || 5),
    githubToken:     env.GITHUB_TOKEN,
    postComments:    env.POST_COMMENTS === '1',
    watch:           env.WATCH !== '0',
    watchTimeoutMs:  Number(env.WATCH_TIMEOUT_MINUTES || 20) * 60 * 1000,
  };

  if (needsSecret && !config.secret) {
    missing.push('WEBHOOK_SECRET');
  }

  if (!config.rancherUrl && !config.apiServer) {
    missing.push('RANCHER_URL or KUBE_API_SERVER');
  }

  if (!config.token && !config.tokenFile) {
    missing.push('REMUDA_TOKEN or REMUDA_TOKEN_FILE');
  }

  if (config.clusterId !== HOST_CLUSTER) {
    config.pins = {
      ingressClass:      env.PIN_INGRESS_CLASS,
      storageClass:      env.PIN_STORAGE_CLASS,
      nestedPodCidr:     env.PIN_NESTED_POD_CIDR,
      nestedServiceCidr: env.PIN_NESTED_SERVICE_CIDR,
    };

    // At startup rather than on the first pull request: a downstream Environment
    // missing one of these sits at Resolved=False forever, and the person who
    // added the label is told nothing they can act on.
    Object.entries(config.pins).filter(([, value]) => !value).forEach(([key]) => missing.push(pinVariable(key)));
  }

  return { config, missing };
}

export function remudaFor(config) {
  return remudaClient({
    rancherUrl: config.rancherUrl,
    apiServer:  config.apiServer,
    token:      config.token,
    tokenFile:  config.tokenFile,
    dryRun:     config.dryRun,
  });
}

export function githubClient({ githubToken, postComments }) {
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

const numberOf = (payload) => payload.pull_request?.number ?? payload.issue?.number;

function summarise(environment) {
  return environment && {
    name:   environment.metadata?.name,
    spec:   environment.spec,
    status: environment.status,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config From loadConfig().
 * @param {object} deps.remuda From remudaClient().
 * @param {object} deps.github From githubClient(), or anything with comment() and pullRequest().
 * @param {number} [deps.intervalMs] How often follow() re-reads a new environment.
 */
export function createBot({
  config, remuda, github, intervalMs = 15000
}) {
  const target = config.clusterId === HOST_CLUSTER ? '' : ` on \`${ config.clusterId }\``;
  const dryNote = () => (remuda.dryRun ? '\n\n_Dry run: the API server validated this and persisted nothing._' : '');

  async function execute(plan, payload) {
    const repo = payload.repository.full_name;
    const number = numberOf(payload);
    const name = plan.name;
    const dryRun = remuda.dryRun;

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

      await github.comment(repo, number, created ? `**Remuda** is building \`${ body.metadata.name }\` from \`${ clone }\` @ \`${ branch }\`${ target }. It will comment again with the URL once the environment answers, usually within ten minutes.\n\nThe bootstrap password is not posted here; it is on the environment's page in Remuda.${ dryNote() }` : `Remuda already has \`${ body.metadata.name }\` for this pull request${ environment?.status?.url ? `, at ${ environment.status.url }` : '' }. Comment \`/remuda rebuild\` to build the latest commit.`);

      return { outcome: created ? 'created' : 'exists', dryRun, environment: summarise(environment) };
    }

    case 'rebuild': {
      const result = await remuda.rebuild(name, { sha: plan.sha });

      if (!result.found) {
        return { outcome: 'not-found', dryRun, reason: `no environment ${ name } to rebuild` };
      }

      if (!result.supported) {
        await github.comment(repo, number, `Remuda could not rebuild \`${ name }\`: this server's remuda-controller predates rebuilds, and its CRD dropped the request. Upgrade the remuda-controller chart.`);

        return { outcome: 'unsupported', dryRun, reason: 'the CRD pruned spec.rebuildRequest' };
      }

      await github.comment(repo, number, `Rebuilding \`${ name }\` from the latest commit on the branch.${ dryNote() }`);

      return { outcome: 'rebuild-requested', dryRun, environment: summarise(result.environment) };
    }

    case 'delete': {
      const { found } = await remuda.remove(name);

      if (found) {
        await github.comment(repo, number, `Removed \`${ name }\` (${ plan.reason }).${ dryNote() }`);
      }

      return { outcome: found ? 'deleted' : 'not-found', dryRun };
    }

    default:
      return { outcome: 'ignored' };
    }
  }

  /**
   * Follow a new environment until it answers, then say where.
   *
   * Downstream, status.build stays Unknown on the host -- Fleet does not carry
   * Jobs back -- so a running backend is the most this can wait for there, and
   * the bundle may still be building when it reports.
   */
  async function watch(repo, number, name) {
    const deadline = Date.now() + config.watchTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      let env;

      try {
        env = await remuda.get(name);
      } catch (e) {
        // Deleted while it was being followed: nothing left to announce.
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

    await github.comment(repo, number, `\`${ name }\` has not answered after ${ Math.round(config.watchTimeoutMs / 60000) } minutes. Check it in Remuda.`);
  }

  /**
   * The follow-up for a result, or undefined when there is none to make.
   *
   * The caller decides whether to wait for it. The server cannot, because GitHub
   * wants its answer within ten seconds; an Actions step has nothing else to do.
   */
  function follow(result, payload) {
    if (result?.outcome !== 'created' || !config.watch || remuda.dryRun) {
      return undefined;
    }

    return watch(payload.repository.full_name, numberOf(payload), result.environment.name);
  }

  return { execute, follow };
}
