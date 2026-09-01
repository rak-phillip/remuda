import { ENDPOINTS, ENVIRONMENT_CRD, HOST_CLUSTER_ID } from './constants';
import { clusterResourceUrl, collectionUrl } from './api';

/**
 * Installing remuda-controller from inside the extension.
 *
 * The controller is not optional from 0.2.0 -- it is what builds an environment
 * and what serves the Environment API -- but it ships as a separate chart,
 * because the extension's own chart is regenerated from an upstream template on
 * every publish and cannot carry extra templates.
 *
 * Left to the user that costs a detour out of Remuda into Apps, and on the
 * candidate channel the detour is a dead end: every candidate version is a
 * SemVer pre-release, Apps hides pre-release versions unless the
 * `show-pre-release` preference is on, and a chart with no remaining versions is
 * dropped from the list entirely -- so the repository renders as empty rather
 * than filtered. Installing through the repository's own `install` action skips
 * all of that: it names the chart and version directly and never goes near the
 * catalog's filtering.
 */

/** Where the controller and its CRD are installed. */
export const CONTROLLER_NAMESPACE = 'cattle-remuda-system';
export const CONTROLLER_CHART = 'remuda-controller';

/**
 * The extension's own version, which is the controller version to match.
 *
 * Both ship from one tag, so a candidate extension wants the candidate
 * controller rather than whatever is newest. `require` rather than `import`
 * because that is how the plugin already reads this file in `index.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const EXTENSION_VERSION: string = require('../package.json').version;

const CLUSTER_REPOS = '/v1/catalog.cattle.io.clusterrepos';

export interface ControllerChart {
  /** ClusterRepo holding it. */
  repo: string;
  version: string;
}

/**
 * Whether this cluster can accept an Environment.
 *
 * Probes the CRD rather than the controller's Deployment: the API server
 * accepts a CR the moment the CRD is registered, and a controller that is
 * restarting still reconciles it afterwards. Testing for the Deployment would
 * refuse creates that would have worked.
 */
export async function controllerAvailable(store: any, clusterId = HOST_CLUSTER_ID): Promise<boolean> {
  try {
    const res = await store.dispatch('management/request', { url: clusterResourceUrl(clusterId, ENDPOINTS.customresourcedefinition, ENVIRONMENT_CRD) });

    return !!res?.id;
  } catch {
    return false;
  }
}

/**
 * Whether this user may install it, asked rather than assumed.
 *
 * The chart brings a CRD and cluster-scoped RBAC, so it needs cluster-admin,
 * and plenty of people who use Remuda do not have it. Offering a control that
 * 403s is worse than not offering one: the failure arrives after the click and
 * reads as a broken product rather than as a permission the user never had.
 *
 * SelfSubjectAccessReview answers this for the caller's own token with no
 * special privilege. It has to go through the raw Kubernetes path -- Steve's
 * flattened `authorization.k8s.io.selfsubjectaccessreviews` rejects the POST
 * with a 422, because the resource exists only to be created and never listed.
 */
