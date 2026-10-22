// The only bridge to the Rust backend. No command here accepts shell text or URLs; V3 remote paths
// are typed values that Rust validates and ICF re-resolves inside the home directory.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppError,
  EnvReport,
  FolderPick,
  ImportResult,
  LaunchResult,
  Listing,
  LocalPick,
  MetricsResponse,
  Prefs,
  Preset,
  ProjectPrefs,
  ProjectRecord,
  RunsResponse,
  SettingsPreview,
  ToolchainProfile,
  Transfer,
  VsCodeStatus,
  WorkflowConfig,
  WorkflowPreview,
  WorkflowRun,
  CancelOutcome,
  Challenge,
  JobDetailResponse,
  JobReceipt,
  JobRequest,
  JobsResponse,
  LogChunk,
  PreviewResponse,
  SubmitResponse,
  ConnectionProfile,
  ConnectionStatus,
  ComputeNode,
  LoginRequest,
  ProfileInput,
  Settings,
  SnapshotResponse,
  SshConfigReport,
  FileContent,
  FileSaved,
  SharePreview,
  ShareStatus,
} from '../types';

export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  return 'Unexpected error. Details were not shown to avoid leaking sensitive data.';
}

export const api = {
  profiles: () => invoke<ConnectionProfile[]>('connection_profiles_list'),
  saveProfile: (profile: ProfileInput) => invoke<ConnectionProfile>('connection_profile_save', { profile }),
  inspectSshConfig: (profileId: string) => invoke<SshConfigReport>('connection_inspect_ssh_config', { profileId }),
  status: () => invoke<ConnectionStatus>('connection_status'),
  login: (request: LoginRequest) => invoke<ConnectionStatus>('connection_test_and_login', { request }),
  cancel: () => invoke<null>('connection_cancel'),
  answerChallenge: (id: string, accept: boolean, response?: string) =>
    invoke<null>('connection_answer_challenge', { id, accept, response: response ?? null }),
  disconnect: () => invoke<ConnectionStatus>('connection_disconnect'),
  forgetCredentials: (profileId: string) =>
    invoke<ConnectionProfile>('connection_forget_credentials', { profileId, confirm: true }),
  openDemo: () => invoke<ConnectionStatus>('connection_open_demo'),
  snapshot: (forceRefresh: boolean) => invoke<SnapshotResponse>('cluster_get_snapshot', { forceRefresh }),
  nodeDetail: (nodeId: string) => invoke<ComputeNode>('cluster_get_node_detail', { nodeId }),
  clearCache: () => invoke<null>('cluster_clear_cache'),
  settings: () => invoke<Settings>('settings_get'),
  setPollInterval: (seconds: number) => invoke<Settings>('settings_set_poll_interval', { seconds }),
  // V2 jobs. Only jobsSubmit and jobsCancel change cluster state (separate Tauri capability).
  jobsPreview: (request: JobRequest) => invoke<PreviewResponse>('jobs_preview', { request }),
  jobsSubmit: (previewId: string, acknowledged: boolean, clientRequestId: string) =>
    invoke<SubmitResponse>('jobs_submit', { previewId, acknowledged, clientRequestId }),
  jobsList: (forceRefresh: boolean, includeHistory: boolean) =>
    invoke<JobsResponse>('jobs_list_mine', { forceRefresh, includeHistory }),
  jobDetail: (jobId: string) => invoke<JobDetailResponse>('jobs_get_detail', { jobId }),
  jobLog: (jobId: string, stream: 'stdout' | 'stderr', offset: number | null) =>
    invoke<LogChunk>('jobs_get_log_tail', { jobId, stream, offset }),
  jobsCancel: (jobId: string, cancelToken: string) => invoke<CancelOutcome>('jobs_cancel', { jobId, cancelToken }),
  jobsReceipts: () => invoke<JobReceipt[]>('jobs_receipts'),
  jobsReconcile: (tag: string) => invoke<JobReceipt>('jobs_reconcile', { tag }),
  jobsDismissReceipt: (tag: string) => invoke<null>('jobs_dismiss_receipt', { tag }),
  openExternal: (target: 'icf_status' | 'icf_tutorial' | 'vscode_remote_ssh') =>
    invoke<null>('open_external', { target }),
  // V3. Remote paths are validated and re-resolved in Rust/on ICF; local paths come only from
  // backend-owned native dialogs (the UI holds opaque tokens).
  projectsRecent: () => invoke<ProjectRecord[]>('projects_recent'),
  browse: (path: string | null) => invoke<Listing>('projects_browse', { path }),
  mkdir: (parent: string, name: string) => invoke<string>('projects_mkdir', { parent, name }),
  openProject: (path: string) => invoke<ProjectRecord>('projects_open', { path }),
  setProjectPrefs: (path: string, prefs: ProjectPrefs) => invoke<ProjectRecord>('projects_set_prefs', { path, prefs }),
  forgetProject: (path: string | null) => invoke<null>('projects_forget', { path }),
  pythonDiscover: (project: string, extra: string | null) => invoke<EnvReport>('python_discover', { project, extra }),
  vscodeShareStatus: () => invoke<ShareStatus>('vscode_share_status'),
  vscodeSharePreview: () => invoke<SharePreview>('vscode_share_preview'),
  vscodeShareApply: (previewId: string) => invoke<ShareStatus>('vscode_share_apply', { previewId }),
  vscodeShareDisable: () => invoke<ShareStatus>('vscode_share_disable'),
  filesRead: (path: string) => invoke<FileContent>('files_read', { path }),
  filesCreate: (dir: string, name: string, content: string) =>
    invoke<FileSaved>('files_create', { dir, name, content }),
  filesWrite: (path: string, content: string, expectedSha256: string) =>
    invoke<FileSaved>('files_write', { path, content, expectedSha256 }),
  pythonCheckImports: (interpreter: string, modules: string[]) =>
    invoke<ImportResult[]>('python_check_imports', { interpreter, modules }),
  toolchains: () => invoke<ToolchainProfile[]>('toolchains_list'),
  saveToolchain: (profile: ToolchainProfile) => invoke<ToolchainProfile[]>('toolchains_save', { profile }),
  deleteToolchain: (id: string) => invoke<ToolchainProfile[]>('toolchains_delete', { id }),
  presets: () => invoke<Preset[]>('presets_list'),
  savePreset: (id: string | null, label: string, config: WorkflowConfig) =>
    invoke<Preset[]>('presets_save', { id, label, config }),
  deletePreset: (id: string) => invoke<Preset[]>('presets_delete', { id }),
  prefs: () => invoke<Prefs>('prefs_get'),
  setPrefs: (prefs: Prefs) => invoke<Prefs>('prefs_set', { prefs }),
  vscodeStatus: (refresh: boolean) => invoke<VsCodeStatus>('vscode_status', { refresh }),
  vscodeOpen: (path: string) => invoke<LaunchResult>('vscode_open', { path }),
  vscodeSettingsPreview: (project: string, interpreter: string) =>
    invoke<SettingsPreview>('vscode_settings_preview', { project, interpreter }),
  vscodeSettingsApply: (previewId: string) =>
    invoke<{ file: string; backup: string | null }>('vscode_settings_apply', { previewId }),
  transfers: () => invoke<Transfer[]>('transfers_list'),
  pickFile: () => invoke<LocalPick | null>('transfers_pick_file'),
  pickFolder: () => invoke<FolderPick | null>('transfers_pick_folder'),
  packFolder: (token: string) => invoke<LocalPick>('transfers_pack_folder', { token }),
  upload: (token: string, remoteDir: string, name: string) =>
    invoke<Transfer>('transfers_upload', { token, remoteDir, name }),
  download: (remotePath: string) => invoke<Transfer | null>('transfers_download', { remotePath }),
  cancelTransfer: (id: string) => invoke<null>('transfers_cancel', { id }),
  retryTransfer: (id: string) => invoke<Transfer>('transfers_retry', { id }),
  discardTransfer: (id: string) => invoke<null>('transfers_discard', { id }),
  workflowPreview: (config: WorkflowConfig) => invoke<WorkflowPreview>('workflow_preview', { config }),
  workflowRuns: () => invoke<WorkflowRun[]>('workflow_runs'),
  workflowRefresh: (force: boolean) => invoke<RunsResponse>('workflow_refresh', { force }),
  workflowDismiss: (tag: string) => invoke<null>('workflow_dismiss', { tag }),
  workflowReconcile: (tag: string) => invoke<WorkflowRun>('workflow_reconcile', { tag }),
  workflowFiles: (tag: string, which: '' | 'outputs' | '.outputs.partial' | 'checkpoints') =>
    invoke<Listing>('workflow_list_files', { tag, which }),
  workflowMetrics: (tag: string) => invoke<MetricsResponse>('workflow_metrics', { tag }),
};

export const events = {
  onStatus: (cb: (s: ConnectionStatus) => void): Promise<UnlistenFn> =>
    listen<ConnectionStatus>('connection-status', (e) => cb(e.payload)),
  onChallenge: (cb: (c: Challenge) => void): Promise<UnlistenFn> =>
    listen<Challenge>('auth-challenge', (e) => cb(e.payload)),
  onChallengeClosed: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>('auth-challenge-closed', (e) => cb(e.payload)),
};
