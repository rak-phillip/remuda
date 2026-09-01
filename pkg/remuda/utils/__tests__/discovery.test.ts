import {
  backendImageForBranch, baseDomainFromServerUrl, cidrsOverlap, discoverDefaults, exposureFor,
  hostIngressDefaults, hostnameFor, ingressEntry, isIpLiteral, pickNestedCidrs, saveDefaults,
  widenToSixteen, wildcardDomainFor, isWildcardFallbackDomain, probeBaseDomain, parseProbeLog,
} from '../discovery';
import { DEFAULT_BACKEND_IMAGE, ENDPOINTS } from '../constants';

describe('baseDomainFromServerUrl', () => {
  it.each([
    ['https://prak-bf3b08bd.ui.rancher.space', 'prak-bf3b08bd.ui.rancher.space'],
    ['https://prak-bf3b08bd.ui.rancher.space/', 'prak-bf3b08bd.ui.rancher.space'],
    ['http://rancher.example.com/dashboard', 'rancher.example.com'],
    ['', ''],
  ])('strips %s down to %s', (input, expected) => {
    expect(baseDomainFromServerUrl(input)).toBe(expected);
  });

  it('tolerates the setting being absent', () => {
    expect(baseDomainFromServerUrl(undefined as any)).toBe('');
  });
});

describe('hostnameFor', () => {
  it('composes the environment host under the wildcard domain', () => {
    expect(hostnameFor('multi-idp', 'prak-bf3b08bd.ui.rancher.space'))
      .toBe('multi-idp.prak-bf3b08bd.ui.rancher.space');
  });
});

describe('isIpLiteral', () => {
  it.each([
    ['13.53.41.140', true],
    ['44.247.97.31', true],
    // Not an address, so nothing stops a subdomain being hung under it.
    ['prak-bf3b08bd.ui.rancher.space', false],
    ['13.53.41.140.sslip.io', false],
    // Reads like one but cannot be: an octet past 255 is somebody's hostname.
    ['999.1.1.1', false],
    ['', false],
  ])('%s -> %s', (input, expected) => {
    expect(isIpLiteral(input)).toBe(expected);
  });

  it('tolerates the domain being absent', () => {
    expect(isIpLiteral(undefined as any)).toBe(false);
  });
});

describe('wildcardDomainFor', () => {
  it('wraps an address in the wildcard suffix', () => {
    expect(wildcardDomainFor('44.247.97.31')).toBe('44.247.97.31.sslip.io');
    expect(hostnameFor('multi-idp', wildcardDomainFor('44.247.97.31')))
      .toBe('multi-idp.44.247.97.31.sslip.io');
  });

  // A LoadBalancer that hands out an ELB hostname already has a name; wrapping
  // it would resolve to nothing at all.
  it('gives nothing back for an address that is already a name', () => {
    expect(wildcardDomainFor('a1b2.eu-north-1.elb.amazonaws.com')).toBe('');
    expect(wildcardDomainFor('')).toBe('');
  });
});

describe('exposureFor', () => {
  const host = {
    targetsLocal: false, hostIngressClass: 'traefik', hostBaseDomain: 'prak.ui.rancher.space'
  };

  it('leaves a local target alone, whatever the host looks like', () => {
    expect(exposureFor({ ...host, targetsLocal: true }).mode).toBe('local');
    expect(exposureFor({
      targetsLocal: true, hostIngressClass: '', hostBaseDomain: '13.53.41.140'
    }).mode).toBe('local');
  });

  it('fronts a downstream target from the host when it can', () => {
    expect(exposureFor(host)).toStrictEqual({ mode: 'hop' });
    expect(exposureFor({ ...host, hostIngressClass: 'nginx' })).toStrictEqual({ mode: 'hop' });
  });

  // The docker Rancher case: its k3s starts with traefik disabled, so the host
  // has no IngressClass and an empty class used to slip the guard and be written
  // into the hop's Ingress, which the API rejects.
  it('falls back to direct when the host has no ingress controller', () => {
    expect(exposureFor({ ...host, hostIngressClass: '' }))
      .toStrictEqual({ mode: 'direct', reason: 'noHostIngress' });
  });

  it('falls back to direct when the host ingress cannot go upstream over HTTPS', () => {
    expect(exposureFor({ ...host, hostIngressClass: 'haproxy' }))
      .toStrictEqual({ mode: 'direct', reason: 'hostClassUnsupported' });
  });

  it('falls back to direct when the host has no domain to hang a name under', () => {
    expect(exposureFor({ ...host, hostBaseDomain: '13.53.41.140' }))
      .toStrictEqual({ mode: 'direct', reason: 'baseDomainIsIp' });
  });
});

