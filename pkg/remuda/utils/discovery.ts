import {
  CONFIG_MAP_NAME, DEFAULT_BACKEND_IMAGE, DEFAULT_NESTED_POD_CIDR, DEFAULT_NESTED_SERVICE_CIDR,
  REMUDA_NS, ENDPOINTS, HOST_CLUSTER_ID, NESTED_CIDR_CANDIDATES, REMUDA_ISSUER_NAME,
  WILDCARD_DNS_SUFFIX, DNS_PROBE_TIMEOUT_MS,
} from './constants';
import { create, ensureNamespace, list, remove } from './api';
import { dnsProbeJobManifest } from './manifests';
import { hopSupported } from './hop';
import type {
  AcmeIssuer, ClusterDefaults, DirectReason, Exposure, IngressEntry, IssuerKind,
} from '../types';

/**
 * The wildcard DNS record is created under the host Rancher's own domain, so
 * server-url is exactly the right source for the base domain.
 */
export function baseDomainFromServerUrl(serverUrl: string): string {
  return (serverUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Derive a hostname for an environment. Kept pure so it can be unit tested. */
export const hostnameFor = (name: string, baseDomain: string): string => `${ name }.${ baseDomain }`;

/**
 * Whether a base domain is a bare IPv4 address rather than a name.
 *
 * A Rancher installed with no DNS record answers on its address, so server-url
 * is an IP and baseDomainFromServerUrl hands back `13.53.41.140`. Nothing can be
 * hung under that: `name.13.53.41.140` is not a hostname and no record can make
 * it one, so an environment named off it is unreachable however well everything
 * else is wired. That is a different condition from having no base domain at
 * all, and it is the one that decides an environment cannot go through the host
 * cluster.
 */
export function isIpLiteral(domain: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(domain || '') &&
    (domain || '').split('.').every((octet) => Number(octet) <= 255);
}

/**
 * A wildcard base domain for an address that has no DNS of its own.
 *
 * Empty for anything that is not an IPv4 address -- a LoadBalancer that gives
 * out a hostname (an ELB, say) already *has* a name, and wrapping it in
 * sslip.io would produce something that resolves to nothing. The caller then
 * has no base domain to offer and the form asks for one, which is the honest
 * outcome.
 */
export function wildcardDomainFor(address: string): string {
  return isIpLiteral(address) ? `${ address }.${ WILDCARD_DNS_SUFFIX }` : '';
}

/** Whether a base domain is one this extension derived from an address. */
export const isWildcardFallbackDomain = (domain: string): boolean => (domain || '').endsWith(`.${ WILDCARD_DNS_SUFFIX }`);

/**
 * What the cluster's own resolver says about a base domain.
 *
 * `wildcard` is three-valued on purpose. `true` and `false` are the probe's
 * verdict; `undefined` means it never reached one -- no permission to create the
 * Job, no node to schedule it, an image it could not pull, or the caller gave up
 * waiting. That distinction is the whole point: an inconclusive probe must leave
 * the base domain alone. Rewriting a working domain to sslip.io because a Job
 * could not be scheduled would break a cluster that was fine, which is a worse
 * failure than the one this exists to catch.
 *
 * `entryAddress` is where the host Rancher's own name resolves, which is the
 * address to build a fallback hostname on. See dnsProbeScript for why it is not
 * read off the ingress Service.
 */
export async function probeBaseDomain(
  store: any, clusterId: string, baseDomain: string, serverHost: string, timeoutMs = DNS_PROBE_TIMEOUT_MS
): Promise<{ wildcard?: boolean; entryAddress?: string }> {
  if (!baseDomain || isIpLiteral(baseDomain) || !serverHost) {
    return {};
  }

  // The create form loads its defaults twice on mount -- onMounted assigns
  // clusterId, which fires the watcher, and then calls loadDefaults itself --
  // which used to cost a duplicate API call and now would cost a second pod and
  // a second wait for the same answer. Coalesce only what is genuinely in
  // flight: the entry is dropped as soon as it settles, so this never serves a
  // stale verdict.
  const key = `${ clusterId }|${ baseDomain }|${ serverHost }`;
  const inFlight = probesInFlight.get(key);

  if (inFlight) {
    return inFlight;
  }

  const run = runProbe(store, clusterId, baseDomain, serverHost, timeoutMs)
    .finally(() => probesInFlight.delete(key));

  probesInFlight.set(key, run);

  return run;
}

const probesInFlight = new Map<string, Promise<{ wildcard?: boolean; entryAddress?: string }>>();

async function runProbe(
  store: any, clusterId: string, baseDomain: string, serverHost: string, timeoutMs: number
): Promise<{ wildcard?: boolean; entryAddress?: string }> {
  // Lowercase: a DNS label is case-insensitive, but a Kubernetes object name is
  // not allowed uppercase at all, and this string is both.
  const probeId = `p${ Math.random().toString(36).slice(2, 10) }`.toLowerCase();
  const manifest = dnsProbeJobManifest(baseDomain, probeId, serverHost);
  const name = manifest.body.metadata.name;

  try {
    await ensureNamespace(store, clusterId);
    await create(store, clusterId, manifest);
  } catch {
    return {};
  }

  try {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.job }/${ REMUDA_NS }/${ name }` }).catch(() => undefined);

      // The script always exits 0, so a failed Job means something stopped it
      // from running at all -- which is not a verdict about the domain.
      if (job?.status?.failed) {
        return {};
      }

      if (job?.status?.succeeded) {
        return parseProbeLog(await probeLog(store, clusterId, name));
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {};
  } finally {
    // ttlSecondsAfterFinished would get there eventually; this keeps the
    // namespace tidy for the common case where the answer arrived.
    //
    // Cascading, so the probe's *pod* goes with its Job. A plain delete orphans
    // it, and an orphaned probe pod has nothing left to collect it -- the TTL
    // that would have is a field on the Job -- so every create would leave one
    // behind for good.
    remove(store, clusterId, ENDPOINTS.job, REMUDA_NS, name, true).catch(() => undefined);
  }
}

/**
 * The probe pod's log.
 *
 * Read through the core API rather than Steve: this is a subresource, and Steve
 * models resources rather than proxying arbitrary subresources of them.
 */
async function probeLog(store: any, clusterId: string, jobName: string): Promise<string> {
  const base = `/k8s/clusters/${ clusterId }/api/v1/namespaces/${ REMUDA_NS }/pods`;

  try {
    const pods = await store.dispatch('management/request', { url: `${ base }?labelSelector=job-name%3D${ jobName }` });
    const pod = pods?.items?.[0]?.metadata?.name;

    if (!pod) {
      return '';
    }

    const res = await store.dispatch('management/request', { url: `${ base }/${ pod }/log` });

    // The store's request action wraps any non-object body: `responseObject` in
    // @rancher/shell's steve actions does `out = { data: out }` when the parsed
    // response is not an object. A pod log is text/plain, so it arrives as
    // `{ data: '<log>' }` rather than as the string, and reading it as a string
    // silently yields '[object Object]' -- which parses to no verdict at all,
    // and leaves the base domain on whatever was saved last.
    return (typeof res === 'string' ? res : res?.data) || '';
  } catch {
    return '';
  }
}

/** `wildcard=yes|no` and `entry=<address>`, one per line. */
export function parseProbeLog(log: string): { wildcard?: boolean; entryAddress?: string } {
  const value = (key: string) => (String(log || '').match(new RegExp(`^${ key }=(.*)$`, 'm'))?.[1] || '').trim();
  const wildcard = value('wildcard');
  const entry = value('entry');

  return {
    // An absent or unrecognised line is not a "no" -- it means the probe did not
    // answer, and the caller must not act on it.
    wildcard:     wildcard === 'yes' ? true : (wildcard === 'no' ? false : undefined),
    entryAddress: isIpLiteral(entry) ? entry : undefined,
  };
}

/**
 * How an environment on this target will actually be reached.
 *
 * Three cases, and the third is why this exists:
 *
 * - `local`: the environment's own Ingress is already on the cluster the base
 *   domain resolves to. Nothing to arrange.
 * - `hop`: the normal downstream case. The host cluster fronts the environment,
 *   which needs an ingress controller there that can be pointed upstream over
 *   HTTPS, and a base domain that can carry a subdomain.
 * - `direct`: the fallback. The host cluster cannot front anything -- most often
 *   a Rancher running in docker, whose k3s starts with traefik and servicelb
 *   disabled and so has no IngressClass at all -- so the hop is skipped and the
 *   environment is named off the *target* cluster's own ingress address
 *   instead. The Ingress written next to the workload then serves it directly,
 *   exactly as it does for `local`.
 *
 * `reason` is carried out so the form can say which of the three conditions put
 * it in the fallback, rather than announcing an unexplained change of address.
 */
export function exposureFor(input: {
  targetsLocal: boolean;
  hostIngressClass: string;
  hostBaseDomain: string;
}): { mode: Exposure; reason?: DirectReason } {
  if (input.targetsLocal) {
    return { mode: 'local' };
  }

  if (!input.hostIngressClass) {
    return { mode: 'direct', reason: 'noHostIngress' };
  }

  if (!hopSupported(input.hostIngressClass)) {
    return { mode: 'direct', reason: 'hostClassUnsupported' };
  }

  if (isIpLiteral(input.hostBaseDomain)) {
    return { mode: 'direct', reason: 'baseDomainIsIp' };
  }

  return { mode: 'hop' };
}

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

/**
 * The first ACME Issuer on the cluster, whatever namespace it is in.
 *
 * A stock Rancher provisions exactly one: `cattle-system/rancher`, created by
 * the Rancher Helm chart for the server's own certificate. It is never usable
 * directly -- `cert-manager.io/issuer` resolves in the *Ingress's* namespace, so
 * an Issuer in cattle-system is invisible to an Ingress in rancher-remuda -- but
 * its ACME configuration is exactly what a new Issuer in our own namespace
 * needs, and it is the only issuer a cluster is guaranteed to have.
 *
 * Non-ACME issuers (selfSigned, ca, vault) are skipped: mirroring a selfSigned
 * issuer would produce the same untrusted certificate traefik already serves by
 * default, which is worse than no TLS because it looks configured.
 */
async function firstAcmeIssuer(store: any, clusterId: string): Promise<AcmeIssuer | undefined> {
  try {
    const res = await store.dispatch('management/request', { url: `/k8s/clusters/${ clusterId }/v1/${ ENDPOINTS.issuer }` });
    const found = (res?.data || []).find((i: any) => i?.spec?.acme);

    if (!found) {
      return undefined;
    }

    return {
      source: `${ found.metadata?.namespace }/${ found.metadata?.name }`,
      spec:   found.spec.acme,
    };
  } catch {
    return undefined;
  }
}

/**
 * How this cluster can issue certificates, in order of preference.
 *
 * A ClusterIssuer wins because it is explicit operator configuration and works
 * across namespaces as-is. Falling back to mirroring a namespaced ACME Issuer is
 * what removes the manual prerequisite on a stock cluster -- see
 * REMUDA_ISSUER_NAME.
 */
async function issuerFor(store: any, clusterId: string): Promise<{ clusterIssuer?: string; issuerKind?: IssuerKind; acme?: AcmeIssuer }> {
  const clusterIssuer = await firstClusterIssuer(store, clusterId);

  if (clusterIssuer) {
    return { clusterIssuer, issuerKind: 'ClusterIssuer' };
  }

  const acme = await firstAcmeIssuer(store, clusterId);

  if (!acme) {
    return {};
  }

  return {
    clusterIssuer: REMUDA_ISSUER_NAME, issuerKind: 'Issuer', acme
  };
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
 * The *host* cluster's ingress class, domain and issuer, for the hop's own
 * Ingress.
 *
 * TLS terminates on the host, so the issuer is read there and not on the target
 * -- which is why a downstream cluster needs no cert-manager at all.
 *
 * The domain is the host Rancher's own, straight from server-url and never the
 * target cluster's saved override, because what it is used for is deciding
 * whether the host can front an environment at all. See exposureFor().
 */
export async function hostIngressDefaults(store: any): Promise<{ ingressClass: string; baseDomain: string; clusterIssuer?: string; issuerKind?: IssuerKind; acme?: AcmeIssuer }> {
  const [ingressClass, url, issuer] = await Promise.all([
    firstIngressClass(store, HOST_CLUSTER_ID),
    serverUrl(store),
    issuerFor(store, HOST_CLUSTER_ID),
  ]);

  return {
    ingressClass,
    baseDomain: baseDomainFromServerUrl(url),
    ...issuer,
  };
}

export async function discoverDefaults(store: any, clusterId: string): Promise<ClusterDefaults> {
  const [url, version, ingressClass, storage, issuer, nested, saved] = await Promise.all([
    serverUrl(store),
    serverVersion(store),
    firstIngressClass(store, clusterId),
    storageClasses(store, clusterId),
    issuerFor(store, clusterId),
    hostCidrs(store, clusterId),
    savedDefaults(store, clusterId),
  ]);

  return {
    baseDomain:        baseDomainFromServerUrl(url),
    serverVersion:     version,
    ingressClass,
    storageClass:      storage.preferred,
    ...issuer,
    ...nested,
    ...saved,
    // After `saved` for the same reason as hasStorageClass below: both describe
    // the cluster as it is now, and neither is the user's to override.
    derivedBaseDomain: baseDomainFromServerUrl(url),
    // After `saved` on purpose: this describes the cluster as it is right now,
    // and a stale persisted value must never mask a cluster that has since lost
    // its storage.
    hasStorageClass:   storage.found,
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
