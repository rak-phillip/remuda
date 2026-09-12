import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NAME, environmentFor, environmentName, planFor, sign, verifySignature
} from './plan.mjs';

// Shaped like rancher/dashboard#18994: a pull request from a fork.
const pr = (overrides = {}) => ({
  number:   18994,
  state:    'open',
  html_url: 'https://github.com/rancher/dashboard/pull/18994',
  user:     { login: 'rak-phillip' },
  labels:   [],
  head:     {
    ref:  'task/13742-a11y-color-contrast-tokens',
    sha:  '0123abc',
    repo: { full_name: 'rak-phillip/dashboard', clone_url: 'https://github.com/rak-phillip/dashboard.git' },
  },
  base: { repo: { full_name: 'rancher/dashboard', clone_url: 'https://github.com/rancher/dashboard.git' } },
  ...overrides,
});

const sameRepo = (overrides = {}) => pr({
  head: { ...pr().head, repo: pr().base.repo },
  ...overrides,
});

const labelled = (p) => ({ ...p, labels: [{ name: 'remuda' }] });
const delivery = (action, p, extra = {}) => ({
  action, pull_request: p, repository: p.base.repo, ...extra
});
const commentOn = (body, association) => ({
  action:     'created',
  issue:      { number: 18994, pull_request: {} },
  comment:    { body, author_association: association, user: { login: 'someone' } },
  repository: { full_name: 'rancher/dashboard' },
});

test('accepts GitHub\'s signature and nothing else', () => {
  const body = Buffer.from('{"action":"labeled"}');

  assert.equal(verifySignature('s3cret', body, sign('s3cret', body)), true);
  assert.equal(verifySignature('s3cret', Buffer.from('{"action":"closed"}'), sign('s3cret', body)), false);
  assert.equal(verifySignature('s3cret', body, sign('other', body)), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
  // No secret configured must never mean "everything verifies".
  assert.equal(verifySignature('', body, sign('', body)), false);
});

test('names an environment after its repository and pull request', () => {
  assert.equal(environmentName('rancher/dashboard', 18994), 'dashboard-pr-18994');
  assert.equal(environmentName('rancher/dashboard', 18994, 'Dash Board!'), 'dash-board-pr-18994');
});

test('keeps every name short enough for its build Job', () => {
  const name = environmentName('rancher/an-extraordinarily-long-repository-name-for-testing', 123456);

  assert.ok(name.length <= MAX_NAME, `${ name } is ${ name.length } characters`);
  assert.ok(`${ name }-build-1789223188`.length <= 63);
  assert.match(name, /-pr-123456$/);
  assert.doesNotMatch(name, /--/);
});

test('starts every name with a letter, as a Service name must', () => {
  assert.equal(environmentName('acme/9lives', 7), 'gh-9lives-pr-7');
  assert.equal(environmentName('acme/---', 7), 'gh-pr-7');
});

test('builds a fork from the fork', () => {
  const env = environmentFor(pr());

  assert.equal(env.spec.repo, 'https://github.com/rak-phillip/dashboard.git');
  assert.equal(env.spec.branch, 'task/13742-a11y-color-contrast-tokens');
  assert.equal(env.spec.owner, 'github-rak-phillip');
  assert.equal(env.metadata.labels['remuda.rancher.io/source'], 'github');
  // Nothing the controller can resolve for itself on the host is pinned.
  assert.deepEqual(Object.keys(env.spec).sort(), ['branch', 'owner', 'repo']);
});

test('pins what Fleet cannot read back only for a downstream target', () => {
  const pins = {
    ingressClass: 'traefik', storageClass: 'local-path', nestedPodCidr: '10.44.0.0/16', nestedServiceCidr: '10.45.0.0/16'
  };
  const env = environmentFor(pr(), { clusterId: 'c-m-9jprk9c6', pins });

  assert.equal(env.spec.clusterId, 'c-m-9jprk9c6');
  assert.equal(env.spec.nestedServiceCidr, '10.45.0.0/16');
  assert.equal(environmentFor(pr(), { clusterId: 'local', pins }).spec.clusterId, undefined);
});

test('creates when the remuda label is added, and only that label', () => {
  const p = labelled(pr());

  assert.equal(planFor('pull_request', delivery('labeled', p, { label: { name: 'remuda' } })).action, 'create');
  assert.equal(planFor('pull_request', delivery('labeled', p, { label: { name: 'bug' } })).action, 'none');
});

test('does not create for a closed pull request or a deleted fork', () => {
  const closed = labelled(pr({ state: 'closed' }));
  const orphaned = labelled(pr({ head: { ...pr().head, repo: null } }));

  assert.equal(planFor('pull_request', delivery('labeled', closed, { label: { name: 'remuda' } })).action, 'none');
  assert.equal(planFor('pull_request', delivery('labeled', orphaned, { label: { name: 'remuda' } })).action, 'none');
});

test('rebuilds on a push to a labelled branch in the same repository', () => {
  const plan = planFor('pull_request', delivery('synchronize', labelled(sameRepo())));

  assert.equal(plan.action, 'rebuild');
  assert.equal(plan.sha, '0123abc');
  assert.equal(planFor('pull_request', delivery('synchronize', sameRepo())).action, 'none');
});

// The label approved the fork as it was. What arrived since has not been looked at.
test('does not rebuild a fork on push', () => {
  const plan = planFor('pull_request', delivery('synchronize', labelled(pr())));

  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /\/remuda rebuild/);
});

test('deletes when the pull request closes or loses the label', () => {
  assert.equal(planFor('pull_request', delivery('closed', labelled(pr({ merged: true })))).reason, 'pull request merged');
  assert.equal(planFor('pull_request', delivery('unlabeled', pr(), { label: { name: 'remuda' } })).action, 'delete');
  assert.equal(planFor('pull_request', delivery('closed', pr())).action, 'none');
});

test('takes commands from people with standing in the repository', () => {
  assert.equal(planFor('issue_comment', commentOn('/remuda rebuild', 'MEMBER')).action, 'rebuild');
  assert.equal(planFor('issue_comment', commentOn('/remuda down', 'OWNER')).action, 'delete');

  const up = planFor('issue_comment', commentOn('Looks good.\n/remuda up', 'COLLABORATOR'));

  assert.equal(up.action, 'create');
  assert.equal(up.needsPullRequest, true);
  assert.equal(up.name, 'dashboard-pr-18994');
});

test('ignores commands from anyone else, and from issues', () => {
  assert.equal(planFor('issue_comment', commentOn('/remuda up', 'NONE')).action, 'none');
  assert.equal(planFor('issue_comment', commentOn('/remuda up', 'CONTRIBUTOR')).action, 'none');
  assert.equal(planFor('issue_comment', { ...commentOn('/remuda up', 'MEMBER'), issue: { number: 1 } }).action, 'none');
  assert.equal(planFor('issue_comment', commentOn('please /remuda up', 'MEMBER')).action, 'none');
});

test('always says why it did nothing', () => {
  for (const plan of [
    planFor('push', {}),
    planFor('pull_request', delivery('edited', pr())),
    planFor('issue_comment', commentOn('nice', 'MEMBER')),
  ]) {
    assert.equal(plan.action, 'none');
    assert.ok(plan.reason);
  }
});
