// Turning a git checkout into an Environment, and an Environment back into a
// sentence someone can read.
//
// Pure by design: no network, no clock, no process.env. The agent's judgement
// lives in SKILL.md; the rules that must not vary between the extension and this
// live here, where a test can hold them still.

export const API_VERSION = 'remuda.rancher.io/v1alpha1';
export const NAMESPACE = 'rancher-remuda';
export const HOST_CLUSTER = 'local';

/**
 * Marks an Environment as this client's. The value names the way in, not the
 * agent: Claude Code, Codex and pi all run this same script.
 */
export const SOURCE_LABEL = 'remuda.rancher.io/source';
export const SOURCE = 'agent-skill';

/** Which agent ran the skill. An annotation: descriptive, never selected on. */
export const AGENT_ANNOTATION = 'remuda.rancher.io/agent';

/**
 * The agent that ran this, from the variables agents set for their child
 * processes. REMUDA_AGENT wins, then AI_AGENT -- Claude Code sets it to
 * `claude-code_<version>_agent` and pi to `pi` -- then each agent's own marker.
 * `unknown` rather than a guess: the model cannot be asked, as it names itself
 * a different way each time.
 */
export function detectAgent(env = {}) {
  const named = env.REMUDA_AGENT || env.AI_AGENT?.split('_')[0];

  if (named) {
    return slug(named) || 'unknown';
  }

  if (env.CLAUDECODE) {
    return 'claude-code';
  }

  if (env.PI_CODING_AGENT) {
    return 'pi';
  }

  if (env.CODEX_THREAD_ID) {
    return 'codex';
  }

  return 'unknown';
}

/**
 * The longest environment name whose build Job still has a legal name.
 *
 * The controller names that Job `<environment>-build-<10-digit id>` and a Job
 * name is capped at 63 characters. The API server knows none of that about an
 * Environment -- a 47-character name is admitted and fails later, when the Job
 * is created -- so every client has to cap it for itself.
 */
export const MAX_NAME = 63 - '-build-'.length - 10;

/** The four fields Fleet cannot read back from a downstream cluster. */
export const DOWNSTREAM_PINS = ['ingressClass', 'storageClass', 'nestedPodCidr', 'nestedServiceCidr'];

/**
 * A clone URL the build Job can actually use.
 *
 * The build pod has no SSH key and no GitHub credentials, so an `origin` of
 * `git@github.com:owner/repo.git` -- which is what anyone who pushes has --
 * would clone as far as "Permission denied (publickey)" and no further. Every
 * remote form is normalised to the anonymous HTTPS URL.
 */
export function cloneUrl(remote) {
  const url = String(remote || '').trim();

  if (!url) {
    return '';
  }

  const scp = url.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);

  if (/^https?:\/\//.test(url)) {
    return url.replace(/\.git$/, '').replace(/\/+$/, '');
  }

  return scp ? `https://${ scp[1] }/${ scp[2] }` : url;
}

/** `owner/repo` out of a clone URL, for naming and for the report. */
export function repoSlug(url) {
  const m = cloneUrl(url).match(/^https?:\/\/[^/]+\/(.+)$/);

  return m ? m[1] : '';
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * One environment per branch, named so it is legal everywhere it lands.
 *
 * The name becomes a Service name, which must start with a letter; a DNS label
 * in the environment's hostname; and the front of a Job name, which caps it at
 * MAX_NAME. The branch is what distinguishes one environment from another, so
 * the repository half gives way first.
 */
export function environmentName(repo, branch, override) {
  if (override) {
    return slug(override).slice(0, MAX_NAME).replace(/-+$/, '');
  }

  const repoPart = slug((repoSlug(repo).split('/').pop()) || '');
  const branchPart = slug(branch);
  let name = [repoPart, branchPart].filter(Boolean).join('-');

  if (name.length > MAX_NAME) {
    // Keep the branch whole and trim the repository. A branch too long even on
    // its own is cut from the tail, because what identifies it -- `task/12345`
    // -- is at the front.
    const room = MAX_NAME - branchPart.length - 1;

    name = room > 2 ? `${ repoPart.slice(0, room) }-${ branchPart }` : branchPart.slice(0, MAX_NAME);
  }

  name = name.replace(/-+$/, '');

  return /^[a-z]/.test(name) ? name : `env-${ name }`.slice(0, MAX_NAME);
}

/**
 * The Environment a checkout asks for.
 *
 * Only repo and branch are required; the controller resolves the rest from the
 * target cluster. A cluster other than the host has to pin the four fields
 * Fleet cannot read back -- see "What a downstream environment must pin" in
 * controller/README.md -- because nothing here has a browser to discover them
 * with.
 */
export function environmentFor({
  repo, branch, owner, name, clusterId, agent = 'unknown', pins = {}, annotations = {},
}) {
  const envName = environmentName(repo, branch, name);
  const spec = { repo: cloneUrl(repo), branch };

  if (owner) {
    // Copied into a label on every object the controller creates, so it has to
    // be a legal label value.
    spec.owner = slug(owner).slice(0, 63);
  }

  if (clusterId && clusterId !== HOST_CLUSTER) {
    spec.clusterId = clusterId;

    for (const key of DOWNSTREAM_PINS) {
      if (pins[key]) {
        spec[key] = pins[key];
      }
    }
  }

  return {
    apiVersion: API_VERSION,
    kind:       'Environment',
    metadata:   {
      name:        envName,
      namespace:   NAMESPACE,
      labels:      { 'remuda.rancher.io/name': envName, [SOURCE_LABEL]: SOURCE },
      annotations: { [AGENT_ANNOTATION]: agent, ...annotations },
    },
    spec,
  };
}

/** Which required pins a downstream Environment is missing, if any. */
export function missingPins(clusterId, pins = {}) {
  return (!clusterId || clusterId === HOST_CLUSTER) ? [] : DOWNSTREAM_PINS.filter((key) => !pins[key]);
}

/**
 * What an Environment is doing, in the terms the agent should report.
 *
 * `build` is deliberately allowed to be unknown rather than reported as a
 * failure: Fleet tracks Deployments and PVCs but not Jobs, so every downstream
 * environment reads `Unknown` there for its whole life. The URL answering is the
 * signal that matters, and it is the one thing true on both paths.
 */
export function summarize(env) {
  const status = env?.status || {};
  const conditions = status.conditions || [];
  const failing = conditions.filter((c) => c.status === 'False' && c.type !== 'Ready');

  return {
    name:     env?.metadata?.name,
    branch:   env?.spec?.branch,
    repo:     env?.spec?.repo,
    cluster:  env?.spec?.clusterId || HOST_CLUSTER,
    running:  env?.spec?.running !== false,
    build:    status.build || 'Unknown',
    run:      status.run || 'Pending',
    url:      status.url || '',
    bundle:   status.sharedBundleUrl || '',
    secret:   status.bootstrapSecret || '',
    problems: failing.map((c) => `${ c.type }: ${ c.message || c.reason || 'False' }`),
  };
}

/** One line per environment, for `remuda list`. */
export function line(env) {
  const s = summarize(env);

  return [
    s.name.padEnd(34),
    (s.run || '').padEnd(9),
    (s.build || '').padEnd(9),
    s.cluster.padEnd(14),
    s.url || '(no url yet)',
  ].join(' ');
}
