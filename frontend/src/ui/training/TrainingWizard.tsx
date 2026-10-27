import { useState, type ReactNode } from 'react';
import { Badge, Dialog, EmptyState, Icon, Notice, NumberInput } from '../components/ui';
import { bytes, formatTime, nominalVram } from '../../logic/format';
import { useTrainingWizard } from '../../logic/training/useTrainingWizard';
import { expandHome, importCounts, isArchiveName, type Draft, type WizardInit } from '../../logic/training/wizardDraft';
import type { CheckpointMode, ClusterSnapshot, ConnectionStatus, ImportResult, Issue } from '../../types';
import { MailOption } from '../jobs/RequestGpuView';
import { PickRemote } from '../projects/RemoteBrowser';
import { RunChoice } from '../jobs/RunChoice';
import type { JobMode } from '../../logic/jobs/newJob';

/** Fields in each folded section: a section opens by itself when one of its fields has a problem. */
const DATA_FIELDS = ['datasets', 'scratchRoot', 'expectedOutputGib'];
const RESULT_FIELDS = ['resultsRoot', 'checkpointMode', 'checkpointSyncMinutes', 'signalGraceSeconds', 'resumeFrom'];
const MORE_FIELDS = ['jobName', 'toolchain', 'args', 'cpus', 'memoryMib', 'hfCache', 'env', 'mailUser'];

const IMPORT_BADGE = {
  ok: { tone: 'ok', glyph: '✓' },
  failed: { tone: 'bad', glyph: '✕' },
  not_checked: { tone: 'warn', glyph: '?' },
} as const;

