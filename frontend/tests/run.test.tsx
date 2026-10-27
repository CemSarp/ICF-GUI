import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCode, runLang } from '../src/logic/editor/runFile';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';
import * as v3 from './v3Fixtures';

async function openFile(name: string) {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
  await screen.findByRole('heading', { name: v3.PROJECT });
  await userEvent.click(await screen.findByRole('button', { name }));
  await screen.findByRole('heading', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
  await waitFor(() =>
    expect(document.querySelector('.code-editor')?.shadowRoot?.querySelector('.cm-editor')).toBeTruthy(),
  );
}

async function startKernel() {
  const sheet = await screen.findByRole('dialog', { name: 'Start an interactive kernel' });
  await userEvent.click(within(sheet).getByRole('button', { name: 'Review' }));
  const start = await within(sheet).findByRole('button', { name: 'Start kernel' });
  for (const box of within(sheet).getAllByRole('checkbox')) await userEvent.click(box);
  await userEvent.click(start);
  await screen.findByText(/Python 3\.11\.9 · landonia01/);
}

const executed = () => backend.calls.filter((c) => c.cmd === 'kernel_execute').map((c) => c.args.code as string);

describe('Run on GPU (pure)', () => {
  it('knows which files run and builds the cell that runs them', () => {
    expect(['a.py', 'k.cu', 'm.cpp', 'm.cc', 'm.cxx', 'm.c', 'K.CU'].map(runLang)).toEqual([
      'python',
      'cuda',
      'cpp',
      'cpp',
      'cpp',
      'c',
      'cuda',
    ]);
    expect(['k.cuh', 'u.h', 'r.md', 'run.sh', 'Makefile'].map(runLang)).toEqual([null, null, null, null, null]);
    expect(runCode('/home/u/p/train.py', 'print(1)', '')).toBe("%%icfcc_script '/home/u/p/train.py'\nprint(1)");
    expect(runCode("/home/u/it's.py", 'x', '--epochs 3\n--lr 1')).toBe(
      "%%icfcc_script '/home/u/it'\\''s.py' -- --epochs 3 --lr 1\nx",
    );
    expect(runCode('/home/u/saxpy.cu', 'int main() {}', '1024')).toBe('%%cuda -- 1024\nint main() {}');
    expect(runCode('/home/u/hello.c', 'int main(void) {}', '')).toBe('%%c\nint main(void) {}');
  });
});

describe('Run on GPU in the editor', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('runs the current CUDA text (unsaved edits too) with arguments, after a reviewed kernel start', async () => {
    await openFile('kernel.cu');
    const bar = screen.getByRole('toolbar', { name: 'Run on a GPU node' });
    await userEvent.click(within(bar).getByRole('button', { name: /Run on GPU/ }));
    await startKernel(); // no kernel yet: Run opened the review sheet
    expect(backend.calls.find((c) => c.cmd === 'kernel_preview')!.args.request).toMatchObject({
      path: `${v3.PROJECT}/kernel.cu`,
      toolchain: v3.toolchains[0]!.spec,
    });
    const host = document.querySelector<HTMLElement>('.code-editor')!;
    const view = EditorView.findFromDOM(host.shadowRoot!.querySelector<HTMLElement>('.cm-editor')!)!;
    act(() => view.dispatch({ changes: { from: 0, insert: '// tuned\n' } }));
    await userEvent.type(within(bar).getByLabelText('Program arguments'), '1024');
    await userEvent.click(within(bar).getByRole('button', { name: /Run on GPU/ }));
    const out = await screen.findByRole('region', { name: 'Output' });
    await waitFor(() => expect(within(out).getByText('ran the cuda program')).toBeInTheDocument());
    expect(within(out).getByText(/Done in/)).toBeInTheDocument();
    expect(executed()).toEqual([`%%cuda -- 1024\n// tuned\n${v3.FILES[`${v3.PROJECT}/kernel.cu`]}`]);
    expect(backend.count('files_write')).toBe(0); // running never saves
  });

  it('shows Running, not waiting, while the program runs on a ready kernel', async () => {
    await openFile('kernel.cu');
    const bar = screen.getByRole('toolbar', { name: 'Run on a GPU node' });
    await userEvent.click(within(bar).getByRole('button', { name: /Start kernel/ }));
    await startKernel();
    backend.handlers.kernel_execute = () => null; // the program never finishes
    await userEvent.click(within(bar).getByRole('button', { name: /Run on GPU/ }));
    const out = await screen.findByRole('region', { name: 'Output' });
    expect(await within(out).findByText('Running')).toBeInTheDocument();
    expect(within(out).queryByText('Waiting for the kernel…')).toBeNull();
  });

  it('runs a Python file as a script with its path', async () => {
    backend.reset(connectedLive);
    await openFile('train.py');
    await userEvent.click(screen.getByRole('button', { name: 'Start kernel' }));
    await startKernel();
    await userEvent.click(screen.getByRole('button', { name: /Run on GPU/ }));
    await waitFor(() => expect(executed()).toHaveLength(1));
    expect(executed()[0]).toBe(`%%icfcc_script '${v3.PROJECT}/train.py'\n${v3.FILES[`${v3.PROJECT}/train.py`]}`);
  });

  it('asks before leaving the file while its kernel runs, then stops it', async () => {
    await openFile('kernel.cu');
    await userEvent.click(screen.getByRole('button', { name: 'Start kernel' }));
    await startKernel();
    await userEvent.click(screen.getByRole('button', { name: 'Project files' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stop the kernel?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Stop kernel and leave' }));
    await waitFor(() => expect(backend.count('kernel_stop', (a) => a.kernelId === 'k1')).toBe(1));
    // The sidebar asks too.
    await userEvent.click(await screen.findByRole('button', { name: 'kernel.cu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start kernel' }));
    await startKernel();
    await userEvent.click(screen.getByRole('button', { name: 'Cluster' }));
    expect(await screen.findByRole('dialog', { name: 'Stop the kernel?' })).toBeInTheDocument();
  });

  it('text files that cannot run have no run bar', async () => {
    await openFile('requirements.txt');
    expect(screen.queryByRole('toolbar', { name: 'Run on a GPU node' })).not.toBeInTheDocument();
  });
});
