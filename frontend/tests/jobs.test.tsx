import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, JobRequest, PreviewResponse } from '../src/types';
import { backend, connectedDemo, connectedLive, jobRow } from './mockBackend';
import { renderApp } from './render';
import { newestFirst } from '../src/logic/jobs/myJobs';
import { commandsFor, rememberCommands, resolveWorkingDir, toRequest } from '../src/logic/jobs/jobRequest';
import { autoJobName, crumbs, replaceableName, splitPath, timePresets } from '../src/logic/jobs/newJob';
import { describeProjectEnv, envDirOf, projectFor } from '../src/logic/jobs/projectEnv';
import { parseSbatch, parseTime } from '../src/logic/jobs/sbatchImport';
import * as v3 from './v3Fixtures';

const okPreview = (o: Partial<PreviewResponse> = {}): PreviewResponse => ({
  previewId: 'pv1',
  script: '#!/bin/bash\n#SBATCH --partition=Teaching\nexec python /home/s1/p/train.py\n',
  checksum: 'abcd1234abcd1234',
  errors: [],
  warnings: [],
  acknowledgements: ["Eligibility for 'Teaching' is unknown: the scheduler may reject or hold this job."],
  snapshotAt: '2026-10-16T14:00:00Z',
  timeLimit: '0-04:00:00',
  stdoutPattern: '/home/s1/p/slurm-%j.out',
  stderrPattern: '/home/s1/p/slurm-%j.err',
  home: '/home/s1',
  ...o,
});

const receipt = {
  tag: 't1',
  profileId: 'default',
  user: 's1',
  jobId: null,
  cluster: null,
  status: 'uncertain',
  name: 'train',
  partition: 'Teaching',
  gres: 'gpu:x',
  gpuCount: 1,
  submittedAt: '2026-10-16T14:00:00Z',
  checksum: 'c',
  stdoutPattern: '',
  stderrPattern: '',
  message: 'm',
  accessDenied: false,
  dismissed: false,
};

async function openWizard() {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'New job' }));
  await screen.findByRole('heading', { name: 'New job' });
}

async function reviewAndConfirm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Review script' }));
  await screen.findByRole('heading', { name: 'Review the exact batch script' });
  await userEvent.click(screen.getByLabelText('I understand these notices'));
  await userEvent.click(screen.getByRole('button', { name: 'Submit job' }));
  return screen.findByRole('dialog', { name: 'Submit this job to SLURM?' });
}

