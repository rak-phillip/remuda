export const PRODUCT_NAME = 'remuda';
export const BLANK_CLUSTER = '_';

/** Namespace that holds every dev environment on a given host cluster. */
export const REMUDA_NS = 'rancher-remuda';

/** ConfigMap holding the per-cluster defaults discovered on first create. */
export const CONFIG_MAP_NAME = 'remuda-config';

export const LABEL_MANAGED = 'remuda.rancher.io/managed';
export const LABEL_NAME = 'remuda.rancher.io/name';
export const LABEL_OWNER = 'remuda.rancher.io/owner';
export const LABEL_ROLE = 'remuda.rancher.io/role';

/**
 * Recorded on the hop objects so the host cluster is self-describing.
 *
 * The environment's own record lives in a ConfigMap on the *target* cluster, so
 * anything reconciling the hop from the host cluster -- the Detail page's poll
 * today, a controller later -- would otherwise need a second cluster's
 * credentials just to learn where to point.
 */
export const LABEL_TARGET_CLUSTER = 'remuda.rancher.io/target-cluster';
export const LABEL_ENTRY_PORT = 'remuda.rancher.io/entry-port';

export const ROLE_BACKEND = 'backend';
export const ROLE_UI = 'ui';
export const ROLE_BUILD = 'build';
export const ROLE_HOP = 'hop';

/**
 * The cluster the wildcard DNS record actually points at, which is the Rancher
 * serving this extension. Environments on any other cluster are fronted from
 * here -- see utils/hop.ts.
 */
export const HOST_CLUSTER_ID = 'local';

/**
 * Path the built dashboard bundle is served under. The bundle is built into a
 * directory of this name so nginx resolves it with no rewrite rule, and it is
 * baked into the bundle's asset URLs via RESOURCE_BASE.
 */
export const UI_BUNDLE_PATH = 'ui-bundle';

export const BUILD_IMAGE = 'node:24';
export const SERVE_IMAGE = 'nginx:alpine';

export const DEFAULT_BACKEND_IMAGE = 'rancher/rancher:head';

/** Registries a Rancher server image is commonly pulled from. */
export const BACKEND_IMAGE_SOURCES = [
  { label: 'Docker Hub (community)', value: 'docker.io/rancher/rancher' },
  { label: 'Prime staging', value: 'stgregistry.suse.com/rancher/rancher' },
];

/**
 * The single-container backend image runs its own k3s inside the pod, and that
 * k3s defaults to the same CIDRs as any other k3s -- which is exactly what the
 * host cluster is most likely using. Both clusters' routes and iptables rules
 * then land in one network namespace, and nested pods stop being able to reach
 * their own CoreDNS. Nothing else in the environment recovers from that.
 *
 * These are the pairs to hand the nested k3s instead, tried in order and each
 * skipped if it overlaps whatever the host cluster turns out to use.
 */
export const NESTED_CIDR_CANDIDATES = [
  { podCidr: '10.44.0.0/16', serviceCidr: '10.45.0.0/16' },
  { podCidr: '10.46.0.0/16', serviceCidr: '10.47.0.0/16' },
  { podCidr: '10.48.0.0/16', serviceCidr: '10.49.0.0/16' },
  { podCidr: '172.30.0.0/16', serviceCidr: '172.31.0.0/16' },
] as const;

/** Used when the host cluster's own CIDRs could not be read. */
export const DEFAULT_NESTED_POD_CIDR = NESTED_CIDR_CANDIDATES[0].podCidr;
export const DEFAULT_NESTED_SERVICE_CIDR = NESTED_CIDR_CANDIDATES[0].serviceCidr;

/** Where the k3s binary looks for its config file, absent --config. */
export const K3S_CONFIG_PATH = '/etc/rancher/k3s/config.yaml';

/**
 * inotify limits to raise on the node before a backend starts.
 *
 * fs.inotify.* is counted per-uid across the whole host and is not namespaced,
 * so every nested k3s on a node draws from one budget -- and each of them runs
 * an apiserver, a kubelet and a containerd that all want watches. The stock
 * max_user_instances of 128 is spent quickly, and what fails is the nested
 * containerd's CRI plugin ("failed to create fsnotify watcher: too many open
 * files"), which leaves the nested cluster with no node at all and every pod in
 * it Pending. Because the limit is host-global, this gets worse the more
 * environments a node carries, which is what made it look intermittent.
 */
