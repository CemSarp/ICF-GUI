import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { usePersistentState } from '../../logic/persist';

/** Outline icons drawn on a 24-pt grid with SF Symbols-like proportions (1.75 stroke, round caps). */
const PATHS = {
  overview: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  partitions: 'M4 5h16v14H4zM4 9.7h16M4 14.3h16',
  nodes: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5',
  request: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM12 8.5v7M8.5 12h7',
  jobs: 'M9 6.5h11M9 12h11M9 17.5h11M4.75 6.5h.01M4.75 12h.01M4.75 17.5h.01',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  training: 'M4 4.5v15h16M7.5 15l3.5-4.5 3 2.5 5-6.5',
  transfers: 'M7.5 19.5v-15M4 8l3.5-3.5L11 8M16.5 4.5v15M13 16l3.5 3.5L20 16',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  forward: 'M9.5 5.5L16 12l-6.5 6.5',
  up: 'M5.5 14.5L12 8l6.5 6.5',
  down: 'M5.5 9.5L12 16l6.5-6.5',
  upload: 'M12 19.5v-14M6.5 11L12 5.5l5.5 5.5',
  download: 'M12 4.5v14M6.5 13l5.5 5.5 5.5-5.5',
  home: 'M4 11l8-6.5 8 6.5M6.5 9.5V19.5h11V9.5',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  file: 'M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM12 11v5.5M12 7.75h.01',
  warn: 'M12 4l8.5 15h-17zM12 10v4M12 16.75h.01',
  bad: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5',
  ok: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM8.25 12.25l2.5 2.5L15.75 9.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  external: 'M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10',
  chip: 'M7 7h10v10H7zM10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5',
  code: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14',
  layers: 'M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5',
  notebook: 'M6.5 3.5h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-11zM10 8h5.5M10 11.5h5.5M4 7h5M4 12h5M4 17h5',
  play: 'M8 5.5v13l10-6.5z',
  playAll: 'M4.5 6v12l7.5-6zM12.5 6v12l7.5-6z',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
  clear: 'M4 6.5h10M4 12h7M4 17.5h7M14.5 13.5l5 5M19.5 13.5l-5 5',
  expand: 'M14.5 4.5h5v5M19.5 4.5l-6 6M9.5 19.5h-5v-5M4.5 19.5l6-6',
  collapse: 'M19.5 4.5l-6 6M13.5 5.5v5h5M4.5 19.5l6-6M10.5 18.5v-5h-5',
  keyboard: 'M3.5 6.5h17v11h-17zM7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14h8',
  chevron: 'M9.5 5.5L16 12l-6.5 6.5',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The one "go up a level" control, used by every detail screen. */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn plain back" onClick={onClick}>
      <Icon name="back" />
      {label}
    </button>
  );
}

/**
 * A number field that can be emptied while typing: `onChange` gets only real numbers, so clearing
 * "12" to type "8" never shows 0 or 08. Left empty, it shows the last number again on blur.
 */
export function NumberInput({
  value,
  onChange,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    // Changed from outside (a preset, a reset): show it.
    setShown(value);
    setText(String(value));
  }
  return (
    <input
      {...rest}
      type="number"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
      onBlur={(e) => {
        if (e.target.value === '') setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}

export function Badge({ tone, glyph, children }: { tone: string; glyph?: string; children: ReactNode }) {
  return (
    <span className={`badge tone-${tone}`}>
      {glyph && <span aria-hidden="true">{glyph} </span>}
      {children}
    </span>
  );
}

/** One row of an inset grouped list (wrap rows in `.rows`): tinted glyph, title, detail, trailing control. */
export function Row({
  icon,
  tone = 'info',
  title,
  children,
  trailing,
}: {
  icon: IconName;
  tone?: 'info' | 'warn' | 'bad' | 'ok' | 'muted';
  title: ReactNode;
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="list-row">
      <span className={`list-glyph tone-${tone}`}>
        <Icon name={icon} size={18} />
      </span>
      <div className="list-text">
        <strong>{title}</strong>
        {children && <div className="muted small">{children}</div>}
      </div>
      {trailing && <div className="list-trailing">{trailing}</div>}
    </div>
  );
}

/**
 * A card that folds to its title and a one-line summary. Starts closed; open or closed is
 * remembered per card. The header actions only show while it is open.
 */
export function CollapsibleCard({
  id,
  title,
  summary,
  actions,
  children,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistentState(`fold.${id}`, false);
  return (
    <section className={`card fold${open ? ' is-open' : ''}`} aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h3 id={`${id}-title`}>
          <button
            className="fold-toggle"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={() => setOpen(!open)}
          >
            {title}
          </button>
        </h3>
        {open ? actions : summary && <div className="fold-summary">{summary}</div>}
      </div>
      {open && <div id={`${id}-body`}>{children}</div>}
    </section>
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
  return (
    <div className={`notice tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={tone} size={18} />
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
