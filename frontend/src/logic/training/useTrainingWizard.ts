import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { maxGpusFor } from '../cluster/gpu';
import { usePersistentState } from '../persist';
import { safeName } from '../transfers/transfers';
import {
  autoJobName,
  carryTo,
  modeFor,
  replaceableName,
  runChoiceOf,
  splitPath,
  type JobMode,
  type RunChoice,
} from '../jobs/newJob';
import { handOver, usePresets } from '../jobs/presets';
import { useProjectEnv } from '../jobs/projectEnv';
import type {
  ClusterSnapshot,
  ConnectionStatus,
  ImportResult,
  Issue,
  SubmitResponse,
  Transfer,
  WorkflowPreview,
  WorkflowState,
} from '../../types';
import {
  CHECK_MODULES,
  DEFAULT_DRAFT,
  expandHome,
  fromConfig,
  initialDraft,
  pickedDatasetName,
  SMOKE_DEFAULTS,
  SMOKE_NAME,
  toConfig,
  uploadedDatasetName,
  type Draft,
  type WizardInit,
} from './wizardDraft';

/**
 * The training workflow form: saved draft, resources against the snapshot, review (preview), the single
 * submit, the login-node environment check, uploading a dataset archive, presets.
 * Phases: DRAFT → (UPLOADING) → VALIDATING → READY → SUBMITTING → DRAFT with a result.
 */
