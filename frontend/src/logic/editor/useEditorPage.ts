import { useRef, useState } from 'react';
import { usePageGuard, type PageGuard } from '../app/guard';
import { usePersistentState } from '../persist';
import { appendOutput } from '../notebooks/outputs';
import type { CellRun } from '../notebooks/useNotebookDoc';
import { useKernel } from '../notebooks/useKernel';
import type { NotebookOutput } from '../../types';
import { runCode, runLang } from './runFile';
import { useFileEditor } from './useFileEditor';

/**
 * The editor page: conflict-checked editing, and for Python / CUDA / C++ / C files "Run on GPU":
 * the current text runs on this page's own kernel (same review sheet and lifetime as a notebook's),
 * with its output streamed into the page.
 */
export function useEditorPage(path: string, onGuard: (g: PageGuard | null) => void) {
  const [dirty, setDirty] = useState(false);
  const file = useFileEditor(path, setDirty);
  const kernel = useKernel();
  const lang = runLang(path);
  const name = path.split('/').pop() ?? path;
  const [outputs, setOutputs] = useState<NotebookOutput[]>([]);
  const [run, setRun] = useState<CellRun | null>(null);
  const [args, setArgs] = usePersistentState(`run.args.${path}`, '');
  const [kernelSheet, setKernelSheet] = useState(false);
  const clearPending = useRef(false);
  usePageGuard(name, dirty, kernel.active, onGuard);

  const runFile = () => {
    if (!lang) return;
    let since = 0;
    const ok = kernel.exec(runCode(path, file.currentText(), args), {
      started: () => {
        since = Date.now();
        setRun({ state: 'running', since });
      },
      output: (o) =>
        setOutputs((list) => {
          const base = clearPending.current ? [] : list;
          clearPending.current = false;
          return appendOutput(base, o);
        }),
      clear: (wait) => (wait ? (clearPending.current = true) : setOutputs([])),
      done: (_count, status) =>
        setRun(status === 'aborted' ? null : { state: 'done', ok: status === 'ok', ms: since ? Date.now() - since : 0 }),
    });
    if (!ok) return setKernelSheet(true);
    clearPending.current = false;
    setOutputs([]);
    setRun({ state: 'queued' });
  };
  const clearOutput = () => {
    setOutputs([]);
    setRun(null);
  };
  /** A CUDA file on a kernel whose node has no nvcc (no CUDA toolchain was loaded). */
  const missingNvcc = lang === 'cuda' && kernel.state.phase === 'ready' && !kernel.state.tools.includes('nvcc');

  return {
    ...file,
    dirty,
    name,
    lang,
    kernel,
    outputs,
    run,
    args,
    setArgs,
    runFile,
    clearOutput,
    missingNvcc,
    kernelSheet,
    setKernelSheet,
  };
}
