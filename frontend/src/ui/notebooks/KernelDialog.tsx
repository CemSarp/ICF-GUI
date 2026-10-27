import { useKernelSetup } from '../../logic/notebooks/useKernelSetup';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { Dialog, Notice, NumberInput } from '../components/ui';

const hours = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

/**
 * Review sheet for one interactive kernel: resources on an Interactive partition, the project's
 * Python, then the exact srun line and the notices to confirm. Nothing starts until "Start kernel".
 */
export function KernelDialog({
  path,
  status,
  snapshot,
  onStart,
  onClose,
}: {
  path: string;
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  onStart: (previewId: string) => void;
  onClose: () => void;
}) {
  const s = useKernelSetup(path, status, snapshot);
  const d = s.draft;
  const times = s.times.includes(d.minutes) ? s.times : [...s.times, d.minutes].sort((a, b) => a - b);
  const p = s.preview;

  return (
    <Dialog title="Start an interactive kernel" labelledBy="kernel-title" onClose={onClose}>
      <p className="muted">
        The kernel runs on a GPU node through <code>srun</code> on an Interactive partition. It holds the GPU until you
        stop it, leave this page or disconnect, after 30 minutes without running code, or at the time limit. Cells and
        files in Python run in the kernel; CUDA, C++ and C are compiled and run on the same node.
      </p>
      {!snapshot && (
        <Notice tone="warn">Cluster data has not loaded yet. Open Overview and refresh, then try again.</Notice>
      )}
      {snapshot && s.partitions.length === 0 && (
        <Notice tone="warn">
          No Interactive partition is visible to your account in the current cluster data, so a kernel cannot start. Use
          a batch notebook run (New job → Training workflow → Notebook) instead.
        </Notice>
      )}
      <div className="kernel-form">
        <div className="field half">
          <label htmlFor="k-partition">Partition</label>
          <select
            id="k-partition"
            value={d.partition}
            onChange={(e) => s.setDraft({ partition: e.target.value, gres: '' })}
          >
            {s.partitions.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field half">
          <label htmlFor="k-gres">GPU type</label>
          <select id="k-gres" value={d.gres} onChange={(e) => s.setDraft({ gres: e.target.value })}>
            {s.gpuTypes.length === 0 && <option value="gpu">Any GPU</option>}
            {s.gpuTypes.map((t) => (
              <option key={t.gresName} value={t.gresName}>
                {t.modelLabel || t.gresName} · {t.potentiallyFree} of {t.configured} free
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="k-gpus">GPUs</label>
          <NumberInput
            id="k-gpus"
            min={1}
            max={s.maxGpus}
            value={d.gpuCount}
            onChange={(n) => s.setDraft({ gpuCount: Math.max(1, n) })}
          />
        </div>
        <div className="field">
          <label htmlFor="k-cpus">CPUs</label>
          <NumberInput id="k-cpus" min={1} value={d.cpus} onChange={(n) => s.setDraft({ cpus: Math.max(1, n) })} />
        </div>
        <div className="field">
          <label htmlFor="k-mem">Memory (GB)</label>
          <NumberInput
            id="k-mem"
            min={1}
            value={d.memoryGb}
            onChange={(n) => s.setDraft({ memoryGb: Math.max(1, n) })}
          />
        </div>
        <div className="field">
          <label htmlFor="k-time">Time limit</label>
          <select id="k-time" value={d.minutes} onChange={(e) => s.setDraft({ minutes: Number(e.target.value) })}>
            {times.map((m) => (
              <option key={m} value={m}>
                {hours(m)}
              </option>
            ))}
          </select>
        </div>
        <div className="field wide">
          <label htmlFor="k-python">Python (needs ipykernel)</label>
          <input
            id="k-python"
            className="mono"
            value={d.interpreter}
            placeholder="/home/s1234567/projects/icf-env/bin/python"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => s.setDraft({ interpreter: e.target.value })}
          />
          <span className="muted small">
            {s.project
              ? s.project.interpreter
                ? `From the project ${s.project.path.split('/').pop()} (Projects → Python environment).`
                : `The project ${s.project.path.split('/').pop()} has no Python environment chosen yet (Projects → Python environment).`
              : 'Open this folder in Projects to pick its Python environment there.'}
          </span>
        </div>
        <div className="field wide">
          <span>CUDA toolchain</span>
          <span className="muted small">
            {s.toolchain
              ? `${s.toolchain.label} is loaded on the node before the kernel starts (nvcc for CUDA).`
              : 'None chosen for this project: CUDA code needs one (Projects → Python environment → CUDA toolchain). C, C++ and Python work without.'}
          </span>
        </div>
      </div>

      {s.error && <Notice tone="bad">{s.error}</Notice>}
      {p && p.errors.length > 0 && (
        <Notice tone="bad" title="Fix these first">
          <ul>
            {p.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      {p?.previewId && (
        <div className="kernel-review">
          <h3>What will run on ICF</h3>
          <pre className="nb-srun mono">{p.command}</pre>
          {p.prechecks.length > 0 && <p className="muted small">Checked first: {p.prechecks.join('; ')}.</p>}
          {p.warnings.map((w, i) => (
            <Notice key={i} tone="warn">
              {w.message}
            </Notice>
          ))}
          <fieldset className="acks">
            <legend className="sr-only">Confirm</legend>
            {p.acknowledgements.map((a, i) => (
              <label key={i} className="check">
                <input type="checkbox" checked={s.checked.has(i)} onChange={() => s.toggleAck(i)} />
                {a}
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {p?.previewId ? (
          <button
            className="btn primary"
            disabled={!s.canStart}
            onClick={() => {
              onStart(p.previewId!);
              onClose();
            }}
          >
            Start kernel
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void s.review()}
            disabled={s.busy || !d.partition || !d.interpreter.trim()}
            data-autofocus
          >
            {s.busy ? 'Checking…' : 'Review'}
          </button>
        )}
      </div>
    </Dialog>
  );
}
