import { Badge, Notice } from '../components/ui';
import { fleetSummary, partitionGpus } from '../../logic/cluster/overview';
import { formatDuration, nominalVram } from '../../logic/format';
import type { ClusterSnapshot } from '../../types';
import { GpuBar, Legend } from './GpuBar';

/** Cluster → Overview: fleet numbers and one card per partition with its GPUs. */
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

      <div className="section-head">
        <h2>Partitions</h2>
        <Legend />
      </div>
      <div className="part-grid">
        {snapshot.partitions.map((p) => {
          const g = partitionGpus(p);
          const mig = p.gpuTotals.filter((t) => t.granularity === 'mig');
          return (
            <article key={p.name} className="card part-card" aria-labelledby={`part-${p.name}`}>
              <header className="part-card-head">
                <div>
                  <h3 id={`part-${p.name}`}>
                    {p.name}
                    {p.warnings.length > 0 && (
                      <span className="warn-mark" title={p.warnings.join('\n')}>
                        {' '}
                        ⚠<span className="sr-only">{p.warnings.length} warnings</span>
                      </span>
                    )}
                  </h3>
                  <div className="badges">
                    {p.isDefault && <Badge tone="info">Default</Badge>}
                    {p.state !== 'up' && (
                      <Badge tone="bad" glyph="✕">
                        {p.stateRaw || 'Unknown'}
                      </Badge>
                    )}
                    {p.eligibility === 'not_permitted' && <Badge tone="muted">Not permitted</Badge>}
                  </div>
                </div>
                {g.configured > 0 && <Ring g={g} name={p.name} />}
              </header>
              <dl className="part-facts">
                <div>
                  <dt>Up to</dt>
                  <dd>{formatDuration(p.maxTimeSeconds, p.maxTimeRaw)}</dd>
                </div>
                <div>
                  <dt>Nodes</dt>
                  <dd>{p.nodeIds.length}</dd>
                </div>
                <div>
                  <dt>GPUs</dt>
                  <dd>
                    {g.configured}
                    {mig.length > 0 && (
                      <span className="muted small"> + {mig.reduce((a, t) => a + t.configured, 0)} MIG</span>
                    )}
                  </dd>
                </div>
              </dl>
              {p.gpuTotals.length === 0 ? (
                <p className="muted">{p.nodeIds.length === 0 ? 'No nodes' : 'No GPUs'}</p>
              ) : (
                <ul className="gpu-lines">
                  {p.gpuTotals.map((t) => (
                    <li key={t.gresName}>
                      <div className="gpu-line-name" title={t.gresName}>
                        <strong>{t.modelLabel}</strong>
                        <span className="muted small">
                          {' '}
                          {nominalVram(t.gresName) ?? ''}
                          {t.granularity === 'mig' && ' · MIG slice'}
                        </span>
                      </div>
                      <GpuBar t={t} />
                    </li>
                  ))}
                </ul>
              )}
              <footer className="actions start">
                <button
                  className="btn primary small-btn"
                  onClick={() => onRequest(p.name)}
                  aria-label={`New job on ${p.name}`}
                  disabled={p.gpuTotals.length === 0 || p.eligibility === 'not_permitted'}
                >
                  New job here
                </button>
                <button
                  className="btn ghost small-btn"
                  onClick={() => onOpenNodes(p.name)}
                  disabled={p.nodeIds.length === 0}
                  aria-label={`Nodes of ${p.name}`}
                >
                  See nodes
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      <p className="muted small">
        Partitions visible to your account. Visibility does not imply eligibility: account, QoS and group limits are
        enforced by the scheduler. “Potentially free” is not a reservation; the scheduler decides at submission. GPU
        memory is nominal, from the model name.
      </p>
    </>
  );
}

/** A ring of one partition's physical GPUs: free, allocated, unavailable; the gap is unknown. */
function Ring({ g, name }: { g: ReturnType<typeof partitionGpus>; name: string }) {
  const pct = (n: number) => (n / g.configured) * 100;
  const free = pct(g.free);
  const alloc = free + pct(g.allocated);
  const down = alloc + pct(g.unavailable);
  return (
    <div
      className="ring"
      role="img"
      aria-label={`${name}: ${g.free} of ${g.configured} GPUs potentially free, ${g.allocated} allocated, ${g.unavailable} unavailable, ${g.unknown} unknown`}
      style={{
        background: `conic-gradient(var(--ok) 0 ${free}%, var(--alloc) 0 ${alloc}%, var(--bad) 0 ${down}%, var(--fill-strong) 0)`,
      }}
    >
      <span className="ring-hole">
        <strong>{g.free}</strong>
        <small>free</small>
      </span>
    </div>
  );
}
