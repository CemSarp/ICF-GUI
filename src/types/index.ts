// Mirrors the Rust models in src-tauri/src (serde camelCase). Keep in sync by hand.

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

// ---- V2 jobs (mirrors src-tauri/src/jobs) ----

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

export type Runner = 'python' | 'bash';

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
