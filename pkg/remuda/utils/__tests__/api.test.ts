import {
  collectionUrl, deleteEnvironment, hostnameTaken, resourceUrl, resyncHop,
  setEnvironmentRunning,
} from '../api';
import { CONFIG_MAP_NAME, ENDPOINTS, HOST_CLUSTER_ID, LABEL_NAME } from '../constants';
import type { IngressEntry, RemudaSpec } from '../../types';

describe('collectionUrl', () => {
  // Steve ignores labelSelector -- verified against a live instance, where a
  // nonsense selector still returned all 84 configmaps -- but honours filter=.
  it('filters by namespace rather than by label', () => {
    expect(collectionUrl('local', ENDPOINTS.configmap)).toBe(
      '/k8s/clusters/local/v1/configmaps?filter=metadata.namespace=rancher-remuda'
    );
    expect(collectionUrl('local', ENDPOINTS.configmap)).not.toContain('labelSelector');
  });

  it('routes through the downstream cluster path', () => {
    expect(collectionUrl('c-m-abc123', ENDPOINTS.deployment)).toContain('/k8s/clusters/c-m-abc123/v1/apps.deployments');
  });
});

describe('resourceUrl', () => {
  it('addresses a single namespaced object', () => {
    expect(resourceUrl('local', ENDPOINTS.ingress, 'rancher-remuda', 'multi-idp'))
      .toBe('/k8s/clusters/local/v1/networking.k8s.io.ingresses/rancher-remuda/multi-idp');
  });
});

describe('deleteEnvironment', () => {
  const envConfigMap = { metadata: { name: 'multi-idp', labels: { [LABEL_NAME]: 'multi-idp' } } };
  // The shared per-cluster defaults. No owner label today, but it lives in the
  // same namespace and the same collection as the environment's own ConfigMap.
  const sharedConfigMap = { metadata: { name: CONFIG_MAP_NAME } };

  const spec = { name: 'multi-idp', namespace: 'rancher-remuda' } as any;

  function storeReturning(rows: any[]) {
    const deleted: string[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'DELETE') {
          deleted.push(opts.url);

          return {};
        }

        return { data: opts.url.includes('configmaps') ? rows : [] };
      }),
    };

    return { store, deleted };
  }

  it('deletes objects belonging to the environment', async() => {
    const { store, deleted } = storeReturning([envConfigMap]);

    await deleteEnvironment(store, 'local', spec);

    expect(deleted.some((u) => u.endsWith('/configmaps/rancher-remuda/multi-idp'))).toBe(true);
  });

  it('never deletes the shared cluster defaults', async() => {
    const { store, deleted } = storeReturning([envConfigMap, sharedConfigMap]);

    await deleteEnvironment(store, 'local', spec);

    expect(deleted.some((u) => u.includes(CONFIG_MAP_NAME))).toBe(false);
  });

  it('leaves other environments alone', async() => {
    const other = { metadata: { name: 'other', labels: { [LABEL_NAME]: 'other' } } };
    const { store, deleted } = storeReturning([envConfigMap, other]);

    await deleteEnvironment(store, 'local', spec);

    expect(deleted.some((u) => u.endsWith('/other'))).toBe(false);
  });
});

describe('deleteEnvironment sweeps pods', () => {
  it('deletes pods, and does so before the PVCs they mount', async() => {
    // Deleting a Job orphans its pods -- batch/v1 defaults to Orphan
    // propagation -- and a surviving build pod holds the ui and cache claims
    // via kubernetes.io/pvc-protection. The PVCs then never finalise and the
    // environment's name can never be reused.
    const deleted: string[] = [];
    const store = {
      dispatch: jest.fn(async(_a: string, opts: any) => {
        if (opts.method === 'DELETE') {
          deleted.push(opts.url);

          return {};
        }

        return { data: [{ metadata: { name: 'multi-idp-build-1', labels: { [LABEL_NAME]: 'multi-idp' } } }] };
      }),
    };

    await deleteEnvironment(store, 'local', { name: 'multi-idp', namespace: 'rancher-remuda' } as any);

    const pod = deleted.findIndex((u) => u.includes(`/${ ENDPOINTS.pod }/`));
    const pvc = deleted.findIndex((u) => u.includes(ENDPOINTS.persistentvolumeclaim));

    expect(pod).toBeGreaterThan(-1);
    expect(pvc).toBeGreaterThan(-1);
    expect(pod).toBeLessThan(pvc);
  });
});

