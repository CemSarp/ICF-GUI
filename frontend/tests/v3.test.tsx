import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT, expandHome, fromConfig, toConfig } from '../src/features/training/TrainingWizard';
import { safeName } from '../src/features/transfers/TransfersView';
import type { WorkflowConfig } from '../src/types';
import { backend, connectedDemo, connectedLive } from './mockBackend';
import { renderApp } from './render';
import * as v3 from './v3Fixtures';

async function nav(name: string) {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name }));
}

async function openProject() {
  await nav('Projects');
  await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
  return screen.findByRole('heading', { name: v3.PROJECT });
}

describe('Projects and VS Code (V3-AC01, AC02, AC03)', () => {
  beforeEach(() =>
    backend.reset(connectedLive, {
      vscode_open: (a) => ({
        remotePath: a.path,
        alias: 'icf',
        message: 'VS Code was asked to open it. It connects with its own SSH session.',
      }),
      vscode_settings_preview: (a) => ({
        previewId: 'sp1',
        project: a.project,
        file: `${a.project}/.vscode/settings.json`,
        exists: true,
        before: '{\n  "editor.tabSize": 4\n}\n',
        after: `{\n  "editor.tabSize": 4,\n  "python.defaultInterpreterPath": "${a.interpreter}"\n}\n`,
        problem: null,
        manualSnippet: '',
      }),
      vscode_settings_apply: () => ({
        file: `${v3.PROJECT}/.vscode/settings.json`,
        backup: `${v3.PROJECT}/.vscode/settings.json.icfcc-backup-1`,
      }),
    }),
  );

  it('browses the remote home without recursion and opens a folder as a project', async () => {
    await nav('Projects');
    const browser = await screen.findByRole('region', { name: 'Remote folder browser' });
    expect(within(browser).getByRole('button', { name: /projects/ })).toBeInTheDocument();
    expect(within(browser).queryByText('.cache')).toBeNull();
    await userEvent.click(within(browser).getByLabelText('Show hidden'));
    expect(within(browser).getByText('.cache')).toBeInTheDocument();
    await userEvent.click(within(browser).getByRole('button', { name: /projects/ }));
    await userEvent.click(await within(browser).findByRole('button', { name: /semeval/ }));
    await within(browser).findByText('train.py');
    expect(backend.calls.filter((c) => c.cmd === 'projects_browse').map((c) => c.args.path)).toEqual([
      null,
      `${v3.HOME}/projects`,
      v3.PROJECT,
    ]);
    await userEvent.click(within(browser).getByRole('button', { name: 'Back' }));
    await within(browser).findByRole('button', { name: /semeval/ });
    await userEvent.click(within(browser).getByRole('button', { name: 'Open as project' }));
    expect(backend.count('projects_open', (a) => a.path === `${v3.HOME}/projects`)).toBe(1);
  });

  it('warns that editing is not GPU compute and launches VS Code only on click', async () => {
    await openProject();
    expect(screen.getByText(/Run and Debug buttons execute on the login node/)).toBeInTheDocument();
    expect(screen.getByText(/does not allocate a GPU/)).toBeInTheDocument();
    expect(backend.count('vscode_open')).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }));
    expect(await screen.findByText('Launch requested')).toBeInTheDocument();
    expect(screen.getByText(/its own SSH session/)).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === 'vscode_open')?.args).toEqual({ path: v3.PROJECT });
  });

  it('shows actionable problems when Remote - SSH or the ssh config is missing', async () => {
    backend.handlers.vscode_status = () => v3.vscodeStatus(false);
    await openProject();
    expect(await screen.findByText(/Remote - SSH extension .* is not installed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Suggested ~/.ssh/config block')).toHaveTextContent('ProxyJump edinburgh-jump');
    expect(screen.getByText(/the app never edits that file/)).toBeInTheDocument();
  });

  it('discovers interpreters on request, selects one and writes settings only after preview + confirmation', async () => {
    await openProject();
    expect(backend.count('python_discover')).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Discover interpreters' }));
    const row = (await screen.findByText('/usr/bin/python3')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Use' }));
    expect(backend.calls.find((c) => c.cmd === 'projects_set_prefs')?.args.prefs).toMatchObject({
      interpreter: '/usr/bin/python3',
    });
    expect(screen.getByText(/PyTorch was built for CUDA 12.8, matching the toolchain/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set as VS Code interpreter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update .vscode/settings.json?' });
    expect(within(dialog).getByText(/"editor.tabSize": 4,/)).toBeInTheDocument();
    expect(backend.count('vscode_settings_apply')).toBe(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Write settings' }));
    expect(await screen.findByText(/backed up as/)).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === 'vscode_settings_apply')?.args).toEqual({ previewId: 'sp1' });
  });

  it('refuses to edit settings it cannot preserve and offers a manual snippet', async () => {
    backend.handlers.vscode_settings_preview = () => ({
      previewId: null,
      project: v3.PROJECT,
      file: `${v3.PROJECT}/.vscode/settings.json`,
      exists: true,
      before: '{ // comment\n}',
      after: null,
      problem: 'settings.json is not plain JSON; it may contain comments or trailing commas',
      manualSnippet: '{\n  "python.defaultInterpreterPath": "/x"\n}\n',
    });
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: 'Set as VS Code interpreter…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/not plain JSON/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Write settings' })).toBeNull();
  });

  it('is unavailable in demo mode instead of pretending', async () => {
    backend.reset(connectedDemo);
    await nav('Projects');
    expect(await screen.findByText('Projects need a live connection')).toBeInTheDocument();
    expect(backend.count('projects_browse')).toBe(0);
  });
});

