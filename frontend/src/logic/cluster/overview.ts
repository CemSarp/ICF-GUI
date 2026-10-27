import type { ClusterSnapshot } from '../../types';

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

/** One partition's physical (and untyped) GPUs added up; MIG slices are listed separately, never added. */
export function partitionGpus(p: ClusterSnapshot['partitions'][number]) {
  const physical = p.gpuTotals.filter((t) => t.granularity !== 'mig');
  const sum = (k: 'configured' | 'potentiallyFree' | 'allocated' | 'unavailable' | 'unknown') =>
    physical.reduce((a, t) => a + t[k], 0);
  return {
    configured: sum('configured'),
    free: sum('potentiallyFree'),
    allocated: sum('allocated'),
    unavailable: sum('unavailable'),
    unknown: sum('unknown'),
  };
}
