import { useState, type FormEvent } from 'react';
import { Dialog, Notice } from '../../components/ui';
import { api } from '../../lib/api';
import type { Challenge } from '../../types';

/** One SSH prompt routed from the askpass helper. Typed values go straight to the backend and are cleared. */
export function ChallengeDialog({ challenge, onDone }: { challenge: Challenge; onDone: (id: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const answer = async (accept: boolean) => {
    setBusy(true);
    const v = value;
    setValue('');
    await api.answerChallenge(challenge.id, accept, accept ? v : undefined).catch(() => undefined);
    onDone(challenge.id);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void answer(true);
  };

  if (challenge.kind === 'host_key') {
    return (
      <Dialog title="Verify host key" onClose={() => void answer(false)}>
        <p>
          This is the first connection to <strong>{challenge.host}</strong> from this Mac. SSH cannot prove the server
          is genuine yet.
        </p>
        <dl className="kv">
          <dt>Key type</dt>
          <dd>{challenge.keyType}</dd>
          <dt>Fingerprint</dt>
          <dd>
            <code className="fingerprint">{challenge.fingerprint}</code>
          </dd>
        </dl>
        <Notice tone="warn">
          Only accept if this fingerprint matches one published by Informatics through a trusted channel. The
          fingerprint shown here comes from the server itself and is not independent proof. Your decision is recorded
          locally and the key is saved to <code>~/.ssh/known_hosts</code> by OpenSSH.
        </Notice>
        <div className="actions">
          <button className="btn" onClick={() => void answer(false)} disabled={busy} data-autofocus>
            Reject and stop
          </button>
          <button className="btn primary" onClick={() => void answer(true)} disabled={busy}>
            I verified it — trust this host
          </button>
        </div>
      </Dialog>
    );
  }

  const title = challenge.kind === 'password' ? `Password for ${challenge.hopLabel ?? 'host'}` : 'SSH needs a response';
  return (
    <Dialog title={title} onClose={() => void answer(false)}>
      <form onSubmit={submit}>
        {challenge.kind === 'password' ? (
          <p>
            Enter the password for <strong>{`${challenge.user}@${challenge.host}`}</strong>.
          </p>
        ) : (
          <>
            <p className="muted">The server asked (shown as plain text, may be untrusted):</p>
            <pre className="prompt-text">{challenge.text}</pre>
          </>
        )}
        {challenge.note && <Notice tone="info">{challenge.note}</Notice>}
        <label className="field">
          <span>Response</span>
          <input
            type={challenge.secretInput ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-autofocus
          />
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void answer(false)} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Send
          </button>
        </div>
      </form>
    </Dialog>
  );
}
