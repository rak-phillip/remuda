// A client for the Environment API over the plain Kubernetes path.
//
// It uses the raw /apis/remuda.rancher.io/... path: Rancher proxies it under
// /k8s/clusters/local, it takes a JSON merge patch -- which makes a rebuild one
// request rather than a read-modify-write -- and it is the path a ServiceAccount
// token would use unchanged if this ever ran in the cluster.

export class RemudaError extends Error {
  constructor(status, message) {
    super(`${ status }: ${ message }`);
    this.status = status;
  }
}

export function remudaClient({
  rancherUrl, token, dryRun = false, timeoutMs = 15000, fetch: fetchImpl = globalThis.fetch,
}) {
  const base = String(rancherUrl || '').replace(/\/+$/, '');
  // The CR always lives on the host cluster, whichever cluster it targets.
  const root = `${ base }/k8s/clusters/local`;
  const collection = `${ root }/apis/remuda.rancher.io/v1alpha1/namespaces/rancher-remuda/environments`;

  async function request(method, url, { body, contentType = 'application/json', query = {} } = {}) {
    const params = new URLSearchParams(query);

    // Server-side dry run: the API server admits, defaults, validates and prunes
    // exactly as it would for real, then persists nothing. A dry run is
    // therefore a test against the real schema rather than a guess at it.
    if (dryRun && method !== 'GET') {
      params.set('dryRun', 'All');
    }

    const qs = params.toString();
    const res = await fetchImpl(`${ url }${ qs ? `?${ qs }` : '' }`, {
      method,
      headers: {
        Authorization: `Bearer ${ token }`,
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

  const merge = (name, patch) => request('PATCH', `${ collection }/${ name }`, {
    body: patch, contentType: 'application/merge-patch+json',
  });

  return {
    dryRun,

    /** Whether the controller is installed at all, which is the first thing to check. */
    async ready() {
      try {
        await request('GET', `${ root }/apis/remuda.rancher.io/v1alpha1`);

        return true;
      } catch {
        return false;
      }
    },

    get:  (name) => request('GET', `${ collection }/${ name }`),
    list: (selector) => request('GET', collection, { query: selector ? { labelSelector: selector } : {} }),

    async create(body) {
      try {
        return { created: true, environment: await request('POST', collection, { body }) };
      } catch (e) {
        // Asking twice for the same environment is not an error: the thing that
        // was asked for exists.
        if (e.status === 409) {
          return { created: false, environment: await request('GET', `${ collection }/${ body.metadata.name }`) };
        }

        throw e;
      }
    },

    remove:  (name) => request('DELETE', `${ collection }/${ name }`),
    start:   (name) => merge(name, { spec: { running: true } }),
    stop:    (name) => merge(name, { spec: { running: false } }),

    /**
     * A rebuild is a token the controller compares for change, never a flag --
     * it writes only status and could never reset one it had acted on. An older
     * CRD drops the field without an error, so the value is read back.
     */
    async rebuild(name) {
      const token = new Date().toISOString();
      const out = await merge(name, { spec: { rebuildRequest: token } });

      if (!dryRun && out?.spec?.rebuildRequest !== token) {
        throw new RemudaError(400, 'the cluster dropped spec.rebuildRequest -- remuda-controller is older than this client');
      }

      return out;
    },

    /**
     * The generated bootstrap password, read from the Secret status names.
     *
     * It lives beside the workload, so a downstream environment's Secret is on
     * the downstream cluster -- named rather than inlined into status precisely
     * so that listing Environments does not hand out passwords.
     */
    async password(env) {
      const name = env?.status?.bootstrapSecret;

      if (!name) {
        return '';
      }

      const cluster = env.spec?.clusterId || 'local';
      const url = `${ base }/k8s/clusters/${ cluster }/api/v1/namespaces/rancher-remuda/secrets/${ name }`;
      const secret = await request('GET', url);

      return Buffer.from(secret?.data?.password || '', 'base64').toString('utf8');
    },
  };
}
