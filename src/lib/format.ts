import type { ConnState, JobState, NodeState } from '../types';

/** The one display format for every time: `10:16 PM` today, `Oct 16, 10:16 PM` otherwise. */
export function displayTime(d: Date, now = new Date()): string {
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** An instant from the app/backend (ISO with zone), shown in this Mac's time. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : displayTime(d);
}

export function formatDuration(seconds: number | null, raw: string): string {
  if (seconds === null) return raw === 'UNLIMITED' ? 'Unlimited' : raw || 'Unknown';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Never render null as 0. */
export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? 'Unknown' : String(n);
}

export function memory(mb: number | null): string {
  if (mb === null) return 'Unknown';
  return mb >= 1024 ? `${(mb / 1024).toFixed(0)} GB` : `${mb} MB`;
}

// Text + glyph for every state so meaning never depends on colour alone.
export const NODE_STATE: Record<NodeState, { label: string; glyph: string; tone: string }> = {
  idle: { label: 'Idle', glyph: '○', tone: 'ok' },
  mixed: { label: 'Mixed', glyph: '◐', tone: 'info' },
  allocated: { label: 'Allocated', glyph: '●', tone: 'busy' },
  down: { label: 'Down', glyph: '✕', tone: 'bad' },
  drain: { label: 'Drain', glyph: '⊘', tone: 'warn' },
  unknown: { label: 'Unknown', glyph: '?', tone: 'muted' },
};

export const CONN_STATE: Record<ConnState, { label: string; glyph: string; tone: string }> = {
  disconnected: { label: 'Disconnected', glyph: '○', tone: 'muted' },
  connecting: { label: 'Connecting…', glyph: '◌', tone: 'info' },
  auth_required: { label: 'Waiting for authentication', glyph: '⚿', tone: 'warn' },
  connected: { label: 'Connected', glyph: '●', tone: 'ok' },
  degraded: { label: 'Degraded', glyph: '◐', tone: 'warn' },
  offline: { label: 'Offline', glyph: '✕', tone: 'bad' },
  auth_failed: { label: 'Authentication failed', glyph: '✕', tone: 'bad' },
};

export const JOB_STATE: Record<JobState, { label: string; glyph: string; tone: string }> = {
  pending: { label: 'Pending', glyph: '◌', tone: 'info' },
  configuring: { label: 'Configuring', glyph: '◌', tone: 'info' },
  running: { label: 'Running', glyph: '▶', tone: 'ok' },
  completing: { label: 'Completing', glyph: '◐', tone: 'info' },
  completed: { label: 'Completed', glyph: '✓', tone: 'ok' },
  failed: { label: 'Failed', glyph: '✕', tone: 'bad' },
  cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'muted' },
  timeout: { label: 'Timeout', glyph: '◷', tone: 'warn' },
  node_fail: { label: 'Node failure', glyph: '✕', tone: 'bad' },
  out_of_memory: { label: 'Out of memory', glyph: '✕', tone: 'bad' },
  requeued: { label: 'Requeued', glyph: '↺', tone: 'info' },
  suspended: { label: 'Suspended', glyph: '❙❙', tone: 'warn' },
  preempted: { label: 'Preempted', glyph: '↺', tone: 'warn' },
  unknown: { label: 'Unknown', glyph: '?', tone: 'muted' },
};

/** Nominal per-GPU memory from the model/MIG name. Not a measurement of free memory. */
export function nominalVram(gresName: string): string | null {
  const t = gresName.toLowerCase();
  const mig = /(\d+)g\.(\d+)gb/.exec(t);
  if (mig) return `${mig[2]} GB`;
  const table: [RegExp, number][] = [
    [/2080_?ti/, 11],
    [/a6000/, 48],
    [/(^|[:_])a40($|_)/, 48],
    [/l40s/, 48],
    [/h200/, 141],
    [/h100/, 80],
    [/pro_6000/, 96],
  ];
  const hit = table.find(([re]) => re.test(t));
  return hit ? `${hit[1]} GB` : null;
}

/**
 * SLURM's zone-less cluster-local `YYYY-MM-DDTHH:MM:SS`, in the same format as `formatTime`.
 * The wall-clock digits are kept as-is (no zone conversion); callers keep the raw value in a title.
 */
export function clusterTime(s: string | null, now = new Date()): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return displayTime(new Date(y, mo - 1, d, h, mi), now);
}
