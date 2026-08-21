import {
  allManifests, backendDeploymentManifest, buildJobManifest, buildScript, clusterDnsFor,
  dashboardIndexUrl, dataPvcManifest, ingressManifest, inotifyInitContainer, k3sConfigManifest,
  k3sConfigName, labelsFor, resourceBase, uiDeploymentManifest,
} from '../manifests';
import {
  K3S_CONFIG_PATH, LABEL_MANAGED, LABEL_NAME, LABEL_OWNER, UI_BUNDLE_PATH,
} from '../constants';
import type { RemudaSpec } from '../../types';

const spec: RemudaSpec = {
  name:          'multi-idp',
  repo:          'https://github.com/rak-phillip/dashboard',
  branch:        'task/17295-multi-idp',
  backendImage:  'rancher/rancher:head',
  hostname:      'multi-idp.prak-bf3b08bd.ui.rancher.space',
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

  it('labels every object created for an environment, so delete can sweep by label', () => {
    const manifests = allManifests(spec, 'pw', '1');

    manifests.forEach(({ body }) => {
      expect(body.metadata.labels[LABEL_MANAGED]).toBe('true');
      expect(body.metadata.labels[LABEL_NAME]).toBe('multi-idp');
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
  it('builds the dashboard index url from the in-cluster service', () => {
    expect(dashboardIndexUrl(spec)).toBe(
      'http://multi-idp-ui.rancher-remuda.svc.cluster.local/ui-bundle/index.html'
    );
  });
});

describe('backendDeploymentManifest', () => {
  const container = backendDeploymentManifest(spec).body.spec.template.spec.containers[0];
  const env = Object.fromEntries(container.env.filter((e: any) => e.value !== undefined).map((e: any) => [e.name, e.value]));

  // "dynamic" gates on a canDownload() check wrapped in a sync.Once: if the
  // bundle is not up at that moment Rancher falls back to the embedded UI for
  // the life of the process. Our bundle is built asynchronously, so it would.
  it('forces the remote UI with exactly "false", never "dynamic"', () => {
    expect(env.CATTLE_UI_OFFLINE_PREFERRED).toBe('false');
  });

  it('points the dashboard index at the in-cluster bundle', () => {
    expect(env.CATTLE_UI_DASHBOARD_INDEX).toBe(dashboardIndexUrl(spec));
  });

  it('takes the bootstrap password from the secret rather than inlining it', () => {
    const pw = container.env.find((e: any) => e.name === 'CATTLE_BOOTSTRAP_PASSWORD');

    expect(pw.valueFrom.secretKeyRef).toStrictEqual({ name: 'multi-idp-bootstrap', key: 'password' });
    expect(pw.value).toBeUndefined();
  });

  // Rancher's single-container image embeds k3s, which needs privileged.
  it('runs privileged with TLS terminated upstream', () => {
    expect(container.securityContext).toStrictEqual({ privileged: true });
    expect(container.args).toContain('--no-cacerts');
  });

  // Without this, Rancher may detect the token and drive the HOST cluster.
  it('does not mount a service account token', () => {
    expect(backendDeploymentManifest(spec).body.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it('uses Recreate so the RWO data volume is released before the new pod starts', () => {
    expect(backendDeploymentManifest(spec).body.spec.strategy).toStrictEqual({ type: 'Recreate' });
  });
});

describe('ingressManifest', () => {
  const ingress = ingressManifest(spec).body;
  const paths = ingress.spec.rules[0].http.paths;

  it('routes the bundle path before the catch-all', () => {
    expect(paths.map((p: any) => p.path)).toStrictEqual([`/${ UI_BUNDLE_PATH }`, '/']);
  });

  it('sends the bundle path to nginx and everything else to Rancher', () => {
    expect(paths[0].backend.service.name).toBe('multi-idp-ui');
    expect(paths[1].backend.service.name).toBe('multi-idp');
  });

  // traefik would need a ServersTransport CRD to talk HTTPS upstream; Rancher's
  // own ingress on the same cluster terminates TLS and uses port 80.
  it('targets plain HTTP port 80 on both backends', () => {
    expect(paths.every((p: any) => p.backend.service.port.number === 80)).toBe(true);
  });

  it('requests a certificate from the configured issuer', () => {
    expect(ingress.metadata.annotations).toStrictEqual({ 'cert-manager.io/cluster-issuer': 'remuda-le' });
    expect(ingress.spec.tls).toStrictEqual([{ hosts: ['multi-idp.prak-bf3b08bd.ui.rancher.space'], secretName: 'multi-idp-tls' }]);
  });

  it('omits TLS entirely when no issuer is configured, rather than emitting an empty block', () => {
    const { clusterIssuer, ...noIssuer } = spec;
    const body = ingressManifest(noIssuer as RemudaSpec).body;

    expect(body.spec.tls).toBeUndefined();
    expect(body.metadata.annotations).toBeUndefined();
  });
});

describe('pvc', () => {
  it('sets the storage class when the cluster has one', () => {
    expect(dataPvcManifest(spec).body.spec.storageClassName).toBe('local-path');
  });

  // Sending storageClassName: undefined would be rejected; the key must be absent.
  it('omits the key entirely when the cluster has no default class', () => {
    const { storageClass, ...noClass } = spec;

    expect('storageClassName' in dataPvcManifest(noClass as RemudaSpec).body.spec).toBe(false);
  });

  it('sizes each volume from the spec', () => {
    expect(dataPvcManifest(spec).body.spec.resources.requests.storage).toBe('20Gi');
  });
});

describe('uiDeploymentManifest', () => {
  it('mounts the bundle read-only at nginx root so /ui-bundle resolves with no rewrite', () => {
    const podSpec = uiDeploymentManifest(spec).body.spec.template.spec;

    expect(podSpec.containers[0].volumeMounts).toStrictEqual([
      {
        name: 'bundle', mountPath: '/usr/share/nginx/html', readOnly: true
      },
    ]);
    expect(podSpec.volumes[0].persistentVolumeClaim.claimName).toBe('multi-idp-ui');
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
    expect(container.resources.limits.memory).toBe('8Gi');
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

describe('allManifests', () => {
  it('creates the record and secret before anything references them', () => {
    // Several objects share the environment's name, so key on kind as well.
    const manifests = allManifests(spec, 'pw', '1');
    const at = (kind: string, name: string) => manifests
      .findIndex((m) => m.body.kind === kind && m.body.metadata.name === name);

    expect(at('Secret', 'multi-idp-bootstrap')).toBeLessThan(at('Deployment', 'multi-idp'));
    expect(at('PersistentVolumeClaim', 'multi-idp-ui')).toBeLessThan(at('Job', 'multi-idp-build-1'));
    expect(at('PersistentVolumeClaim', 'multi-idp-data')).toBeLessThan(at('Deployment', 'multi-idp'));
  });

  it('stores the spec on the record so the list can round-trip it', () => {
    const record = allManifests(spec, 'pw', '1')[0];

    expect(JSON.parse(record.body.data.spec)).toStrictEqual(spec);
  });

  it('never writes the password into the record', () => {
    const record = allManifests(spec, 'hunter2', '1')[0];

    expect(JSON.stringify(record)).not.toContain('hunter2');
  });
});

describe('clusterDnsFor', () => {
  it('takes the tenth address of the service range, as k3s does', () => {
    expect(clusterDnsFor('10.45.0.0/16')).toBe('10.45.0.10');
    expect(clusterDnsFor('172.31.0.0/16')).toBe('172.31.0.10');
  });
});

describe('k3sConfigManifest', () => {
  const cm = k3sConfigManifest(spec).body;

  it('sets both CIDRs and a matching cluster-dns', () => {
    expect(cm.data['config.yaml']).toBe([
      'cluster-cidr:',
      '  - "10.44.0.0/16"',
      'service-cidr:',
      '  - "10.45.0.0/16"',
      'cluster-dns:',
      '  - "10.45.0.10"',
      '',
    ].join('\n'));
  });

  it('is named after the environment', () => {
    expect(cm.metadata.name).toBe('multi-idp-k3s-config');
    expect(k3sConfigName(spec)).toBe('multi-idp-k3s-config');
  });
});

describe('backendDeploymentManifest nested k3s wiring', () => {
  const pod = backendDeploymentManifest(spec).body.spec.template.spec;

  it('mounts the config where the k3s binary looks for it, by subPath', () => {
    const mount = pod.containers[0].volumeMounts.find((m: any) => m.mountPath === K3S_CONFIG_PATH);

    // subPath matters: a whole-directory mount would make /etc/rancher/k3s
    // read-only and k3s could not write its generated kubeconfig there.
    expect(mount).toStrictEqual({
      name: 'k3s-config', mountPath: K3S_CONFIG_PATH, subPath: 'config.yaml'
    });
    expect(pod.volumes).toContainEqual({ name: 'k3s-config', configMap: { name: 'multi-idp-k3s-config' } });
  });

  it('leaves dnsPolicy at ClusterFirst so the UI Service name resolves', () => {
    // 'Default' would hand the pod the node's resolvers, under which the
    // *.svc.cluster.local host in CATTLE_UI_DASHBOARD_INDEX does not resolve.
    expect(pod.dnsPolicy).toBeUndefined();
  });
});

describe('allManifests ordering', () => {
  const names = allManifests(spec, 'pw', 'build-1').map((m) => m.body.metadata?.name);

  it('creates the k3s ConfigMap before the Deployment that mounts it', () => {
    expect(names.indexOf('multi-idp-k3s-config')).toBeGreaterThan(-1);
    expect(names.indexOf('multi-idp-k3s-config')).toBeLessThan(names.lastIndexOf('multi-idp'));
  });
});

describe('inotifyInitContainer', () => {
  const init = inotifyInitContainer(spec);
  const script = init.command[2];

  it('writes both limits through /proc/sys, which is the only lever a pod has', () => {
    // fs.inotify.* is not a namespaced sysctl, so securityContext.sysctls
    // cannot set it and the write has to go through a privileged /proc/sys.
    expect(script).toContain('> /proc/sys/fs/inotify/max_user_instances');
    expect(script).toContain('> /proc/sys/fs/inotify/max_user_watches');
    expect(init.securityContext).toStrictEqual({ privileged: true });
  });

  it('is best-effort, so a locked-down node still starts the environment', () => {
    expect(script).toContain('|| echo');
  });

  it('echoes the effective values so the init log shows what took hold', () => {
    expect(script).toContain('max_user_instances=$(cat /proc/sys/fs/inotify/max_user_instances)');
  });

  it('reuses the backend image so it costs no extra pull', () => {
    expect(init.image).toBe(spec.backendImage);
  });

  it('is wired into the backend pod ahead of the container', () => {
    const pod = backendDeploymentManifest(spec).body.spec.template.spec;

    expect(pod.initContainers).toHaveLength(1);
    expect(pod.initContainers[0].name).toBe('raise-inotify-limits');
  });
});
