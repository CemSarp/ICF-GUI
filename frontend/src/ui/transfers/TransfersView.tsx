import { useState } from 'react';
import { Badge, EmptyState, Icon, Notice } from '../components/ui';
import { bytes, formatTime, TRANSFER_PHASE } from '../../logic/format';
import { canResume, isActive, progressPct, useTransfers } from '../../logic/transfers/transfers';
import type { ConnectionStatus, Transfer } from '../../types';
import { PickRemote } from '../projects/RemoteBrowser';

export function TransfersView({ status, uploadDir }: { status: ConnectionStatus; uploadDir: string | null }) {
  const {
    items,
    pick,
    setPick,
    folder,
    dir,
    setDir,
    name,
    setName,
    busy,
    error,
    refresh,
    chooseFile,
    chooseFolder,
    pack,
    upload,
    download,
    cancel,
    retry,
    discard,
  } = useTransfers(status, uploadDir);
  const [choosing, setChoosing] = useState<'upload-dir' | 'download' | null>(null);

  if (status.demo) {
    return (
      <EmptyState title="Transfers need a live connection">Demo mode does not copy files. Connect to ICF.</EmptyState>
    );
  }

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
          <button className="btn" disabled={!!busy} onClick={chooseFile}>
            Choose a file…
          </button>
          <button className="btn" disabled={!!busy} onClick={chooseFolder}>
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
            <button className="btn primary" disabled={!!busy} onClick={pack}>
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
              <button className="btn primary" disabled={!dir || !name.trim() || !!busy} onClick={upload}>
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
              <TransferRow key={t.id} t={t} onCancel={cancel} onRetry={retry} onDiscard={discard} />
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
            download(p);
          }}
          onClose={() => setChoosing(null)}
        />
      )}
    </div>
  );
}

function TransferRow({
  t,
  onCancel,
  onRetry,
  onDiscard,
}: {
  t: Transfer;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const ph = TRANSFER_PHASE[t.phase];
  const active = isActive(t);
  const pct = progressPct(t);
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
          <button className="btn small-btn" onClick={() => onCancel(t.id)}>
            Cancel
          </button>
        )}
        {canResume(t) && (
          <button className="btn small-btn" onClick={() => onRetry(t.id)}>
            Retry / resume
          </button>
        )}
        {!active && (
          <button className="btn ghost small-btn" onClick={() => onDiscard(t.id)}>
            {t.phase === 'done' ? 'Remove from list' : 'Discard partial file'}
          </button>
        )}
      </div>
    </li>
  );
}
