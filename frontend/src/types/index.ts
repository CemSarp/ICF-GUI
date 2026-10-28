// Mirrors the Rust models in backend/src (serde camelCase). Keep in sync by hand.

export type ErrorCode =
  | 'SSH_AUTH'
  | 'SSH_HOST_KEY'
  | 'SSH_TIMEOUT'
  | 'SSH_NETWORK'
  | 'SSH_CANCELLED'
  | 'SSH_UNAVAILABLE'
  | 'SLURM_UNAVAILABLE'
  | 'SLURM_PERMISSION'
  | 'SLURM_ERROR'
  | 'INVALID_INPUT'
  | 'INVALID_PATH'
  | 'NOT_CONNECTED'
  | 'AUTH_LOCKED'
  | 'KEYCHAIN'
  | 'OUTPUT_TOO_LARGE'
  | 'NO_RESOURCE'
  | 'JOB_SUBMIT_UNCERTAIN'
  | 'CONFLICT'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type AuthMode = 'agent' | 'password';

export interface HostKeyDecision {
  host: string;
  fingerprint: string;
  accepted: boolean;
  decidedAt: string;
}

export interface ConnectionProfile {
  id: string;
  label: string;
  sshAlias: string;
  username: string;
  jumpHost: string;
  authMode: AuthMode;
  savedCredentials: string[];
  lastSuccessAt: string | null;
  hostKeyDecisions: HostKeyDecision[];
}

export interface Hop {
  alias: string;
  user: string;
  hostname: string;
  port: number;
}

export interface Capabilities {
  remoteUser: string;
  remoteHost: string;
  /** Remote $HOME; used to show `~/…` paths resolved. */
  home: string;
  commands: string[];
  missingCommands: string[];
  slurmVersion: string | null;
  jsonSupported: boolean;
}

export type ConnState =
  'disconnected' | 'connecting' | 'auth_required' | 'connected' | 'degraded' | 'offline' | 'auth_failed';

export interface ConnectionStatus {
  state: ConnState;
  profileId: string | null;
  demo: boolean;
  capabilities: Capabilities | null;
  hops: Hop[];
  connectedAt: string | null;
  error: AppError | null;
  failedAttempts: number;
  lockedUntil: string | null;
}

export type ChallengeKind = 'password' | 'host_key' | 'other';

export interface Challenge {
  id: string;
  kind: ChallengeKind;
  hopLabel: string | null;
  user: string | null;
  host: string | null;
  keyType: string | null;
  fingerprint: string | null;
  text: string;
  secretInput: boolean;
  note: string | null;
}

export interface SshConfigReport {
  sshPath: string;
  sshVersion: string;
  hops: Hop[];
  usesProxyCommand: boolean;
  userConfigFound: boolean;
}

export type NodeState = 'idle' | 'mixed' | 'allocated' | 'down' | 'drain' | 'unknown';
export type Granularity = 'physical' | 'mig' | 'unknown';
export type Confidence = 'exact' | 'estimated' | 'unknown';

export interface GpuResource {
  gresName: string;
  modelLabel: string;
  granularity: Granularity;
  configured: number | null;
  allocated: number | null;
  potentiallyFree: number | null;
  unavailable: number;
  confidence: Confidence;
  raw: string;
}

export interface ComputeNode {
  id: string;
  partitions: string[];
  state: NodeState;
  stateRaw: string;
  reason: string | null;
  resources: GpuResource[];
  cpuTotal: number | null;
  cpuAllocated: number | null;
  memoryMb: number | null;
  memoryAllocatedMb: number | null;
  sourceTimestamp: string;
  warnings: string[];
  raw: [string, string][];
}

export interface GpuTotals {
  gresName: string;
  modelLabel: string;
  granularity: Granularity | null;
  nodes: number;
  configured: number;
  allocated: number;
  potentiallyFree: number;
  unavailable: number;
  unknown: number;
}

