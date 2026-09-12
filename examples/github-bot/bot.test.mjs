import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, loadConfig } from './bot.mjs';

const payload = { repository: { full_name: 'rak-phillip/dashboard' }, pull_request: { number: 7 } };
const body = {
  metadata: { name: 'rak-dashboard-pr-7' },
  spec:     { repo: 'https://github.com/rak-phillip/dashboard.git', branch: 'task/x' },
};
const createPlan = {
  action: 'create', name: 'rak-dashboard-pr-7', body, reason: 'labelled remuda'
};

function fakes({
  list = [], create, rebuild, remove, get = [], dryRun = false
} = {}) {
  const comments = [];
  const remuda = {
    dryRun,
    list:    async() => ({ items: list.map((name) => ({ metadata: { name } })) }),
    create:  async(b) => create ?? { created: true, environment: b },
    rebuild: async(name) => rebuild ?? { found: true, supported: true, environment: { metadata: { name } } },
    remove:  async() => remove ?? { found: true },
    get:     async() => {
      const next = get.shift();

      if (next instanceof Error) {
        throw next;
      }

      return next;
    },
  };
  const github = {
    comment:     async(repo, number, text) => comments.push({ repo, number, text }),
    pullRequest: async() => assert.fail('no pull request lookup expected'),
  };

  return { remuda, github, comments };
}

const config = (extra = {}) => ({
  clusterId: 'local', maxEnvironments: 2, watch: true, watchTimeoutMs: 1000, ...extra
});

const botWith = (f, extra) => createBot({
  config: config(extra), remuda: f.remuda, github: f.github, intervalMs: 0
});

test('creates, and says what it is building without posting the password', async() => {
  const f = fakes();
  const result = await botWith(f).execute(createPlan, payload);

  assert.equal(result.outcome, 'created');
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].text, /building `rak-dashboard-pr-7`/);
  assert.match(f.comments[0].text, /password is not posted/);
});

test('refuses a create past the limit, unless the environment is already one of them', async() => {
  const full = fakes({ list: ['a-pr-1', 'b-pr-2'] });
  const refused = await botWith(full).execute(createPlan, payload);

  assert.equal(refused.outcome, 'refused');
  assert.match(full.comments[0].text, /limit of 2/);

  const again = fakes({ list: ['rak-dashboard-pr-7', 'b-pr-2'], create: { created: false, environment: body } });

  assert.equal((await botWith(again).execute(createPlan, payload)).outcome, 'exists');
});

test('marks a dry run in its outcome and its comment', async() => {
  const f = fakes({ dryRun: true });
  const result = await botWith(f).execute(createPlan, payload);

  assert.equal(result.dryRun, true);
  assert.match(f.comments[0].text, /Dry run/);
});

test('tells the pull request when the controller cannot rebuild', async() => {
  const f = fakes({ rebuild: { found: true, supported: false } });
  const result = await botWith(f).execute({ action: 'rebuild', name: 'rak-dashboard-pr-7', reason: 'push' }, payload);

  assert.equal(result.outcome, 'unsupported');
  assert.match(f.comments[0].text, /Upgrade the remuda-controller chart/);
});

test('says nothing about an environment that was never there', async() => {
  const f = fakes({ rebuild: { found: false }, remove: { found: false } });
  const bot = botWith(f);

  assert.equal((await bot.execute({ action: 'rebuild', name: 'x', reason: 'r' }, payload)).outcome, 'not-found');
  assert.equal((await bot.execute({ action: 'delete', name: 'x', reason: 'r' }, payload)).outcome, 'not-found');
  assert.equal(f.comments.length, 0);
});

test('follows only a real create', async() => {
  const created = { outcome: 'created', environment: { name: 'rak-dashboard-pr-7' } };

  assert.equal(botWith(fakes({ dryRun: true })).follow(created, payload), undefined);
  assert.equal(botWith(fakes()).follow({ outcome: 'exists' }, payload), undefined);
  assert.equal(botWith(fakes(), { watch: false }).follow(created, payload), undefined);
});

test('posts the URL once the environment answers', async() => {
  const f = fakes({
    get: [
      { status: { run: 'Pending', build: 'Building' } },
      { status: { run: 'Ready', build: 'Building', url: 'https://env' } },
      { status: { run: 'Ready', build: 'Ready', url: 'https://env' } },
    ],
  });

  await botWith(f).follow({ outcome: 'created', environment: { name: 'rak-dashboard-pr-7' } }, payload);

  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].text, /is up at https:\/\/env\.$/);
});

test('reports a provisioning failure instead of waiting it out', async() => {
  const f = fakes({ get: [{ status: { conditions: [{ type: 'Resolved', status: 'False', message: 'spec.ingressClass must be set' }] } }] });

  await botWith(f).follow({ outcome: 'created', environment: { name: 'rak-dashboard-pr-7' } }, payload);

  assert.match(f.comments[0].text, /could not provision .*spec\.ingressClass must be set/);
});

test('reports every missing setting at once', () => {
  const { missing } = loadConfig({});

  assert.deepEqual(missing, ['WEBHOOK_SECRET', 'RANCHER_URL or KUBE_API_SERVER', 'REMUDA_TOKEN or REMUDA_TOKEN_FILE']);
});

test('does not ask a GitHub Actions run for a webhook secret', () => {
  const { missing } = loadConfig({ RANCHER_URL: 'https://r', REMUDA_TOKEN: 't' }, { needsSecret: false });

  assert.deepEqual(missing, []);
});

test('names each pin a downstream target is missing', () => {
  const { missing } = loadConfig({
    RANCHER_URL: 'https://r', REMUDA_TOKEN: 't', WEBHOOK_SECRET: 's', TARGET_CLUSTER: 'c-m-9jprk9c6', PIN_INGRESS_CLASS: 'traefik'
  });

  assert.deepEqual(missing, ['PIN_STORAGE_CLASS', 'PIN_NESTED_POD_CIDR', 'PIN_NESTED_SERVICE_CIDR']);
});