function ImportReport({ interpreter, results }: { interpreter: string; results: ImportResult[] }) {
  const { failed, unchecked } = importCounts(results);
  return (
    <Notice
      tone={failed ? 'bad' : unchecked ? 'warn' : 'ok'}
      title={
        failed
          ? `${failed} of ${results.length} imports failed`
          : unchecked
            ? `${unchecked} of ${results.length} imports were not checked`
            : `All ${results.length} imports work`
      }
    >
      <span className="small">
        With <code>{interpreter}</code> on the login node:
      </span>
      <ul className="import-report">
        {results.map((r) => (
          <li key={r.module}>
            <Badge tone={IMPORT_BADGE[r.status].tone} glyph={IMPORT_BADGE[r.status].glyph}>
              {r.module}
            </Badge>{' '}
            <span className="mono small">{r.detail}</span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** The absolute path a `~/…` value is sent as, shown under its field. */
function Resolved({ value, home }: { value: string; home: string }) {
  const abs = expandHome(value, home);
  return abs === value.trim() ? null : (
    <small className="muted">
      Resolves to <code>{abs}</code>
    </small>
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
  const mine = issues.filter((i) => i.field === field);
  return (
    <div className={`field${mine.length ? ' invalid' : ''}`}>
      <label htmlFor={`w-${field}`}>{label}</label>
      {children}
      {help && <small className="muted">{help}</small>}
      {mine.length > 0 && (
        <span className="field-error" role="alert">
          {mine.map((i) => i.message).join(' ')}
        </span>
      )}
    </div>
  );
}

export function TrainingWizard({
  status,
  snapshot,
  init,
  onOpenRun,
  onRefreshCluster,
  onSwitch,
}: {
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  init: WizardInit | null;
  onOpenRun: (tag: string) => void;
  onRefreshCluster: () => void;
  /** "What do you want to run?" picked something the script job form handles. */
  onSwitch: (m: JobMode) => void;
}) {
  const {
    draft,
    set,
    choice,
    choose,
    pickEntry,
    presets,
    tcList,
    home,
    project,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
    preview,
    issues,
    phase,
    error,
    ack,
    setAck,
    confirming,
    setConfirming,
    result,
    setResult,
    reconcileMsg,
    upload,
    presetLabel,
    setPresetLabel,
    envCheck,
    interpreter,
    checkModules,
    checking,
    review,
    submit,
    backToEdit,
    reconcile,
    resultsRoot,
    checkEnv,
    uploadArchive,
    setDataset,
    removeDataset,
    addDataset,
    loadPreset,
    savePreset,
  } = useTrainingWizard(status, snapshot, init);
  const [picker, setPicker] = useState<null | {
    kind: 'dir' | 'file';
    title: string;
    start: string | null;
    onPick: (p: string) => void;
    archives?: boolean;
  }>(null);

  const openFor = (fields: string[]) => issues.some((i) => fields.includes(i.field ?? ''));

  if (!snapshot) {
    return (
      <EmptyState title="Cluster data needed">
        The workflow is checked against current partitions and GPU types.{' '}
        <button className="link" onClick={onRefreshCluster}>
          Refresh cluster data
        </button>
      </EmptyState>
    );
  }
  if (status.demo) {
    return (
      <EmptyState title="Workflows need a live connection">
        Demo mode uses synthetic data. Connect to ICF to configure and submit training workflows.
      </EmptyState>
    );
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
              SLURM queued the workflow. It runs on a compute node; this app only monitors it (closing the app does not
              stop it). Results go to{' '}
              <code>
                {resultsRoot()}/{effective.jobName}-{result.jobId}
              </code>
              .
            </p>
            <div className="actions start">
              <button className="btn primary" onClick={() => onOpenRun(result.receipt.tag)}>
                Monitor this run
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                New workflow
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
              Edit workflow
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
              {result.message} The app never resubmits on its own. Check your jobs first.
            </Notice>
            {reconcileMsg && <Notice tone="info">{reconcileMsg}</Notice>}
            <div className="actions start">
              <button className="btn primary" onClick={() => void reconcile(result.receipt.tag)}>
                Check my jobs for this submission
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                Back to the workflow
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  // Same two steps as the script job form; uploading and checking show their own notices.
  const reviewing = phase === 'READY' || phase === 'SUBMITTING';

  return (
    <div className="wizard">
      <ol className="steps" aria-label="Progress">
        <li aria-current={!reviewing ? 'step' : undefined} className={reviewing ? 'done' : undefined}>
          Configure
        </li>
        <li aria-current={reviewing ? 'step' : undefined}>Review &amp; submit</li>
      </ol>
      {error && <Notice tone="bad">{error}</Notice>}
      {phase === 'UPLOADING' && upload && (
        <Notice tone="info" title={`Uploading ${upload.name}`}>
          {upload.phase} · {bytes(upload.doneBytes)} / {bytes(upload.size)}. The dataset is added to this workflow when
          the verified upload finishes.
        </Notice>
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
          <RunChoice value={choice} managed onChange={(c, m) => choose(c, m, onSwitch)} />
          {(presets?.length ?? 0) > 0 && (
            <div className="toolbar">
              <span className="spacer" />
              <label className="field inline">
                <span>Load preset</span>
                <select value="" onChange={(e) => loadPreset(e.target.value)}>
                  <option value="">Choose…</option>
                  {presets?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="grid-2">
            <Field label="Project folder on ICF" field="projectDir" issues={issues}>
              <div className="input-row">
                <input
                  id="w-projectDir"
                  className="mono"
                  value={draft.projectDir}
                  onChange={(e) => set('projectDir', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setPicker({
                      kind: 'dir',
                      title: 'Choose the project folder',
                      start: project || null,
                      onPick: (p) => set('projectDir', p),
                    })
                  }
                >
                  Browse…
                </button>
              </div>
              <Resolved value={draft.projectDir} home={home} />
            </Field>
            {draft.kind !== 'gpu_smoke_test' && (
              <Field
                label={draft.kind === 'notebook' ? 'Notebook (.ipynb)' : 'Script'}
                field="entry"
                issues={issues}
                help="Relative to the project folder, or choose it on ICF"
              >
                <div className="input-row">
                  <input
                    id="w-entry"
                    className="mono"
                    value={draft.entry}
                    onChange={(e) => set('entry', e.target.value)}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setPicker({
                        kind: 'file',
                        title: draft.kind === 'notebook' ? 'Choose the notebook' : 'Choose the script',
                        start: project || null,
                        onPick: pickEntry,
                      })
                    }
                  >
                    Browse…
                  </button>
                </div>
              </Field>
            )}
          </div>
          <Field
            label="Python interpreter on ICF"
            field="interpreter"
            issues={issues}
            help="Full path or ~/…, e.g. ~/projects/icf-env/bin/python — or choose one in Projects → Python environment"
          >
            <input
              id="w-interpreter"
              className="mono"
              value={draft.interpreter}
              onChange={(e) => set('interpreter', e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
            />
            <Resolved value={draft.interpreter} home={home} />
          </Field>

          <h3>GPU</h3>
          <div className="grid-2">
            <Field label="Partition" field="partition" issues={issues}>
              <select id="w-partition" value={partition?.name ?? ''} onChange={(e) => set('partition', e.target.value)}>
                {snapshot.partitions.map((p) => (
                  <option key={p.name} value={p.name} disabled={p.eligibility === 'not_permitted'}>
                    {p.name}
                    {p.isDefault ? ' (default)' : ''}
                    {p.eligibility === 'not_permitted' ? ' — not permitted' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="GPU type"
              field="gresType"
              issues={issues}
              help={`Potentially free at ${formatTime(snapshot.fetchedAt)}; not a reservation`}
            >
              <select id="w-gresType" value={gres} onChange={(e) => set('gres', e.target.value)}>
                {gpuTypes.map((t) => (
                  <option key={t.gresName} value={t.gresName}>
                    {t.modelLabel}
                    {nominalVram(t.gresName) ? ` (${nominalVram(t.gresName)})` : ''} — {t.potentiallyFree} free /{' '}
                    {t.configured}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid-2">
            <Field label="GPUs" field="gpuCount" issues={issues} help={`Max ${maxGpus} on one node`}>
              <NumberInput
                id="w-gpuCount"
                min={1}
                max={maxGpus}
                value={draft.gpuCount}
                onChange={(n) => set('gpuCount', n)}
              />
            </Field>
            <Field label="Wall time" field="timeLimitSeconds" issues={issues}>
              <div className="input-row" id="w-timeLimitSeconds">
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

          <details className="fold-section" open={openFor(DATA_FIELDS)}>
            <summary>Datasets{draft.datasets.length > 0 ? ` (${draft.datasets.length})` : ''}</summary>
            <p className="muted small">
              Archives are copied from /home (NFS) to a private folder on the compute node's local disk, checked (no
              absolute or <code>..</code> paths, no links leaving the folder, no devices, no archive bombs) and only
              then unpacked. The scratch folder exists only inside the job and is deleted when it ends.
            </p>
            <Field label="Dataset archives" field="datasets" issues={issues}>
              <div className="dataset-list">
                {draft.datasets.map((d, i) => (
                  <div key={i}>
                    <div className="input-row">
                      <input
                        aria-label={`Archive ${i + 1}`}
                        className="mono"
                        value={d.archive}
                        onChange={(e) => setDataset(i, { archive: e.target.value })}
                      />
                      <span className="muted">→ data/</span>
                      <input
                        aria-label={`Folder name for archive ${i + 1}`}
                        className="mono short"
                        value={d.into}
                        onChange={(e) => setDataset(i, { into: e.target.value })}
                      />
                      <button
                        type="button"
                        className="btn ghost icon-btn"
                        aria-label={`Remove archive ${i + 1}`}
                        onClick={() => removeDataset(i)}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <Resolved value={d.archive} home={home} />
                  </div>
                ))}
                <div className="actions start">
                  <button
                    type="button"
                    className="btn"
                    disabled={draft.datasets.length >= 4}
                    onClick={() =>
                      setPicker({
                        kind: 'file',
                        archives: true,
                        title: 'Choose a dataset archive on ICF',
                        start: project || null,
                        onPick: addDataset,
                      })
                    }
                  >
                    Add archive on ICF…
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!project || phase === 'UPLOADING' || draft.datasets.length >= 4}
                    onClick={() => void uploadArchive()}
                  >
                    Upload an archive from this Mac…
                  </button>
                </div>
              </div>
            </Field>
            <div className="grid-2">
              <Field label="Scratch location" field="scratchRoot" issues={issues}>
                <select
                  id="w-scratchRoot"
                  value={draft.scratchRoot}
                  onChange={(e) => set('scratchRoot', e.target.value as Draft['scratchRoot'])}
                >
                  <option value="disk_scratch">/disk/scratch/&lt;you&gt;/… (ICF node-local disk)</option>
                  <option value="slurm_tmpdir">$SLURM_TMPDIR (if the site provides it)</option>
                </select>
              </Field>
              <Field
                label="Space to reserve for outputs (GB)"
                field="expectedOutputGib"
                issues={issues}
                help="Staging fails early if the node's scratch disk cannot hold data plus this"
              >
                <NumberInput
                  id="w-expectedOutputGib"
                  min={0}
                  value={draft.expectedOutputGib}
                  onChange={(n) => set('expectedOutputGib', n)}
                />
              </Field>
            </div>
          </details>

          <details className="fold-section" open={!!draft.resumeFrom || openFor(RESULT_FIELDS)}>
            <summary>Results and checkpoints</summary>
            <div className="grid-2">
              <Field
                label="Results folder"
                field="resultsRoot"
                issues={issues}
                help={`Each run gets <folder>/<job name>-<job id>; default ${project || '<project>'}/runs`}
              >
                <input
                  id="w-resultsRoot"
                  className="mono"
                  value={draft.resultsRoot}
                  placeholder={project ? `${project}/runs` : ''}
                  onChange={(e) => set('resultsRoot', e.target.value)}
                />
                <Resolved value={draft.resultsRoot} home={home} />
              </Field>
              <Field label="Checkpoints" field="checkpointMode" issues={issues}>
                <select
                  id="w-checkpointMode"
                  value={draft.checkpointMode}
                  onChange={(e) => set('checkpointMode', e.target.value as CheckpointMode)}
                >
                  <option value="scratch_sync">Scratch, copied to /home periodically (recommended)</option>
                  <option value="direct">Directly in /home (durable at once, more NFS load)</option>
                  <option value="none">Scratch only, copied at the end (lost if the node fails)</option>
                </select>
              </Field>
            </div>
            <div className="grid-4">
              {draft.checkpointMode === 'scratch_sync' && (
                <Field label="Sync every (minutes)" field="checkpointSyncMinutes" issues={issues}>
                  <NumberInput
                    id="w-checkpointSyncMinutes"
                    min={5}
                    max={720}
                    value={draft.checkpointSyncMinutes}
                    onChange={(n) => set('checkpointSyncMinutes', n)}
                  />
                </Field>
              )}
              <Field
                label="Copy-back warning (s)"
                field="signalGraceSeconds"
                issues={issues}
                help="SIGTERM to your program this long before the time limit"
              >
                <NumberInput
                  id="w-signalGraceSeconds"
                  min={60}
                  max={1800}
                  value={draft.signalGraceSeconds}
                  onChange={(n) => set('signalGraceSeconds', n)}
                />
              </Field>
            </div>
            <Field
              label="Resume from checkpoint (optional)"
              field="resumeFrom"
              issues={issues}
              help="Exported as $ICFCC_RESUME_FROM and {resume}"
            >
              <input
                id="w-resumeFrom"
                className="mono"
                value={draft.resumeFrom}
                onChange={(e) => set('resumeFrom', e.target.value)}
              />
              <Resolved value={draft.resumeFrom} home={home} />
            </Field>
            <Notice tone="info">
              Checkpoints and outputs survive only if they reach /home: the job copies them back at the end, on failure,
              on cancellation and before the time limit, but nothing can be copied from a node that has failed. Write
              checkpoints to <code>$ICFCC_CHECKPOINT_DIR</code> and results to <code>$ICFCC_OUTPUT_DIR</code>.
            </Notice>
          </details>

          <details className="fold-section" open={openFor(MORE_FIELDS)}>
            <summary>More options</summary>
            <p className="muted small">The defaults suit most runs.</p>
            <div className="grid-2">
              <Field label="Job name" field="jobName" issues={issues} help="Letters, digits, . _ -">
                <input
                  id="w-jobName"
                  value={draft.jobName}
                  onChange={(e) => set('jobName', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="CUDA toolchain"
                field="toolchain"
                issues={issues}
                help="Sourced in the job only if it exists then; never installed or upgraded"
              >
                <select id="w-toolchain" value={draft.toolchainId} onChange={(e) => set('toolchainId', e.target.value)}>
                  <option value="">None (virtualenv only)</option>
                  {tcList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {draft.kind === 'train' && (
              <Field
                label="Arguments (one per line)"
                field="args"
                issues={issues}
                help={
                  <>
                    Passed literally. Placeholders: <code>{'{data}'}</code> <code>{'{outputs}'}</code>{' '}
                    <code>{'{checkpoints}'}</code> <code>{'{scratch}'}</code> <code>{'{run_dir}'}</code>{' '}
                    <code>{'{resume}'}</code> (also available as $ICFCC_DATA_DIR etc.)
                  </>
                }
              >
                <textarea
                  id="w-args"
                  rows={3}
                  className="mono"
                  value={draft.args}
                  onChange={(e) => set('args', e.target.value)}
                  spellCheck={false}
                />
              </Field>
            )}
            <div className="grid-2">
              <Field label="CPUs" field="cpus" issues={issues}>
                <NumberInput id="w-cpus" min={1} value={draft.cpus} onChange={(n) => set('cpus', n)} />
              </Field>
              <Field label="RAM (GB)" field="memoryMib" issues={issues}>
                <NumberInput id="w-memoryMib" min={1} value={draft.memoryGb} onChange={(n) => set('memoryGb', n)} />
              </Field>
            </div>
            <Field
              label="Modules to check"
              field="checkModules"
              issues={[]}
              help="Imports each one with this Python on the login node, without the CUDA toolchain. Read-only; nothing is installed."
            >
              <div className="input-row">
                <input
                  id="w-checkModules"
                  className="mono"
                  value={checkModules}
                  onChange={(e) => set('checkModules', e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={checking || !interpreter}
                  onClick={() => void checkEnv()}
                >
                  {checking ? 'Checking…' : 'Check environment'}
                </button>
              </div>
            </Field>
            {envCheck?.interpreter === interpreter && envCheck.error && <Notice tone="bad">{envCheck.error}</Notice>}
            {envCheck?.interpreter === interpreter && envCheck.results && (
              <ImportReport interpreter={interpreter} results={envCheck.results} />
            )}
            <div className="grid-2">
              <Field label="Hugging Face cache" field="hfCache" issues={issues}>
                <select
                  id="w-hfCache"
                  value={draft.hfMode}
                  onChange={(e) => set('hfMode', e.target.value as Draft['hfMode'])}
                >
                  <option value="scratch">On scratch (fast; downloads again each job)</option>
                  <option value="home">Persistent folder in /home (download once; NFS)</option>
                  <option value="staged">Stage a packed cache archive to scratch</option>
                  <option value="off">Leave HF variables alone</option>
                </select>
              </Field>
              {draft.hfMode === 'home' && (
                <Field label="HF_HOME folder" field="hfCache" issues={[]}>
                  <input
                    className="mono"
                    value={draft.hfPath}
                    onChange={(e) => set('hfPath', e.target.value)}
                    placeholder={`${project}/hf-cache`}
                  />
                  <Resolved value={draft.hfPath} home={home} />
                </Field>
              )}
              {draft.hfMode === 'staged' && (
                <Field label="Cache archive" field="hfCache" issues={[]}>
                  <input className="mono" value={draft.hfArchive} onChange={(e) => set('hfArchive', e.target.value)} />
                  <Resolved value={draft.hfArchive} home={home} />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.hfOffline}
                      onChange={(e) => set('hfOffline', e.target.checked)}
                    />
                    Offline mode (no downloads)
                  </label>
                </Field>
              )}
            </div>
            <Field label="Environment variables (NAME=value per line)" field="env" issues={issues}>
              <textarea
                id="w-env"
                rows={2}
                className="mono"
                value={draft.env}
                onChange={(e) => set('env', e.target.value)}
                spellCheck={false}
              />
            </Field>
            <MailOption draft={draft} issues={issues} set={set} id="w-mailUser" />
            <div className="input-row">
              <label className="sr-only" htmlFor="preset-label">
                Preset name
              </label>
              <input
                id="preset-label"
                placeholder="Preset name"
                value={presetLabel}
                onChange={(e) => setPresetLabel(e.target.value)}
              />
              <button
                type="button"
                className="btn ghost"
                disabled={!presetLabel.trim()}
                onClick={() => void savePreset()}
              >
                Save as preset
              </button>
            </div>
          </details>
          {issues.some((i) => !i.field) && (
            <Notice tone="bad">
              {issues
                .filter((i) => !i.field)
                .map((i) => i.message)
                .join(' ')}
            </Notice>
          )}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={phase !== 'DRAFT' || !gres}>
              {phase === 'VALIDATING' ? 'Checking…' : 'Review workflow'}
            </button>
          </div>
        </form>
      ) : (
        <section className="card" aria-labelledby="wf-review-title">
          <h2 id="wf-review-title">Review the exact batch script</h2>
          <p className="muted small">
            This is byte for byte what goes to <code>sbatch</code> (checksum <code>{preview.checksum}</code>), submitted
            once.
          </p>
          <dl className="kv">
            <dt>Run folder</dt>
            <dd className="mono">{preview.runDirPattern}</dd>
            <dt>Logs</dt>
            <dd className="mono">{preview.logPattern}</dd>
            <dt>Scratch (inside the job only)</dt>
            <dd className="mono">{preview.scratchPattern}</dd>
            <dt>Wall time</dt>
            <dd>{preview.timeLimit}</dd>
          </dl>
          <details>
            <summary>Checks on ICF right before sbatch ({preview.prechecks.length})</summary>
            <ul className="small mono">
              {preview.prechecks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </details>
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
            <button className="btn" onClick={backToEdit}>
              Back to edit
            </button>
            <button
              className="btn primary"
              onClick={() => setConfirming(true)}
              disabled={preview.acknowledgements.length > 0 && !ack}
            >
              Submit workflow…
            </button>
          </div>
        </section>
      )}

      {confirming && preview && (
        <Dialog title="Submit this workflow to SLURM?" onClose={() => phase !== 'SUBMITTING' && setConfirming(false)}>
          <p>
            Queues one real job <strong>{effective.jobName}</strong> on <strong>{effective.partition}</strong>{' '}
            requesting {effective.gpuCount} × {gres}, {effective.cpus} CPUs, {effective.memoryGb} GB RAM for{' '}
            {preview.timeLimit}. It is submitted exactly once and keeps running if you close this app.
          </p>
          <div className="actions">
            <button
              className="btn"
              onClick={() => setConfirming(false)}
              disabled={phase === 'SUBMITTING'}
              data-autofocus
            >
              Cancel
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={phase === 'SUBMITTING'}>
              {phase === 'SUBMITTING' ? 'Submitting…' : 'Submit to SLURM'}
            </button>
          </div>
        </Dialog>
      )}
      {picker && (
        <PickRemote
          status={status}
          start={picker.start}
          kind={picker.kind}
          title={picker.title}
          filter={picker.archives ? (e) => isArchiveName(e.name) : undefined}
          onPick={(p) => {
            picker.onPick(p);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