describe('backendImageForBranch', () => {
  it('matches the backend to a release branch', () => {
    expect(backendImageForBranch('release-2.12')).toBe('rancher/rancher:v2.12-head');
    expect(backendImageForBranch('bugfix/release-2.9-thing')).toBe('rancher/rancher:v2.9-head');
  });

  it('uses plain head for the line the host is on, which has no vX.Y-head tag', () => {
    // Docker Hub publishes the main line as `head` (plus per-commit
    // vX.Y-<sha>-head); only branched lines get the vX.Y-head alias, so
    // rancher/rancher:v2.16-head 404s while 2.16 is main.
    expect(backendImageForBranch('release-2.16', 'v2.16-ffbd1cc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('still pins older lines, which do have the alias', () => {
    expect(backendImageForBranch('release-2.15', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.15-head');
    expect(backendImageForBranch('release-2.9', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.9-head');
  });

  it('treats a branch ahead of the host as the main line too', () => {
    expect(backendImageForBranch('release-2.17', 'v2.16-ffbd1cc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('compares minors numerically, not as strings', () => {
    // '2.9' > '2.16' lexically; the comparison has to be numeric.
    expect(backendImageForBranch('release-2.9', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.9-head');
    expect(backendImageForBranch('release-2.16', 'v2.9-abc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('falls back to the pinned tag when the host version is unreadable', () => {
    expect(backendImageForBranch('release-2.15')).toBe('rancher/rancher:v2.15-head');
    expect(backendImageForBranch('release-2.15', '')).toBe('rancher/rancher:v2.15-head');
  });

  // A feature branch carries no usable version signal, so don't invent one.
  it.each(['task/17295-multi-idp', 'master', '', undefined])('falls back to head for %s', (branch) => {
    expect(backendImageForBranch(branch as string)).toBe(DEFAULT_BACKEND_IMAGE);
  });
});

describe('cidrsOverlap', () => {
  it('detects a containing range', () => {
    expect(cidrsOverlap('10.42.0.0/24', '10.42.0.0/16')).toBe(true);
  });

  it('separates adjacent ranges', () => {
    expect(cidrsOverlap('10.44.0.0/16', '10.45.0.0/16')).toBe(false);
    expect(cidrsOverlap('10.42.0.0/16', '10.43.0.0/16')).toBe(false);
  });

  it('handles addresses above 2^31 without sign errors', () => {
    expect(cidrsOverlap('172.31.0.0/16', '172.31.5.0/24')).toBe(true);
    expect(cidrsOverlap('192.168.0.0/16', '10.0.0.0/8')).toBe(false);
  });

  it('treats an unparseable range as overlapping, so the candidate is skipped', () => {
    expect(cidrsOverlap('10.44.0.0/16', '')).toBe(true);
    expect(cidrsOverlap('10.44.0.0/16', 'nonsense')).toBe(true);
  });
});

describe('widenToSixteen', () => {
  it('rounds a node slice out to the range that contains it', () => {
    expect(widenToSixteen('10.42.0.0/24')).toBe('10.42.0.0/16');
  });

  it('accepts a bare address, as read off a Service ClusterIP', () => {
    expect(widenToSixteen('10.43.0.1')).toBe('10.43.0.0/16');
  });

  it('returns empty for junk rather than a plausible-looking range', () => {
    expect(widenToSixteen('')).toBe('');
    expect(widenToSixteen('10.43')).toBe('');
  });
});

describe('pickNestedCidrs', () => {
  it('takes the first candidate when the host uses the k3s defaults', () => {
    expect(pickNestedCidrs('10.42.0.0/16', '10.43.0.0/16')).toStrictEqual({
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    });
  });

  it('steps past a candidate the host has already claimed', () => {
    // A host on 10.44/10.45 is exactly the case that would recreate the
    // original collision if the first candidate were used unconditionally.
    expect(pickNestedCidrs('10.44.0.0/16', '10.45.0.0/16')).toStrictEqual({
      nestedPodCidr:     '10.46.0.0/16',
      nestedServiceCidr: '10.47.0.0/16',
    });
  });

  it('skips a candidate that collides on either half', () => {
    expect(pickNestedCidrs('10.45.0.0/16', '10.99.0.0/16').nestedPodCidr).toBe('10.46.0.0/16');
  });

  it('falls back to the default pair when the host ranges are unreadable', () => {
    expect(pickNestedCidrs('', '')).toStrictEqual({
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    });
  });
});

describe('saveDefaults', () => {
  const defaults = { baseDomain: 'example.com', ingressClass: 'traefik' } as any;

  function mockStore(existing: any) {
    const calls: any[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        calls.push(opts);

        if (!opts.method) {
          if (!existing) {
            throw new Error('404 not found');
          }

          return existing;
        }

        return {};
      }),
    };

    return { store, calls };
  }

  const posted = (calls: any[], endpoint: string) => calls.filter(
    (c) => c.method === 'POST' && c.url.endsWith(`/${ endpoint }`)
  );

  it('creates the ConfigMap when the cluster has none yet', async() => {
    const { store, calls } = mockStore(undefined);

    await saveDefaults(store, 'local', defaults);

    expect(posted(calls, ENDPOINTS.configmap)).toHaveLength(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('creates the namespace first, because on a downstream target nothing else has', async() => {
    // The environment's own objects arrive by Fleet, which brings the namespace
    // with them, and the Environment CR lives on the host -- so the first create
    // on a target cluster used to POST this ConfigMap into a namespace that did
    // not exist. The 404 was swallowed by the caller, so the create reported
    // success and that cluster never prefilled anything, ever.
    const { store, calls } = mockStore(undefined);

    await saveDefaults(store, 'c-m-zxt2njmt', defaults);

    const namespacePost = posted(calls, ENDPOINTS.namespace);

    expect(namespacePost).toHaveLength(1);
    expect(calls.indexOf(namespacePost[0])).toBeLessThan(
      calls.indexOf(posted(calls, ENDPOINTS.configmap)[0])
    );
  });

  it('leaves an existing namespace alone', async() => {
    const { store, calls } = mockStore({ metadata: { resourceVersion: '1' } });

    await saveDefaults(store, 'c-m-zxt2njmt', defaults);

    expect(posted(calls, ENDPOINTS.namespace)).toHaveLength(0);
  });

  it('updates in place when it already exists, carrying resourceVersion', async() => {
    // Steve rejects an update without one: "metadata.resourceVersion is
    // required for update". The old code PUT without it, always failed, then
    // POSTed and got `configmaps "remuda-config" already exists` -- so every
    // create after the first on a cluster surfaced an error.
    const { store, calls } = mockStore({ metadata: { resourceVersion: '80357' } });

    await saveDefaults(store, 'local', defaults);

    const put = calls.find((c) => c.method === 'PUT');

    expect(put).toBeDefined();
    expect(put.data.metadata.resourceVersion).toBe('80357');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not fall back to POST when the object exists', async() => {
    const { store, calls } = mockStore({ metadata: { resourceVersion: '1' } });

    await saveDefaults(store, 'local', defaults);

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('discoverDefaults storage detection', () => {
  function storeWith(storageRows: any) {
    return {
      dispatch: jest.fn(async(action: string, opts: any) => {
        if (action === 'management/find') {
          return { value: '' };
        }

        if (opts?.url?.includes('storageclasses')) {
          if (storageRows === 'error') {
            throw new Error('forbidden');
          }

          return { data: storageRows };
        }

        return { data: [] };
      }),
    };
  }

  it('flags a cluster that has no StorageClass at all', async() => {
    const out = await discoverDefaults(storeWith([]), 'c-m-abc');

    expect(out.hasStorageClass).toBe(false);
    expect(out.storageClass).toBeUndefined();
  });

  it('prefers the class marked default', async() => {
    const rows = [
      { metadata: { name: 'slow' } },
      { metadata: { name: 'fast', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } },
    ];
    const out = await discoverDefaults(storeWith(rows), 'c-m-abc');

    expect(out.hasStorageClass).toBe(true);
    expect(out.storageClass).toBe('fast');
  });

  it('does not block when the lookup itself fails', async() => {
    // A user without permission to list StorageClasses should not be told the
    // cluster has no storage.
    const out = await discoverDefaults(storeWith('error'), 'c-m-abc');

    expect(out.hasStorageClass).toBe(true);
  });
});

describe('issuer discovery', () => {
  /** Answers the two lookups issuerFor() makes, in whatever combination. */
  function storeWith({ clusterIssuers = [], issuers = [] }: any) {
    return {
      dispatch: jest.fn(async(action: string, opts: any) => {
        if (action === 'management/find') {
          return { value: '' };
        }

        if (opts?.url?.includes('clusterissuers')) {
          return { data: clusterIssuers };
        }

        if (opts?.url?.includes('cert-manager.io.issuers')) {
          return { data: issuers };
        }

        return { data: [] };
      }),
    };
  }

  const rancherIssuer = {
    metadata: { name: 'rancher', namespace: 'cattle-system' },
    spec:     { acme: { email: 'admin@example.com', solvers: [{ http01: {} }] } },
  };

  // Read from server-url on the host and never from the target cluster's saved
  // override, because what it answers is whether the host can front anything.
  it('reports the host Rancher own domain alongside the issuer', async() => {
    const store = {
      dispatch: jest.fn(async(action: string, opts: any) => {
        if (action === 'management/find') {
          return { value: 'https://13.53.41.140/' };
        }

        return opts?.url?.includes('ingressclasses') ? { data: [] } : { data: [] };
      }),
    };
    const out = await hostIngressDefaults(store);

    expect(out.baseDomain).toBe('13.53.41.140');
    expect(out.ingressClass).toBe('');
    expect(exposureFor({
      targetsLocal: false, hostIngressClass: out.ingressClass, hostBaseDomain: out.baseDomain
    })).toStrictEqual({ mode: 'direct', reason: 'noHostIngress' });
  });

  it('prefers a ClusterIssuer, and mirrors nothing', async() => {
    // Explicit operator configuration, works across namespaces as-is.
    const out = await hostIngressDefaults(storeWith({ clusterIssuers: [{ metadata: { name: 'dev-envs-le' } }], issuers: [rancherIssuer] }));

    expect(out.clusterIssuer).toBe('dev-envs-le');
    expect(out.issuerKind).toBe('ClusterIssuer');
    expect(out.acme).toBeUndefined();
  });

  // The stock Rancher case: the chart provisions cattle-system/rancher and
  // nothing cluster-scoped, which is why TLS silently never worked.
  it('falls back to mirroring a namespaced ACME Issuer', async() => {
    const out = await hostIngressDefaults(storeWith({ issuers: [rancherIssuer] }));

    expect(out.clusterIssuer).toBe('remuda-le');
    expect(out.issuerKind).toBe('Issuer');
    expect(out.acme?.source).toBe('cattle-system/rancher');
    expect(out.acme?.spec).toStrictEqual(rancherIssuer.spec.acme);
  });

  it('ignores a non-ACME Issuer', async() => {
    // Mirroring a selfSigned issuer would reproduce the untrusted certificate
    // traefik already serves, while looking configured.
    const out = await hostIngressDefaults(storeWith({ issuers: [{ metadata: { name: 'selfsigned', namespace: 'default' }, spec: { selfSigned: {} } }] }));

    expect(out.clusterIssuer).toBeUndefined();
    expect(out.issuerKind).toBeUndefined();
  });

  it('reports no issuer when the cluster has neither', async() => {
    const out = await hostIngressDefaults(storeWith({}));

    expect(out.clusterIssuer).toBeUndefined();
    expect(out.acme).toBeUndefined();
  });

  it('does not fail the form when the Issuer CRD is absent', async() => {
    const store = {
      dispatch: jest.fn(async(action: string, opts: any) => {
        if (action === 'management/find') {
          return { value: '' };
        }

        if (opts?.url?.includes('issuers')) {
          throw new Error('no such type');
        }

        return { data: [] };
      }),
    };

    await expect(hostIngressDefaults(store)).resolves.toBeDefined();
  });
});

describe('ingressEntry', () => {
  const nodes = (addresses: any[]) => ({ data: [{ status: { addresses } }] });

  function clusterWith({ services = [], daemonsets = [], nodeAddresses = [] }: any) {
    return {
      dispatch: jest.fn(async(_a: string, opts: any) => {
        if (opts.url.includes(ENDPOINTS.daemonset)) {
          return { data: daemonsets };
        }
        if (opts.url.includes(ENDPOINTS.node)) {
          return nodes(nodeAddresses);
        }
        if (opts.url.includes(ENDPOINTS.service)) {
          return { data: services };
        }

        return { data: [] };
      }),
    };
  }

  const bothAddresses = [
    { type: 'InternalIP', address: '10.0.12.23' },
    { type: 'ExternalIP', address: '52.12.200.3' },
    { type: 'Hostname', address: 'prak-test3-pool1' },
  ];

  it('prefers the public address, because the private one is not routable', async() => {
    // Measured, not assumed: from the host cluster the downstream node's
    // 10.0.12.23 times out on every port even though the host's own address is
    // 10.0.16.140. Sharing 10.0.0.0/16 does not make two VPCs one network.
    const store = clusterWith({
      daemonsets:    [{ metadata: { name: 'rke2-traefik' }, spec: { template: { spec: { containers: [{ ports: [{ name: 'websecure', hostPort: 443 }] }] } } } }],
      nodeAddresses: bothAddresses,
    });

    expect(await ingressEntry(store, 'c-m-dff2ssd2', 'traefik')).toEqual({
      addresses: ['52.12.200.3'], addressType: 'ExternalIP', port: 443, source: 'node',
    });
  });

  it('falls back to the private address when there is no public one', async() => {
    // A node with no ExternalIP is on a private network by construction, which
    // is exactly when InternalIP is both the only and the correct answer.
    const store = clusterWith({
      daemonsets:    [{ metadata: { name: 'rke2-traefik' }, spec: { template: { spec: { containers: [{ ports: [{ name: 'websecure', hostPort: 443 }] }] } } } }],
      nodeAddresses: [{ type: 'InternalIP', address: '10.0.12.23' }],
    });

    expect(await ingressEntry(store, 'c-m-dff2ssd2', 'traefik')).toEqual({
      addresses: ['10.0.12.23'], addressType: 'InternalIP', port: 443, source: 'node',
    });
  });

  it('takes a LoadBalancer ahead of anything node-bound', async() => {
    const store = clusterWith({
      services: [{
        metadata: { name: 'traefik' },
        spec:     { type: 'LoadBalancer', ports: [{ name: 'https', port: 443 }] },
        status:   { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] } },
      }],
      daemonsets:    [{ metadata: { name: 'traefik' }, spec: { template: { spec: { containers: [{ ports: [{ hostPort: 443 }] }] } } } }],
      nodeAddresses: bothAddresses,
    });

    const entry = await ingressEntry(store, 'c-m-x', 'traefik');

    expect(entry?.addresses).toEqual(['203.0.113.5']);

    // addressType cannot carry this: a load balancer's address and a node's
    // public address are both ExternalIP, and only one of them is a node. The
    // controller recomputes hop addresses from nodes, so it has to be told which
    // this is or it replaces a working LB address with node addresses that are
    // usually not listening on the port. See LABEL_ADDRESSES_PINNED.
    expect(entry?.source).toBe('loadBalancer');
    expect(entry?.addressType).toBe('ExternalIP');
  });

  it('uses the assigned nodePort when the controller is a NodePort Service', async() => {
    const store = clusterWith({
      services: [{
        metadata: { name: 'ingress-nginx-controller' },
        spec:     {
          type:  'NodePort',
          ports: [{
            name: 'https', port: 443, nodePort: 31443
          }]
        }
      }],
      nodeAddresses: bothAddresses,
    });

    expect(await ingressEntry(store, 'c-m-x', 'nginx')).toEqual({
      addresses: ['52.12.200.3'], addressType: 'ExternalIP', port: 31443, source: 'node',
    });
  });

  it('ignores services belonging to some other controller', async() => {
    const store = clusterWith({
      services: [{
        metadata: { name: 'rancher-monitoring' },
        spec:     {
          type:  'NodePort',
          ports: [{
            name: 'https', port: 443, nodePort: 31999
          }]
        }
      }],
      nodeAddresses: bothAddresses,
    });

    expect(await ingressEntry(store, 'c-m-x', 'traefik')).toBeUndefined();
  });

  it('reports "could not tell" rather than throwing', async() => {
    const store = {
      dispatch: jest.fn(async() => {
        throw new Error('403');
      })
    };

    expect(await ingressEntry(store, 'c-m-x', 'traefik')).toBeUndefined();
  });
});


describe('isWildcardFallbackDomain', () => {
  it.each([
    ['34.220.244.75.sslip.io', true],
    ['prak-2531067c.ui.rancher.space', false],
    ['', false],
  ])('%s -> %s', (domain, expected) => {
    expect(isWildcardFallbackDomain(domain as string)).toBe(expected);
  });
});

describe('parseProbeLog', () => {
  it('reads both answers out of the log', () => {
    expect(parseProbeLog('wildcard=yes\nentry=34.220.244.75\n')).toStrictEqual({ wildcard: true, entryAddress: '34.220.244.75' });
  });

  it('reads a missing wildcard', () => {
    expect(parseProbeLog('wildcard=no\nentry=34.220.244.75\n').wildcard).toBe(false);
  });

  // A line that never arrived is not a "no": acting on it would rewrite a base
  // domain on the strength of a probe that did not answer.
  it('is undefined when the wildcard line is absent or unrecognised', () => {
    expect(parseProbeLog('entry=1.2.3.4').wildcard).toBeUndefined();
    expect(parseProbeLog('wildcard=\nentry=1.2.3.4').wildcard).toBeUndefined();
    expect(parseProbeLog('').wildcard).toBeUndefined();
  });

  // getent prints nothing when the name does not resolve, so entry can be empty.
  it('ignores an entry that is not an address', () => {
    expect(parseProbeLog('wildcard=no\nentry=').entryAddress).toBeUndefined();
    expect(parseProbeLog('wildcard=no\nentry=not-an-ip').entryAddress).toBeUndefined();
  });
});

describe('probeBaseDomain', () => {
  function mockStore(status: any, { createFails = false, log = 'wildcard=no\nentry=34.220.244.75\n' } = {}) {
    const methods: string[] = [];

    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        methods.push(opts.method || 'GET');

        if (opts.method === 'POST') {
          if (createFails) {
            throw new Error('forbidden');
          }

          return {};
        }

        if (opts.method === 'DELETE') {
          return {};
        }

        // The shape @rancher/shell's request action actually returns for a
        // text/plain body -- it wraps anything that is not an object.
        if (String(opts.url).endsWith('/log')) {
          return { data: log };
        }

        if (String(opts.url).includes('labelSelector')) {
          return { items: [{ metadata: { name: 'probe-pod' } }] };
        }

        return { status };
      }),
    };

    return { store, methods };
  }

  it('returns the verdict and the address from the probe log', async() => {
    const { store } = mockStore({ succeeded: 1 });

    expect(await probeBaseDomain(store, 'local', 'example.com', 'example.com')).toStrictEqual({ wildcard: false, entryAddress: '34.220.244.75' });
  });

  it('reads a wildcard that resolves', async() => {
    const { store } = mockStore({ succeeded: 1 }, { log: 'wildcard=yes\nentry=34.220.244.75\n' });

    expect((await probeBaseDomain(store, 'local', 'example.com', 'example.com')).wildcard).toBe(true);
  });

  // The script always exits 0, so a failed Job means it never ran -- which says
  // nothing about the domain.
  it('treats a failed Job as no verdict rather than a missing wildcard', async() => {
    const { store } = mockStore({ failed: 1 });

    expect(await probeBaseDomain(store, 'local', 'example.com', 'example.com')).toStrictEqual({});
  });

  it('gives no verdict when the probe cannot be created at all', async() => {
    const { store } = mockStore({ succeeded: 1 }, { createFails: true });

    expect(await probeBaseDomain(store, 'local', 'example.com', 'example.com')).toStrictEqual({});
  });

  it('gives no verdict when nothing lands before the deadline', async() => {
    const { store } = mockStore({});

    expect(await probeBaseDomain(store, 'local', 'example.com', 'example.com', 0)).toStrictEqual({});
  });

  it('does not probe a base domain that is an address, since nothing can hang under one', async() => {
    const { store } = mockStore({ succeeded: 1 });

    expect(await probeBaseDomain(store, 'local', '13.53.41.140', 'x')).toStrictEqual({});
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  // A plain DELETE orphans the probe's pod, and nothing is left to clean that
  // up once the Job carrying the TTL is gone.
  it('deletes the probe Job and its pod once it has answered', async() => {
    const urls: string[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'DELETE') {
          urls.push(String(opts.url));

          return {};
        }

        if (opts.method === 'POST') {
          return {};
        }

        if (String(opts.url).endsWith('/log')) {
          return { data: 'wildcard=no\nentry=1.2.3.4\n' };
        }

        if (String(opts.url).includes('labelSelector')) {
          return { items: [{ metadata: { name: 'probe-pod' } }] };
        }

        return { status: { succeeded: 1 } };
      }),
    };

    await probeBaseDomain(store, 'local', 'example.com', 'example.com');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('propagationPolicy=Background');
    expect(urls[0]).toContain('remuda-dns-probe-');
  });
});

describe('probeBaseDomain log shapes', () => {
  function storeReturning(logBody: any) {
    return {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'POST' || opts.method === 'DELETE') {
          return {};
        }

        if (String(opts.url).endsWith('/log')) {
          return logBody;
        }

        if (String(opts.url).includes('labelSelector')) {
          return { items: [{ metadata: { name: 'probe-pod' } }] };
        }

        return { status: { succeeded: 1 } };
      }),
    };
  }

  const answer = 'wildcard=no\nentry=34.220.244.75\n';

  // The regression: a wrapped body read as a string gives '[object Object]',
  // which parses to no verdict and silently keeps the previous base domain.
  it('reads a log the store wrapped as { data }', async() => {
    const result = await probeBaseDomain(storeReturning({ data: answer }), 'local', 'example.com', 'example.com');

    expect(result).toStrictEqual({ wildcard: false, entryAddress: '34.220.244.75' });
  });

  it('still reads a log that arrives as a plain string', async() => {
    const result = await probeBaseDomain(storeReturning(answer), 'local', 'example.com', 'example.com');

    expect(result).toStrictEqual({ wildcard: false, entryAddress: '34.220.244.75' });
  });

  // An error Status body is an object with no `data`, so it must read as no
  // verdict rather than as a missing wildcard.
  it('gives no verdict when the log endpoint returns an error object', async() => {
    const status = {
      kind: 'Status', status: 'Failure', message: 'is waiting to start: ContainerCreating'
    };
    const result = await probeBaseDomain(storeReturning(status), 'local', 'example.com', 'example.com');

    // Absent rather than false: the caller acts only on a real verdict.
    expect(result.wildcard).toBeUndefined();
    expect(result.entryAddress).toBeUndefined();
  });
});

describe('probeBaseDomain concurrency', () => {
  // The create form loads defaults twice on mount; without coalescing that is
  // two pods and two waits for one answer.
  it('runs one probe for concurrent calls with the same question', async() => {
    const creates: string[] = [];
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'POST') {
          creates.push(String(opts.url));

          return {};
        }

        if (opts.method === 'DELETE') {
          return {};
        }

        if (String(opts.url).endsWith('/log')) {
          return { data: 'wildcard=no\nentry=1.2.3.4\n' };
        }

        if (String(opts.url).includes('labelSelector')) {
          return { items: [{ metadata: { name: 'probe-pod' } }] };
        }

        return { status: { succeeded: 1 } };
      }),
    };

    const [a, b] = await Promise.all([
      probeBaseDomain(store, 'local', 'example.com', 'example.com'),
      probeBaseDomain(store, 'local', 'example.com', 'example.com'),
    ]);

    expect(a).toStrictEqual(b);
    expect(creates.filter((u) => u.includes('job'))).toHaveLength(1);
  });

  // Coalescing must not turn into caching: a later call gets a fresh probe.
  it('probes again once the first has settled', async() => {
    let jobs = 0;
    const store = {
      dispatch: jest.fn(async(_action: string, opts: any) => {
        if (opts.method === 'POST') {
          if (String(opts.url).includes('job')) {
            jobs++;
          }

          return {};
        }

        if (opts.method === 'DELETE') {
          return {};
        }

        if (String(opts.url).endsWith('/log')) {
          return { data: 'wildcard=yes\nentry=1.2.3.4\n' };
        }

        if (String(opts.url).includes('labelSelector')) {
          return { items: [{ metadata: { name: 'probe-pod' } }] };
        }

        return { status: { succeeded: 1 } };
      }),
    };

    await probeBaseDomain(store, 'local', 'example.com', 'example.com');
    await probeBaseDomain(store, 'local', 'example.com', 'example.com');

    expect(jobs).toBe(2);
  });
});
