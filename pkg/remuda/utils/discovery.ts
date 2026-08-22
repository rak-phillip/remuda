import {
  CONFIG_MAP_NAME, DEFAULT_BACKEND_IMAGE, DEFAULT_NESTED_POD_CIDR, DEFAULT_NESTED_SERVICE_CIDR,
  REMUDA_NS, ENDPOINTS, HOST_CLUSTER_ID, NESTED_CIDR_CANDIDATES,
} from './constants';
import { create, list } from './api';
import type { ClusterDefaults, IngressEntry } from '../types';

/**
 * The wildcard DNS record is created under the host Rancher's own domain, so
 * server-url is exactly the right source for the base domain.
 */
export function baseDomainFromServerUrl(serverUrl: string): string {
  return (serverUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Derive a hostname for an environment. Kept pure so it can be unit tested. */
export const hostnameFor = (name: string, baseDomain: string): string => `${ name }.${ baseDomain }`;

/** Minor version as a sortable number, e.g. 'v2.16-abc-head' -> 2.16. */
function minorOf(version: string): number | undefined {
  const match = (version || '').match(/(\d+)\.(\d+)/);

  return match ? Number(match[1]) + (Number(match[2]) / 1000) : undefined;
}

/**
 * Pick a backend image for a dashboard branch.
 *
 * There is no reliable Rancher version signal on a feature branch -- package.json
 * is 0.0.0 and scripts/version falls back to the commit SHA when no tag contains
 * HEAD -- so only a `release-X.Y` branch says anything, and everything else gets
 * the plain head image.
 *
 * The wrinkle is that the line currently being developed on main has **no**
 * `vX.Y-head` floating tag on Docker Hub; it is published as plain `head` (plus
 * per-commit `vX.Y-<sha>-head` tags). Only older, branched lines get the
 * `vX.Y-head` alias. Rather than hardcode which minor that is -- it moves every
 * release -- compare against the host Rancher's own version, which the extension
 * already reads from settings. A branch at or ahead of the host's line is the
 * main line, so it takes `head`.
 */
export function backendImageForBranch(branch: string, hostVersion?: string): string {
  const release = (branch || '').match(/release-(\d+\.\d+)/);

  if (!release) {
    return DEFAULT_BACKEND_IMAGE;
  }

  const branchMinor = minorOf(release[1]);
  const hostMinor = minorOf(hostVersion || '');

  if (branchMinor !== undefined && hostMinor !== undefined && branchMinor >= hostMinor) {
    return DEFAULT_BACKEND_IMAGE;
  }

  return `rancher/rancher:v${ release[1] }-head`;
}

/** First and last address of an IPv4 CIDR, as unsigned 32-bit numbers. */
function cidrRange(cidr: string): [number, number] | undefined {
  const [address, bits] = (cidr || '').split('/');
  const octets = (address || '').split('.').map(Number);
  const prefix = Number(bits);

  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return undefined;
  }

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined;
  }

  // >>> 0 throughout: JS bitwise ops yield signed 32-bit, and these addresses
  // run past 2^31 once the first octet is >= 128.
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  const start = (value & (prefix === 0 ? 0 : (-1 << (32 - prefix)))) >>> 0;

  return [start, start + size - 1];
}

