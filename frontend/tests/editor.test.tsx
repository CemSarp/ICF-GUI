import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';
import * as v3 from './v3Fixtures';

async function openProject() {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
  await screen.findByRole('heading', { name: v3.PROJECT });
}

async function openFile(name: string) {
  await openProject();
  await userEvent.click(await screen.findByRole('button', { name }));
  await screen.findByRole('heading', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
  await waitFor(() =>
    expect(document.querySelector('.code-editor')?.shadowRoot?.querySelector('.cm-editor')).toBeTruthy(),
  );
}

/** Type into the n-th CodeMirror editor the way a user edit arrives (a document change). */
function edit(n: number, insert: string, at: 'end' | 'start' = 'end') {
  const host = document.querySelectorAll<HTMLElement>('.code-editor')[n]!;
  const el = host.shadowRoot!.querySelector<HTMLElement>('.cm-editor')!;
  const view = EditorView.findFromDOM(el)!;
  act(() => view.dispatch({ changes: { from: at === 'end' ? view.state.doc.length : 0, insert } }));
}

const saves = () => backend.calls.filter((c) => c.cmd === 'files_write');

describe('In-app editor', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('opens a project file, saves once against the version it opened, and reports success', async () => {
    const path = `${v3.PROJECT}/train.py`;
    await openFile('train.py');
    expect(screen.getByText('Python')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    edit(0, '\n# tuned\n');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(await screen.findByText('Saved to ICF.')).toBeInTheDocument();
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.args).toMatchObject({
      path,
      expectedSha256: v3.fakeSha(v3.FILES[path]!),
      content: `${v3.FILES[path]}\n# tuned\n`,
    });
    expect(save).toBeDisabled();
  });

  it('never overwrites a newer version silently: conflict sheet, reload or explicit overwrite', async () => {
    backend.handlers.files_write = (a) => {
      if (a.expectedSha256 === 'f'.repeat(64)) return { path: a.path, sha256: 'e'.repeat(64) };
      throw { code: 'CONFLICT', message: 'The file changed on ICF since you opened it.' };
    };
    await openFile('kernel.cu');
    expect(screen.getByText('CUDA')).toBeInTheDocument();
    edit(0, '// mine\n', 'start');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const sheet = await screen.findByRole('dialog', { name: 'The file changed on ICF' });
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Overwrite re-reads the current version and writes against *its* hash.
    backend.handlers.files_read = (a) => ({ ...v3.file(a.path as string), sha256: 'f'.repeat(64) });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Overwrite the version on ICF' }));
    expect(await screen.findByText('Saved to ICF.')).toBeInTheDocument();
    expect(saves().map((c) => c.args.expectedSha256)).toEqual([
      v3.fakeSha(v3.FILES[`${v3.PROJECT}/kernel.cu`]!),
      'f'.repeat(64),
    ]);
  });

  it('asks before discarding unsaved edits, from Back and from the sidebar', async () => {
    await openFile('train.py');
    edit(0, 'x = 1\n');
    await userEvent.click(screen.getByRole('button', { name: 'Project files' }));
    let sheet = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('heading', { name: /^train\.py/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cluster' }));
    sheet = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'Cluster' })).toBeInTheDocument();
    expect(saves()).toHaveLength(0);
  });

  it('creates a new file without overwriting and opens it in the editor', async () => {
    await openProject();
    await userEvent.click(await screen.findByRole('button', { name: 'New file…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create a file on ICF' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Type'), 'cuda');
    await userEvent.type(within(sheet).getByLabelText('File name'), 'kernel');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create and edit' }));
    // kernel.cu already exists: refused, nothing replaced, the sheet stays open with the reason.
    expect(await within(sheet).findByText(/already exists/)).toBeInTheDocument();
    await userEvent.clear(within(sheet).getByLabelText('File name'));
    await userEvent.type(within(sheet).getByLabelText('File name'), 'saxpy');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create and edit' }));
    expect(await screen.findByRole('heading', { name: /^saxpy\.cu/ })).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.cmd === 'files_create').map((c) => c.args)).toEqual([
      { dir: v3.PROJECT, name: 'kernel.cu', content: '' },
      { dir: v3.PROJECT, name: 'saxpy.cu', content: '' },
    ]);
  });
});

