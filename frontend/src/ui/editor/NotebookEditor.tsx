import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Icon } from '../components/ui';
import { CodeEditor } from './CodeEditor';
import type { Lang } from '../../logic/editor/languages';

type Source = string | string[];
interface Cell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: Source;
  execution_count?: number | null;
  outputs?: Output[];
  [k: string]: unknown;
}
interface Output {
  output_type: string;
  name?: string;
  text?: Source;
  data?: Record<string, Source>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface Notebook {
  cells: Cell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } };
  [k: string]: unknown;
}

export interface ParsedNotebook {
  nb: Notebook;
  indent: number;
  trailingNewline: boolean;
}

const join = (s: Source | undefined) => (Array.isArray(s) ? s.join('') : (s ?? ''));

/** nbformat stores source as lines that keep their `\n`; the last line has none. */
function toLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function parseNotebook(text: string): ParsedNotebook {
  const nb = JSON.parse(text) as Notebook;
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells))
    throw new Error('This file is not a Jupyter notebook.');
  const m = /^\{\r?\n( +)"/.exec(text);
  return { nb, indent: m ? m[1]!.length : 1, trailingNewline: text.endsWith('\n') };
}

/** Rebuild the file: only edited cells get a new `source`; everything else is kept as it was. */
export function serializeNotebook(p: ParsedNotebook, cells: { cell: Cell; text: string }[]): string {
  const out: Notebook = {
    ...p.nb,
    cells: cells.map(({ cell, text }) =>
      text === join(cell.source) ? cell : { ...cell, source: typeof cell.source === 'string' ? text : toLines(text) },
    ),
  };
  return JSON.stringify(out, null, p.indent) + (p.trailingNewline ? '\n' : '');
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const MAX_OUTPUT_LINES = 400;

function Clip({ text, tone }: { text: string; tone?: string }) {
  const lines = text.split('\n');
  const shown = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES).join('\n') : text;
  return (
    <pre className={`nb-out${tone ? ` ${tone}` : ''}`}>
      {shown}
      {lines.length > MAX_OUTPUT_LINES && `\n… ${lines.length - MAX_OUTPUT_LINES} more lines`}
    </pre>
  );
}

function Outputs({ outputs }: { outputs: Output[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="nb-outputs" aria-label="Cell output (read-only)">
      {outputs.map((o, i) => {
        if (o.output_type === 'stream')
          return <Clip key={i} text={join(o.text)} tone={o.name === 'stderr' ? 'warn-text' : undefined} />;
        if (o.output_type === 'error')
          return (
            <Clip
              key={i}
              tone="nb-error"
              text={(o.traceback ?? [`${o.ename}: ${o.evalue}`]).join('\n').replace(ANSI, '')}
            />
          );
        const png = o.data?.['image/png'];
        if (png)
          return (
            <img
              key={i}
              className="nb-img"
              alt="Cell output image"
              src={`data:image/png;base64,${join(png).replace(/\s/g, '')}`}
            />
          );
        const txt = o.data?.['text/plain'];
        return txt ? <Clip key={i} text={join(txt)} /> : null;
      })}
    </div>
  );
}

let nextKey = 0;
type Row = { key: number; cell: Cell; text: string };
const newCellId = () => Math.random().toString(16).slice(2, 10);

/**
 * Cell view of a notebook: one editor per cell, outputs read-only, add/move/delete cells.
 * `serializeRef` gives the parent the current file text at save time (no work per keystroke).
 */
export function NotebookEditor({
  parsed,
  onDirty,
  onSave,
  serializeRef,
}: {
  parsed: ParsedNotebook;
  onDirty: () => void;
  onSave: () => void;
  serializeRef: MutableRefObject<(() => string) | null>;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    parsed.nb.cells.map((cell) => ({ key: nextKey++, cell, text: join(cell.source) })),
  );
  const texts = useRef(new Map<number, string>());
  useEffect(() => {
    serializeRef.current = () =>
      serializeNotebook(
        parsed,
        rows.map((r) => ({ cell: r.cell, text: texts.current.get(r.key) ?? r.text })),
      );
  });
  const lang: Lang =
    (parsed.nb.metadata?.kernelspec?.language ?? parsed.nb.metadata?.language_info?.name ?? 'python').toLowerCase() ===
    'python'
      ? 'python'
      : 'text';

  const change = (f: (r: Row[]) => Row[]) => {
    // Fold in-progress text before restructuring so no edit is lost.
    setRows((rs) => f(rs.map((r) => ({ ...r, text: texts.current.get(r.key) ?? r.text }))));
    onDirty();
  };
  const add = (at: number, type: 'code' | 'markdown') => {
    const id = newCellId();
    const withId = (parsed.nb.nbformat ?? 4) > 4 || (parsed.nb.nbformat_minor ?? 0) >= 5 ? { id } : {};
    const cell: Cell =
      type === 'code'
        ? { cell_type: 'code', execution_count: null, ...withId, metadata: {}, outputs: [], source: [] }
        : { cell_type: 'markdown', ...withId, metadata: {}, source: [] };
    change((rs) => [...rs.slice(0, at), { key: nextKey++, cell, text: '' }, ...rs.slice(at)]);
  };
  const move = (i: number, by: number) =>
    change((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + by, 0, r!);
      return next;
    });

  const adder = (at: number) => (
    <div className="nb-add">
      <button className="btn plain small" onClick={() => add(at, 'code')}>
        + Code
      </button>
      <button className="btn plain small" onClick={() => add(at, 'markdown')}>
        + Markdown
      </button>
    </div>
  );

  return (
    <div className="notebook">
      {adder(0)}
      {rows.map((r, i) => (
        <section key={r.key} className="nb-cell" aria-label={`Cell ${i + 1}`}>
          <div className="nb-cell-head">
            <span className="muted small">
              {r.cell.cell_type === 'code'
                ? `Code [${r.cell.execution_count ?? ' '}]`
                : r.cell.cell_type === 'markdown'
                  ? 'Markdown'
                  : 'Raw'}
            </span>
            <span className="spacer" />
            <button
              className="btn ghost icon-btn small"
              aria-label={`Move cell ${i + 1} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <Icon name="up" size={14} />
            </button>
            <button
              className="btn ghost icon-btn small"
              aria-label={`Move cell ${i + 1} down`}
              disabled={i === rows.length - 1}
              onClick={() => move(i, 1)}
            >
              <Icon name="down" size={14} />
            </button>
            <button
              className="btn ghost icon-btn small danger"
              aria-label={`Delete cell ${i + 1}`}
              onClick={() => change((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <CodeEditor
            initial={r.text}
            lang={r.cell.cell_type === 'markdown' ? 'markdown' : r.cell.cell_type === 'code' ? lang : 'text'}
            compact
            label={`Cell ${i + 1} source`}
            onSave={onSave}
            onChange={(text) => {
              texts.current.set(r.key, text);
              onDirty();
            }}
          />
          {r.cell.cell_type === 'code' && <Outputs outputs={r.cell.outputs ?? []} />}
          {adder(i + 1)}
        </section>
      ))}
    </div>
  );
}