export function cidrsOverlap(a: string, b: string): boolean {
  const rangeA = cidrRange(a);
  const rangeB = cidrRange(b);

  // An unparseable CIDR is treated as overlapping, so an unknown host range
  // makes us move on to the next candidate rather than risk the collision.
  if (!rangeA || !rangeB) {
    return true;
  }

  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

/**
 * Widen an address to its containing /16.
 *
 * What is readable from the host is a *node's* podCIDR (a /24 slice) and the
 * ClusterIP of the kubernetes Service -- neither states the cluster-wide range.
 * Rounding out to a /16 covers the usual k3s defaults and errs towards claiming
 * more of the host than it really uses, which only ever rejects a candidate.
 */
export function widenToSixteen(cidr: string): string {
  const [address] = (cidr || '').split('/');
  const octets = address.split('.');

  return octets.length === 4 ? `${ octets[0] }.${ octets[1] }.0.0/16` : '';
}

/**
 * Pick CIDRs for the nested k3s that do not collide with the host cluster's.
 *
 * Falls back to the first candidate when every one of them overlaps -- at that
 * point there is nothing better to do than let the environment start and report
 * the failure, rather than refuse to create it.
 */
export function pickNestedCidrs(hostPodCidr: string, hostServiceCidr: string): { nestedPodCidr: string; nestedServiceCidr: string } {
  const hostRanges = [hostPodCidr, hostServiceCidr].filter(Boolean);

  const free = NESTED_CIDR_CANDIDATES.find((candidate) => !hostRanges.some(
    (host) => cidrsOverlap(candidate.podCidr, host) || cidrsOverlap(candidate.serviceCidr, host)
  ));

  return {
    nestedPodCidr:     free?.podCidr || DEFAULT_NESTED_POD_CIDR,
    nestedServiceCidr: free?.serviceCidr || DEFAULT_NESTED_SERVICE_CIDR,
  };
}

/** The host's pod and service ranges, as far as they can be read back. */
async function hostCidrs(store: any, clusterId: string): Promise<{ nestedPodCidr: string; nestedServiceCidr: string }> {
  const read = async(url: string) => {
    try {
      return await store.dispatch('management/request', { url });
    } catch {
      return undefined;
    }
  };

  const [nodes, kubernetes] = await Promise.all([
    read(`/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.node }`),
    read(`/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.service }/default/kubernetes`),
  ]);

  const podCidr = (nodes?.data || []).map((n: any) => n?.spec?.podCIDR).find(Boolean) || '';
  const serviceIp = kubernetes?.spec?.clusterIP || '';

  return pickNestedCidrs(widenToSixteen(podCidr), widenToSixteen(serviceIp));
}

async function serverUrl(store: any): Promise<string> {
  try {
    const setting = await store.dispatch('management/find', {
      type: 'management.cattle.io.setting',
      id:   'server-url',
    });

    return setting?.value || setting?.default || '';
  } catch {
    return '';
  }
}

async function serverVersion(store: any): Promise<string> {
  try {
    const setting = await store.dispatch('management/find', {
      type: 'management.cattle.io.setting',
      id:   'server-version',
    });

    return setting?.value || setting?.default || '';
  } catch {
    return '';
  }
}

async function firstIngressClass(store: any, clusterId: string): Promise<string> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.ingressclass }` });
    const classes = res?.data || [];
    const marked = classes.find(
      (c: any) => c.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
    );

    return (marked || classes[0])?.metadata?.name || '';
  } catch {
    return '';
  }
}

/**
 * What storage the cluster can actually provision.
 *
 * `found` is reported separately from `preferred` because the two mean very
 * different things. A cluster with no StorageClass at all cannot bind any of an
 * environment's three PVCs, so the build pod never schedules -- it fails with
 * "pod has unbound immediate PersistentVolumeClaims" some minutes later, which
 * is a miserable way to find out. `found: false` is what lets the create form
 * say so up front, and it is deliberately distinct from a *failed lookup*, which
 * should not block anyone.
 */
async function storageClasses(store: any, clusterId: string): Promise<{ found: boolean; preferred?: string }> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.storageclass }` });
    const classes = res?.data || [];
    const marked = classes.find(
      (c: any) => c.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
    );

    return {
      found:     classes.length > 0,
      // Undefined rather than '' so the PVC omits the key entirely.
      preferred: marked?.metadata?.name || classes[0]?.metadata?.name || undefined,
    };
  } catch {
    // Could not tell. Assume the cluster is fine rather than block on a lookup
    // the user may simply lack permission for.
    return { found: true };
  }
}