describe('deleteEnvironment across clusters', () => {
  const owned = { metadata: { name: 'multi-idp-hop', labels: { [LABEL_NAME]: 'multi-idp' } } };

  function tracking() {
    const deleted: string[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'DELETE') {
          deleted.push(opts.url);

          return {};
        }

        return { data: [owned] };
      }),
    };

    return { store, deleted };
  }

  const downstream = { name: 'multi-idp', namespace: 'rancher-remuda' } as any;

  it('sweeps the host cluster too, or a leaked Ingress blocks the name forever', async() => {
    // Hostnames are unique across every cluster because they share one wildcard,
    // so a hop Ingress left behind on `local` cannot be worked around by
    // creating the environment somewhere else.
    const { store, deleted } = tracking();

    await deleteEnvironment(store, 'c-m-dff2ssd2', downstream);

    expect(deleted.some((u) => u.includes(`/clusters/${ HOST_CLUSTER_ID }/`) && u.includes(ENDPOINTS.endpointslice))).toBe(true);
    expect(deleted.some((u) => u.includes(`/clusters/${ HOST_CLUSTER_ID }/`) && u.includes(ENDPOINTS.ingress))).toBe(true);
    expect(deleted.some((u) => u.includes('/clusters/c-m-dff2ssd2/'))).toBe(true);
  });

  it('does not touch the host cluster for a local environment', async() => {
    // There is no hop; the only objects on `local` are the environment's own,
    // and they are already covered by the normal sweep.
    const { store, deleted } = tracking();

    await deleteEnvironment(store, HOST_CLUSTER_ID, downstream);

    expect(deleted.some((u) => u.includes(ENDPOINTS.endpointslice))).toBe(false);
    expect(deleted.some((u) => u.includes(ENDPOINTS.serverstransport))).toBe(false);
  });

  it('survives a cluster that has never heard of ServersTransport', async() => {
    // Listing a kind that does not exist is a 404, not a failed delete.
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.url.includes(ENDPOINTS.serverstransport)) {
          throw new Error('no such type');
        }

        return opts.method === 'DELETE' ? {} : { data: [owned] };
      }),
    };

    await expect(deleteEnvironment(store, 'c-m-dff2ssd2', downstream)).resolves.toBeUndefined();
  });
});

describe('hostnameTaken', () => {
  const asking = (rows: any[]) => ({ dispatch: jest.fn(async(..._args: any[]) => ({ data: rows })) });

  it('looks on the host cluster, where every hostname lands', async() => {
    const store = asking([{ spec: { rules: [{ host: 'multi-idp.example.com' }] } }]);

    expect(await hostnameTaken(store, 'multi-idp.example.com')).toBe(true);
    expect(store.dispatch.mock.calls[0][1].url).toContain(`/clusters/${ HOST_CLUSTER_ID }/`);
  });

  it('is false for a free hostname', async() => {
    expect(await hostnameTaken(asking([{ spec: { rules: [{ host: 'other.example.com' }] } }]), 'multi-idp.example.com')).toBe(false);
  });

  it('does not block a create when the lookup fails', async() => {
    // A courtesy check. Someone without permission to list Ingresses on the host
    // cluster should still be able to create an environment.
    const store = {
      dispatch: jest.fn(async() => {
        throw new Error('403');
      })
    };

    expect(await hostnameTaken(store, 'multi-idp.example.com')).toBe(false);
  });
});