export function useTrainingWizard(
  status: ConnectionStatus,
  snapshot: ClusterSnapshot | null,
  init: WizardInit | null,
  onSwitch: (m: JobMode) => void,
) {
  const qc = useQueryClient();
  const toolchains = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const [stored, setStored] = usePersistentState<Draft>('workflow.draft', DEFAULT_DRAFT);
  const [draft, setDraftState] = useState<Draft>(() => initialDraft(stored, init, toolchains.data ?? []));
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
  const [upload, setUpload] = useState<Transfer | null>(null);
  const [envCheck, setEnvCheck] = useState<{ interpreter: string; results?: ImportResult[]; error?: string } | null>(
    null,
  );
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
        const into = uploadedDatasetName(t.name);
        setDraft({ ...draft, datasets: [...draft.datasets, { archive: t.remotePath, into }] });
        setPhase('DRAFT');
      } else if (t && ['failed', 'cancelled', 'interrupted'].includes(t.phase)) {
        setError(`Upload ${t.phase}: ${t.message ?? ''} You can resume it in Transfers.`);
        setPhase('DRAFT');
      }
      return t;
    },
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => patch({ [k]: v } as Partial<Draft>);
  const patch = (p: Partial<Draft>) => {
    setDraft({ ...draft, ...p });
    setPreview(null);
    setResult(null);
    if (phase === 'READY') setPhase('DRAFT');
  };

  const partition = snapshot
    ? (snapshot.partitions.find((p) => p.name === draft.partition) ??
      snapshot.partitions.find((p) => p.isDefault) ??
      snapshot.partitions[0])
    : undefined;
  const gpuTypes = partition?.gpuTotals ?? [];
  const gres = gpuTypes.some((t) => t.gresName === draft.gres) ? draft.gres : (gpuTypes[0]?.gresName ?? '');
  const effective: Draft = { ...draft, partition: partition?.name ?? '', gres };
  const tcList = toolchains.data ?? [];
  const home = status.capabilities?.home ?? '';
  const project = expandHome(effective.projectDir, home).replace(/\/+$/, '');
  // ADR-037: the project's interpreter and toolchain, when the form has none yet.
  const projectEnv = useProjectEnv(status, project, home, effective.interpreter, (e) =>
    patch({ interpreter: e.interpreter, ...(e.toolchainId ? { toolchainId: e.toolchainId } : {}) }),
  );
  const maxGpus = snapshot ? maxGpusFor(snapshot, partition, gres) : 1;

  const review = async () => {
    setPhase('VALIDATING');
    setError(null);
    setAck(false);
    try {
      const p = await api.workflowPreview(toConfig(effective, tcList, home));
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
  const backToEdit = () => {
    setPreview(null);
    setPhase('DRAFT');
  };
  const reconcile = (tag: string) =>
    api
      .workflowReconcile(tag)
      .then((r) => setReconcileMsg(r.submissionMessage ?? r.submission))
      .catch((e) => setReconcileMsg(errorMessage(e)));
  /** Where the accepted run writes its results: next to the code. */
  const resultsRoot = `${project}/runs`;

  const interpreter = expandHome(draft.interpreter, home);
  const checkModules = draft.checkModules || CHECK_MODULES[draft.kind];
  const checkEnv = async () => {
    setEnvCheck({ interpreter });
    try {
      const modules = checkModules.split(/[\s,]+/).filter(Boolean);
      setEnvCheck({ interpreter, results: await api.pythonCheckImports(interpreter, modules) });
    } catch (err) {
      setEnvCheck({ interpreter, error: errorMessage(err) });
    }
  };
  const checking = !!envCheck && !envCheck.results && !envCheck.error;

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

  const setDataset = (i: number, patch: Partial<Draft['datasets'][number]>) =>
    set(
      'datasets',
      draft.datasets.map((x, j) => (j === i ? { ...x, ...patch } : x)),
    );
  const removeDataset = (i: number) =>
    set(
      'datasets',
      draft.datasets.filter((_, j) => j !== i),
    );
  const addDataset = (path: string) =>
    set('datasets', [...draft.datasets, { archive: path, into: pickedDatasetName(path) }]);

  const presets = usePresets(
    status,
    () => ({
      config: toConfig(effective, tcList, home),
      job: { choice: draft.kind === 'notebook' ? 'notebook' : draft.kind === 'gpu_smoke_test' ? 'smoke' : 'managed' },
    }),
    (p) => {
      // A preset of a job type the script form runs (Python, Shell, Commands, GPU session): that form loads it.
      if (p.job && modeFor(...runChoiceOf(p.job.choice)) === 'script') {
        handOver(p.id);
        return onSwitch('script');
      }
      setDraft(fromConfig(p.config, tcList));
      setPreview(null);
    },
  );

  /** The script or notebook as an absolute path ('' when none is chosen). */
  const entryAbs = !draft.entry.trim()
    ? ''
    : draft.entry.startsWith('/')
      ? expandHome(draft.entry, home)
      : `${project}/${draft.entry}`;
  /**
   * A script or notebook picked on ICF: its folder becomes the project folder (results go there too),
   * and a notebook runs as a notebook whatever was chosen before.
   */
  const pickEntry = (path: string) => {
    const { dir, name } = splitPath(path);
    const kind = /\.ipynb$/i.test(name) ? 'notebook' : draft.kind === 'notebook' ? 'train' : draft.kind;
    patch({
      projectDir: dir,
      entry: name,
      kind,
      ...(replaceableName(draft.jobName, draft.entry) ? { jobName: autoJobName(name) } : {}),
    });
  };
  /** Run from a folder above the file's own (e.g. the project root): the file path becomes relative. */
  const runFrom = (dir: string) =>
    patch(
      entryAbs.startsWith(`${dir}/`) ? { projectDir: dir, entry: entryAbs.slice(dir.length + 1) } : { projectDir: dir },
    );
  /** A virtualenv or conda environment folder: its Python runs the job. */
  const pickEnv = (dir: string) => set('interpreter', `${dir.replace(/\/+$/, '')}/bin/python`);

  /** "What do you want to run?": a workflow type here, or the script job form. */
  const choice: RunChoice =
    draft.kind === 'notebook' ? 'notebook' : draft.kind === 'gpu_smoke_test' ? 'smoke' : 'python';
  const choose = (c: RunChoice, managed: boolean, onSwitch: (m: JobMode) => void) => {
    const mode = modeFor(c, managed);
    if (mode === 'workflow') {
      const kind = c === 'notebook' ? 'notebook' : c === 'smoke' ? 'gpu_smoke_test' : 'train';
      setDraft({
        ...draft,
        kind,
        ...(kind === 'gpu_smoke_test'
          ? { ...SMOKE_DEFAULTS, ...(replaceableName(draft.jobName, draft.entry) ? { jobName: SMOKE_NAME } : {}) }
          : {}),
        ...(kind === 'notebook' && !/\.ipynb$/i.test(draft.entry) ? { entry: '' } : {}),
      });
      setPreview(null);
      return;
    }
    const d = effective;
    carryTo(mode, c, { ...d, folder: d.projectDir, file: d.entry, python: d.interpreter }, home);
    onSwitch(mode);
  };

  return {
    draft,
    set,
    patch,
    projectEnv,
    choice,
    choose,
    pickEntry,
    entryAbs,
    runFrom,
    pickEnv,
    presets,
    tcList,
    home,
    project,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
    preview,
    issues,
    phase,
    error,
    ack,
    setAck,
    confirming,
    setConfirming,
    result,
    setResult,
    reconcileMsg,
    upload,
    envCheck,
    interpreter,
    checkModules,
    checking,
    review,
    submit,
    backToEdit,
    reconcile,
    resultsRoot,
    checkEnv,
    uploadArchive,
    setDataset,
    removeDataset,
    addDataset,
  };
}
