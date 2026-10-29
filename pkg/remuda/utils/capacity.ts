import { read } from './api';

/**
 * Whether the target cluster has the disk for one more environment.
 *
 * Nothing else checks this, and the PVC requests do not either: `local-path`,
 * the class most target clusters use, is a hostPath on the node's own disk and
 * enforces no size at all. On 2026-10-14 shared's target node carried nine
 * environments requesting 270 Gi on a 145 GiB disk. It sat at 89-95% used,
 * the kubelet evicted a backend, and two more crashlooped until they were
 * recreated.
 *
 * Advisory only. The answer is per node and the scheduler picks the node, so
 * a warning is as strong as this can honestly be.
 */

/**
 * What an environment actually writes, as opposed to what its PVCs request.
 *
 * Measured on shared on 2026-10-14, roughly: deleting two full environments
 * freed about 15 GB. Most of that is the nested cluster's images and etcd on
 * the data volume, which an environment in front of an existing Rancher does
 * not have. What it keeps is the yarn cache and the build's node_modules,
 * hence the smaller figure. Both are estimates, not limits.
 */
export const ESTIMATED_DISK_GB = { ownBackend: 8, externalBackend: 4 };

/**
 * The free fraction below which a node is in trouble.
 *
 * The kubelet's default hard eviction threshold for the image filesystem is
 * 15% free. Every environment's nested k3s runs its own kubelet against the
 * same disk, so crossing it puts all of them under pressure at once. That
 * link to the crashloops is inferred rather than observed from inside the
 * nested clusters.
 */
export const DISK_PRESSURE_FRACTION = 0.15;

/** Hard cap on how many nodes are asked, so a large cluster costs bounded reads. */
const MAX_NODES = 10;

export interface NodeDisk {
  name: string;
  capacityBytes: number;
  availableBytes: number;
}

export interface DiskShortfall {
  node: string;
  availableGb: number;
  capacityGb: number;
  /** Free space left once the new environment has written what it writes. */
  afterGb: number;
  /** Free space below which the node is under disk pressure. */
  floorGb: number;
}

const GB = 1e9;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The shortfall on the roomiest node, or undefined when there is room.
 *
 * The roomiest rather than the fullest: the scheduler places pods by CPU and
 * memory, not disk, so the environment could land anywhere -- and warning
 * whenever any node is full would warn on every multi-node cluster forever.
 * If even the roomiest node would cross the line, the warning is certain.
 */
export function diskShortfall(nodes: NodeDisk[], needGb: number): DiskShortfall | undefined {
  const usable = nodes.filter((n) => n.capacityBytes > 0);

  if (!usable.length) {
    return undefined;
  }

  const roomiest = usable.reduce((a, b) => (b.availableBytes > a.availableBytes ? b : a));
  const afterGb = roomiest.availableBytes / GB - needGb;
  const floorGb = roomiest.capacityBytes / GB * DISK_PRESSURE_FRACTION;

  if (afterGb >= floorGb) {
    return undefined;
  }

  return {
    node:        roomiest.name,
    availableGb: round(roomiest.availableBytes / GB),
    capacityGb:  round(roomiest.capacityBytes / GB),
    afterGb:     round(afterGb),
    floorGb:     round(floorGb),
  };
}

/**
 * Each node's root filesystem, from the kubelet's own summary.
 *
 * Read through Rancher's cluster proxy, which needs `nodes/proxy` -- in
 * practice an admin. Anyone else gets an empty answer and no warning, which
 * is the same as before this check existed.
 */
export async function readNodeDisk(store: any, clusterId: string): Promise<NodeDisk[]> {
  const root = `/k8s/clusters/${ clusterId }/api/v1/nodes`;
  let names: string[] = [];

  try {
    const nodes = await read(store, root);

    names = (nodes?.items || []).map((n: any) => n?.metadata?.name).filter(Boolean).slice(0, MAX_NODES);
  } catch {
    return [];
  }

  const summaries = await Promise.all(names.map(async(name) => {
    try {
      const summary = await read(store, `${ root }/${ name }/proxy/stats/summary`);
      const fs = summary?.node?.fs;

      return fs ? {
        name, capacityBytes: Number(fs.capacityBytes) || 0, availableBytes: Number(fs.availableBytes) || 0
      } : undefined;
    } catch {
      return undefined;
    }
  }));

  return summaries.filter(Boolean) as NodeDisk[];
}
