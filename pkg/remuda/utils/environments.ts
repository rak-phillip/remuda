import {
  ENDPOINTS, ENVIRONMENT_API_VERSION, ENVIRONMENT_KIND, HOST_CLUSTER_ID, LABEL_NAME,
  REMUDA_NS,
} from './constants';
import {
  create, deleteEnvironment, ensureNamespace, list, readEnvironments, remove, resourceUrl,
  setEnvironmentRunning,
} from './api';
import type {
  BuildState, EnvironmentCR, EnvironmentRecord, RemudaSpec, RunState,
} from '../types';

/**
 * The whole compatibility boundary between the two provisioning paths.
 *
 * Environments created from 0.3.0 onwards are Environment custom resources
 * built by remuda-controller. Environments created before that are ConfigMap
 * records whose objects the browser wrote itself. Both remain listable,
 * openable, startable, stoppable and deletable; only creation moved.
 *
 * Everything that knows the difference lives here, so retiring the old path is
 * a matter of deleting the `legacy` branches in this file and the modules they
 * call, rather than unpicking provenance checks from across the pages.
 */

/**
 * Fold a CR into the shape the pages already render.
 *
 * `status.resolved` wins over `spec` because it is what the environment was
 * actually built with: an unpinned field is absent from spec entirely, and a
 * pinned one is echoed back unchanged, so resolved is never the weaker answer.
 */
export function specFromCr(cr: EnvironmentCR): RemudaSpec {
  const resolved = cr.status?.resolved || {};

  return {
    ...cr.spec,
    ...resolved,
    name:      cr.metadata.name,
    namespace: cr.metadata.namespace || REMUDA_NS,
    createdAt: cr.metadata.creationTimestamp || '',
    owner:     cr.spec.owner || resolved.owner || '',
  } as RemudaSpec;
}

/** The controller's build vocabulary in the UI's terms. */
export function crBuildState(cr: EnvironmentCR): BuildState {
  switch (cr.status?.build) {
  case 'Ready': return 'ready';
  case 'Failed': return 'failed';
  case 'Building': return 'building';
  default: return 'unknown';
  }
}

/** The controller's run vocabulary in the UI's terms. */
export function crRunState(cr: EnvironmentCR): RunState {
  switch (cr.status?.run) {
  case 'Ready': return 'ready';
  case 'Stopped': return 'stopped';
  case 'Stopping': return 'stopping';
  default: return 'pending';
  }
}

/**
 * Every environment on a cluster, from both records, newest first.
 *
 * A CR-backed environment writes no ConfigMap record, and a legacy one has no
 * CR, so the two sets cannot overlap -- but they are keyed by name anyway. A
 * name collision would mean someone hand-wrote a CR over a legacy environment,
 * and the CR is the better answer in that case because it is the one something
 * is actively reconciling.
 */
export async function listEnvironments(store: any, clusterId: string): Promise<EnvironmentRecord[]> {
  // A legacy record lives on the cluster its environment runs on; a CR always
  // lives on the host, whatever `spec.clusterId` targets. So the CRs are read
  // once, on the host pass, rather than once per cluster -- and a caller
  // walking every cluster gets each environment exactly once.
  const [crs, legacy] = await Promise.all([
    clusterId === HOST_CLUSTER_ID ? listEnvironmentCrs(store) : Promise.resolve([]),
    readEnvironments(store, clusterId),
  ]);

  const records: EnvironmentRecord[] = crs.map((cr) => ({
    source: 'cr' as const,
    spec:   specFromCr(cr),
    cr,
  }));

  const claimed = new Set(records.map((r) => r.spec.name));

  for (const spec of legacy) {
    if (!claimed.has(spec.name)) {
      records.push({ source: 'legacy', spec });
    }
  }

  return records.sort((a, b) => (b.spec.createdAt || '').localeCompare(a.spec.createdAt || ''));
}

/**
 * The CRs on a cluster, or none.
 *
 * An absent CRD is the ordinary state of a cluster that has not installed the
 * controller, not an error worth surfacing -- the create form reports that, and
 * a list has nothing useful to say about it.
 */
export async function listEnvironmentCrs(store: any, clusterId = HOST_CLUSTER_ID): Promise<EnvironmentCR[]> {
  try {
    const res = await list(store, clusterId, ENDPOINTS.environment);

    return (res?.data || []) as EnvironmentCR[];
  } catch {
    return [];
  }
}

/** One CR by name, or undefined when it is gone or the CRD is not installed. */
export async function readEnvironmentCr(
  store: any,
  clusterId: string,
  name: string,
  namespace = REMUDA_NS,
): Promise<EnvironmentCR | undefined> {
  try {
    return await store.dispatch('management/request', { url: resourceUrl(clusterId, ENDPOINTS.environment, namespace, name) });
  } catch {
    return undefined;
  }
}

/**
 * Ask for an environment. The controller resolves and builds it.
 *
 * Only what the form actually collected is sent. Every omitted field is either
 * defaulted by the CRD schema or resolved by the controller from the cluster,
 * and a field sent explicitly is *pinned* -- so echoing back a discovered value
 * the user never chose would silently freeze it against a cluster that later
 * changes. The exception is a downstream target, where Fleet delivers but
 * cannot read back, so the four fields it cannot see have to be pinned here.
 */
