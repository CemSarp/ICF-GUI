// Dev-only browser preview of the UI (pnpm dev, then /dev/preview.html). Never talks to SSH.
import demo from '../fixtures/slurm/demo_snapshot.json';
import * as v3 from '../tests/v3Fixtures';

let shareOn = false;

const callbacks = new Map<number, (e: unknown) => void>();
let next = 1;
let state = new URLSearchParams(location.search).get('state') ?? 'login';
// ?state=live previews the V3 screens as if connected (synthetic data, still no SSH).
const status = () => ({
  state: state === 'login' ? 'disconnected' : 'connected',
  profileId: state === 'live' ? 'default' : null,
  demo: state === 'demo',
  capabilities:
    state === 'live'
      ? {
          remoteUser: 's1234567',
          remoteHost: 'hastings',
          home: v3.HOME,
          commands: [],
          missingCommands: [],
          slurmVersion: 'slurm 25.05.3',
          jsonSupported: true,
        }
      : null,
  hops: [],
  connectedAt: '2026-10-16T14:00:00Z',
  error: null,
  failedAttempts: 0,
  lockedUntil: null,
});
const job = (o: Record<string, unknown>) => ({
  jobId: '1',
  user: 'demo',
  name: 'x',
  partition: 'Teaching',
  state: 'running',
  stateRaw: 'RUNNING',
  gpus: 'nvidia_rtx_a6000 × 1',
  cpus: 8,
  memory: '32G',
  submittedAt: '2026-10-16T09:00:00',
  startedAt: '2026-10-16T09:05:00',
  endedAt: null,
  elapsed: '1:02:13',
  timeLeft: '10:57:47',
  timeLimit: '12:00:00',
  nodes: 'landonia11',
  reason: null,
  exitCode: null,
  comment: null,
  source: 'squeue',
  ...o,
});
const emit = (event: string, payload: unknown) =>
  callbacks.forEach((cb, id) => (cb as { event?: string } & typeof cb).event === event && cb({ event, id, payload }));

const receipt = (o: Record<string, unknown>) => ({
  profileId: 'demo',
  user: 'demo',
  jobId: null,
  cluster: null,
  name: 'semeval-train',
  gres: 'gpu:nvidia_geforce_rtx_2080_ti',
  gpuCount: 1,
  submittedAt: new Date().toISOString(),
  checksum: 'c',
  stdoutPattern: '',
  stderrPattern: '',
  message: null,
  accessDenied: false,
  dismissed: false,
  ...o,
});

