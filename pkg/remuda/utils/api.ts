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

/** A cluster-scoped resource, which has no namespace segment at all. */
export const clusterResourceUrl = (clusterId: string, endpoint: string, name: string): string => `${ base(clusterId) }/${ endpoint }/${ name }`;

export function list(store: any, clusterId: string, endpoint: string, namespace = REMUDA_NS): Promise<any> {
  return store.dispatch('management/request', { url: collectionUrl(clusterId, endpoint, namespace) });
}

export function create(store: any, clusterId: string, { endpoint, body }: ManifestRequest): Promise<any> {
  return store.dispatch('management/request', {
    url: `${ base(clusterId) }/${ endpoint }`, method: 'POST', data: body,
  });
}

/**
 * Delete one object.
 *
 * `cascade` matters for anything with dependents, and Jobs above all: batch/v1
 * defaults to **Orphan** propagation, so a plain delete takes the Job and leaves
 * its pods behind with no owner and nothing left to collect them. Steve passes
 * the policy through to the API server -- measured, both ways -- so this is the
 * whole fix wherever a Job is deleted and its pods are not swept separately.
 */
export function remove(
  store: any, clusterId: string, endpoint: string, namespace: string, name: string, cascade = false
): Promise<any> {
  const url = `${ resourceUrl(clusterId, endpoint, namespace, name) }${ cascade ? '?propagationPolicy=Background' : '' }`;

  return store.dispatch('management/request', { url, method: 'DELETE' });
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

/**
 * Create one manifest, treating "already exists" as success.
 *
 * For the objects an environment shares with its neighbours rather than owns --
 * today just the mirrored Issuer, which is one per namespace. The second
 * environment in a namespace would otherwise abort its whole create on the
 * Issuer that the first one quite correctly left behind.
 */
async function createShared(store: any, clusterId: string, manifest: ManifestRequest): Promise<void> {
  try {
    await create(store, clusterId, manifest);
  } catch (e: any) {
    if (!/already exists/i.test(e?.message || '')) {
      throw e;
    }
  }
}

/** Kinds that belong to the namespace rather than to one environment. */
const SHARED_ENDPOINTS: string[] = [ENDPOINTS.issuer];

export async function createEnvironment(
  store: any, clusterId: string, spec: RemudaSpec, password: string
): Promise<void> {
  await ensureNamespace(store, clusterId, spec.namespace);

  // Sequential: later objects reference earlier ones by name.
  for (const manifest of allManifests(spec, password, `${ Date.now() }`)) {
    if (SHARED_ENDPOINTS.includes(manifest.endpoint)) {
      await createShared(store, clusterId, manifest);
    } else {
      await create(store, clusterId, manifest);
    }
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
    if (SHARED_ENDPOINTS.includes(manifest.endpoint)) {
      await createShared(store, HOST_CLUSTER_ID, manifest);
    } else {
      await create(store, HOST_CLUSTER_ID, manifest);
    }
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
 * Whether some environment already claims this hostname.
 *
 * Two clusters are asked, because a hostname can land on either. The host
 * cluster carries a `local` environment's own Ingress and a downstream one's
 * hop Ingress, and while those all come off a single wildcard they are unique
 * across every target cluster at once -- two environments of the same name
 * would produce two Ingresses for one host, and only one would ever match.
 *
 * A directly-exposed environment writes nothing to the host cluster at all, so
 * its hostname is only visible on the cluster it runs on. That is where a
 * collision between two of them happens, and asking only the host would report
 * a name free that the create is about to fail on.
 *
 * A failed lookup reports "not taken": this is a courtesy check, and it should
 * not block a create on a permission the user may simply not have.
 */
export async function hostnameTaken(store: any, hostname: string, clusterId?: string): Promise<boolean> {
  if (!hostname) {
    return false;
  }

  const clusters = [HOST_CLUSTER_ID, ...(clusterId && clusterId !== HOST_CLUSTER_ID ? [clusterId] : [])];

  const claimed = await Promise.all(clusters.map(async(id) => {
    try {
      const res = await list(store, id, ENDPOINTS.ingress);

      return (res?.data || []).some(
        (ing: any) => (ing?.spec?.rules || []).some((r: any) => r?.host === hostname)
      );
    } catch {
      return false;
    }
  }));

  return claimed.some(Boolean);
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
      // Cascading: nothing sweeps this Job's pods afterwards the way
      // deleteEnvironment's does, so without it every rebuild strands the
      // previous build's pod -- still holding the ui and cache claims it
      // mounted, which is what makes a stranded build pod expensive.
      await remove(store, clusterId, ENDPOINTS.job, spec.namespace, job.metadata.name, true);
    }
  }

  await create(store, clusterId, buildJobManifest(spec, `${ Date.now() }`));
}

/**
 * Stop or start an environment by scaling both of its Deployments.
 *
 * Everything else is deliberately left in place -- the PVCs, the Services, the
 * Ingress and the hop. A stopped environment therefore keeps its data, its
 * hostname and its bootstrap password, and gives back only what actually costs
 * something while idle: the backend's CPU and memory, and the node the RWO
 * volumes pin its pods to. Its URL answers 503 until it is started again.
 *
 * Order matters in one direction only. nginx comes up first on a start so the
 * bundle is already being served by the time the backend fetches
 * ui-dashboard-index; that fetch is not a one-shot (see CATTLE_UI_OFFLINE_PREFERRED
 * in manifests.ts), so this is politeness rather than a race, but it costs
 * nothing. On a stop the backend goes first, because it is the one holding the
 * volume and the memory.
 */
export async function setEnvironmentRunning(
  store: any, clusterId: string, spec: RemudaSpec, running: boolean
): Promise<void> {
  const names = [spec.name, `${ spec.name }-ui`];

  for (const name of running ? [...names].reverse() : names) {
    await scaleDeployment(store, clusterId, spec.namespace, name, running ? 1 : 0);
  }
}

/**
 * Read-modify-write rather than a scale subresource: Steve exposes neither
 * `/scale` nor a usable PATCH here, and rejects an update that carries no
 * resourceVersion -- the same constraint resyncHop() works around.
 *
 * A Deployment that cannot be read is skipped rather than treated as a failure.
 * An incomplete environment is missing one or both of them by definition, and
 * stopping the half that does exist is still the useful outcome. A failed
 * *write* is not swallowed, because that is the case where the user is told the
 * environment stopped and it did not.
 */
async function scaleDeployment(
  store: any, clusterId: string, namespace: string, name: string, replicas: number
): Promise<void> {
  const url = resourceUrl(clusterId, ENDPOINTS.deployment, namespace, name);
  let existing: any;

  try {
    existing = await store.dispatch('management/request', { url });
  } catch {
    return;
  }

  if (!existing || existing.spec?.replicas === replicas) {
    return;
  }

  await store.dispatch('management/request', {
    url,
    method: 'PUT',
    data:   { ...existing, spec: { ...existing.spec, replicas } },
  });
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

/**
 * Every kind an environment owns, in reverse dependency order.
 *
 * ENDPOINTS.issuer is deliberately absent. The mirrored Issuer is one per
 * namespace and shared by every environment in it, exactly like remuda-config,
 * so deleting one environment must not take it with them.
 */
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
