import { Badge, EmptyState, Notice } from '../components/ui';
import { granularityLabel } from '../../logic/cluster/gpu';
import { fleetSummary } from '../../logic/cluster/overview';
import { formatDuration, nominalVram } from '../../logic/format';
import type { ClusterSnapshot } from '../../types';
import { GpuBar, Legend } from './GpuBar';

/** Cluster → Overview: fleet numbers, GPUs by type, and one row per partition. */
export function Overview({
  snapshot,
  onOpenNodes,
  onRequest,
}: {
  snapshot: ClusterSnapshot;
  onOpenNodes: (partition: string) => void;
  onRequest: (partition: string) => void;
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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Partition</th>
                <th scope="col">Max time</th>
                <th scope="col" className="num">
                  Nodes
                </th>
                <th scope="col">GPUs</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.partitions.map((p) => (
                <tr key={p.name}>
                  <th scope="row">
                    {p.name}
                    {p.warnings.length > 0 && (
                      <span className="warn-mark" title={p.warnings.join('\n')}>
                        {' '}
                        ⚠<span className="sr-only">{p.warnings.length} warnings</span>
                      </span>
                    )}
                    <div className="badges">
                      {p.isDefault && <Badge tone="info">Default</Badge>}
                      {p.state !== 'up' && (
                        <Badge tone="bad" glyph="✕">
                          {p.stateRaw || 'Unknown'}
                        </Badge>
                      )}
                      {p.eligibility === 'not_permitted' && <Badge tone="muted">Not permitted</Badge>}
                    </div>
                  </th>
                  <td className="nowrap">{formatDuration(p.maxTimeSeconds, p.maxTimeRaw)}</td>
                  <td className="num">{p.nodeIds.length}</td>
                  <td>
                    {p.gpuTotals.length === 0 ? (
                      <span className="muted">{p.nodeIds.length === 0 ? 'No nodes' : 'No GPUs'}</span>
                    ) : (
                      <ul className="gpu-lines">
                        {p.gpuTotals.map((t) => (
                          <li key={t.gresName}>
                            <div>
                              <strong>{t.modelLabel}</strong>{' '}
                              {t.granularity === 'mig' && <span className="muted small">MIG</span>}
                            </div>
                            <GpuBar t={t} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn ghost small-btn"
                      onClick={() => onOpenNodes(p.name)}
                      disabled={p.nodeIds.length === 0}
                      aria-label={`Nodes of ${p.name}`}
                    >
                      Nodes
                    </button>
                    <button
                      className="btn small-btn"
                      onClick={() => onRequest(p.name)}
                      aria-label={`New job on ${p.name}`}
                      disabled={p.gpuTotals.length === 0 || p.eligibility === 'not_permitted'}
                    >
                      New job
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Partitions visible to your account. Visibility does not imply eligibility: account, QoS and group limits are
          enforced by the scheduler. “Potentially free” is not a reservation; the scheduler decides at submission.
        </p>
      </section>
    </>
  );
}
