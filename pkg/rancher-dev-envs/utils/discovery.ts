import {
  CONFIG_MAP_NAME, DEFAULT_BACKEND_IMAGE, DEFAULT_NESTED_POD_CIDR, DEFAULT_NESTED_SERVICE_CIDR,
  DEV_ENV_NS, ENDPOINTS, NESTED_CIDR_CANDIDATES,
} from './constants';
import { create, list } from './api';
import type { ClusterDefaults } from '../types';

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

async function defaultStorageClass(store: any, clusterId: string): Promise<string | undefined> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.storageclass }` });
    const classes = res?.data || [];
    const marked = classes.find(
      (c: any) => c.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
    );

    // Undefined rather than '' so the PVC omits the key entirely.
    return marked?.metadata?.name || classes[0]?.metadata?.name || undefined;
  } catch {
    return undefined;
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

export async function discoverDefaults(store: any, clusterId: string): Promise<ClusterDefaults> {
  const [url, version, ingressClass, storageClass, clusterIssuer, nested, saved] = await Promise.all([
    serverUrl(store),
    serverVersion(store),
    firstIngressClass(store, clusterId),
    defaultStorageClass(store, clusterId),
    firstClusterIssuer(store, clusterId),
    hostCidrs(store, clusterId),
    savedDefaults(store, clusterId),
  ]);

  return {
    baseDomain:    baseDomainFromServerUrl(url),
    serverVersion: version,
    ingressClass,
    storageClass,
    clusterIssuer,
    ...nested,
    ...saved,
  };
}

export async function saveDefaults(store: any, clusterId: string, defaults: ClusterDefaults): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: CONFIG_MAP_NAME, namespace: DEV_ENV_NS },
    data:       { defaults: JSON.stringify(defaults, null, 2) },
  };

  try {
    await store.dispatch('management/request', {
      url:    `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.configmap }/${ DEV_ENV_NS }/${ CONFIG_MAP_NAME }`,
      method: 'PUT',
      data:   body,
    });
  } catch {
    await create(store, clusterId, { endpoint: ENDPOINTS.configmap, body });
  }
}
