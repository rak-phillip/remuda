import {
  buildJobManifest,
  buildScript,
  dnsProbeJobManifest,
  dnsProbeScript,
  environmentUrl,
  issuerAnnotations,
  issuerManifest,
  labelsFor,
  resourceBase,
  sharedDashboardIndexUrl,
  uiNginxConfigManifest,
} from '../manifests';
import {
  LABEL_MANAGED,
  LABEL_NAME,
  LABEL_OWNER,
  UI_BUNDLE_PATH,
} from '../constants';
import type { RemudaSpec } from '../../types';

const spec: RemudaSpec = {
  name:          'multi-idp',
  repo:          'https://github.com/rak-phillip/dashboard',
  branch:        'task/17295-multi-idp',
  backendImage:  'rancher/rancher:head',
  hostname:      'multi-idp.prak-bf3b08bd.ui.rancher.space',
  clusterId:     'c-m-dff2ssd2',
  owner:         'prak',
  createdAt:     '2026-08-21T00:00:00.000Z',
  namespace:     'rancher-remuda',
  ingressClass:  'traefik',
  storageClass:  'local-path',
  clusterIssuer: 'remuda-le',
  dataSizeGb:    20,
  uiSizeGb:      2,
  cacheSizeGb:   8,

  nestedPodCidr:     '10.44.0.0/16',
  nestedServiceCidr: '10.45.0.0/16',
};

describe('labelsFor', () => {
  it('marks the object as managed and records name and owner', () => {
    expect(labelsFor(spec)).toStrictEqual({
      [LABEL_MANAGED]: 'true',
      [LABEL_NAME]:    'multi-idp',
      [LABEL_OWNER]:   'prak',
    });
  });
});

describe('urls', () => {
  // The bundle's assets are fetched by the browser, so this must be the public
  // host. It is baked in at build time and cannot be changed afterwards.
  it('builds RESOURCE_BASE from the public hostname', () => {
    expect(resourceBase(spec)).toBe('https://multi-idp.prak-bf3b08bd.ui.rancher.space/ui-bundle');
  });

  // The index is fetched server-side by the Rancher pod, so keeping it in-cluster
  // avoids depending on hairpin routing back through the ingress.
  it('leaves the port off when the environment answers on 443', () => {
    expect(environmentUrl(spec)).toBe('https://multi-idp.prak-bf3b08bd.ui.rancher.space');
  });

  // Direct exposure onto a NodePort: nothing normalises the port, so both
  // browser-facing URLs have to carry it -- and they have to agree, because the
  // bundle is only same-origin with the backend if they do.
  describe('with an entry port', () => {
    const onNodePort: RemudaSpec = {
      ...spec,
      hostname:  'multi-idp.44.247.97.31.sslip.io',
      entryPort: 31443,
    };

    it('carries the port on both browser-facing urls', () => {
      expect(environmentUrl(onNodePort)).toBe('https://multi-idp.44.247.97.31.sslip.io:31443');
      expect(resourceBase(onNodePort)).toBe('https://multi-idp.44.247.97.31.sslip.io:31443/ui-bundle');
    });

    // traefik and nginx both match Host ignoring the port, which is what lets a
    // :31443 request reach a rule written for the bare name.
  });
});

describe('uiNginxConfigManifest', () => {
  const cm = uiNginxConfigManifest(spec).body;
  const config = cm.data['default.conf'];

  // Fonts are fetched in CORS mode whatever the markup says, so a bundle shared
  // with a Rancher on another origin renders in fallback fonts without this.
  it('allows any origin, on error responses too', () => {
    expect(config).toContain('add_header Access-Control-Allow-Origin "*" always;');
  });

  it('serves the bundle from the same root the PVC is mounted at', () => {
    expect(config).toContain('root /usr/share/nginx/html;');
  });

  it('is named for the environment and carries the ui role', () => {
    expect(cm.metadata.name).toBe('multi-idp-ui-nginx');
    expect(cm.metadata.labels[LABEL_NAME]).toBe('multi-idp');
  });
});

describe('sharedDashboardIndexUrl', () => {
  // The in-cluster address is unreachable from a developer's own Rancher; this
  // one goes through the ingress, which already routes the bundle path.
  it('addresses the index through the ingress, for another Rancher to fetch', () => {
    expect(sharedDashboardIndexUrl(spec)).toBe(`https://${ spec.hostname }/${ UI_BUNDLE_PATH }/index.html`);
  });

  it('carries the entry port when there is one', () => {
    expect(sharedDashboardIndexUrl({ ...spec, entryPort: 8443 })).toBe(
      `https://${ spec.hostname }:8443/${ UI_BUNDLE_PATH }/index.html`
    );
  });
});

