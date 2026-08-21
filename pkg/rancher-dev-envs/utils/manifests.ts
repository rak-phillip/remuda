import {
  DEV_ENV_NS, ENDPOINTS, LABEL_MANAGED, LABEL_NAME, LABEL_OWNER, LABEL_ROLE,
  ROLE_BACKEND, ROLE_BUILD, ROLE_UI, UI_BUNDLE_PATH, BUILD_IMAGE, SERVE_IMAGE,
} from './constants';
import type { DevEnvSpec, ManifestRequest } from '../types';

export const labelsFor = (spec: DevEnvSpec, role?: string): Record<string, string> => ({
  [LABEL_MANAGED]: 'true',
  [LABEL_NAME]:    spec.name,
  [LABEL_OWNER]:   spec.owner,
  ...(role ? { [LABEL_ROLE]: role } : {}),
});

/** Browser-facing. Baked into the bundle's asset URLs at build time. */
export const resourceBase = (spec: DevEnvSpec): string => `https://${ spec.hostname }/${ UI_BUNDLE_PATH }`;

/**
 * Pod-facing. Rancher fetches ui-dashboard-index server-side, so this stays
 * in-cluster over plain HTTP and never depends on hairpinning through the ingress.
 */
export const dashboardIndexUrl = (spec: DevEnvSpec): string => `http://${ spec.name }-ui.${ spec.namespace }.svc.cluster.local/${ UI_BUNDLE_PATH }/index.html`;

export const environmentUrl = (spec: DevEnvSpec): string => `https://${ spec.hostname }`;

const meta = (spec: DevEnvSpec, name: string, role?: string) => ({
  name,
  namespace: spec.namespace,
  labels:    labelsFor(spec, role),
});

export function namespaceManifest(namespace: string = DEV_ENV_NS): ManifestRequest {
  return {
    endpoint: ENDPOINTS.namespace,
    body:     {
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   { name: namespace, labels: { [LABEL_MANAGED]: 'true' } },
    },
  };
}

export function recordManifest(spec: DevEnvSpec): ManifestRequest {
  return {
    endpoint: ENDPOINTS.configmap,
    body:     {
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   meta(spec, spec.name),
      data:       { spec: JSON.stringify(spec, null, 2) },
    },
  };
}

export function bootstrapSecretManifest(spec: DevEnvSpec, password: string): ManifestRequest {
  return {
    endpoint: ENDPOINTS.secret,
    body:     {
      apiVersion: 'v1',
      kind:       'Secret',
      metadata:   meta(spec, `${ spec.name }-bootstrap`),
      type:       'Opaque',
      stringData: { password },
    },
  };
}

function pvcManifest(spec: DevEnvSpec, suffix: string, sizeGb: number, role: string): ManifestRequest {
  return {
    endpoint: ENDPOINTS.persistentvolumeclaim,
    body:     {
      apiVersion: 'v1',
      kind:       'PersistentVolumeClaim',
      metadata:   meta(spec, `${ spec.name }-${ suffix }`, role),
      spec:       {
        accessModes: ['ReadWriteOnce'],
        resources:   { requests: { storage: `${ sizeGb }Gi` } },
        // Omitted entirely when the cluster has no default class, rather than
        // sending an explicit undefined that Steve would reject.
        ...(spec.storageClass ? { storageClassName: spec.storageClass } : {}),
      },
    },
  };
}

export const dataPvcManifest = (spec: DevEnvSpec) => pvcManifest(spec, 'data', spec.dataSizeGb, ROLE_BACKEND);
export const uiPvcManifest = (spec: DevEnvSpec) => pvcManifest(spec, 'ui', spec.uiSizeGb, ROLE_UI);
export const cachePvcManifest = (spec: DevEnvSpec) => pvcManifest(spec, 'cache', spec.cacheSizeGb, ROLE_BUILD);

