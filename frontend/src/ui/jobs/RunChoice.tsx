import { Icon, type IconName } from '../components/ui';
import type { RunChoice as Choice } from '../../logic/jobs/newJob';

const CHOICES: { id: Choice; label: string; icon: IconName; short: string; help: string }[] = [
  {
    id: 'python',
    label: 'Python script',
    icon: 'code',
    short: '.py file',
    help: 'Runs a .py file with your Python environment. A notebook (.ipynb) runs as a Notebook instead.',
  },
  {
    id: 'bash',
    label: 'Shell script',
    icon: 'file',
    short: '.sh or .sbatch',
    help: 'Runs a .sh file with bash. A batch file with #SBATCH lines (such as a course’s .sbatch file) brings its GPU settings and commands with it.',
  },
  {
    id: 'commands',
    label: 'Commands',
    icon: 'keyboard',
    short: 'Terminal, .cu, C/C++',
    help: 'Type the commands you would type in a terminal on the GPU node, no script file needed. CUDA (.cu) and C/C++ files run here too: choose one and the compile-and-run lines are filled in.',
  },
  {
    id: 'notebook',
    label: 'Notebook',
    icon: 'notebook',
    short: '.ipynb, top to bottom',
    help: 'Runs a notebook top to bottom on the GPU node and saves the executed copy with the results. To run one cell at a time, use the Notebooks tab.',
  },
  {
    id: 'smoke',
    label: 'GPU test',
    icon: 'chip',
    short: '10-minute check',
    help: 'Checks that a GPU node works with your Python: versions, torch.cuda.is_available(), the GPU model and a tiny matrix multiply.',
  },
];

/**
 * The first question on New job, as tiles. Notebooks, the GPU test and managed training run as a
 * training workflow; the rest as a plain script job. Switching keeps what was entered.
 */
export function RunChoice({
  value,
  managed,
  onChange,
}: {
  value: Choice;
  managed: boolean;
  onChange: (c: Choice, managed: boolean) => void;
}) {
  const current = CHOICES.find((c) => c.id === value) ?? CHOICES[0]!;
  return (
    <div className="field">
      <span id="run-choice-label" className="section-label">
        What do you want to run?
      </span>
      <div className="run-tiles" role="radiogroup" aria-labelledby="run-choice-label">
        {CHOICES.map((c) => (
          <label key={c.id} className={`run-tile${value === c.id ? ' selected' : ''}`}>
            <input
              type="radio"
              name="run-choice"
              aria-label={c.label}
              checked={value === c.id}
              onChange={() => onChange(c.id, managed)}
            />
            <span className="run-tile-icon" aria-hidden="true">
              <Icon name={c.icon} size={16} />
            </span>
            <strong>{c.label}</strong>
            <span className="muted small">{c.short}</span>
          </label>
        ))}
      </div>
      <small className="muted">{current.help}</small>
      {value === 'python' && (
        <label className="switch-row">
          <input
            type="checkbox"
            role="switch"
            checked={managed}
            onChange={(e) => onChange('python', e.target.checked)}
          />
          Managed training: stage datasets to fast scratch, keep checkpoints and copy results back
        </label>
      )}
    </div>
  );
}