export const INOTIFY_LIMITS = {
  'fs.inotify.max_user_instances': 8192,
  'fs.inotify.max_user_watches':   524288,
} as const;

/**
 * Fallback storage for a cluster that provisions none of its own.
 *
 * k3s ships local-path-provisioner; RKE2 and most imported clusters do not, and
 * an environment cannot work without *some* StorageClass -- its three PVCs never
 * bind and the build pod is never scheduled. Node-local storage also happens to
 * suit this workload: the bundle PVC is ReadWriteOnce and is written by the
 * build Job then read by nginx, so both pods have to land on one node anyway.
 */
export const LOCAL_PATH = {
  namespace:      'local-path-storage',
  storageClass:   'local-path',
  provisioner:    'rancher.io/local-path',
  serviceAccount: 'local-path-provisioner-service-account',
  image:          'rancher/local-path-provisioner:v0.0.35',
  helperImage:    'busybox:1.37',
  /** Where volumes are written on the node. */
  hostPath:       '/opt/local-path-provisioner',
} as const;

/**
 * How long after an environment is recorded its backend Deployment may be
 * missing before the environment is called incomplete. Generous on purpose: the
 * create writes twelve objects in sequence, and a slow cluster should not make a
 * healthy environment look broken.
 */
export const INCOMPLETE_AFTER_MS = 2 * 60 * 1000;

export const DEFAULT_DATA_SIZE_GB = 20;
export const DEFAULT_UI_SIZE_GB = 2;
export const DEFAULT_CACHE_SIZE_GB = 8;

/**
 * How much of a repository's branch list to fetch, all at once, up front.
 *
 * Ten pages of 100 rather than one, because substring matching can only ever
 * find what has actually been fetched. GitHub's REST API has no substring search
 * -- matching-refs takes a prefix, and the GraphQL `refs(query:)` that does the
 * real thing answers 403 unauthenticated -- so the only way to match "17295"
 * against "task/17295-multi-idp" is to hold the whole list and filter it here.
 *
 * The cost is paid once per repository, not per keystroke: 495 branches (the
 * largest real case measured) is 5 of the 60 hourly requests, and filtering
 * afterwards is instant and offline. A repository past the cap falls back to the
 * prefix search below.
 */
export const GITHUB_PER_PAGE = 100;
export const GITHUB_BRANCH_PAGES = 10;

/**
 * Shortest branch prefix worth sending to GitHub.
 *
 * Only used for a repository whose branch list was truncated at the cap above;
 * anything smaller is filtered locally. Guards two things: the rate limit, and
 * the fact that an empty ref makes matching-refs return every ref in the
 * repository.
 */
export const GITHUB_BRANCH_SEARCH_MIN = 2;

/** How long to wait after the last keystroke before asking GitHub anything. */
export const GITHUB_DEBOUNCE_MS = 600;

/** Steve endpoints, keyed by the shell's type constants. */
export const ENDPOINTS = {
  namespace:             'namespaces',
  pod:                   'pods',
  node:                  'nodes',
  configmap:             'configmaps',
  secret:                'secrets',
  persistentvolumeclaim: 'persistentvolumeclaims',
  service:               'services',
  deployment:            'apps.deployments',
  job:                   'batch.jobs',
  ingress:               'networking.k8s.io.ingresses',
  ingressclass:          'networking.k8s.io.ingressclasses',
  storageclass:          'storage.k8s.io.storageclasses',
  serviceaccount:        'serviceaccounts',
  clusterrole:           'rbac.authorization.k8s.io.clusterroles',
  clusterrolebinding:    'rbac.authorization.k8s.io.clusterrolebindings',
  role:                  'rbac.authorization.k8s.io.roles',
  rolebinding:           'rbac.authorization.k8s.io.rolebindings',
  clusterissuer:         'cert-manager.io.clusterissuers',
  daemonset:             'apps.daemonsets',
  endpointslice:         'discovery.k8s.io.endpointslices',
  serverstransport:      'traefik.io.serverstransports',
} as const;
