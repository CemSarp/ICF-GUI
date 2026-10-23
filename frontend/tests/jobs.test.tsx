import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRequest, PreviewResponse } from '../src/types';
import { backend, connectedDemo, connectedLive, jobRow } from './mockBackend';
import { renderApp } from './render';
import { newestFirst } from '../src/features/jobs/MyJobsView';

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
  await userEvent.click(screen.getByRole('button', { name: 'Submit job…' }));
  return screen.findByRole('dialog', { name: 'Submit this job to SLURM?' });
}

describe('GPU request wizard (V2-AC01, AC02, AC08)', () => {
  beforeEach(() => backend.reset(connectedLive, { jobs_preview: () => okPreview() }));

  it('offers live partitions and their GPU types with potential availability', async () => {
    await openWizard();
    expect(screen.getByLabelText('Partition')).toHaveValue('Teaching');
    const group = screen.getByRole('group', { name: 'GPU type in Teaching' });
    expect(within(group).getByText('RTX A6000')).toBeInTheDocument();
    expect(within(group).getAllByText(/○ \d+ free/).length).toBeGreaterThan(0);
    expect(screen.getByText(/potentially free at .*not a reservation/)).toBeInTheDocument();
    expect(within(group).getByText(/48 GB VRAM/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Submit job…' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('I understand these notices'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit job…' }));
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
    expect(await screen.findByRole('button', { name: 'Submit job…' })).toBeDisabled();
  });
});

describe('New job: one screen for script jobs and training workflows', () => {
  beforeEach(() => backend.reset(connectedLive, { jobs_preview: () => okPreview() }));

  it('switches between the two forms without losing either draft or submitting anything', async () => {
    await openWizard();
    const name = screen.getByLabelText('Job name');
    await userEvent.clear(name);
    await userEvent.type(name, 'mine');
    await userEvent.click(screen.getByLabelText('Training workflow'));
    await screen.findByRole('heading', { name: 'Workflow' });
    expect(screen.queryByRole('button', { name: 'Review script' })).toBeNull();
    await userEvent.click(screen.getByLabelText('Script job'));
    expect(await screen.findByLabelText('Job name')).toHaveValue('mine');
    expect(screen.queryByRole('heading', { name: 'Workflow' })).toBeNull();
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('opens the script form with the partition chosen from a partition card', async () => {
    await openWizard();
    await userEvent.click(screen.getByLabelText('Training workflow'));
    await userEvent.click(screen.getByRole('button', { name: 'Partitions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New job on Interactive' }));
    await screen.findByRole('heading', { name: 'New job' });
    expect(screen.getByLabelText('Script job')).toBeChecked();
    expect(screen.getByLabelText('Partition')).toHaveValue('Interactive'); // not the default (Teaching)
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
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job…' }));
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
    expect(screen.queryByRole('button', { name: 'Cancel job…' })).not.toBeInTheDocument();
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

  it('marks a partition that rejected you and sends relative working dirs inside home', async () => {
    await openWizard();
    const sel = screen.getByLabelText('Partition');
    expect(within(sel).getByRole('option', { name: /ICF-Free.*rejected you before/ })).toBeInTheDocument();
    const wd = screen.getByLabelText('Working directory');
    await userEvent.clear(wd);
    await userEvent.type(wd, 'projects/semeval');
    await userEvent.click(screen.getByRole('button', { name: 'Review script' }));
    await waitFor(() =>
      expect(
        backend.count(
          'jobs_preview',
          (a) => (a.request as { workingDir: string }).workingDir === '/home/s1/projects/semeval',
        ),
      ).toBe(1),
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
