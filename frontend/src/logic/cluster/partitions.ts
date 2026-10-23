import { usePersistentState } from '../persist';
import type { ClusterSnapshot } from '../../types';

/** Filters (remembered per Mac) and the filtered, sorted partition list. */
export function usePartitionList(snapshot: ClusterSnapshot) {
  const [query, setQuery] = usePersistentState('partitions.query', '');
  const [eligibleOnly, setEligibleOnly] = usePersistentState('partitions.eligibleOnly', false);
  const [sort, setSort] = usePersistentState<'name' | 'free'>('partitions.sort', 'name');

  const free = (name: string) =>
    snapshot.partitions.find((p) => p.name === name)?.gpuTotals.reduce((a, t) => a + t.potentiallyFree, 0) ?? 0;
  const list = snapshot.partitions
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    .filter((p) => !eligibleOnly || p.eligibility !== 'not_permitted')
    .sort((a, b) => (sort === 'name' ? 0 : free(b.name) - free(a.name)));

  return { query, setQuery, eligibleOnly, setEligibleOnly, sort, setSort, list };
}
