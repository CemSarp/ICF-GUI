import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, Dialog, EmptyState, Icon, Notice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { bytes, formatTime, nominalVram } from '../../lib/format';
import { usePersistentState } from '../../lib/persist';
import type {
  CheckpointMode,
  ClusterSnapshot,
  ConnectionStatus,
  Issue,
  SubmitResponse,
  ToolchainProfile,
  Transfer,
  WorkflowConfig,
  WorkflowKind,
  WorkflowPreview,
  WorkflowState,
} from '../../types';
import { PickRemote } from '../projects/RemoteBrowser';
import { safeName } from '../transfers/TransfersView';

export interface Draft {
  kind: WorkflowKind;
  jobName: string;
  projectDir: string;
  entry: string;
  args: string;
  interpreter: string;
  toolchainId: string;
  datasets: { archive: string; into: string }[];
  scratchRoot: 'disk_scratch' | 'slurm_tmpdir';
  hfMode: 'off' | 'scratch' | 'home' | 'staged';
  hfPath: string;
  hfArchive: string;
  hfOffline: boolean;
  resultsRoot: string;
  checkpointMode: CheckpointMode;
  checkpointSyncMinutes: number;
  resumeFrom: string;
  env: string;
  expectedOutputGib: number;
  signalGraceSeconds: number;
  partition: string;
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  hours: number;
  minutes: number;
}

export interface WizardInit {
  projectDir?: string;
  kind?: WorkflowKind;
  interpreter?: string | null;
  toolchainId?: string | null;
  config?: WorkflowConfig;
}

export const DEFAULT_DRAFT: Draft = {
  kind: 'train',
  jobName: 'train',
  projectDir: '',
  entry: 'train.py',
  args: '',
  interpreter: '',
  toolchainId: '',
  datasets: [],
  scratchRoot: 'disk_scratch',
  hfMode: 'scratch',
  hfPath: '',
  hfArchive: '',
  hfOffline: false,
  resultsRoot: '',
  checkpointMode: 'scratch_sync',
  checkpointSyncMinutes: 30,
  resumeFrom: '',
  env: '',
  expectedOutputGib: 5,
  signalGraceSeconds: 300,
  partition: '',
  gres: '',
  gpuCount: 1,
  cpus: 4,
  memoryGb: 16,
  hours: 4,
  minutes: 0,
};

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function toConfig(d: Draft, toolchains: ToolchainProfile[]): WorkflowConfig {
  const tc = toolchains.find((t) => t.id === d.toolchainId);
  const project = d.projectDir.trim().replace(/\/+$/, '');
  return {
    kind: d.kind,
    jobName: d.jobName.trim(),
    projectDir: project,
    entry: d.kind === 'gpu_smoke_test' ? '' : d.entry.trim(),
    args: d.kind === 'train' ? lines(d.args) : [],
    interpreter: d.interpreter.trim(),
    toolchain: tc ? tc.spec : { kind: 'none' },
    datasets: d.datasets
      .filter((x) => x.archive.trim())
      .map((x) => ({ archive: x.archive.trim(), into: x.into.trim() })),
    scratchRoot: d.scratchRoot,
    hfCache:
      d.hfMode === 'home'
        ? { mode: 'home', path: d.hfPath.trim() }
        : d.hfMode === 'staged'
          ? { mode: 'staged', archive: d.hfArchive.trim(), offline: d.hfOffline }
          : { mode: d.hfMode },
    resultsRoot: d.resultsRoot.trim().replace(/\/+$/, '') || `${project}/runs`,
    checkpointMode: d.checkpointMode,
    checkpointSyncMinutes: d.checkpointSyncMinutes,
    resumeFrom: d.resumeFrom.trim() || null,
    env: lines(d.env).map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1) };
    }),
    expectedOutputGib: d.expectedOutputGib,
    signalGraceSeconds: d.signalGraceSeconds,
    resources: {
      partition: d.partition,
      gresType: d.gres === 'gpu' || d.gres === '' ? null : d.gres.replace(/^gpu:/, ''),
      gpuCount: d.gpuCount,
      cpus: d.cpus,
      memoryMib: Math.round(d.memoryGb * 1024),
      timeLimitSeconds: d.hours * 3600 + d.minutes * 60,
    },
  };
}

