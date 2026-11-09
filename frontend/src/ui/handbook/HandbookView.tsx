import { useHandbook } from '../../logic/handbook/handbook';
import { Icon, Notice } from '../components/ui';
import { RichTree } from '../notebooks/RichTree';
import '../../styles/notebook.css';

const jump = (id: string) => document.getElementById(`hb-${id}`)?.scrollIntoView({ block: 'start' });

/** The handbook: every feature and setting, searchable, and exportable for an AI assistant. */
export function HandbookView() {
  const { intro, sections, shown, rendered, query, setQuery, save, copy, msg } = useHandbook();
  return (
    <div className="handbook">
      <section className="card handbook-head">
        <div className="nb-markdown">
          <RichTree nodes={intro} />
        </div>
        <div className="actions start">
          <button className="btn primary" onClick={() => void save()}>
            <Icon name="download" />
            Save as Markdown…
          </button>
          <button className="btn" onClick={copy}>
            Copy all
          </button>
          <span className="muted small">Give the file to an AI assistant and ask it anything about the app.</span>
        </div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <input
          type="search"
          className="handbook-search"
          placeholder="Search the handbook, e.g. GPU session idle"
          aria-label="Search the handbook"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </section>
      <div className="handbook-grid">
        <nav className="handbook-toc" aria-label="Handbook contents">
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <button className="link" disabled={!shown.includes(s)} onClick={() => jump(s.id)}>
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="handbook-body">
          {shown.length === 0 && <p className="muted">Nothing in the handbook matches “{query}”.</p>}
          {shown.map((s) => (
            <section key={s.id} id={`hb-${s.id}`} className="card nb-markdown handbook-section">
              <RichTree nodes={rendered.get(s.id) ?? []} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
