import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon, Notice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { ConnectionStatus, Settings, SnapshotResponse, SshConfigReport, ToolchainProfile } from '../../types';
import { VsCodePanel } from '../projects/ProjectsView';

export type Theme = 'system' | 'light' | 'dark';
const POLL_CHOICES = [45, 60, 90, 120, 300, 600];

export function SettingsView({
  settings,
  onSettings,
  theme,
  setTheme,
  status,
  snapshot,
  onCacheCleared,
}: {
  settings: Settings;
  onSettings: (s: Settings) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  status: ConnectionStatus;
  snapshot: SnapshotResponse | undefined;
  onCacheCleared: () => void;
}) {
  const [report, setReport] = useState<SshConfigReport | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [redact, setRedact] = useState(true);
  const r = (s: string) => (redact && s ? s.replace(/./g, '•').slice(0, 8) : s);
  const caps = status.capabilities;

  return (
    <div className="settings">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <section className="card">
        <h2>Refresh</h2>
        <label className="field inline">
          <span>Automatic refresh every</span>
          <select
            value={settings.pollIntervalSecs}
            onChange={(e) =>
              api
                .setPollInterval(Number(e.target.value))
                .then(onSettings)
                .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }))
            }
          >
            {POLL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s < 120 ? `${s} seconds` : `${s / 60} minutes`}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Only while connected and the window is visible. Minimum 45 s; manual refresh is limited to once per 10 s and
          shares any in-flight request. One refresh = one SSH command running two read-only <code>scontrol show</code>{' '}
          queries.
        </p>
        <button
          className="btn"
          onClick={() =>
            api
              .clearCache()
              .then(() => {
                onCacheCleared();
                setMsg({ tone: 'ok', text: 'Cached snapshot cleared.' });
              })
              .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }))
          }
        >
          Clear cached snapshot
        </button>
      </section>

      <section className="card">
        <h2>Appearance</h2>
        <div className="field">
          <span id="theme-label">Theme</span>
          <div className="segmented choice" role="radiogroup" aria-labelledby="theme-label">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <label key={t}>
                <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
                {t[0]!.toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Diagnostics</h2>
        <label className="check">
          <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />
          Redact usernames
        </label>
        <dl className="kv">
          <dt>Connection</dt>
          <dd>{status.demo ? 'Demo (synthetic data)' : status.state}</dd>
          <dt>Remote identity</dt>
          <dd>{caps ? `${r(caps.remoteUser)} on ${caps.remoteHost}` : '—'}</dd>
          <dt>SLURM</dt>
          <dd>
            {caps?.slurmVersion ?? '—'}
            {caps && ` · JSON output ${caps.jsonSupported ? 'available (not used)' : 'not available'}`}
          </dd>
          {caps && caps.missingCommands.length > 0 && (
            <>
              <dt>Missing commands</dt>
              <dd>{caps.missingCommands.join(', ')}</dd>
            </>
          )}
          <dt>Last refresh attempt</dt>
          <dd>{formatTime(snapshot?.lastAttemptAt)}</dd>
          <dt>Last error</dt>
          <dd>
            {snapshot?.lastError
              ? `${snapshot.lastError.code}: ${snapshot.lastError.message}`
              : (status.error?.message ?? 'None')}
          </dd>
          <dt>Scheduler queries this session</dt>
          <dd>{snapshot?.inventoryRequests ?? 0}</dd>
        </dl>
        <button
          className="btn"
          onClick={() =>
            api
              .inspectSshConfig(status.profileId ?? 'default')
              .then(setReport)
              .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }))
          }
        >
          Inspect local SSH configuration
        </button>
        {report && (
          <dl className="kv">
            <dt>OpenSSH</dt>
            <dd>
              {report.sshVersion} ({report.sshPath})
            </dd>
            <dt>~/.ssh/config</dt>
            <dd>{report.userConfigFound ? 'found (read only, never modified)' : 'not found'}</dd>
            <dt>Route</dt>
            <dd>
              {report.hops.map((h) => `${r(h.user)}@${h.hostname}:${h.port}`).join(' → ')}
              {report.usesProxyCommand && ' (ProxyCommand)'}
            </dd>
          </dl>
        )}
      </section>

      <VsCodePanel status={status} />
      <ToolchainsCard />
      <TransfersCard />

      <section className="card" aria-labelledby="jupyter-title">
        <h2 id="jupyter-title">Jupyter</h2>
        <p>
          <strong>Batch notebooks</strong> are supported: New job → Training workflow → "Notebook, batch execution" runs
          a notebook top to bottom on a GPU node and saves the executed copy with the results.
        </p>
        <Notice tone="info" title="Interactive Jupyter is disabled">
          A safe interactive session needs Jupyter bound to 127.0.0.1 on the allocated compute node and an SSH tunnel to
          that node. Whether ICF lets users SSH into the node running their job, and how those host keys are verified,
          has not been confirmed, and binding Jupyter to a cluster-visible address would expose it to other users. Until
          this is verified with Informatics, the app does not start interactive notebook servers or hold idle GPU
          allocations.
        </Notice>
      </section>

      <section className="card">
        <h2>Links</h2>
        <p className="muted small">Opens in your browser. The app does not read or scrape these pages.</p>
        <div className="actions start">
          <button className="btn ghost" onClick={() => void api.openExternal('icf_status')}>
            ICF status page
            <Icon name="external" size={14} />
          </button>
          <button className="btn ghost" onClick={() => void api.openExternal('icf_tutorial')}>
            ICF tutorial
            <Icon name="external" size={14} />
          </button>
          <button className="btn ghost" onClick={() => void api.openExternal('vscode_remote_ssh')}>
            VS Code Remote - SSH
            <Icon name="external" size={14} />
          </button>
        </div>
      </section>
    </div>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'toolchain';

function ToolchainsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'rc' | 'modules'>('rc');
  const [value, setValue] = useState('');
  const [cuda, setCuda] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = (p: ToolchainProfile) =>
    api
      .saveToolchain(p)
      .then(() => {
        setLabel('');
        setValue('');
        setCuda('');
        setError(null);
        return qc.invalidateQueries({ queryKey: ['toolchains'] });
      })
      .catch((e) => setError(errorMessage(e)));
  return (
    <section className="card" aria-labelledby="tc-title">
      <h2 id="tc-title">CUDA toolchain profiles</h2>
      <p className="muted small">
        A toolchain is sourced (or its modules loaded) at the start of a job, before your interpreter. The app never
        installs or upgrades CUDA or PyTorch. Paths are checked on ICF when you discover environments and again inside
        each job.
      </p>
      {error && <Notice tone="bad">{error}</Notice>}
      <ul className="project-list">
        {q.data?.map((t) => (
          <li key={t.id}>
            <span>
              <strong>{t.label}</strong>{' '}
              <span className="muted small mono">
                {t.spec.kind === 'rc'
                  ? `source ${t.spec.path}`
                  : t.spec.kind === 'modules'
                    ? `module load ${t.spec.names.join(' ')}`
                    : 'none'}
                {t.cuda && ` · CUDA ${t.cuda}`}
              </span>
              {t.note && <div className="muted small">{t.note}</div>}
            </span>
            <button
              className="btn ghost small-btn"
              aria-label={`Delete ${t.label}`}
              onClick={() =>
                void api
                  .deleteToolchain(t.id)
                  .then(() => qc.invalidateQueries({ queryKey: ['toolchains'] }))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="grid-4">
        <label className="field">
          <span>Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'rc' | 'modules')}>
            <option value="rc">Setup file (source)</option>
            <option value="modules">Environment modules</option>
          </select>
        </label>
        <label className="field">
          <span>{kind === 'rc' ? 'File on ICF' : 'Modules (space separated)'}</span>
          <input
            className="mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>CUDA version (label)</span>
          <input value={cuda} onChange={(e) => setCuda(e.target.value)} placeholder="12.8" />
        </label>
      </div>
      <button
        className="btn"
        disabled={!label.trim() || !value.trim()}
        onClick={() =>
          void save({
            id: slug(label),
            label: label.trim(),
            spec:
              kind === 'rc'
                ? { kind: 'rc', path: value.trim() }
                : { kind: 'modules', names: value.trim().split(/\s+/) },
            cuda: cuda.trim() || null,
            note: null,
          })
        }
      >
        Add toolchain
      </button>
    </section>
  );
}

const LIMITS = [0, 50, 100, 200, 500];

function TransfersCard() {
  const q = useQuery({ queryKey: ['prefs'], queryFn: api.prefs, retry: false });
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby="xfer-title">
      <h2 id="xfer-title">Transfers</h2>
      {error && <Notice tone="bad">{error}</Notice>}
      <label className="field inline">
        <span>Bandwidth limit</span>
        <select
          value={q.data?.transferLimitMbps ?? 0}
          onChange={(e) =>
            void api
              .setPrefs({ transferLimitMbps: Number(e.target.value) })
              .then((p) => qc.setQueryData(['prefs'], p))
              .catch((err) => setError(errorMessage(err)))
          }
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              {l === 0 ? 'No limit' : `${l} Mbit/s`}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Transfers run one at a time over your SSH connection; this caps each one (sftp -l).</p>
    </section>
  );
}
