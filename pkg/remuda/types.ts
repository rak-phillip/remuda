/** Where a cluster's ingress controller answers HTTPS from outside the cluster. */
export interface IngressEntry {
  addresses: string[];
  addressType: 'ExternalIP' | 'InternalIP';
  port: number;
}

/**
 * Where an environment's hostname resolves to, which decides what has to be
 * built for it. See exposureFor().
 */
export type Exposure = 'local' | 'hop' | 'direct';

/** Why the host cluster could not front an environment. One per condition. */
export type DirectReason = 'noHostIngress' | 'hostClassUnsupported' | 'baseDomainIsIp';

/**
 * How an environment on a downstream cluster is reached.
 *
 * The hostname comes off the host Rancher's own wildcard (see
 * baseDomainFromServerUrl), so it only ever resolves to the host cluster's
 * ingress. For a downstream target that means the Ingress created next to the
 * workload is correct and simply never receives traffic; the host cluster has
 * to front it.
 *
 * Absent on a downstream environment means `direct` exposure, not that the hop
 * was forgotten: the host cluster could not front it, so the environment is
 * named off the target cluster's own ingress instead and its own Ingress does
 * the serving. Also absent on `local`, where that was always true.
 */
export interface HopSpec {
  /** Cluster the wildcard resolves to, i.e. HOST_CLUSTER_ID. */
  hostClusterId: string;
  /** Cluster the workload actually runs on. */
  targetClusterId: string;
  /**
   * Downstream ingress entry addresses. The only part of the topology that
   * drifts -- replacing a node changes it -- so it is re-resolved and rewritten
   * rather than trusted for the environment's lifetime.
   */
  addresses: string[];
  /**
   * Which address family was picked, surfaced in the UI because the two have
   * very different security properties: an ExternalIP hop leaves the VPC.
   */
  addressType: 'ExternalIP' | 'InternalIP';
  /**
   * Always the downstream ingress's *HTTPS* entry point.
   *
   * Not :80. Traefik rewrites inbound X-Forwarded-* from an untrusted peer, so a
   * hop arriving on :80 reaches Rancher as X-Forwarded-Proto: http no matter what
   * the host sent, and Rancher redirects to https -- straight back to the same
   * URL, forever. Arriving on :443 lets the downstream ingress terminate TLS and
   * set the header itself, which is exactly what makes it work on `local`.
   */
  port: number;
  /** Host cluster's ingress class, not the target's. */
  ingressClass: string;
  /** Host cluster's issuer. TLS terminates here, so the target needs none. */
  clusterIssuer?: string;
  /** Defaults to ClusterIssuer when absent -- see IssuerKind. */
  issuerKind?: IssuerKind;
  /**
   * The host cluster's ACME spec, when its issuer has to be mirrored.
   *
   * Deliberately separate from RemudaSpec.acme, which describes the *target*
   * cluster. Sharing one field made a downstream create write the host's Issuer
   * onto the target -- a cluster that has no cert-manager at all, by design.
   */
  acme?: Record<string, any>;
}

/**
 * Which kind of cert-manager issuer an environment references.
 *
 * Absent means `ClusterIssuer`, so specs recorded before the mirrored-Issuer
 * path existed keep working untouched.
 */
export type IssuerKind = 'ClusterIssuer' | 'Issuer';

/** An ACME issuer spec, copied verbatim from whatever the cluster already has. */
export interface AcmeIssuer {
  /** Namespace-qualified source, for display only. */
  source: string;
  spec: Record<string, any>;
}

/** Everything needed to render a dev environment's manifests. */
export interface RemudaSpec {
  name: string;
  /** Clone URL, e.g. https://github.com/rancher/dashboard */
  repo: string;
  branch: string;
  /** Rancher server image for the backend. */
  backendImage: string;
  /** Fully qualified host, e.g. my-feature.rancher.example.com */
  hostname: string;
  /**
   * Port to reach `hostname` on, when it is not 443.
   *
   * Only ever set for `direct` exposure, and only when the target cluster's
   * ingress controller answers on a NodePort rather than 443 -- there is no
   * fronting layer to normalise the port, so the browser has to be told. It
   * stays out of the Ingress `host` field, which must be a bare name: traefik
   * and nginx both match Host ignoring the port, which is what makes a
   * `:31443` URL reach a rule written for the name alone.
   */
  entryPort?: number;
  owner: string;
  createdAt: string;

  /** Cluster the environment runs on. */
  clusterId: string;
  /** Present only when clusterId is not the host cluster. */
  hop?: HopSpec;

  namespace: string;
  ingressClass: string;
  /** Omitted when the cluster has no default StorageClass to fall back on. */
  storageClass?: string;
  /** Omitted when the cluster offers no usable issuer at all. */
  clusterIssuer?: string;
  /** Defaults to ClusterIssuer when absent -- see IssuerKind. */
  issuerKind?: IssuerKind;
  /**
   * The target cluster's ACME spec, when its issuer has to be mirrored.
   *
   * Only ever the cluster this environment's own objects are written to. For a
   * downstream environment TLS terminates on the host instead, so this stays
   * undefined and HopSpec.acme carries it.
   */
  acme?: Record<string, any>;
  /** Secret holding a `token` key, for cloning a private fork. */
  gitSecretName?: string;

  dataSizeGb: number;
  uiSizeGb: number;
  cacheSizeGb: number;

  /**
   * CIDRs for the k3s the backend runs inside its own pod. They must not
   * overlap the host cluster's, or the nested cluster cannot reach its own
   * CoreDNS and never finishes installing its system charts.
   */
  nestedPodCidr: string;
  nestedServiceCidr: string;
}

/** Per-cluster defaults, discovered then persisted so later creates prefill. */
export interface ClusterDefaults {
  baseDomain: string;
  /** Host Rancher's server-version, used to tell the main line from a branched one. */
  serverVersion?: string;
  ingressClass: string;
  storageClass?: string;
  clusterIssuer?: string;
  issuerKind?: IssuerKind;
  /** The ACME spec to mirror, when the only issuer found was a namespaced one. */
  acme?: AcmeIssuer;
  /** False only when the cluster genuinely has no StorageClass, not when the lookup failed. */
  hasStorageClass?: boolean;
  /** Chosen to not overlap the host cluster's own CIDRs. */
  nestedPodCidr: string;
  nestedServiceCidr: string;
}

export interface ManifestRequest {
  /** Steve collection path, appended to /k8s/clusters/<id>/v1/ */
  endpoint: string;
  body: Record<string, any>;
}

export type BuildState = 'building' | 'ready' | 'failed' | 'unknown';

/**
 * Whether an environment is running, derived from its backend Deployment rather
 * than recorded in its spec. See runStateOf().
 */
export type RunState = 'ready' | 'pending' | 'stopped' | 'stopping';

/** A dev environment as presented in the list, merged from several resources. */
export interface RemudaSummary {
  spec: RemudaSpec;
  clusterId: string;
  clusterName: string;
  runState: RunState;
  buildState: BuildState;
  /** Record exists but the workload was never created. See isIncomplete(). */
  incomplete: boolean;
  url: string;
}
