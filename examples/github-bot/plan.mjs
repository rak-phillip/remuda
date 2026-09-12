// Turning GitHub webhook deliveries into Remuda Environment operations.
//
// Pure by design: no network, no clock, no process.env. Everything that varies
// arrives as an argument, so every decision the bot makes can be tested by
// handing it a payload and reading back what it would do.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const API_VERSION = 'remuda.rancher.io/v1alpha1';
export const NAMESPACE = 'rancher-remuda';
export const HOST_CLUSTER = 'local';

/** The pull-request label that asks for an environment. */
export const LABEL = 'remuda';

/** Marks an Environment as the bot's, which is what the capacity check counts. */
export const SOURCE_LABEL = 'remuda.rancher.io/source';

/**
 * The longest environment name whose build Job still has a legal name.
 *
 * The controller names that Job `<environment>-build-<10-digit id>`, and a Job
 * name is capped at 63 characters because Kubernetes copies it into a label. The
 * API server knows none of that about an Environment: measured, a 47-character
 * name is admitted, and the failure only arrives later, when the controller
 * creates the Job.
 */
export const MAX_NAME = 63 - '-build-'.length - 10;

/**
 * Who may drive the bot from a comment.
 *
 * Labels need no such check. GitHub only lets people with triage access or
 * better apply one, so applying it is the approval.
 */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const COMMAND = /^\/remuda\s+(up|rebuild|down)\b/m;

/** GitHub's X-Hub-Signature-256 value for a body. */
export function sign(secret, rawBody) {
  return `sha256=${ createHmac('sha256', secret).update(rawBody).digest('hex') }`;
}

/**
 * Whether a delivery really came from GitHub.
 *
 * Checked against the raw bytes rather than re-serialised JSON, and compared in
 * constant time. An unsigned endpoint that creates workloads is an open door to
 * anyone who finds its URL.
 */
export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== 'string') {
    return false;
  }

  const expected = Buffer.from(sign(secret, rawBody));
  const actual = Buffer.from(header);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * One environment per pull request, named so it is legal everywhere it lands.
 *
 * The name becomes a Service name, which must start with a letter; a hostname
 * label; and the front of a Job name, which caps it at MAX_NAME. The PR number is
 * what makes it unique, so it is kept whole and the repository half gives way.
 */
export function environmentName(repoFullName, number, prefix) {
  const suffix = `-pr-${ number }`;
  let base = String(prefix || repoFullName.split('/').pop() || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!/^[a-z]/.test(base)) {
    base = base ? `gh-${ base }` : 'gh';
  }

  return `${ base.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '') }${ suffix }`;
}

const hasLabel = (pr) => (pr.labels || []).some((label) => label.name === LABEL);
const isFork = (pr) => pr.head?.repo?.full_name !== pr.base?.repo?.full_name;
const none = (reason, name) => ({ action: 'none', name, reason });

/**
 * The Environment a pull request asks for.
 *
 * Only repo and branch are needed; the controller resolves everything else. The
 * clone URL is the *head* repository's, so a pull request from a fork builds the
 * fork -- the base repository does not have the branch.
 *
 * A target other than the host cluster has to pin the four fields Fleet cannot
 * read back (see "What a downstream environment must pin" in
 * controller/README.md). They come from config, because a bot has no browser to
 * discover them with.
 */
export function environmentFor(pr, config = {}) {
  const name = environmentName(pr.base.repo.full_name, pr.number, config.namePrefix);
  const spec = {
    repo:   pr.head.repo.clone_url,
    branch: pr.head.ref,
    // Copied into a label on every object the controller creates, so it has to
    // be a legal label value. A GitHub login always is, prefixed or not.
    owner:  `github-${ pr.user.login }`,
  };

  if (config.clusterId && config.clusterId !== HOST_CLUSTER) {
    Object.assign(spec, { clusterId: config.clusterId }, config.pins);
  }

  return {
    apiVersion: API_VERSION,
    kind:       'Environment',
    metadata:   {
      name,
      namespace:   NAMESPACE,
      labels:      { 'remuda.rancher.io/name': name, [SOURCE_LABEL]: 'github' },
      annotations: {
        'remuda.rancher.io/pull-request': pr.html_url,
        'remuda.rancher.io/head-sha':     pr.head.sha,
      },
    },
    spec,
  };
}

