import { useState } from 'react';
import { Badge, Dialog, EmptyState, Icon, Notice } from '../components/ui';
import { formatDuration } from '../../logic/format';
import { useRequestGpu, type RunTarget } from '../../logic/jobs/jobRequest';
import { splitPath, tilde, type JobMode } from '../../logic/jobs/newJob';
import { SETUP_LINES, validCondaEnv, withSetupLine } from '../../logic/jobs/sbatchImport';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { PickRemote } from '../projects/RemoteBrowser';
import { Field, FieldError, GpuPicker, PathCard, PresetBar, ProjectEnvNote } from './JobParts';
import { RunChoice } from './RunChoice';

/** Fields under "More options": it opens by itself when one of them has a problem. */
const MORE_FIELDS = ['programArgs', 'setupSource'];

export function RequestGpuView({
  snapshot,
  status,
  initialPartition,
  onOpenJobs,
  onSwitch,
  runTarget = null,
}: {
  snapshot: ClusterSnapshot;
  status: ConnectionStatus;
  initialPartition: string | null;
  onOpenJobs: (jobId?: string) => void;
  /** "What do you want to run?" picked something the training workflow form handles. */
  onSwitch: (m: JobMode) => void;
  runTarget?: RunTarget | null;
}) {
  const {
    home,
    learned,
    choose,
    draft,
    set,
    patch,
    wd,
    fileAbs,
    runFrom,
    projectEnv,
    presets,
    partition,
    gres,
    effective,
    maxGpus,
    picking,
    setPicking,
    imported,
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
  } = useRequestGpu(snapshot, status, initialPartition, runTarget, onSwitch);
  const [condaOpen, setCondaOpen] = useState(false);
  const [condaEnv, setCondaEnv] = useState('');
  const gpuName = partition?.gpuTotals.find((t) => t.gresName === gres)?.modelLabel ?? 'GPU';

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
      {(picking === 'dir' || picking === 'env') && (
        <PickRemote
          status={status}
          start={picking === 'env' ? draft.pythonEnv.trim() || null : draft.workingDir.trim() ? wd : null}
          kind="dir"
          onPick={pickDir}
          onClose={() => setPicking(null)}
          title={picking === 'env' ? 'Choose the Python environment folder' : 'Choose the folder to run in'}
        />
      )}
      {(picking === 'program' || picking === 'file') && (
        <PickRemote
          status={status}
          start={draft.workingDir.trim() ? wd : null}
          kind="file"
          onPick={(p) => void pickFile(p)}
          onClose={() => setPicking(null)}
          title={picking === 'file' ? 'Choose the file to run' : 'Choose the script'}
        />
      )}

      {!preview ? (
        <form
          className="job-form"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
          noValidate
        >
          <section className="card form-card">
            {!status.demo && <PresetBar presets={presets} />}
            <RunChoice value={draft.runner} managed={false} onChange={choose} />
          </section>

          <section className="card form-card">
            <h3>{draft.runner === 'commands' ? 'Commands' : 'Script'}</h3>
            {draft.runner === 'commands' ? (
              <>
                <PathCard
                  icon="folder"
                  label="Folder"
                  title={wd === home ? '~' : splitPath(wd).name}
                  empty=""
                  folder={wd}
                  home={home}
                  onRunFrom={runFrom}
                >
                  <button type="button" className="btn" onClick={() => setPicking('file')}>
                    Choose a file
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setPicking('dir')}>
                    Choose folder
                  </button>
                </PathCard>
                <FieldError issues={issues} field="workingDir" />
                <div className={`field${issues.some((i) => i.field === 'commands') ? ' invalid' : ''}`}>
                  <label htmlFor="f-commands">Commands to run</label>
                  <div className="chips">
                    <span className="muted small">Add a line:</span>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => set('commands', withSetupLine(draft.commands, SETUP_LINES.cuda))}
                      title={SETUP_LINES.cuda}
                    >
                      + CUDA 12.8
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => setCondaOpen(!condaOpen)}
                      aria-expanded={condaOpen}
                    >
                      + Conda environment
                    </button>
                    {projectEnv.env.kind === 'env' && /^[\w./-]+$/.test(projectEnv.env.dir) && (
                      <button
                        type="button"
                        className="chip"
                        onClick={() =>
                          projectEnv.env.kind === 'env' &&
                          set('commands', withSetupLine(draft.commands, SETUP_LINES.env(projectEnv.env.dir)))
                        }
                        title={SETUP_LINES.env(projectEnv.env.dir)}
                      >
                        + Project environment ({splitPath(projectEnv.env.dir).name})
                      </button>
                    )}
                    <button
                      type="button"
                      className="chip"
                      onClick={() => set('commands', withSetupLine(draft.commands, SETUP_LINES.gpu))}
                      title={SETUP_LINES.gpu}
                    >
                      + Show the GPU
                    </button>
                  </div>
                  {condaOpen && (
                    <div className="input-row">
                      <label className="sr-only" htmlFor="f-conda">
                        Conda environment name
                      </label>
                      <input
                        id="f-conda"
                        className="mono"
                        placeholder="Environment name, e.g. mls-asr"
                        value={condaEnv}
                        onChange={(e) => setCondaEnv(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={!validCondaEnv(condaEnv.trim())}
                        onClick={() => {
                          set('commands', withSetupLine(draft.commands, SETUP_LINES.conda(condaEnv.trim())));
                          setCondaOpen(false);
                        }}
                      >
                        Add
                      </button>
                    </div>
                  )}
                  {imported && (
                    <Notice tone="ok" title={`Settings and commands taken from ${imported.name}`}>
                      Check them below and under GPU before reviewing.
                      {imported.notes.length > 0 && (
                        <ul className="small">
                          {imported.notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </Notice>
                  )}
                  <textarea
                    id="f-commands"
                    rows={Math.min(16, Math.max(4, draft.commands.split('\n').length + 1))}
                    value={draft.commands}
                    placeholder={'nvidia-smi -L\nmake && ./run.sh 2>&1 | tee run.log'}
                    onChange={(e) => set('commands', e.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    className="mono"
                  />
                  <small className="muted">
                    They run on the GPU node exactly as typed and stop at the first failing command. A batch file
                    (.sbatch) brings its settings and commands with it.
                  </small>
                  <FieldError issues={issues} field="commands" />
                </div>
              </>
            ) : (
              <>
                <PathCard
                  icon="file"
                  label="Script"
                  title={fileAbs ? (fileAbs.startsWith(`${wd}/`) ? fileAbs.slice(wd.length + 1) : fileAbs) : ''}
                  empty="No script chosen yet"
                  folder={fileAbs || draft.workingDir.trim() ? wd : undefined}
                  home={home}
                  onRunFrom={runFrom}
                >
                  {fileAbs && (
                    <button type="button" className="btn ghost" onClick={() => set('program', '')}>
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    className={fileAbs ? 'btn' : 'btn primary'}
                    onClick={() => setPicking('program')}
                  >
                    {fileAbs ? 'Change' : 'Choose script'}
                  </button>
                </PathCard>
                <FieldError issues={issues} field="program" />
                <FieldError issues={issues} field="workingDir" />
              </>
            )}
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
            </div>
            {draft.runner === 'python' && (
              <>
                <PathCard
                  icon="layers"
                  label="Python environment"
                  title={draft.pythonEnv.trim() ? tilde(draft.pythonEnv.trim(), home) : ''}
                  empty="None: python3 of the GPU node"
                  home={home}
                >
                  {draft.pythonEnv.trim() && (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        projectEnv.decline();
                        set('pythonEnv', '');
                      }}
                    >
                      Clear
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => setPicking('env')}>
                    Choose
                  </button>
                </PathCard>
                <ProjectEnvNote
                  env={projectEnv.env}
                  fromProject={projectEnv.fromProject(draft.pythonEnv)}
                  home={home}
                />
                <FieldError issues={issues} field="pythonEnv" />
              </>
            )}
          </section>

          <GpuPicker
            snapshot={snapshot}
            partition={partition}
            gres={gres}
            draft={draft}
            maxGpus={maxGpus}
            learned={learned}
            issues={issues}
            patch={patch}
            prefix="f"
          />

          <details className="card fold-section" open={issues.some((i) => MORE_FIELDS.includes(i.field ?? ''))}>
            <summary>More options</summary>
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
          </details>
          <div className="actions submit-bar">
            <span className="muted small">
              {draft.gpuCount} × {gpuName} · {formatDuration(draft.hours * 3600 + draft.minutes * 60, '')} ·{' '}
              {draft.cpus} CPUs · {draft.memoryGb} GB RAM
            </span>
            <button type="submit" className="btn primary" disabled={busy || !gres}>
              <Icon name="play" />
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
              Submit job
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
