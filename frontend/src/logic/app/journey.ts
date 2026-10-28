import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { wfState } from '../training/runs';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';

const KEY = 'icfcc.milestones';
/** Milestones the app's own data does not record; remembered on this Mac only. */
export type Marked = 'log' | 'kernel';

export function markMilestone(id: Marked) {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Marked, number>>;
    if (m[id]) return;
    localStorage.setItem(KEY, JSON.stringify({ ...m, [id]: Date.now() }));
  } catch {
    /* storage unavailable: the step just stays open */
  }
}

function marked(): Partial<Record<Marked, number>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Marked, number>>;
  } catch {
    return {};
  }
}

export type StepId = 'connect' | 'project' | 'gpuTest' | 'submit' | 'output' | 'kernel' | 'transfer' | 'training';
export interface Step {
  id: StepId;
  done: boolean;
  optional: boolean;
}

const LEVELS = ['Getting started', 'GPU beginner', 'GPU user', 'GPU regular', 'GPU pro'];

/**
 * The Start screen's checklist, worked out from what this Mac already stores (recent projects, job
 * receipts, the local run list, transfers) plus two remembered milestones. No ICF requests.
 */
export function useJourney(status: ConnectionStatus) {
  const k = [status.profileId, status.connectedAt];
  const q = { retry: false, staleTime: 30_000 } as const;
  const projects = useQuery({ queryKey: ['journey-projects', ...k], queryFn: api.projectsRecent, ...q });
  const receipts = useQuery({ queryKey: ['receipts', status.connectedAt], queryFn: api.jobsReceipts, ...q });
  const runs = useQuery({ queryKey: ['runs-local', ...k], queryFn: api.workflowRuns, ...q });
  const transfers = useQuery({ queryKey: ['journey-transfers', ...k], queryFn: api.transfers, ...q });
  const m = marked();
  const finished = (kind: string) => (runs.data ?? []).some((r) => r.kind === kind && wfState(r) === 'COMPLETED');
  const accepted = (receipts.data ?? []).filter((r) => r.status === 'accepted');

  const steps: Step[] = [
    { id: 'connect', done: true, optional: false },
    { id: 'project', done: (projects.data?.length ?? 0) > 0, optional: false },
    { id: 'gpuTest', done: finished('gpu_smoke_test'), optional: false },
    { id: 'submit', done: accepted.length > 0, optional: false },
    { id: 'output', done: !!m.log, optional: false },
    { id: 'kernel', done: !!m.kernel, optional: true },
    { id: 'transfer', done: (transfers.data ?? []).some((t) => t.phase === 'done'), optional: true },
    { id: 'training', done: finished('train'), optional: true },
  ];
  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    next: steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done) ?? null,
    level: LEVELS[Math.min(LEVELS.length - 1, Math.floor((done / steps.length) * (LEVELS.length - 1)))]!,
    jobsSubmitted: accepted.length,
    gpuKinds: new Set(accepted.map((r) => r.gres)).size,
  };
}

/** GPU types with the most potentially free GPUs right now (physical GPUs and MIG slices alike). */
export function freestGpus(snapshot: ClusterSnapshot | null, n = 4) {
  return [...(snapshot?.gpuTotals ?? [])]
    .filter((t) => t.configured > 0)
    .sort((a, b) => b.potentiallyFree - a.potentiallyFree)
    .slice(0, n);
}
