import type { GpuTotals } from '../../types';

const SEGMENTS = [
  { key: 'potentiallyFree', label: 'Potentially free', cls: 'seg-free', glyph: '○' },
  { key: 'allocated', label: 'Allocated', cls: 'seg-alloc', glyph: '●' },
  { key: 'unavailable', label: 'Unavailable (down/drain)', cls: 'seg-unavail', glyph: '✕' },
  { key: 'unknown', label: 'Unknown', cls: 'seg-unknown', glyph: '?' },
] as const;

export function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      {SEGMENTS.map((s) => (
        <li key={s.key}>
          <span className={`swatch ${s.cls}`} aria-hidden="true" />
          <span aria-hidden="true">{s.glyph}</span> {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Stacked bar with exact numbers as text; the bar is decorative, the numbers carry meaning. */
export function GpuBar({ t, compact = false }: { t: GpuTotals; compact?: boolean }) {
  const total = Math.max(t.configured, 1);
  const summary = SEGMENTS.map((s) => `${t[s.key]} ${s.label.toLowerCase()}`).join(', ');
  return (
    <div className="gpubar-wrap">
      <div className="gpubar" role="img" aria-label={`${t.modelLabel}: ${t.configured} configured; ${summary}`}>
        {SEGMENTS.map((s) =>
          t[s.key] > 0 ? (
            <span key={s.key} className={`seg ${s.cls}`} style={{ width: `${(t[s.key] / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      {!compact && (
        <div className="gpubar-nums" aria-hidden="true">
          <span title="Potentially free">○ {t.potentiallyFree}</span>
          <span title="Allocated">● {t.allocated}</span>
          {t.unavailable > 0 && <span title="Unavailable">✕ {t.unavailable}</span>}
          {t.unknown > 0 && <span title="Unknown">? {t.unknown}</span>}
          <span className="muted">/ {t.configured}</span>
        </div>
      )}
    </div>
  );
}
