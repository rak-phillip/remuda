import { LABEL_NAME, INCOMPLETE_AFTER_MS } from './constants';
import type { BuildState, RemudaSpec } from '../types';

/** State of an environment's most recent build Job. */
export function buildStateOf(jobs: any[], name: string): BuildState {
  const mine = jobs.filter((j) => j.metadata?.labels?.[LABEL_NAME] === name);

  if (!mine.length) {
    return 'unknown';
  }

  // Newest first, so a rebuild's state wins over the build it replaced.
  const latest = mine.sort((a, b) => (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || ''))[0];

  if (latest.status?.succeeded) {
    return 'ready';
  }

  return latest.status?.failed ? 'failed' : 'building';
}

/**
 * An environment whose record exists but whose workload was never created.
 *
 * `createEnvironment` writes its manifests in order and does not roll back, and
 * the ConfigMap record is written *first*. So a create that fails partway --
 * most commonly on a PVC whose predecessor is still terminating -- leaves the
 * record behind with nothing running under it, and the environment then shows in
 * the list looking like one that is merely still starting.
 *
 * The backend Deployment is the marker because it is written ninth of twelve:
 * present means the create got far enough to matter, absent means it did not.
 *
 * The age check is what stops a healthy create being labelled incomplete during
 * the second or so between the record and the Deployment being written. Rolling
 * back instead was considered and rejected: a rollback that itself fails leaves
 * the user worse off than a row they can see and delete.
 */
export function isIncomplete(spec: RemudaSpec, hasBackend: boolean, now: number = Date.now()): boolean {
  if (hasBackend) {
    return false;
  }

  const created = Date.parse(spec.createdAt || '');

  // Unreadable timestamp: say nothing rather than accuse a healthy environment.
  if (isNaN(created)) {
    return false;
  }

  return now - created > INCOMPLETE_AFTER_MS;
}
