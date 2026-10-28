import { Badge, Icon } from '../components/ui';
import { freestGpus, useJourney, type StepId } from '../../logic/app/journey';
import { formatTime, nominalVram } from '../../logic/format';
import type { View } from '../../logic/app/useAppShell';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';

const STEP_TEXT: Record<StepId, { title: string; text: string; action?: string }> = {
  connect: { title: 'Connect to ICF', text: 'You are signed in. Your Mac stays the place where you edit and watch.' },
  project: {
    title: 'Choose your project folder',
    text: 'Open the folder on ICF that holds your code, for example your homework. The app remembers it.',
    action: 'Open Projects',
  },
  gpuTest: {
    title: 'Check that a GPU works',
    text: 'A 10-minute test job: Python, PyTorch and a real NVIDIA GPU. It usually finishes a few minutes after it starts.',
    action: 'Run the GPU test',
  },
  submit: {
    title: 'Run your code on a GPU',
    text: 'New job: pick your .py, .sh or .sbatch file, or type commands such as make test1. Review, then submit.',
    action: 'Start a GPU job',
  },
  output: {
    title: 'Read the output',
    text: 'My Jobs → open the job → Load log. Turn on Follow to watch it while it runs.',
    action: 'Open My Jobs',
  },
  kernel: {
    title: 'Run code cell by cell',
    text: 'Start an interactive kernel in a notebook, or press Run on GPU in a .py or .cu file.',
    action: 'Open Notebooks',
  },
  transfer: {
    title: 'Copy files between your Mac and ICF',
    text: 'Upload a dataset or download your results, checked with SHA-256.',
    action: 'Open Transfers',
  },
  training: {
    title: 'Finish a managed training run',
    text: 'Datasets on fast scratch, checkpoints kept, results copied back to your folder.',
    action: 'Start one',
  },
};

/**
 * First screen: what the app is for, the next thing to do, a checklist of milestones (all worked
 * out from data on this Mac) and which GPUs are free now.
 */
export function StartView({
  status,
  snapshot,
  onGo,
  onGpuTest,
  onTraining,
}: {
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  onGo: (v: View) => void;
  onGpuTest: () => void;
  onTraining: () => void;
}) {
  const { steps, done, next, level, jobsSubmitted, gpuKinds } = useJourney(status);
  const free = freestGpus(snapshot);
  const act = (id: StepId) =>
    ({
      connect: () => undefined,
      project: () => onGo('projects'),
      gpuTest: onGpuTest,
      submit: () => onGo('request'),
      output: () => onGo('jobs'),
      kernel: () => onGo('notebooks'),
      transfer: () => onGo('transfers'),
      training: onTraining,
    })[id]();

  return (
    <div className="start">
      <section className="card start-hero">
        <div className="start-hero-text">
          <h2>Run your code on an NVIDIA GPU</h2>
          <p className="muted">
            Your Mac has no CUDA GPU; ICF has dozens. This app sends your code to a GPU node, runs it there and shows
            you the output, without a terminal.
          </p>
          <div className="actions start">
            <button className="btn primary" onClick={() => onGo('request')}>
              <Icon name="play" />
              Start a GPU job
            </button>
            <button className="btn" onClick={() => onGo('notebooks')}>
              <Icon name="notebook" />
              Open a notebook
            </button>
          </div>
        </div>
        <div className="score" aria-label={`${done} of ${steps.length} milestones done`}>
          <span className="score-level">{level}</span>
          <span className="score-count">
            {done}
            <span className="muted">/{steps.length}</span>
          </span>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${(done / steps.length) * 100}%` }} />
          </span>
          <span className="muted small">
            {jobsSubmitted} job{jobsSubmitted === 1 ? '' : 's'} submitted · {gpuKinds} GPU type
            {gpuKinds === 1 ? '' : 's'} tried
          </span>
        </div>
      </section>

      {next && (
        <section className="card next-step" aria-labelledby="next-title">
          <Badge tone="info">Next step</Badge>
          <div className="next-step-text">
            <h3 id="next-title">{STEP_TEXT[next.id].title}</h3>
            <p className="muted">{STEP_TEXT[next.id].text}</p>
          </div>
          {STEP_TEXT[next.id].action && (
            <button className="btn primary" onClick={() => act(next.id)}>
              {STEP_TEXT[next.id].action}
            </button>
          )}
        </section>
      )}

      <div className="start-grid">
        <section className="card" aria-labelledby="journey-title">
          <h3 id="journey-title">Your GPU milestones</h3>
          <ol className="journey">
            {steps.map((s, i) => (
              <li key={s.id} className={s.done ? 'done' : undefined}>
                <span className="journey-mark" aria-hidden="true">
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="journey-text">
                  <strong>{STEP_TEXT[s.id].title}</strong>
                  {s.optional && <span className="muted small"> · optional</span>}
                  <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                </span>
                {!s.done && STEP_TEXT[s.id].action && (
                  <button className="btn ghost small-btn" onClick={() => act(s.id)}>
                    {STEP_TEXT[s.id].action}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="card" aria-labelledby="free-title">
          <div className="card-head">
            <h3 id="free-title">Free right now</h3>
            {snapshot && <span className="muted small">{formatTime(snapshot.fetchedAt)}</span>}
          </div>
          {free.length === 0 ? (
            <p className="muted">No GPU data yet.</p>
          ) : (
            <ul className="free-list">
              {free.map((t) => (
                <li key={t.gresName}>
                  <span>
                    <strong>{t.modelLabel}</strong>
                    <span className="muted small"> {nominalVram(t.gresName) ?? ''}</span>
                  </span>
                  <span className={t.potentiallyFree > 0 ? 'free-count' : 'free-count none'}>
                    {t.potentiallyFree} free
                    <span className="muted"> / {t.configured}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Potentially free, not reserved: a job waits in the queue until one is.{' '}
            <button className="link" onClick={() => onGo('overview')}>
              See all GPUs
            </button>
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="where-title">
        <h3 id="where-title">Where your code runs</h3>
        <ol className="flow">
          <li>
            <strong>Your Mac</strong>
            <span className="muted small">Edit, choose what to run, review it, read the output.</span>
          </li>
          <li>
            <strong>ICF login node</strong>
            <span className="muted small">
              Holds your files and the queue. It has no GPU for you; never train here.
            </span>
          </li>
          <li>
            <strong>GPU node</strong>
            <span className="muted small">
              Your job runs here once SLURM gives it a GPU. Output goes to icfcc-run/slurm-&lt;job id&gt;.out in your folder.
            </span>
          </li>
        </ol>
      </section>
    </div>
  );
}
