import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, EmptyState, Icon, Notice } from '../components/ui';
import { api, errorMessage } from '../../logic/api';
import { bytes, formatTime, TRANSFER_PHASE } from '../../logic/format';
import type { ConnectionStatus, FolderPick, LocalPick, Transfer } from '../../types';
import { PickRemote } from '../projects/RemoteBrowser';

const ACTIVE = ['queued', 'checking', 'hashing', 'transferring', 'verifying', 'publishing'];

/** Suggest a remote-safe file name (the backend enforces the same rule). */
export function safeName(name: string): string {
  const base = name.split('/').pop() ?? '';
  const s = base.replace(/[^A-Za-z0-9._+\-@=,]/g, '_').replace(/^[^A-Za-z0-9_]+/, '');
  return s.slice(0, 128) || 'upload';
}

export function TransfersView({ status, uploadDir }: { status: ConnectionStatus; uploadDir: string | null }) {
  const qc = useQueryClient();
  const key = ['transfers', status.profileId, status.connectedAt];
  const list = useQuery({
    queryKey: key,
    queryFn: api.transfers,
    retry: false,
    // Local call only (no network): fast while something is moving, otherwise on demand.
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => ACTIVE.includes(t.phase)) ? 1500 : false),
    refetchIntervalInBackground: false,
  });
  const [pick, setPick] = useState<LocalPick | null>(null);
  const [folder, setFolder] = useState<FolderPick | null>(null);
  const [dir, setDir] = useState<string | null>(uploadDir);
  const [name, setName] = useState('');
  const [choosing, setChoosing] = useState<'upload-dir' | 'download' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (status.demo) {
    return (
      <EmptyState title="Transfers need a live connection">Demo mode does not copy files. Connect to ICF.</EmptyState>
    );
  }

  const items = list.data ?? [];
  return (
    <div className="transfers">
      {error && <Notice tone="bad">{error}</Notice>}
      <section className="card" aria-labelledby="up-title">
        <h2 id="up-title">Upload to ICF</h2>
        <p className="muted small">
          Files go over your existing SSH connection with SFTP, one at a time. Each upload is written to a hidden
          partial file, verified with SHA-256 against your Mac's copy, and only then given its name — an existing file
          is never overwritten. Datasets with many small files: upload a folder as one archive and let the training
          workflow unpack it on the compute node's scratch disk.
        </p>
        <div className="actions start">
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              void run('pick', async () => {
                const p = await api.pickFile();
                if (p) {
                  setPick(p);
                  setFolder(null);
                  setName(safeName(p.name));
                }
              })
            }
          >
            Choose a file…
          </button>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              void run('folder', async () => {
                const f = await api.pickFolder();
                if (f) {
                  setFolder(f);
                  setPick(null);
                }
              })
            }
          >
            {busy === 'folder' ? 'Scanning folder…' : 'Choose a folder to pack…'}
          </button>
        </div>
        {folder && (
          <div className="card inset">
            <p>
              <strong>{folder.name}</strong> — {folder.files} files, {bytes(folder.bytes)}. It will be packed into one{' '}
              <code>.tar.gz</code> on this Mac (no macOS metadata files), uploaded, and the local archive deleted after
              a verified upload.
            </p>
            <button
              className="btn primary"
              disabled={!!busy}
              onClick={() =>
                void run('pack', async () => {
                  const p = await api.packFolder(folder.token);
                  setPick(p);
                  setName(safeName(p.name));
                  setFolder(null);
                })
              }
            >
              {busy === 'pack' ? 'Packing…' : 'Pack as archive'}
            </button>
          </div>
        )}
        {pick && (
          <div className="card inset">
            <p>
              <strong>{pick.name}</strong> ({bytes(pick.size)}){pick.isArchive ? ' · archive' : ''}
            </p>
            <div className="grid-2">
              <div className="field">
                <span>Destination folder on ICF</span>
                <div className="input-row">
                  <code className="crumbs">{dir ?? 'not chosen'}</code>
                  <button className="btn" onClick={() => setChoosing('upload-dir')}>
                    Choose…
                  </button>
                </div>
              </div>
              <div className="field">
                <label htmlFor="up-name">Name on ICF</label>
                <input
                  id="up-name"
                  className="mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <small className="muted">Letters, digits, . _ - + @ = , (no spaces)</small>
              </div>
            </div>
            <div className="actions start">
              <button
                className="btn primary"
                disabled={!dir || !name.trim() || !!busy}
                onClick={() =>
                  void run('upload', async () => {
                    if (!dir) return;
                    await api.upload(pick.token, dir, name.trim());
                    setPick(null);
                  })
                }
              >
                Upload
              </button>
              <button className="btn ghost" onClick={() => setPick(null)}>
                Clear
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="down-title">
        <h2 id="down-title">Download from ICF</h2>
        <p className="muted small">
          Choose a file in your ICF home, then where to save it. The download is verified with SHA-256 before it
          replaces anything (macOS asks before replacing an existing file).
        </p>
        <button className="btn" onClick={() => setChoosing('download')}>
          Choose a file on ICF…
        </button>
      </section>

      <section className="card" aria-labelledby="queue-title">
        <div className="card-head">
          <h2 id="queue-title">Transfers</h2>
          <button className="btn" onClick={refresh}>
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
        {items.length === 0 ? (
          <p className="muted">No transfers yet.</p>
        ) : (
          <ul className="transfer-list">
            {items.map((t) => (
              <TransferRow key={t.id} t={t} onAction={(label, f) => void run(label, f)} />
            ))}
          </ul>
        )}
      </section>

      {choosing === 'upload-dir' && (
        <PickRemote
          status={status}
          start={dir}
          kind="dir"
          title="Upload into which folder?"
          onPick={(p) => {
            setDir(p);
            setChoosing(null);
          }}
          onClose={() => setChoosing(null)}
        />
      )}
      {choosing === 'download' && (
        <PickRemote
          status={status}
          start={uploadDir}
          kind="file"
          title="Download which file?"
          onPick={(p) => {
            setChoosing(null);
            void run('download', () => api.download(p));
          }}
          onClose={() => setChoosing(null)}
        />
      )}
    </div>
  );
}

