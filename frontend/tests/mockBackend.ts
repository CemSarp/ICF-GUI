// In-memory stand-in for the Tauri backend used by UI tests. Never talks to SSH.
import demoSnapshot from '../fixtures/slurm/demo_snapshot.json';
import type {
  ClusterSnapshot,
  ConnectionProfile,
  ConnectionStatus,
  JobRow,
  KernelEvent,
  KernelRequest,
  SnapshotResponse,
  WorkflowConfig,
} from '../src/types';
import * as v3 from './v3Fixtures';

export const snapshot = demoSnapshot as unknown as ClusterSnapshot;

export const profile: ConnectionProfile = {
  id: 'default',
  label: 'ICF',
  sshAlias: 'icf',
  username: 's1234567',
  jumpHost: '',
  authMode: 'password',
  savedCredentials: [],
  lastSuccessAt: null,
  hostKeyDecisions: [],
};

export const connectedDemo: ConnectionStatus = {
  state: 'connected',
  profileId: null,
  demo: true,
  capabilities: null,
  hops: [],
  connectedAt: '2026-10-16T14:00:00Z',
  error: null,
  failedAttempts: 0,
  lockedUntil: null,
};

export const connectedLive: ConnectionStatus = {
  ...connectedDemo,
  demo: false,
  profileId: 'default',
  capabilities: {
    remoteUser: 's1',
    remoteHost: 'hastings',
    home: '/home/s1',
    commands: [],
    missingCommands: [],
    slurmVersion: 'slurm 25.05.3',
    jsonSupported: true,
  },
};

export const jobRow = (o: Partial<JobRow>): JobRow => ({
  jobId: '4242',
  user: 's1',
  name: 'semeval-train',
  partition: 'Teaching',
  state: 'running',
  stateRaw: 'RUNNING',
  gpus: 'nvidia_rtx_a6000 × 1',
  cpus: 8,
  memory: '32G',
  submittedAt: '2026-10-16T09:00:00',
  startedAt: '2026-10-16T09:05:00',
  endedAt: null,
  elapsed: '1:00:00',
  timeLeft: '11:00:00',
  timeLimit: '12:00:00',
  nodes: 'landonia11',
  reason: null,
  exitCode: null,
  comment: null,
  source: 'squeue',
  ...o,
});

type Handler = (args: Record<string, unknown>) => unknown;
type KernelChannel = { onmessage: (e: KernelEvent) => void };

/**
 * Fake kernel: `print("x")` lines print x, a last bare expression becomes an execute_result,
 * `raise`/`1/0` fails. Events arrive asynchronously, like the real channel.
 */
