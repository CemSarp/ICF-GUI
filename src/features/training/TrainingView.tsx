import type { ClusterSnapshot, ConnectionStatus, WorkflowConfig } from '../../types';
import { RunsView } from './RunsView';
import { TrainingWizard, type WizardInit } from './TrainingWizard';

export type TrainingTab = 'new' | 'runs';

export function TrainingView({
  status,
  snapshot,
  tab,
  setTab,
  init,
  wizardKey,
  selectedRun,
  onSelectRun,
  onResume,
  onRefreshCluster,
}: {
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  tab: TrainingTab;
  setTab: (t: TrainingTab) => void;
  init: WizardInit | null;
  wizardKey: number;
  selectedRun: string | null;
  onSelectRun: (tag: string | null) => void;
  onResume: (config: WorkflowConfig) => void;
  onRefreshCluster: () => void;
}) {
  return (
    <div className="training">
      <div role="tablist" aria-label="Training" className="tabs page-tabs">
        <button role="tab" className="tab" aria-selected={tab === 'new'} onClick={() => setTab('new')}>
          New workflow
        </button>
        <button role="tab" className="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>
          Runs
        </button>
      </div>
      {tab === 'new' ? (
        <TrainingWizard
          key={wizardKey}
          status={status}
          snapshot={snapshot}
          init={init}
          onRefreshCluster={onRefreshCluster}
          onOpenRun={(tag) => {
            onSelectRun(tag);
            setTab('runs');
          }}
        />
      ) : (
        <RunsView status={status} selected={selectedRun} onSelect={onSelectRun} onResume={onResume} />
      )}
    </div>
  );
}
