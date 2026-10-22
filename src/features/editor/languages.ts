export type Lang = 'python' | 'cpp' | 'cuda' | 'markdown' | 'text';
export type FileKind = Lang | 'notebook';

const BY_EXT: Record<string, FileKind> = {
  py: 'python',
  pyi: 'python',
  ipynb: 'notebook',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cu: 'cuda',
  cuh: 'cuda',
  md: 'markdown',
};
/** Plain-text files the editor also opens (no colours, same indentation and search). */
const TEXT_EXT = new Set([
  'txt',
  'sh',
  'bash',
  'json',
  'yaml',
  'yml',
  'toml',
  'cfg',
  'ini',
  'csv',
  'tsv',
  'log',
  'rst',
  'tex',
  'r',
  'jl',
  'slurm',
  'sbatch',
  'env',
]);
const TEXT_NAMES = new Set([
  'Makefile',
  'Dockerfile',
  'CMakeLists.txt',
  'requirements.txt',
  '.gitignore',
  '.bashrc',
  '.profile',
  'README',
]);

const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** What the in-app editor does with this file name; `null` = not offered (binary or unknown). */
export function fileKind(name: string): FileKind | null {
  const base = name.split('/').pop() ?? name;
  return BY_EXT[ext(base)] ?? (TEXT_EXT.has(ext(base)) || TEXT_NAMES.has(base) ? 'text' : null);
}

export const KIND_LABEL: Record<FileKind, string> = {
  python: 'Python',
  cpp: 'C / C++',
  cuda: 'CUDA',
  markdown: 'Markdown',
  text: 'Plain text',
  notebook: 'Jupyter notebook',
};

/** Same limits as the backend (2 MB text, 20 MB notebooks). */
export const sizeLimit = (name: string) => (fileKind(name) === 'notebook' ? 20 : 2) * 1024 * 1024;
