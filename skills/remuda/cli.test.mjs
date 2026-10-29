import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./remuda.mjs', import.meta.url));

/**
 * Run the CLI with no Rancher configured at all, so anything that reaches
 * the network dies with "no Rancher configured" -- which is how these tests
 * tell a command that stopped early from one that went on to do something.
 */
function remuda(...args) {
  const env = { ...process.env, REMUDA_CONFIG: '/nonexistent/remuda.json' };

  delete env.RANCHER_URL;
  delete env.REMUDA_TOKEN;

  const out = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });

  return { code: out.status, text: `${ out.stdout }${ out.stderr }` };
}

test('--help on a command prints help and does nothing else', () => {
  // `create --help` once created an environment from whatever checkout it
  // ran in. It must never get as far as connecting.
  for (const command of ['create', 'get', 'delete', 'doctor']) {
    const { code, text } = remuda(command, '--help');

    assert.equal(code, 0, `${ command } --help exited ${ code }: ${ text }`);
    assert.match(text, /remuda <command>/);
    assert.doesNotMatch(text, /no Rancher configured/);
  }
});

test('an unknown flag is refused before anything runs', () => {
  const { code, text } = remuda('create', '--bogus');

  assert.equal(code, 1);
  assert.match(text, /create does not take --bogus/);
  assert.match(text, /--backend-url/);
  assert.doesNotMatch(text, /no Rancher configured/);
});

test('a flag for one command is not accepted by another', () => {
  const { code, text } = remuda('delete', 'x', '--timeout', '5');

  assert.equal(code, 1);
  assert.match(text, /delete does not take --timeout/);
});

test('a switch does not swallow the argument after it', () => {
  // --prime used to take the next word as its value.
  const { code, text } = remuda('create', '--prime', '--backend-url', 'https://rancher.example.com');

  assert.equal(code, 1);
  assert.match(text, /--prime needs a backend of the environment's own/);
});

test('a value flag without its value is an error, not true', () => {
  const { code, text } = remuda('create', '--branch');

  assert.equal(code, 1);
  assert.match(text, /--branch needs a value/);
});

test('--backend-url must be an origin', () => {
  const { code, text } = remuda('create', '--backend-url', 'https://rancher.example.com/dashboard/home');

  assert.equal(code, 1);
  assert.match(text, /the Rancher's address alone/);
});