export interface Partition {
  name: string;
  isDefault: boolean;
  state: 'up' | 'down' | 'unknown';
  stateRaw: string;
  maxTimeSeconds: number | null;
  maxTimeRaw: string;
  maxCpusPerNode: number | null;
  maxMemPerNodeMb: number | null;
  nodeIds: string[];
  eligibility: 'confirmed' | 'not_permitted' | 'unknown';
  gpuTotals: GpuTotals[];
  warnings: string[];
}

export interface ClusterSnapshot {
  clusterName: string;
  source: 'live' | 'demo';
  fetchedAt: string;
  fetchedAtMs: number;
  stale: boolean;
  partial: boolean;
  permissionScope: string;
  partitions: Partition[];
  nodesById: Record<string, ComputeNode>;
  gpuTotals: GpuTotals[];
  warnings: string[];
}

export interface SnapshotResponse {
  snapshot: ClusterSnapshot | null;
  lastError: AppError | null;
  lastAttemptAt: string | null;
  nextAllowedAt: string | null;
  fetched: boolean;
  inventoryRequests: number;
}

export interface Settings {
  pollIntervalSecs: number;
}

export interface LoginRequest {
  profileId: string;
  username?: string;
  authMode?: AuthMode;
  password?: string;
  gatewayPassword?: string;
  sameForBoth?: boolean;
  remember?: boolean;
  useSaved?: boolean;
}

export interface ProfileInput {
  id: string;
  label: string;
  sshAlias: string;
  username: string;
  jumpHost: string;
  authMode: AuthMode;
}

// ---- V2 jobs (mirrors backend/src/jobs) ----

export type JobState =
  | 'pending'
  | 'configuring'
  | 'running'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'node_fail'
  | 'out_of_memory'
  | 'requeued'
  | 'suspended'
  | 'preempted'
  | 'unknown';

export interface JobRow {
  /** Validated string; preserves array suffixes. */
  jobId: string;
  user: string;
  name: string;
  partition: string;
  state: JobState;
  stateRaw: string;
  gpus: string | null;
  cpus: number | null;
  memory: string | null;
  /** Cluster-local times as reported by SLURM. */
  submittedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsed: string | null;
  timeLeft: string | null;
  timeLimit: string | null;
  nodes: string | null;
  reason: string | null;
  exitCode: string | null;
  comment: string | null;
  source: 'squeue' | 'sacct' | 'scontrol';
}

export interface JobsList {
  active: JobRow[];
  history: JobRow[] | null;
  historyNote: string | null;
  fetchedAt: string;
  fetchedAtMs: number;
  historyFetchedAt: string | null;
  foreignRowsDropped: number;
}

export interface JobsResponse {
  list: JobsList | null;
  lastError: AppError | null;
  stale: boolean;
  fetched: boolean;
  requests: number;
}

/** `commands`: the user's own shell lines, run in the working directory (ADR-034). */
export type Runner = 'python' | 'bash' | 'commands' | 'session';

export interface JobRequest {
  partition: string;
  gresType: string | null;
  gpuCount: number;
  cpus: number;
  memoryMib: number;
  timeLimitSeconds: number;
  jobName: string;
  workingDir: string;
  runner: Runner;
  program: string;
  programArgs: string[];
  pythonEnv: string | null;
  setupSource: string | null;
  /** SLURM e-mails this address when the job ends or fails. */
  mailUser: string | null;
  /** Shell lines for runner `commands`; setup lines for `session`; null otherwise. */
  commands: string | null;
  /** Runner `session` only: it ends after this many minutes without a command block (5–240). */
  sessionIdleMinutes?: number | null;
}

export interface Issue {
  field: string | null;
  message: string;
}

export interface PreviewResponse {
  previewId: string | null;
  script: string;
  checksum: string;
  errors: Issue[];
  warnings: Issue[];
  acknowledgements: string[];
  snapshotAt: string | null;
  timeLimit: string;
  stdoutPattern: string;
  stderrPattern: string;
  home: string;
}