export function backendDeploymentManifest(spec: DevEnvSpec): ManifestRequest {
  const selector = { [LABEL_NAME]: spec.name, [LABEL_ROLE]: ROLE_BACKEND };

  return {
    endpoint: ENDPOINTS.deployment,
    body:     {
      apiVersion: 'apps/v1',
      kind:       'Deployment',
      metadata:   meta(spec, spec.name, ROLE_BACKEND),
      spec:       {
        replicas: 1,
        selector: { matchLabels: selector },
        // The data PVC is RWO, so the old pod must go before the new one starts.
        strategy: { type: 'Recreate' },
        template: {
          metadata: { labels: labelsFor(spec, ROLE_BACKEND) },
          spec:     {
            // Rancher picks embedded-k3s vs in-cluster mode partly on whether a
            // service account token is mounted. Without this it can try to drive
            // the HOST cluster instead of starting its own k3s.
            automountServiceAccountToken: false,
            containers:                   [{
              name:            'rancher',
              image:           spec.backendImage,
              imagePullPolicy: 'Always',
              args:            ['--no-cacerts', '--http-listen-port=80', '--https-listen-port=443'],
              securityContext: { privileged: true },
              ports:           [{ containerPort: 80, name: 'http' }, { containerPort: 443, name: 'https' }],
              env:             [
                { name: 'CATTLE_UI_OFFLINE_PREFERRED', value: 'false' },
                { name: 'CATTLE_UI_DASHBOARD_INDEX', value: dashboardIndexUrl(spec) },
                {
                  name:      'CATTLE_BOOTSTRAP_PASSWORD',
                  valueFrom: { secretKeyRef: { name: `${ spec.name }-bootstrap`, key: 'password' } },
                },
              ],
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/rancher' }],
              resources:    {
                requests: { cpu: '1', memory: '3Gi' },
                limits:   { cpu: '2', memory: '6Gi' },
              },
            }],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${ spec.name }-data` } }],
          },
        },
      },
    },
  };
}

export function uiDeploymentManifest(spec: DevEnvSpec): ManifestRequest {
  const selector = { [LABEL_NAME]: spec.name, [LABEL_ROLE]: ROLE_UI };

  return {
    endpoint: ENDPOINTS.deployment,
    body:     {
      apiVersion: 'apps/v1',
      kind:       'Deployment',
      metadata:   meta(spec, `${ spec.name }-ui`, ROLE_UI),
      spec:       {
        replicas: 1,
        selector: { matchLabels: selector },
        strategy: { type: 'Recreate' },
        template: {
          metadata: { labels: labelsFor(spec, ROLE_UI) },
          spec:     {
            containers: [{
              name:         'nginx',
              image:        SERVE_IMAGE,
              ports:        [{ containerPort: 80, name: 'http' }],
              // Building into a directory named for the path means /ui-bundle/...
              // resolves straight off nginx's root with no rewrite rule.
              volumeMounts: [{
                name: 'bundle', mountPath: '/usr/share/nginx/html', readOnly: true
              }],
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits:   { cpu: '500m', memory: '256Mi' },
              },
            }],
            volumes: [{
              name:                  'bundle',
              persistentVolumeClaim: { claimName: `${ spec.name }-ui`, readOnly: true },
            }],
          },
        },
      },
    },
  };
}

function serviceManifest(spec: DevEnvSpec, name: string, role: string, ports: any[]): ManifestRequest {
  return {
    endpoint: ENDPOINTS.service,
    body:     {
      apiVersion: 'v1',
      kind:       'Service',
      metadata:   meta(spec, name, role),
      spec:       {
        type:     'ClusterIP',
        selector: { [LABEL_NAME]: spec.name, [LABEL_ROLE]: role },
        ports,
      },
    },
  };
}

export const backendServiceManifest = (spec: DevEnvSpec) => serviceManifest(spec, spec.name, ROLE_BACKEND, [
  {
    name: 'http', port: 80, targetPort: 80
  },
  {
    name: 'https', port: 443, targetPort: 443
  },
]);

export const uiServiceManifest = (spec: DevEnvSpec) => serviceManifest(spec, `${ spec.name }-ui`, ROLE_UI, [
  {
    name: 'http', port: 80, targetPort: 80
  },
]);

export function ingressManifest(spec: DevEnvSpec): ManifestRequest {
  const backend = (name: string) => ({ service: { name, port: { number: 80 } } });

  return {
    endpoint: ENDPOINTS.ingress,
    body:     {
      apiVersion: 'networking.k8s.io/v1',
      kind:       'Ingress',
      metadata:   {
        ...meta(spec, spec.name),
        ...(spec.clusterIssuer ? { annotations: { 'cert-manager.io/cluster-issuer': spec.clusterIssuer } } : {}),
      },
      spec: {
        ingressClassName: spec.ingressClass,
        rules:            [{
          host: spec.hostname,
          http: {
            paths: [
              // The bundle path must precede '/', which catches everything else.
              {
                path: `/${ UI_BUNDLE_PATH }`, pathType: 'Prefix', backend: backend(`${ spec.name }-ui`)
              },
              {
                path: '/', pathType: 'Prefix', backend: backend(spec.name)
              },
            ],
          },
        }],
        // Rancher's own ingress terminates TLS here and talks plain HTTP to port
        // 80. traefik would otherwise need a ServersTransport CRD to go upstream
        // over HTTPS, which is why the backend runs with --no-cacerts.
        ...(spec.clusterIssuer ? { tls: [{ hosts: [spec.hostname], secretName: `${ spec.name }-tls` }] } : {}),
      },
    },
  };
}

export function buildScript(spec: DevEnvSpec): string {
  // These are shell parameter expansions for the build container, not JS
  // template literals -- they must reach the script verbatim.
  /* eslint-disable no-template-curly-in-string */
  return [
    'set -euo pipefail',
    'if [ -n "${GIT_TOKEN:-}" ]; then',
    '  CLONE_URL="$(echo "$REPO" | sed -E "s#https://#https://x-access-token:${GIT_TOKEN}@#")"',
    'else',
    '  CLONE_URL="$REPO"',
    'fi',
    'rm -rf /src && mkdir -p /src',
    'git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" /src',
    'cd /src',
    'git rev-parse --short HEAD > /out/COMMIT.txt',
    'yarn install --frozen-lockfile',
    // build-hosted derives OUTPUT_DIR from the branch name, and branches like
    // task/17295-multi-idp contain a slash. Call the build directly instead so
    // the served path is predictable.
    // shell/vue.config.js reads DASHBOARD_VERSION for the About page; scripts/version
    // sets it to "<branch> <commit>" when no tag contains HEAD, which is our case.
    `COMMIT="$(cat /out/COMMIT.txt)" VERSION="$BRANCH" \\`,
    `  DASHBOARD_VERSION="$BRANCH $(cat /out/COMMIT.txt)" OUTPUT_DIR="dist/${ UI_BUNDLE_PATH }" \\`,
    `  ROUTER_BASE="/dashboard/" RESOURCE_BASE="${ resourceBase(spec) }" \\`,
    '  yarn run build',
    // Stage the swap so nginx never serves a half-written bundle.
    `rm -rf "/out/${ UI_BUNDLE_PATH }.tmp"`,
    `cp -r "dist/${ UI_BUNDLE_PATH }" "/out/${ UI_BUNDLE_PATH }.tmp"`,
    `rm -rf "/out/${ UI_BUNDLE_PATH }"`,
    `mv "/out/${ UI_BUNDLE_PATH }.tmp" "/out/${ UI_BUNDLE_PATH }"`,
    'echo "build complete"',
  ].join('\n');
  /* eslint-enable no-template-curly-in-string */
}

export function buildJobManifest(spec: DevEnvSpec, buildId: string): ManifestRequest {
  const env: any[] = [
    { name: 'REPO', value: spec.repo },
    { name: 'BRANCH', value: spec.branch },
    { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' },
    { name: 'YARN_CACHE_FOLDER', value: '/cache/yarn' },
  ];

  if (spec.gitSecretName) {
    env.push({ name: 'GIT_TOKEN', valueFrom: { secretKeyRef: { name: spec.gitSecretName, key: 'token' } } });
  }

  return {
    endpoint: ENDPOINTS.job,
    body:     {
      apiVersion: 'batch/v1',
      kind:       'Job',
      metadata:   meta(spec, `${ spec.name }-build-${ buildId }`, ROLE_BUILD),
      spec:       {
        backoffLimit: 1,
        template:     {
          metadata: { labels: labelsFor(spec, ROLE_BUILD) },
          spec:     {
            restartPolicy: 'Never',
            containers:    [{
              name:         'build',
              image:        BUILD_IMAGE,
              command:      ['bash', '-c'],
              args:         [buildScript(spec)],
              env,
              volumeMounts: [
                { name: 'out', mountPath: '/out' },
                { name: 'cache', mountPath: '/cache' },
              ],
              // node_modules is ~855MB and the dashboard build already runs with
              // --max_old_space_size=4096, so it needs headroom above 4Gi.
              resources: {
                requests: { cpu: '2', memory: '6Gi' },
                limits:   { cpu: '4', memory: '8Gi' },
              },
            }],
            volumes: [
              { name: 'out', persistentVolumeClaim: { claimName: `${ spec.name }-ui` } },
              { name: 'cache', persistentVolumeClaim: { claimName: `${ spec.name }-cache` } },
            ],
          },
        },
      },
    },
  };
}

/** Every object for a new environment, in dependency order. */
export function allManifests(spec: DevEnvSpec, password: string, buildId: string): ManifestRequest[] {
  return [
    recordManifest(spec),
    bootstrapSecretManifest(spec, password),
    dataPvcManifest(spec),
    uiPvcManifest(spec),
    cachePvcManifest(spec),
    backendServiceManifest(spec),
    uiServiceManifest(spec),
    backendDeploymentManifest(spec),
    uiDeploymentManifest(spec),
    ingressManifest(spec),
    buildJobManifest(spec, buildId),
  ];
}
