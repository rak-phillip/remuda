import {
  CONFIG_MAP_NAME, REMUDA_NS, ENDPOINTS, HOST_CLUSTER_ID, LABEL_NAME,
} from './constants';
import { allManifests, buildJobManifest, namespaceManifest } from './manifests';
import { localPathManifests } from './storage';
import { hopEndpointSlice, hopManifests, hopName } from './hop';
import type { IngressEntry, RemudaSpec, ManifestRequest } from '../types';

const base = (clusterId: string) => `/k8s/clusters/${ clusterId }/v1`;

/**
 * Steve silently ignores `labelSelector` -- a nonsense selector still returns
 * every object -- but honours its own `filter=`. Everything therefore lives in
 * one namespace and is queried by namespace, not by label.
 */
export function collectionUrl(clusterId: string, endpoint: string, namespace = REMUDA_NS): string {
  return `${ base(clusterId) }/${ endpoint }?filter=metadata.namespace=${ namespace }`;
}

export const resourceUrl = (clusterId: string, endpoint: string, namespace: string, name: string): string => `${ base(clusterId) }/${ endpoint }/${ namespace }/${ name }`;

export function list(store: any, clusterId: string, endpoint: string, namespace = REMUDA_NS): Promise<any> {
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

export async function ensureNamespace(store: any, clusterId: string, namespace = REMUDA_NS): Promise<void> {
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
export async function readEnvironments(store: any, clusterId: string): Promise<RemudaSpec[]> {
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
  store: any, clusterId: string, spec: RemudaSpec, password: string
): Promise<void> {
  await ensureNamespace(store, clusterId, spec.namespace);

  // Sequential: later objects reference earlier ones by name.
  for (const manifest of allManifests(spec, password, `${ Date.now() }`)) {
    await create(store, clusterId, manifest);
  }

  await createHop(store, spec);
}

/**
 * Front a downstream environment from the host cluster.
 *
 * Skipped entirely for a `local` target, where the environment's own Ingress is
 * already on the cluster the wildcard resolves to and a second one would just
 * collide with it.
 */
export async function createHop(store: any, spec: RemudaSpec): Promise<void> {
  const manifests = hopManifests(spec);

  if (!manifests.length) {
    return;
  }

  await ensureNamespace(store, HOST_CLUSTER_ID, spec.namespace);

  for (const manifest of manifests) {
    await create(store, HOST_CLUSTER_ID, manifest);
  }
}

/**
 * Re-point a hop whose downstream addresses have changed.
 *
 * Only the EndpointSlice is rewritten -- the Service, Ingress and
 * ServersTransport describe topology that does not drift. Read-before-write
 * because Steve rejects an update carrying no resourceVersion, the same trap
 * saveDefaults() documents.
 *
 * The freshly resolved entry is passed in rather than looked up here: the caller
 * has already read it to notice the drift, and discovery.ts imports this module,
 * so reaching back into it would make the two circular.
 */
export async function resyncHop(store: any, spec: RemudaSpec, entry: IngressEntry): Promise<boolean> {
  const hop = spec.hop;

  if (!hop || !entry?.addresses?.length) {
    return false;
  }

  const next: RemudaSpec = { ...spec, hop: { ...hop, ...entry } };
  const manifest = hopEndpointSlice(next);

  if (!manifest) {
    return false;
  }

  const url = resourceUrl(HOST_CLUSTER_ID, ENDPOINTS.endpointslice, spec.namespace, hopName(spec));
  let existing: any;

  try {
    existing = await store.dispatch('management/request', { url });
  } catch {
    existing = undefined;
  }

  if (!existing) {
    await create(store, HOST_CLUSTER_ID, manifest);

    return true;
  }

  await store.dispatch('management/request', {
    url,
    method: 'PUT',
    data:   {
      ...manifest.body,
      metadata: { ...manifest.body.metadata, resourceVersion: existing.metadata?.resourceVersion },
    },
  });

  return true;
}

/**
 * The addresses the hop is *actually* sending traffic to right now.
 *
 * Read from the EndpointSlice rather than from the recorded spec, because that
 * object is the one in the traffic path and the only one that can be wrong on
 * its own -- edited by hand, or left behind by a half-finished write.
 */
export async function hopAddresses(store: any, spec: RemudaSpec): Promise<string[]> {
  if (!spec.hop) {
    return [];
  }

  try {
    const slice = await store.dispatch('management/request', { url: resourceUrl(HOST_CLUSTER_ID, ENDPOINTS.endpointslice, spec.namespace, hopName(spec)) });

    return (slice?.endpoints || []).flatMap((e: any) => e.addresses || []);
  } catch {
    return [];
  }
}

/**
 * Whether some environment already claims this hostname on the host cluster.
 *
 * Every hostname comes off one wildcard, so they are unique across all target
 * clusters at once -- two environments of the same name on different clusters
 * would produce two Ingresses for the same host, and only one of them would
 * ever be matched. The host cluster is the right place to ask, because that is
 * where both a `local` environment's own Ingress and a downstream environment's
 * hop Ingress end up.
 *
 * A failed lookup reports "not taken": this is a courtesy check, and it should
 * not block a create on a permission the user may simply not have.
 */
export async function hostnameTaken(store: any, hostname: string): Promise<boolean> {
  if (!hostname) {
    return false;
  }

  try {
    const res = await list(store, HOST_CLUSTER_ID, ENDPOINTS.ingress);

    return (res?.data || []).some(
      (ing: any) => (ing?.spec?.rules || []).some((r: any) => r?.host === hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Jobs are immutable, so a rebuild is a fresh Job. The old one is removed first
 * to keep the namespace tidy; nginx keeps serving the previous bundle until the
 * new build stages its swap, so this is zero-downtime.
 */
export async function rebuildUi(store: any, clusterId: string, spec: RemudaSpec): Promise<void> {
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
  // Pods are swept explicitly, and must go before the PVCs they mount.
  //
  // Deleting a Job through the API leaves its pods behind: batch/v1 defaults to
  // Orphan propagation, so a completed build pod survives with no owner and
  // nothing will ever collect it. It still references the ui and cache claims,
  // so kubernetes.io/pvc-protection then blocks those PVCs from finalising --
  // permanently, not just slowly. The environment's name stays unusable, with
  // `object is being deleted: persistentvolumeclaims "<name>-ui" already exists`
  // on every attempt to recreate it.
  ENDPOINTS.pod,
  ENDPOINTS.ingress,
  ENDPOINTS.deployment,
  ENDPOINTS.service,
  ENDPOINTS.persistentvolumeclaim,
  ENDPOINTS.secret,
  ENDPOINTS.configmap,
];

/**
 * What a downstream environment owns on the *host* cluster.
 *
 * Sweeping these is not optional tidiness: hostnames come off a single wildcard
 * and so are unique across every target cluster, which means a leaked hop
 * Ingress permanently blocks re-creating an environment of the same name.
 */
const HOP_ENDPOINTS = [
  ENDPOINTS.ingress,
  ENDPOINTS.endpointslice,
  ENDPOINTS.service,
  ENDPOINTS.serverstransport,
];

export async function deleteEnvironment(store: any, clusterId: string, spec: RemudaSpec): Promise<void> {
  if (clusterId !== HOST_CLUSTER_ID) {
    await sweep(store, HOST_CLUSTER_ID, spec, HOP_ENDPOINTS);
  }

  await sweep(store, clusterId, spec, OWNED_ENDPOINTS);
}

async function sweep(store: any, clusterId: string, spec: RemudaSpec, endpoints: string[]): Promise<void> {
  for (const endpoint of endpoints) {
    let res: any;

    try {
      res = await list(store, clusterId, endpoint, spec.namespace);
    } catch {
      // A kind that does not exist on this cluster -- ServersTransport without
      // traefik, say -- has nothing to delete and is not a failed delete.
      continue;
    }

    for (const obj of res?.data || []) {
      // remuda-config holds the whole cluster's discovered defaults and is
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