describe('GPU request wizard (V2-AC01, AC02, AC08)', () => {
  beforeEach(() => backend.reset(connectedLive, { jobs_preview: () => okPreview() }));

  it('offers live partitions and their GPU types with potential availability', async () => {
    await openWizard();
    expect(screen.getByRole('radio', { name: 'Teaching' })).toBeChecked();
    const group = screen.getByRole('group', { name: 'GPU type in Teaching' });
    expect(within(group).getByText('RTX A6000')).toBeInTheDocument();
    expect(within(group).getAllByText(/of \d+ free/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Free counts from .*not a reservation/)).toBeInTheDocument();
    expect(within(group).getByText(/48 GB VRAM/)).toBeInTheDocument();
    // Time limits are one click, within the partition's maximum.
    await userEvent.click(screen.getByRole('button', { name: '30 min' }));
    expect(screen.getByLabelText('Hours')).toHaveValue(0);
    expect(screen.getByLabelText('Minutes')).toHaveValue(30);
    expect(screen.getByRole('button', { name: '30 min' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'More CPUs' }));
    expect(screen.getByLabelText('CPUs')).toHaveValue(5);
  });

  it('shows validation errors next to fields and does not reach review', async () => {
    backend.reset(connectedLive, {
      jobs_preview: () =>
        okPreview({
          previewId: null,
          script: '',
          errors: [{ field: 'workingDir', message: 'Working directory must be inside your home (/home/s1).' }],
        }),
    });
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    expect(await screen.findByText(/must be inside your home/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review the exact batch script' })).not.toBeInTheDocument();
  });

  it('shows the exact script, requires acknowledgement and confirmation, and submits once on double click', async () => {
    let release: () => void = () => undefined;
    backend.reset(connectedLive, {
      jobs_preview: () => okPreview(),
      jobs_submit: () =>
        new Promise((r) => {
          release = () =>
            r({
              outcome: 'accepted',
              jobId: '4242',
              cluster: null,
              receipt: { ...receipt, status: 'accepted', jobId: '4242' },
            });
        }),
    });
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    expect(await screen.findByLabelText('Batch script')).toHaveTextContent('#SBATCH --partition=Teaching');
    expect(screen.getByRole('button', { name: 'Submit job' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('I understand these notices'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit job' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit this job to SLURM?' });
    const btn = within(dialog).getByRole('button', { name: 'Submit to SLURM' });
    await userEvent.dblClick(btn);
    await userEvent.click(btn);
    expect(backend.count('jobs_submit')).toBe(1);
    const args = backend.calls.find((c) => c.cmd === 'jobs_submit')!.args;
    expect(args).toMatchObject({ previewId: 'pv1', acknowledged: true });
    act(() => release());
    expect(await screen.findByText('Job 4242')).toBeInTheDocument();
    expect(screen.getByText(/It is/)).toHaveTextContent(/queued/);
  });

  it('adds the SLURM end/fail e-mail only when asked, and shows errors for the address', async () => {
    backend.reset(connectedLive, {
      jobs_preview: (a) => {
        const r = a.request as JobRequest;
        return r.mailUser === 'not an address'
          ? okPreview({
              previewId: null,
              script: '',
              errors: [{ field: 'mailUser', message: 'Enter one plain e-mail address.' }],
            })
          : okPreview({ script: `#!/bin/bash\n#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=${r.mailUser}\n` });
      },
    });
    await openWizard();
    expect(screen.queryByLabelText('E-mail address')).toBeNull();
    await userEvent.click(screen.getByLabelText('E-mail me when the job ends or fails'));
    const mail = screen.getByLabelText('E-mail address');
    expect(mail).toHaveValue('');
    await userEvent.type(mail, 'not an address');
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    expect(await screen.findByText('Enter one plain e-mail address.')).toBeInTheDocument();
    await userEvent.clear(mail);
    await userEvent.type(mail, 's1234567@ed.ac.uk');
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    expect(await screen.findByLabelText('Batch script')).toHaveTextContent('#SBATCH --mail-user=s1234567@ed.ac.uk');
    const sent = backend.calls
      .filter((c) => c.cmd === 'jobs_preview')
      .map((c) => (c.args.request as JobRequest).mailUser);
    expect(sent).toEqual(['not an address', 's1234567@ed.ac.uk']);
  });

  it('an uncertain outcome is never retried and offers reconciliation', async () => {
    backend.reset(connectedLive, {
      jobs_preview: () => okPreview(),
      jobs_submit: () => ({
        outcome: 'uncertain',
        message: 'The connection dropped while sbatch was running.',
        receipt,
      }),
      jobs_reconcile: () => ({
        ...receipt,
        status: 'accepted',
        jobId: '4250',
        message: 'Found among your jobs: the submission was accepted.',
      }),
    });
    await openWizard();
    const dialog = await reviewAndConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit to SLURM' }));
    expect(await screen.findByText('Submission uncertain')).toBeInTheDocument();
    expect(screen.getByText(/will not retry automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check my jobs for this submission' }));
    expect(await screen.findByText(/Found among your jobs/)).toBeInTheDocument();
    expect(backend.count('jobs_submit')).toBe(1);
    expect(backend.count('jobs_reconcile', (a) => a.tag === 't1')).toBe(1);
  });

  it('a scheduler rejection is a recoverable state', async () => {
    backend.reset(connectedLive, {
      jobs_preview: () => okPreview(),
      jobs_submit: () => ({
        outcome: 'rejected',
        code: 'NO_RESOURCE',
        message: 'sbatch: error: Invalid generic resource (gres) specification — Try another GPU type.',
        receipt,
      }),
    });
    await openWizard();
    const dialog = await reviewAndConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit to SLURM' }));
    expect(await screen.findByText(/Invalid generic resource/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit request' }));
    expect(screen.getByRole('button', { name: 'Review script' })).toBeInTheDocument();
  });

  it('number fields can be emptied while typing a new value', async () => {
    await openWizard();
    const ram = screen.getByLabelText('RAM (GB)');
    await userEvent.clear(ram);
    expect(ram).toHaveValue(null);
    await userEvent.type(ram, '8');
    expect(ram).toHaveValue(8);
    await userEvent.clear(ram);
    await userEvent.tab();
    expect(ram).toHaveValue(8); // left empty: back to the last number
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    const req = backend.calls.find((c) => c.cmd === 'jobs_preview')!.args.request as JobRequest;
    expect(req.memoryMib).toBe(8 * 1024);
  });

  it('editing after review invalidates the preview', async () => {
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Back to edit' }));
    await userEvent.clear(screen.getByLabelText('Job name'));
    await userEvent.type(screen.getByLabelText('Job name'), 'other');
    expect(screen.queryByLabelText('Batch script')).not.toBeInTheDocument();
  });

  it('demo mode can review but not submit', async () => {
    backend.reset(connectedDemo, { jobs_preview: () => okPreview({ acknowledgements: [] }) });
    await openWizard();
    expect(screen.getByText(/submission is disabled/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    expect(await screen.findByRole('button', { name: 'Submit job' })).toBeDisabled();
  });
});

describe('New job: one screen for script jobs and training workflows', () => {
  beforeEach(() => backend.reset(connectedLive, { jobs_preview: () => okPreview() }));

  it('asks one question first and carries what was entered when the answer needs the other form', async () => {
    await openWizard();
    // Only the essentials are open; the rest is folded under More options. Name, CPUs, RAM and e-mail show.
    expect(screen.getByText('More options').closest('details')).not.toHaveAttribute('open');
    for (const shown of ['CPUs', 'RAM (GB)', 'E-mail me when the job ends or fails'])
      expect(screen.getByLabelText(shown).closest('details')).toBeNull();
    const name = screen.getByLabelText('Job name');
    await userEvent.clear(name);
    await userEvent.type(name, 'mine');
    await userEvent.click(
      screen.getByLabelText(/Managed training: stage datasets to fast scratch, keep checkpoints and copy results back/),
    );
    expect(await screen.findByRole('button', { name: 'Review workflow' })).toBeInTheDocument();
    expect(screen.getByLabelText('Job name')).toHaveValue('mine');
    expect(screen.queryByRole('button', { name: 'Review script' })).toBeNull();
    await userEvent.click(screen.getByLabelText('Shell script'));
    expect(await screen.findByRole('button', { name: 'Review script' })).toBeInTheDocument();
    expect(screen.getByLabelText('Shell script')).toBeChecked();
    expect(screen.getByLabelText('Job name')).toHaveValue('mine');
    // The GPU test is started from Projects (a check of an environment), not offered as a job type.
    expect(screen.queryByLabelText('GPU test')).toBeNull();
    await userEvent.click(screen.getByLabelText('Notebook'));
    expect(await screen.findByRole('button', { name: 'Review workflow' })).toBeInTheDocument();
    expect(screen.getByLabelText('Job name')).toHaveValue('mine'); // a name the user chose is kept
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('opens the script form with the partition chosen from a partition card', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Notebook'));
    await userEvent.click(screen.getByRole('button', { name: 'Cluster' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New job on Interactive' }));
    await screen.findByRole('heading', { name: 'New job' });
    expect(await screen.findByRole('button', { name: 'Review script' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Interactive' })).toBeChecked(); // not the default (Teaching)
  });
});

describe('My Jobs, details, cancel and logs (V2-AC04..AC07)', () => {
  beforeEach(() => backend.reset(connectedLive));
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
  });

  async function openJobs() {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'My Jobs' }));
    return screen.findByRole('heading', { name: 'Queued and running' });
  }

  it('lists own active and finished jobs; queued jobs show no node', async () => {
    await openJobs();
    const queued = (await screen.findByRole('button', { name: '4243' })).closest('tr')!;
    expect(within(queued).getByText('Pending')).toBeInTheDocument();
    expect(within(queued).getByText('Resources')).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: '4242' }).closest('tr')!).getByText('landonia11'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: '4100' }).closest('tr')!).getByText('1:0')).toBeInTheDocument();
  });

  it('cancel requires confirmation and sends the detail token', async () => {
    backend.reset(connectedLive, {
      jobs_get_detail: () => ({
        job: jobRow({}),
        fields: [['JobId', '4242']],
        stdoutPath: '/home/s1/p/slurm-4242.out',
        stderrPath: '/home/s1/p/slurm-4242.err',
        stderrMerged: false,
        logPathNote: null,
        cancelToken: 'tok',
        receipt: null,
        fetchedAt: '2026-10-16T14:00:00Z',
      }),
      jobs_cancel: () => ({ outcome: 'requested' }),
    });
    await openJobs();
    await userEvent.click(await screen.findByRole('button', { name: '4242' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    expect(backend.count('jobs_cancel')).toBe(0);
    const dialog = screen.getByRole('dialog', { name: 'Cancel job 4242?' });
    expect(within(dialog).getByText('semeval-train')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep job' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel job 4242' }));
    await waitFor(() =>
      expect(backend.count('jobs_cancel', (a) => a.jobId === '4242' && a.cancelToken === 'tok')).toBe(1),
    );
    expect(await screen.findByText('Cancellation requested')).toBeInTheDocument();
  });

  it("another user's job is refused", async () => {
    backend.reset(connectedLive, {
      jobs_get_detail: () => {
        throw { code: 'SLURM_PERMISSION', message: 'This job belongs to another user; its details are not shown.' };
      },
    });
    await openJobs();
    await userEvent.click(await screen.findByRole('button', { name: '4242' }));
    expect(await screen.findByText(/belongs to another user/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument();
  });

  it('logs load incrementally, handle rotation and missing files', async () => {
    const chunks = [
      { path: '/home/s1/p/slurm-4242.out', size: 12, from: 0, next: 12, rotated: false, text: 'epoch 1\nok\n' },
      { path: '/home/s1/p/slurm-4242.out', size: 20, from: 12, next: 20, rotated: false, text: 'epoch 2\n' },
      { path: '/home/s1/p/slurm-4242.out', size: 4, from: 0, next: 4, rotated: true, text: 'new\n' },
    ];
    backend.reset(connectedLive, {
      jobs_get_detail: () => ({
        job: jobRow({}),
        fields: [],
        stdoutPath: '/home/s1/p/slurm-4242.out',
        stderrPath: '/home/s1/p/slurm-4242.err',
        stderrMerged: false,
        logPathNote: null,
        cancelToken: null,
        receipt: null,
        fetchedAt: 'x',
      }),
      jobs_get_log_tail: (a) => {
        if (a.stream === 'stderr')
          throw {
            code: 'INVALID_PATH',
            message: 'The log file does not exist yet (the job may still be pending) or was deleted.',
          };
        return chunks.shift();
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openJobs();
    await userEvent.click(await screen.findByRole('button', { name: '4242' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Load log' }));
    expect(await screen.findByLabelText('stdout log')).toHaveTextContent('epoch 1');
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    await userEvent.click(screen.getByRole('button', { name: 'Load new output' }));
    await waitFor(() => expect(screen.getByLabelText('stdout log')).toHaveTextContent(/epoch 1\s*ok\s*epoch 2/));
    const offsets = backend.calls.filter((c) => c.cmd === 'jobs_get_log_tail').map((c) => c.args.offset);
    expect(offsets).toEqual([null, 12]);
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    await userEvent.click(screen.getByRole('button', { name: 'Load new output' }));
    expect(await screen.findByText(/truncated or rotated/)).toBeInTheDocument();
    expect(screen.getByLabelText('stdout log')).toHaveTextContent('new');
    expect(screen.getByLabelText('stdout log')).not.toHaveTextContent('epoch');
    await userEvent.click(screen.getByRole('tab', { name: 'Standard error' }));
    await userEvent.click(screen.getByRole('button', { name: 'Load log' }));
    expect(await screen.findByText(/does not exist yet/)).toBeInTheDocument();
  });

  it('polls jobs every 45 s only while visible and coalesces manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openJobs();
    const scheduled = () => backend.count('jobs_list_mine', (a) => a.forceRefresh === false);
    expect(scheduled()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(46_000));
    expect(scheduled()).toBe(2);
    act(() => focusManager.setFocused(false));
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(scheduled()).toBe(2);
    act(() => focusManager.setFocused(true));
    const btn = screen.getByRole('button', { name: 'Refresh' });
    for (let i = 0; i < 5; i++) await userEvent.click(btn);
    expect(backend.count('jobs_list_mine', (a) => a.forceRefresh === true)).toBe(1);
  });
});

describe('V2 polish: receipts, learned partitions, working dir', () => {
  const finished = [
    { ...receipt, tag: 'old', status: 'rejected', partition: 'ICF-Free', accessDenied: true, message: 'denied' },
    { ...receipt, tag: 'gone', status: 'accepted', jobId: '4000', dismissed: true },
  ];
  beforeEach(() => backend.reset(connectedLive, { jobs_preview: () => okPreview(), jobs_receipts: () => finished }));

  it('hides dismissed receipts and dismisses one on click', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'My Jobs' }));
    await userEvent.click(await screen.findByText('Recent submissions from this Mac'));
    expect(screen.queryByRole('button', { name: '4000' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Dismiss submission train/ }));
    expect(backend.count('jobs_dismiss_receipt', (a) => a.tag === 'old')).toBe(1);
  });

  it('jobs screens show only their own Refresh', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'My Jobs' }));
    await screen.findByRole('heading', { name: 'Queued and running' });
    // One Refresh per screen: the jobs list's own, not the cluster snapshot's.
    expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1);
    expect(screen.queryByText(/Last updated/)).not.toBeInTheDocument();
  });

  it('marks a partition that rejected you and resolves relative working dirs inside home', async () => {
    await openWizard();
    expect(screen.getByRole('radio', { name: 'ICF-Free' }).closest('label')).toHaveTextContent(
      'Rejected your last job',
    );
    // Relative folders (from presets and older drafts) start in the home folder.
    expect(resolveWorkingDir('projects/semeval', '/home/s1')).toBe('/home/s1/projects/semeval');
    expect(resolveWorkingDir('~/p/', '/home/s1')).toBe('/home/s1/p');
  });
});

/** Signed in as the user whose home the project fixtures live in. */
const asFixtureUser: ConnectionStatus = {
  ...connectedLive,
  capabilities: { ...connectedLive.capabilities!, remoteUser: 's1234567', home: v3.HOME },
};

describe('Script job: pick files on ICF, or run terminal commands', () => {
  beforeEach(() => backend.reset(connectedLive));

  async function chooseInPicker(dialogName: string, folders: string[], file: string) {
    const dialog = await screen.findByRole('dialog', { name: dialogName });
    for (const f of folders) await userEvent.click(await within(dialog).findByRole('button', { name: f }));
    const row = (await within(dialog).findByText(file)).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Choose' }));
  }

  it('runs a picked script in its own folder, named after it, and can run it from a folder above', async () => {
    backend.handlers.jobs_preview = () => okPreview();
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Choose script' }));
    await chooseInPicker('Choose the script', ['projects', 'semeval'], 'train.py');
    const card = screen.getByRole('group', { name: 'Script' });
    expect(within(card).getByText('train.py')).toBeInTheDocument();
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Job name')).toHaveValue('train');
    expect(backend.count('jobs_preview')).toBe(0); // the picker never submits the form
    await userEvent.click(within(card).getByRole('button', { name: 'projects' }));
    expect(within(card).getByText('semeval/train.py')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await waitFor(() => expect(backend.count('jobs_preview')).toBe(1));
    expect(backend.calls.find((c) => c.cmd === 'jobs_preview')!.args.request as JobRequest).toMatchObject({
      runner: 'python',
      workingDir: `${v3.HOME}/projects`,
      program: 'semeval/train.py',
      jobName: 'train',
    });
  });

  it('runs a notebook picked as a Python script as a Notebook', async () => {
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Choose script' }));
    await chooseInPicker('Choose the script', ['projects', 'semeval'], 'explore.ipynb');
    expect(await screen.findByRole('button', { name: 'Review workflow' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Notebook' })).toBeChecked();
    expect(within(screen.getByRole('group', { name: 'Notebook' })).getByText('explore.ipynb')).toBeInTheDocument();
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Job name')).toHaveValue('explore');
  });

  it('uses the Python environment of the project the file is in, and Clear keeps it empty (ADR-037)', async () => {
    backend.reset(asFixtureUser, { jobs_preview: () => okPreview() });
    backend.handlers.jobs_preview = () => okPreview();
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Choose script' }));
    await chooseInPicker('Choose the script', ['projects', 'semeval'], 'train.py');
    const env = await screen.findByRole('group', { name: 'Python environment' });
    expect(await within(env).findByText('~/projects/icf-env')).toBeInTheDocument();
    expect(screen.getByText('From your project ~/projects/semeval.')).toBeInTheDocument();
    await userEvent.click(within(env).getByRole('button', { name: 'Clear' }));
    expect(within(env).getByText('None: python3 of the GPU node')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await chooseInPicker('Choose the script', [], 'train.py'); // same folder again: stays cleared
    expect(
      within(screen.getByRole('group', { name: 'Python environment' })).getByText('None: python3 of the GPU node'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await waitFor(() => expect(backend.count('jobs_preview')).toBe(1));
    expect((backend.calls.find((c) => c.cmd === 'jobs_preview')!.args.request as JobRequest).pythonEnv).toBeNull();
  });

  it('offers the project environment to Commands as a visible line', async () => {
    backend.reset(asFixtureUser, { jobs_preview: () => okPreview() });
    await openWizard();
    await userEvent.click(screen.getByLabelText('Commands'));
    await userEvent.click(screen.getByRole('button', { name: 'Choose a file' }));
    await chooseInPicker('Choose the file to run', ['projects', 'semeval'], 'kernel.cu');
    await userEvent.click(await screen.findByRole('button', { name: '+ Project environment (icf-env)' }));
    expect(screen.getByLabelText('Commands to run')).toHaveValue(
      `export PATH="${v3.HOME}/projects/icf-env/bin:$PATH"\nnvcc -O2 -o kernel kernel.cu\n./kernel`,
    );
  });

  it('without a project for the folder, no environment is filled and Projects is suggested', async () => {
    backend.handlers.projects_recent = () => [];
    await openWizard();
    await userEvent.click(screen.getByRole('button', { name: 'Choose script' }));
    await chooseInPicker('Choose the script', ['projects', 'semeval'], 'train.py');
    const env = screen.getByRole('group', { name: 'Python environment' });
    expect(within(env).getByText('None: python3 of the GPU node')).toBeInTheDocument();
    expect(screen.getByText(/open this folder in Projects and choose its Python environment/)).toBeInTheDocument();
  });

  it('runs terminal commands in the folder of a chosen file, with no script or arguments', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Commands'));
    expect(screen.queryByRole('group', { name: 'Script' })).toBeNull();
    expect(screen.queryByLabelText('Arguments (optional, one per line)')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Choose a file' }));
    await chooseInPicker('Choose the file to run', ['projects', 'semeval'], 'kernel.cu');
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
    const box = screen.getByLabelText('Commands to run');
    expect(box).toHaveValue('nvcc -O2 -o kernel kernel.cu\n./kernel');
    await userEvent.type(box, '{Enter}nvidia-smi -L');
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await waitFor(() => expect(backend.count('jobs_preview')).toBe(1));
    expect(backend.calls.find((c) => c.cmd === 'jobs_preview')!.args.request as JobRequest).toMatchObject({
      runner: 'commands',
      workingDir: v3.PROJECT,
      program: '',
      programArgs: [],
      commands: 'nvcc -O2 -o kernel kernel.cu\n./kernel\nnvidia-smi -L',
    });
  });

  it('suggests a command per file type, a job name per file, and clickable folders', () => {
    expect(commandsFor('train.py')).toBe('python train.py');
    expect(commandsFor('run.sh')).toBe('bash run.sh');
    expect(commandsFor('main.cpp')).toBe('g++ -O2 -o main main.cpp\n./main');
    expect(commandsFor("my k'1.cu")).toBe(`nvcc -O2 -o 'my k'\\''1' 'my k'\\''1.cu'\n./'my k'\\''1'`);
    expect(splitPath('/home/s1/q/a.py')).toEqual({ dir: '/home/s1/q', name: 'a.py' });
    expect(autoJobName('/x/run_asr.sbatch')).toBe('run_asr');
    expect(autoJobName('my model (v2).py')).toBe('my-model-v2-');
    expect(autoJobName('.hidden')).toBe('job');
    expect(replaceableName('gpu-test', '')).toBe(true);
    expect(replaceableName('train', 'a.py')).toBe(true);
    expect(replaceableName('a', 'a.py')).toBe(true);
    expect(replaceableName('mine', 'a.py')).toBe(false);
    expect(crumbs('/home/s1/p/q', '/home/s1')).toEqual([
      ['~', '/home/s1'],
      ['p', '/home/s1/p'],
      ['q', '/home/s1/p/q'],
    ]);
    expect(crumbs('/opt/x', '/home/s1')).toEqual([
      ['/', '/'],
      ['opt', '/opt'],
      ['x', '/opt/x'],
    ]);
    expect(timePresets(3600).map((t) => t.label)).toEqual(['10 min', '30 min', '1 h']);
    expect(timePresets(null)).toHaveLength(8);
  });
});

describe('New job starts empty', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('does not bring back earlier entries when it is opened again', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Commands'));
    await userEvent.type(screen.getByLabelText('Commands to run'), 'make test1');
    const name = screen.getByLabelText('Job name');
    await userEvent.clear(name);
    await userEvent.type(name, 'old-name');
    await userEvent.click(screen.getByLabelText('Notebook')); // switching inside New job keeps entries
    expect(screen.getByLabelText('Job name')).toHaveValue('old-name');
    await userEvent.click(screen.getByRole('button', { name: 'My Jobs' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New job' }));
    await screen.findByRole('heading', { name: 'New job' });
    expect(screen.getByLabelText('Python script')).toBeChecked();
    expect(screen.getByLabelText('Job name')).toHaveValue('job');
    await userEvent.click(screen.getByLabelText('Commands'));
    expect(screen.getByLabelText('Commands to run')).toHaveValue('');
  });
});

describe('Recent commands', () => {
  it('offers submitted Commands blocks back, newest first, without filling them in', async () => {
    backend.reset(connectedLive, {
      jobs_preview: () => okPreview(),
      jobs_submit: () => ({
        outcome: 'accepted',
        jobId: '4242',
        cluster: null,
        receipt: { ...receipt, status: 'accepted', jobId: '4242' },
      }),
    });
    await openWizard();
    await userEvent.click(screen.getByLabelText('Commands'));
    expect(screen.queryByText(/Recent commands/)).toBeNull();
    await userEvent.type(screen.getByLabelText('Commands to run'), 'conda activate mls-asr{Enter}make test1');
    const dialog = await reviewAndConfirm();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit to SLURM' }));
    expect(await screen.findByText('Job 4242')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'My Jobs' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New job' }));
    await screen.findByRole('heading', { name: 'New job' });
    await userEvent.click(screen.getByLabelText('Commands'));
    expect(screen.getByLabelText('Commands to run')).toHaveValue(''); // New job still opens empty
    await userEvent.click(screen.getByText('Recent commands (1)'));
    await userEvent.click(screen.getByRole('button', { name: 'Use: make test1' }));
    expect(screen.getByLabelText('Commands to run')).toHaveValue('conda activate mls-asr\nmake test1');
  });

  it('keeps each block once, newest first, at most eight', () => {
    let l: string[] = [];
    for (const c of ['a', 'b', 'a', '  ', ...'cdefghij']) l = rememberCommands(l, c);
    expect(l).toEqual(['j', 'i', 'h', 'g', 'f', 'e', 'd', 'c']);
    expect(rememberCommands(['b', 'a'], 'a')).toEqual(['a', 'b']);
  });
});

describe('Edit and run again', () => {
  it('refills New job with the request a finished job was submitted with', async () => {
    const request: JobRequest = {
      partition: 'Teaching',
      gresType: 'nvidia_geforce_rtx_2080_ti',
      gpuCount: 1,
      cpus: 2,
      memoryMib: 16384,
      timeLimitSeconds: 5400,
      jobName: 'hw1-test',
      workingDir: '/home/s1/hw1-asr',
      runner: 'commands',
      program: '',
      programArgs: [],
      pythonEnv: null,
      setupSource: null,
      mailUser: null,
      commands: 'make test1 && ./run.sh --cuda task1',
    };
    backend.reset(connectedLive, {
      jobs_get_detail: () => ({
        job: jobRow({}),
        fields: [],
        stdoutPath: null,
        stderrPath: null,
        stderrMerged: false,
        logPathNote: null,
        cancelToken: null,
        receipt: { ...receipt, jobId: '4242', status: 'accepted', request },
        fetchedAt: '2026-10-16T14:00:00Z',
      }),
      jobs_preview: () => okPreview(),
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'My Jobs' }));
    await userEvent.click(await screen.findByRole('button', { name: '4242' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit and run again' }));
    await screen.findByRole('heading', { name: 'New job' });
    expect(screen.getByLabelText('Commands')).toBeChecked();
    expect(screen.getByLabelText('Commands to run')).toHaveValue(request.commands);
    expect(screen.getByLabelText('Job name')).toHaveValue('hw1-test');
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await screen.findByRole('heading', { name: 'Review the exact batch script' });
    expect(backend.calls.find((c) => c.cmd === 'jobs_preview')?.args.request).toEqual(request);
    expect(backend.count('jobs_submit')).toBe(0);
  });
});

describe('Python environment only for Python jobs', () => {
  it('does not send a hidden saved environment with Commands or Shell script', () => {
    const d = {
      partition: 'Teaching',
      gres: '',
      gpuCount: 1,
      cpus: 2,
      memoryGb: 16,
      hours: 1,
      minutes: 0,
      jobName: 'hw1',
      workingDir: '/home/u/hw1',
      runner: 'commands' as const,
      program: '',
      commands: 'make test1',
      args: '',
      pythonEnv: '/home/u/projects/icf-env',
      setupSource: '',
      mail: false,
      mailUser: '',
    };
    expect(toRequest(d, '/home/u').pythonEnv).toBeNull();
    expect(toRequest({ ...d, runner: 'bash', program: 'run.sh' }, '/home/u').pythonEnv).toBeNull();
    expect(toRequest({ ...d, runner: 'python', program: 'x.py' }, '/home/u').pythonEnv).toBe(
      '/home/u/projects/icf-env',
    );
  });
});

describe('My Jobs history order', () => {
  it('shows the most recently finished job first, ties by newer job ID', () => {
    const jobs = [
      { jobId: '3678745', endedAt: '2026-10-15T16:20:00' },
      { jobId: '3683913', endedAt: '2026-10-22T12:05:00' },
      { jobId: '3682082', endedAt: '2026-10-20T02:40:00' },
      { jobId: '3682083', endedAt: '2026-10-20T02:40:00' },
    ];
    expect(newestFirst(jobs).map((j) => j.jobId)).toEqual(['3683913', '3682083', '3682082', '3678745']);
  });
});

describe('Batch files and setup lines (course .sbatch files)', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('takes over the resources and commands of a picked .sbatch file', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Shell script'));
    await userEvent.click(screen.getByRole('button', { name: 'Choose script' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose the script' });
    for (const f of ['projects', 'semeval'])
      await userEvent.click(await within(dialog).findByRole('button', { name: f }));
    const row = (await within(dialog).findByText('run_asr.sbatch')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Choose' }));
    expect(await screen.findByText('Settings and commands taken from run_asr.sbatch')).toBeInTheDocument();
    expect(screen.getByLabelText('Commands')).toBeChecked();
    expect(screen.getByLabelText('Commands to run')).toHaveValue(
      'export PATH=/opt/cuda-12.8.0/bin:$PATH\nsource "${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"\nconda activate mls-asr\n\nhostname\nnvidia-smi -L\nmake test\n./run.sh --profile',
    );
    expect(screen.getByText(/--output is not used/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Teaching' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'RTX A6000 48 GB' })).toBeChecked();
    expect(screen.getByLabelText('Minutes')).toHaveValue(30);
    expect(screen.getByLabelText('CPUs')).toHaveValue(2);
    expect(screen.getByLabelText('Job name')).toHaveValue('run_asr');
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
    expect(backend.count('jobs_preview')).toBe(0);
  });

  it('adds setup lines once, before the commands', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Commands'));
    const box = screen.getByLabelText('Commands to run');
    await userEvent.clear(box);
    await userEvent.type(box, 'make test1');
    await userEvent.click(screen.getByRole('button', { name: '+ CUDA 12.8' }));
    await userEvent.click(screen.getByRole('button', { name: '+ CUDA 12.8' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Conda environment' }));
    await userEvent.type(screen.getByLabelText('Conda environment name'), 'mls-asr');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(box).toHaveValue(
      'source "${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"\nconda activate mls-asr\nexport PATH=/opt/cuda-12.8.0/bin:$PATH\nmake test1',
    );
  });

  it('reads SLURM times, memory and GPU requests', () => {
    expect(parseTime('30')).toEqual({ hours: 0, minutes: 30 });
    expect(parseTime('01:00:00')).toEqual({ hours: 1, minutes: 0 });
    expect(parseTime('1-02:30')).toEqual({ hours: 26, minutes: 30 });
    expect(parseTime('0:90')).toEqual({ hours: 0, minutes: 2 });
    expect(parseTime('soon')).toBeNull();
    const s = parseSbatch(
      '#!/bin/bash\n#SBATCH --gres=gpu:1\n#SBATCH --mem=16000M\n#SBATCH --account=x\necho hi\n#SBATCH -p Late\n',
    );
    expect(s?.settings).toEqual({ gpuCount: 1, memoryGb: 16 });
    expect(s?.commands).toBe('echo hi\n#SBATCH -p Late'); // after the first command SLURM ignores #SBATCH
    expect(s?.notes.join(' ')).toMatch(/--account=x is not taken over/);
    expect(parseSbatch('echo no header')).toBeNull();
  });
});

describe('Run buttons in Projects', () => {
  beforeEach(() => backend.reset(connectedLive));

  async function openProjectFiles() {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
    await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
    await screen.findByRole('button', { name: 'Run kernel.cu on a GPU' });
  }

  it('opens New job with a .cu file ready as commands in its folder, and only for runnable files', async () => {
    await openProjectFiles();
    expect(screen.queryByRole('button', { name: 'Run requirements.txt on a GPU' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run kernel.cu on a GPU' }));
    expect(await screen.findByRole('heading', { name: 'New job' })).toBeInTheDocument();
    expect(screen.getByLabelText('Commands')).toBeChecked();
    expect(screen.getByLabelText('Commands to run')).toHaveValue('nvcc -O2 -o kernel kernel.cu\n./kernel');
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
  });

  it('takes a project .sbatch file with its settings, and a folder as the working directory', async () => {
    await openProjectFiles();
    await userEvent.click(screen.getByRole('button', { name: 'Run run_asr.sbatch on a GPU' }));
    expect(await screen.findByText('Settings and commands taken from run_asr.sbatch')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Projects' }));
    await userEvent.click(await screen.findByRole('button', { name: /Run on a GPU/ }));
    expect(await screen.findByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('runs a notebook from its Run button as a Notebook job in its folder', async () => {
    await openProjectFiles();
    await userEvent.click(screen.getByRole('button', { name: 'Run explore.ipynb on a GPU' }));
    expect(await screen.findByRole('button', { name: 'Review workflow' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Notebook' })).toBeChecked();
    expect(within(screen.getByRole('group', { name: 'Notebook' })).getByText('explore.ipynb')).toBeInTheDocument();
    expect(screen.getByTitle(`Runs in ${v3.PROJECT}`)).toBeInTheDocument();
  });
});

describe('Project environment helpers (ADR-037)', () => {
  const p = v3.project();
  it('finds the project holding a folder, nearest first', () => {
    const inner = v3.project({ path: `${v3.PROJECT}/sub`, interpreter: null });
    expect(projectFor(`${v3.PROJECT}/data`, [p, inner])?.path).toBe(v3.PROJECT);
    expect(projectFor(`${v3.PROJECT}/sub/x`, [p, inner])?.path).toBe(`${v3.PROJECT}/sub`);
    expect(projectFor(`${v3.PROJECT}-other`, [p])).toBeNull(); // a sibling with a common prefix is not inside
    expect(projectFor('', [p])).toBeNull();
  });
  it('uses only environment folders in home', () => {
    expect(envDirOf('/home/u/miniconda3/envs/mls-asr/bin/python', '/home/u')).toBe('/home/u/miniconda3/envs/mls-asr');
    expect(envDirOf('/home/u/env/bin/python3.11', '/home/u')).toBe('/home/u/env');
    expect(envDirOf('/usr/bin/python3', '/home/u')).toBeNull();
    expect(envDirOf(null, '/home/u')).toBeNull();
  });
  it('tells the four cases apart', () => {
    const h = v3.HOME;
    expect(describeProjectEnv(`${h}/elsewhere`, [p], h).kind).toBe('none');
    expect(describeProjectEnv(v3.PROJECT, [v3.project({ interpreter: null })], h).kind).toBe('unset');
    expect(describeProjectEnv(v3.PROJECT, [v3.project({ interpreter: '/usr/bin/python3' })], h).kind).toBe('unusable');
    expect(describeProjectEnv(v3.PROJECT, [p], h)).toMatchObject({ kind: 'env', dir: `${h}/projects/icf-env` });
  });
});
