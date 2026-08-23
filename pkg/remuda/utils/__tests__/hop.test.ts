import {
  hopEndpointSlice, hopHasDrifted, hopManifests, hopName, hopSupported
} from '../hop';
import {
  ENDPOINTS, LABEL_ENTRY_PORT, LABEL_NAME, LABEL_ROLE, LABEL_TARGET_CLUSTER, ROLE_HOP
} from '../constants';
import type { RemudaSpec } from '../../types';

const spec = (overrides: Partial<RemudaSpec> = {}): RemudaSpec => ({
  name:         'multi-idp',
  hostname:     'multi-idp.prak-bf3b08bd.ui.rancher.space',
  owner:        'user-rs864',
  namespace:    'rancher-remuda',
  clusterId:    'c-m-dff2ssd2',
  ingressClass: 'traefik',
  hop:          {
    hostClusterId:   'local',
    targetClusterId: 'c-m-dff2ssd2',
    addresses:       ['52.12.200.3'],
    addressType:     'ExternalIP',
    port:            443,
    ingressClass:    'traefik',
    clusterIssuer:   'dev-envs-le',
  },
  ...overrides,
} as RemudaSpec);

const byKind = (manifests: any[], kind: string) => manifests.find((m) => m.body.kind === kind)?.body;

describe('hopManifests', () => {
  it('produces nothing for an environment with no hop', () => {
    // A `local` target is already on the cluster the wildcard resolves to, so a
    // second Ingress for the same host would only collide with its own.
    expect(hopManifests(spec({ hop: undefined }))).toEqual([]);
  });

  it('gives the Service no selector, because its backend is another cluster', () => {
    const svc = byKind(hopManifests(spec()), 'Service');

    expect(svc.spec.selector).toBeUndefined();
    expect(svc.spec.ports).toEqual([{
      name: 'https', port: 443, targetPort: 443, protocol: 'TCP'
    }]);
  });

  it('attaches the EndpointSlice to the Service by name', () => {
    // Without kubernetes.io/service-name the Service has no backends at all and
    // the Ingress answers 503 rather than anything diagnosable.
    const slice = byKind(hopManifests(spec()), 'EndpointSlice');

    expect(slice.metadata.labels['kubernetes.io/service-name']).toBe(hopName(spec()));
    expect(slice.addressType).toBe('IPv4');
    expect(slice.endpoints).toEqual([{ addresses: ['52.12.200.3'], conditions: { ready: true } }]);
  });

  it('always targets the downstream HTTPS port, never :80', () => {
    // A hop to :80 loops: traefik rewrites inbound X-Forwarded-Proto, so Rancher
    // sees http and redirects to the same https URL, forever.
    const manifests = hopManifests(spec());

    for (const kind of ['Service', 'EndpointSlice']) {
      expect(JSON.stringify(byKind(manifests, kind))).not.toContain('"port":80');
    }
    expect(byKind(manifests, 'Ingress').spec.rules[0].http.paths[0].backend.service.port.number).toBe(443);
  });

  it('routes one path, leaving /ui-bundle to the downstream Ingress', () => {
    const paths = byKind(hopManifests(spec()), 'Ingress').spec.rules[0].http.paths;

    expect(paths).toHaveLength(1);
    expect(paths[0].path).toBe('/');
  });

  it('terminates TLS on the host cluster, using the host issuer', () => {
    const ingress = byKind(hopManifests(spec()), 'Ingress');

    expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('dev-envs-le');
    expect(ingress.spec.tls).toEqual([{ hosts: ['multi-idp.prak-bf3b08bd.ui.rancher.space'], secretName: 'multi-idp-hop-tls' }]);
  });

  it('records the target cluster and port so the host cluster is self-describing', () => {
    // The environment's own record lives on the target cluster, so without these
    // nothing on the host could tell where to re-point a drifted hop.
    const svc = byKind(hopManifests(spec()), 'Service');

    expect(svc.metadata.labels[LABEL_TARGET_CLUSTER]).toBe('c-m-dff2ssd2');
    expect(svc.metadata.labels[LABEL_ENTRY_PORT]).toBe('443');
    expect(svc.metadata.labels[LABEL_ROLE]).toBe(ROLE_HOP);
    expect(svc.metadata.labels[LABEL_NAME]).toBe('multi-idp');
  });

  describe('per ingress class', () => {
    it('gives traefik a ServersTransport and points the Service at it', () => {
      // The downstream ingress serves a self-signed cert for a host it was never
      // issued for, so the host side has to skip verification.
      const manifests = hopManifests(spec());
      const transport = byKind(manifests, 'ServersTransport');
      const svc = byKind(manifests, 'Service');

      expect(transport.spec.insecureSkipVerify).toBe(true);
      expect(svc.metadata.annotations['traefik.ingress.kubernetes.io/service.serversscheme']).toBe('https');
      expect(svc.metadata.annotations['traefik.ingress.kubernetes.io/service.serverstransport'])
        .toBe('rancher-remuda-multi-idp-hop@kubernetescrd');
    });

    it('uses an annotation and no extra object for nginx', () => {
      const nginx = spec({ hop: { ...spec().hop!, ingressClass: 'nginx' } });
      const manifests = hopManifests(nginx);

      expect(byKind(manifests, 'ServersTransport')).toBeUndefined();
      expect(manifests.some((m) => m.endpoint === ENDPOINTS.serverstransport)).toBe(false);
      expect(byKind(manifests, 'Ingress').metadata.annotations['nginx.ingress.kubernetes.io/backend-protocol'])
        .toBe('HTTPS');
    });

    it('knows which classes it can front', () => {
      expect(hopSupported('traefik')).toBe(true);
      expect(hopSupported('nginx')).toBe(true);
      expect(hopSupported('haproxy')).toBe(false);
      expect(hopSupported('')).toBe(false);
    });
  });
});

