import {
  REMUDA_NS, ENDPOINTS, INOTIFY_LIMITS, K3S_CONFIG_PATH, LABEL_MANAGED, LABEL_NAME, LABEL_OWNER,
  LABEL_ROLE, ROLE_BACKEND, ROLE_BUILD, ROLE_UI, UI_BUNDLE_PATH, BUILD_IMAGE, SERVE_IMAGE,
  REMUDA_ISSUER_NAME, REMUDA_ISSUER_ACCOUNT_SECRET, NGINX_CONFIG_PATH,
} from './constants';
import type { IssuerKind, RemudaSpec, ManifestRequest } from '../types';

export const labelsFor = (spec: RemudaSpec, role?: string): Record<string, string> => ({
  [LABEL_MANAGED]: 'true',
  [LABEL_NAME]:    spec.name,
  [LABEL_OWNER]:   spec.owner,
  ...(role ? { [LABEL_ROLE]: role } : {}),
});

/**
 * Browser-facing authority, carrying the entry port when there is one.
 *
 * Shared by both browser-facing URLs below so they cannot disagree: the
 * environment's own backend and its bundle are the same origin by design, and a
 * port on one but not the other would break exactly that.
 *
 * That sameness is what keeps the environment itself free of CORS. It stops
 * holding as soon as the bundle is shared with a Rancher elsewhere, which is
 * why the bundle server sends a CORS header anyway -- see uiNginxConfigManifest.
 */
const browserOrigin = (spec: RemudaSpec): string => `https://${ spec.hostname }${ spec.entryPort ? `:${ spec.entryPort }` : '' }`;

/** Browser-facing. Baked into the bundle's asset URLs at build time. */
export const resourceBase = (spec: RemudaSpec): string => `${ browserOrigin(spec) }/${ UI_BUNDLE_PATH }`;

/**
 * Pod-facing. Rancher fetches ui-dashboard-index server-side, so this stays
 * in-cluster over plain HTTP and never depends on hairpinning through the ingress.
 */
export const dashboardIndexUrl = (spec: RemudaSpec): string => `http://${ spec.name }-ui.${ spec.namespace }.svc.cluster.local/${ UI_BUNDLE_PATH }/index.html`;

/**
 * The same index, addressed the way a Rancher *outside* this cluster has to
 * reach it -- a backend developer's local instance, pointing its own
 * ui-dashboard-index at a branch build rather than at a `*-dev` CDN bundle.
 *
 * Public rather than in-cluster, because that Rancher fetches the index
 * server-side from wherever it happens to be running, and the ingress already
 * routes `/UI_BUNDLE_PATH` to the bundle. Their browser then loads the assets
 * from this origin too, since RESOURCE_BASE is absolute and baked in -- which is
 * what uiNginxConfigManifest's CORS header is for.
 */
export const sharedDashboardIndexUrl = (spec: RemudaSpec): string => `${ browserOrigin(spec) }/${ UI_BUNDLE_PATH }/index.html`;

export const environmentUrl = (spec: RemudaSpec): string => browserOrigin(spec);

const meta = (spec: RemudaSpec, name: string, role?: string) => ({
  name,
  namespace: spec.namespace,
  labels:    labelsFor(spec, role),
});

export function namespaceManifest(namespace: string = REMUDA_NS): ManifestRequest {
  return {
    endpoint: ENDPOINTS.namespace,
    body:     {
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   { name: namespace, labels: { [LABEL_MANAGED]: 'true' } },
    },
  };
}

