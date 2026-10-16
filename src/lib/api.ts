// The only bridge to the Rust backend. No command here accepts shell text, remote paths or URLs.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppError,
  Challenge,
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
