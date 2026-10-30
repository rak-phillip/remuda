import { list } from './api';
import {
  ENDPOINTS, LABEL_NAME, LABEL_ROLE, ROLE_BACKEND, ROLE_BUILD
} from './constants';
import type { RemudaSpec } from '../types';

/** Which of an environment's pods to read, and the container that matters in it. */
export const LOG_SOURCES = {
  backend: { role: ROLE_BACKEND, container: 'rancher' },
  build:   { role: ROLE_BUILD, container: 'build' },
};

export type LogSource = keyof typeof LOG_SOURCES;

/**
 * The newest pod of one role. Older ones are evicted or superseded leftovers,
 * and the newest is the one that says what is happening now.
 */
export function newestPod(pods: any[], name: string, role: string): any | undefined {
  return pods
    .filter((pod) => pod.metadata?.labels?.[LABEL_NAME] === name && pod.metadata?.labels?.[LABEL_ROLE] === role)
    .sort((a, b) => (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || ''))[0];
}

/**
 * Open a pod's logs in Rancher's own log window, the one the Pod page uses.
 *
 * ContainerLogs asks only for a pod shaped thing, so it does not need the pod in
 * the store -- and it cannot be there: these pages live outside any cluster, and
 * the environment may be on a different one from the host. The pod comes straight
 * from the cluster's API, whose links.view already addresses that cluster.
 *
 * Read on click rather than on every poll: nobody needs the list until they ask,
 * and it is one more request per cluster every fifteen seconds otherwise.
 *
 * Resolves false when there is no pod to read. A finished build's pod goes when
 * the next build sweeps it, and a retired build's goes with its Job.
 */
export async function openLogs(store: any, clusterId: string, spec: RemudaSpec, source: LogSource): Promise<boolean> {
  const { role, container } = LOG_SOURCES[source];
  const pods = await list(store, clusterId, ENDPOINTS.pod, spec.namespace);
  const pod = newestPod(pods?.data || [], spec.name, role);

  if (!pod?.links?.view) {
    return false;
  }

  await store.dispatch('wm/open', {
    id:        `${ clusterId }/${ pod.metadata.name }-logs`,
    label:     pod.metadata.name,
    icon:      'file',
    component: 'ContainerLogs',
    attrs:     {
      pod:              { ...pod, nameDisplay: pod.metadata.name },
      initialContainer: container,
    },
  }, { root: true });

  return true;
}
