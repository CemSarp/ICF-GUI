import { useState } from 'react';
import { Notice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { ConnectionStatus, Settings, SnapshotResponse, SshConfigReport } from '../../types';

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
        <fieldset className="segmented">
          <legend>Theme</legend>
          {(['system', 'light', 'dark'] as const).map((t) => (
            <label key={t}>
              <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
              {t[0]!.toUpperCase() + t.slice(1)}
            </label>
          ))}
        </fieldset>
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
            {caps && ` · JSON output ${caps.jsonSupported ? 'available (not used in V1)' : 'not available'}`}
          </dd>
          {caps && caps.missingCommands.length > 0 && (
            <>
              <dt>Missing commands</dt>
              <dd>{caps.missingCommands.join(', ')}</dd>
            </>
          )}
          <dt>Last refresh attempt</dt>
          <dd>{formatDateTime(snapshot?.lastAttemptAt)}</dd>
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

      <section className="card">
        <h2>Links</h2>
        <p className="muted small">Opens in your browser. The app does not read or scrape these pages.</p>
        <div className="actions start">
          <button className="btn ghost" onClick={() => void api.openExternal('icf_status')}>
            ICF status page ↗
          </button>
          <button className="btn ghost" onClick={() => void api.openExternal('icf_tutorial')}>
            ICF tutorial ↗
          </button>
          <button className="btn ghost" onClick={() => void api.openExternal('vscode_remote_ssh')}>
            VS Code Remote - SSH (V3) ↗
          </button>
        </div>
      </section>
    </div>
  );
}
