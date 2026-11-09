import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { CATEGORIES, LIBRARY, filterLibrary, type CategoryId } from '../../logic/terminal/library';
import { usePersistentState } from '../../logic/persist';
import { useCustomCommands } from '../../logic/terminal/useLibrary';
import { useTerminal } from '../../logic/terminal/useTerminal';
import { Badge, Icon, Notice } from '../components/ui';

const DEFAULT_LIB_W = 480;

type Tab = CategoryId | 'all' | 'mine';

/**
 * Head node terminal: a login shell on ICF over the app's connection, beside a library of common
 * commands. Insert types a command at the prompt; the user edits <placeholders> and presses Enter.
 */
export function TerminalView({ active }: { active: boolean }) {
  const { hostRef, status, message, insert, restart } = useTerminal(active);
  const { custom, add, remove } = useCustomCommands();
  const [libOpen, setLibOpen] = usePersistentState('terminal.libraryOpen', true);
  const [libWidth, setLibWidth] = usePersistentState('terminal.libraryWidth', DEFAULT_LIB_W);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const ready = status === 'live';

  const mine = custom.map((c) => ({ ...c, category: 'mine', note: undefined, warn: false }));
  const entries = tab === 'mine' ? mine : filterLibrary(tab === 'all' ? [...LIBRARY, ...mine] : LIBRARY, tab, '');
  const shown = filterLibrary(entries, 'all', query);
  const blurb = CATEGORIES.find((c) => c.id === tab)?.blurb;

  const clampW = (w: number) => Math.round(Math.min(Math.max(w, 240), Math.max(240, window.innerWidth - 480)));
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const right = e.currentTarget.parentElement!.getBoundingClientRect().right;
    setLibWidth(clampW(right - e.clientX));
  };
  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setLibWidth(clampW(libWidth + 20));
    else if (e.key === 'ArrowRight') setLibWidth(clampW(libWidth - 20));
  };

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
      },
      () => {},
    );
  };

  return (
    <div className={`term-page${libOpen ? '' : ' lib-closed'}`} style={{ '--lib-w': `${libWidth}px` } as CSSProperties}>
      <section className="term-main" aria-label="Head node terminal">
        <div className="term-bar">
          <span className="term-status" role="status">
            {status === 'starting' && 'Starting…'}
            {status === 'live' && (
              <Badge tone="ok" glyph="●">
                Connected to the head node
              </Badge>
            )}
            {status === 'ended' && <Badge tone="muted">Session ended</Badge>}
            {status === 'error' && <Badge tone="bad">Could not start</Badge>}
          </span>
          <span className="spacer" />
          {(status === 'ended' || status === 'error') && (
            <button className="btn primary" onClick={restart}>
              <Icon name="refresh" />
              New session
            </button>
          )}
          <button className="btn ghost" aria-expanded={libOpen} onClick={() => setLibOpen(!libOpen)}>
            {libOpen ? 'Hide library' : 'Show library'}
          </button>
        </div>
        {status === 'error' && (
          <Notice tone="bad" title="The terminal could not start">
            {message}
          </Notice>
        )}
        <div className="term-host" ref={hostRef} aria-label="Terminal" />
        <p className="muted small term-hint">
          This is your own shell on the login node: it can do anything your account can. Heavy work belongs in a job.
        </p>
      </section>

      {libOpen && (
        <div
          className={`term-split${dragging ? ' dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize command library"
          title="Drag to resize, double-click to reset"
          onDoubleClick={() => setLibWidth(clampW(DEFAULT_LIB_W))}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={drag}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={nudge}
        />
      )}
      {libOpen && (
        <aside className="term-lib" aria-label="Command library">
          <h2 className="term-lib-title">Command library</h2>
          <input
            type="search"
            placeholder="Search commands…"
            aria-label="Search commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="chips" role="group" aria-label="Category">
            {(
              [{ id: 'all', label: 'All' }, ...CATEGORIES, { id: 'mine', label: 'Mine' }] as {
                id: Tab;
                label: string;
              }[]
            ).map((c) => (
              <button key={c.id} className="chip" aria-pressed={tab === c.id} onClick={() => setTab(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          {blurb && <p className="muted small">{blurb}</p>}
          <p className="muted small">
            Insert types the command at the prompt. Edit anything in &lt;brackets&gt;, then press Enter.
          </p>

          <ul className="term-list">
            {shown.map((x) => (
              <li key={x.id} className="term-cmd">
                <div className="term-cmd-head">
                  <strong>{x.title}</strong>
                  {x.warn && (
                    <Badge tone="warn" glyph="⚠">
                      Deletes
                    </Badge>
                  )}
                </div>
                <code>{x.command}</code>
                {x.note && <div className="muted small">{x.note}</div>}
                <div className="term-cmd-actions">
                  <button className="btn" disabled={!ready} onClick={() => insert(x.command)}>
                    Insert
                  </button>
                  <button className="btn ghost" onClick={() => copy(x.id, x.command)}>
                    {copied === x.id ? 'Copied' : 'Copy'}
                  </button>
                  {x.category === 'mine' && (
                    <button className="btn ghost danger" onClick={() => remove(x.id)} aria-label={`Remove ${x.title}`}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="muted small">{tab === 'mine' ? 'Nothing saved yet.' : 'No command matches.'}</li>
            )}
          </ul>

          <form
            className="term-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (add(title, command)) {
                setTitle('');
                setCommand('');
                setTab('mine');
              }
            }}
          >
            <h3>Save your own</h3>
            <input
              placeholder="Name (optional)"
              aria-label="Name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              placeholder="One command"
              aria-label="Command to save"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!command.trim()}>
              <Icon name="plus" />
              Save
            </button>
          </form>
        </aside>
      )}
    </div>
  );
}
