import { CONFIG_MAP_NAME, DEV_ENV_NS, ENDPOINTS, LABEL_NAME } from './constants';
import { allManifests, buildJobManifest, namespaceManifest } from './manifests';
import { localPathManifests } from './storage';
import type { DevEnvSpec, ManifestRequest } from '../types';

const base = (clusterId: string) => `/k8s/clusters/${ clusterId }/v1`;

/**
 * Steve silently ignores `labelSelector` -- a nonsense selector still returns
 * every object -- but honours its own `filter=`. Everything therefore lives in
 * one namespace and is queried by namespace, not by label.
 */
export function collectionUrl(clusterId: string, endpoint: string, namespace = DEV_ENV_NS): string {
  return `${ base(clusterId) }/${ endpoint }?filter=metadata.namespace=${ namespace }`;
}

export const resourceUrl = (clusterId: string, endpoint: string, namespace: string, name: string): string => `${ base(clusterId) }/${ endpoint }/${ namespace }/${ name }`;

export function list(store: any, clusterId: string, endpoint: string, namespace = DEV_ENV_NS): Promise<any> {
  return store.dispatch('management/request', { url: collectionUrl(clusterId, endpoint, namespace) });
}

export function create(store: any, clusterId: string, { endpoint, body }: ManifestRequest): Promise<any> {
  return store.dispatch('management/request', {
    url: `${ base(clusterId) }/${ endpoint }`, method: 'POST', data: body,
  });
}

export function remove(store: any, clusterId: string, endpoint: string, namespace: string, name: string): Promise<any> {
  return store.dispatch('management/request', { url: resourceUrl(clusterId, endpoint, namespace, name), method: 'DELETE' });
}

export async function ensureNamespace(store: any, clusterId: string, namespace = DEV_ENV_NS): Promise<void> {
  try {
    await store.dispatch('management/request', { url: `${ base(clusterId) }/${ ENDPOINTS.namespace }/${ namespace }` });
  } catch {
    await create(store, clusterId, namespaceManifest(namespace));
  }
}

/** Clusters the extension can deploy into, newest Rancher state first. */
export async function readyClusters(store: any): Promise<{ id: string; name: string; isLocal: boolean }[]> {
  const clusters = await store.dispatch('management/findAll', { type: 'management.cattle.io.cluster' });

  return (clusters || [])
    .filter((c: any) => c.isReady !== false)
    .map((c: any) => ({
      id:      c.id,
      name:    c.nameDisplay || c.spec?.displayName || c.id,
      isLocal: c.id === 'local',
    }));
}

/** The ConfigMap records are the source of truth for what exists. */
export async function readEnvironments(store: any, clusterId: string): Promise<DevEnvSpec[]> {
  const res = await list(store, clusterId, ENDPOINTS.configmap);

  return (res?.data || [])
    .filter((cm: any) => cm.data?.spec && cm.metadata?.labels?.[LABEL_NAME])
    .map((cm: any) => {
      try {
        return JSON.parse(cm.data.spec);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function createEnvironment(
  store: any, clusterId: string, spec: DevEnvSpec, password: string
): Promise<void> {
  await ensureNamespace(store, clusterId, spec.namespace);

  // Sequential: later objects reference earlier ones by name.
  for (const manifest of allManifests(spec, password, `${ Date.now() }`)) {
    await create(store, clusterId, manifest);
  }
}

/**
 * Jobs are immutable, so a rebuild is a fresh Job. The old one is removed first
 * to keep the namespace tidy; nginx keeps serving the previous bundle until the
 * new build stages its swap, so this is zero-downtime.
 */
export async function rebuildUi(store: any, clusterId: string, spec: DevEnvSpec): Promise<void> {
  const jobs = await list(store, clusterId, ENDPOINTS.job, spec.namespace);

  for (const job of jobs?.data || []) {
    if (job.metadata?.labels?.[LABEL_NAME] === spec.name) {
      await remove(store, clusterId, ENDPOINTS.job, spec.namespace, job.metadata.name);
    }
  }

  await create(store, clusterId, buildJobManifest(spec, `${ Date.now() }`));
}

/**
 * Give the target cluster a default StorageClass backed by local-path.
 *
 * Cluster-wide infrastructure, not part of any environment, so it is created
 * separately and never torn down with one. Objects that already exist are
 * skipped rather than treated as failures, so this is safe to re-run -- a
 * half-finished previous attempt should be completable, not a dead end.
 */
export async function installLocalPathStorage(store: any, clusterId: string): Promise<void> {
  for (const manifest of localPathManifests()) {
    try {
      await create(store, clusterId, manifest);
    } catch (e: any) {
      const message = e?.message || '';

      if (!/already exists/i.test(message)) {
        throw e;
      }
    }
  }
}

/** Every kind an environment owns, in reverse dependency order. */
const OWNED_ENDPOINTS = [
  ENDPOINTS.job,
  ENDPOINTS.ingress,
  ENDPOINTS.deployment,
  ENDPOINTS.service,
  ENDPOINTS.persistentvolumeclaim,
  ENDPOINTS.secret,
  ENDPOINTS.configmap,
];

export async function deleteEnvironment(store: any, clusterId: string, spec: DevEnvSpec): Promise<void> {
  for (const endpoint of OWNED_ENDPOINTS) {
    const res = await list(store, clusterId, endpoint, spec.namespace);

    for (const obj of res?.data || []) {
      // dev-envs-config holds the whole cluster's discovered defaults and is
      // shared by every environment, so it is never one environment's to
      // delete. It carries no owner label today, which would be enough on its
      // own -- this is belt and braces, because losing it silently breaks
      // prefill for everyone on the cluster.
      if (obj.metadata?.name === CONFIG_MAP_NAME) {
        continue;
      }

      if (obj.metadata?.labels?.[LABEL_NAME] === spec.name) {
        await remove(store, clusterId, endpoint, spec.namespace, obj.metadata.name);
      }
    }
  }
}
