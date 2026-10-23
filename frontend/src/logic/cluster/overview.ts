import type { ClusterSnapshot, Partition } from '../../types';

/** Fleet-wide numbers: physical and untyped GPUs counted once per node; MIG slices kept separate. */
export function fleetSummary(snapshot: ClusterSnapshot) {
  const nodes = Object.values(snapshot.nodesById);
  const gpuNodes = nodes.filter((n) => n.resources.length > 0);
  const physical = snapshot.gpuTotals.filter((t) => t.granularity !== 'mig');
  const sum = (k: 'configured' | 'potentiallyFree' | 'unknown') => physical.reduce((a, t) => a + t[k], 0);
  const mig = snapshot.gpuTotals.filter((t) => t.granularity === 'mig');
  return {
    nodes: nodes.length,
    gpuNodes: gpuNodes.length,
    configured: sum('configured'),
    free: sum('potentiallyFree'),
    unknown: sum('unknown'),
    hasMig: mig.length > 0,
    migSlices: mig.reduce((a, t) => a + t.configured, 0),
  };
}

/** Potentially free (MIG excluded) and unknown GPUs in one partition. */
export function partitionSummary(p: Partition) {
  return {
    free: p.gpuTotals.reduce((a, t) => a + (t.granularity === 'mig' ? 0 : t.potentiallyFree), 0),
    unknown: p.gpuTotals.reduce((a, t) => a + t.unknown, 0),
  };
}
