// The only bridge to the Rust backend. No command here accepts shell text, remote paths or URLs.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppError,
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
};

export const events = {
  onStatus: (cb: (s: ConnectionStatus) => void): Promise<UnlistenFn> =>
    listen<ConnectionStatus>('connection-status', (e) => cb(e.payload)),
  onChallenge: (cb: (c: Challenge) => void): Promise<UnlistenFn> =>
    listen<Challenge>('auth-challenge', (e) => cb(e.payload)),
  onChallengeClosed: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>('auth-challenge-closed', (e) => cb(e.payload)),
};
