import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CATEGORIES, LIBRARY, cleanCustom, filterLibrary } from '../src/logic/terminal/library';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';

// jsdom has no canvas or layout: xterm is replaced by a recorder with the same surface we use.
const fake = vi.hoisted(() => ({
  written: [] as Uint8Array[],
  onData: null as ((d: string) => void) | null,
  resets: 0,
  focused: 0,
  disposed: 0,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    loadAddon() {}
    open() {}
    onData(cb: (d: string) => void) {
      fake.onData = cb;
    }
    onResize() {}
    write(b: Uint8Array | string) {
      fake.written.push(typeof b === 'string' ? new TextEncoder().encode(b) : b);
    }
    reset() {
      fake.resets++;
    }
    focus() {
      fake.focused++;
    }
    dispose() {
      fake.disposed++;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

const b64 = (s: string) => btoa(s);
const text = () => fake.written.map((b) => new TextDecoder().decode(b)).join('');
const nav = async (name: string) => userEvent.click(await screen.findByRole('button', { name }));
const writes = () => backend.calls.filter((c) => c.cmd === 'terminal_write').map((c) => c.args.data as string);

async function openTerminal() {
  renderApp();
  await nav('Terminal');
  await screen.findByText('Connected to the head node');
}

describe('Command library (pure)', () => {
  it('has unique ids, one-line commands and only known categories', () => {
    const ids = LIBRARY.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set<string>(CATEGORIES.map((c) => c.id));
    for (const x of LIBRARY) {
      expect(cats.has(x.category), x.id).toBe(true);
      expect(x.command.trim(), x.id).not.toBe('');
      expect(x.command, `${x.id} must not run by itself`).not.toMatch(/[\r\n]/);
    }
    for (const c of CATEGORIES)
      expect(
        LIBRARY.some((x) => x.category === c.id),
        c.id,
      ).toBe(true);
  });

  it('covers the asked-for setup tasks and never ships a driver-update command', () => {
    const all = LIBRARY.map((x) => x.command).join('\n');
    for (const needle of [
      'conda create',
      'conda install',
      'pip install',
      'download.pytorch.org/whl/cu128',
      'mv <from> <to>',
      'nvidia-smi',
    ])
      expect(all, needle).toContain(needle);
    expect(all).not.toMatch(/apt(-get)?\s+install|yum\s+install|dnf\s+install|\.run\b/);
  });

  it('marks deleting commands with a warning', () => {
    for (const id of ['rm', 'rm-dir', 'scancel', 'conda-remove-env'])
      expect(LIBRARY.find((x) => x.id === id)?.warn, id).toBe(true);
  });

  it('filters by category and by every search word', () => {
    expect(filterLibrary(LIBRARY, 'torch', '').every((x) => x.category === 'torch')).toBe(true);
    const hits = filterLibrary(LIBRARY, 'all', 'CONDA create');
    expect(hits.map((x) => x.id)).toContain('conda-create');
    expect(hits.every((x) => /conda/i.test(x.command + x.title) && /create/i.test(x.command + x.title))).toBe(true);
    expect(filterLibrary(LIBRARY, 'all', 'zzzz-nothing')).toEqual([]);
  });

  it('turns a saved command into one line and refuses an empty one', () => {
    expect(cleanCustom('', 'ls -l\nrm -rf x')).toEqual({ title: 'ls -l rm -rf x', command: 'ls -l rm -rf x' });
    expect(cleanCustom('  ', ' \n ')).toBeNull();
  });
});

describe('Terminal screen', () => {
  beforeEach(() => {
    backend.reset(connectedLive);
    fake.written = [];
    fake.onData = null;
    fake.resets = fake.focused = fake.disposed = 0;
  });

  it('opens a shell sized to the terminal and shows its output', async () => {
    await openTerminal();
    const open = backend.calls.find((c) => c.cmd === 'terminal_open')!;
    expect(open.args).toMatchObject({ cols: 100, rows: 30 });
    act(() => backend.terminal!.onmessage({ event: 'data', data: b64('café$ ').replace(/.*/, btoa('hello $ ')) }));
    expect(text()).toBe('hello $ ');
  });

  it('sends typing to the shell exactly as typed', async () => {
    await openTerminal();
    fake.onData!('ls\r');
    expect(writes()).toEqual(['ls\r']);
    expect(backend.calls.find((c) => c.cmd === 'terminal_write')!.args.terminalId).toBe('t1');
  });

  it('Insert types the command without Enter; Copy is separate', async () => {
    await openTerminal();
    const card = screen.getByText('Create a conda environment').closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Insert' }));
    expect(writes()).toEqual(['conda create -n <env-name> python=3.11 -y']);
    expect(writes()[0]).not.toMatch(/[\r\n]/);
  });

  it('searches and filters the library, and shows the drivers caveat', async () => {
    await openTerminal();
    await userEvent.type(screen.getByLabelText('Search commands'), 'rsync');
    expect(screen.getByText('Sync a folder (resumable)')).toBeInTheDocument();
    expect(screen.queryByText('Create a conda environment')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search commands'));
    await userEvent.click(screen.getByRole('button', { name: 'GPU & drivers' }));
    expect(screen.getByText(/cannot be updated from your account/)).toBeInTheDocument();
    expect(screen.queryByText('Create a conda environment')).not.toBeInTheDocument();
  });

  it('saves your own command, keeps it after a reload and removes it', async () => {
    await openTerminal();
    await userEvent.type(screen.getByLabelText('Name'), 'My sync');
    await userEvent.type(screen.getByLabelText('Command to save'), 'rsync -a a/ b/');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('My sync')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('icfcc.terminal.customCommands')!)).toMatchObject([
      { title: 'My sync', command: 'rsync -a a/ b/' },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove My sync' }));
    expect(screen.getByText('Nothing saved yet.')).toBeInTheDocument();
  });

  it('keeps the shell when you leave the screen and come back', async () => {
    await openTerminal();
    await nav('Cluster');
    await nav('Terminal');
    expect(backend.count('terminal_open')).toBe(1);
    expect(backend.count('terminal_close')).toBe(0);
    expect(fake.disposed).toBe(0);
  });

  it('says when the session ended and starts a new one on request', async () => {
    await openTerminal();
    act(() => backend.terminal!.onmessage({ event: 'exit', code: 255 }));
    expect(await screen.findByText('Session ended')).toBeInTheDocument();
    expect(text()).toContain('connection lost');
    expect(screen.getAllByRole('button', { name: 'Insert' })[0]).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /New session/ }));
    await waitFor(() => expect(backend.count('terminal_open')).toBe(2));
    expect(fake.resets).toBe(1);
    expect(await screen.findByText('Connected to the head node')).toBeInTheDocument();
  });

  it('shows why the terminal could not start', async () => {
    backend.handlers.terminal_open = () => {
      throw { code: 'NOT_CONNECTED', message: 'Not connected.' };
    };
    renderApp();
    await nav('Terminal');
    expect(await screen.findByText('Could not start')).toBeInTheDocument();
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
  });
});
