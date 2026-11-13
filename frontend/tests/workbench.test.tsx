import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { findSession, newTaskId, pollDelay, seconds, sessionRequest, showKind } from '../src/logic/workbench/workbench';
import { gpuModel, slurmMemory } from '../src/logic/format';
import type {
  ConnectionStatus,
  DevTask,
  JobReceipt,
  JobRequest,
  JobRow,
  RunRecord,
  RunStatusResponse,
} from '../src/types';
import { backend, connectedLive, jobRow } from './mockBackend';
import { renderApp } from './render';
import * as v3 from './v3Fixtures';

const live: ConnectionStatus = {
  ...connectedLive,
  capabilities: { ...connectedLive.capabilities!, remoteUser: 's1234567', home: v3.HOME },
};

const sessionReq = (o: Partial<JobRequest> = {}): JobRequest => ({
  partition: 'Teaching',
  gresType: 'nvidia_rtx_a6000',
  gpuCount: 1,
  cpus: 4,
  memoryMib: 16384,
  timeLimitSeconds: 7200,
  jobName: 'semeval-session',
  workingDir: v3.PROJECT,
  runner: 'session',
  program: '',
  programArgs: [],
  pythonEnv: null,
  setupSource: null,
  mailUser: null,
  commands: '',
  sessionIdleMinutes: 30,
  ...o,
});

const receipt = (jobId: string, request = sessionReq()): JobReceipt => ({
  tag: `t${jobId}`,
  profileId: 'default',
  user: 's1234567',
  jobId,
  cluster: null,
  status: 'accepted',
  name: request.jobName,
  partition: request.partition,
  gres: 'gpu:nvidia_rtx_a6000',
  gpuCount: 1,
  submittedAt: `2026-10-17T10:00:0${jobId.slice(-1)}Z`,
  checksum: 'abc',
  stdoutPattern: '',
  stderrPattern: '',
  message: null,
  accessDenied: false,
  dismissed: false,
  request,
});

const jobs = (active: JobRow[]) => () => ({
  list: {
    active,
    history: [],
    historyNote: null,
    fetchedAt: '2026-10-17T10:05:00Z',
    fetchedAtMs: 0,
    historyFetchedAt: null,
    foreignRowsDropped: 0,
  },
  lastError: null,
  stale: false,
  fetched: true,
  requests: 1,
});

const sessionRow = (o: Partial<JobRow> = {}) =>
  jobRow({ jobId: '5001', name: 'semeval-session', nodes: 'landonia05', gpus: 'nvidia_rtx_a6000 × 1', ...o });

const task = (o: Partial<DevTask> = {}): DevTask => ({
  id: 'build',
  name: 'Build',
  kind: 'build',
  command: 'make',
  workingDir: '',
  description: '',
  ...o,
});

/** A small stateful Workbench backend: tasks per project, runs, and scripted status reads. */
function workbench(opts: { tasks?: DevTask[]; receipts?: JobReceipt[]; active?: JobRow[]; runs?: RunRecord[] } = {}) {
  let tasks = opts.tasks ?? [];
  let runs: RunRecord[] = opts.runs ?? [];
  const reads: Partial<RunStatusResponse>[] = [];
  backend.reset(live, {
    projects_recent: () => [v3.project({ tasks })],
    projects_open: () => v3.project({ tasks }),
    workbench_save_tasks: (a) => {
      tasks = a.tasks as DevTask[];
      return v3.project({ tasks });
    },
    jobs_receipts: () => opts.receipts ?? [],
    jobs_list_mine: jobs(opts.active ?? []),
    workbench_runs: () => runs,
    workbench_run: (a) => {
      const t = tasks.find((x) => x.id === a.taskId)!;
      const r: RunRecord = {
        profileId: 'default',
        user: 's1234567',
        project: v3.PROJECT,
        id: `r${runs.length + 1}`,
        taskId: t.id,
        taskName: t.name,
        kind: t.kind,
        jobId: a.jobId as string,
        block: `000000000000${runs.length + 1}`,
        command: t.command,
        workingDir: v3.PROJECT,
        gpu: 'nvidia_rtx_a6000',
        node: 'landonia05',
        sentAt: '2026-10-17T10:06:00Z',
        sentMs: Date.now() + runs.length,
        status: 'queued',
        exitCode: null,
        startedEpoch: null,
        endedEpoch: null,
        message: null,
        note: null,
      };
      runs = [r, ...runs];
      return r;
    },
    workbench_run_status: (a) => {
      const r = runs.find((x) => x.id === a.runId)!;
      const next = reads.shift() ?? {};
      const run = { ...r, ...next.run };
      runs = runs.map((x) => (x.id === r.id ? run : x));
      return { run, chunk: next.chunk ?? null, logNote: next.logNote ?? null };
    },
  });
  return { reads, tasks: () => tasks, runs: () => runs };
}

