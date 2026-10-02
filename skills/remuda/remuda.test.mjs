import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_NAME, cloneUrl, detectAgent, environmentFor, environmentName, missingPins, repoSlug, summarize,
} from './env.mjs';

test('an ssh remote becomes the anonymous https URL the build pod can clone', () => {
  assert.equal(cloneUrl('git@github.com:rak-phillip/dashboard.git'), 'https://github.com/rak-phillip/dashboard');
  assert.equal(cloneUrl('ssh://git@github.com/rak-phillip/dashboard.git'), 'https://github.com/rak-phillip/dashboard');
  assert.equal(cloneUrl('https://github.com/rancher/dashboard.git'), 'https://github.com/rancher/dashboard');
  assert.equal(repoSlug('git@github.com:rak-phillip/dashboard.git'), 'rak-phillip/dashboard');
});

test('a name is derived from the repository and the branch', () => {
  assert.equal(environmentName('git@github.com:rak-phillip/dashboard.git', 'task/17295-multi-idp'), 'dashboard-task-17295-multi-idp');
});

test('the repository gives way before the branch does', () => {
  const branch = 'task/12345-multi-idp-provider-config-page';
  const name = environmentName('https://github.com/rak-phillip/dashboard', branch);

  assert.ok(name.length <= MAX_NAME, `${ name } is ${ name.length } characters`);
  assert.ok(name.endsWith(branch.replace('/', '-')), name);
  assert.ok(name.startsWith('das'), name);
});

test('a branch too long on its own is cut from the tail, keeping the issue number', () => {
  const name = environmentName('https://github.com/rak-phillip/dashboard', 'task/12345-a-very-long-branch-name-that-keeps-going-and-going');

  assert.ok(name.length <= MAX_NAME, `${ name } is ${ name.length } characters`);
  assert.ok(name.startsWith('task-12345-'), name);
});

test('a name always starts with a letter, because it becomes a Service name', () => {
  assert.match(environmentName('https://github.com/x/1repo', '2branch'), /^[a-z]/);
});

test('a host-cluster environment pins nothing', () => {
  const body = environmentFor({ repo: 'git@github.com:rak-phillip/dashboard.git', branch: 'main', clusterId: 'local' });

  assert.deepEqual(Object.keys(body.spec).sort(), ['branch', 'repo']);
  assert.equal(body.metadata.labels['remuda.rancher.io/source'], 'agent-skill');
  assert.equal(body.metadata.annotations['remuda.rancher.io/agent'], 'unknown');
  assert.deepEqual(missingPins('local', {}), []);
});

test('a downstream environment carries the four fields Fleet cannot read back', () => {
  const pins = {
    ingressClass: 'traefik', storageClass: 'local-path', nestedPodCidr: '10.44.0.0/16', nestedServiceCidr: '10.45.0.0/16',
  };
  const body = environmentFor({
    repo: 'https://github.com/rak-phillip/dashboard', branch: 'main', clusterId: 'c-m-abc', pins,
  });

  assert.equal(body.spec.clusterId, 'c-m-abc');
  assert.equal(body.spec.nestedServiceCidr, '10.45.0.0/16');
  assert.deepEqual(missingPins('c-m-abc', { ingressClass: 'traefik' }), ['storageClass', 'nestedPodCidr', 'nestedServiceCidr']);
});

test('the agent comes from what each agent sets, and an override wins', () => {
  assert.equal(detectAgent({ AI_AGENT: 'claude-code_2-1-287_agent', CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectAgent({ AI_AGENT: 'pi', PI_CODING_AGENT: 'true' }), 'pi');
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectAgent({ PI_CODING_AGENT: 'true' }), 'pi');
  assert.equal(detectAgent({ CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({ REMUDA_AGENT: 'My Agent', AI_AGENT: 'pi' }), 'my-agent');
  assert.equal(detectAgent({}), 'unknown');
});

test('an owner is made into a legal label value', () => {
  const body = environmentFor({ repo: 'https://github.com/x/y', branch: 'main', owner: 'Rak Phillip' });

  assert.equal(body.spec.owner, 'rak-phillip');
});

test('a downstream build reads Unknown rather than failed', () => {
  const s = summarize({
    metadata: { name: 'x' },
    spec:     { branch: 'main', clusterId: 'c-m-abc' },
    status:   { run: 'Ready', url: 'https://x.example.com' },
  });

  assert.equal(s.build, 'Unknown');
  assert.equal(s.run, 'Ready');
  assert.deepEqual(s.problems, []);
});

test('a failing condition is reported, and Ready is not repeated as one', () => {
  const s = summarize({
    metadata: { name: 'x' },
    spec:     { branch: 'main' },
    status:   {
      conditions: [
        { type: 'Ready', status: 'False', message: 'not yet' },
        { type: 'Resolved', status: 'False', message: 'needs ingressClass' },
      ],
    },
  });

  assert.deepEqual(s.problems, ['Resolved: needs ingressClass']);
});
