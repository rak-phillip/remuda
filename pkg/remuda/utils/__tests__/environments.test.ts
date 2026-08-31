import {
  crBuildState, crRunState, environmentCrBody, listEnvironments, specFromCr
} from '../environments';
import { ENVIRONMENT_API_VERSION, ENVIRONMENT_KIND, REMUDA_NS } from '../constants';
import type { EnvironmentCR, RemudaSpec } from '../../types';

const cr = (overrides: Partial<EnvironmentCR> = {}): EnvironmentCR => ({
  metadata: {
    name:              'crd-smoke',
    namespace:         REMUDA_NS,
    creationTimestamp: '2026-08-30T15:49:00Z',
  },
  spec: {
    repo:   'https://github.com/rak-phillip/dashboard',
    branch: 'task/17295-login-page',
  },
  status: {
    build:    'Building',
    run:      'Stopped',
    resolved: {
      hostname:     'crd-smoke.54.191.139.180.sslip.io',
      ingressClass: 'traefik',
      storageClass: 'local-path',
    },
  },
  ...overrides,
} as EnvironmentCR);

const legacy = (overrides: Partial<RemudaSpec> = {}): RemudaSpec => ({
  name:      'prak-test1',
  repo:      'https://github.com/rak-phillip/dashboard',
  branch:    'task/17295-login-page',
  hostname:  'prak-test1.54.191.139.180.sslip.io',
  owner:     'user-rsznl',
  namespace: REMUDA_NS,
  clusterId: 'local',
  createdAt: '2026-08-29T16:48:53.599Z',
  ...overrides,
} as RemudaSpec);

/** A store whose two collection reads can be steered independently. */
const storeWith = (crs: EnvironmentCR[], configMaps: RemudaSpec[]) => ({
  dispatch: (_action: string, { url }: { url: string }) => {
    if (url.includes('remuda.rancher.io.environments')) {
      return Promise.resolve({ data: crs });
    }

    if (url.includes('configmaps')) {
      return Promise.resolve({
        data: configMaps.map((spec) => ({
          metadata: { labels: { 'remuda.rancher.io/name': spec.name } },
          data:     { spec: JSON.stringify(spec) },
        })),
      });
    }

    return Promise.resolve({ data: [] });
  },
});

describe('specFromCr', () => {
  it('prefers what the controller resolved over what was asked for', () => {
    // An unpinned field is absent from spec entirely and a pinned one is echoed
    // back unchanged, so resolved is never the weaker answer.
    const spec = specFromCr(cr());

    expect(spec.hostname).toBe('crd-smoke.54.191.139.180.sslip.io');
    expect(spec.ingressClass).toBe('traefik');
    expect(spec.branch).toBe('task/17295-login-page');
  });

  it('takes identity from metadata rather than spec', () => {
    const spec = specFromCr(cr());

    expect(spec.name).toBe('crd-smoke');
    expect(spec.namespace).toBe(REMUDA_NS);
    expect(spec.createdAt).toBe('2026-08-30T15:49:00Z');
  });

  it('leaves owner empty for a scripted create rather than inventing one', () => {
    // kubectl has no principal to attribute it to, so the Owner column renders
    // nothing. Filling it in here would be a guess presented as a fact.
    expect(specFromCr(cr()).owner).toBe('');
  });

  it('survives a CR the controller has not reconciled yet', () => {
    const spec = specFromCr(cr({ status: undefined }));

    expect(spec.name).toBe('crd-smoke');
    expect(spec.hostname).toBeUndefined();
  });
});

describe('state mapping', () => {
  it('translates the controller vocabulary into the UI\'s', () => {
    expect(crBuildState(cr({ status: { build: 'Ready' } }))).toBe('ready');
    expect(crBuildState(cr({ status: { build: 'Failed' } }))).toBe('failed');
    expect(crBuildState(cr({ status: { build: 'Building' } }))).toBe('building');

    expect(crRunState(cr({ status: { run: 'Ready' } }))).toBe('ready');
    expect(crRunState(cr({ status: { run: 'Stopped' } }))).toBe('stopped');
    expect(crRunState(cr({ status: { run: 'Stopping' } }))).toBe('stopping');
  });

  it('maps a Fleet-delivered Unknown build to unknown, not failed', () => {
    // Fleet tracks Deployments and PVCs but not Jobs, so a downstream build is
    // unobservable. Reporting that as a failure would be wrong and alarming.
    expect(crBuildState(cr({ status: { build: 'Unknown' } }))).toBe('unknown');
  });

  it('falls back for a status the controller has not written yet', () => {
    expect(crBuildState(cr({ status: undefined }))).toBe('unknown');
    expect(crRunState(cr({ status: undefined }))).toBe('pending');
  });
});

