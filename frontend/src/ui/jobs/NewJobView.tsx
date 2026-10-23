import { EmptyState } from '../components/ui';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { TrainingWizard, type WizardInit } from '../training/TrainingWizard';
import { RequestGpuView } from './RequestGpuView';

export type JobMode = 'script' | 'workflow';

const MODES: { id: JobMode; label: string; help: string }[] = [
  {
    id: 'script',
    label: 'Script job',
    help: 'Runs your bash or Python script in a folder on /home. Your script handles its own data and results.',
  },
  {
    id: 'workflow',
    label: 'Training workflow',
    help: 'Training script, batch notebook or GPU smoke test: data staged to fast scratch, checkpoints synced, results copied back and verified.',
  },
];

/**
 * One place to start any GPU job. The two forms keep their own engines, drafts and confirmation
 * flows; this screen only chooses which one is shown (each draft is saved, so switching loses nothing).
 */
export function NewJobView({
  mode,
  setMode,
  status,
  snapshot,
  snapshotLoading,
  requestPartition,
  wizardInit,
  wizardKey,
  onOpenJobs,
  onOpenRun,
  onRefreshCluster,
}: {
  mode: JobMode;
  setMode: (m: JobMode) => void;
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  snapshotLoading: boolean;
  requestPartition: string | null;
  wizardInit: WizardInit | null;
  wizardKey: number;
  onOpenJobs: (jobId?: string) => void;
  onOpenRun: (tag: string) => void;
  onRefreshCluster: () => void;
}) {
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  return (
    <>
      <div className="field">
        <span id="job-mode-label">Kind of job</span>
        <div className="segmented choice" role="radiogroup" aria-labelledby="job-mode-label">
          {MODES.map((m) => (
            <label key={m.id}>
              <input type="radio" name="job-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              {m.label}
            </label>
          ))}
        </div>
        <small className="muted">{current.help}</small>
      </div>
      {mode === 'workflow' ? (
        <TrainingWizard
          key={wizardKey}
          status={status}
          snapshot={snapshot}
          init={wizardInit}
          onOpenRun={onOpenRun}
          onRefreshCluster={onRefreshCluster}
        />
      ) : snapshotLoading ? (
        <div className="skeleton" aria-busy="true">
          Loading cluster data…
        </div>
      ) : !snapshot ? (
        <EmptyState title="Data unavailable">
          The scheduler could not be queried, so partitions and GPU types are unknown. Try Refresh in a moment.
        </EmptyState>
      ) : (
        <RequestGpuView
          key={requestPartition ?? 'draft'}
          snapshot={snapshot}
          status={status}
          initialPartition={requestPartition}
          onOpenJobs={onOpenJobs}
        />
      )}
    </>
  );
}
