import type { ClusterSnapshot, GpuTotals, Partition } from '../../types';

export function granularityLabel(g: GpuTotals['granularity']) {
  return g === 'mig' ? 'MIG slice' : g === 'physical' ? 'Physical GPU' : 'Untyped';
}

/** Largest number of `gres` GPUs any single node of the partition has (at least 1). */
export function maxGpusFor(snapshot: ClusterSnapshot, partition: Partition | undefined, gres: string): number {
  return partition
    ? Math.max(
        1,
        ...partition.nodeIds.map(
          (id) => snapshot.nodesById[id]?.resources.find((r) => r.gresName === gres)?.configured ?? 0,
        ),
      )
    : 1;
}
