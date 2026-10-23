import { Badge, EmptyState } from '../components/ui';
import { freeLabel, useNodeTable, type SortKey } from '../../logic/cluster/nodes';
import { count, memory, NODE_STATE } from '../../logic/format';
import type { ClusterSnapshot, GpuResource, NodeState } from '../../types';

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
  const {
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
  } = useNodeTable(snapshot, partitionFilter, setPartitionFilter);

  const header = (key: SortKey, label: string, num = false) => (
    <th
      scope="col"
      className={num ? 'num' : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button className="sort" onClick={() => toggleSort(key)}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );

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
                    <td className="num">{freeLabel(n)}</td>
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
