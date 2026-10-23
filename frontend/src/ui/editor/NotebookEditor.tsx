import { type MutableRefObject } from 'react';
import { Icon } from '../components/ui';
import {
  clipOutput,
  outputItem,
  useNotebookCells,
  type Output,
  type ParsedNotebook,
} from '../../logic/editor/notebook';
import { CodeEditor } from './CodeEditor';

function Clip({ text, tone }: { text: string; tone?: string }) {
  const { shown, hidden } = clipOutput(text);
  return (
    <pre className={`nb-out${tone ? ` ${tone}` : ''}`}>
      {shown}
      {hidden > 0 && `\n… ${hidden} more lines`}
    </pre>
  );
}

const STREAM_TONE = { stderr: 'warn-text', error: 'nb-error' } as const;

function Outputs({ outputs }: { outputs: Output[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="nb-outputs" aria-label="Cell output (read-only)">
      {outputs.map((o, i) => {
        const item = outputItem(o);
        if (!item) return null;
        if (item.kind === 'image') return <img key={i} className="nb-img" alt="Cell output image" src={item.src} />;
        return <Clip key={i} text={item.text} tone={item.stream ? STREAM_TONE[item.stream] : undefined} />;
      })}
    </div>
  );
}

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
  const { rows, add, move, remove, setText, cellLang } = useNotebookCells(parsed, onDirty, serializeRef);

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
              onClick={() => remove(r.key)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <CodeEditor
            initial={r.text}
            lang={cellLang(r)}
            compact
            label={`Cell ${i + 1} source`}
            onSave={onSave}
            onChange={(text) => setText(r.key, text)}
          />
          {r.cell.cell_type === 'code' && <Outputs outputs={r.cell.outputs ?? []} />}
          {adder(i + 1)}
        </section>
      ))}
    </div>
  );
}
