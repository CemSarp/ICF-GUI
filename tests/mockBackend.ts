// In-memory stand-in for the Tauri backend used by UI tests. Never talks to SSH.
import demoSnapshot from '../fixtures/slurm/demo_snapshot.json';
import type { ClusterSnapshot, ConnectionProfile, ConnectionStatus, SnapshotResponse } from '../src/types';

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
      ...overrides,
    };
  },
};
