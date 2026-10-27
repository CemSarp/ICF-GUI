import { useState, type ReactNode } from 'react';
import { Badge, Dialog, Icon, NumberInput, type IconName } from '../components/ui';
import { granularityLabel } from '../../logic/cluster/gpu';
import { partitionGpus } from '../../logic/cluster/overview';
import { formatDuration, formatTime, nominalVram } from '../../logic/format';
import { crumbs, timePresets } from '../../logic/jobs/newJob';
import type { usePresets } from '../../logic/jobs/presets';
import type { ClusterSnapshot, Issue, Partition } from '../../types';
import { GpuBar } from '../cluster/GpuBar';

/* Parts both New job forms are built from, so a script job and a training workflow look the same. */

export function FieldError({ issues, field }: { issues: Issue[]; field: string }) {
  const mine = issues.filter((i) => i.field === field);
  if (!mine.length) return null;
  return (
    <span className="field-error" id={`err-${field}`} role="alert">
      {mine.map((i) => i.message).join(' ')}
    </span>
  );
}

export function Field({
  label,
  field,
  issues,
  help,
  prefix = 'f',
  children,
}: {
  label: string;
  field: string;
  issues: Issue[];
  help?: ReactNode;
  /** Input ids are `<prefix>-<field>`. */
  prefix?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${issues.some((i) => i.field === field) ? ' invalid' : ''}`}>
      <label htmlFor={`${prefix}-${field}`}>{label}</label>
      {children}
      {help && <small className="muted">{help}</small>}
      <FieldError issues={issues} field={field} />
    </div>
  );
}

/** A number with − and + buttons around it; `step` rounds to its multiples (RAM in 4 GB steps). */
export function Stepper({
  id,
  label,
  value,
  min = 1,
  max,
  step = 1,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n));
  return (
    <div className="stepper">
      <button
        type="button"
        className="step-btn"
        aria-label={`Fewer ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(Math.ceil(value / step) * step - step))}
      >
        −
      </button>
      <NumberInput id={id} min={min} max={max} value={value} onChange={onChange} />
      <button
        type="button"
        className="step-btn"
        aria-label={`More ${label}`}
        disabled={max !== undefined && value >= max}
        onClick={() => onChange(clamp(Math.floor(value / step) * step + step))}
      >
        +
      </button>
      {unit && <span className="muted small">{unit}</span>}
    </div>
  );
}

/** A folder path with each folder clickable: "run from here" for code that expects its project root. */
function Crumbs({ path, home, onPick }: { path: string; home: string; onPick?: (dir: string) => void }) {
  const list = crumbs(path, home);
  return (
    <p className="path-crumbs" title={`Runs in ${path}`}>
      <span className="muted">Runs in</span>
      {list.map(([label, dir], i) => (
        <span key={dir} className="path-crumb">
          {i > 0 && (
            <span className="muted" aria-hidden="true">
              ›
            </span>
          )}
          {i === list.length - 1 ? (
            <strong>{label}</strong>
          ) : onPick && label !== '/' ? (
            <button type="button" className="link" title={`Run from ${dir} instead`} onClick={() => onPick(dir)}>
              {label}
            </button>
          ) : (
            <span>{label}</span>
          )}
        </span>
      ))}
    </p>
  );
}

/**
 * A chosen file or folder on ICF, drawn as a card: what it is, where it runs, and its buttons.
 * Nothing to type: the buttons open the ICF file picker.
 */
export function PathCard({
  icon,
  label,
  title,
  empty,
  folder,
  home,
  onRunFrom,
  children,
}: {
  icon: IconName;
  label: string;
  title: string;
  /** Shown instead of the title when nothing is chosen yet. */
  empty: string;
  /** The folder it runs in, shown as a clickable path. */
  folder?: string;
  home: string;
  onRunFrom?: (dir: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`path-card${title ? '' : ' unset'}`} role="group" aria-label={label}>
      <span className="path-card-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div className="path-card-text">
        <span className="path-card-label">{label}</span>
        <strong className={title ? 'mono' : 'muted'}>{title || empty}</strong>
        {folder && <Crumbs path={folder} home={home} onPick={onRunFrom} />}
      </div>
      <div className="path-card-actions">{children}</div>
    </div>
  );
}

interface Resources {
  partition: string;
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  hours: number;
  minutes: number;
  mail: boolean;
  mailUser: string;
}

/**
 * Where and how big: partition and GPU type as tiles with live free counts, GPU count, time limit,
 * CPUs, RAM and the e-mail switch. The same on every kind of job.
 */