export type ReceiptStatus = 'submitting' | 'accepted' | 'rejected' | 'uncertain' | 'not_found';

export interface JobReceipt {
  tag: string;
  profileId: string;
  user: string;
  jobId: string | null;
  cluster: string | null;
  status: ReceiptStatus;
  name: string;
  partition: string;
  gres: string;
  gpuCount: number;
  submittedAt: string;
  checksum: string;
  stdoutPattern: string;
  stderrPattern: string;
  message: string | null;
  /** SLURM refused this partition for the account. */
  accessDenied: boolean;
  /** Hidden from the list; still counts for what was learned about the partition. */
  dismissed: boolean;
  /** The reviewed script-job request (absent for workflows and receipts before 0.5.1). */
  request?: JobRequest | null;
}

export type SubmitOutcome =
  | { outcome: 'accepted'; jobId: string; cluster: string | null }
  | { outcome: 'rejected'; code: ErrorCode; message: string }
  | { outcome: 'uncertain'; message: string };

export type SubmitResponse = SubmitOutcome & { receipt: JobReceipt };

export type CancelOutcome =
  | { outcome: 'requested' }
  | { outcome: 'refused'; code: ErrorCode; message: string }
  | { outcome: 'uncertain'; message: string };

export interface JobDetailResponse {
  job: JobRow;
  fields: [string, string][];
  stdoutPath: string | null;
  stderrPath: string | null;
  stderrMerged: boolean;
  logPathNote: string | null;
  cancelToken: string | null;
  receipt: JobReceipt | null;
  fetchedAt: string;
}

export interface LogChunk {
  path: string;
  size: number;
  from: number;
  next: number;
  rotated: boolean;
  text: string;
}

// ---- V3 projects, VS Code, environments, transfers, workflows (mirrors backend/src) ----

export type EntryKind = 'dir' | 'file' | 'symlink' | 'other' | 'missing';

export interface Entry {
  name: string;
  kind: EntryKind;
  targetKind: EntryKind | null;
  size: number;
  modified: number | null;
  mode: string;
  mine: boolean;
  unsupported: boolean;
}

/** VS Code reuses the app's signed-in connection (ADR-028). */
export interface ShareStatus {
  enabled: boolean;
  alias: string | null;
  active: boolean;
  inUse: boolean;
  configFile: string;
  settingsFile: string;
}

export interface SharePreview {
  previewId: string | null;
  alias: string;
  settingsFile: string;
  settingsBefore: string | null;
  settingsAfter: string | null;
  configFile: string;
  configText: string;
  problem: string | null;
  manualSnippet: string;
}

/** One text file opened in the in-app editor (`files_read`). */
export interface FileContent {
  path: string;
  content: string;
  sha256: string;
  size: number;
  writable: boolean;
}

export interface FileSaved {
  path: string;
  sha256: string;
}

export interface Listing {
  path: string;
  home: string;
  writable: boolean;
  entries: Entry[];
  truncated: boolean;
  fetchedAt: string;
}

export interface InterpreterSummary {
  version: string | null;
  envType: string;
  torch: string | null;
  torchCuda: string | null;
  ok: boolean;
  checkedAt: string;
}

export interface ProjectRecord {
  profileId: string;
  user: string;
  path: string;
  lastOpenedAt: string;
  interpreter: string | null;
  interpreterInfo: InterpreterSummary | null;
  toolchainId: string | null;
  partition: string | null;
  gresType: string | null;
}

/** Job logs in one icfcc-run folder; `old*` are those last changed more than the chosen days ago. */
export interface LogsSummary {
  files: number;
  bytes: number;
  oldFiles: number;
  oldBytes: number;
}

export interface ProjectPrefs {
  interpreter: string | null;
  toolchainId: string | null;
  partition: string | null;
  gresType: string | null;
}

export type InterpreterStatus = 'ok' | 'missing' | 'not_executable' | 'failed';

