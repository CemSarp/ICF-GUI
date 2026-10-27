import { type ReactNode } from 'react';
import { Badge, Dialog, EmptyState, Notice, NumberInput } from '../components/ui';
import { granularityLabel } from '../../logic/cluster/gpu';
import { formatDuration, formatTime, nominalVram } from '../../logic/format';
import { resolveWorkingDir, useRequestGpu } from '../../logic/jobs/jobRequest';
import type { ClusterSnapshot, ConnectionStatus, Issue } from '../../types';
import { PickRemote } from '../projects/RemoteBrowser';
import { RunChoice } from './RunChoice';
import type { JobMode } from '../../logic/jobs/newJob';

/** Fields under "More options": it opens by itself when one of them has a problem. */
const MORE_FIELDS = [
  'jobName',
  'workingDir',
  'cpus',
  'memoryMib',
  'programArgs',
  'pythonEnv',
  'setupSource',
  'mailUser',
];

function FieldError({ issues, field }: { issues: Issue[]; field: string }) {
  const mine = issues.filter((i) => i.field === field);
  if (!mine.length) return null;
  return (
    <span className="field-error" id={`err-${field}`} role="alert">
      {mine.map((i) => i.message).join(' ')}
    </span>
  );
}

/** Optional SLURM e-mail on end/fail; works while the app is closed. Shared with the training wizard. */
export function MailOption({
  draft,
  issues,
  set,
  id,
}: {
  draft: { mail: boolean; mailUser: string };
  issues: Issue[];
  set: (k: 'mail' | 'mailUser', v: boolean | string) => void;
  id: string;
}) {
  const mine = issues.filter((i) => i.field === 'mailUser');
  return (
    <div className={`field${mine.length ? ' invalid' : ''}`}>
      <label className="check">
        <input type="checkbox" checked={draft.mail} onChange={(e) => set('mail', e.target.checked)} />
        E-mail me when the job ends or fails
      </label>
      {draft.mail && (
        <>
          <label htmlFor={id}>E-mail address</label>
          <input
            id={id}
            type="email"
            className="mono"
            value={draft.mailUser}
            placeholder="s1234567@ed.ac.uk"
            onChange={(e) => set('mailUser', e.target.value)}
            autoCapitalize="off"
            spellCheck={false}
          />
          <small className="muted">SLURM sends it itself, so it arrives even while this app is closed.</small>
        </>
      )}
      {mine.length > 0 && (
        <span className="field-error" role="alert">
          {mine.map((i) => i.message).join(' ')}
        </span>
      )}
    </div>
  );
}

function Field({
  label,
  field,
  issues,
  help,
  children,
}: {
  label: string;
  field: string;
  issues: Issue[];
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`field${issues.some((i) => i.field === field) ? ' invalid' : ''}`}>
      <label htmlFor={`f-${field}`}>{label}</label>
      {children}
      {help && <small className="muted">{help}</small>}
      <FieldError issues={issues} field={field} />
    </div>
  );
}