export function recordManifest(spec: RemudaSpec): ManifestRequest {
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

export function bootstrapSecretManifest(spec: RemudaSpec, password: string): ManifestRequest {
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

function pvcManifest(spec: RemudaSpec, suffix: string, sizeGb: number, role: string): ManifestRequest {
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

export const dataPvcManifest = (spec: RemudaSpec) => pvcManifest(spec, 'data', spec.dataSizeGb, ROLE_BACKEND);
export const uiPvcManifest = (spec: RemudaSpec) => pvcManifest(spec, 'ui', spec.uiSizeGb, ROLE_UI);
export const cachePvcManifest = (spec: RemudaSpec) => pvcManifest(spec, 'cache', spec.cacheSizeGb, ROLE_BUILD);

/** Name of the ConfigMap carrying the nested k3s config file. */
export const k3sConfigName = (spec: RemudaSpec): string => `${ spec.name }-k3s-config`;

/**
 * Config for the k3s that the backend image starts inside its own pod.
 *
 * Rancher launches it as a plain subprocess -- `exec.Command("k3s", "server", ...)`
 * in norman's kwrapper -- so the k3s binary does its own CLI parsing and picks up
 * /etc/rancher/k3s/config.yaml. Neither CIDR is passed on that command line, so
 * the file is free to set them, and it is the only lever available: the image
 * entrypoint sends trailing args to `rancher`, not to `k3s`.
 *
 * cluster-dns is pinned rather than left to k3s's derivation so the value is
 * visible here next to the range it has to fall inside.
 */
export function k3sConfigManifest(spec: RemudaSpec): ManifestRequest {
  const config = [
    'cluster-cidr:',
    `  - "${ spec.nestedPodCidr }"`,
    'service-cidr:',
    `  - "${ spec.nestedServiceCidr }"`,
    'cluster-dns:',
    `  - "${ clusterDnsFor(spec.nestedServiceCidr) }"`,
    '',
  ].join('\n');

  return {
    endpoint: ENDPOINTS.configmap,
    body:     {
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   meta(spec, k3sConfigName(spec), ROLE_BACKEND),
      data:       { 'config.yaml': config },
    },
  };
}

/** k3s puts the DNS service at the tenth address of the service range. */
export function clusterDnsFor(serviceCidr: string): string {
  const [base] = serviceCidr.split('/');
  const octets = base.split('.');

  return [octets[0], octets[1], octets[2], '10'].join('.');
}

/**
 * Raise the node's inotify limits before the backend starts.
 *
 * These are not namespaced sysctls, so securityContext.sysctls cannot set them
 * and each environment has to widen the shared host budget itself. Writing
 * through /proc/sys from a privileged container is the only lever a workload
 * has; the container is already privileged for the nested k3s, so this asks for
 * nothing extra.
 *
 * Best-effort on purpose -- a node that already has generous limits, or one
 * with a read-only /proc/sys, should not stop an environment from starting. The
 * values are echoed so the init container's log says what actually took effect.
 */
export function inotifyInitContainer(spec: RemudaSpec) {
  const writes = Object.entries(INOTIFY_LIMITS)
    .map(([key, value]) => {
      const path = `/proc/sys/${ key.replace(/\./g, '/') }`;

      return `echo ${ value } > ${ path } 2>/dev/null || echo "could not raise ${ key }"`;
    })
    .join('; ');

  const reads = Object.keys(INOTIFY_LIMITS)
    .map((key) => `echo "${ key }=$(cat /proc/sys/${ key.replace(/\./g, '/') })"`)
    .join('; ');

  return {
    name:            'raise-inotify-limits',
    // The backend image, so this costs no additional pull.
    image:           spec.backendImage,
    imagePullPolicy: 'IfNotPresent',
    command:         ['sh', '-c', `${ writes }; ${ reads }`],
    securityContext: { privileged: true },
    resources:       { requests: { cpu: '10m', memory: '16Mi' } },
  };
}

export function backendDeploymentManifest(spec: RemudaSpec): ManifestRequest {
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
            // dnsPolicy is deliberately left at the ClusterFirst default.
            //
            // An earlier workaround set it to 'Default' because the container
            // could not use the host CoreDNS -- but that was a symptom of the
            // CIDR collision, which made 10.43.0.10 ambiguous between the host
            // and nested clusters. With the CIDRs separated the host CoreDNS is
            // unambiguous again, and ClusterFirst is what lets this pod resolve
            // the UI Service that CATTLE_UI_DASHBOARD_INDEX points at. Setting
            // 'Default' here gives the node's resolvers, under which
            // *.svc.cluster.local does not resolve at all.
            initContainers:               [inotifyInitContainer(spec)],
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
              volumeMounts: [
                { name: 'data', mountPath: '/var/lib/rancher' },
                // subPath so k3s keeps a writable /etc/rancher/k3s to drop its
                // generated kubeconfig into.
                {
                  name: 'k3s-config', mountPath: K3S_CONFIG_PATH, subPath: 'config.yaml',
                },
              ],
              /**
               * Without this the pod is Ready the instant the process starts,
               * which is seconds -- while Rancher needs minutes. Measured on a
               * restart of an existing environment: pod start to /dashboard/
               * answering 200 was 6m06s, and the Deployment reported
               * readyReplicas=1 for all of it. Everything reading that field --
               * this extension's own list and detail pages -- therefore said
               * "Ready" while the URL returned 502.
               *
               * /healthz is served by Rancher itself, unauthenticated, and only
               * once its HTTP listener is up, so it is exactly the transition
               * the ingress cares about. Port 80 because that is the plain-HTTP
               * listener the Service and Ingress already target.
               *
               * Readiness only, deliberately -- NO livenessProbe. A restart
               * takes k3s through an etcd cluster-reset that can sit silent for
               * minutes, and a liveness probe would kill the pod mid-recovery
               * and never let it finish.
               */
              readinessProbe: {
                httpGet:             { path: '/healthz', port: 80 },
                // Nothing useful can answer before this, and probing through it
                // just fills the events log with failures.
                initialDelaySeconds: 30,
                periodSeconds:       10,
                timeoutSeconds:      5,
                // Generous: once serving, a blip should not pull the pod out of
                // the Service and 503 someone mid-session.
                failureThreshold:    6,
              },
              resources: {
                requests: { cpu: '1', memory: '3Gi' },
                limits:   { cpu: '2', memory: '6Gi' },
              },
            }],
            volumes: [
              { name: 'data', persistentVolumeClaim: { claimName: `${ spec.name }-data` } },
              { name: 'k3s-config', configMap: { name: k3sConfigName(spec) } },
            ],
          },
        },
      },
    },
  };
}