export async function canInstallController(store: any, clusterId = HOST_CLUSTER_ID): Promise<boolean> {
  try {
    const res = await store.dispatch('management/request', {
      url:    `/k8s/clusters/${ clusterId }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
      method: 'POST',
      data:   {
        apiVersion: 'authorization.k8s.io/v1',
        kind:       'SelfSubjectAccessReview',
        spec:       {
          resourceAttributes: {
            group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions', verb: 'create',
          },
        },
      },
    });

    return !!res?.status?.allowed;
  } catch {
    return false;
  }
}

/**
 * Find remuda-controller in whichever repository the user actually added.
 *
 * Not hardcoded: the repo is named by whoever created it, and the same
 * extension is installed from `remuda`, `remuda-rc` or anything else. The
 * installed extension records no source repository of its own -- only apps
 * installed through the UI carry `ui-source-repo` -- so the indexes are the
 * only place the answer exists.
 *
 * Version is matched to the extension's own before falling back to the newest
 * available, because the two ship from one tag: a candidate extension paired
 * with a stable controller is a version skew nobody asked for.
 */
export async function findControllerChart(store: any): Promise<ControllerChart | undefined> {
  let repos: any[] = [];

  try {
    const res = await store.dispatch('management/request', { url: CLUSTER_REPOS });

    repos = res?.data || [];
  } catch {
    return undefined;
  }

  const indexes = await Promise.all(repos.map(async(repo: any) => {
    const name = repo?.metadata?.name;

    if (!name || !repo?.links?.index) {
      return undefined;
    }

    try {
      const index = await store.dispatch('management/request', { url: `${ CLUSTER_REPOS }/${ name }?link=index` });
      const versions = index?.entries?.[CONTROLLER_CHART];

      return versions?.length ? { repo: name, versions } : undefined;
    } catch {
      return undefined;
    }
  }));

  const found = indexes.filter(Boolean) as { repo: string; versions: any[] }[];

  const exact = found.find((f) => f.versions.some((v) => v.version === EXTENSION_VERSION));

  if (exact) {
    return { repo: exact.repo, version: EXTENSION_VERSION };
  }

  // The index lists newest first, which is what `helm repo index` writes and
  // what every consumer of these indexes already relies on.
  return found.length ? { repo: found[0].repo, version: found[0].versions[0].version } : undefined;
}

/**
 * Install the chart through its repository's own action.
 *
 * The payload is the one the Apps install page sends. `wait` makes Helm hold
 * until the release settles, which matters here because the very next thing
 * that happens is an Environment being created against the CRD this brings.
 */
export async function installController(store: any, chart: ControllerChart): Promise<void> {
  await store.dispatch('management/request', {
    url:    `${ CLUSTER_REPOS }/${ chart.repo }?action=install`,
    method: 'POST',
    data:   {
      charts: [{
        chartName:   CONTROLLER_CHART,
        version:     chart.version,
        releaseName: CONTROLLER_CHART,
        values:      {},
        annotations: {
          'catalog.cattle.io/ui-source-repo':      chart.repo,
          'catalog.cattle.io/ui-source-repo-type': 'cluster',
        },
      }],
      namespace: CONTROLLER_NAMESPACE,
      noHooks:   false,
      timeout:   '600s',
      wait:      true,
    },
  });
}

/**
 * Whether Steve will accept a POST to the Environment collection.
 *
 * A stricter question than controllerAvailable(), and the difference is the
 * whole reason this exists. `apiextensions.k8s.io.customresourcedefinitions` is
 * a schema Steve ships with, so a GET for the CRD *object* starts succeeding the
 * instant the CRD is registered. `remuda.rancher.io.environments` is a schema
 * Steve has to learn, and it only picks new ones up on its own refresh cycle --
 * seconds later. In that gap the CRD is present, the API server is serving the
 * type, and a POST through Steve still 404s.
 *
 * So this asks the collection endpoint the create will actually post to, which
 * cannot answer before Steve is ready to route it.
 */
export async function environmentApiReady(store: any, clusterId = HOST_CLUSTER_ID): Promise<boolean> {
  try {
    await store.dispatch('management/request', { url: collectionUrl(clusterId, ENDPOINTS.environment) });

    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until an Environment can be created, which is the outcome rather than a
 * proxy for it.
 *
 * Deliberately not the Helm operation's own status: a succeeded operation still
 * leaves a window before the new type can be created, and a create in that
 * window fails for a reason the user cannot act on.
 *
 * It used to poll the CRD, on the reasoning that this "closes that window by
 * construction". It closed the *API server's* window. The next step does not
 * talk to the API server -- it talks to Steve, whose window was still open, so
 * the first create on a fresh Rancher failed with a bare 404 every time. See
 * environmentApiReady.
 */
export async function waitForController(
  store: any, { timeoutMs = 120000, intervalMs = 2000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await environmentApiReady(store)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}
