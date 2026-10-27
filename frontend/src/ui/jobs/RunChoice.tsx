import type { RunChoice as Choice } from '../../logic/jobs/newJob';

const CHOICES: { id: Choice; label: string; help: string }[] = [
  { id: 'python', label: 'Python script', help: 'Runs a .py file with your Python environment.' },
  {
    id: 'bash',
    label: 'Shell script',
    help: 'Runs a .sh file with bash. A batch file with #SBATCH lines (such as a course’s .sbatch file) brings its GPU settings and commands with it.',
  },
  {
    id: 'commands',
    label: 'Commands',
    help: 'Type the commands you would type in a terminal on the GPU node. No script file needed.',
  },
  {
    id: 'notebook',
    label: 'Notebook',
    help: 'Runs a notebook top to bottom on the GPU node and saves the executed copy with the results. To run one cell at a time, use the Notebooks tab.',
  },
  {
    id: 'smoke',
    label: 'GPU test',
    help: 'Checks that a GPU node works with your Python: versions, torch.cuda.is_available(), the GPU model and a tiny matrix multiply.',
  },
];

/**
 * The first question on New job. Notebooks, the GPU test and managed training run as a training
 * workflow; the rest as a plain script job. Switching keeps what was entered.
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
      <span id="run-choice-label">What do you want to run?</span>
      <div className="segmented choice" role="radiogroup" aria-labelledby="run-choice-label">
        {CHOICES.map((c) => (
          <label key={c.id}>
            <input type="radio" name="run-choice" checked={value === c.id} onChange={() => onChange(c.id, managed)} />
            {c.label}
          </label>
        ))}
      </div>
      <small className="muted">{current.help}</small>
      {value === 'python' && (
        <label className="check">
          <input type="checkbox" checked={managed} onChange={(e) => onChange('python', e.target.checked)} />
          Managed training: stage datasets to fast scratch, keep checkpoints and copy results back
        </label>
      )}
    </div>
  );
}
