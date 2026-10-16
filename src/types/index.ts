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

// ---- V2 (typed only; no commands exist in V1, and the V1 capability grants no mutation) ----

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
  | 'unknown';

export interface JobRef {
  cluster: string;
  profileId: string;
  owner: string;
  /** Validated string: preserves possible scheduler suffixes. */
  jobId: string;
  name: string;
  partition: string;
  resources: string;
  state: JobState;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: string;
  stdoutPath?: string;
  stderrPath?: string;
  lastUpdatedAt: string;
}