function TransferRow({ t, onAction }: { t: Transfer; onAction: (label: string, f: () => Promise<unknown>) => void }) {
  const ph = TRANSFER_PHASE[t.phase];
  const active = ACTIVE.includes(t.phase);
  const pct = t.size > 0 ? Math.min(100, Math.round((t.doneBytes / t.size) * 100)) : t.phase === 'done' ? 100 : 0;
  return (
    <li className="transfer">
      <div className="transfer-head">
        <Icon name={t.direction === 'upload' ? 'upload' : 'download'} />
        <strong>{t.name}</strong>
        <Badge tone={ph.tone} glyph={ph.glyph}>
          {ph.label}
        </Badge>
        <span className="spacer" />
        <span className="muted small">{formatTime(t.updatedAt)}</span>
      </div>
      <div className="muted small mono">
        {t.direction === 'upload' ? `${t.localPath} → ${t.remotePath}` : `${t.remotePath} → ${t.localPath}`}
      </div>
      {(active || t.phase === 'done') && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`${t.name} ${ph.label}`}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="small">
        {bytes(t.doneBytes)} / {bytes(t.size)}
        {t.phase === 'hashing' && ' hashed'}
        {t.message && <span> · {t.message}</span>}
      </div>
      <div className="actions start">
        {active && (
          <button className="btn small-btn" onClick={() => onAction('cancel', () => api.cancelTransfer(t.id))}>
            Cancel
          </button>
        )}
        {['failed', 'cancelled', 'interrupted'].includes(t.phase) && (
          <button className="btn small-btn" onClick={() => onAction('retry', () => api.retryTransfer(t.id))}>
            Retry / resume
          </button>
        )}
        {!active && (
          <button className="btn ghost small-btn" onClick={() => onAction('discard', () => api.discardTransfer(t.id))}>
            {t.phase === 'done' ? 'Remove from list' : 'Discard partial file'}
          </button>
        )}
      </div>
    </li>
  );
}