describe('hopEndpointSlice', () => {
  it('is the only object a re-sync rewrites', () => {
    const manifest = hopEndpointSlice(spec());

    expect(manifest?.endpoint).toBe(ENDPOINTS.endpointslice);
    expect(manifest?.body.kind).toBe('EndpointSlice');
  });

  it('is undefined when there is no hop to re-sync', () => {
    expect(hopEndpointSlice(spec({ hop: undefined }))).toBeUndefined();
  });
});

describe('hopHasDrifted', () => {
  it('ignores ordering', () => {
    expect(hopHasDrifted(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('notices a replaced node', () => {
    expect(hopHasDrifted(['52.12.200.3'], ['52.12.200.9'])).toBe(true);
  });

  it('notices an EndpointSlice edited or lost behind the extension\'s back', () => {
    // The case the recorded-spec comparison used to miss entirely: the target
    // cluster still reports the address it always did, and the object carrying
    // traffic no longer points at it.
    expect(hopHasDrifted(['203.0.113.99'], ['52.12.200.3'])).toBe(true);
    expect(hopHasDrifted([], ['52.12.200.3'])).toBe(true);
  });

  it('is quiet once the hop matches, so a poll does not rewrite every 15s', () => {
    expect(hopHasDrifted(['52.12.200.3'], ['52.12.200.3'])).toBe(false);
  });

  it('does not treat a failed lookup as drift', () => {
    // Re-pointing an EndpointSlice at nothing would take a working environment
    // offline on the strength of one bad read.
    expect(hopHasDrifted(['52.12.200.3'], [])).toBe(false);
  });
});

describe('hopManifests issuer', () => {
  const mirrored = (overrides: any = {}) => spec({
    hop: {
      ...(spec().hop as any),
      clusterIssuer: 'remuda-le',
      issuerKind:    'Issuer',
      acme:          { email: 'admin@example.com' },
      ...overrides,
    },
  } as any);

  it('writes the Issuer on the host cluster, before the Ingress', () => {
    // TLS terminates on the hop, so the Issuer belongs beside *this* Ingress --
    // not on the cluster the workload runs on.
    const manifests = hopManifests(mirrored());
    const kinds = manifests.map((m) => m.body.kind);

    expect(kinds).toContain('Issuer');
    expect(kinds.indexOf('Issuer')).toBeLessThan(kinds.indexOf('Ingress'));
  });

  it('annotates the hop Ingress with issuer + issuer-kind', () => {
    const ingress = byKind(hopManifests(mirrored()), 'Ingress');

    expect(ingress.metadata.annotations['cert-manager.io/issuer']).toBe('remuda-le');
    expect(ingress.metadata.annotations['cert-manager.io/issuer-kind']).toBe('Issuer');
    expect(ingress.spec.tls[0].hosts).toStrictEqual([spec().hostname]);
  });

  it('keeps the ClusterIssuer form unchanged', () => {
    // prak-bf3b08bd has a ClusterIssuer and must keep producing today's output.
    const ingress = byKind(hopManifests(spec()), 'Ingress');

    expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('dev-envs-le');
    expect(ingress.metadata.annotations['cert-manager.io/issuer-kind']).toBeUndefined();
    expect(hopManifests(spec()).map((m) => m.body.kind)).not.toContain('Issuer');
  });

  it('creates no Issuer when there is no ACME spec to copy', () => {
    const noIssuer = spec({
      hop: {
        ...(spec().hop as any), clusterIssuer: undefined, issuerKind: undefined
      }
    } as any);
    const ingress = byKind(hopManifests(noIssuer), 'Ingress');

    expect(hopManifests(noIssuer).map((m) => m.body.kind)).not.toContain('Issuer');
    expect(ingress.spec.tls).toBeUndefined();
  });
});

describe('the hop and the target never share an issuer', () => {
  /*
   * A downstream cluster has no cert-manager -- by design, because TLS
   * terminates on the host. Writing the host's Issuer into the environment's own
   * manifests made a downstream create fail outright on a 404 for the Issuer
   * CRD. The two clusters' issuers therefore live on different objects.
   */
  it('reads the ACME spec from the hop, not from the environment', () => {
    const hostOnly = spec({
      acme: undefined,
      hop:  {
        ...(spec().hop as any),
        clusterIssuer: 'remuda-le',
        issuerKind:    'Issuer',
        acme:          { email: 'admin@example.com' },
      },
    } as any);

    expect(hopManifests(hostOnly).map((m) => m.body.kind)).toContain('Issuer');
  });

  it('ignores an ACME spec that belongs to the target cluster', () => {
    // spec.acme describes the *target*; the hop must never act on it.
    const targetOnly = spec({
      acme: { email: 'target@example.com' },
      hop:  {
        ...(spec().hop as any), clusterIssuer: undefined, issuerKind: undefined, acme: undefined,
      },
    } as any);

    expect(hopManifests(targetOnly).map((m) => m.body.kind)).not.toContain('Issuer');
  });
});