describe('listEnvironments', () => {
  it('returns both records, tagged with where each came from', async() => {
    const records = await listEnvironments(storeWith([cr()], [legacy()]), 'local');

    expect(records.map((r) => [r.spec.name, r.source])).toEqual([
      ['crd-smoke', 'cr'],
      ['prak-test1', 'legacy'],
    ]);
  });

  it('sorts newest first across both records', async() => {
    const older = cr({
      metadata: {
        name: 'old', namespace: REMUDA_NS, creationTimestamp: '2026-08-01T00:00:00Z'
      }
    });
    const records = await listEnvironments(storeWith([older, cr()], [legacy()]), 'local');

    expect(records.map((r) => r.spec.name)).toEqual(['crd-smoke', 'prak-test1', 'old']);
  });

  it('prefers the CR when a name appears in both records', async() => {
    // The two sets cannot overlap in normal use -- a CR writes no ConfigMap and
    // a legacy environment has no CR -- so this only happens if someone wrote a
    // CR over a legacy environment. The CR wins because it is the one something
    // is actively reconciling.
    const records = await listEnvironments(
      storeWith([cr({ metadata: { name: 'prak-test1', namespace: REMUDA_NS } })], [legacy()]),
      'local',
    );

    expect(records).toHaveLength(1);
    expect(records[0].source).toBe('cr');
  });

  it('still lists legacy environments on a cluster with no CRD', async() => {
    // This is the ordinary state of every cluster that has not installed the
    // controller, and the whole point of the compatibility window.
    const store = {
      dispatch: (_a: string, { url }: { url: string }) => {
        if (url.includes('remuda.rancher.io.environments')) {
          return Promise.reject(new Error('404 not found'));
        }

        return storeWith([], [legacy()]).dispatch(_a, { url });
      },
    };

    const records = await listEnvironments(store, 'local');

    expect(records.map((r) => [r.spec.name, r.source])).toEqual([['prak-test1', 'legacy']]);
  });
});

describe('environmentCrBody', () => {
  const asked = {
    name: 'pr-1234', repo: 'https://github.com/rancher/dashboard', branch: 'main',
  };

  it('sends only intent, leaving discovery to the controller', () => {
    // Echoing back a discovered value the user never chose would pin it, and a
    // pinned field is frozen against a cluster that later changes.
    const body = environmentCrBody(asked);

    expect(body.apiVersion).toBe(ENVIRONMENT_API_VERSION);
    expect(body.kind).toBe(ENVIRONMENT_KIND);
    expect(body.spec).toEqual({
      repo: asked.repo, branch: 'main', running: true
    });
  });

  it('pins what the person actually chose', () => {
    const body = environmentCrBody({
      ...asked, clusterId: 'local', dataSizeGb: 40, backendImage: 'rancher/rancher:head',
    });

    expect(body.spec.clusterId).toBe('local');
    expect(body.spec.dataSizeGb).toBe(40);
    expect(body.spec.backendImage).toBe('rancher/rancher:head');
    expect(body.spec.storageClass).toBeUndefined();
  });

  it('pins the four fields Fleet cannot read back, downstream only', () => {
    const downstream = {
      ...asked,
      clusterId:         'c-m-dff2ssd2',
      ingressClass:      'traefik',
      storageClass:      'local-path',
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    };

    expect(environmentCrBody(downstream, { downstream: true }).spec).toMatchObject({
      ingressClass:      'traefik',
      storageClass:      'local-path',
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    });

    // On the host cluster the controller reads all four from remuda-config, so
    // sending them would pin values nobody chose.
    const host = environmentCrBody(downstream).spec;

    expect(host.ingressClass).toBeUndefined();
    expect(host.nestedPodCidr).toBeUndefined();
  });

  it('drops empty strings rather than pinning them', () => {
    const body = environmentCrBody({
      ...asked, hostname: '', backendImage: ''
    });

    expect(body.spec.hostname).toBeUndefined();
    expect(body.spec.backendImage).toBeUndefined();
  });
});