export function fromConfig(c: WorkflowConfig, toolchains: ToolchainProfile[]): Draft {
  const tc = toolchains.find((t) => JSON.stringify(t.spec) === JSON.stringify(c.toolchain));
  return {
    ...DEFAULT_DRAFT,
    kind: c.kind,
    jobName: c.jobName,
    projectDir: c.projectDir,
    entry: c.entry || DEFAULT_DRAFT.entry,
    args: c.args.join('\n'),
    interpreter: c.interpreter,
    toolchainId: tc?.id ?? '',
    datasets: c.datasets,
    scratchRoot: c.scratchRoot,
    hfMode: c.hfCache.mode,
    hfPath: c.hfCache.mode === 'home' ? c.hfCache.path : '',
    hfArchive: c.hfCache.mode === 'staged' ? c.hfCache.archive : '',
    hfOffline: c.hfCache.mode === 'staged' ? c.hfCache.offline : false,
    resultsRoot: c.resultsRoot,
    checkpointMode: c.checkpointMode,
    checkpointSyncMinutes: c.checkpointSyncMinutes,
    resumeFrom: c.resumeFrom ?? '',
    env: c.env.map((e) => `${e.name}=${e.value}`).join('\n'),
    expectedOutputGib: c.expectedOutputGib,
    signalGraceSeconds: c.signalGraceSeconds,
    partition: c.resources.partition,
    gres: c.resources.gresType ? `gpu:${c.resources.gresType}` : 'gpu',
    gpuCount: c.resources.gpuCount,
    cpus: c.resources.cpus,
    memoryGb: Math.round(c.resources.memoryMib / 1024),
    hours: Math.floor(c.resources.timeLimitSeconds / 3600),
    minutes: Math.floor((c.resources.timeLimitSeconds % 3600) / 60),
  };
}

function Field({
  label,
  field,
  issues,
  help,
  children,
}: {
  label: string;
  field: string;
  issues: Issue[];
  help?: ReactNode;
  children: ReactNode;
}) {
  const mine = issues.filter((i) => i.field === field);
  return (
    <div className={`field${mine.length ? ' invalid' : ''}`}>
      <label htmlFor={`w-${field}`}>{label}</label>
      {children}
      {help && <small className="muted">{help}</small>}
      {mine.length > 0 && (
        <span className="field-error" role="alert">
          {mine.map((i) => i.message).join(' ')}
        </span>
      )}
    </div>
  );
}