/**
 * A create for a pull request already in hand, or the reason there cannot be one.
 *
 * Exported for the `/remuda up` path, where a comment carries only the issue and
 * the pull request has to be fetched before this can run.
 */
export function planCreate(pr, config, reason) {
  const name = environmentName(pr.base.repo.full_name, pr.number, config.namePrefix);

  if (pr.state !== 'open') {
    return none(`pull request #${ pr.number } is ${ pr.state }`, name);
  }

  // A pull request whose fork has since been deleted has nothing left to clone.
  if (!pr.head?.repo) {
    return none('the head repository no longer exists', name);
  }

  return {
    action: 'create', name, body: environmentFor(pr, config), reason
  };
}

/**
 * What a delivery asks for, without doing any of it.
 *
 * Returns `{ action, name, reason }`, where action is create, rebuild, delete or
 * none, plus whatever that action needs. `reason` is always set: a bot that
 * silently ignores an event looks exactly like a bot that is broken.
 */
export function planFor(event, payload, config = {}) {
  switch (event) {
  case 'pull_request':
    return planForPullRequest(payload, config);
  case 'issue_comment':
    return planForComment(payload, config);
  default:
    return none(`${ event } deliveries are not handled`);
  }
}

function planForPullRequest({ action, label, pull_request: pr }, config) {
  const name = environmentName(pr.base.repo.full_name, pr.number, config.namePrefix);

  switch (action) {
  // Not `opened`: a pull request opened with labels also delivers `labeled` for
  // each, so handling both would create twice.
  case 'labeled':
    return label?.name === LABEL ? planCreate(pr, config, `labelled ${ LABEL }`) : none(`label ${ label?.name } is not ${ LABEL }`, name);

  // Reopening keeps the labels and delivers no `labeled`, so this is the only
  // signal that the environment closing it removed is wanted back.
  case 'reopened':
    return hasLabel(pr) ? planCreate(pr, config, `reopened with the ${ LABEL } label`) : none(`no ${ LABEL } label`, name);

  case 'synchronize':
    if (!hasLabel(pr)) {
      return none(`no ${ LABEL } label`, name);
    }

    // New commits on a fork are code no maintainer has looked at. The label
    // approved the branch as it was then; building what arrived since would run
    // `yarn install` from someone outside the project on this cluster. A
    // maintainer's `/remuda rebuild` says they have looked.
    if (isFork(pr)) {
      return none('new commits on a fork wait for a maintainer to comment /remuda rebuild', name);
    }

    return {
      action: 'rebuild', name, sha: pr.head.sha, reason: 'new commits pushed'
    };

  case 'unlabeled':
    return label?.name === LABEL ? { action: 'delete', name, reason: `${ LABEL } label removed` } : none(`label ${ label?.name } is not ${ LABEL }`, name);

  case 'closed':
    return hasLabel(pr) ? { action: 'delete', name, reason: pr.merged ? 'pull request merged' : 'pull request closed' } : none(`no ${ LABEL } label`, name);

  default:
    return none(`pull_request ${ action } is not handled`, name);
  }
}

function planForComment({
  action, issue, comment, repository
}, config) {
  if (action !== 'created') {
    return none(`issue_comment ${ action } is not handled`);
  }

  if (!issue?.pull_request) {
    return none('the comment is on an issue, not a pull request');
  }

  const command = COMMAND.exec(comment?.body || '')?.[1];

  if (!command) {
    return none('no /remuda command');
  }

  const name = environmentName(repository.full_name, issue.number, config.namePrefix);
  const who = comment.user?.login;

  // author_association is GitHub's own statement of the commenter's standing in
  // this repository, so nothing has to be looked up to trust it.
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    return none(`${ who } (${ comment.author_association }) may not run /remuda ${ command }`, name);
  }

  switch (command) {
  case 'up':
    return {
      action: 'create', name, number: issue.number, needsPullRequest: true, reason: `/remuda up from ${ who }`
    };
  case 'rebuild':
    return { action: 'rebuild', name, reason: `/remuda rebuild from ${ who }` };
  default:
    return { action: 'delete', name, reason: `/remuda down from ${ who }` };
  }
}
