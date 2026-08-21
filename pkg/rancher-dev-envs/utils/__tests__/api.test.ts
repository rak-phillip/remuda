import { collectionUrl, resourceUrl } from '../api';
import { ENDPOINTS } from '../constants';

describe('collectionUrl', () => {
  // Steve ignores labelSelector -- verified against a live instance, where a
  // nonsense selector still returned all 84 configmaps -- but honours filter=.
  it('filters by namespace rather than by label', () => {
    expect(collectionUrl('local', ENDPOINTS.configmap)).toBe(
      '/k8s/clusters/local/v1/configmaps?filter=metadata.namespace=rancher-dev-envs'
    );
    expect(collectionUrl('local', ENDPOINTS.configmap)).not.toContain('labelSelector');
  });

  it('routes through the downstream cluster path', () => {
    expect(collectionUrl('c-m-abc123', ENDPOINTS.deployment)).toContain('/k8s/clusters/c-m-abc123/v1/apps.deployments');
  });
});

describe('resourceUrl', () => {
  it('addresses a single namespaced object', () => {
    expect(resourceUrl('local', ENDPOINTS.ingress, 'rancher-dev-envs', 'multi-idp'))
      .toBe('/k8s/clusters/local/v1/networking.k8s.io.ingresses/rancher-dev-envs/multi-idp');
  });
});
