import {
  REMUDA_NS,
  ENDPOINTS,
  LABEL_MANAGED,
  LABEL_NAME,
  LABEL_OWNER,
  LABEL_ROLE,
  ROLE_BUILD,
  ROLE_UI,
  UI_BUNDLE_PATH,
  BUILD_IMAGE,
  REMUDA_ISSUER_NAME,
  REMUDA_ISSUER_ACCOUNT_SECRET,
  ROLE_PROBE,
  DNS_PROBE_IMAGE,
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


/**
 * Script the probe runs. Answers two questions in one pod, because they are
 * needed together and a second Job would double the wait.
 *
 * 1. Does `*.<baseDomain>` resolve? The name probed is a random one: a wildcard
 *    answers for any label, while a domain carrying only specific records
 *    answers for none we would invent. Probing the base domain itself would
 *    pass on its own A record and prove nothing -- which is exactly the case
 *    that fails, since a Rancher's own hostname always resolves whether or not
 *    anything is hung beneath it.
 *
 * 2. What address does the host Rancher's own name resolve to? That is the
 *    address a browser reaches this Rancher at, and so the one to name a
 *    fallback hostname after. It is deliberately *not* read from the ingress
 *    Service: k3s's built-in servicelb reports the node's own address as the
 *    LoadBalancer ingress IP, which on any cloud node is the private VPC one --
 *    a perfectly valid-looking answer that resolves to somewhere no browser can
 *    reach.
 *
 * Always exits 0. The verdict travels in the log rather than the exit status,
 * so a Job that ran at all is a Job that answered, and one that failed means
 * something stopped it from running rather than that the name was missing.
 */
export function dnsProbeScript(): string {
  return [
    'w=no',
    'getent hosts "$PROBE" >/dev/null 2>&1 && w=yes',
    'echo "wildcard=$w"',
    // ahostsv4: a AAAA-first answer would give an address sslip.io cannot carry.
    `echo "entry=$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1}' | head -1)"`,
    '',
  ].join('\n');
}

/**
 * A short-lived Job that reports on the base domain from inside the cluster.
 *
 * In the cluster rather than the browser because that is the resolver whose
 * answer matters: the same view cert-manager takes when it self-checks an
 * HTTP-01 challenge, and the one that honours a private or split-horizon zone
 * that a public resolver cannot see.
 *
 * `ttlSecondsAfterFinished` so an abandoned probe still cleans itself up if the
 * form is closed before it can be deleted -- long enough that its log is still
 * readable when the answer is collected.
 */
export function dnsProbeJobManifest(
  baseDomain: string, probeId: string, serverHost: string, namespace = REMUDA_NS
): ManifestRequest {
  const name = `remuda-dns-probe-${ probeId }`;

  return {
    endpoint: ENDPOINTS.job,
    body:     {
      apiVersion: 'batch/v1',
      kind:       'Job',
      metadata:   {
        name, namespace, labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: ROLE_PROBE }
      },
      spec: {
        backoffLimit:            0,
        ttlSecondsAfterFinished: 300,
        activeDeadlineSeconds:   20,
        template:                {
          metadata: { labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: ROLE_PROBE } },
          spec:     {
            restartPolicy: 'Never',
            containers:    [{
              name:    'probe',
              image:   DNS_PROBE_IMAGE,
              command: ['sh', '-c', dnsProbeScript()],
              env:     [
                { name: 'PROBE', value: `${ probeId }.${ baseDomain }` },
                { name: 'HOST', value: serverHost },
              ],
              resources: {
                requests: { cpu: '10m', memory: '16Mi' },
                limits:   { cpu: '100m', memory: '64Mi' },
              },
            }],
          },
        },
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

