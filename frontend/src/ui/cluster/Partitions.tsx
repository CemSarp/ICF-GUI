import { Badge, EmptyState } from '../components/ui';
import { granularityLabel } from '../../logic/cluster/gpu';
import { usePartitionList } from '../../logic/cluster/partitions';
import { formatDuration } from '../../logic/format';
import type { ClusterSnapshot } from '../../types';
import { GpuBar, Legend } from './GpuBar';

export function Partitions({
  snapshot,
  onOpenNodes,
  onRequest,
}: {
  snapshot: ClusterSnapshot;
  onOpenNodes: (partition: string) => void;
  onRequest: (partition: string) => void;
}) {
  const { query, setQuery, eligibleOnly, setEligibleOnly, sort, setSort, list } = usePartitionList(snapshot);

  if (snapshot.partitions.length === 0) {
    return (
      <EmptyState title="No partitions visible">The scheduler returned no partitions for this account.</EmptyState>
    );
  }

  return (
    <>
      <div className="toolbar" role="search">
        <label className="field inline">
          <span>Search</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Partition name" />
        </label>
        <label className="field inline">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'free')}>
            <option value="name">Scheduler order</option>
            <option value="free">Most potentially free</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} />
          Hide partitions known to be not permitted
        </label>
        <Legend />
      </div>
      <p className="muted small">
        Visibility does not imply eligibility: account, QoS and group limits are enforced by the scheduler.
      </p>
      {list.length === 0 ? (
        <EmptyState title="Filtered out">No partition matches the current filters.</EmptyState>
      ) : (
        <div className="grid">
          {list.map((p) => (
            <article className="card" key={p.name} aria-labelledby={`p-${p.name}`}>
              <div className="card-head">
                <h2 id={`p-${p.name}`}>{p.name}</h2>
                <div>
                  {p.isDefault && <Badge tone="info">Default</Badge>}{' '}
                  {p.state === 'up' ? (
                    <Badge tone="ok" glyph="●">
                      Up
                    </Badge>
                  ) : (
                    <Badge tone="bad" glyph="✕">
                      {p.stateRaw || 'Unknown'}
                    </Badge>
                  )}
                </div>
              </div>
              <dl className="kv">
                <dt>Max time</dt>
                <dd>{formatDuration(p.maxTimeSeconds, p.maxTimeRaw)}</dd>
                <dt>Nodes</dt>
                <dd>{p.nodeIds.length}</dd>
                <dt>Eligibility</dt>
                <dd>
                  {p.eligibility === 'not_permitted'
                    ? 'Not permitted (group restriction)'
                    : p.eligibility === 'confirmed'
                      ? 'Confirmed'
                      : 'Unknown'}
                </dd>
              </dl>
              {p.gpuTotals.length === 0 ? (
                <p className="muted">
                  {p.nodeIds.length === 0 ? 'No nodes in this partition.' : 'No GPUs on these nodes.'}
                </p>
              ) : (
                <ul className="gpu-lines">
                  {p.gpuTotals.map((t) => (
                    <li key={t.gresName}>
                      <div>
                        <strong>{t.modelLabel}</strong>{' '}
                        <span className="muted small">{granularityLabel(t.granularity)}</span>
                      </div>
                      <GpuBar t={t} />
                    </li>
                  ))}
                </ul>
              )}
              {p.warnings.length > 0 && (
                <details>
                  <summary>{p.warnings.length} parser warning(s)</summary>
                  <ul className="small">
                    {p.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="actions start card-foot">
                <button className="btn ghost" onClick={() => onOpenNodes(p.name)} disabled={p.nodeIds.length === 0}>
                  View nodes
                </button>
                <button
                  className="btn"
                  onClick={() => onRequest(p.name)}
                  aria-label={`New job on ${p.name}`}
                  disabled={p.gpuTotals.length === 0 || p.eligibility === 'not_permitted'}
                >
                  New job
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