describe('buildScript', () => {
  const script = buildScript(spec);

  it('bakes the public asset base into the build', () => {
    expect(script).toContain(`RESOURCE_BASE="${ resourceBase(spec) }"`);
    expect(script).toContain('ROUTER_BASE="/dashboard/"');
  });

  // build-hosted derives OUTPUT_DIR from the branch name, and this branch has a
  // slash in it, which would scatter the output across nested directories.
  it('sets OUTPUT_DIR explicitly instead of deriving it from the branch', () => {
    expect(script).toContain(`OUTPUT_DIR="dist/${ UI_BUNDLE_PATH }"`);
    expect(script).not.toContain('build-hosted');
  });

  // shell/vue.config.js reads DASHBOARD_VERSION, not VERSION; without it the
  // About page in the deployed environment reads "undefined".
  it('sets DASHBOARD_VERSION so the About page identifies the branch', () => {
    expect(script).toContain('DASHBOARD_VERSION="$BRANCH $(cat /out/COMMIT.txt)"');
  });

  it('clones the requested branch shallowly', () => {
    expect(script).toContain('git clone --depth 1 --branch "$BRANCH"');
  });

  // nginx serves straight off the volume, so a partial copy would be served.
  it('stages the swap so a half-written bundle is never served', () => {
    const stage = script.indexOf(`cp -r "dist/${ UI_BUNDLE_PATH }" "/out/${ UI_BUNDLE_PATH }.tmp"`);
    const swap = script.indexOf(`mv "/out/${ UI_BUNDLE_PATH }.tmp" "/out/${ UI_BUNDLE_PATH }"`);

    expect(stage).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(stage);
  });

  it('aborts on the first failing command', () => {
    expect(script.startsWith('set -euo pipefail')).toBe(true);
  });
});

describe('buildJobManifest', () => {
  it('gives each rebuild a distinct name, since Jobs are immutable', () => {
    expect(buildJobManifest(spec, '1755792000').body.metadata.name).toBe('multi-idp-build-1755792000');
    expect(buildJobManifest(spec, '1755795600').body.metadata.name).toBe('multi-idp-build-1755795600');
  });

  it('gives the build enough memory for the dashboard webpack run', () => {
    const container = buildJobManifest(spec, '1').body.spec.template.spec.containers[0];
    const env = Object.fromEntries(container.env.filter((e: any) => e.value).map((e: any) => [e.name, e.value]));

    expect(env.NODE_OPTIONS).toBe('--max_old_space_size=4096');
    expect(container.resources.limits.memory).toBe('7Gi');
  });

  // The CPU limit caps os.availableParallelism() inside the container, which in
  // turn caps how many minifier isolates webpack opens -- so it sets the memory
  // peak (~5.3Gi measured at 4 CPU). Raising it without re-benchmarking memory
  // is what this guards against.
  it('caps build CPU, since the memory peak is measured against that cap', () => {
    const container = buildJobManifest(spec, '1').body.spec.template.spec.containers[0];

    expect(container.resources.limits.cpu).toBe('4');
  });

  it('omits the git token when the fork is public', () => {
    const container = buildJobManifest(spec, '1').body.spec.template.spec.containers[0];

    expect(container.env.find((e: any) => e.name === 'GIT_TOKEN')).toBeUndefined();
  });

  it('reads the git token from a secret when one is configured', () => {
    const container = buildJobManifest({ ...spec, gitSecretName: 'multi-idp-git' }, '1')
      .body.spec.template.spec.containers[0];
    const token = container.env.find((e: any) => e.name === 'GIT_TOKEN');

    expect(token.valueFrom.secretKeyRef).toStrictEqual({ name: 'multi-idp-git', key: 'token' });
  });

  it('does not retry indefinitely on a broken branch', () => {
    expect(buildJobManifest(spec, '1').body.spec.backoffLimit).toBe(1);
  });
});

