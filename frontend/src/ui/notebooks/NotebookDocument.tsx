import { type MutableRefObject, type ReactNode } from 'react';
import type { ParsedNotebook } from '../../logic/notebooks/notebook';
import type { Kernel } from '../../logic/notebooks/useKernel';
import { useNotebookDoc } from '../../logic/notebooks/useNotebookDoc';
import { Icon } from '../components/ui';
import { NotebookCell } from './NotebookCell';

/** Keys typed into these stay theirs; everything else on the page is Jupyter's command mode. */
const OWN_KEYS = '.code-editor, input, select, textarea, button, a, [role="dialog"]';

/**
 * The notebook itself: toolbar, cells and the insert bars between them. `kernelControls` and
 * `fileControls` come from the page (kernel chip, save, full screen).
 */
export function NotebookDocument({
  parsed,
  serializeRef,
  onDirty,
  onSave,
  kernel,
  needKernel,
  readOnly,
  kernelControls,
  fileControls,
}: {
  parsed: ParsedNotebook;
  serializeRef: MutableRefObject<(() => string) | null>;
  onDirty: () => void;
  onSave: () => void;
  kernel: Kernel;
  needKernel: () => void;
  readOnly: boolean;
  kernelControls: ReactNode;
  fileControls: ReactNode;
}) {
  const doc = useNotebookDoc({ parsed, onDirty, serializeRef, kernel, onSave, needKernel });
  const ready = kernel.state.phase === 'ready';

  const inserter = (at: number, label: string) => (
    <div className="nb-insert" role="group" aria-label={label}>
      <button className="nb-insert-btn" onClick={() => doc.add(at, 'code')}>
        <Icon name="plus" size={12} /> Code
      </button>
      <button className="nb-insert-btn" onClick={() => doc.add(at, 'markdown')}>
        <Icon name="plus" size={12} /> Markdown
      </button>
    </div>
  );

  return (
    <div
      className="notebook"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest(OWN_KEYS)) return;
        if (doc.onCommandKey(e)) e.preventDefault();
      }}
    >
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <div className="nb-tool-group">
          <button
            className="btn ghost small"
            onClick={() =>
              doc.selected === null ? doc.add(doc.rows.length, 'code') : doc.insert(doc.selected, 'below', 'code', true)
            }
            aria-label="Insert code cell below"
            title="Insert a code cell below (B)"
          >
            <Icon name="plus" size={14} /> Code
          </button>
          <button
            className="btn ghost small"
            onClick={() =>
              doc.selected === null
                ? doc.add(doc.rows.length, 'markdown')
                : doc.insert(doc.selected, 'below', 'markdown', true)
            }
            aria-label="Insert Markdown cell below"
            title="Insert a Markdown cell below"
          >
            <Icon name="plus" size={14} /> Markdown
          </button>
        </div>
        <span className="nb-tool-sep" aria-hidden="true" />
        <div className="nb-tool-group">
          <button
            className="btn ghost icon-btn small"
            aria-label="Run selected cell"
            title="Run selected cell (⇧ Enter)"
            disabled={doc.selected === null}
            onClick={() => doc.selected !== null && doc.run(doc.selected, 'advance')}
          >
            <Icon name="play" size={14} />
          </button>
          <button className="btn ghost small" onClick={doc.runAll} title="Run all cells from the top">
            <Icon name="playAll" size={14} /> Run all
          </button>
          <button
            className="btn ghost icon-btn small"
            aria-label="Interrupt the kernel"
            title="Interrupt (I I)"
            disabled={!ready}
            onClick={kernel.interrupt}
          >
            <Icon name="stop" size={14} />
          </button>
          <button
            className="btn ghost icon-btn small"
            aria-label="Restart the kernel"
            title="Restart: clears all variables (0 0)"
            disabled={!ready}
            onClick={kernel.restart}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="btn ghost icon-btn small"
            aria-label="Clear all outputs"
            title="Clear all outputs"
            onClick={doc.clearAll}
          >
            <Icon name="clear" size={14} />
          </button>
        </div>
        <span className="spacer" />
        {kernelControls}
        <span className="nb-tool-sep" aria-hidden="true" />
        {fileControls}
      </div>
      {readOnly && (
        <p className="muted small nb-readonly">Read-only: you can run cells, but changes cannot be saved.</p>
      )}

      <div className="nb-cells">
        {doc.rows.length === 0 ? (
          <div className="nb-empty">
            <p className="muted">This notebook has no cells yet.</p>
            {inserter(0, 'Add the first cell')}
          </div>
        ) : (
          <>
            {inserter(0, 'Insert at the top')}
            {doc.rows.map((r, i) => (
              <div key={r.key} className="nb-slot">
                <NotebookCell
                  row={r}
                  index={i}
                  count={doc.rows.length}
                  doc={doc}
                  selected={doc.selected === r.key}
                  editing={doc.editing === r.key}
                  run={doc.runs[r.key]}
                  onSave={onSave}
                />
                {inserter(i + 1, `Insert after cell ${i + 1}`)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
