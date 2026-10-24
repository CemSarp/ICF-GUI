import { useNow } from '../../logic/persist';
import type { Kernel } from '../../logic/notebooks/useKernel';
import { Icon } from '../components/ui';

function left(endsAtMs: number, now: number) {
  const min = Math.max(0, Math.round((endsAtMs - now) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min left` : `${min} min left`;
}

/** Kernel status chip with the one action that fits: start, cancel the request, or stop. */
export function KernelControls({ kernel, onStart }: { kernel: Kernel; onStart: () => void }) {
  const now = useNow(30_000);
  const s = kernel.state;
  const chip = (tone: string, label: string, title?: string, busy = false) => (
    <span className={`nb-kernel tone-${tone}`} title={title} role="status" aria-live="polite">
      {busy ? <span className="nb-spinner" aria-hidden="true" /> : <span className="nb-dot" aria-hidden="true" />}
      {label}
    </span>
  );
  switch (s.phase) {
    case 'off':
    case 'ended':
      return (
        <>
          {chip(
            'muted',
            s.phase === 'ended' ? 'Kernel stopped' : 'No kernel',
            s.phase === 'ended' ? s.message : undefined,
          )}
          <button className="btn small primary" onClick={onStart}>
            <Icon name="play" size={12} /> Start kernel…
          </button>
        </>
      );
    case 'starting':
    case 'queued':
      return (
        <>
          {chip(
            'warn',
            s.phase === 'queued' ? `Queued · job ${s.jobId}` : 'Requesting a GPU…',
            'Waiting for SLURM to allocate the Interactive GPU',
            true,
          )}
          <button className="btn small" onClick={() => void kernel.stop()}>
            Cancel
          </button>
        </>
      );
    case 'ready':
      return (
        <>
          {chip(
            s.busy ? 'busy' : 'ok',
            `${s.busy ? 'Busy' : 'Python'} ${s.python} · ${s.node || 'node'} · ${left(s.endsAtMs, now)}`,
            `Job ${s.jobId} on ${s.node}. Stopping releases the GPU.`,
            s.busy,
          )}
          <button className="btn small danger" onClick={() => void kernel.stop()}>
            <Icon name="stop" size={12} /> Stop
          </button>
        </>
      );
  }
}
