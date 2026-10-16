// Dev-only browser preview of the UI (pnpm dev, then /dev/preview.html). Never talks to SSH.
import demo from '../fixtures/slurm/demo_snapshot.json';

const callbacks = new Map<number, (e: unknown) => void>();
let next = 1;
let state = new URLSearchParams(location.search).get('state') ?? 'login';
const status = () => ({
  state: state === 'login' ? 'disconnected' : 'connected',
  profileId: null,
  demo: state !== 'login',
  capabilities: null,
  hops: [],
  connectedAt: '2026-10-16T14:00:00Z',
  error: null,
  failedAttempts: 0,
  lockedUntil: null,
});
const emit = (event: string, payload: unknown) =>
  callbacks.forEach((cb, id) => (cb as { event?: string } & typeof cb).event === event && cb({ event, id, payload }));

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
