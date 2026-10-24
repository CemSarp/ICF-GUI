import { useRef, useState, type MutableRefObject } from 'react';
import { commandKey, type KeyInput, type NotebookCommand } from './keys';
import { useNotebookCells, type ParsedNotebook } from './notebook';
import type { Kernel } from './useKernel';

/** Execution marker beside a code cell (not saved): waiting, running since, or last result. */
export type CellRun =
  { state: 'queued' } | { state: 'running'; since: number } | { state: 'done'; ok: boolean; ms: number };

/**
 * One open notebook: its cells, Jupyter's command/edit modes and keys, and running cells on the
 * page's kernel. `needKernel` is called when a code cell is run with no kernel (the page offers to
 * start one).
 */
export function useNotebookDoc({
  parsed,
  onDirty,
  serializeRef,
  kernel,
  onSave,
  needKernel,
}: {
  parsed: ParsedNotebook;
  onDirty: () => void;
  serializeRef: MutableRefObject<(() => string) | null>;
  kernel: Kernel;
  onSave: () => void;
  needKernel: () => void;
}) {
  const cells = useNotebookCells(parsed, onDirty, serializeRef);
  const [runs, setRuns] = useState<Record<number, CellRun>>({});
  const lastKey = useRef<string | null>(null);
  const setRun = (key: number, r: CellRun | null) =>
    setRuns((m) => {
      const next = { ...m };
      if (r) next[key] = r;
      else delete next[key];
      return next;
    });

  /** Send one code cell to the kernel; false if there is none. */
  const execute = (key: number) => {
    const code = cells.textOf(key);
    let since = 0;
    const ok = kernel.exec(code, {
      started: () => {
        since = Date.now();
        setRun(key, { state: 'running', since });
      },
      output: (o) => cells.pushOutput(key, o),
      clear: (wait) => cells.clearOutput(key, wait),
      done: (count, status) => {
        if (status === 'aborted') setRun(key, null);
        else setRun(key, { state: 'done', ok: status === 'ok', ms: since ? Date.now() - since : 0 });
        if (count !== null) cells.setCount(key, count);
      },
    });
    if (ok) {
      cells.beginRun(key);
      setRun(key, { state: 'queued' });
    }
    return ok;
  };

  /** Run (code) or render (Markdown) a cell, then stay, move on, or insert a cell below. */
  const run = (key: number, then: 'advance' | 'stay' | 'insert') => {
    const row = cells.rowsRef.current.find((r) => r.key === key);
    if (!row) return;
    if (row.cell.cell_type === 'code' && !execute(key)) {
      needKernel();
      return;
    }
    cells.edit(null); // running leaves edit mode (a Markdown cell renders)
    if (then === 'stay') {
      cells.select(key);
      return;
    }
    const next = then === 'advance' ? cells.after(key) : null;
    if (next) cells.select(next.key);
    else cells.insert(key, 'below', 'code', true);
  };

  const runAll = () => {
    const code = cells.rowsRef.current.filter((r) => r.cell.cell_type === 'code');
    if (code.length === 0) return;
    if (!kernel.active) {
      needKernel();
      return;
    }
    for (const r of code) execute(r.key);
  };

  const command = (c: NotebookCommand) => {
    const key = cells.selected;
    switch (c.t) {
      case 'save':
        return onSave();
      case 'interrupt':
        return kernel.interrupt();
      case 'restart':
        return kernel.restart();
    }
    if (key === null) {
      if (c.t === 'insert') cells.add(0, 'code', false);
      return;
    }
    switch (c.t) {
      case 'run':
        return run(key, c.then);
      case 'edit':
        return cells.edit(key);
      case 'select':
        return cells.selectRel(c.by);
      case 'insert':
        return void cells.insert(key, c.where);
      case 'delete':
        return cells.remove(key);
      case 'type':
        return cells.setType(key, c.to);
    }
  };

  /** Keys on the page outside any cell editor (command mode). True when handled. */
  const onCommandKey = (e: KeyInput) => {
    const c = commandKey(e, lastKey.current);
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.length === 1;
    // A double-press key consumes the pair; any other key breaks it.
    lastKey.current = plain && !(c && (c.t === 'delete' || c.t === 'interrupt' || c.t === 'restart')) ? e.key : null;
    if (c) command(c);
    return !!c;
  };

  return { ...cells, runs, run, runAll, command, onCommandKey };
}

export type NotebookDoc = ReturnType<typeof useNotebookDoc>;
