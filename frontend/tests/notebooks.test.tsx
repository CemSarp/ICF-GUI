import { EditorView } from '@codemirror/view';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { collapseCR, parseAnsi } from '../src/logic/notebooks/ansi';
import { commandKey } from '../src/logic/notebooks/keys';
import { renderMarkdown } from '../src/logic/notebooks/markdown';
import { parseNotebook, serializeNotebook } from '../src/logic/notebooks/notebook';
import { appendOutput, displayItem } from '../src/logic/notebooks/outputs';
import { richText, sanitizeHtml, type RichNode } from '../src/logic/notebooks/rich';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';
import * as v3 from './v3Fixtures';

const NB = `${v3.PROJECT}/analysis.ipynb`;
const key = (k: string, mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});
const all = (nodes: RichNode[]): RichNode[] => nodes.flatMap((n) => [n, ...('children' in n ? all(n.children) : [])]);

describe('Notebook rendering (pure)', () => {
  it('renders Markdown as a whitelisted tree: raw HTML stays text, links never navigate, only data images', () => {
    const nodes = renderMarkdown(
      '# Title\n\n<script>alert(1)</script>\n\n[site](https://example.org) [bad](javascript:alert(1)) ![remote](https://evil.example/x.png) ![plot](attachment:plot.png)\n\n```python\nimport torch\n```',
      { 'plot.png': { 'image/png': 'iVBORw0KGgo=' } },
    );
    const flat = all(nodes);
    expect(flat.find((n) => n.k === 'el' && n.tag === 'h1')).toBeTruthy();
    expect(richText(nodes)).toContain('<script>alert(1)</script>');
    expect(flat.some((n) => n.k === 'el' && (n.tag as string) === 'script')).toBe(false);
    expect(flat.filter((n) => n.k === 'link').map((n) => (n as { href: string }).href)).toEqual([
      'https://example.org',
    ]);
    expect(flat.filter((n) => n.k === 'img')).toEqual([
      { k: 'img', src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'plot' },
    ]);
    expect(richText(nodes)).toContain('[remote]');
    const code = flat.find((n) => n.k === 'code') as { spans: { text: string; cls?: string }[] };
    expect(code.spans.find((s) => s.text === 'import')?.cls).toContain('tok-keyword');
  });

  it('sanitises HTML outputs down to tables and text', () => {
    const { nodes } = sanitizeHtml(
      '<style>*{color:red}</style><table class="dataframe"><tr><td colspan="2" onclick="steal()">a</td></tr></table>' +
        '<script>steal()</script><img src=x onerror="steal()"><iframe src="https://x"></iframe><a href="https://x">link</a>',
    );
    const flat = all(nodes);
    expect(flat.map((n) => (n.k === 'el' ? n.tag : n.k))).toEqual(['table', 'tbody', 'tr', 'td', 'text', 'text']);
    expect(flat.find((n) => n.k === 'el' && n.tag === 'td')).toMatchObject({ attrs: { colSpan: 2 } });
    expect(richText(nodes)).toBe('alink');
  });

  it('keeps terminal colours, collapses progress bars and merges streams', () => {
    expect(parseAnsi('\u001b[0;31mKeyError\u001b[0m: 44')).toEqual([{ text: 'KeyError', fg: 1 }, { text: ': 44' }]);
    expect(parseAnsi('\u001b[1;38;5;2mok\u001b[22m!')).toEqual([
      { text: 'ok', fg: 2, bold: true },
      { text: '!', fg: 2 },
    ]);
    expect(collapseCR(' 10%|█\r 50%|█████\r100%|██████████\n')).toBe('100%|██████████\n');
    const out = appendOutput(appendOutput([], { output_type: 'stream', name: 'stderr', text: ' 10%\r' }), {
      output_type: 'stream',
      name: 'stderr',
      text: ' 99%\rdone\n',
    });
    expect(out).toEqual([{ output_type: 'stream', name: 'stderr', text: 'done\n' }]);
  });

  it('shows the richest safe MIME type', () => {
    expect(
      displayItem({ output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': 'fig' } }),
    ).toMatchObject({
      kind: 'image',
      src: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(
      displayItem({ output_type: 'display_data', data: { 'image/png': 'not base64!', 'text/plain': 'fig' } }),
    ).toMatchObject({
      kind: 'text',
    });
    expect(
      displayItem({ output_type: 'execute_result', data: { 'text/html': '<b>x</b>', 'text/plain': 'x' } }),
    ).toMatchObject({
      kind: 'rich',
    });
    expect(
      displayItem({ output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': '{}' } }),
    ).toEqual({
      kind: 'unsupported',
      mimes: ['application/vnd.jupyter.widget-view+json'],
    });
  });

  it('maps Jupyter command-mode keys, including the double presses', () => {
    expect(commandKey(key('d'), null)).toBeNull();
    expect(commandKey(key('d'), 'd')).toEqual({ t: 'delete' });
    expect(commandKey(key('0'), '0')).toEqual({ t: 'restart' });
    expect(commandKey(key('Enter', { shiftKey: true }), null)).toEqual({ t: 'run', then: 'advance' });
    expect(commandKey(key('Enter', { metaKey: true }), null)).toEqual({ t: 'run', then: 'stay' });
    expect(commandKey(key('Enter'), null)).toEqual({ t: 'edit' });
    expect(commandKey(key('s', { metaKey: true }), null)).toEqual({ t: 'save' });
    expect(commandKey(key('b', { metaKey: true }), null)).toBeNull();
  });

  it('serialises an untouched notebook byte-for-byte', () => {
    const text = v3.FILES[NB]!;
    const p = parseNotebook(text);
    expect(
      serializeNotebook(
        p,
        p.nb.cells.map((cell) => ({ cell, text: [cell.source].flat().join('') })),
      ),
    ).toBe(text);
  });
});

// ---------- the Notebooks tab ----------

async function openNotebook(name = 'analysis.ipynb') {
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

/** Type into the n-th cell editor the way a user edit arrives (a document change). */
function edit(n: number, insert: string) {
  const host = document.querySelectorAll<HTMLElement>('.code-editor')[n]!;
  const view = EditorView.findFromDOM(host.shadowRoot!.querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert } }));
}

async function startKernel() {
  await userEvent.click(screen.getByRole('button', { name: 'Start kernel…' }));
  const sheet = await screen.findByRole('dialog', { name: 'Start an interactive kernel' });
  await userEvent.click(within(sheet).getByRole('button', { name: 'Review' }));
  const start = await within(sheet).findByRole('button', { name: 'Start kernel' });
  expect(start).toBeDisabled(); // every notice must be confirmed first
  for (const box of within(sheet).getAllByRole('checkbox')) await userEvent.click(box);
  await userEvent.click(start);
  await screen.findByText(/Python 3\.11\.9 · landonia01/);
}

const cells = () => screen.getAllByRole('region', { name: /^Cell \d+,/ });
const saves = () => backend.calls.filter((c) => c.cmd === 'files_write');

describe('Notebooks tab', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('opens a notebook from Projects as a rendered page and saves only the edited cell', async () => {
    await openNotebook();
    expect(screen.getByRole('button', { name: 'Notebooks' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Results', level: 1 })).toBeInTheDocument(); // Markdown rendered
    const err = screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'KeyError: 44');
    expect(err.querySelector('.ansi-fg-1')).toHaveTextContent('KeyError'); // colours kept
    expect(backend.count('kernel_stop', (a) => a.kernelId === null)).toBe(1); // orphan cleanup on open
    edit(0, '  # cell edited'); // first code cell: Markdown cells have no editor until opened
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved to ICF.');
    const before = JSON.parse(v3.FILES[NB]!);
    const after = JSON.parse(saves()[0]!.args.content as string);
    expect(after.cells[1].source).toEqual([
      'for seed in (42, 43):\n',
      '    print(f"seed {seed}: {score[seed]:.3f}")  # cell edited',
    ]);
    after.cells[1].source = before.cells[1].source;
    expect(after).toEqual(before); // outputs, metadata, ids and execution counts untouched
  });

  it('starts a reviewed kernel, runs a cell live and saves its outputs', async () => {
    await openNotebook();
    await startKernel();
    expect(backend.calls.find((c) => c.cmd === 'kernel_preview')!.args.request).toEqual({
      notebookPath: NB,
      interpreter: v3.VENV_PY,
      toolchain: v3.toolchains[0]!.spec,
      resources: {
        partition: 'Interactive',
        gresType: 'nvidia_geforce_rtx_2080_ti',
        gpuCount: 1,
        cpus: 4,
        memoryMib: 16384,
        timeLimitSeconds: 3600,
      },
    });
    expect(backend.calls.find((c) => c.cmd === 'kernel_start')!.args).toMatchObject({
      previewId: 'kernel-preview-1',
      acknowledged: true,
    });

    // A new code cell below the last one, edited, then run with its ▶ button.
    fireEvent.mouseDown(cells()[2]!);
    await userEvent.click(screen.getByRole('button', { name: 'Insert code cell below' }));
    expect(cells()).toHaveLength(4);
    edit(2, 'print("hello")\n6 * 7');
    await userEvent.click(screen.getByRole('button', { name: 'Run cell 4' }));
    await waitFor(() =>
      expect([...cells()[3]!.querySelectorAll('.nb-prompt.out')].map((e) => e.textContent)).toContain('[1]:'),
    );
    expect(within(cells()[3]!).getByText('hello')).toBeInTheDocument();
    expect(within(cells()[3]!).getByText(/Done in/)).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === 'kernel_execute')!.args).toMatchObject({
      kernelId: 'k1',
      code: 'print("hello")\n6 * 7',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved to ICF.');
    const saved = JSON.parse(saves()[0]!.args.content as string).cells[3];
    expect(saved).toMatchObject({ cell_type: 'code', execution_count: 1, source: ['print("hello")\n', '6 * 7'] });
    expect(saved.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'hello\n' },
      { output_type: 'execute_result', execution_count: 1, data: { 'text/plain': '6 * 7' }, metadata: {} },
    ]);
  });

  it('Run all stops at the first error; later cells are not run', async () => {
    let failed = false;
    let n = 0;
    backend.reset(connectedLive, {
      kernel_execute: (a) => {
        const ch = backend.kernel!;
        const id = a.requestId as string;
        setTimeout(() => {
          if (failed) return ch.onmessage({ event: 'done', id, count: null, status: 'aborted' });
          n += 1;
          if ((a.code as string).includes('score[44]')) {
            failed = true;
            ch.onmessage({
              event: 'output',
              id,
              output: { output_type: 'error', ename: 'KeyError', evalue: '44', traceback: ['KeyError: 44'] },
            });
            ch.onmessage({ event: 'done', id, count: n, status: 'error' });
          } else ch.onmessage({ event: 'done', id, count: n, status: 'ok' });
        }, 0);
        return null;
      },
    });
    await openNotebook();
    await startKernel();
    fireEvent.mouseDown(cells()[2]!);
    await userEvent.click(screen.getByRole('button', { name: 'Insert code cell below' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run all' }));
    await waitFor(() => expect(backend.count('kernel_execute')).toBe(3));
    await waitFor(() => expect(within(cells()[2]!).getByText(/Failed in/)).toBeInTheDocument());
    expect(within(cells()[1]!).getByText('[1]:')).toBeInTheDocument();
    expect(within(cells()[2]!).getByText('[2]:')).toBeInTheDocument();
    expect(within(cells()[3]!).getByText('[ ]:')).toBeInTheDocument(); // aborted: never ran
  });

  it('asks before leaving while the kernel runs, then stops it', async () => {
    await openNotebook();
    await startKernel();
    await userEvent.click(screen.getByRole('button', { name: 'Overview' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stop the kernel?' });
    expect(within(sheet).getByText(/stops and its GPU is released/)).toBeInTheDocument();
    expect(backend.count('kernel_stop', (a) => a.kernelId === 'k1')).toBe(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Stop kernel and leave' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    await waitFor(() => expect(backend.count('kernel_stop', (a) => a.kernelId === 'k1')).toBe(1));
  });

  it('full screen hides the app chrome and asks the window to go full screen', async () => {
    await openNotebook();
    await userEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(document.querySelector('.shell')).toHaveClass('focus');
    expect(backend.calls.filter((c) => c.cmd === 'window_set_fullscreen').map((c) => c.args)).toEqual([{ on: true }]);
    await userEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(document.querySelector('.shell')).not.toHaveClass('focus');
    expect(backend.calls.filter((c) => c.cmd === 'window_set_fullscreen').map((c) => c.args)).toEqual([
      { on: true },
      { on: false },
    ]);
  });

  it('command mode: B inserts below, M makes Markdown, D D deletes, Enter edits', async () => {
    await openNotebook();
    const first = cells()[0]!;
    fireEvent.mouseDown(first);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'b' });
    await waitFor(() => expect(cells()).toHaveLength(4));
    const added = () => cells()[1]!;
    expect(added()).toHaveAccessibleName('Cell 2, Python');
    fireEvent.keyDown(added(), { key: 'm' });
    await waitFor(() => expect(added()).toHaveAccessibleName('Cell 2, Markdown'));
    fireEvent.keyDown(added(), { key: 'd' });
    fireEvent.keyDown(added(), { key: 'd' });
    await waitFor(() => expect(cells()).toHaveLength(3));
    expect(backend.count('kernel_execute')).toBe(0);
    // Running a code cell with no kernel offers to start one instead.
    fireEvent.keyDown(cells()[1]!, { key: 'Enter', shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Start an interactive kernel' })).toBeInTheDocument();
  });
});
