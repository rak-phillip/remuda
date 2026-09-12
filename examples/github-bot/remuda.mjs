// A client for the Environment API over the plain Kubernetes path.
//
// Not Steve's /v1 path, which the extension uses. The raw
// /apis/remuda.rancher.io/... path is the one Rancher proxies under
// /k8s/clusters/local and the one the API server answers in-cluster, so moving
// the bot from a laptop holding a Rancher token to a Deployment holding a
// ServiceAccount changes a base URL and a token and nothing else. It also takes a
// JSON merge patch, which makes a rebuild one request rather than a
// read-modify-write.

import { readFileSync } from 'node:fs';
import {
  API_VERSION, HOST_CLUSTER, NAMESPACE, SOURCE_LABEL
} from './plan.mjs';

export class RemudaError extends Error {
  constructor(status, message) {
    super(`${ status }: ${ message }`);
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {string} [options.rancherUrl] Rancher server URL; the CR is reached through its proxy to `local`.
 * @param {string} [options.apiServer] Kubernetes API server URL, for running inside the host cluster.
 * @param {string} [options.token] Bearer token: a Rancher API token, or a ServiceAccount token.
 * @param {string} [options.tokenFile] Read per request instead, because projected ServiceAccount tokens rotate.
 * @param {boolean} [options.dryRun] Ask the API server to validate every write and persist none of them.
 */
export function remudaClient({
  rancherUrl, apiServer, token, tokenFile, dryRun = false, fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000,
}) {
  // The CR always lives on the host cluster, whichever cluster it targets.
  const root = rancherUrl ? `${ rancherUrl.replace(/\/+$/, '') }/k8s/clusters/${ HOST_CLUSTER }` : apiServer.replace(/\/+$/, '');
  const collection = `${ root }/apis/${ API_VERSION }/namespaces/${ NAMESPACE }/environments`;
  const bearer = () => (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : token);

  async function request(method, url, { body, contentType = 'application/json', query = {} } = {}) {
    const params = new URLSearchParams(query);

    // Server-side dry run: the API server admits, defaults, validates and prunes
    // exactly as it would for real, then persists nothing. That makes a dry run a
    // test against the real schema rather than a guess at it.
    if (dryRun && method !== 'GET') {
      params.set('dryRun', 'All');
    }

    const qs = params.toString();
    const res = await fetchImpl(`${ url }${ qs ? `?${ qs }` : '' }`, {
      method,
      headers: {
        Authorization: `Bearer ${ bearer() }`,
        Accept:        'application/json',
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body:   body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let json;

    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      throw new RemudaError(res.status, json?.message || text || res.statusText);
    }

    return json;
  }

  const client = {
    dryRun,

    get: (name) => request('GET', `${ collection }/${ name }`),

    /** Environments the bot made, which is what its capacity limit counts. */
    list: () => request('GET', collection, { query: { labelSelector: `${ SOURCE_LABEL }=github` } }),

    async create(body) {
      try {
        return { created: true, environment: await request('POST', collection, { body }) };
      } catch (e) {
        // A repeated `labeled`, or /remuda up on a pull request that already has
        // one. The environment exists, which is what was asked for.
        if (e.status === 409) {
          return { created: false, environment: await client.get(body.metadata.name) };
        }

        throw e;
      }
    },

    /**
     * Ask for a fresh build of the branch's current head.
     *
     * The response is checked for the token that was sent, because a CRD from
     * before rebuildRequest existed prunes the field without an error -- measured
     * on a 0.2.0-rc.10 controller. Without the check, that reads as success and
     * nothing ever builds.
     */
    async rebuild(name, { sha, now = new Date() } = {}) {
      const requested = now.toISOString();
      let environment;

      try {
        environment = await request('PATCH', `${ collection }/${ name }`, {
          contentType: 'application/merge-patch+json',
          body:        {
            metadata: sha ? { annotations: { 'remuda.rancher.io/head-sha': sha } } : undefined,
            spec:     { rebuildRequest: requested },
          },
        });
      } catch (e) {
        if (e.status === 404) {
          return { found: false };
        }

        throw e;
      }

      return { found: true, supported: environment?.spec?.rebuildRequest === requested, environment };
    },

    async remove(name) {
      try {
        await request('DELETE', `${ collection }/${ name }`);

        return { found: true };
      } catch (e) {
        if (e.status === 404) {
          return { found: false };
        }

        throw e;
      }
    },
  };

  return client;
}