describe('issuerAnnotations', () => {
  it('uses cluster-issuer for a ClusterIssuer, with no kind', () => {
    // ClusterIssuer is cluster-scoped and unambiguous, so cert-manager needs no
    // issuer-kind alongside it.
    expect(issuerAnnotations('dev-envs-le', 'ClusterIssuer')).toStrictEqual({ 'cert-manager.io/cluster-issuer': 'dev-envs-le' });
  });

  // The no-migration guarantee: specs recorded before the mirrored path existed
  // carry a name and no kind, and must keep producing exactly what they did.
  it('treats a missing kind as ClusterIssuer', () => {
    expect(issuerAnnotations('dev-envs-le')).toStrictEqual({ 'cert-manager.io/cluster-issuer': 'dev-envs-le' });
  });

  it('uses issuer + issuer-kind for a namespaced Issuer', () => {
    expect(issuerAnnotations('remuda-le', 'Issuer')).toStrictEqual({
      'cert-manager.io/issuer':      'remuda-le',
      'cert-manager.io/issuer-kind': 'Issuer',
    });
  });

  it('annotates nothing when the cluster offers no issuer', () => {
    expect(issuerAnnotations(undefined, 'Issuer')).toStrictEqual({});
    expect(issuerAnnotations('')).toStrictEqual({});
  });
});

describe('issuerManifest', () => {
  const acme = {
    email:               'admin@example.com',
    server:              'https://acme-v02.api.letsencrypt.org/directory',
    privateKeySecretRef: { name: 'letsencrypt-production' },
    solvers:             [{ http01: { ingress: { class: 'traefik' } } }],
  };
  const body = issuerManifest(spec, acme).body;

  it('creates a namespaced Issuer beside the Ingress', () => {
    // cert-manager.io/issuer resolves in the Ingress's own namespace, which is
    // the entire reason this object exists rather than referencing the one the
    // cluster already has in cattle-system.
    expect(body.kind).toBe('Issuer');
    expect(body.metadata.namespace).toBe(spec.namespace);
  });

  it('copies the ACME config verbatim apart from the account key', () => {
    expect(body.spec.acme.email).toBe(acme.email);
    expect(body.spec.acme.server).toBe(acme.server);
    expect(body.spec.acme.solvers).toStrictEqual(acme.solvers);
  });

  it('points at its own account key rather than the source namespace secret', () => {
    // The source Issuer's secret lives in its own namespace and does not exist
    // in ours; cert-manager creates this one and registers a fresh account.
    expect(body.spec.acme.privateKeySecretRef).toStrictEqual({ name: 'remuda-le-account' });
  });

  it('carries no environment labels, so a delete sweep cannot claim it', () => {
    // Shared by every environment in the namespace, like remuda-config.
    expect(body.metadata.labels).toBeUndefined();
  });
});

describe('dnsProbeJobManifest', () => {
  const job = dnsProbeJobManifest('example.com', 'pabc1234', 'rancher.example.com').body;
  const podSpec = job.spec.template.spec;
  const env = Object.fromEntries(podSpec.containers[0].env.map((e: any) => [e.name, e.value]));

  // The base domain's own record always resolves; only an invented label says
  // whether a wildcard is there.
  it('probes a name under the domain rather than the domain itself', () => {
    expect(env.PROBE).toBe('pabc1234.example.com');
  });

  // Where the fallback hostname's address comes from, and the reason the ingress
  // Service is not consulted for it.
  it('also resolves the host Rancher\'s own name', () => {
    expect(env.HOST).toBe('rancher.example.com');
  });

  it('does not retry', () => {
    expect(job.spec.backoffLimit).toBe(0);
    expect(podSpec.restartPolicy).toBe('Never');
  });

  it('cleans itself up even if nobody is left to delete it', () => {
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(job.spec.activeDeadlineSeconds).toBeGreaterThan(0);
  });

  // It belongs to the cluster, not to any environment, so an environment delete
  // must never sweep it up by name.
  it('carries no environment labels', () => {
    expect(job.metadata.labels[LABEL_NAME]).toBeUndefined();
    expect(job.metadata.labels[LABEL_MANAGED]).toBe('true');
  });
});

describe('dnsProbeScript', () => {
  const script = dnsProbeScript();

  it('reports both answers on their own lines', () => {
    expect(script).toContain('echo "wildcard=$w"');
    expect(script).toContain('entry=$(getent ahostsv4 "$HOST"');
  });

  // A AAAA-first answer would hand back an address sslip.io cannot carry.
  it('asks for IPv4 only', () => {
    expect(script).toContain('ahostsv4');
  });

  // The verdict travels in the log, so the script must not fail the Job when the
  // name simply does not resolve.
  it('does not let a missing name fail the job', () => {
    expect(script).toContain('getent hosts "$PROBE" >/dev/null 2>&1 && w=yes');
    expect(script).not.toContain('set -e');
  });
});