describe('Deleting files and folders', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('deletes a file only after confirmation, and says a folder goes with everything in it', async () => {
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: 'Delete train.py' }));
    let sheet = screen.getByRole('dialog', { name: 'Delete this file?' });
    expect(within(sheet).getByText(`${v3.PROJECT}/train.py`)).toBeInTheDocument();
    expect(within(sheet).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(backend.count('files_delete')).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Delete train.py' }));
    sheet = screen.getByRole('dialog', { name: 'Delete this file?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete train.py' })).not.toBeInTheDocument());
    expect(backend.calls.find((c) => c.cmd === 'files_delete')!.args).toEqual({
      dir: v3.PROJECT,
      name: 'train.py',
      kind: 'file',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Delete data' }));
    sheet = screen.getByRole('dialog', { name: 'Delete this folder?' });
    expect(within(sheet).getByText(/everything inside it/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete data' })).not.toBeInTheDocument());
    expect(backend.count('files_delete')).toBe(2);
  });

  it('shows why a delete failed and keeps the sheet open', async () => {
    backend.reset(connectedLive, {
      files_delete: () => {
        throw { code: 'INVALID_INPUT', message: 'It changed on ICF since the folder was listed. Nothing was deleted.' };
      },
    });
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: 'Delete train.py' }));
    const sheet = screen.getByRole('dialog', { name: 'Delete this file?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await within(sheet).findByText(/Nothing was deleted/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete train.py' })).toBeInTheDocument();
  });
});

describe('Renaming and unpacking', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('renames in place after the new name is typed, and never sends an unchanged name', async () => {
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: 'Rename train.py' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename this file' });
    const input = within(sheet).getByLabelText('New name');
    expect(input).toHaveValue('train.py');
    expect(within(sheet).getByRole('button', { name: 'Rename' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'train_v2.py{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.calls.find((c) => c.cmd === 'files_rename')!.args).toEqual({
      dir: v3.PROJECT,
      name: 'train.py',
      kind: 'file',
      newName: 'train_v2.py',
    });
    expect(await screen.findByRole('button', { name: 'Rename train_v2.py' })).toBeInTheDocument();
  });

  it('offers Unpack only on archives, confirms first, then opens the unpacked folder', async () => {
    await openProject();
    expect(screen.queryByRole('button', { name: 'Unpack train.py' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'data' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Unpack semeval.tar.gz' }));
    const sheet = screen.getByRole('dialog', { name: 'Unpack this archive?' });
    expect(within(sheet).getByText(/The archive is kept/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(backend.count('files_unpack')).toBe(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Unpack' }));
    expect(await screen.findByText('train.jsonl')).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === 'files_unpack')!.args).toEqual({
      dir: `${v3.PROJECT}/data`,
      name: 'semeval.tar.gz',
    });
  });
});

describe('Sign VS Code in through this app', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('shows both local changes and applies them only after confirmation', async () => {
    await openProject();
    await userEvent.click(await screen.findByRole('button', { name: 'VS Code', expanded: false }));
    await userEvent.click(await screen.findByLabelText('Sign VS Code in through this app (no password prompts)'));
    const sheet = await screen.findByRole('dialog', { name: 'Let VS Code reuse this connection?' });
    expect(within(sheet).getByText(/ControlPath/)).toBeInTheDocument();
    expect(within(sheet).getByText(/"remote\.SSH\.configFile"/)).toBeInTheDocument();
    expect(backend.count('vscode_share_apply')).toBe(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(backend.count('vscode_share_apply', (a) => a.previewId === 'share-1')).toBe(1));
    expect(await screen.findByText('VS Code reuses this connection (icfcc-icf)')).toBeInTheDocument();
    expect(await screen.findByText('Shared with VS Code')).toBeInTheDocument();
  });

  it('warns before Disconnect drops the VS Code windows using the connection', async () => {
    backend.handlers.vscode_share_status = () => v3.shareStatus(true, true);
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const sheet = await screen.findByRole('dialog', { name: 'Disconnect from ICF?' });
    expect(
      within(sheet).getByText(
        /VS Code windows using this app’s connection|VS Code windows using this app's connection/,
      ),
    ).toBeInTheDocument();
    expect(backend.count('connection_disconnect')).toBe(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(backend.count('connection_disconnect')).toBe(1));
  });
});