/** Name of the ConfigMap carrying the bundle server's nginx config. */
export const uiNginxConfigName = (spec: RemudaSpec): string => `${ spec.name }-ui-nginx`;

/**
 * Server block for the bundle, replacing the image's stock default.conf.
 *
 * It exists for one directive. The environment's own backend is same-origin
 * with the bundle and needs nothing, but a Rancher elsewhere -- a backend
 * developer's local instance pointed at this environment's index -- serves
 * `index.html` from its own origin while the browser still fetches the assets
 * from here, because RESOURCE_BASE is absolute and fixed at build time.
 *
 * Most of that survives cross-origin untouched: the bundle's entry points are
 * plain `<script defer src>` with no `type="module"` and no `crossorigin`, and
 * webpack's chunk and stylesheet injection is the same, none of which is
 * CORS-checked. `@font-face` is the exception -- fonts are always fetched in
 * CORS mode -- so without this header the dashboard loads and works but falls
 * back to system fonts, which is a poor result for a tool whose whole point is
 * looking at UI changes. `releases.rancher.com` serves the `*-dev` bundles with
 * exactly this header; this is parity with it.
 *
 * Wildcard is safe here: the ingress routes only UI_BUNDLE_PATH to this server,
 * so it covers static assets and never Rancher's API, and `*` cannot be paired
 * with credentials by definition.
 */
export function uiNginxConfigManifest(spec: RemudaSpec): ManifestRequest {
  const config = [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /usr/share/nginx/html;',
    '    index index.html;',
    '',
    '    # `always` so the header is on error responses too -- a 404 for a font',
    '    # should surface as a 404 in the console, not as an opaque CORS failure.',
    '    add_header Access-Control-Allow-Origin "*" always;',
    '',
    '    location / {',
    '        try_files $uri $uri/ =404;',
    '    }',
    '}',
    '',
  ].join('\n');

  return {
    endpoint: ENDPOINTS.configmap,
    body:     {
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   meta(spec, uiNginxConfigName(spec), ROLE_UI),
      data:       { 'default.conf': config },
    },
  };
}

export function uiDeploymentManifest(spec: RemudaSpec): ManifestRequest {
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
              volumeMounts: [
                {
                  name: 'bundle', mountPath: '/usr/share/nginx/html', readOnly: true
                },
                // subPath so the ConfigMap replaces just default.conf rather than
                // shadowing conf.d and taking the rest of the directory with it.
                {
                  name: 'nginx-config', mountPath: NGINX_CONFIG_PATH, subPath: 'default.conf', readOnly: true
                },
              ],
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits:   { cpu: '500m', memory: '256Mi' },
              },
            }],
            volumes: [
              {
                name:                  'bundle',
                persistentVolumeClaim: { claimName: `${ spec.name }-ui`, readOnly: true },
              },
              {
                name:      'nginx-config',
                configMap: { name: uiNginxConfigName(spec) },
              },
            ],
          },
        },
      },
    },
  };
}

