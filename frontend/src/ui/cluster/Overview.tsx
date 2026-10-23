import { Badge, EmptyState, Notice } from '../components/ui';
import { granularityLabel } from '../../logic/cluster/gpu';
import { fleetSummary, partitionSummary } from '../../logic/cluster/overview';
import { formatDuration, nominalVram } from '../../logic/format';
import type { ClusterSnapshot } from '../../types';
import { GpuBar, Legend } from './GpuBar';

export function Overview({
  snapshot,
  onOpenPartition,
}: {
  snapshot: ClusterSnapshot;
  onOpenPartition: (name: string) => void;
}) {
  const fleet = fleetSummary(snapshot);
  const free = fleet.free;

  return (
    <>
      <section className="stats" aria-label="Fleet summary">
        <div className="stat">
          <span className="stat-label">Partitions visible</span>
          <span className="stat-value">{snapshot.partitions.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">GPU nodes</span>
          <span className="stat-value">{fleet.gpuNodes}</span>
          <span className="muted small">{fleet.nodes} nodes total</span>
        </div>
        <div className="stat">
          <span className="stat-label">GPUs configured</span>
          <span className="stat-value">{fleet.configured}</span>
          <span className="muted small">physical + untyped, each node counted once</span>
        </div>
        <div className="stat">
          <span className="stat-label">Potentially free</span>
          <span className="stat-value">{free}</span>
          <span className="muted small">
            {fleet.unknown > 0 ? `${fleet.unknown} with unknown allocation` : 'scheduler estimate'}
          </span>
        </div>
        {fleet.hasMig && (
          <div className="stat">
            <span className="stat-label">MIG slices</span>
            <span className="stat-value">{fleet.migSlices}</span>
            <span className="muted small">not added to physical count</span>
          </div>
        )}
      </section>

      {free === 0 && fleet.unknown === 0 && fleet.configured > 0 && (
        <Notice tone="info" title="No GPUs are potentially free right now">
          Every known GPU is allocated or unavailable. You can still submit a job: it waits in the queue until the
          scheduler starts it.
        </Notice>
      )}

      <section className="card">
        <div className="card-head">
          <h2>GPUs by type</h2>
          <Legend />
        </div>
        {snapshot.gpuTotals.length === 0 ? (
          <EmptyState title="No GPU resources reported">The scheduler listed no GPU GRES on visible nodes.</EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Kind</th>
                <th scope="col" className="num">
                  VRAM*
                </th>
                <th scope="col" className="num">
                  Nodes
                </th>
                <th scope="col">Allocation</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.gpuTotals.map((t) => (
                <tr key={t.gresName}>
                  <th scope="row">
                    {t.modelLabel}
                    <div className="muted small mono">{t.gresName}</div>
                  </th>
                  <td>{granularityLabel(t.granularity)}</td>
                  <td className="num">{nominalVram(t.gresName) ?? '—'}</td>
                  <td className="num">{t.nodes}</td>
                  <td>
                    <GpuBar t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          * Nominal memory per GPU or MIG slice, from the model name. It is not a measurement of free GPU memory.
        </p>
      </section>

      <section className="card">
        <h2>Partitions</h2>
        <ul className="partition-list">
          {snapshot.partitions.map((p) => {
            const { free: f, unknown: u } = partitionSummary(p);
            return (
              <li key={p.name}>
                <button className="row-button" onClick={() => onOpenPartition(p.name)}>
                  <span className="pname">
                    {p.name} {p.isDefault && <Badge tone="info">Default</Badge>}{' '}
                    {p.state !== 'up' && (
                      <Badge tone="bad" glyph="✕">
                        {p.stateRaw || 'Unknown'}
                      </Badge>
                    )}
                    {p.eligibility === 'not_permitted' && <Badge tone="muted">Not permitted</Badge>}
                  </span>
                  <span className="muted">
                    {p.nodeIds.length} nodes · max {formatDuration(p.maxTimeSeconds, p.maxTimeRaw)}
                  </span>
                  <span>
                    <span aria-hidden="true">○ </span>
                    {f} potentially free{u > 0 ? ` · ${u} unknown` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted small">
          {snapshot.permissionScope}. “Potentially free” is not a reservation; the scheduler decides at submission.
        </p>
      </section>
    </>
  );
}