describe('resyncHop', () => {
  const spec = {
    name:      'multi-idp',
    namespace: 'rancher-remuda',
    hostname:  'multi-idp.example.com',
    hop:       {
      hostClusterId:   'local',
      targetClusterId: 'c-m-dff2ssd2',
      addresses:       ['52.12.200.3'],
      addressType:     'ExternalIP',
      port:            443,
      ingressClass:    'traefik',
    },
  } as RemudaSpec;

  const entry: IngressEntry = {
    addresses: ['52.12.200.9'], addressType: 'ExternalIP', port: 443
  };

  it('carries resourceVersion, which Steve requires on any update', async() => {
    const calls: any[] = [];
    const store = {
      dispatch: jest.fn(async(_a: string, opts: any) => {
        calls.push(opts);

        return opts.method ? {} : { metadata: { resourceVersion: '1234' } };
      })
    };

    expect(await resyncHop(store, spec, entry)).toBe(true);

    const put = calls.find((c) => c.method === 'PUT');

    expect(put.data.metadata.resourceVersion).toBe('1234');
    expect(put.data.endpoints[0].addresses).toEqual(['52.12.200.9']);
    expect(put.url).toContain(`/clusters/${ HOST_CLUSTER_ID }/`);
  });

  it('creates the slice when it has gone missing entirely', async() => {
    const calls: any[] = [];
    const store = {
      dispatch: jest.fn(async(_a: string, opts: any) => {
        calls.push(opts);

        if (!opts.method) {
          throw new Error('404');
        }

        return {};
      })
    };

    expect(await resyncHop(store, spec, entry)).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('refuses to point a working hop at nothing', async() => {
    const store = { dispatch: jest.fn() };

    expect(await resyncHop(store, spec, {
      addresses: [], addressType: 'ExternalIP', port: 443
    })).toBe(false);
    expect(store.dispatch).not.toHaveBeenCalled();
  });
});

describe('setEnvironmentRunning', () => {
  const spec = { name: 'multi-idp', namespace: 'rancher-remuda' } as any;

  /** Answers every GET with a Deployment at `replicas`, and records the PUTs. */
  function storeWith(replicas: number, missing: string[] = []) {
    const puts: { url: string; replicas: number }[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'PUT') {
          puts.push({ url: opts.url, replicas: opts.data.spec.replicas });

          return {};
        }

        if (missing.some((name) => opts.url.endsWith(`/${ name }`))) {
          throw new Error('not found');
        }

        return { metadata: { resourceVersion: '42' }, spec: { replicas } };
      }),
    };

    return { store, puts };
  }

  it('scales both Deployments to zero on a stop', async() => {
    const { store, puts } = storeWith(1);

    await setEnvironmentRunning(store, 'local', spec, false);

    expect(puts.map((p) => p.replicas)).toEqual([0, 0]);
    expect(puts.map((p) => p.url)).toEqual([
      '/k8s/clusters/local/v1/apps.deployments/rancher-remuda/multi-idp',
      '/k8s/clusters/local/v1/apps.deployments/rancher-remuda/multi-idp-ui',
    ]);
  });

  it('brings nginx up before the backend on a start', async() => {
    // The backend fetches ui-dashboard-index server-side as it boots, so the
    // bundle should already be being served by then.
    const { store, puts } = storeWith(0);

    await setEnvironmentRunning(store, 'local', spec, true);

    expect(puts.map((p) => p.url)).toEqual([
      '/k8s/clusters/local/v1/apps.deployments/rancher-remuda/multi-idp-ui',
      '/k8s/clusters/local/v1/apps.deployments/rancher-remuda/multi-idp',
    ]);
    expect(puts.every((p) => p.replicas === 1)).toBe(true);
  });

  it('writes nothing when the Deployments already hold the wanted scale', async() => {
    const { store, puts } = storeWith(0);

    await setEnvironmentRunning(store, 'local', spec, false);

    expect(puts).toHaveLength(0);
  });

  it('scales what exists when a Deployment is missing', async() => {
    // An incomplete environment is missing one or both by definition, and
    // stopping the half that is there is still the useful outcome.
    const { store, puts } = storeWith(1, ['multi-idp-ui']);

    await setEnvironmentRunning(store, 'local', spec, false);

    expect(puts.map((p) => p.url)).toEqual([
      '/k8s/clusters/local/v1/apps.deployments/rancher-remuda/multi-idp',
    ]);
  });

  it('reports a failed write rather than swallowing it', async() => {
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'PUT') {
          throw new Error('forbidden');
        }

        return { spec: { replicas: 1 } };
      }),
    };

    await expect(setEnvironmentRunning(store, 'local', spec, false)).rejects.toThrow('forbidden');
  });
});
