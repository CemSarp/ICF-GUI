import { useEffect, useRef, type ReactNode } from 'react';

export function Badge({ tone, glyph, children }: { tone: string; glyph?: string; children: ReactNode }) {
  return (
    <span className={`badge tone-${tone}`}>
      {glyph && <span aria-hidden="true">{glyph} </span>}
      {children}
    </span>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'bad' | 'ok';
  title?: string;
  children: ReactNode;
}) {
  const glyph = { info: 'ℹ', warn: '⚠', bad: '✕', ok: '✓' }[tone];
  return (
    <div className={`notice tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <span aria-hidden="true" className="notice-glyph">
        {glyph}
      </span>
      <div>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

/** Modal with focus on open, Escape to dismiss and focus restore on close. */
export function Dialog({
  title,
  onClose,
  children,
  labelledBy = 'dialog-title',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button, input'))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]')];
        const [first, last] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === first) {
          last?.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first?.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
