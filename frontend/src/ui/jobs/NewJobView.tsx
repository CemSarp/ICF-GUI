import { EmptyState } from '../components/ui';
import type { JobMode } from '../../logic/jobs/newJob';
import type { RunTarget } from '../../logic/jobs/jobRequest';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import type { WizardInit } from '../../logic/training/wizardDraft';
import { TrainingWizard } from '../training/TrainingWizard';
import { RequestGpuView } from './RequestGpuView';

/**
 * One place to start any GPU job. Both forms start with the same "What do you want to run?"
 * question; the answer picks the form (each keeps its own engine, draft and confirmation flow),
 * and values entered so far are carried across.
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
  runTarget,
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
  /** Projects' Run buttons: the folder or file New job opens on. */
  runTarget: RunTarget | null;
}) {
  return (
    <>
      {mode === 'workflow' ? (
        <TrainingWizard
          key={wizardKey}
          status={status}
          snapshot={snapshot}
          init={wizardInit}
          onOpenRun={onOpenRun}
          onRefreshCluster={onRefreshCluster}
          onSwitch={setMode}
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
          onSwitch={setMode}
          runTarget={runTarget}
        />
      )}
    </>
  );
}