function fakeRun(ch: KernelChannel, id: string, code: string, count: number) {
  // %%cuda / %%cpp / %%c: "compiled and ran"; `return 1;` exits with 1. %%icfcc_script runs its body.
  const magic = /^%%(cuda|cpp|c)\b/.exec(code)?.[1];
  if (magic) {
    const fails = code.includes('return 1;');
    ch.onmessage({ event: 'output', id, output: { output_type: 'stream', name: 'stdout', text: `ran the ${magic} program\n` } });
    if (fails)
      ch.onmessage({
        event: 'output',
        id,
        output: { output_type: 'error', ename: 'IcfccError', evalue: '', traceback: ['The program exited with code 1.'] },
      });
    ch.onmessage({ event: 'done', id, count, status: fails ? 'error' : 'ok' });
    return;
  }
  if (code.startsWith('%%icfcc_script')) code = code.slice(code.indexOf('\n') + 1);
  const lines = code
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.startsWith('raise') || l.includes('1/0'))) {
    ch.onmessage({
      event: 'output',
      id,
      output: {
        output_type: 'error',
        ename: 'ZeroDivisionError',
        evalue: 'division by zero',
        traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'],
      },
    });
    ch.onmessage({ event: 'done', id, count, status: 'error' });
    return;
  }
  const printed = lines.map((l) => /^print\((['"])(.*)\1\)$/.exec(l)?.[2]).filter((x) => x !== undefined);
  if (printed.length)
    ch.onmessage({
      event: 'output',
      id,
      output: { output_type: 'stream', name: 'stdout', text: printed.join('\n') + '\n' },
    });
  const last = lines[lines.length - 1];
  if (last && !last.startsWith('print(') && !last.includes('=') && !/^(import|from|def|for|if)\b/.test(last))
    ch.onmessage({
      event: 'output',
      id,
      output: { output_type: 'execute_result', execution_count: count, data: { 'text/plain': last }, metadata: {} },
    });
  ch.onmessage({ event: 'done', id, count, status: 'ok' });
}

export const backend = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, Handler>,
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
  /** Event channel of the running fake kernel (tests can push their own events). */
  kernel: null as KernelChannel | null,
  emit(name: string, payload: unknown) {
    this.listeners[name]?.({ payload });
  },
  count(cmd: string, pred?: (a: Record<string, unknown>) => boolean) {
    return this.calls.filter((c) => c.cmd === cmd && (!pred || pred(c.args))).length;
  },
  reset(status: ConnectionStatus, overrides: Record<string, Handler> = {}) {
    this.calls = [];
    this.listeners = {};
    this.kernel = null;
    let execCount = 0;
    const files: Record<string, string> = { ...v3.FILES }; // editor saves stay within one test
    let shared = false;
    const snap: SnapshotResponse = {
      snapshot,
      lastError: null,
      lastAttemptAt: snapshot.fetchedAt,
      nextAllowedAt: null,
      fetched: true,
      inventoryRequests: 0,
    };
    this.handlers = {
      connection_status: () => status,
      connection_profiles_list: () => [profile],
      settings_get: () => ({ pollIntervalSecs: 60 }),
      cluster_get_snapshot: () => snap,
      cluster_get_node_detail: (a) => snapshot.nodesById[a.nodeId as string],
      connection_test_and_login: () => status,
      connection_answer_challenge: () => undefined,
      connection_forget_credentials: () => ({ ...profile, savedCredentials: [] }),
      connection_cancel: () => undefined,
      connection_disconnect: () => ({ ...status, state: 'disconnected' }),
      connection_profile_save: (a) => a.profile,
      jobs_receipts: () => [],
      jobs_dismiss_receipt: () => null,
      jobs_list_mine: () => ({
        list: {
          active: [
            jobRow({}),
            jobRow({
              jobId: '4243',
              name: 'queued-one',
              state: 'pending',
              stateRaw: 'PENDING',
              nodes: null,
              startedAt: null,
              reason: 'Resources',
            }),
          ],
          history: [
            jobRow({
              jobId: '4100',
              name: 'old',
              state: 'failed',
              stateRaw: 'FAILED',
              exitCode: '1:0',
              source: 'sacct',
            }),
          ],
          historyNote: null,
          fetchedAt: '2026-10-16T14:00:00Z',
          fetchedAtMs: 0,
          historyFetchedAt: '2026-10-16T14:00:00Z',
          foreignRowsDropped: 0,
        },
        lastError: null,
        stale: false,
        fetched: true,
        requests: 1,
      }),
      // V3 defaults (synthetic). Tests override what they exercise.
      projects_recent: () => [v3.project()],
      projects_browse: (a) => v3.listing((a.path as string | null) ?? null),
      files_create: (a) => {
        const path = `${a.dir}/${a.name}`;
        if (files[path] !== undefined)
          throw {
            code: 'INVALID_INPUT',
            message: 'Something with that name already exists there. Nothing was overwritten.',
          };
        files[path] = a.content as string;
        return { path, sha256: v3.fakeSha(a.content as string) };
      },
      files_read: (a) => v3.file(a.path as string, files[a.path as string]),
      files_write: (a) => {
        const cur = files[a.path as string];
        if (cur === undefined || v3.fakeSha(cur) !== a.expectedSha256)
          throw {
            code: 'CONFLICT',
            message: 'The file changed on ICF since you opened it (for example in VS Code). Nothing was saved.',
          };
        files[a.path as string] = a.content as string;
        return { path: a.path, sha256: v3.fakeSha(a.content as string) };
      },
      projects_open: (a) => v3.project({ path: a.path as string }),
      projects_mkdir: (a) => `${a.parent}/${a.name}`,
      projects_set_prefs: (a) => ({ ...v3.project(), ...(a.prefs as object) }),
      projects_forget: () => null,
      python_discover: () => v3.envReport,
      toolchains_list: () => v3.toolchains,
      presets_list: () => [],
      prefs_get: () => ({ transferLimitMbps: 0 }),
      vscode_status: () => v3.vscodeStatus(true),
      vscode_share_status: () => v3.shareStatus(shared),
      vscode_share_preview: () => v3.sharePreview,
      vscode_share_apply: () => ((shared = true), v3.shareStatus(true)),
      vscode_share_disable: () => ((shared = false), v3.shareStatus(false)),
      transfers_list: () => [v3.transfer()],
      workflow_preview: (a) => v3.workflowPreview(a.config as WorkflowConfig),
      kernel_preview: (a) => v3.kernelPreview(a.request as KernelRequest),
      kernel_start: (a) => {
        const ch = a.events as KernelChannel;
        this.kernel = ch;
        setTimeout(() => {
          ch.onmessage({ event: 'starting' });
          ch.onmessage({
            event: 'ready',
            jobId: '5150',
            node: 'landonia01',
            python: '3.11.9',
            tools: 'nvcc 12.8 · g++ 11.4.0 · gcc 11.4.0',
            endsAtMs: Date.now() + 3_600_000,
          });
        }, 0);
        return { kernelId: 'k1' };
      },
      kernel_execute: (a) => {
        const ch = this.kernel!;
        const n = ++execCount;
        setTimeout(() => fakeRun(ch, a.requestId as string, a.code as string, n), 0);
        return null;
      },
      kernel_interrupt: () => null,
      kernel_restart: () => {
        execCount = 0;
        setTimeout(() => this.kernel?.onmessage({ event: 'restarted' }), 0);
        return null;
      },
      kernel_stop: () => {
        const ch = this.kernel;
        this.kernel = null;
        if (ch)
          setTimeout(
            () => ch.onmessage({ event: 'ended', reason: 'stopped', message: 'Kernel stopped; the GPU was released.' }),
            0,
          );
        return null;
      },
      workflow_refresh: () => v3.runs(),
      workflow_list_files: () => v3.listing(`${v3.PROJECT}/runs/train-4242/outputs`),
      jobs_get_detail: (a) => ({
        job: jobRow({ jobId: a.jobId as string }),
        fields: [],
        stdoutPath: `${v3.PROJECT}/runs/slurm-4242.out`,
        stderrPath: `${v3.PROJECT}/runs/slurm-4242.err`,
        stderrMerged: false,
        logPathNote: null,
        cancelToken: null,
        receipt: null,
        fetchedAt: '2026-10-17T10:00:00Z',
      }),
      ...overrides,
    };
  },
};
