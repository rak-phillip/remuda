/** Everything needed to render a dev environment's manifests. */
export interface DevEnvSpec {
  name: string;
  /** Clone URL, e.g. https://github.com/rak-phillip/dashboard */
  repo: string;
  branch: string;
  /** Rancher server image for the backend. */
  backendImage: string;
  /** Fully qualified host, e.g. multi-idp.prak-bf3b08bd.ui.rancher.space */
  hostname: string;
  owner: string;
  createdAt: string;

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
}

/** Per-cluster defaults, discovered then persisted so later creates prefill. */
export interface ClusterDefaults {
  baseDomain: string;
  ingressClass: string;
  storageClass?: string;
  clusterIssuer?: string;
}

export interface ManifestRequest {
  /** Steve collection path, appended to /k8s/clusters/<id>/v1/ */
  endpoint: string;
  body: Record<string, any>;
}

export type BuildState = 'building' | 'ready' | 'failed' | 'unknown';

/** A dev environment as presented in the list, merged from several resources. */
export interface DevEnvSummary {
  spec: DevEnvSpec;
  clusterId: string;
  clusterName: string;
  backendReady: boolean;
  buildState: BuildState;
  url: string;
}