async function openWorkbench() {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'GPU Workbench' }));
}

const chunk = (text: string, from = 0) => ({
  path: 'x',
  size: from + text.length,
  from,
  next: from + text.length,
  rotated: false,
  text,
});

describe('GPU Workbench', () => {
  beforeEach(() => workbench());

  it('opens from a project with an empty state, and a task needs only a name and a command', async () => {
    const wb = workbench();
    await openWorkbench();
    expect(screen.getByText('No development tasks yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Add a command you normally run to build, test or execute this project/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save task' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Build');
    await userEvent.type(within(dialog).getByLabelText('Command'), 'make');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(wb.tasks()).toEqual([task({ kind: 'custom' })]);
    expect(await screen.findByText('make')).toBeInTheDocument();

    // Edit and duplicate keep the command inspectable and ids distinct.
    await userEvent.click(screen.getByRole('button', { name: 'Edit Build' }));
    const cmd = within(screen.getByRole('dialog')).getByLabelText('Command');
    await userEvent.clear(cmd);
    await userEvent.type(cmd, 'make -j4');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save task' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate Build' }));
    await waitFor(() =>
      expect(wb.tasks().map((t) => [t.id, t.name, t.command])).toEqual([
        ['build', 'Build', 'make -j4'],
        ['build-copy', 'Build (copy)', 'make -j4'],
      ]),
    );
    expect(backend.count('workbench_run')).toBe(0);
    expect(backend.count('jobs_submit')).toBe(0);
  });

  it('without a session, Run is disabled and Start opens New job filled with the session for review', async () => {
    workbench({ tasks: [task()] });
    await openWorkbench();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText(/This task requires a running GPU session/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Build' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Start GPU session' }));
    const setup = await screen.findByLabelText('Setup lines (run once, optional)');
    expect(setup).toHaveValue(`export PATH='${v3.HOME}/projects/icf-env/bin':"$PATH"`);
    expect(backend.count('jobs_submit')).toBe(0);
    expect(backend.count('workbench_run')).toBe(0);
  });

  it('shows a queued session as waiting, and an ended one as ended with a way to start again', async () => {
    workbench({
      tasks: [task()],
      receipts: [receipt('5001')],
      active: [sessionRow({ state: 'pending', stateRaw: 'PENDING', nodes: null, reason: 'Resources' })],
    });
    await openWorkbench();
    expect(await screen.findByText('Waiting for a GPU')).toBeInTheDocument();
    expect(screen.getByText(/Job 5001 is waiting for a GPU \(Resources\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Build' })).toBeDisabled();
  });

  it('an ended session is never shown as running', async () => {
    workbench({ tasks: [task()], receipts: [receipt('5001')], active: [] });
    await openWorkbench();
    expect(await screen.findByText('GPU session ended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a new GPU session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Build' })).toBeDisabled();
  });

  it('runs a task once in the running session and reports queued, running and failed with the exit code', async () => {
    const wb = workbench({ tasks: [task()], receipts: [receipt('5001')], active: [sessionRow()] });
    wb.reads.push(
      { run: { status: 'queued' } as RunRecord },
      { run: { status: 'running' } as RunRecord, chunk: chunk('nvcc -o app kernel.cu\n') },
      {
        run: { status: 'failed', exitCode: 2, startedEpoch: 100, endedEpoch: 112 } as RunRecord,
        chunk: chunk('kernel.cu(3): error: identifier "idx" is undefined\n', 22),
      },
    );
    await openWorkbench();
    expect(await screen.findByText('GPU allocated')).toBeInTheDocument();
    expect(screen.getByText('landonia05')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'Run Build' });
    await userEvent.dblClick(run);
    await waitFor(() => expect(backend.count('workbench_run')).toBe(1));
    expect(backend.calls.find((c) => c.cmd === 'workbench_run')?.args).toEqual({
      path: v3.PROJECT,
      taskId: 'build',
      jobId: '5001',
    });
    expect(await screen.findByRole('heading', { name: /Build Queued/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Build' })).toBeDisabled();

    // The session picks it up: the page checks it again by itself (every 2 s while visible).
    expect(await screen.findByLabelText('Output of Build', {}, { timeout: 4000 })).toHaveTextContent(
      'nvcc -o app kernel.cu',
    );
    expect(screen.getByRole('heading', { name: /Build Running/ })).toBeInTheDocument();
    await screen.findByRole('heading', { name: /Build Failed \(exit 2\)/ }, { timeout: 4000 });
    expect(screen.getByLabelText('Output of Build')).toHaveTextContent('nvcc -o app kernel.cu kernel.cu(3): error');
    expect(screen.getByText(/ran 12 s \(whole command, not GPU kernel time\)/)).toBeInTheDocument();
    // Offsets continue where the last read ended; nothing is resent.
    const offs = backend.calls.filter((c) => c.cmd === 'workbench_run_status').map((c) => c.args.offset);
    expect(offs.slice(0, 3)).toEqual([null, null, 22]);
    expect(backend.count('workbench_run')).toBe(1);
    expect(screen.getByRole('button', { name: 'Run Build' })).toBeEnabled();
  }, 15_000);

  it('keeps the project session when navigating away and back', async () => {
    workbench({ tasks: [task()], receipts: [receipt('5001')], active: [sessionRow()] });
    await openWorkbench();
    expect(await screen.findByText('GPU allocated')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cluster' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
    expect(await screen.findByText('GPU allocated')).toBeInTheDocument();
    expect(backend.count('jobs_submit')).toBe(0);
  });
});

describe('GPU Workbench helpers', () => {
  it('finds the newest session for exactly this folder and never assumes it runs', () => {
    const r = [receipt('5001'), receipt('5002'), receipt('5003', sessionReq({ workingDir: `${v3.PROJECT}/sub` }))];
    const list = jobs([sessionRow({ jobId: '5002' })])().list;
    expect(findSession(v3.PROJECT, r, list)).toMatchObject({ kind: 'running', jobId: '5002' });
    expect(findSession(v3.PROJECT, r, null)).toMatchObject({ kind: 'unknown', jobId: '5002' });
    expect(findSession(v3.PROJECT, r, jobs([])().list)).toMatchObject({ kind: 'ended' });
    expect(findSession(v3.PROJECT, [receipt('5004', sessionReq({ runner: 'commands' }))], list)).toEqual({
      kind: 'none',
    });
  });

  it('builds the session from the project, or reuses the previous reviewed one', () => {
    const p = v3.project({ partition: 'Teaching', gresType: 'nvidia_rtx_a6000' });
    const r = sessionRequest(p, null, v3.toolchains, v3.HOME);
    expect(r).toMatchObject({
      runner: 'session',
      workingDir: v3.PROJECT,
      gpuCount: 1,
      partition: 'Teaching',
      pythonEnv: null,
    });
    expect(r.commands).toBe(`export PATH='${v3.HOME}/projects/icf-env/bin':"$PATH"`);
    expect(r.setupSource).toBe('/home/htang2/toolchain-20251006/toolchain.rc');
    const generic = sessionRequest(
      v3.project({ path: '/home/s1/my cuda', interpreter: null, toolchainId: null }),
      null,
      [],
      '/home/s1',
    );
    expect(generic).toMatchObject({ commands: '', setupSource: null, jobName: 'my-cuda-session' });
    const prev = sessionReq({ cpus: 8 });
    expect(sessionRequest(p, prev, v3.toolchains, v3.HOME)).toBe(prev);
  });

  it('makes valid distinct ids and slows status reads for long runs', () => {
    expect(newTaskId('Run all tests!', [])).toBe('run-all-tests');
    expect(newTaskId('Build', ['build', 'build-2'])).toBe('build-3');
    expect(newTaskId('çç', [])).toBe('task');
    expect([pollDelay(0), pollDelay(119_000), pollDelay(300_000), pollDelay(3_600_000)]).toEqual([
      2000, 2000, 5000, 10000,
    ]);
  });
});

function editorView() {
  const el = document.querySelector('.code-editor')!.shadowRoot!.querySelector<HTMLElement>('.cm-editor')!;
  return EditorView.findFromDOM(el)!;
}

async function openTrainPy() {
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  await userEvent.click(await screen.findByText(v3.PROJECT, { selector: 'span' }));
  await userEvent.click(await screen.findByRole('button', { name: 'train.py' }));
  await waitFor(() =>
    expect(document.querySelector('.code-editor')?.shadowRoot?.querySelector('.cm-editor')).toBeTruthy(),
  );
}

describe('GPU Workbench: diagnostics and the editor', () => {
  const running = () => ({
    tasks: [task(), task({ id: 'test', name: 'Test', kind: 'test', command: 'make test' })],
    receipts: [receipt('5001')],
    active: [sessionRow()],
  });

  it('lists compiler errors from a failed run and opens the file at the line', async () => {
    const wb = workbench(running());
    wb.reads.push({
      run: { status: 'failed', exitCode: 2 } as RunRecord,
      chunk: chunk(
        'train.py:3:5: error: expected expression\n   x = = 1\n       ^\nlib/missing.cu(9): error: outside\n',
      ),
    });
    await openWorkbench();
    await userEvent.click(await screen.findByRole('button', { name: 'Run Build' }));
    expect(await screen.findByText(/Failed \(exit code 2\) — 2 compiler errors/)).toBeInTheDocument();
    expect(screen.getByText('expected expression')).toBeInTheDocument();
    expect(screen.getByLabelText('Output of Build')).toHaveTextContent('x = = 1'); // the raw output stays
    expect(screen.queryByRole('button', { name: /Open lib\/missing\.cu/ })).toBeInTheDocument(); // inside the project
    await userEvent.click(screen.getByRole('button', { name: 'Open train.py at line 3' }));
    await screen.findByRole('heading', { name: /^train\.py/ });
    await waitFor(() => {
      const v = editorView();
      const head = v.state.selection.main.head;
      expect(v.state.doc.lineAt(head).number).toBe(3);
      expect(head - v.state.doc.line(3).from).toBe(4);
    });
  });

  it('Save & Build saves first through the conflict check, then runs once', async () => {
    workbench(running());
    await openTrainPy();
    expect(await screen.findByText('GPU session: running on landonia05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build' })).toBeEnabled();
    act(() => editorView().dispatch({ changes: { from: 0, insert: '# edited\n' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save & Build' }));
    await waitFor(() => expect(backend.count('workbench_run')).toBe(1));
    const order = backend.calls.map((c) => c.cmd).filter((c) => c === 'files_write' || c === 'workbench_run');
    expect(order).toEqual(['files_write', 'workbench_run']);
    expect(await screen.findByText('Saved to ICF.')).toBeInTheDocument();
  });

  it('a save conflict or error sends nothing', async () => {
    workbench(running());
    backend.handlers.files_write = () => {
      throw { code: 'CONFLICT', message: 'The file changed on ICF since you opened it.' };
    };
    await openTrainPy();
    act(() => editorView().dispatch({ changes: { from: 0, insert: '# edited\n' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save & Test' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    backend.handlers.files_write = () => {
      throw { code: 'INTERNAL', message: 'Disk full.' };
    };
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
    expect(await screen.findByText('Disk full.')).toBeInTheDocument();
    expect(backend.count('workbench_run')).toBe(0);
  });

  it('suggests Makefile targets without running anything, and adds one only after review', async () => {
    const wb = workbench();
    const listing = v3.listing(v3.PROJECT);
    backend.handlers.projects_browse = (a) =>
      a.path === v3.PROJECT
        ? { ...listing, entries: [...listing.entries, { ...listing.entries[0]!, name: 'Makefile', kind: 'file' }] }
        : v3.listing((a.path as string | null) ?? null);
    const read = backend.handlers.files_read!;
    backend.handlers.files_read = (a) =>
      a.path === `${v3.PROJECT}/Makefile`
        ? v3.file(a.path as string, '.PHONY: all test1 install\nall:\n\tnvcc x.cu\ntest1: all\ninstall:\n')
        : read(a);
    await openWorkbench();
    expect(await screen.findByText('Suggested from this project (2)')).toBeInTheDocument();
    expect(screen.queryByText('make install')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add make test1' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Command')).toHaveValue('make test1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(wb.tasks().map((t) => t.command)).toEqual(['make test1']));
    expect(backend.count('workbench_run')).toBe(0);
    expect(backend.calls.some((c) => c.cmd === 'files_read' && c.args.path === `${v3.PROJECT}/Makefile`)).toBe(true);
  });

  it('explains an interrupted run and output that is no longer on ICF', async () => {
    const wb = workbench({ tasks: [task()], receipts: [receipt('5001')], active: [sessionRow()] });
    wb.reads.push({
      run: {
        status: 'interrupted',
        message: 'The GPU session ended while this task was running; no exit code was recorded.',
      } as RunRecord,
      logNote: "This run's output is no longer on ICF (deleted or cleaned up).",
    });
    await openWorkbench();
    await userEvent.click(await screen.findByRole('button', { name: 'Run Build' }));
    expect(await screen.findByRole('heading', { name: /Build Interrupted/ })).toBeInTheDocument();
    expect(screen.getByText(/no exit code was recorded/)).toBeInTheDocument();
    expect(screen.getByText(/no longer on ICF/)).toBeInTheDocument();
    expect(screen.queryByText(/Succeeded/)).toBeNull();
  });
});

const mkRun = (o: Partial<RunRecord>): RunRecord => ({
  profileId: 'default',
  user: 's1234567',
  project: v3.PROJECT,
  id: 'r1',
  taskId: 'bench',
  taskName: 'Benchmark',
  kind: 'benchmark',
  jobId: '5001',
  block: '0000000000001',
  command: './bench.sh',
  workingDir: v3.PROJECT,
  gpu: 'nvidia_rtx_a6000',
  node: 'landonia05',
  sentAt: '2026-10-17T10:06:00Z',
  sentMs: 1,
  status: 'succeeded',
  exitCode: 0,
  startedEpoch: 100,
  endedEpoch: 160,
  message: null,
  note: null,
  ...o,
});

describe('GPU Workbench: history', () => {
  const bench = task({ id: 'bench', name: 'Benchmark', kind: 'benchmark', command: './bench.sh' });

  it('compares two runs side by side without turning wall time into a speed-up claim', async () => {
    const runs = [
      mkRun({ id: 'r2', sentMs: 2, endedEpoch: 150, note: 'tile 32', block: '0000000000002' }),
      mkRun({ id: 'r1', sentMs: 1 }),
    ];
    workbench({ tasks: [bench], receipts: [receipt('5001')], active: [sessionRow()], runs });
    backend.handlers.workbench_run_status = (a) => ({
      run: runs.find((r) => r.id === a.runId)!,
      chunk: chunk(`kernel time 1.${a.runId === 'r1' ? 9 : 2} ms\n`),
      logNote: null,
    });
    await openWorkbench();
    const boxes = await screen.findAllByRole('checkbox', { name: /^Compare Benchmark/ });
    await userEvent.click(boxes[0]!);
    await userEvent.click(boxes[1]!);
    const card = await screen.findByRole('region', { name: 'Compare two runs' });
    expect(within(card).getByRole('row', { name: /Command wall time 1 min 50 s/ })).toBeInTheDocument();
    expect(within(card).getByRole('row', { name: /Note tile 32/ })).toBeInTheDocument();
    expect(within(card).getByText(/not GPU kernel time\. Two runs are not enough/)).toBeInTheDocument();
    expect(await within(card).findByLabelText('Output of the first run')).toHaveTextContent('kernel time 1.9 ms');
    expect(await within(card).findByLabelText('Output of the second run')).toHaveTextContent('kernel time 1.2 ms');
    expect(within(card).queryByText(/faster|speed-?up of/i)).toBeNull();
    expect(within(card).queryByText(/different GPU types/)).toBeNull();
  });

  it('warns when the GPU types differ', async () => {
    workbench({
      tasks: [bench],
      runs: [mkRun({ id: 'r2', sentMs: 2, gpu: 'nvidia_rtx_2080_ti' }), mkRun({ id: 'r1', sentMs: 1 })],
    });
    await openWorkbench();
    const boxes = await screen.findAllByRole('checkbox');
    await userEvent.click(boxes[0]!);
    await userEvent.click(boxes[1]!);
    expect(await screen.findByText(/used different GPU types \(RTX A6000 and RTX 2080 Ti\)/)).toBeInTheDocument();
  });

  it('⌘↩ runs the last task again, once, and not while typing', async () => {
    workbench({ tasks: [bench], receipts: [receipt('5001')], active: [sessionRow()], runs: [mkRun({})] });
    await openWorkbench();
    expect(await screen.findByText(/⌘↩ runs Benchmark again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await userEvent.type(screen.getByLabelText('Name'), 'x{Meta>}{Enter}{/Meta}');
    expect(backend.count('workbench_run')).toBe(0);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(backend.count('workbench_run')).toBe(1));
    expect(backend.calls.find((c) => c.cmd === 'workbench_run')?.args).toMatchObject({
      taskId: 'bench',
      jobId: '5001',
    });
  });
});

describe('Readable resources', () => {
  it('shows SLURM memory as GB and GPU types by name', () => {
    expect(['8000M', '32G', '16384M', '16Gn', '4000Mc', '512M', '1.5T', 'weird', null].map(slurmMemory)).toEqual([
      '7.8 GB',
      '32 GB',
      '16 GB',
      '16 GB',
      '3.9 GB per CPU',
      '512 MB',
      '1536 GB',
      'weird',
      '—',
    ]);
    expect(gpuModel('nvidia_geforce_rtx_2080_ti')).toBe('GeForce RTX 2080 Ti');
    expect(gpuModel('nvidia_rtx_a6000')).toBe('RTX A6000');
    expect(gpuModel('nvidia_a100_3g.40gb')).toBe('A100 3g.40gb');
    expect(gpuModel(null)).toBe('GPU (untyped)');
  });

  it('says sub-second runs plainly and hides kind badges that repeat the name', () => {
    expect([0, 13, 60, 125].map(seconds)).toEqual(['under 1 s', '13 s', '1 min', '2 min 5 s']);
    expect(showKind(task({ name: 'Build', kind: 'build' }))).toBe(false);
    expect(showKind(task({ name: 'make check-sm', kind: 'test' }))).toBe(true);
    expect(showKind(task({ name: 'Notes', kind: 'custom' }))).toBe(false);
  });
});