export function environmentCrBody(spec: Partial<RemudaSpec> & {
  name: string; repo: string; branch: string;
}, opts: { downstream?: boolean } = {}): EnvironmentCR {
  const body: EnvironmentCR = {
    apiVersion: ENVIRONMENT_API_VERSION,
    kind:       ENVIRONMENT_KIND,
    metadata:   {
      name:      spec.name,
      namespace: spec.namespace || REMUDA_NS,
      labels:    { [LABEL_NAME]: spec.name },
    },
    spec: {
      repo:    spec.repo,
      branch:  spec.branch,
      running: true,
    },
  };

  const pin = <K extends keyof RemudaSpec>(key: K) => {
    const value = spec[key];

    if (value !== undefined && value !== '') {
      (body.spec as any)[key] = value;
    }
  };

  // Chosen by the person, so always intent rather than discovery.
  (['clusterId', 'owner', 'backendImage', 'hostname', 'entryPort',
    'dataSizeGb', 'uiSizeGb', 'cacheSizeGb'] as (keyof RemudaSpec)[]).forEach(pin);

  // Fleet delivers without reading back, and the controller can only see the
  // host -- a wrong answer rather than a missing one. See "What a downstream
  // environment must pin" in controller/README.md.
  if (opts.downstream) {
    (['ingressClass', 'storageClass', 'nestedPodCidr',
      'nestedServiceCidr'] as (keyof RemudaSpec)[]).forEach(pin);
  }

  return body;
}

/**
 * Start or stop an environment, whichever record backs it.
 *
 * For a CR this is one field on the spec and the controller does the scaling,
 * in the order that matters -- nginx up before the backend on a start, backend
 * down first on a stop, because it is the one holding the RWO volume. For a
 * legacy environment the browser still scales the two Deployments itself.
 *
 * Read-modify-write rather than PATCH: Steve rejects an update carrying no
 * resourceVersion, which is the same constraint scaleDeployment() works around.
 */
export async function setRecordRunning(
  store: any, clusterId: string, record: EnvironmentRecord, running: boolean,
): Promise<void> {
  if (record.source === 'legacy') {
    return setEnvironmentRunning(store, clusterId, record.spec, running);
  }

  const url = resourceUrl(clusterId, ENDPOINTS.environment, record.spec.namespace, record.spec.name);
  const existing = await store.dispatch('management/request', { url });

  if (existing?.spec?.running === running) {
    return;
  }

  await store.dispatch('management/request', {
    url,
    method: 'PUT',
    data:   { ...existing, spec: { ...existing.spec, running } },
  });
}

/**
 * Delete an environment, whichever record backs it.
 *
 * The two are genuinely different operations rather than two spellings of one.
 * Deleting a CR removes one object and Kubernetes garbage-collects the rest
 * through owner references, which also avoids the pvc-protection deadlock the
 * old sweep was written to work around. A legacy environment has no owner
 * references at all, so its objects have to be swept by label -- build pods
 * before the PVCs they mount, or the PVCs stay Terminating forever.
 */
export async function deleteRecord(
  store: any, clusterId: string, record: EnvironmentRecord,
): Promise<void> {
  if (record.source === 'legacy') {
    return deleteEnvironment(store, clusterId, record.spec);
  }

  await remove(store, clusterId, ENDPOINTS.environment, record.spec.namespace, record.spec.name);
}

/**
 * Ask for a fresh UI build.
 *
 * The CR path has no equivalent yet -- the controller starts the first build
 * and never another, with status.buildId as the hook -- so this reports that
 * rather than pretending. See the rebuild-trigger item in controller/README.md.
 */
export function canRebuild(record: EnvironmentRecord): boolean {
  return record.source === 'legacy';
}

/**
 * A CR whose objects do not exist, which is the same thing the legacy
 * isIncomplete() heuristic reports about a ConfigMap with no workload.
 *
 * The controller says so directly rather than being inferred from a missing
 * Deployment: a false Resolved means it could not work out what to build, and a
 * false Provisioned means it tried and could not. Both leave a record with
 * nothing behind it, which is what the list warns about.
 */
export function crIncomplete(cr: EnvironmentCR): boolean {
  const failed = (type: string) => cr.status?.conditions
    ?.some((c) => c.type === type && c.status === 'False');

  return !!(failed('Resolved') || failed('Provisioned'));
}

/**
 * Create an environment by asking for one.
 *
 * **The CR always lands on the host cluster**, whatever cluster the environment
 * itself will run on. That is the one place the old path and this one genuinely
 * disagree: the browser used to write an environment's objects straight to the
 * target, whereas the controller runs on the host, reads Environments with its
 * in-cluster client, and reaches a downstream cluster through a Fleet Bundle.
 * Creating the CR on the target would put it somewhere nothing is watching.
 *
 * No password is generated here either -- the controller mints one into
 * `status.bootstrapSecret`, so the browser never handles the credential.
 */
export async function createEnvironmentCr(
  store: any, spec: RemudaSpec,
): Promise<EnvironmentCR> {
  await ensureNamespace(store, HOST_CLUSTER_ID, spec.namespace || REMUDA_NS);

  const body = environmentCrBody(spec, { downstream: spec.clusterId !== HOST_CLUSTER_ID });

  return create(store, HOST_CLUSTER_ID, { endpoint: ENDPOINTS.environment, body } as any);
}

/**
 * One environment by name, from whichever record holds it.
 *
 * The CR is looked for on the **host** cluster and the ConfigMap on the cluster
 * the environment runs on, because that is where each actually lives -- see
 * createEnvironmentCr(). The workload objects are on the target cluster either
 * way, so a caller still reads those from `clusterId`.
 */
export async function findEnvironment(
  store: any, clusterId: string, name: string,
): Promise<EnvironmentRecord | undefined> {
  const cr = await readEnvironmentCr(store, HOST_CLUSTER_ID, name);

  if (cr?.metadata?.name) {
    return {
      source: 'cr', spec: specFromCr(cr), cr
    };
  }

  const specs = await readEnvironments(store, clusterId);
  const spec = specs.find((s) => s.name === name);

  return spec ? { source: 'legacy', spec } : undefined;
}
