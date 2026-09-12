#!/usr/bin/env node
// The bot as a webhook receiver. See README.md for configuration; action.mjs is
// the same bot as a GitHub Actions step.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { HOST_CLUSTER, planFor, verifySignature } from './plan.mjs';
import {
  createBot, githubClient, loadConfig, remudaFor
} from './bot.mjs';

const MAX_BODY = 5 * 1024 * 1024;

const { config, missing } = loadConfig(process.env);

if (missing.length) {
  console.error(`missing configuration: ${ missing.join(', ') }`);
  process.exit(1);
}

const remuda = remudaFor(config);
const bot = createBot({ config, remuda, github: githubClient(config) });

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async(req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, { ok: true, dryRun: remuda.dryRun });
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    return send(res, 404, { error: 'not found' });
  }

  let raw;

  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, 413, { error: e.message });
  }

  if (!verifySignature(config.secret, raw, req.headers['x-hub-signature-256'])) {
    console.warn('rejected a delivery with a missing or wrong signature');

    return send(res, 401, { error: 'bad signature' });
  }

  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'] || randomUUID();

  if (event === 'ping') {
    return send(res, 200, { delivery, pong: true });
  }

  let payload;

  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'body is not JSON' });
  }

  const plan = planFor(event, payload, config);
  const planned = { action: plan.action, name: plan.name, reason: plan.reason };

  console.log(`${ delivery } ${ event }.${ payload.action }: ${ plan.action }${ plan.name ? ` ${ plan.name }` : '' } -- ${ plan.reason }`);

  try {
    const result = await bot.execute(plan, payload);

    send(res, 200, { delivery, plan: planned, ...result });

    // Not awaited: GitHub wants its answer within ten seconds, and an environment
    // takes minutes to answer.
    bot.follow(result, payload)?.catch((e) => console.error(`${ plan.name }: follow-up failed: ${ e.message }`));
  } catch (e) {
    console.error(`${ delivery }: ${ e.message }`);
    // A 5xx marks the delivery failed in GitHub's UI, which offers Redeliver --
    // that is the whole retry story for a webhook.
    send(res, 502, {
      delivery, plan: planned, error: e.message, status: e.status
    });
  }
});

server.listen(config.port, () => {
  const where = config.rancherUrl || config.apiServer;
  const target = config.clusterId === HOST_CLUSTER ? '' : ` for ${ config.clusterId }`;

  console.log(`remuda github bot listening on :${ config.port }, driving ${ where }${ target }${ config.dryRun ? ' (DRY RUN)' : '' }${ config.postComments ? ', posting comments' : ', printing comments' }`);
});
