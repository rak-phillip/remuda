import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remudaClient } from './remuda.mjs';

/** A fetch that records requests and answers from a queue. */
function fakeFetch(...answers) {
  const calls = [];
  const impl = async(url, init) => {
    calls.push({
      url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body)
    });
    const { status = 200, body } = answers.shift() || {};

    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };

  return { calls, impl };
}

const client = (fetch, extra = {}) => remudaClient({
  rancherUrl: 'https://rancher.example/', token: 'token-abc:xyz', fetch, ...extra
});

const body = { apiVersion: 'remuda.rancher.io/v1alpha1', kind: 'Environment', metadata: { name: 'dashboard-pr-1' }, spec: { repo: 'r', branch: 'b' } };

test('reaches the CR on the host cluster through Rancher\'s proxy', async() => {
  const { calls, impl } = fakeFetch({ status: 201, body });

  await client(impl).create(body);

  assert.equal(calls[0].url, 'https://rancher.example/k8s/clusters/local/apis/remuda.rancher.io/v1alpha1/namespaces/rancher-remuda/environments');
  assert.equal(calls[0].headers.Authorization, 'Bearer token-abc:xyz');
});

test('talks to the API server directly when running in-cluster', async() => {
  const { calls, impl } = fakeFetch({ body: { items: [] } });

  await remudaClient({ apiServer: 'https://kubernetes.default.svc', token: 't', fetch: impl }).list();

  assert.equal(calls[0].url, 'https://kubernetes.default.svc/apis/remuda.rancher.io/v1alpha1/namespaces/rancher-remuda/environments?labelSelector=remuda.rancher.io%2Fsource%3Dgithub');
});

test('dry-runs every write and no read', async() => {
  const { calls, impl } = fakeFetch({ status: 201, body }, { body }, { body: {} });
  const dry = client(impl, { dryRun: true });

  await dry.create(body);
  await dry.get('dashboard-pr-1');
  await dry.remove('dashboard-pr-1');

  assert.match(calls[0].url, /\?dryRun=All$/);
  assert.doesNotMatch(calls[1].url, /dryRun/);
  assert.match(calls[2].url, /\?dryRun=All$/);
});

test('treats an environment that already exists as the one asked for', async() => {
  const { impl } = fakeFetch({ status: 409, body: { message: 'already exists' } }, { body: { ...body, status: { url: 'https://x' } } });
  const result = await client(impl).create(body);

  assert.equal(result.created, false);
  assert.equal(result.environment.status.url, 'https://x');
});

test('asks for a rebuild with one merge patch', async() => {
  const now = new Date('2026-09-12T15:00:00Z');
  const { calls, impl } = fakeFetch({ body: { spec: { rebuildRequest: now.toISOString() } } });
  const result = await client(impl).rebuild('dashboard-pr-1', { sha: 'abc', now });

  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].headers['Content-Type'], 'application/merge-patch+json');
  assert.deepEqual(calls[0].body, { metadata: { annotations: { 'remuda.rancher.io/head-sha': 'abc' } }, spec: { rebuildRequest: now.toISOString() } });
  assert.deepEqual([result.found, result.supported], [true, true]);
});

// Measured against a 0.2.0-rc.10 controller: the PATCH succeeds and the field is gone.
test('notices a CRD that silently pruned the rebuild request', async() => {
  const { impl } = fakeFetch({ body: { spec: { repo: 'r', branch: 'b' } } });
  const result = await client(impl).rebuild('dashboard-pr-1');

  assert.deepEqual([result.found, result.supported], [true, false]);
});

test('reports a missing environment rather than failing', async() => {
  const { impl } = fakeFetch({ status: 404, body: { message: 'not found' } }, { status: 404, body: { message: 'not found' } });

  assert.deepEqual(await client(impl).rebuild('gone'), { found: false });
  assert.deepEqual(await client(impl).remove('gone'), { found: false });
});

test('surfaces anything else with the API server\'s own message', async() => {
  const { impl } = fakeFetch({ status: 403, body: { message: 'environments is forbidden' } });

  await assert.rejects(client(impl).create(body), (e) => e.status === 403 && /forbidden/.test(e.message));
});