function serviceManifest(spec: RemudaSpec, name: string, role: string, ports: any[]): ManifestRequest {
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

export const backendServiceManifest = (spec: RemudaSpec) => serviceManifest(spec, spec.name, ROLE_BACKEND, [
  {
    name: 'http', port: 80, targetPort: 80
  },
  {
    name: 'https', port: 443, targetPort: 443
  },
]);

export const uiServiceManifest = (spec: RemudaSpec) => serviceManifest(spec, `${ spec.name }-ui`, ROLE_UI, [
  {
    name: 'http', port: 80, targetPort: 80
  },
]);

/**
 * The cert-manager annotation for whichever issuer kind was discovered.
 *
 * `cert-manager.io/cluster-issuer` needs no kind because ClusterIssuer is
 * cluster-scoped and unambiguous. A namespaced Issuer needs both the name and
 * `issuer-kind`, and is resolved **in the Ingress's own namespace** -- which is
 * the whole reason the mirrored Issuer has to exist next to the Ingress rather
 * than being referenced where the cluster already keeps one.
 *
 * Shared with the hop, because for a downstream environment the hop's Ingress is
 * the one that terminates TLS.
 */
export function issuerAnnotations(name?: string, kind?: IssuerKind): Record<string, string> {
  if (!name) {
    return {};
  }

  // Absent kind means ClusterIssuer, so specs recorded before the mirrored path
  // existed keep producing exactly what they produced before.
  if (kind === 'Issuer') {
    return {
      'cert-manager.io/issuer':      name,
      'cert-manager.io/issuer-kind': 'Issuer',
    };
  }

  return { 'cert-manager.io/cluster-issuer': name };
}

/**
 * An Issuer in the environment's own namespace, copied from whatever ACME
 * configuration the cluster already has.
 *
 * Only the account key is changed. Pointing at the source Issuer's
 * `privateKeySecretRef` would name a Secret in *its* namespace, which does not
 * exist in ours; cert-manager creates a fresh key here instead and registers a
 * new ACME account against the same email. Account registration is not
 * meaningfully rate limited -- certificate issuance is, and that is unchanged.
 */
export function issuerManifest(spec: RemudaSpec, acme: Record<string, any>): ManifestRequest {
  return {
    endpoint: ENDPOINTS.issuer,
    body:     {
      apiVersion: 'cert-manager.io/v1',
      kind:       'Issuer',
      // No environment labels: this is shared by every environment in the
      // namespace, so it must not be swept when one of them is deleted.
      metadata:   { name: REMUDA_ISSUER_NAME, namespace: spec.namespace },
      spec:       {
        acme: {
          ...acme,
          privateKeySecretRef: { name: REMUDA_ISSUER_ACCOUNT_SECRET },
        },
      },
    },
  };
}

export function ingressManifest(spec: RemudaSpec): ManifestRequest {
  const backend = (name: string) => ({ service: { name, port: { number: 80 } } });

  return {
    endpoint: ENDPOINTS.ingress,
    body:     {
      apiVersion: 'networking.k8s.io/v1',
      kind:       'Ingress',
      metadata:   {
        ...meta(spec, spec.name),
        ...(spec.clusterIssuer ? { annotations: issuerAnnotations(spec.clusterIssuer, spec.issuerKind) } : {}),
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

export function buildScript(spec: RemudaSpec): string {
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

export function buildJobManifest(spec: RemudaSpec, buildId: string): ManifestRequest {
  const env: any[] = [
    { name: 'REPO', value: spec.repo },
    { name: 'BRANCH', value: spec.branch },
    // Belt and braces: dashboard's own build script sets this inline, which
    // wins over an inherited value. It only takes effect on a fork that has
    // dropped it -- the build OOMs below a 2Gi heap.
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
              // Benchmarked against rancher/dashboard master on node 24: the
              // build peaks at ~5.3Gi with this 4 CPU limit and needs ~26s of
              // webpack. limits.cpu is load-bearing for memory, not just for
              // throughput -- node reads the cgroup CPU quota for
              // os.availableParallelism(), and webpack's minifier opens that
              // many worker isolates, each with its own heap. Peak scales with
              // it: ~4.3Gi at 2 CPU, ~5.3Gi at 4, ~6.0Gi at 8, and ~7.4Gi
              // uncapped on a 24-core node. Raising limits.cpu raises the
              // memory floor with it; dropping the limit entirely lets the
              // build fan out to the node's core count and OOM.
              resources: {
                requests: { cpu: '1', memory: '4Gi' },
                limits:   { cpu: '4', memory: '7Gi' },
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
export function allManifests(spec: RemudaSpec, password: string, buildId: string): ManifestRequest[] {
  return [
    recordManifest(spec),
    bootstrapSecretManifest(spec, password),
    k3sConfigManifest(spec),
    uiNginxConfigManifest(spec),
    dataPvcManifest(spec),
    uiPvcManifest(spec),
    cachePvcManifest(spec),
    backendServiceManifest(spec),
    uiServiceManifest(spec),
    backendDeploymentManifest(spec),
    uiDeploymentManifest(spec),
    // Before the Ingress that references it. Only for the mirrored path -- a
    // ClusterIssuer already exists and is not ours to create.
    ...(spec.acme ? [issuerManifest(spec, spec.acme)] : []),
    ingressManifest(spec),
    buildJobManifest(spec, buildId),
  ];
}
