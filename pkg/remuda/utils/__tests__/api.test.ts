import { collectionUrl, deleteEnvironment, resourceUrl } from '../api';
import { CONFIG_MAP_NAME, ENDPOINTS, LABEL_NAME } from '../constants';

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
