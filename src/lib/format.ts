import type { ConnState, NodeState } from '../types';

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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