async function firstClusterIssuer(store: any, clusterId: string): Promise<string | undefined> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.clusterissuer }` });

    return res?.data?.[0]?.metadata?.name || undefined;
  } catch {
    return undefined;
  }
}

/** Persisted defaults win over discovered ones, so an override sticks. */
async function savedDefaults(store: any, clusterId: string): Promise<Partial<ClusterDefaults>> {
  try {
    const res = await list(store, clusterId, ENDPOINTS.configmap);
    const cm = (res?.data || []).find((c: any) => c.metadata?.name === CONFIG_MAP_NAME);

    return cm?.data ? JSON.parse(cm.data.defaults || '{}') : {};
  } catch {
    return {};
  }
}

/**
 * Address a hop should dial to reach a downstream ingress.
 *
 * ExternalIP is preferred, which is the opposite of what seems safest and was
 * measured the hard way: from the host cluster, the downstream node's InternalIP
 * (10.0.12.23, alongside the host's own 10.0.16.140) times out on every port.
 * The two are not one routable network merely because both sit inside 10.0.0.0/16
 * -- node-driver nodes get their own VPC. Meanwhile a node that has *no*
 * ExternalIP is by construction on a private network, which is exactly when
 * InternalIP is both the only and the correct answer. So: take the public address
 * when there is one, and record which was taken so the UI can say that the hop
 * leaves the VPC.
 */
async function nodeAddresses(store: any, clusterId: string): Promise<Pick<IngressEntry, 'addresses' | 'addressType'>> {
  const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.node }` });
  const nodes = res?.data || [];
  const ofType = (type: string) => nodes
    .map((n: any) => (n?.status?.addresses || []).find((a: any) => a.type === type)?.address)
    .filter(Boolean);

  const external = ofType('ExternalIP');

  return external.length ? { addresses: external, addressType: 'ExternalIP' } : { addresses: ofType('InternalIP'), addressType: 'InternalIP' };
}

/** An ingress controller's own Service or DaemonSet, found by ingress class name. */
const namedForClass = (objects: any[], ingressClass: string) => {
  const needle = (ingressClass || '').toLowerCase();

  return objects.filter((o: any) => {
    const name = (o?.metadata?.name || '').toLowerCase();
    const app = (o?.metadata?.labels?.['app.kubernetes.io/name'] || '').toLowerCase();

    return !!needle && (name.includes(needle) || app.includes(needle));
  });
};

const httpsPort = (ports: any[]) => (ports || []).find((p: any) => p.name === 'websecure' || p.name === 'https' || p.port === 443 || p.containerPort === 8443);

/**
 * Where a cluster's ingress controller can be reached from outside it.
 *
 * Always the HTTPS entry point -- a hop to :80 cannot work, see HopSpec.port.
 * The three cases are tried in descending order of stability, each swallowing
 * its own failure the way firstIngressClass() and storageClasses() do, because
 * a cluster that answers none of them should degrade to "could not tell" rather
 * than block a create.
 *
 * On RKE2 it is the third case: rke2-traefik is a DaemonSet with hostPort 443
 * behind a ClusterIP Service, because the RKE2 cloud provider runs with
 * --controllers=*,-service and so a LoadBalancer Service would never be filled in.
 */
