// In-memory stand-in for the Tauri backend used by UI tests. Never talks to SSH.
import demoSnapshot from '../fixtures/slurm/demo_snapshot.json';
import type {
  ClusterSnapshot,
  ConnectionProfile,
  ConnectionStatus,
  JobRow,
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

export const backend = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, Handler>,
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
  emit(name: string, payload: unknown) {
    this.listeners[name]?.({ payload });
  },
  count(cmd: string, pred?: (a: Record<string, unknown>) => boolean) {
    return this.calls.filter((c) => c.cmd === cmd && (!pred || pred(c.args))).length;
  },
  reset(status: ConnectionStatus, overrides: Record<string, Handler> = {}) {
    this.calls = [];
    this.listeners = {};
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
