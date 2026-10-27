/** Files the editor can run on a kernel, and the magic that runs each (driver.py, ADR-031). */
export type RunLang = 'python' | 'cuda' | 'cpp' | 'c';

const BY_EXT: Record<string, RunLang> = { py: 'python', cu: 'cuda', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c' };
export const RUN_LABEL: Record<RunLang, string> = { python: 'Python', cuda: 'CUDA', cpp: 'C++', c: 'C' };

export function runLang(path: string): RunLang | null {
  const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  return path.includes('.') ? (BY_EXT[ext] ?? null) : null;
}

/** POSIX single quoting, as `shlex.split` on the node reads it. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The cell sent to the kernel to run a file's current text (saving is not needed): Python as a
 * script (`__main__`, `sys.argv`), CUDA / C++ / C compiled and run on the node. `args` are the
 * program's arguments as one shell-style line.
 */
export function runCode(path: string, text: string, args: string): string {
  const lang = runLang(path) ?? 'python';
  const a = args.replace(/[\r\n]+/g, ' ').trim();
  const tail = a ? ` -- ${a}` : '';
  const head = lang === 'python' ? `%%icfcc_script ${quote(path)}${tail}` : `%%${lang}${tail}`;
  return `${head}\n${text}`;
}
