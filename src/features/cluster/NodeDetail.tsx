import { useQuery } from '@tanstack/react-query';
import { Badge, Notice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { count, formatDateTime, memory, NODE_STATE } from '../../lib/format';

export function NodeDetail({ nodeId, version, onBack }: { nodeId: string; version: number; onBack: () => void }) {
  const q = useQuery({ queryKey: ['node', nodeId, version], queryFn: () => api.nodeDetail(nodeId), retry: false });
  const n = q.data;
  return (
    <section aria-labelledby="node-title">
      <button className="btn ghost back" onClick={onBack}>
        ← Back to nodes
      </button>
      <h2 id="node-title">Node {nodeId}</h2>
      {q.error && <Notice tone="bad">{errorMessage(q.error)}</Notice>}
      {n && (
        <>
          <div className="card">
            <dl className="kv">
              <dt>State</dt>
              <dd>
                <Badge tone={NODE_STATE[n.state].tone} glyph={NODE_STATE[n.state].glyph}>
                  {NODE_STATE[n.state].label}
                </Badge>{' '}
                <code className="muted">{n.stateRaw}</code>
              </dd>
              {n.reason && (
                <>
                  <dt>Reason</dt>
                  <dd>{n.reason}</dd>
                </>
              )}
              <dt>Partitions</dt>
              <dd>{n.partitions.join(', ') || '—'}</dd>
              <dt>CPUs</dt>
              <dd>
                {count(n.cpuAllocated)} allocated of {count(n.cpuTotal)}
              </dd>
              <dt>Memory</dt>
              <dd>
                {memory(n.memoryAllocatedMb)} allocated of {memory(n.memoryMb)}
              </dd>
              <dt>Data from</dt>
              <dd>{formatDateTime(n.sourceTimestamp)}</dd>
            </dl>
          </div>
          <div className="card">
            <h3>GPU resources (scheduler GRES)</h3>
            {n.resources.length === 0 ? (
              <p className="muted">This node reports no GPU GRES.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Kind</th>
                    <th scope="col" className="num">
                      Configured
                    </th>
                    <th scope="col" className="num">
                      Allocated
                    </th>
                    <th scope="col" className="num">
                      Potentially free
                    </th>
                    <th scope="col">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {n.resources.map((r) => (
                    <tr key={r.gresName}>
                      <th scope="row">
                        {r.modelLabel}
                        <div className="muted small mono">{r.raw}</div>
                      </th>
                      <td>
                        {r.granularity === 'mig' ? 'MIG slice' : r.granularity === 'physical' ? 'Physical' : 'Untyped'}
                      </td>
                      <td className="num">{count(r.configured)}</td>
                      <td className="num">{count(r.allocated)}</td>
                      <td className="num">{r.unavailable > 0 ? 'Unavailable' : count(r.potentiallyFree)}</td>
                      <td>{r.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">
              SLURM occupancy only. GPU memory and utilisation are not measured in V1 and are not implied by these
              numbers.
            </p>
          </div>
          {n.warnings.length > 0 && (
            <Notice tone="warn" title="Parser warnings">
              <ul>
                {n.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          <details className="card">
            <summary>Raw scheduler fields</summary>
            <dl className="kv raw">
              {n.raw.map(([k, v], i) => (
                <div key={`${k}-${i}`} className="kv-row">
                  <dt>{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
