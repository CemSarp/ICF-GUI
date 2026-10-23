import { fileKind, sizeLimit } from '../editor/languages';
import type { Entry } from '../../types';

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export const isDir = (e: Entry) => e.kind === 'dir' || e.targetKind === 'dir';
/** Regular (not linked) text files the editor supports, within its size limit. */
export const editable = (e: Entry) =>
  e.kind === 'file' && !e.unsupported && fileKind(e.name) !== null && e.size <= sizeLimit(e.name);

/** Path segments from `/` down; only those at or below the home folder can be opened. */
export function crumbTrail(path: string, home: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.map((part, i) => {
    const p = `/${parts.slice(0, i + 1).join('/')}`;
    return { part, path: p, last: i === parts.length - 1, inside: p === home || p.startsWith(`${home}/`) };
  });
}

/** Empty notebook (nbformat 4.5) with one code cell and a Python 3 kernel. */
const NOTEBOOK_TEMPLATE =
  JSON.stringify(
    {
      cells: [{ cell_type: 'code', execution_count: null, id: 'c0ffee01', metadata: {}, outputs: [], source: [] }],
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  ) + '\n';

export const NEW_FILE_TYPES = {
  python: { label: 'Python', ext: '.py', template: '' },
  notebook: { label: 'Jupyter notebook', ext: '.ipynb', template: NOTEBOOK_TEMPLATE },
  cuda: { label: 'CUDA', ext: '.cu', template: '' },
  cpp: { label: 'C++', ext: '.cpp', template: '' },
  c: { label: 'C', ext: '.c', template: '' },
  header: { label: 'C/C++ header', ext: '.h', template: '' },
  markdown: { label: 'Markdown', ext: '.md', template: '' },
  text: { label: 'Plain text', ext: '.txt', template: '' },
} as const;
export type NewFileType = keyof typeof NEW_FILE_TYPES;