export function TrainingWizard({
  status,
  snapshot,
  init,
  onOpenRun,
  onRefreshCluster,
}: {
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  init: WizardInit | null;
  onOpenRun: (tag: string) => void;
  onRefreshCluster: () => void;
}) {
  const qc = useQueryClient();
  const toolchains = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const presets = useQuery({
    queryKey: ['presets', status.profileId, status.connectedAt],
    queryFn: api.presets,
    retry: false,
  });
  const [stored, setStored] = usePersistentState<Draft>('workflow.draft', DEFAULT_DRAFT);
  const [draft, setDraftState] = useState<Draft>(() => {
    const base = { ...DEFAULT_DRAFT, ...stored };
    if (init?.config) return fromConfig(init.config, toolchains.data ?? []);
    if (!init) return base;
    return {
      ...base,
      projectDir: init.projectDir ?? base.projectDir,
      kind: init.kind ?? (base.kind === 'gpu_smoke_test' ? 'train' : base.kind),
      jobName: init.kind === 'gpu_smoke_test' ? 'gpu-smoke' : base.jobName,
      interpreter: init.interpreter ?? base.interpreter,
      toolchainId: init.toolchainId ?? base.toolchainId,
      resultsRoot: init.projectDir && init.projectDir !== base.projectDir ? '' : base.resultsRoot,
      ...(init.kind === 'gpu_smoke_test'
        ? {
            datasets: [],
            hours: 0,
            minutes: 10,
            cpus: 2,
            memoryGb: 8,
            gpuCount: 1,
            signalGraceSeconds: 120,
            checkpointMode: 'none' as const,
            expectedOutputGib: 0,
          }
        : {}),
    };
  });
  const setDraft = (d: Draft) => {
    setDraftState(d);
    setStored(d);
  };
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [phase, setPhase] = useState<WorkflowState>('DRAFT');
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | {
    kind: 'dir' | 'file';
    title: string;
    start: string | null;
    onPick: (p: string) => void;
    archives?: boolean;
  }>(null);
  const [upload, setUpload] = useState<Transfer | null>(null);
  const [presetLabel, setPresetLabel] = useState('');
  const submitting = useRef(false);

  // Live progress of an archive being uploaded from the wizard (local list call, no network).
  useQuery({
    queryKey: ['wizard-upload', upload?.id],
    enabled: !!upload && phase === 'UPLOADING',
    refetchInterval: 1500,
    queryFn: async () => {
      const t = (await api.transfers()).find((x) => x.id === upload?.id) ?? null;
      setUpload(t);
      if (t && t.phase === 'done') {
        const into =
          safeName(t.name.replace(/\.(tar\.gz|tgz|tar\.zst|tar\.zstd|tzst|tar|tar\.xz|tar\.bz2|zip)$/i, '')) || 'data';
        setDraft({ ...draft, datasets: [...draft.datasets, { archive: t.remotePath, into }] });
        setPhase('DRAFT');
      } else if (t && ['failed', 'cancelled', 'interrupted'].includes(t.phase)) {
        setError(`Upload ${t.phase}: ${t.message ?? ''} You can resume it in Transfers.`);
        setPhase('DRAFT');
      }
      return t;
    },
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft({ ...draft, [k]: v });
    setPreview(null);
    setResult(null);
    if (phase === 'READY') setPhase('DRAFT');
  };

  if (!snapshot) {
    return (
      <EmptyState title="Cluster data needed">
        The workflow is checked against current partitions and GPU types.{' '}
        <button className="link" onClick={onRefreshCluster}>
          Refresh cluster data
        </button>
      </EmptyState>
    );
  }
  if (status.demo) {
    return (
      <EmptyState title="Workflows need a live connection">
        Demo mode uses synthetic data. Connect to ICF to configure and submit training workflows.
      </EmptyState>
    );
  }

  const partition =
    snapshot.partitions.find((p) => p.name === draft.partition) ??
    snapshot.partitions.find((p) => p.isDefault) ??
    snapshot.partitions[0];
  const gpuTypes = partition?.gpuTotals ?? [];
  const gres = gpuTypes.some((t) => t.gresName === draft.gres) ? draft.gres : (gpuTypes[0]?.gresName ?? '');
  const effective: Draft = { ...draft, partition: partition?.name ?? '', gres };
  const tcList = toolchains.data ?? [];
  const project = effective.projectDir.trim().replace(/\/+$/, '');

  const review = async (e: FormEvent) => {
    e.preventDefault();
    setPhase('VALIDATING');
    setError(null);
    setAck(false);
    try {
      const p = await api.workflowPreview(toConfig(effective, tcList));
      setIssues(p.errors);
      if (p.errors.length) {
        setPreview(null);
        setPhase('DRAFT');
        setError(`${p.errors.length} problem(s) need fixing before the workflow can be reviewed.`);
      } else {
        setPreview(p);
        setPhase('READY');
      }
    } catch (err) {
      setError(errorMessage(err));
      setPhase('DRAFT');
    }
  };

  const submit = async () => {
    if (!preview?.previewId || submitting.current) return;
    submitting.current = true;
    setPhase('SUBMITTING');
    setError(null);
    try {
      const r = await api.jobsSubmit(preview.previewId, ack, crypto.randomUUID());
      setResult(r);
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setConfirming(false);
      setPhase('DRAFT');
      submitting.current = false;
    }
  };

  const uploadArchive = async () => {
    setError(null);
    try {
      const pick = await api.pickFile();
      if (!pick) return;
      if (!pick.isArchive) {
        setError('Choose an archive (.tar.gz, .tar.zst, .zip, …). Pack folders in Transfers first.');
        return;
      }
      await api.mkdir(project, 'data').catch(() => undefined); // already exists is fine
      setUpload(await api.upload(pick.token, `${project}/data`, safeName(pick.name)));
      setPhase('UPLOADING');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (result) {
    return (
      <section className="card result" aria-live="polite">
        {result.outcome === 'accepted' && (
          <>
            <h2>
              <Badge tone="ok" glyph="✓">
                Accepted
              </Badge>{' '}
              Job {result.jobId}
            </h2>
            <p>
              SLURM queued the workflow. It runs on a compute node; this app only monitors it (closing the app does not
              stop it). Results go to{' '}
              <code>
                {toConfig(effective, tcList).resultsRoot}/{effective.jobName}-{result.jobId}
              </code>
              .
            </p>
            <div className="actions start">
              <button className="btn primary" onClick={() => onOpenRun(result.receipt.tag)}>
                Monitor this run
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                New workflow
              </button>
            </div>
          </>
        )}
        {result.outcome === 'rejected' && (
          <>
            <h2>
              <Badge tone="bad" glyph="✕">
                Not submitted
              </Badge>
            </h2>
            <Notice tone="bad">{result.message}</Notice>
            <button className="btn" onClick={() => setResult(null)}>
              Edit workflow
            </button>
          </>
        )}
        {result.outcome === 'uncertain' && (
          <>
            <h2>
              <Badge tone="warn" glyph="?">
                Submission uncertain
              </Badge>
            </h2>
            <Notice tone="warn" title="The job may or may not have been queued">
              {result.message} The app never resubmits on its own. Check your jobs first.
            </Notice>
            {reconcileMsg && <Notice tone="info">{reconcileMsg}</Notice>}
            <div className="actions start">
              <button
                className="btn primary"
                onClick={() =>
                  api
                    .workflowReconcile(result.receipt.tag)
                    .then((r) => setReconcileMsg(r.submissionMessage ?? r.submission))
                    .catch((e) => setReconcileMsg(errorMessage(e)))
                }
              >
                Check my jobs for this submission
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                Back to the workflow
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  const maxGpus = partition
    ? Math.max(
        1,
        ...partition.nodeIds.map(
          (id) => snapshot.nodesById[id]?.resources.find((r) => r.gresName === gres)?.configured ?? 0,
        ),
      )
    : 1;
  // Same two steps as Request GPU; uploading and checking show their own notices.
  const reviewing = phase === 'READY' || phase === 'SUBMITTING';

  return (
    <div className="wizard">
      <ol className="steps" aria-label="Progress">
        <li aria-current={!reviewing ? 'step' : undefined} className={reviewing ? 'done' : undefined}>
          Configure
        </li>
        <li aria-current={reviewing ? 'step' : undefined}>Review &amp; submit</li>
      </ol>
      {error && <Notice tone="bad">{error}</Notice>}
      {phase === 'UPLOADING' && upload && (
        <Notice tone="info" title={`Uploading ${upload.name}`}>
          {upload.phase} · {bytes(upload.doneBytes)} / {bytes(upload.size)}. The dataset is added to this workflow when
          the verified upload finishes.
        </Notice>
      )}

      {!preview ? (
        <form className="card" onSubmit={review} noValidate>
          <div className="card-head">
            <h2>Workflow</h2>
            {(presets.data?.length ?? 0) > 0 && (
              <label className="field inline">
                <span>Load preset</span>
                <select
                  value=""
                  onChange={(e) => {
                    const p = presets.data?.find((x) => x.id === e.target.value);
                    if (p) setDraft(fromConfig(p.config, tcList));
                  }}
                >
                  <option value="">Choose…</option>
                  {presets.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <fieldset className="segmented">
            <legend>Type</legend>
            {(
              [
                ['train', 'Training script (sbatch)'],
                ['notebook', 'Notebook, batch execution'],
                ['gpu_smoke_test', 'GPU smoke test'],
              ] as const
            ).map(([k, label]) => (
              <label key={k}>
                <input type="radio" name="kind" checked={draft.kind === k} onChange={() => set('kind', k)} />
                {label}
              </label>
            ))}
          </fieldset>
          {draft.kind === 'gpu_smoke_test' && (
            <Notice tone="info">
              Runs a fixed check on the allocated GPU node: Python and PyTorch versions,{' '}
              <code>torch.cuda.is_available()</code>, the GPU model and one tiny matrix multiply. No benchmark; it also
              exercises scratch staging and result copy-back.
            </Notice>
          )}
          {draft.kind === 'notebook' && (
            <Notice tone="info">
              The notebook is executed top to bottom on the compute node with <code>nbconvert</code> (must be installed
              in the environment) and the executed copy is saved with the results. Interactive Jupyter sessions are not
              offered (see Settings).
            </Notice>
          )}

          <h3>Project and program</h3>
          <div className="grid-2">
            <Field label="Project folder on ICF" field="projectDir" issues={issues}>
              <div className="input-row">
                <input
                  id="w-projectDir"
                  className="mono"
                  value={draft.projectDir}
                  onChange={(e) => set('projectDir', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setPicker({
                      kind: 'dir',
                      title: 'Choose the project folder',
                      start: project || null,
                      onPick: (p) => set('projectDir', p),
                    })
                  }
                >
                  Choose…
                </button>
              </div>
            </Field>
            <Field label="Job name" field="jobName" issues={issues} help="Letters, digits, . _ -">
              <input
                id="w-jobName"
                value={draft.jobName}
                onChange={(e) => set('jobName', e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          </div>
          {draft.kind !== 'gpu_smoke_test' && (
            <Field
              label={
                draft.kind === 'notebook'
                  ? 'Notebook (.ipynb, relative to the project)'
                  : 'Script (relative to the project)'
              }
              field="entry"
              issues={issues}
            >
              <input
                id="w-entry"
                className="mono"
                value={draft.entry}
                onChange={(e) => set('entry', e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          )}
          {draft.kind === 'train' && (
            <Field
              label="Arguments (one per line)"
              field="args"
              issues={issues}
              help={
                <>
                  Passed literally. Placeholders: <code>{'{data}'}</code> <code>{'{outputs}'}</code>{' '}
                  <code>{'{checkpoints}'}</code> <code>{'{scratch}'}</code> <code>{'{run_dir}'}</code>{' '}
                  <code>{'{resume}'}</code> (also available as $ICFCC_DATA_DIR etc.)
                </>
              }
            >
              <textarea
                id="w-args"
                rows={3}
                className="mono"
                value={draft.args}
                onChange={(e) => set('args', e.target.value)}
                spellCheck={false}
              />
            </Field>
          )}
          <div className="grid-2">
            <Field
              label="Python interpreter on ICF"
              field="interpreter"
              issues={issues}
              help="Full path, e.g. /home/<you>/projects/icf-env/bin/python (~ is not expanded) — or choose one in Projects → Python environment"
            >
              <input
                id="w-interpreter"
                className="mono"
                value={draft.interpreter}
                onChange={(e) => set('interpreter', e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="CUDA toolchain"
              field="toolchain"
              issues={issues}
              help="Sourced in the job only if it exists then; never installed or upgraded"
            >
              <select id="w-toolchain" value={draft.toolchainId} onChange={(e) => set('toolchainId', e.target.value)}>
                <option value="">None (virtualenv only)</option>
                {tcList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <h3>Data and scratch</h3>
          <p className="muted small">
            Archives are copied from /home (NFS) to a private folder on the compute node's local disk, checked (no
            absolute or <code>..</code> paths, no links leaving the folder, no devices, no archive bombs) and only then
            unpacked. The scratch folder exists only inside the job and is deleted when it ends.
          </p>
          <Field label="Dataset archives" field="datasets" issues={issues}>
            <div className="dataset-list">
              {draft.datasets.map((d, i) => (
                <div key={i} className="input-row">
                  <input
                    aria-label={`Archive ${i + 1}`}
                    className="mono"
                    value={d.archive}
                    onChange={(e) =>
                      set(
                        'datasets',
                        draft.datasets.map((x, j) => (j === i ? { ...x, archive: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="muted">→ data/</span>
                  <input
                    aria-label={`Folder name for archive ${i + 1}`}
                    className="mono short"
                    value={d.into}
                    onChange={(e) =>
                      set(
                        'datasets',
                        draft.datasets.map((x, j) => (j === i ? { ...x, into: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn ghost icon-btn"
                    aria-label={`Remove archive ${i + 1}`}
                    onClick={() =>
                      set(
                        'datasets',
                        draft.datasets.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              <div className="actions start">
                <button
                  type="button"
                  className="btn"
                  disabled={draft.datasets.length >= 4}
                  onClick={() =>
                    setPicker({
                      kind: 'file',
                      archives: true,
                      title: 'Choose a dataset archive on ICF',
                      start: project || null,
                      onPick: (p) =>
                        set('datasets', [
                          ...draft.datasets,
                          { archive: p, into: safeName((p.split('/').pop() ?? 'data').replace(/\..*$/, '')) || 'data' },
                        ]),
                    })
                  }
                >
                  Add archive on ICF…
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!project || phase === 'UPLOADING' || draft.datasets.length >= 4}
                  onClick={() => void uploadArchive()}
                >
                  Upload an archive from this Mac…
                </button>
              </div>
            </div>
          </Field>
          <div className="grid-2">
            <Field label="Scratch location" field="scratchRoot" issues={issues}>
              <select
                id="w-scratchRoot"
                value={draft.scratchRoot}
                onChange={(e) => set('scratchRoot', e.target.value as Draft['scratchRoot'])}
              >
                <option value="disk_scratch">/disk/scratch/&lt;you&gt;/… (ICF node-local disk)</option>
                <option value="slurm_tmpdir">$SLURM_TMPDIR (if the site provides it)</option>
              </select>
            </Field>
            <Field
              label="Space to reserve for outputs (GB)"
              field="expectedOutputGib"
              issues={issues}
              help="Staging fails early if the node's scratch disk cannot hold data plus this"
            >
              <input
                id="w-expectedOutputGib"
                type="number"
                min={0}
                value={draft.expectedOutputGib}
                onChange={(e) => set('expectedOutputGib', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Hugging Face cache" field="hfCache" issues={issues}>
              <select
                id="w-hfCache"
                value={draft.hfMode}
                onChange={(e) => set('hfMode', e.target.value as Draft['hfMode'])}
              >
                <option value="scratch">On scratch (fast; downloads again each job)</option>
                <option value="home">Persistent folder in /home (download once; NFS)</option>
                <option value="staged">Stage a packed cache archive to scratch</option>
                <option value="off">Leave HF variables alone</option>
              </select>
            </Field>
            {draft.hfMode === 'home' && (
              <Field label="HF_HOME folder" field="hfCache" issues={[]}>
                <input
                  className="mono"
                  value={draft.hfPath}
                  onChange={(e) => set('hfPath', e.target.value)}
                  placeholder={`${project}/hf-cache`}
                />
              </Field>
            )}
            {draft.hfMode === 'staged' && (
              <Field label="Cache archive" field="hfCache" issues={[]}>
                <input className="mono" value={draft.hfArchive} onChange={(e) => set('hfArchive', e.target.value)} />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.hfOffline}
                    onChange={(e) => set('hfOffline', e.target.checked)}
                  />
                  Offline mode (no downloads)
                </label>
              </Field>
            )}
          </div>

          <h3>Results and checkpoints</h3>
          <div className="grid-2">
            <Field
              label="Results folder"
              field="resultsRoot"
              issues={issues}
              help={`Each run gets <folder>/<job name>-<job id>; default ${project || '<project>'}/runs`}
            >
              <input
                id="w-resultsRoot"
                className="mono"
                value={draft.resultsRoot}
                placeholder={project ? `${project}/runs` : ''}
                onChange={(e) => set('resultsRoot', e.target.value)}
              />
            </Field>
            <Field label="Checkpoints" field="checkpointMode" issues={issues}>
              <select
                id="w-checkpointMode"
                value={draft.checkpointMode}
                onChange={(e) => set('checkpointMode', e.target.value as CheckpointMode)}
              >
                <option value="scratch_sync">Scratch, copied to /home periodically (recommended)</option>
                <option value="direct">Directly in /home (durable at once, more NFS load)</option>
                <option value="none">Scratch only, copied at the end (lost if the node fails)</option>
              </select>
            </Field>
          </div>
          <div className="grid-4">
            {draft.checkpointMode === 'scratch_sync' && (
              <Field label="Sync every (minutes)" field="checkpointSyncMinutes" issues={issues}>
                <input
                  id="w-checkpointSyncMinutes"
                  type="number"
                  min={5}
                  max={720}
                  value={draft.checkpointSyncMinutes}
                  onChange={(e) => set('checkpointSyncMinutes', Number(e.target.value))}
                />
              </Field>
            )}
            <Field
              label="Copy-back warning (s)"
              field="signalGraceSeconds"
              issues={issues}
              help="SIGTERM to your program this long before the time limit"
            >
              <input
                id="w-signalGraceSeconds"
                type="number"
                min={60}
                max={1800}
                value={draft.signalGraceSeconds}
                onChange={(e) => set('signalGraceSeconds', Number(e.target.value))}
              />
            </Field>
          </div>
          <Field
            label="Resume from checkpoint (optional)"
            field="resumeFrom"
            issues={issues}
            help="Exported as $ICFCC_RESUME_FROM and {resume}"
          >
            <input
              id="w-resumeFrom"
              className="mono"
              value={draft.resumeFrom}
              onChange={(e) => set('resumeFrom', e.target.value)}
            />
          </Field>
          <Notice tone="info">
            Checkpoints and outputs survive only if they reach /home: the job copies them back at the end, on failure,
            on cancellation and before the time limit, but nothing can be copied from a node that has failed. Write
            checkpoints to <code>$ICFCC_CHECKPOINT_DIR</code> and results to <code>$ICFCC_OUTPUT_DIR</code>.
          </Notice>
          <Field label="Environment variables (NAME=value per line)" field="env" issues={issues}>
            <textarea
              id="w-env"
              rows={2}
              className="mono"
              value={draft.env}
              onChange={(e) => set('env', e.target.value)}
              spellCheck={false}
            />
          </Field>

          <h3>GPU resources</h3>
          <div className="grid-2">
            <Field label="Partition" field="partition" issues={issues}>
              <select id="w-partition" value={partition?.name ?? ''} onChange={(e) => set('partition', e.target.value)}>
                {snapshot.partitions.map((p) => (
                  <option key={p.name} value={p.name} disabled={p.eligibility === 'not_permitted'}>
                    {p.name}
                    {p.isDefault ? ' (default)' : ''}
                    {p.eligibility === 'not_permitted' ? ' — not permitted' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="GPU type"
              field="gresType"
              issues={issues}
              help={`Potentially free at ${formatTime(snapshot.fetchedAt)}; not a reservation`}
            >
              <select id="w-gresType" value={gres} onChange={(e) => set('gres', e.target.value)}>
                {gpuTypes.map((t) => (
                  <option key={t.gresName} value={t.gresName}>
                    {t.modelLabel}
                    {nominalVram(t.gresName) ? ` (${nominalVram(t.gresName)})` : ''} — {t.potentiallyFree} free /{' '}
                    {t.configured}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid-4">
            <Field label="GPUs" field="gpuCount" issues={issues} help={`Max ${maxGpus} on one node`}>
              <input
                id="w-gpuCount"
                type="number"
                min={1}
                max={maxGpus}
                value={draft.gpuCount}
                onChange={(e) => set('gpuCount', Number(e.target.value))}
              />
            </Field>
            <Field label="CPUs" field="cpus" issues={issues}>
              <input
                id="w-cpus"
                type="number"
                min={1}
                value={draft.cpus}
                onChange={(e) => set('cpus', Number(e.target.value))}
              />
            </Field>
            <Field label="RAM (GB)" field="memoryMib" issues={issues}>
              <input
                id="w-memoryMib"
                type="number"
                min={1}
                value={draft.memoryGb}
                onChange={(e) => set('memoryGb', Number(e.target.value))}
              />
            </Field>
            <Field label="Wall time" field="timeLimitSeconds" issues={issues}>
              <div className="input-row" id="w-timeLimitSeconds">
                <input
                  aria-label="Hours"
                  type="number"
                  min={0}
                  value={draft.hours}
                  onChange={(e) => set('hours', Number(e.target.value))}
                />
                <span className="muted">h</span>
                <input
                  aria-label="Minutes"
                  type="number"
                  min={0}
                  max={59}
                  value={draft.minutes}
                  onChange={(e) => set('minutes', Number(e.target.value))}
                />
                <span className="muted">m</span>
              </div>
            </Field>
          </div>
          {issues.some((i) => !i.field) && (
            <Notice tone="bad">
              {issues
                .filter((i) => !i.field)
                .map((i) => i.message)
                .join(' ')}
            </Notice>
          )}
          <div className="actions">
            <div className="input-row">
              <label className="sr-only" htmlFor="preset-label">
                Preset name
              </label>
              <input
                id="preset-label"
                placeholder="Preset name"
                value={presetLabel}
                onChange={(e) => setPresetLabel(e.target.value)}
              />
              <button
                type="button"
                className="btn ghost"
                disabled={!presetLabel.trim()}
                onClick={() =>
                  api
                    .savePreset(null, presetLabel.trim(), toConfig(effective, tcList))
                    .then(() => {
                      setPresetLabel('');
                      void qc.invalidateQueries({ queryKey: ['presets'] });
                    })
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Save as preset
              </button>
            </div>
            <span className="spacer" />
            <button type="submit" className="btn primary" disabled={phase !== 'DRAFT' || !gres}>
              {phase === 'VALIDATING' ? 'Checking…' : 'Review workflow'}
            </button>
          </div>
        </form>
      ) : (
        <section className="card" aria-labelledby="wf-review-title">
          <h2 id="wf-review-title">Review the exact batch script</h2>
          <p className="muted small">
            This is byte for byte what goes to <code>sbatch</code> (checksum <code>{preview.checksum}</code>), submitted
            once.
          </p>
          <dl className="kv">
            <dt>Run folder</dt>
            <dd className="mono">{preview.runDirPattern}</dd>
            <dt>Logs</dt>
            <dd className="mono">{preview.logPattern}</dd>
            <dt>Scratch (inside the job only)</dt>
            <dd className="mono">{preview.scratchPattern}</dd>
            <dt>Wall time</dt>
            <dd>{preview.timeLimit}</dd>
          </dl>
          <details>
            <summary>Checks on ICF right before sbatch ({preview.prechecks.length})</summary>
            <ul className="small mono">
              {preview.prechecks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </details>
          <pre className="code script" aria-label="Batch script">
            {preview.script}
          </pre>
          {preview.warnings.map((w, i) => (
            <Notice key={i} tone="warn">
              {w.message}
            </Notice>
          ))}
          {preview.acknowledgements.length > 0 && (
            <div className="acks">
              <ul>
                {preview.acknowledgements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand these
                notices
              </label>
            </div>
          )}
          <div className="actions">
            <button
              className="btn"
              onClick={() => {
                setPreview(null);
                setPhase('DRAFT');
              }}
            >
              Back to edit
            </button>
            <button
              className="btn primary"
              onClick={() => setConfirming(true)}
              disabled={preview.acknowledgements.length > 0 && !ack}
            >
              Submit workflow…
            </button>
          </div>
        </section>
      )}

      {confirming && preview && (
        <Dialog title="Submit this workflow to SLURM?" onClose={() => phase !== 'SUBMITTING' && setConfirming(false)}>
          <p>
            Queues one real job <strong>{effective.jobName}</strong> on <strong>{effective.partition}</strong>{' '}
            requesting {effective.gpuCount} × {gres}, {effective.cpus} CPUs, {effective.memoryGb} GB RAM for{' '}
            {preview.timeLimit}. It is submitted exactly once and keeps running if you close this app.
          </p>
          <div className="actions">
            <button
              className="btn"
              onClick={() => setConfirming(false)}
              disabled={phase === 'SUBMITTING'}
              data-autofocus
            >
              Cancel
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={phase === 'SUBMITTING'}>
              {phase === 'SUBMITTING' ? 'Submitting…' : 'Submit to SLURM'}
            </button>
          </div>
        </Dialog>
      )}
      {picker && (
        <PickRemote
          status={status}
          start={picker.start}
          kind={picker.kind}
          title={picker.title}
          filter={
            picker.archives
              ? (e) => /\.(tar\.gz|tgz|tar\.zst|tar\.zstd|tzst|tar|tar\.xz|tar\.bz2|zip)$/i.test(e.name)
              : undefined
          }
          onPick={(p) => {
            picker.onPick(p);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
