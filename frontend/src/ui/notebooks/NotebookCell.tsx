import { memo, useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../../logic/notebooks/markdown';
import type { CellType, Row } from '../../logic/notebooks/notebook';
import type { CellRun, NotebookDoc } from '../../logic/notebooks/useNotebookDoc';
import { Icon } from '../components/ui';
import { CodeEditor } from '../editor/CodeEditor';
import { CellOutputs } from './CellOutputs';
import { RichTree } from './RichTree';

const Outputs = memo(CellOutputs);

function seconds(ms: number) {
  return ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function RunStatus({ run }: { run: CellRun | undefined }) {
  if (!run) return null;
  if (run.state === 'queued') return <span className="nb-status muted">Waiting for the kernel…</span>;
  if (run.state === 'running')
    return (
      <span className="nb-status busy">
        <span className="nb-spinner" aria-hidden="true" />
        Running
      </span>
    );
  return (
    <span className={`nb-status ${run.ok ? 'ok' : 'bad'}`}>
      <span aria-hidden="true">{run.ok ? '✓' : '✕'}</span> {run.ok ? 'Done' : 'Failed'} in {seconds(run.ms)}
    </span>
  );
}

const TYPE_LABEL: Record<CellType, string> = { code: 'Python', markdown: 'Markdown', raw: 'Raw' };

/**
 * One cell, laid out like JupyterLab: prompt gutter (`[n]`, `[*]`, ▶ on hover), the source (an
 * editor, or rendered Markdown until double-clicked), outputs, and a floating toolbar when selected.
 */
export function NotebookCell({
  row,
  index,
  count,
  doc,
  selected,
  editing,
  run,
  onSave,
}: {
  row: Row;
  index: number;
  count: number;
  doc: NotebookDoc;
  selected: boolean;
  editing: boolean;
  run: CellRun | undefined;
  onSave: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { cell, key } = row;
  const type = cell.cell_type;
  const pending = run?.state === 'queued' || run?.state === 'running';
  const n = index + 1;
  const text = doc.textOf(key);
  const rendered = useMemo(
    () => (type === 'markdown' && !editing ? renderMarkdown(text, cell.attachments) : null),
    [type, editing, text, cell.attachments],
  );

  // Command mode: the selected cell holds focus (not its editor) so Jupyter keys reach the page.
  useEffect(() => {
    const el = ref.current;
    const a = document.activeElement;
    if (!selected || editing || !el) return;
    if (!el.contains(a) || (a instanceof HTMLElement && a.closest('.code-editor'))) {
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selected, editing]);

  const cls = ['nb-cell', `type-${type}`, selected && 'selected', editing && 'editing', pending && 'running']
    .filter(Boolean)
    .join(' ');

  return (
    <section
      ref={ref}
      className={cls}
      tabIndex={-1}
      aria-label={`Cell ${n}, ${TYPE_LABEL[type]}`}
      onMouseDown={() => !selected && doc.select(key)}
    >
      <div className="nb-gutter">
        {type === 'code' && (
          <>
            <button
              className="nb-run"
              aria-label={`Run cell ${n}`}
              title="Run cell (⇧ Enter runs and moves on)"
              onClick={() => doc.run(key, 'stay')}
            >
              {pending ? <span className="nb-spinner" aria-hidden="true" /> : <Icon name="play" size={14} />}
            </button>
            <span className="nb-prompt in" aria-label={pending ? 'Running' : undefined}>
              [{pending ? '*' : (cell.execution_count ?? ' ')}]:
            </span>
          </>
        )}
      </div>
      <div className="nb-body">
        {selected && (
          <div className="nb-cell-tools" role="toolbar" aria-label={`Cell ${n} actions`}>
            <label className="sr-only" htmlFor={`cell-type-${key}`}>
              Cell {n} type
            </label>
            <select id={`cell-type-${key}`} value={type} onChange={(e) => doc.setType(key, e.target.value as CellType)}>
              <option value="code">Python</option>
              <option value="markdown">Markdown</option>
              <option value="raw">Raw</option>
            </select>
            <button
              className="btn ghost icon-btn small"
              aria-label={`Move cell ${n} up`}
              disabled={index === 0}
              onClick={() => doc.move(key, -1)}
            >
              <Icon name="up" size={14} />
            </button>
            <button
              className="btn ghost icon-btn small"
              aria-label={`Move cell ${n} down`}
              disabled={index === count - 1}
              onClick={() => doc.move(key, 1)}
            >
              <Icon name="down" size={14} />
            </button>
            {type === 'code' && (cell.outputs?.length ?? 0) > 0 && (
              <button
                className="btn ghost icon-btn small"
                aria-label={`Clear cell ${n} output`}
                title="Clear output"
                onClick={() => doc.clearOutputs(key)}
              >
                <Icon name="clear" size={14} />
              </button>
            )}
            <button
              className="btn ghost icon-btn small danger"
              aria-label={`Delete cell ${n}`}
              title="Delete cell (D D)"
              onClick={() => doc.remove(key)}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        )}
        {rendered ? (
          <div
            className={`nb-markdown${text.trim() ? '' : ' empty'}`}
            onDoubleClick={() => doc.edit(key)}
            title="Double-click (or press Enter) to edit"
          >
            {text.trim() ? (
              <RichTree nodes={rendered} />
            ) : (
              <p className="muted">Empty Markdown cell. Double-click to write.</p>
            )}
          </div>
        ) : (
          <div className="nb-input">
            <CodeEditor
              key={`${key}-${type}`}
              initial={text}
              lang={doc.cellLang(row)}
              compact
              cell
              active={editing}
              label={`Cell ${n} source`}
              placeholder={
                type === 'markdown'
                  ? 'Write Markdown… (⇧ Enter to render)'
                  : type === 'code'
                    ? 'Python code… (⇧ Enter to run)'
                    : ''
              }
              onChange={(t) => doc.setText(key, t)}
              onFocus={() => doc.edit(key)}
              onEscape={() => doc.edit(null)}
              onRun={(then) => doc.run(key, then)}
              onSave={onSave}
            />
          </div>
        )}
        {type === 'code' && <Outputs outputs={cell.outputs ?? []} cell={n} />}
        <RunStatus run={run} />
      </div>
    </section>
  );
}
