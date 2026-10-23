import { useState } from 'react';
import { Icon, Notice } from '../components/ui';
import { formatTime } from '../../logic/format';
import {
  POLL_CHOICES,
  redactName,
  TRANSFER_LIMITS,
  useSettings,
  useToolchains,
  useTransferPrefs,
} from '../../logic/settings/settings';
import type { Theme } from '../../logic/settings/theme';
import type { ConnectionStatus, Settings, SnapshotResponse } from '../../types';
import { VsCodePanel } from '../projects/ProjectsView';

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
  const { report, msg, setPollInterval, clearCache, inspect, openLink } = useSettings(
    status,
    onSettings,
    onCacheCleared,
  );
  const [redact, setRedact] = useState(true);
  const r = (s: string) => redactName(s, redact);
  const caps = status.capabilities;

  return (
    <div className="settings">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <section className="card">
        <h2>Refresh</h2>
        <label className="field inline">
          <span>Automatic refresh every</span>
          <select value={settings.pollIntervalSecs} onChange={(e) => void setPollInterval(Number(e.target.value))}>
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
        <button className="btn" onClick={() => void clearCache()}>
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
        <button className="btn" onClick={() => void inspect()}>
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
          <button className="btn ghost" onClick={() => openLink('icf_status')}>
            ICF status page
            <Icon name="external" size={14} />
          </button>
          <button className="btn ghost" onClick={() => openLink('icf_tutorial')}>
            ICF tutorial
            <Icon name="external" size={14} />
          </button>
          <button className="btn ghost" onClick={() => openLink('vscode_remote_ssh')}>
            VS Code Remote - SSH
            <Icon name="external" size={14} />
          </button>
        </div>
      </section>
    </div>
  );
}

function ToolchainsCard() {
  const { q, label, setLabel, kind, setKind, value, setValue, cuda, setCuda, error, add, remove } = useToolchains();
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
            <button className="btn ghost small-btn" aria-label={`Delete ${t.label}`} onClick={() => remove(t.id)}>
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
      <button className="btn" disabled={!label.trim() || !value.trim()} onClick={add}>
        Add toolchain
      </button>
    </section>
  );
}

function TransfersCard() {
  const { limit, error, setLimit } = useTransferPrefs();
  return (
    <section className="card" aria-labelledby="xfer-title">
      <h2 id="xfer-title">Transfers</h2>
      {error && <Notice tone="bad">{error}</Notice>}
      <label className="field inline">
        <span>Bandwidth limit</span>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {TRANSFER_LIMITS.map((l) => (
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
