import { useMemo } from 'react';
import { usePersistentState } from '../persist';
import type { ClusterSnapshot, ComputeNode, NodeState } from '../../types';

export type SortKey = 'id' | 'state' | 'free' | 'gpus';

export function freeOf(n: ComputeNode) {
  return n.resources.reduce((a, r) => a + (r.potentiallyFree ?? 0), 0);
}

/** "Potentially free" cell: a lower bound with `+?` when some GPU's allocation is unknown. */
export function freeLabel(n: ComputeNode): string | number {
  const unknown = n.resources.some((r) => r.potentiallyFree === null);
  return unknown && freeOf(n) === 0 ? 'Unknown' : freeOf(n) + (unknown ? '+?' : '');
}

/** Filters (remembered per Mac), filtered and sorted rows for the GPU Nodes table. */
export function useNodeTable(
  snapshot: ClusterSnapshot,
  partitionFilter: string,
  setPartitionFilter: (p: string) => void,
) {
  const [query, setQuery] = usePersistentState('nodes.query', '');
  const [state, setState] = usePersistentState<NodeState | ''>('nodes.state', '');
  const [model, setModel] = usePersistentState('nodes.model', '');
  const [gpuOnly, setGpuOnly] = usePersistentState('nodes.gpuOnly', true);
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: 1 | -1 }>('nodes.sort', { key: 'id', dir: 1 });

  const all = useMemo(() => Object.values(snapshot.nodesById), [snapshot]);
  const models = useMemo(() => [...new Set(all.flatMap((n) => n.resources.map((r) => r.gresName)))].sort(), [all]);
  const rows = all
    .filter((n) => !gpuOnly || n.resources.length > 0)
    .filter((n) => !partitionFilter || n.partitions.includes(partitionFilter))
    .filter((n) => !state || n.state === state)
    .filter((n) => !model || n.resources.some((r) => r.gresName === model))
    .filter(
      (n) =>
        !query ||
        n.id.includes(query.toLowerCase()) ||
        n.resources.some((r) => r.modelLabel.toLowerCase().includes(query.toLowerCase())),
    )
    .sort((a, b) => {
      const v =
        sort.key === 'id'
          ? a.id.localeCompare(b.id, undefined, { numeric: true })
          : sort.key === 'state'
            ? a.state.localeCompare(b.state)
            : sort.key === 'free'
              ? freeOf(a) - freeOf(b)
              : a.resources.reduce((x, r) => x + (r.configured ?? 0), 0) -
                b.resources.reduce((x, r) => x + (r.configured ?? 0), 0);
      return v * sort.dir;
    });

  const toggleSort = (key: SortKey) => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 });
  const clear = () => {
    setQuery('');
    setState('');
    setModel('');
    setPartitionFilter('');
  };

  return {
    query,
    setQuery,
    state,
    setState,
    model,
    setModel,
    gpuOnly,
    setGpuOnly,
    sort,
    toggleSort,
    clear,
    all,
    models,
    rows,
  };
}
