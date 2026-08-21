export const PRODUCT_NAME = 'dev-envs';
export const BLANK_CLUSTER = '_';

/** Namespace that holds every dev environment on a given host cluster. */
export const DEV_ENV_NS = 'rancher-dev-envs';

/** ConfigMap holding the per-cluster defaults discovered on first create. */
export const CONFIG_MAP_NAME = 'dev-envs-config';

export const LABEL_MANAGED = 'devenv.rancher.io/managed';
export const LABEL_NAME = 'devenv.rancher.io/name';
export const LABEL_OWNER = 'devenv.rancher.io/owner';
export const LABEL_ROLE = 'devenv.rancher.io/role';

export const ROLE_BACKEND = 'backend';
export const ROLE_UI = 'ui';
export const ROLE_BUILD = 'build';

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

export const DEFAULT_DATA_SIZE_GB = 20;
export const DEFAULT_UI_SIZE_GB = 2;
export const DEFAULT_CACHE_SIZE_GB = 8;

/** Steve endpoints, keyed by the shell's type constants. */
export const ENDPOINTS = {
  namespace:             'namespaces',
  configmap:             'configmaps',
  secret:                'secrets',
  persistentvolumeclaim: 'persistentvolumeclaims',
  service:               'services',
  deployment:            'apps.deployments',
  job:                   'batch.jobs',
  ingress:               'networking.k8s.io.ingresses',
  ingressclass:          'networking.k8s.io.ingressclasses',
  storageclass:          'storage.k8s.io.storageclasses',
  clusterissuer:         'cert-manager.io.clusterissuers',
} as const;
