import { ENDPOINTS, LABEL_ENTRY_PORT, LABEL_TARGET_CLUSTER, ROLE_HOP } from './constants';
import { labelsFor } from './manifests';
import type { ManifestRequest, RemudaSpec } from '../types';

/** Suffix for every object the hop owns on the host cluster. */
export const hopName = (spec: RemudaSpec): string => `${ spec.name }-hop`;

/**
 * Whether this ingress class can be told to reach its backend over HTTPS.
 *
 * The hop has to arrive at the downstream ingress on :443 (see HopSpec.port),
 * and the certificate there is whatever the downstream ingress serves by
 * default -- self-signed, for a hostname it was never issued for. So the host
 * ingress has to both speak TLS upstream and skip verification, and every
 * controller spells that differently.
 */
export const HOP_SUPPORTED_CLASSES = ['traefik', 'nginx'];

const isTraefik = (ingressClass: string) => /traefik/i.test(ingressClass || '');
const isNginx = (ingressClass: string) => /nginx/i.test(ingressClass || '');

export const hopSupported = (ingressClass: string): boolean => isTraefik(ingressClass) || isNginx(ingressClass);

/**
 * Everything the host cluster needs to front one downstream environment.
 *
 * Four objects, in dependency order. The Service is deliberately selector-less:
 * its backend is a node on another cluster, so there is nothing here to select,
 * and the addresses are supplied by hand in the EndpointSlice instead. That is
 * also why the EndpointSlice is the only one of the four that is ever rewritten
 * -- replacing a downstream node changes the addresses and nothing else.
 *
 * ExternalName would be the obvious shortcut and is not usable: traefik gates it
 * behind allowExternalNameServices, and it cannot express an IP anyway.
 */
export function hopManifests(spec: RemudaSpec): ManifestRequest[] {
  const hop = spec.hop;

  if (!hop) {
    return [];
  }

  const name = hopName(spec);
  const labels = labelsFor(spec, ROLE_HOP);
  const meta = {
    name,
    namespace: spec.namespace,
    labels:    {
      ...labels,
      // Read back by anything reconciling the hop from the host cluster, which
      // has no access to the environment's record on the target cluster.
      [LABEL_TARGET_CLUSTER]: hop.targetClusterId,
      [LABEL_ENTRY_PORT]:     `${ hop.port }`,
    },
  };

  const traefik = isTraefik(hop.ingressClass);
  const manifests: ManifestRequest[] = [];

  // traefik needs a ServersTransport to skip verification; nginx does it with an
  // Ingress annotation and no extra object.
  if (traefik) {
    manifests.push({
      endpoint: ENDPOINTS.serverstransport,
      body:     {
        apiVersion: 'traefik.io/v1alpha1',
        kind:       'ServersTransport',
        metadata:   {
          name, namespace: spec.namespace, labels
        },
        spec: { insecureSkipVerify: true },
      },
    });
  }

  manifests.push({
    endpoint: ENDPOINTS.service,
    body:     {
      apiVersion: 'v1',
      kind:       'Service',
      metadata:   {
        ...meta,
        ...(traefik ? {
          annotations: {
            'traefik.ingress.kubernetes.io/service.serversscheme':    'https',
            // Namespace-qualified and provider-suffixed: traefik's own naming
            // for a CRD reference from the Ingress provider.
            'traefik.ingress.kubernetes.io/service.serverstransport': `${ spec.namespace }-${ name }@kubernetescrd`,
          },
        } : {}),
      },
      spec: {
        // No selector on purpose -- see the note above.
        ports: [{
          name: 'https', port: hop.port, targetPort: hop.port, protocol: 'TCP',
        }],
      },
    },
  });

  manifests.push({
    endpoint: ENDPOINTS.endpointslice,
    body:     {
      apiVersion: 'discovery.k8s.io/v1',
      kind:       'EndpointSlice',
      metadata:   {
        ...meta,
        labels: {
          ...meta.labels,
          // How the EndpointSlice is attached to the Service. Without this the
          // Service has no backends and the Ingress 503s.
          'kubernetes.io/service-name': name,
        },
      },
      addressType: 'IPv4',
      ports:       [{
        name: 'https', port: hop.port, protocol: 'TCP'
      }],
      endpoints: hop.addresses.map((address) => ({ addresses: [address], conditions: { ready: true } })),
    },
  });

  manifests.push({
    endpoint: ENDPOINTS.ingress,
    body:     {
      apiVersion: 'networking.k8s.io/v1',
      kind:       'Ingress',
      metadata:   {
        ...meta,
        annotations: {
          ...(hop.clusterIssuer ? { 'cert-manager.io/cluster-issuer': hop.clusterIssuer } : {}),
          ...(isNginx(hop.ingressClass) ? { 'nginx.ingress.kubernetes.io/backend-protocol': 'HTTPS' } : {}),
        },
      },
      spec: {
        ingressClassName: hop.ingressClass,
        rules:            [{
          host: spec.hostname,
          http: {
            // One path, not two. The downstream Ingress already splits
            // /ui-bundle from '/', and re-splitting it here would duplicate a
            // decision in a second place that has to be kept in step.
            paths: [{
              path:     '/',
              pathType: 'Prefix',
              backend:  { service: { name, port: { number: hop.port } } },
            }],
          },
        }],
        ...(hop.clusterIssuer ? { tls: [{ hosts: [spec.hostname], secretName: `${ name }-tls` }] } : {}),
      },
    },
  });

  return manifests;
}

/** Just the EndpointSlice, for re-pointing a hop whose addresses have drifted. */
export function hopEndpointSlice(spec: RemudaSpec): ManifestRequest | undefined {
  return hopManifests(spec).find((m) => m.endpoint === ENDPOINTS.endpointslice);
}

/**
 * True when the hop is not sending traffic where the target cluster now says it
 * should be.
 *
 * Both sides matter. `current` must be read from the **EndpointSlice on the host
 * cluster** -- the object actually carrying traffic -- and not from the recorded
 * HopSpec, which is a snapshot taken at create and never updated. Comparing the
 * snapshot against the live cluster looks equivalent and is not: it misses an
 * EndpointSlice that was edited or lost, and after a genuine node replacement it
 * stays unequal forever, so every poll rewrites an object that is already
 * correct.
 *
 * An empty `desired` is not drift. Re-pointing a working hop at nothing on the
 * strength of one failed lookup would take the environment down.
 */
export function hopHasDrifted(current: string[], desired: string[]): boolean {
  if (!desired.length) {
    return false;
  }

  const sorted = (list: string[]) => [...(list || [])].sort().join(',');

  return sorted(current) !== sorted(desired);
}