export function GpuPicker({
  snapshot,
  partition,
  gres,
  draft,
  maxGpus,
  learned,
  issues,
  patch,
  prefix,
}: {
  snapshot: ClusterSnapshot;
  partition: Partition;
  gres: string;
  draft: Resources;
  maxGpus: number;
  /** Partitions that accepted or rejected this user's last job from this Mac. */
  learned?: Map<string, 'accepted' | 'denied'>;
  issues: Issue[];
  patch: (p: Partial<Resources>) => void;
  prefix: string;
}) {
  const times = timePresets(partition.maxTimeSeconds);
  return (
    <section className="card form-card" aria-labelledby={`${prefix}-gpu-title`}>
      <div className="card-head">
        <h3 id={`${prefix}-gpu-title`}>GPU and resources</h3>
        <span className="muted small">Free counts from {formatTime(snapshot.fetchedAt)}, not a reservation</span>
      </div>

      <span className="section-label" id={`${prefix}-partition-label`}>
        Partition
      </span>
      <div className="tiles" role="radiogroup" aria-labelledby={`${prefix}-partition-label`}>
        {snapshot.partitions.map((p) => {
          const g = partitionGpus(p);
          const was = learned?.get(p.name);
          return (
            <label key={p.name} className={`tile${p.name === partition.name ? ' selected' : ''}`}>
              <input
                type="radio"
                name={`${prefix}-partition`}
                aria-label={p.name}
                checked={p.name === partition.name}
                disabled={p.eligibility === 'not_permitted'}
                onChange={() => patch({ partition: p.name })}
              />
              <span className="tile-title">
                {p.name}
                {p.isDefault && <Badge tone="info">Default</Badge>}
              </span>
              {g.configured > 0 ? (
                <span className="tile-big">
                  {g.free}
                  <small> of {g.configured} GPUs free</small>
                </span>
              ) : (
                <span className="tile-big muted">
                  <small>No GPUs</small>
                </span>
              )}
              <span className="tile-sub">
                Up to {formatDuration(p.maxTimeSeconds, p.maxTimeRaw)}
                {g.unknown > 0 && ` · ? ${g.unknown} unknown`}
              </span>
              {p.eligibility === 'not_permitted' && <span className="tile-sub">Not permitted for you</span>}
              {was === 'denied' && <span className="tile-sub warn-text">✕ Rejected your last job</span>}
              {was === 'accepted' && <span className="tile-sub">✓ Ran your last job</span>}
            </label>
          );
        })}
      </div>
      <FieldError issues={issues} field="partition" />

      <fieldset className="tiles-set">
        <legend className="section-label">GPU type in {partition.name}</legend>
        {partition.gpuTotals.length === 0 ? (
          <p className="muted">No GPUs in this partition.</p>
        ) : (
          <div className="tiles">
            {partition.gpuTotals.map((t) => {
              const vram = nominalVram(t.gresName);
              return (
                <label key={t.gresName} className={`tile${gres === t.gresName ? ' selected' : ''}`} title={t.gresName}>
                  <input
                    type="radio"
                    name={`${prefix}-gres`}
                    aria-label={`${t.modelLabel}${vram ? ` ${vram}` : ''}`}
                    checked={gres === t.gresName}
                    onChange={() => patch({ gres: t.gresName })}
                  />
                  <span className="tile-title">{t.modelLabel}</span>
                  <span className="tile-sub">
                    {vram ? `${vram} VRAM` : granularityLabel(t.granularity)}
                    {t.granularity === 'mig' && ` · ${granularityLabel(t.granularity)}`}
                  </span>
                  <span className="tile-big">
                    {t.potentiallyFree}
                    <small> of {t.configured} free</small>
                  </span>
                  <GpuBar t={t} compact />
                </label>
              );
            })}
          </div>
        )}
        <FieldError issues={issues} field="gresType" />
      </fieldset>

      <div className="res-row">
        <Field label="GPUs" field="gpuCount" issues={issues} prefix={prefix} help={`Up to ${maxGpus} on one node`}>
          <Stepper
            id={`${prefix}-gpuCount`}
            label="GPUs"
            min={1}
            max={maxGpus}
            value={draft.gpuCount}
            onChange={(n) => patch({ gpuCount: n })}
          />
        </Field>
        <Field label="CPUs" field="cpus" issues={issues} prefix={prefix}>
          <Stepper id={`${prefix}-cpus`} label="CPUs" value={draft.cpus} onChange={(n) => patch({ cpus: n })} />
        </Field>
        <Field label="RAM (GB)" field="memoryMib" issues={issues} prefix={prefix}>
          <Stepper
            id={`${prefix}-memoryMib`}
            label="GB of RAM"
            step={4}
            value={draft.memoryGb}
            onChange={(n) => patch({ memoryGb: n })}
          />
        </Field>
      </div>
      <div className={`field${issues.some((i) => i.field === 'timeLimitSeconds') ? ' invalid' : ''}`}>
        <span id={`${prefix}-time-label`}>Time limit</span>
        <div className="time-line">
          <div className="chips" role="group" aria-labelledby={`${prefix}-time-label`}>
            {times.map((t) => (
              <button
                key={t.label}
                type="button"
                className="chip"
                aria-pressed={draft.hours === t.hours && draft.minutes === t.minutes}
                onClick={() => patch({ hours: t.hours, minutes: t.minutes })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="input-row time-row" id={`${prefix}-timeLimitSeconds`}>
            <NumberInput aria-label="Hours" min={0} value={draft.hours} onChange={(n) => patch({ hours: n })} />
            <span className="muted">h</span>
            <NumberInput
              aria-label="Minutes"
              min={0}
              max={59}
              value={draft.minutes}
              onChange={(n) => patch({ minutes: n })}
            />
            <span className="muted">min</span>
          </div>
        </div>
        <small className="muted">The job is stopped after this.</small>
        <FieldError issues={issues} field="timeLimitSeconds" />
      </div>
      {draft.gpuCount > 1 && (
        <p className="muted small">More GPUs usually means a longer wait in the queue. Make sure your code uses all.</p>
      )}
      <MailOption draft={draft} issues={issues} patch={patch} id={`${prefix}-mailUser`} />
    </section>
  );
}

/** SLURM's own e-mail when the job ends or fails; it arrives even while this app is closed. */
function MailOption({
  draft,
  issues,
  patch,
  id,
}: {
  draft: { mail: boolean; mailUser: string };
  issues: Issue[];
  patch: (p: { mail?: boolean; mailUser?: string }) => void;
  id: string;
}) {
  return (
    <div className={`field mail${issues.some((i) => i.field === 'mailUser') ? ' invalid' : ''}`}>
      <label className="switch-row">
        <input type="checkbox" role="switch" checked={draft.mail} onChange={(e) => patch({ mail: e.target.checked })} />
        E-mail me when the job ends or fails
      </label>
      {draft.mail && (
        <>
          <label htmlFor={id} className="sr-only">
            E-mail address
          </label>
          <input
            id={id}
            type="email"
            className="mono"
            value={draft.mailUser}
            placeholder="E-mail address, e.g. s1234567@ed.ac.uk"
            onChange={(e) => patch({ mailUser: e.target.value })}
            autoCapitalize="off"
            spellCheck={false}
          />
          <small className="muted">SLURM sends it itself, so it arrives even while this app is closed.</small>
        </>
      )}
      <FieldError issues={issues} field="mailUser" />
    </div>
  );
}

/** Load, save, update, rename and delete presets (GPU, resources, name, e-mail, folder and file). */
export function PresetBar({ presets: p }: { presets: ReturnType<typeof usePresets> }) {
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
  const [label, setLabel] = useState('');
  const [deleting, setDeleting] = useState(false);
  const name = (as: 'new' | 'rename') => {
    setLabel(as === 'rename' ? (p.loaded?.label ?? '') : '');
    setNaming(as);
  };
  const save = () => {
    if (!label.trim()) return;
    void (naming === 'rename' ? p.rename(label) : p.saveNew(label));
    setNaming(null);
  };
  return (
    <div className="preset-bar">
      <label htmlFor="preset-select">Preset</label>
      <select id="preset-select" value={p.loaded?.id ?? ''} onChange={(e) => p.choose(e.target.value)}>
        <option value="">{p.presets.length ? 'None' : 'No presets yet'}</option>
        {p.presets.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {p.loaded && (
        <>
          <button type="button" className="btn small-btn" onClick={() => void p.update()}>
            Save changes
          </button>
          <button type="button" className="btn ghost small-btn" onClick={() => name('rename')}>
            Rename
          </button>
          <button type="button" className="btn ghost danger small-btn" onClick={() => setDeleting(true)}>
            Delete
          </button>
        </>
      )}
      <button type="button" className="btn ghost small-btn" onClick={() => name('new')}>
        <Icon name="plus" size={14} />
        New preset
      </button>
      {p.loaded && <span className="muted small">Saved {formatTime(p.loaded.savedAt)}</span>}
      {naming && (
        <div className="input-row preset-name">
          <label className="sr-only" htmlFor="preset-label">
            Preset name
          </label>
          <input
            id="preset-label"
            placeholder={naming === 'new' ? 'Name for these settings' : 'New name'}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault(); // not the form's Review
                save();
              }
            }}
          />
          <button type="button" className="btn primary small-btn" disabled={!label.trim()} onClick={save}>
            {naming === 'new' ? 'Save preset' : 'Save name'}
          </button>
          <button type="button" className="btn small-btn" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </div>
      )}
      {p.error && (
        <span className="field-error" role="alert">
          {p.error}
        </span>
      )}
      {deleting && p.loaded && (
        <Dialog title={`Delete the preset “${p.loaded.label}”?`} onClose={() => setDeleting(false)}>
          <p>It is removed from this Mac. Jobs already submitted with it are not affected.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setDeleting(false)} data-autofocus>
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                void p.remove();
                setDeleting(false);
              }}
            >
              Delete preset
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