export interface Interpreter {
  path: string;
  status: InterpreterStatus;
  version: string | null;
  envType: string;
  hasActivate: boolean;
  torch: string | null;
  torchCuda: string | null;
  numpy: string | null;
  nbconvert: boolean;
  ipykernel: boolean;
}

export interface EnvReport {
  interpreters: Interpreter[];
  toolchains: { path: string; status: string }[];
  modulesAvailable: boolean;
  checkedAt: string;
}

export interface ImportResult {
  module: string;
  status: 'ok' | 'failed' | 'not_checked';
  /** Version when ok, the error's last line when failed, the reason when not checked. */
  detail: string;
}

export type Toolchain = { kind: 'none' } | { kind: 'rc'; path: string } | { kind: 'modules'; names: string[] };

export interface ToolchainProfile {
  id: string;
  label: string;
  spec: Toolchain;
  cuda: string | null;
  note: string | null;
}

export interface Prefs {
  transferLimitMbps: number;
}

export interface VsCodeInstall {
  appPath: string;
  cliPath: string;
  version: string | null;
  remoteSsh: string | null;
}

export interface VsCodeStatus {
  install: VsCodeInstall | null;
  alias: {
    alias: string;
    hostname: string;
    user: string;
    proxyJump: string | null;
    usesProxyCommand: boolean;
  };
  problems: string[];
  sshConfigSnippet: string | null;
  checkedAt: string;
}

export interface LaunchResult {
  remotePath: string;
  alias: string;
  message: string;
}

export interface SettingsPreview {
  previewId: string | null;
  project: string;
  file: string;
  exists: boolean;
  before: string | null;
  after: string | null;
  problem: string | null;
  manualSnippet: string;
}

export type TransferPhase =
  | 'queued'
  | 'checking'
  | 'hashing'
  | 'transferring'
  | 'verifying'
  | 'publishing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Transfer {
  id: string;
  profileId: string;
  user: string;
  direction: 'upload' | 'download';
  localPath: string;
  remotePath: string;
  name: string;
  size: number;
  doneBytes: number;
  phase: TransferPhase;
  message: string | null;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
  deleteLocalAfter: boolean;
}

export interface LocalPick {
  token: string;
  name: string;
  path: string;
  size: number;
  isArchive: boolean;
}

export interface FolderPick {
  token: string;
  name: string;
  path: string;
  files: number;
  bytes: number;
}

export type WorkflowKind = 'train' | 'notebook' | 'gpu_smoke_test';
export type HfCache =
  | { mode: 'off' }
  | { mode: 'scratch' }
  | { mode: 'home'; path: string }
  | { mode: 'staged'; archive: string; offline: boolean };
export type CheckpointMode = 'scratch_sync' | 'direct' | 'none';

export interface WorkflowConfig {
  kind: WorkflowKind;
  jobName: string;
  projectDir: string;
  entry: string;
  args: string[];
  interpreter: string;
  toolchain: Toolchain;
  datasets: { archive: string; into: string }[];
  scratchRoot: 'disk_scratch' | 'slurm_tmpdir';
  hfCache: HfCache;
  resultsRoot: string;
  checkpointMode: CheckpointMode;
  checkpointSyncMinutes: number;
  resumeFrom: string | null;
  env: { name: string; value: string }[];
  expectedOutputGib: number;
  signalGraceSeconds: number;
  resources: {
    partition: string;
    gresType: string | null;
    gpuCount: number;
    cpus: number;
    memoryMib: number;
    timeLimitSeconds: number;
  };
  /** SLURM e-mails this address when the job ends or fails. */
  mailUser: string | null;
}

export interface WorkflowPreview {
  previewId: string | null;
  script: string;
  checksum: string;
  errors: Issue[];
  warnings: Issue[];
  acknowledgements: string[];
  snapshotAt: string | null;
  timeLimit: string;
  runDirPattern: string;
  logPattern: string;
  scratchPattern: string;
  prechecks: string[];
}