export function RequestGpuView({
  snapshot,
  status,
  initialPartition,
  onOpenJobs,
  onSwitch,
}: {
  snapshot: ClusterSnapshot;
  status: ConnectionStatus;
  initialPartition: string | null;
  onOpenJobs: (jobId?: string) => void;
  /** "What do you want to run?" picked something the training workflow form handles. */
  onSwitch: (m: JobMode) => void;
}) {
  const {
    home,
    learned,
    choose,
    draft,
    set,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
    picking,
    setPicking,
    pickDir,
    pickFile,
    preview,
    setPreview,
    issues,
    busy,
    error,
    ack,
    setAck,
    confirming,
    setConfirming,
    result,
    setResult,
    reconcileMsg,
    review,
    submit,
    reconcile,
  } = useRequestGpu(snapshot, status, initialPartition);

  if (!partition) {
    return <EmptyState title="No partitions available">Refresh the cluster data first.</EmptyState>;
  }

  if (result) {
    return (
      <section className="card result" aria-live="polite">
        {result.outcome === 'accepted' && (
          <>
            <h2>
              <Badge tone="ok" glyph="✓">
                Accepted
              </Badge>{' '}
              Job {result.jobId}
            </h2>
            <p>
              SLURM accepted the job. It is <strong>queued</strong>: GPUs are allocated only when the scheduler starts
              it. Progress, node and logs appear in My Jobs.
            </p>
            <div className="actions start">
              <button className="btn primary" onClick={() => onOpenJobs(result.jobId)}>
                Open job {result.jobId}
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                New request
              </button>
            </div>
          </>
        )}
        {result.outcome === 'rejected' && (
          <>
            <h2>
              <Badge tone="bad" glyph="✕">
                Not submitted
              </Badge>
            </h2>
            <Notice tone="bad">{result.message}</Notice>
            <button className="btn" onClick={() => setResult(null)}>
              Edit request
            </button>
          </>
        )}
        {result.outcome === 'uncertain' && (
          <>
            <h2>
              <Badge tone="warn" glyph="?">
                Submission uncertain
              </Badge>
            </h2>
            <Notice tone="warn" title="The job may or may not have been queued">
              {result.message} The app will not retry automatically, to avoid a duplicate job. Check your jobs first;
              only submit again if it is not there.
            </Notice>
            {reconcileMsg && <Notice tone="info">{reconcileMsg}</Notice>}
            <div className="actions start">
              <button className="btn primary" onClick={() => void reconcile(result.receipt.tag)}>
                Check my jobs for this submission
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                Back to the request
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <div className="wizard">
      <ol className="steps" aria-label="Progress">
        <li aria-current={!preview ? 'step' : undefined} className={preview ? 'done' : undefined}>
          Configure
        </li>
        <li aria-current={preview ? 'step' : undefined}>Review &amp; submit</li>
      </ol>
      {status.demo && <Notice tone="info">Demo mode: you can review scripts, but submission is disabled.</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {/* Outside the form: the browser's buttons must not submit it. */}
      {picking === 'dir' && (
        <PickRemote
          status={status}
          start={draft.workingDir.trim() ? resolveWorkingDir(draft.workingDir, home) : null}
          kind="dir"
          onPick={pickDir}
          onClose={() => setPicking(null)}
          title="Choose the working directory"
        />
      )}
      {(picking === 'program' || picking === 'file') && (
        <PickRemote
          status={status}
          start={draft.workingDir.trim() ? resolveWorkingDir(draft.workingDir, home) : null}
          kind="file"
          onPick={pickFile}
          onClose={() => setPicking(null)}
          title={picking === 'file' ? 'Choose the file to run' : 'Choose the script'}
        />
      )}

      {!preview ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
          noValidate
        >
          <RunChoice value={draft.runner} managed={false} onChange={(c, m) => choose(c, m, onSwitch)} />
          {draft.runner === 'commands' ? (
            <Field
              label="Commands to run"
              field="commands"
              issues={issues}
              help={
                <>
                  They start in <code>{resolveWorkingDir(draft.workingDir, home)}</code> on the GPU node, exactly as
                  typed; the job stops at the first failing command. <em>Choose a file</em> uses that file&apos;s folder
                  and suggests a command.
                </>
              }
            >
              <div className="actions start">
                <button type="button" className="btn" onClick={() => setPicking('file')}>
                  Choose a file…
                </button>
              </div>
              <textarea
                id="f-commands"
                rows={6}
                value={draft.commands}
                placeholder={'nvidia-smi -L\nmake && ./run.sh 2>&1 | tee run.log'}
                onChange={(e) => set('commands', e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                className="mono"
              />
            </Field>
          ) : (
            <Field
              label="Script"
              field="program"
              issues={issues}
              help={
                <>
                  Runs in <code>{resolveWorkingDir(draft.workingDir, home)}</code>. Choose a file on ICF, or type a path
                  relative to that folder.
                </>
              }
            >
              <div className="input-row">
                <input
                  id="f-program"
                  value={draft.program}
                  onChange={(e) => set('program', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                  className="mono"
                />
                <button type="button" className="btn" onClick={() => setPicking('program')}>
                  Browse…
                </button>
              </div>
            </Field>
          )}

          <h3>GPU</h3>
          <Field
            label="Partition"
            field="partition"
            issues={issues}
            help={
              <>
                Max time {formatDuration(partition.maxTimeSeconds, partition.maxTimeRaw)}
                {learned.get(partition.name) === 'accepted' && ' · ✓ accepted your last job'}
                {learned.get(partition.name) === 'denied' && (
                  <strong className="warn-text"> · ✕ rejected your last job (account not permitted)</strong>
                )}
              </>
            }
          >
            <select id="f-partition" value={partition.name} onChange={(e) => set('partition', e.target.value)}>
              {snapshot.partitions.map((p) => (
                <option key={p.name} value={p.name} disabled={p.eligibility === 'not_permitted'}>
                  {p.name}
                  {p.isDefault ? ' (default)' : ''}
                  {p.eligibility === 'not_permitted' ? ' — not permitted' : ''}
                  {learned.get(p.name) === 'denied' ? ' — rejected you before' : ''}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="gpu-choices">
            <legend>GPU type in {partition.name}</legend>
            <p className="muted small">
              Free = potentially free at {formatTime(snapshot.fetchedAt)}, not a reservation. Hover a row for its SLURM
              name.
            </p>
            {gpuTypes.length === 0 ? (
              <p>No GPUs in this partition.</p>
            ) : (
              gpuTypes.map((t) => (
                <label key={t.gresName} className={`gpu-choice${gres === t.gresName ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name="gres"
                    value={t.gresName}
                    checked={gres === t.gresName}
                    onChange={() => set('gres', t.gresName)}
                  />
                  <span className="gpu-choice-main" title={t.gresName}>
                    <strong>{t.modelLabel}</strong>{' '}
                    <span className="muted small">
                      {nominalVram(t.gresName) ? `${nominalVram(t.gresName)} VRAM` : granularityLabel(t.granularity)}
                      {t.granularity !== 'physical' ? ` · ${granularityLabel(t.granularity)}` : ''} · {t.nodes} node
                      {t.nodes === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="gpu-choice-nums small">
                    <strong>○ {t.potentiallyFree} free</strong> · ● {t.allocated} used
                    {t.unavailable > 0 && ` · ✕ ${t.unavailable} down`}
                    {t.unknown > 0 && ` · ? ${t.unknown} unknown`} / {t.configured}
                  </span>
                </label>
              ))
            )}
            <FieldError issues={issues} field="gresType" />
          </fieldset>
          <div className="grid-2">
            <Field label="GPUs" field="gpuCount" issues={issues} help={`Max ${maxGpus} on one node`}>
              <NumberInput
                id="f-gpuCount"
                min={1}
                max={maxGpus}
                value={draft.gpuCount}
                onChange={(n) => set('gpuCount', n)}
              />
            </Field>
            <Field label="Wall time" field="timeLimitSeconds" issues={issues} help="The job is stopped after this">
              <div className="input-row" id="f-timeLimitSeconds">
                <NumberInput aria-label="Hours" min={0} value={draft.hours} onChange={(n) => set('hours', n)} />
                <span className="muted">h</span>
                <NumberInput
                  aria-label="Minutes"
                  min={0}
                  max={59}
                  value={draft.minutes}
                  onChange={(n) => set('minutes', n)}
                />
                <span className="muted">m</span>
              </div>
            </Field>
          </div>
          {draft.gpuCount > 1 && (
            <Notice tone="warn">
              Multi-GPU requests usually wait longer in the queue. Make sure your code uses all GPUs.
            </Notice>
          )}

          <details className="more" open={issues.some((i) => MORE_FIELDS.includes(i.field ?? ''))}>
            <summary>More options</summary>
            <p className="muted small">The defaults suit most jobs.</p>
            <div className="grid-2">
              <Field label="Job name" field="jobName" issues={issues} help="Shown in My Jobs. Letters, digits, . _ -">
                <input
                  id="f-jobName"
                  value={draft.jobName}
                  onChange={(e) => set('jobName', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Working directory"
                field="workingDir"
                issues={issues}
                help="Where it runs and where slurm-<jobid>.out / .err are written. Relative paths start in your home."
              >
                <div className="input-row">
                  <input
                    id="f-workingDir"
                    placeholder={`e.g. projects/semeval (inside ${home})`}
                    value={draft.workingDir}
                    onChange={(e) => set('workingDir', e.target.value)}
                    autoCapitalize="off"
                    spellCheck={false}
                    className="mono"
                  />
                  <button type="button" className="btn" onClick={() => setPicking('dir')}>
                    Browse…
                  </button>
                </div>
              </Field>
            </div>
            <div className="grid-2">
              <Field label="CPUs" field="cpus" issues={issues}>
                <NumberInput id="f-cpus" min={1} value={draft.cpus} onChange={(n) => set('cpus', n)} />
              </Field>
              <Field label="RAM (GB)" field="memoryMib" issues={issues}>
                <NumberInput id="f-memoryMib" min={1} value={draft.memoryGb} onChange={(n) => set('memoryGb', n)} />
              </Field>
            </div>
            {draft.runner !== 'commands' && (
              <Field
                label="Arguments (optional, one per line)"
                field="programArgs"
                issues={issues}
                help="Passed literally; nothing is interpreted by a shell."
              >
                <textarea
                  id="f-programArgs"
                  rows={3}
                  value={draft.args}
                  onChange={(e) => set('args', e.target.value)}
                  spellCheck={false}
                  className="mono"
                />
              </Field>
            )}
            <Field
              label="Python environment (optional)"
              field="pythonEnv"
              issues={issues}
              help={`A virtualenv folder, activated first, e.g. ${home}/projects/icf-env`}
            >
              <input
                id="f-pythonEnv"
                value={draft.pythonEnv}
                onChange={(e) => set('pythonEnv', e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
                className="mono"
              />
            </Field>
            <Field
              label="Setup file to source first (optional)"
              field="setupSource"
              issues={issues}
              help="For example a CUDA toolchain .rc file"
            >
              <input
                id="f-setupSource"
                value={draft.setupSource}
                onChange={(e) => set('setupSource', e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
                className="mono"
              />
            </Field>
            <MailOption draft={draft} issues={issues} set={set} id="f-mailUser" />
          </details>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !gres}>
              {busy ? 'Checking…' : 'Review script'}
            </button>
          </div>
        </form>
      ) : (
        <section className="card" aria-labelledby="review-title">
          <h2 id="review-title">Review the exact batch script</h2>
          <p className="muted small">
            This is byte-for-byte what will be sent to <code>sbatch</code> (checksum <code>{preview.checksum}</code>).
            Logs: <code>{preview.stdoutPattern}</code>, <code>{preview.stderrPattern}</code>.
          </p>
          <pre className="code script" aria-label="Batch script">
            {preview.script}
          </pre>
          {preview.warnings.map((w, i) => (
            <Notice key={i} tone="warn">
              {w.message}
            </Notice>
          ))}
          {preview.acknowledgements.length > 0 && (
            <div className="acks">
              <ul>
                {preview.acknowledgements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand these
                notices
              </label>
            </div>
          )}
          <div className="actions">
            <button className="btn" onClick={() => setPreview(null)} disabled={busy}>
              Back to edit
            </button>
            <button
              className="btn primary"
              onClick={() => setConfirming(true)}
              disabled={busy || status.demo || (preview.acknowledgements.length > 0 && !ack)}
            >
              Submit job…
            </button>
          </div>
        </section>
      )}

      {confirming && preview && (
        <Dialog title="Submit this job to SLURM?" onClose={() => !busy && setConfirming(false)}>
          <p>
            This queues a real job <strong>{effective.jobName}</strong> on <strong>{effective.partition}</strong>{' '}
            requesting {effective.gpuCount} × {gres}, {effective.cpus} CPUs, {effective.memoryGb} GB RAM for{' '}
            {preview.timeLimit}. It is submitted exactly once.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirming(false)} disabled={busy} data-autofocus>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Submitting…' : 'Submit to SLURM'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
