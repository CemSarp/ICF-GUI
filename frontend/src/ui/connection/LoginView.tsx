import { useState } from 'react';
import { Dialog, Notice } from '../components/ui';
import { useLogin } from '../../logic/connection/useLogin';
import { formatTime } from '../../logic/format';
import type { ConnectionStatus } from '../../types';

const SSH_EXAMPLE = `Host edinburgh-jump
    HostName student.ssh.inf.ed.ac.uk
    User <UUN>

Host icf
    HostName icf
    User <UUN>
    ProxyJump edinburgh-jump
    ServerAliveInterval 60
    ServerAliveCountMax 3`;

export function LoginView({ status }: { status: ConnectionStatus }) {
  const {
    profiles,
    profile,
    selectProfile,
    username,
    setUsername,
    authMode,
    setAuthMode,
    password,
    setPassword,
    gatewayPassword,
    setGatewayPassword,
    remember,
    setRemember,
    sameForBoth,
    setSameForBoth,
    alias,
    setAlias,
    jumpHost,
    setJumpHost,
    error,
    connecting,
    saved,
    locked,
    connect,
    forget,
    cancel,
    openDemo,
  } = useLogin(status);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  return (
    <main className="login" id="main">
      <form
        className="card login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
        aria-labelledby="login-title"
      >
        <h1 id="login-title">Connect to ICF</h1>
        <p className="muted">
          Signs in with macOS OpenSSH through your SSH config (alias <code>{profile?.sshAlias ?? 'icf'}</code>). Nothing
          is submitted or changed on ICF until you confirm it.
        </p>

        {profiles.length > 1 && (
          <label className="field">
            <span>Profile</span>
            <select value={profile?.id} onChange={(e) => selectProfile(e.target.value)} disabled={connecting}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="segmented" disabled={connecting}>
          <legend>Sign-in method</legend>
          <label>
            <input type="radio" name="mode" checked={authMode === 'agent'} onChange={() => setAuthMode('agent')} />
            Use existing SSH config / agent <span className="muted">(recommended)</span>
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={authMode === 'password'}
              onChange={() => setAuthMode('password')}
            />
            Username and password
          </label>
        </fieldset>

        <label className="field">
          <span>Username (UUN)</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            placeholder="from SSH config if empty"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            disabled={connecting}
          />
        </label>

        {authMode === 'password' && (
          <>
            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="input-row">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  aria-describedby="password-help"
                  placeholder={saved.length ? 'Leave empty to use the saved password' : ''}
                  disabled={connecting}
                />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <small id="password-help" className="muted">
                Used for the ICF login host. The gateway asks separately unless you choose otherwise below.
              </small>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={connecting}
              />
              Remember password in macOS Keychain
            </label>
            {saved.length > 0 && (
              <div className="saved">
                <span>Saved in Keychain: {saved.join(', ')}</span>
                <button
                  type="button"
                  className="btn ghost danger"
                  onClick={() => setConfirmForget(true)}
                  disabled={connecting}
                >
                  Forget saved password
                </button>
              </div>
            )}
          </>
        )}

        <details className="advanced">
          <summary>Advanced connection settings</summary>
          <label className="field">
            <span>SSH host alias</span>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
              disabled={connecting}
            />
          </label>
          <label className="field">
            <span>Jump host override</span>
            <input
              value={jumpHost}
              onChange={(e) => setJumpHost(e.target.value)}
              placeholder="empty = from SSH config, else student.ssh.inf.ed.ac.uk"
              autoCapitalize="off"
              spellCheck={false}
              disabled={connecting}
            />
          </label>
          {authMode === 'password' && (
            <>
              <label className="field">
                <span>Gateway password (if different)</span>
                <input
                  type="password"
                  value={gatewayPassword}
                  onChange={(e) => setGatewayPassword(e.target.value)}
                  autoComplete="off"
                  disabled={connecting || sameForBoth}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sameForBoth}
                  onChange={(e) => setSameForBoth(e.target.checked)}
                  disabled={connecting}
                />
                Use the same password for the gateway and ICF
              </label>
            </>
          )}
          <details>
            <summary>Example ~/.ssh/config (not modified by this app)</summary>
            <pre className="code">{SSH_EXAMPLE}</pre>
          </details>
        </details>

        {locked && (
          <Notice tone="bad" title="Sign-in paused">
            {status.failedAttempts} failed attempts. Wait until {formatTime(status.lockedUntil)} and check your password
            to avoid an account lockout.
          </Notice>
        )}
        {error && !locked && <Notice tone="bad">{error}</Notice>}
        {status.state === 'connecting' && (
          <Notice tone="info">Authenticating… Prompts from SSH will appear in a dialog.</Notice>
        )}

        <div className="actions">
          {connecting ? (
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn ghost" onClick={openDemo}>
              Explore demo data
            </button>
          )}
          <button type="submit" className="btn primary" disabled={connecting || locked || !profile}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {profile?.lastSuccessAt && (
          <p className="muted small">Last successful connection: {formatTime(profile.lastSuccessAt)}</p>
        )}
      </form>

      {confirmForget && (
        <Dialog title="Forget saved password?" onClose={() => setConfirmForget(false)}>
          <p>This deletes the Keychain items for: {saved.join(', ')}. You will need to type your password next time.</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirmForget(false)} data-autofocus>
              Keep
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setConfirmForget(false);
                void forget();
              }}
            >
              Delete from Keychain
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
