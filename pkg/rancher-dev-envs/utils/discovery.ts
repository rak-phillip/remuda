import { CONFIG_MAP_NAME, DEFAULT_BACKEND_IMAGE, DEV_ENV_NS, ENDPOINTS } from './constants';
import { create, list } from './api';
import type { ClusterDefaults } from '../types';

/**
 * The wildcard DNS record is created under the host Rancher's own domain, so
 * server-url is exactly the right source for the base domain.
 */
export function baseDomainFromServerUrl(serverUrl: string): string {
  return (serverUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Derive a hostname for an environment. Kept pure so it can be unit tested. */
export const hostnameFor = (name: string, baseDomain: string): string => `${ name }.${ baseDomain }`;

/**
 * There is no reliable Rancher version signal on a dashboard feature branch --
 * package.json is 0.0.0 and scripts/version falls back to the commit SHA when no
 * tag contains HEAD. So this only recognises the one case it genuinely can.
 */
export function backendImageForBranch(branch: string): string {
  const release = (branch || '').match(/release-(\d+\.\d+)/);

  return release ? `rancher/rancher:v${ release[1] }-head` : DEFAULT_BACKEND_IMAGE;
}

async function serverUrl(store: any): Promise<string> {
  try {
    const setting = await store.dispatch('management/find', {
      type: 'management.cattle.io.setting',
      id:   'server-url',
    });

    return setting?.value || setting?.default || '';
  } catch {
    return '';
  }
}

async function firstIngressClass(store: any, clusterId: string): Promise<string> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.ingressclass }` });
    const classes = res?.data || [];
    const marked = classes.find(
      (c: any) => c.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
    );

    return (marked || classes[0])?.metadata?.name || '';
  } catch {
    return '';
  }
}

async function defaultStorageClass(store: any, clusterId: string): Promise<string | undefined> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.storageclass }` });
    const classes = res?.data || [];
    const marked = classes.find(
      (c: any) => c.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
    );

    // Undefined rather than '' so the PVC omits the key entirely.
    return marked?.metadata?.name || classes[0]?.metadata?.name || undefined;
  } catch {
    return undefined;
  }
}

async function firstClusterIssuer(store: any, clusterId: string): Promise<string | undefined> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.clusterissuer }` });

    return res?.data?.[0]?.metadata?.name || undefined;
  } catch {
    return undefined;
  }
}

/** Persisted defaults win over discovered ones, so an override sticks. */
async function savedDefaults(store: any, clusterId: string): Promise<Partial<ClusterDefaults>> {
  try {
    const res = await list(store, clusterId, ENDPOINTS.configmap);
    const cm = (res?.data || []).find((c: any) => c.metadata?.name === CONFIG_MAP_NAME);

    return cm?.data ? JSON.parse(cm.data.defaults || '{}') : {};
  } catch {
    return {};
  }
}

export async function discoverDefaults(store: any, clusterId: string): Promise<ClusterDefaults> {
  const [url, ingressClass, storageClass, clusterIssuer, saved] = await Promise.all([
    serverUrl(store),
    firstIngressClass(store, clusterId),
    defaultStorageClass(store, clusterId),
    firstClusterIssuer(store, clusterId),
    savedDefaults(store, clusterId),
  ]);

  return {
    baseDomain: baseDomainFromServerUrl(url),
    ingressClass,
    storageClass,
    clusterIssuer,
    ...saved,
  };
}

export async function saveDefaults(store: any, clusterId: string, defaults: ClusterDefaults): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: CONFIG_MAP_NAME, namespace: DEV_ENV_NS },
    data:       { defaults: JSON.stringify(defaults, null, 2) },
  };

  try {
    await store.dispatch('management/request', {
      url:    `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.configmap }/${ DEV_ENV_NS }/${ CONFIG_MAP_NAME }`,
      method: 'PUT',
      data:   body,
    });
  } catch {
    await create(store, clusterId, { endpoint: ENDPOINTS.configmap, body });
  }
}
