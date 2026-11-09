import { useEffect, useRef, useState } from 'react';
import { START_HERE, useHandbook } from '../../logic/handbook/handbook';
import { Icon, Notice, type IconName } from '../components/ui';
import { RichTree } from '../notebooks/RichTree';
import '../../styles/notebook.css';

const START_ICONS: IconName[] = ['request', 'code', 'warn', 'settings'];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The handbook: every feature and setting, searchable, and exportable for an AI assistant. */
export function HandbookView() {
  const { intro, groups, total, shown, nodesFor, query, setQuery, save, copy, msg } = useHandbook();
  const search = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<string | null>(null);

  // ⌘F searches the handbook, as in any Mac document window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Searching brings the first match into view, so it is clear why a section is listed.
  useEffect(() => {
    if (query.trim()) document.querySelector('.hb-section mark')?.scrollIntoView?.({ block: 'center' });
  }, [query]);

  // The contents list follows the section being read.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActive(hit.target.id.slice(3));
      },
      { root: document.getElementById('main'), rootMargin: '-90px 0px -65% 0px' },
    );
    document.querySelectorAll('.hb-section').forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [shown]);

  const jump = (id: string) => {
    document
      .getElementById(`hb-${id}`)
      ?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    setActive(id);
  };

  return (
    <div className="hb">
      <header className="hb-head">
        <div className="hb-lead nb-markdown">
          <RichTree nodes={intro} />
        </div>
        <div className="hb-actions">
          <button className="btn" onClick={copy}>
            Copy all
          </button>
          <button className="btn" onClick={() => void save()}>
            <Icon name="download" />
            Save as Markdown…
          </button>
        </div>
      </header>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div className="hb-search" role="search">
        <Icon name="search" />
        <input
          ref={search}
          type="search"
          placeholder="Search the handbook"
          aria-label="Search the handbook"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          spellCheck={false}
        />
        <span className="hb-count" aria-live="polite">
          {query ? `${shown.length} of ${total} sections` : <kbd>⌘F</kbd>}
        </span>
      </div>

      {!query && (
        <nav className="hb-start" aria-label="Start here">
          {START_HERE.map((s, i) => (
            <button key={s.id} className="hb-card" onClick={() => jump(s.id)}>
              <span className="hb-card-icon" aria-hidden="true">
                <Icon name={START_ICONS[i]!} />
              </span>
              <strong>{s.title}</strong>
              <span className="muted">{s.blurb}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="hb-grid">
        <nav className="hb-toc" aria-label="Handbook contents">
          {groups.map((g) => (
            <div key={g.label} className="hb-toc-group">
              <p className="hb-toc-heading">{g.label}</p>
              <ul>
                {g.sections.map((s) => (
                  <li key={s.id}>
                    <button
                      aria-current={(active ?? shown[0]?.id) === s.id ? 'location' : undefined}
                      disabled={!shown.includes(s)}
                      onClick={() => jump(s.id)}
                    >
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <article className="hb-doc">
          {shown.length === 0 ? (
            <div className="hb-empty">
              <Icon name="search" size={28} />
              <p>Nothing in the handbook matches “{query}”.</p>
              <p className="muted small">Try fewer words, or a label from the app such as “Avoid nodes”.</p>
            </div>
          ) : (
            shown.map((s) => (
              <section key={s.id} id={`hb-${s.id}`} className="hb-section nb-markdown">
                <RichTree nodes={nodesFor(s.id)} />
              </section>
            ))
          )}
        </article>
      </div>
    </div>
  );
}