export async function ingressEntry(store: any, clusterId: string, ingressClass: string): Promise<IngressEntry | undefined> {
  const read = async(endpoint: string) => {
    try {
      const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ endpoint }` });

      return res?.data || [];
    } catch {
      return [];
    }
  };

  try {
    const [services, daemonsets] = await Promise.all([read(ENDPOINTS.service), read(ENDPOINTS.daemonset)]);
    const candidates = namedForClass(services, ingressClass);

    // 1. A real load balancer. Stable, and the only case that does not drift.
    for (const svc of candidates) {
      const address = (svc?.status?.loadBalancer?.ingress || [])
        .map((i: any) => i.ip || i.hostname)
        .filter(Boolean);
      const port = httpsPort(svc?.spec?.ports);

      if (svc?.spec?.type === 'LoadBalancer' && address.length && port) {
        return {
          addresses: address, addressType: 'ExternalIP', port: port.port || 443
        };
      }
    }

    // 2. NodePort. Node addresses, and the port the controller was assigned.
    for (const svc of candidates) {
      const port = httpsPort(svc?.spec?.ports);

      if (svc?.spec?.type === 'NodePort' && port?.nodePort) {
        return { ...await nodeAddresses(store, clusterId), port: port.nodePort };
      }
    }

    // 3. hostPort DaemonSet. The controller is bound straight onto the nodes.
    for (const ds of namedForClass(daemonsets, ingressClass)) {
      const containers = ds?.spec?.template?.spec?.containers || [];
      const port = containers
        .flatMap((c: any) => c.ports || [])
        .find((p: any) => p.hostPort === 443 || p.name === 'websecure');

      if (port?.hostPort) {
        return { ...await nodeAddresses(store, clusterId), port: port.hostPort };
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The *host* cluster's ingress class and issuer, for the hop's own Ingress.
 *
 * TLS terminates on the host, so these are read there and not on the target --
 * which is why a downstream cluster needs no cert-manager at all.
 */
export async function hostIngressDefaults(store: any): Promise<{ ingressClass: string; clusterIssuer?: string }> {
  const [ingressClass, clusterIssuer] = await Promise.all([
    firstIngressClass(store, HOST_CLUSTER_ID),
    firstClusterIssuer(store, HOST_CLUSTER_ID),
  ]);

  return { ingressClass, clusterIssuer };
}

export async function discoverDefaults(store: any, clusterId: string): Promise<ClusterDefaults> {
  const [url, version, ingressClass, storage, clusterIssuer, nested, saved] = await Promise.all([
    serverUrl(store),
    serverVersion(store),
    firstIngressClass(store, clusterId),
    storageClasses(store, clusterId),
    firstClusterIssuer(store, clusterId),
    hostCidrs(store, clusterId),
    savedDefaults(store, clusterId),
  ]);

  return {
    baseDomain:      baseDomainFromServerUrl(url),
    serverVersion:   version,
    ingressClass,
    storageClass:    storage.preferred,
    clusterIssuer,
    ...nested,
    ...saved,
    // After `saved` on purpose: this describes the cluster as it is right now,
    // and a stale persisted value must never mask a cluster that has since lost
    // its storage.
    hasStorageClass: storage.found,
  };
}

/**
 * Persist this cluster's defaults so the next create prefills.
 *
 * The ConfigMap is shared by every environment on the cluster, so this is an
 * upsert, and it has to read before it writes: Steve rejects an update that
 * carries no resourceVersion with "metadata.resourceVersion is required for
 * update". An earlier version PUT without one and fell back to POST on failure,
 * which meant the PUT *always* failed and the POST then always returned
 * `configmaps "remuda-config" already exists` -- so every create after the
 * first one on a given cluster reported an error.
 *
 * Reading first also makes the write a compare-and-swap rather than a blind
 * overwrite, so two people creating at once cannot silently clobber each other.
 */
export async function saveDefaults(store: any, clusterId: string, defaults: ClusterDefaults): Promise<void> {
  const url = `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.configmap }/${ REMUDA_NS }/${ CONFIG_MAP_NAME }`;
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: CONFIG_MAP_NAME, namespace: REMUDA_NS },
    data:       { defaults: JSON.stringify(defaults, null, 2) },
  };

  let existing: any;

  try {
    existing = await store.dispatch('management/request', { url });
  } catch {
    existing = undefined;
  }

  if (!existing) {
    await create(store, clusterId, { endpoint: ENDPOINTS.configmap, body });

    return;
  }

  await store.dispatch('management/request', {
    url,
    method: 'PUT',
    data:   {
      ...body,
      metadata: { ...body.metadata, resourceVersion: existing.metadata?.resourceVersion },
    },
  });
}
