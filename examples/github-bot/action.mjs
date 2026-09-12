#!/usr/bin/env node
// The bot as a GitHub Actions step. See workflow.yml.
//
// GitHub has already authenticated the event -- it is the one running this -- so
// there is no signature to check, and the payload comes from the file Actions
// writes it to rather than from a request.

import { appendFileSync, readFileSync } from 'node:fs';
import { planFor } from './plan.mjs';
import {
  createBot, githubClient, loadConfig, remudaFor
} from './bot.mjs';

// Workflow commands are one line each, so anything interpolated into one has to
// be escaped the way the runner expects or it truncates at the first newline.
const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function summary(plan, result) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  // Led by a blank line so a second summary on the same run starts its own block.
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '',
    `### Remuda: ${ plan.action }${ plan.name ? ` \`${ plan.name }\`` : '' }`,
    '',
    `- **Why:** ${ plan.reason }`,
    `- **Outcome:** ${ result.outcome }${ result.dryRun ? ' (dry run)' : '' }${ result.reason ? ` -- ${ result.reason }` : '' }`,
    ...(result.error ? [`- **Error:** ${ result.error }`] : []),
    '',
  ].join('\n'));
}

const { config, missing } = loadConfig(process.env, { needsSecret: false });

if (missing.length) {
  console.log(`::error title=Remuda bot is not configured::${ escape(`missing ${ missing.join(', ') }; REMUDA_TOKEN comes from the repository secret of that name`) }`);
  process.exit(1);
}

const event = process.env.GITHUB_EVENT_NAME;
const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const remuda = remudaFor(config);
const bot = createBot({ config, remuda, github: githubClient(config) });
const plan = planFor(event, payload, config);

console.log(`${ event }.${ payload.action }: ${ plan.action }${ plan.name ? ` ${ plan.name }` : '' } -- ${ plan.reason }${ remuda.dryRun ? ' (DRY RUN)' : '' }`);

let result;

try {
  result = await bot.execute(plan, payload);
} catch (e) {
  console.log(`::error title=Remuda ${ plan.action } failed::${ escape(e.message) }`);
  summary(plan, { outcome: 'error', error: e.message });
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
summary(plan, result);

// Held open until the environment answers, so the comment with its URL comes
// from this run. The workflow's concurrency group cancels the wait if a later
// event for the same pull request arrives, which is the right outcome: that
// event supersedes this one.
await bot.follow(result, payload);