describe('Training workflow wizard (V3-AC05, AC06, duplicate submission)', () => {
  beforeEach(() =>
    backend.reset(connectedLive, {
      jobs_submit: () => ({
        outcome: 'accepted',
        jobId: '4243',
        cluster: null,
        receipt: { tag: 'newtag', status: 'accepted', jobId: '4243' },
      }),
    }),
  );

  async function wizardFromProject() {
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: 'New training workflow…' }));
    await screen.findByRole('heading', { name: 'Workflow' });
  }

  it('is prefilled from the project and previews the exact config', async () => {
    await wizardFromProject();
    expect(screen.getByLabelText('Project folder on ICF')).toHaveValue(v3.PROJECT);
    expect(screen.getByLabelText('Python interpreter on ICF')).toHaveValue(v3.VENV_PY);
    await userEvent.type(screen.getByLabelText('Arguments (one per line)'), '--data={{data}/semeval{enter}--epochs=3');
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    const cfg = backend.calls.find((c) => c.cmd === 'workflow_preview')?.args.config as WorkflowConfig;
    expect(cfg.args).toEqual(['--data={data}/semeval', '--epochs=3']);
    expect(cfg.resultsRoot).toBe(`${v3.PROJECT}/runs`);
    expect(cfg.toolchain).toEqual({ kind: 'rc', path: '/home/htang2/toolchain-20251006/toolchain.rc' });
    expect(cfg.resources.partition).toBe('Teaching');
    expect(screen.getByText(`${v3.PROJECT}/runs/train-<jobid>`)).toBeInTheDocument();
    expect(screen.getByText(/A node failure loses everything on scratch/)).toBeInTheDocument();
  });

  it('requires acknowledgement and confirmation, then submits exactly once through jobs_submit', async () => {
    await wizardFromProject();
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    const submit = await screen.findByRole('button', { name: 'Submit workflow…' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText('I understand these notices'));
    await userEvent.click(submit);
    const dialog = await screen.findByRole('dialog', { name: 'Submit this workflow to SLURM?' });
    expect(within(dialog).getByText(/keeps running if you close this app/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Submit to SLURM' });
    await userEvent.dblClick(go);
    expect(await screen.findByText('Job 4243')).toBeInTheDocument();
    expect(backend.count('jobs_submit')).toBe(1);
    expect(backend.calls.find((c) => c.cmd === 'jobs_submit')?.args).toMatchObject({
      previewId: 'wf-preview-1',
      acknowledged: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Monitor this run' }));
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers the GPU smoke test as a short SLURM job, never on the login node', async () => {
    await openProject();
    await userEvent.click(screen.getByRole('button', { name: /Run the GPU smoke test/ }));
    await screen.findByRole('heading', { name: 'Workflow' });
    expect(screen.getByLabelText('GPU smoke test')).toBeChecked();
    expect(screen.getByText(/Runs a fixed check on the allocated GPU node/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    const cfg = backend.calls.find((c) => c.cmd === 'workflow_preview')?.args.config as WorkflowConfig;
    expect(cfg.kind).toBe('gpu_smoke_test');
    expect(cfg.entry).toBe('');
    expect(cfg.resources.timeLimitSeconds).toBe(600);
  });

  it('expands ~ in path fields to the remote home and shows the resolved path', async () => {
    await wizardFromProject();
    const py = screen.getByLabelText('Python interpreter on ICF');
    await userEvent.clear(py);
    await userEvent.type(py, '~/projects/icf-env/bin/python');
    expect(screen.getByText('/home/s1/projects/icf-env/bin/python')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    const cfg = backend.calls.find((c) => c.cmd === 'workflow_preview')?.args.config as WorkflowConfig;
    expect(cfg.interpreter).toBe('/home/s1/projects/icf-env/bin/python');
  });

  it('checks the environment on the login node only on request and reports each import', async () => {
    backend.handlers.python_check_imports = (a) =>
      (a.modules as string[]).map((module) =>
        module === 'transformers'
          ? { module, status: 'failed', detail: 'RuntimeError: operator torchvision::nms does not exist' }
          : { module, status: 'ok', detail: '1.0' },
      );
    await wizardFromProject();
    await userEvent.click(screen.getByLabelText('Notebook, batch execution'));
    expect(screen.getByLabelText('Modules to check')).toHaveValue('torch transformers peft nbconvert ipykernel');
    expect(backend.count('python_check_imports')).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Check environment' }));
    expect(await screen.findByText('1 of 5 imports failed')).toBeInTheDocument();
    expect(screen.getByText('RuntimeError: operator torchvision::nms does not exist')).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === 'python_check_imports')?.args).toEqual({
      interpreter: v3.VENV_PY,
      modules: ['torch', 'transformers', 'peft', 'nbconvert', 'ipykernel'],
    });
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('can ask SLURM to e-mail when the workflow ends or fails', async () => {
    await wizardFromProject();
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    expect(screen.getByLabelText('Batch script')).not.toHaveTextContent('--mail');
    await userEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await userEvent.click(screen.getByLabelText('E-mail me when the job ends or fails'));
    await userEvent.type(screen.getByLabelText('E-mail address'), 's1234567@ed.ac.uk');
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(await screen.findByLabelText('Batch script')).toHaveTextContent(
      '#SBATCH --mail-type=END,FAIL #SBATCH --mail-user=s1234567@ed.ac.uk',
    );
    const cfgs = backend.calls.filter((c) => c.cmd === 'workflow_preview').map((c) => c.args.config as WorkflowConfig);
    expect(cfgs.map((c) => c.mailUser)).toEqual([null, 's1234567@ed.ac.uk']);
  });

  it('shows backend validation errors next to fields', async () => {
    backend.handlers.workflow_preview = () => ({
      ...v3.workflowPreview(v3.config()),
      previewId: null,
      script: '',
      errors: [{ field: 'datasets', message: 'Dataset archive must be inside your home (/home/s1234567).' }],
    });
    await wizardFromProject();
    await userEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(await screen.findByText(/must be inside your home/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review the exact batch script' })).toBeNull();
  });
});

describe('Runs dashboard (V3-AC07, AC09)', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('separates workflow state from scheduler state and survives restarts via the local run list', async () => {
    await nav('Runs');
    expect(await screen.findByText('gpu-smoke')).toBeInTheDocument();
    const failed = screen.getByText('long-run').closest('li')!;
    expect(within(failed).getByText('Node failure', { selector: '.badge' })).toBeInTheDocument();
    expect(within(failed).getByText(/scheduler: ✕ Node failure/)).toBeInTheDocument();
    expect(backend.count('workflow_refresh')).toBe(1);
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('labels what is recoverable after a node failure and offers resume from a checkpoint', async () => {
    await nav('Runs');
    await userEvent.click(await screen.findByText('long-run'));
    expect(await screen.findByText('What can be recovered')).toBeInTheDocument();
    expect(screen.getByText(/resume from it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Checkpoints' }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Resume from this…' }))[0]!);
    await screen.findByRole('heading', { name: 'Workflow' });
    expect(screen.getByLabelText('Resume from checkpoint (optional)')).not.toHaveValue('');
  });

  it('cancels a running workflow from its run detail with the same confirmation and token', async () => {
    const detail = backend.handlers.jobs_get_detail!;
    backend.handlers.jobs_get_detail = (a) => ({ ...(detail(a) as object), cancelToken: 'tok' });
    backend.handlers.jobs_cancel = () => ({ outcome: 'requested' });
    await nav('Runs');
    await userEvent.click(await screen.findByText('train'));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job…' }));
    expect(screen.queryByText('Cancel in My Jobs…')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Cancel job 4242?' });
    expect(within(dialog).getByRole('button', { name: 'Keep job' })).toHaveFocus();
    expect(backend.count('jobs_cancel')).toBe(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel job 4242' }));
    await waitFor(() =>
      expect(backend.count('jobs_cancel', (a) => a.jobId === '4242' && a.cancelToken === 'tok')).toBe(1),
    );
    expect(await screen.findByText('Cancellation requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job…' })).toBeNull();
  });

  it('asks the user to reconcile an uncertain submission instead of resubmitting', async () => {
    backend.handlers.workflow_refresh = () => ({
      ...v3.runs(),
      runs: [
        v3.run({
          submission: 'uncertain',
          jobId: null,
          schedulerState: null,
          observed: { ...v3.run().observed, state: 'RECOVERY_REQUIRED', message: 'The submission outcome is unknown.' },
        }),
      ],
    });
    backend.handlers.workflow_reconcile = () => v3.run();
    await nav('Runs');
    await userEvent.click(await screen.findByText('train'));
    await userEvent.click(await screen.findByRole('button', { name: 'Check my jobs for this submission' }));
    await waitFor(() => expect(backend.count('workflow_reconcile')).toBe(1));
    expect(backend.count('jobs_submit')).toBe(0);
  });
});

describe('Transfers (V3-AC04, AC08)', () => {
  beforeEach(() =>
    backend.reset(connectedLive, {
      transfers_list: () => [
        v3.transfer({ id: 'a', phase: 'transferring', doneBytes: 50, size: 100, message: null, name: 'images.tar.gz' }),
        v3.transfer({
          id: 'b',
          phase: 'failed',
          message: 'The SSH connection was lost. Reconnect and retry to resume.',
          name: 'old.zip',
        }),
      ],
      transfers_pick_file: () => ({
        token: 'tok1',
        name: 'My Data (v2).tar.gz',
        path: '/Users/me/My Data (v2).tar.gz',
        size: 2048,
        isArchive: true,
      }),
      transfers_upload: () => v3.transfer({ phase: 'queued' }),
      transfers_cancel: () => null,
      transfers_retry: () => v3.transfer(),
    }),
  );

  it('uploads a picked file to a chosen folder with a safe name, and offers cancel/resume', async () => {
    await nav('Transfers');
    const active = (await screen.findByText('images.tar.gz')).closest('li')!;
    expect(within(active).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    await userEvent.click(within(active).getByRole('button', { name: 'Cancel' }));
    expect(backend.calls.find((c) => c.cmd === 'transfers_cancel')?.args).toEqual({ id: 'a' });
    const failed = screen.getByText('old.zip').closest('li')!;
    await userEvent.click(within(failed).getByRole('button', { name: 'Retry / resume' }));
    expect(backend.count('transfers_retry')).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Choose a file…' }));
    expect(await screen.findByLabelText('Name on ICF')).toHaveValue('My_Data__v2_.tar.gz');
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    const picker = await screen.findByRole('dialog', { name: 'Upload into which folder?' });
    await userEvent.click(await within(picker).findByRole('button', { name: /projects/ }));
    await userEvent.click(await within(picker).findByRole('button', { name: 'Choose this folder' }));
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(backend.calls.find((c) => c.cmd === 'transfers_upload')?.args).toEqual({
      token: 'tok1',
      remoteDir: `${v3.HOME}/projects`,
      name: 'My_Data__v2_.tar.gz',
    });
  });
});

describe('V3 helpers', () => {
  it('suggests remote-safe names', () => {
    expect(safeName('semeval.tar.gz')).toBe('semeval.tar.gz');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('a b;$(id).zip')).toBe('a_b___id_.zip');
    expect(safeName('...')).toBe('upload');
  });

  it('round-trips a workflow config through the draft', () => {
    const c = v3.config({
      env: [{ name: 'WANDB_MODE', value: 'offline=1' }],
      hfCache: { mode: 'home', path: `${v3.HOME}/hf` },
    });
    expect(toConfig(fromConfig(c, v3.toolchains), v3.toolchains)).toEqual(c);
    expect(toConfig({ ...DEFAULT_DRAFT, projectDir: `${v3.PROJECT}/` }, []).resultsRoot).toBe(`${v3.PROJECT}/runs`);
  });

  it('expands only a leading ~ or $HOME', () => {
    const c = toConfig(
      {
        ...DEFAULT_DRAFT,
        projectDir: '~/projects/semeval/',
        interpreter: ' ~/projects/icf-env/bin/python ',
        resumeFrom: '$HOME/ckpt',
        datasets: [{ archive: '~/data.tar.gz', into: 'data' }],
      },
      [],
      '/home/s1',
    );
    expect(c.projectDir).toBe('/home/s1/projects/semeval');
    expect(c.interpreter).toBe('/home/s1/projects/icf-env/bin/python');
    expect(c.resultsRoot).toBe('/home/s1/projects/semeval/runs');
    expect(c.resumeFrom).toBe('/home/s1/ckpt');
    expect(c.datasets[0]?.archive).toBe('/home/s1/data.tar.gz');
    expect(expandHome('~', '/home/s1')).toBe('/home/s1');
    for (const kept of ['~other/x', '/opt/~/x', '~x', '$HOMEx/y']) expect(expandHome(kept, '/home/s1')).toBe(kept);
    expect(expandHome('~/x', '')).toBe('~/x');
  });
});