// Preview kernel: replays the stored outputs of the showcase notebook's cells (explore.ipynb), else
// echoes print("…") lines and a last bare expression; never runs code.
type StoredCell = { cell_type: string; source: string[]; outputs?: Record<string, unknown>[] };
const replay = new Map<string, Record<string, unknown>[]>(
  (JSON.parse(v3.FILES[`${v3.PROJECT}/explore.ipynb`]!).cells as StoredCell[])
    .filter((c) => c.cell_type === 'code')
    .map((c) => [c.source.join(''), c.outputs ?? []]),
);
let kernelSend: ((m: unknown) => void) | null = null;
let kernelCount = 0;
const kernelChannel = (ch: { id: number }) => {
  let index = 0;
  return (message: unknown) => callbacks.get(ch.id)?.({ index: index++, message });
};
const fakeKernelRun = (id: string, code: string) => {
  const send = kernelSend;
  if (!send) return;
  const n = ++kernelCount;
  const lines = code
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const printed = lines.map((l) => /^print\((['"])(.*)\1\)$/.exec(l)?.[2]).filter((x) => x !== undefined);
  const magic = /^%%(cuda|cpp|c)\b/.exec(code)?.[1];
  if (magic) {
    const n = /--\s*(\d+)/.exec(code.slice(0, code.indexOf('\n')))?.[1] ?? '1048576';
    const text = code.includes('saxpy')
      ? `saxpy on ${n} elements, max error 0.000000\n`
      : `Hello from ${magic === 'cuda' ? 'the GPU' : 'the node'}\n`;
    setTimeout(() => {
      send({ event: 'output', id, output: { output_type: 'stream', name: 'stdout', text } });
      send({ event: 'done', id, count: n, status: 'ok' });
    }, 900);
    return;
  }
  if (code.startsWith('%%icfcc_script')) code = code.slice(code.indexOf('\n') + 1);
  const stored = replay.get(code);
  if (stored) {
    setTimeout(() => {
      for (const o of stored)
        send({ event: 'output', id, output: o.output_type === 'execute_result' ? { ...o, execution_count: n } : o });
      send({ event: 'done', id, count: n, status: stored.some((o) => o.output_type === 'error') ? 'error' : 'ok' });
    }, 700);
    return;
  }
  setTimeout(() => {
    if (printed.length)
      send({ event: 'output', id, output: { output_type: 'stream', name: 'stdout', text: printed.join('\n') + '\n' } });
    const last = lines[lines.length - 1];
    if (last && !last.startsWith('print(') && !last.includes('=') && !/^(import|from|def|for|if)\b/.test(last))
      send({
        event: 'output',
        id,
        output: { output_type: 'execute_result', execution_count: n, data: { 'text/plain': last }, metadata: {} },
      });
    send({ event: 'done', id, count: n, status: 'ok' });
  }, 400);
};

const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
  connection_status: status,
  connection_profiles_list: () => [
    {
      id: 'default',
      label: 'ICF',
      sshAlias: 'icf',
      username: '',
      jumpHost: '',
      authMode: 'password',
      savedCredentials: [],
      lastSuccessAt: null,
      hostKeyDecisions: [],
    },
  ],
  settings_get: () => ({ pollIntervalSecs: 60 }),
  connection_open_demo: () => {
    state = 'demo';
    const s = status();
    emit('connection-status', s);
    return s;
  },
  connection_disconnect: () => {
    state = 'login';
    const s = status();
    emit('connection-status', s);
    return s;
  },
  cluster_get_snapshot: () => ({
    snapshot: { ...demo, fetchedAt: new Date().toISOString() },
    lastError: null,
    lastAttemptAt: new Date().toISOString(),
    nextAllowedAt: null,
    fetched: true,
    inventoryRequests: 0,
  }),
  cluster_get_node_detail: (a) => (demo.nodesById as Record<string, unknown>)[a.nodeId as string],
  jobs_receipts: () => [
    receipt({
      tag: 'r2',
      status: 'rejected',
      partition: 'ICF-Free',
      accessDenied: true,
      message:
        'sbatch: error: Batch job submission failed: Invalid account or account/partition combination specified — Your account may not use this partition/QoS. Ask Informatics support which partitions you can use.',
    }),
    receipt({ tag: 'r1', status: 'accepted', partition: 'Teaching', jobId: '900101' }),
  ],
  jobs_dismiss_receipt: () => null,
  jobs_list_mine: () => ({
    list: {
      active: [
        job({ jobId: '900101', name: 'semeval-train', state: 'running', stateRaw: 'RUNNING', nodes: 'landonia11' }),
        job({
          jobId: '900102',
          name: 'sweep-lr',
          state: 'pending',
          stateRaw: 'PENDING',
          nodes: null,
          startedAt: null,
          elapsed: '0:00',
          timeLeft: null,
          reason: 'Resources',
        }),
      ],
      history: [
        job({
          jobId: '899990',
          name: 'smoke',
          state: 'failed',
          stateRaw: 'FAILED',
          exitCode: '1:0',
          endedAt: '2026-10-16T08:01:02',
          source: 'sacct',
        }),
      ],
      historyNote: null,
      fetchedAt: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      historyFetchedAt: new Date().toISOString(),
      foreignRowsDropped: 0,
    },
    lastError: null,
    stale: false,
    fetched: true,
    requests: 1,
  }),
  jobs_get_detail: (a) => ({
    job: job({
      jobId: a.jobId as string,
      name: 'semeval-train',
      state: 'running',
      stateRaw: 'RUNNING',
      nodes: 'landonia11',
    }),
    fields: [
      ['JobId', String(a.jobId)],
      ['Partition', 'Teaching'],
      ['TresPerNode', 'gres/gpu:nvidia_rtx_a6000:1'],
    ],
    stdoutPath: '/home/demo/projects/semeval/slurm-900101.out',
    stderrPath: '/home/demo/projects/semeval/slurm-900101.err',
    stderrMerged: false,
    logPathNote: null,
    cancelToken: 'preview-token',
    receipt: null,
    fetchedAt: new Date().toISOString(),
  }),
  jobs_get_log_tail: () => ({
    path: '/home/demo/projects/semeval/slurm-900101.out',
    size: 160,
    from: 0,
    next: 160,
    rotated: false,
    text: '[icf-control-center] job 900101 on landonia11 started 2026-10-16T09:05:00Z\nepoch 1/3  loss 0.912  acc 0.61\nepoch 2/3  loss 0.547  acc 0.78\n',
  }),
  jobs_preview: (a) => {
    const r = a.request as Record<string, unknown>;
    return {
      previewId: 'pv',
      checksum: '3f2a9c4e1b7d6a05',
      errors: [],
      warnings: [],
      acknowledgements: [
        "Eligibility for '" + r.partition + "' is unknown: the scheduler may reject or hold this job.",
      ],
      snapshotAt: new Date().toISOString(),
      timeLimit: '0-04:00:00',
      home: '/home/demo',
      stdoutPattern: r.workingDir + '/slurm-%j.out',
      stderrPattern: r.workingDir + '/slurm-%j.err',
      script:
        '#!/bin/bash\n#SBATCH --job-name=' +
        r.jobName +
        '\n#SBATCH --partition=' +
        r.partition +
        '\n#SBATCH --nodes=1\n#SBATCH --ntasks=1\n#SBATCH --gres=gpu:' +
        r.gresType +
        ':' +
        r.gpuCount +
        '\n#SBATCH --cpus-per-task=' +
        r.cpus +
        '\n#SBATCH --mem=' +
        r.memoryMib +
        'M\n#SBATCH --time=0-04:00:00\n#SBATCH --chdir=' +
        r.workingDir +
        '\n#SBATCH --output=' +
        r.workingDir +
        '/slurm-%j.out\n#SBATCH --error=' +
        r.workingDir +
        '/slurm-%j.err\n#SBATCH --comment=icfcc-0a1b2c3d4e5f\n' +
        (r.mailUser ? `#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=${r.mailUser}\n` : '') +
        "set -e\nexec python3 '" +
        r.workingDir +
        '/' +
        r.program +
        "'\n",
    };
  },
  projects_recent: () => [v3.project()],
  projects_browse: (a) => v3.listing((a.path as string | null) ?? null),
  files_create: (a) => {
    const path = `${a.dir}/${a.name}`;
    if (v3.FILES[path] !== undefined)
      throw { code: 'INVALID_INPUT', message: 'Something with that name already exists there. Nothing was overwritten.' };
    v3.FILES[path] = a.content as string;
    return { path, sha256: v3.fakeSha(a.content as string) };
  },
  files_read: (a) => v3.file(a.path as string),
  files_write: (a) => {
    const cur = v3.FILES[a.path as string];
    if (cur === undefined || v3.fakeSha(cur) !== a.expectedSha256)
      throw { code: 'CONFLICT', message: 'The file changed on ICF since you opened it (for example in VS Code). Nothing was saved.' };
    v3.FILES[a.path as string] = a.content as string;
    return { path: a.path, sha256: v3.fakeSha(a.content as string) };
  },
  projects_open: (a) => v3.project({ path: a.path as string }),
  projects_mkdir: (a) => `${a.parent}/${a.name}`,
  projects_set_prefs: (a) => ({ ...v3.project(), ...(a.prefs as object) }),
  projects_forget: () => null,
  python_discover: () => v3.envReport,
  python_check_imports: (a) =>
    (a.modules as string[]).map((module) =>
      module === 'transformers' || module === 'peft'
        ? { module, status: 'failed', detail: 'RuntimeError: operator torchvision::nms does not exist' }
        : { module, status: 'ok', detail: module === 'torch' ? '2.8.0a0+gitunknown' : '7.16.6' },
    ),
  toolchains_list: () => v3.toolchains,
  presets_list: () => [],
  presets_save: () => [],
  prefs_get: () => ({ transferLimitMbps: 0 }),
  prefs_set: (a) => a.prefs,
  vscode_status: () => v3.vscodeStatus(true),
  vscode_share_status: () => v3.shareStatus(shareOn),
  vscode_share_preview: () => v3.sharePreview,
  vscode_share_apply: () => ((shareOn = true), v3.shareStatus(true)),
  vscode_share_disable: () => ((shareOn = false), v3.shareStatus(false)),
  vscode_open: (a) => ({
    remotePath: a.path,
    alias: 'icf',
    message: `VS Code was asked to open ${a.path} on 'icf'. It connects with its own SSH session and may ask you to sign in; this app cannot see whether that succeeded. Run/Debug in that window runs on the login node, not on a GPU.`,
  }),
  vscode_settings_preview: (a) => ({
    previewId: 'sp',
    project: a.project,
    file: `${a.project}/.vscode/settings.json`,
    exists: true,
    before: '{\n  "editor.tabSize": 4\n}\n',
    after: `{\n  "editor.tabSize": 4,\n  "python.defaultInterpreterPath": "${a.interpreter}"\n}\n`,
    problem: null,
    manualSnippet: '',
  }),
  vscode_settings_apply: (a) => ({
    file: `${v3.PROJECT}/.vscode/settings.json`,
    backup: a.previewId ? `${v3.PROJECT}/.vscode/settings.json.icfcc-backup-20261017T100000Z` : null,
  }),
  transfers_list: () => [
    v3.transfer({
      id: 't2',
      phase: 'transferring',
      doneBytes: 312_000_000,
      message: null,
      name: 'images.tar.gz',
      remotePath: `${v3.PROJECT}/data/images.tar.gz`,
    }),
    v3.transfer(),
  ],
  transfers_pick_file: () => ({
    token: 'tok',
    name: 'semeval-v2.tar.gz',
    path: '/Users/me/semeval-v2.tar.gz',
    size: 1_234_567,
    isArchive: true,
  }),
  transfers_upload: () => v3.transfer({ phase: 'queued', doneBytes: 0 }),
  transfers_download: () => null,
  workflow_preview: (a) => v3.workflowPreview(a.config as never),
  kernel_preview: (a) => v3.kernelPreview(a.request as never),
  kernel_start: (a) => {
    const send = kernelChannel(a.events as { id: number });
    kernelSend = send;
    kernelCount = 0;
    setTimeout(() => send({ event: 'starting' }), 100);
    setTimeout(() => send({ event: 'queued', jobId: '5150' }), 500);
    setTimeout(
      () => send({ event: 'ready', jobId: '5150', node: 'landonia01', python: '3.11.9',
            tools: 'nvcc 12.8 · g++ 11.4.0 · gcc 11.4.0', endsAtMs: Date.now() + 3_600_000 }),
      1500,
    );
    return { kernelId: 'k1' };
  },
  kernel_execute: (a) => (fakeKernelRun(a.requestId as string, a.code as string), null),
  kernel_interrupt: () => null,
  kernel_restart: () => ((kernelCount = 0), setTimeout(() => kernelSend?.({ event: 'restarted' }), 200), null),
  kernel_stop: () => {
    const send = kernelSend;
    kernelSend = null;
    if (send) setTimeout(() => send({ event: 'ended', reason: 'stopped', message: 'Kernel stopped; the GPU was released.' }), 200);
    return null;
  },
  workflow_refresh: () => v3.runs(),
  workflow_runs: () => v3.runs().runs,
  workflow_list_files: (a) => v3.listing(`${v3.PROJECT}/runs/train-4242/${a.which}`),
  workflow_metrics: () => v3.metrics,
  jobs_cancel: () => ({ outcome: 'requested' }),
  jobs_submit: () => ({
    outcome: 'accepted',
    jobId: '4243',
    cluster: null,
    receipt: receipt({ tag: 'a1b2c3d4e5f6', status: 'accepted', partition: 'Teaching', jobId: '4243' }),
  }),
  connection_test_and_login: () => {
    throw { code: 'SSH_UNAVAILABLE', message: 'Preview mode: no SSH available in the browser.' };
  },
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback(cb: (e: unknown) => void) {
    const id = next++;
    callbacks.set(id, cb);
    return id;
  },
  async invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === 'plugin:event|listen') {
      const cb = callbacks.get(args.handler as number);
      if (cb) (cb as { event?: string } & typeof cb).event = args.event as string;
      return args.handler;
    }
    if (cmd.startsWith('plugin:event|')) return null;
    const h = handlers[cmd];
    if (!h) throw { code: 'INTERNAL', message: `preview: ${cmd} not mocked` };
    return h(args);
  },
};
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