/** One nbformat v4 output (stored in a notebook, or streamed live from a kernel). */
export interface NotebookOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Interactive Jupyter kernel on an Interactive partition (ADR-031). */
export interface KernelRequest {
  /** Notebook or runnable source file (.py .cu .cpp .cc .cxx .c); the kernel runs in its folder. */
  path: string;
  interpreter: string;
  toolchain: Toolchain;
  resources: WorkflowConfig['resources'];
}

export interface KernelPreview {
  previewId: string | null;
  /** The srun line as reviewed (heredoc bodies left out). */
  command: string;
  checksum: string;
  errors: Issue[];
  warnings: Issue[];
  acknowledgements: string[];
  snapshotAt: string | null;
  timeLimit: string;
  prechecks: string[];
}

export type KernelEvent =
  | { event: 'starting' }
  | { event: 'queued'; jobId: string }
  | { event: 'ready'; jobId: string; node: string; python: string; tools: string; endsAtMs: number }
  | { event: 'status'; busy: boolean }
  | { event: 'output'; id: string; output: NotebookOutput }
  | { event: 'clear'; id: string; wait: boolean }
  | { event: 'done'; id: string; count: number | null; status: 'ok' | 'error' | 'aborted' }
  | { event: 'restarted' }
  | { event: 'ended'; reason: string; message: string };

export interface Preset {
  id: string;
  label: string;
  profileId: string;
  user: string;
  config: WorkflowConfig;
  savedAt: string;
}

export type WorkflowState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'UPLOADING'
  | 'READY'
  | 'SUBMITTING'
  | 'PENDING'
  | 'ALLOCATED'
  | 'STAGING'
  | 'TRAINING'
  | 'SAVING_CHECKPOINTS'
  | 'COPYING_RESULTS'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'NODE_FAILURE'
  | 'RECOVERY_REQUIRED';

export type FailureKind =
  | 'authentication'
  | 'network'
  | 'scheduler_rejected'
  | 'invalid_resource'
  | 'missing_remote_file'
  | 'python_environment'
  | 'cuda_incompatible'
  | 'gpu_out_of_memory'
  | 'host_out_of_memory'
  | 'scratch_unavailable'
  | 'scratch_exhausted'
  | 'unsafe_archive'
  | 'corrupt_archive'
  | 'nfs_failure'
  | 'training_script'
  | 'timeout'
  | 'node_failure'
  | 'result_sync'
  | 'cancelled'
  | 'unknown';

export interface WorkflowEvent {
  at: string;
  name: string;
  args: string[];
}

export interface Observed {
  state: WorkflowState | null;
  failure: FailureKind | null;
  message: string | null;
  results: 'pending' | 'synced' | 'failed' | 'no_outputs' | 'unknown';
  lastCheckpointAt: string | null;
  checkpointSyncFailures: number;
  node: string | null;
  gpu: string | null;
  python: string | null;
  git: string | null;
  trainingExit: number | null;
  recoveryNote: string | null;
}

export interface WorkflowRun {
  tag: string;
  profileId: string;
  user: string;
  jobId: string | null;
  name: string;
  kind: WorkflowKind;
  config: WorkflowConfig;
  checksum: string;
  submittedAt: string;
  submission: ReceiptStatus;
  submissionMessage: string | null;
  schedulerState: JobState | null;
  observed: Observed;
  events: WorkflowEvent[];
  lastCheckedAt: string | null;
  finalized: boolean;
  dismissed: boolean;
}

export interface RunsResponse {
  runs: WorkflowRun[];
  fetched: boolean;
  lastError: AppError | null;
  fetchedAt: string | null;
}

export interface MetricPoint {
  step: number | null;
  epoch: number | null;
  values: [string, number][];
}

export interface MetricsResponse {
  points: MetricPoint[];
  path: string;
  note: string | null;
}
