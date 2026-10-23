import { useMemo } from 'react';
import { Badge, EmptyState } from '../../components/ui';
import { count, memory, NODE_STATE } from '../../lib/format';
import { usePersistentState } from '../../lib/persist';
import type { ClusterSnapshot, ComputeNode, GpuResource, NodeState } from '../../types';

type SortKey = 'id' | 'state' | 'free' | 'gpus';

function freeOf(n: ComputeNode) {
  return n.resources.reduce((a, r) => a + (r.potentiallyFree ?? 0), 0);
}

export function ResourceLine({ r }: { r: GpuResource }) {
  return (
    <span className="res">
      <strong>{r.modelLabel}</strong>
      {r.granularity === 'mig' && <span className="muted"> (MIG)</span>} ×{count(r.configured)}
      <span className="muted">
        {' '}
        — {r.allocated === null ? 'allocation unknown' : `${r.allocated} allocated`}
        {r.unavailable > 0
          ? ', unavailable'
          : r.potentiallyFree !== null
            ? `, ${r.potentiallyFree} potentially free`
            : ''}
      </span>
    </span>
  );
}

export function Nodes({
  snapshot,
  partitionFilter,
  setPartitionFilter,
  onSelect,
}: {
  snapshot: ClusterSnapshot;
  partitionFilter: string;
  setPartitionFilter: (p: string) => void;
  onSelect: (id: string) => void;
}) {
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

  const header = (key: SortKey, label: string, num = false) => (
    <th
      scope="col"
      className={num ? 'num' : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button className="sort" onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );
  const clear = () => {
    setQuery('');
    setState('');
    setModel('');
    setPartitionFilter('');
  };

  return (
    <>
      <div className="toolbar" role="search">
        <label className="field inline">
          <span>Search</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Node or GPU model" />
        </label>
        <label className="field inline">
          <span>Partition</span>
          <select value={partitionFilter} onChange={(e) => setPartitionFilter(e.target.value)}>
            <option value="">All</option>
            {snapshot.partitions.map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>State</span>
          <select value={state} onChange={(e) => setState(e.target.value as NodeState | '')}>
            <option value="">All</option>
            {Object.entries(NODE_STATE).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>GPU type</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">All</option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={gpuOnly} onChange={(e) => setGpuOnly(e.target.checked)} />
          GPU nodes only
        </label>
      </div>

      {all.length === 0 ? (
        <EmptyState title="No nodes reported">The scheduler returned no node records.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="Filtered out">
          No node matches these filters.{' '}
          <button className="btn ghost" onClick={clear}>
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Compute nodes, {rows.length} shown</caption>
            <thead>
              <tr>
                {header('id', 'Node')}
                {header('state', 'State')}
                <th scope="col">Partitions</th>
                {header('gpus', 'GPUs')}
                {header('free', 'Potentially free', true)}
                <th scope="col" className="num">
                  CPU alloc / total
                </th>
                <th scope="col" className="num">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => {
                const s = NODE_STATE[n.state];
                const unknown = n.resources.some((r) => r.potentiallyFree === null);
                return (
                  <tr key={n.id}>
                    <th scope="row">
                      <button className="link" onClick={() => onSelect(n.id)}>
                        {n.id}
                      </button>
                      {n.warnings.length > 0 && (
                        <span className="warn-mark" title={n.warnings.join('\n')}>
                          {' '}
                          ⚠<span className="sr-only">{n.warnings.length} warnings</span>
                        </span>
                      )}
                    </th>
                    <td>
                      <Badge tone={s.tone} glyph={s.glyph}>
                        {s.label}
                      </Badge>
                    </td>
                    <td className="small">{n.partitions.join(', ')}</td>
                    <td>
                      {n.resources.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        n.resources.map((r) => (
                          <div key={r.gresName}>
                            <ResourceLine r={r} />
                          </div>
                        ))
                      )}
                    </td>
                    <td className="num">
                      {unknown && freeOf(n) === 0 ? 'Unknown' : freeOf(n) + (unknown ? '+?' : '')}
                    </td>
                    <td className="num">
                      {count(n.cpuAllocated)} / {count(n.cpuTotal)}
                    </td>
                    <td className="num">{memory(n.memoryMb)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
