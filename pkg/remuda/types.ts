/** Where a cluster's ingress controller answers HTTPS from outside the cluster. */
export interface IngressEntry {
  addresses: string[];
  addressType: 'ExternalIP' | 'InternalIP';
  port: number;
}

/**
 * How an environment on a downstream cluster is reached.
 *
 * The hostname always comes off the host Rancher's own wildcard (see
 * baseDomainFromServerUrl), so it only ever resolves to the host cluster's
 * ingress. For a downstream target that means the Ingress created next to the
 * workload is correct and simply never receives traffic; the host cluster has
 * to front it. Set only for downstream targets -- on `local` the environment's
 * own Ingress is already on the right cluster.
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
  /** Host cluster's ClusterIssuer. TLS terminates here, so the target needs none. */
  clusterIssuer?: string;
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
  /** Omitted when cert-manager has no usable ClusterIssuer. */
  clusterIssuer?: string;
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
