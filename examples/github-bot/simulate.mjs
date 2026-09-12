#!/usr/bin/env node
// Plays GitHub: builds the webhook deliveries a real pull request produces, signs
// them the way GitHub does, and sends them to the bot.
//
//   WEBHOOK_SECRET=... node simulate.mjs <scenario> [--pr owner/repo#number] [--url http://localhost:8787/webhook]

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LABEL, sign } from './plan.mjs';

const [scenario, ...rest] = process.argv.slice(2);
const option = (flag, fallback) => {
  const at = rest.indexOf(flag);

  return at >= 0 ? rest[at + 1] : fallback;
};

const url = option('--url', 'http://localhost:8787/webhook');
const prRef = option('--pr', 'rancher/dashboard#18994');
const secret = process.env.WEBHOOK_SECRET;

/**
 * The real pull request, through the gh CLI's own login.
 *
 * GitHub's webhook `pull_request` object is the same object the REST API
 * returns, so this is the payload GitHub would send rather than a hand-written
 * approximation of it -- fork, head repository, clone URL and all.
 */
function pullRequest(ref) {
  const [repo, number] = ref.split('#');

  return JSON.parse(execFileSync('gh', ['api', `repos/${ repo }/pulls/${ number }`], { encoding: 'utf8' }));
}

const labelled = (pr) => ({ ...pr, labels: [...(pr.labels || []).filter((l) => l.name !== LABEL), { name: LABEL }] });

const comment = (pr, body, association, login = pr.user.login) => ['issue_comment', {
  action:     'created',
  issue:      { number: pr.number, pull_request: { url: pr.url }, labels: pr.labels },
  comment:    { body, author_association: association, user: { login } },
  repository: pr.base.repo,
  sender:     { login },
}];

const scenarios = {
  // A maintainer adds the label.
  label: (pr) => ['pull_request', {
    action: 'labeled', label: { name: LABEL }, pull_request: labelled(pr), repository: pr.base.repo, sender: pr.user
  }],
  // The author pushes again. On a fork this is deliberately not a rebuild.
  push: (pr) => ['pull_request', {
    action: 'synchronize', after: pr.head.sha, pull_request: labelled(pr), repository: pr.base.repo, sender: pr.user
  }],
  'comment-up':      (pr) => comment(pr, '/remuda up', 'MEMBER'),
  'comment-rebuild': (pr) => comment(pr, '/remuda rebuild', 'MEMBER'),
  'comment-down':    (pr) => comment(pr, '/remuda down', 'MEMBER'),
  // Anyone can comment on a public pull request.
  'untrusted-comment': (pr) => comment(pr, '/remuda up', 'NONE', 'drive-by-account'),
  close:               (pr) => ['pull_request', {
    action: 'closed', pull_request: { ...labelled(pr), state: 'closed' }, repository: pr.base.repo, sender: pr.user
  }],
};

async function deliver(name, pr, key = secret) {
  const [event, payload] = scenarios[name === 'bad-signature' ? 'label' : name](pr);
  const raw = JSON.stringify(payload);
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':        'application/json',
      'User-Agent':          'GitHub-Hookshot/remuda-simulator',
      'X-GitHub-Event':      event,
      'X-GitHub-Delivery':   randomUUID(),
      'X-Hub-Signature-256': sign(key, raw),
    },
    body: raw,
  });

  console.log(`\n=== ${ name }: ${ event }.${ payload.action } -> HTTP ${ res.status }`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

const known = [...Object.keys(scenarios), 'bad-signature'];

if (!secret || !known.includes(scenario)) {
  console.error(`usage: WEBHOOK_SECRET=... node simulate.mjs <${ known.join('|') }> [--pr owner/repo#number] [--url ...]`);
  process.exit(2);
}

const pr = pullRequest(prRef);

await deliver(scenario, pr, scenario === 'bad-signature' ? `${ secret }-wrong` : secret);
