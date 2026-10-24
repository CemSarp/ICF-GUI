import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { maxGpusFor } from '../cluster/gpu';
import { usePersistentState } from '../persist';
import { recentKey } from '../projects/useProjects';
import { under } from './recent';
import type { ClusterSnapshot, ConnectionStatus, KernelPreview, KernelRequest, ProjectRecord } from '../../types';

export interface KernelDraft {
  partition: string;
  /** `gpu:<type>` as listed for the partition, or `gpu` (untyped). */
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  minutes: number;
  interpreter: string;
}

export const TIME_CHOICES = [15, 30, 60, 120, 240];
export const isInteractive = (name: string) => name.toLowerCase().includes('interactive');

/** The project (longest matching folder) a notebook belongs to, for its Python and toolchain. */
export function projectOf(path: string, projects: ProjectRecord[]): ProjectRecord | null {
  return projects.filter((p) => under(path, p.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/**
 * The Start kernel sheet: resources on an Interactive partition (remembered between notebooks),
 * the project's interpreter and toolchain, and the reviewed preview whose id starts the kernel.
 */
export function useKernelSetup(notebookPath: string, status: ConnectionStatus, snapshot: ClusterSnapshot | null) {
  const projects = useQuery({ queryKey: recentKey(status), queryFn: api.projectsRecent, retry: false });
  const toolchains = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const project = projectOf(notebookPath, projects.data ?? []);
  const partitions = (snapshot?.partitions ?? []).filter((p) => isInteractive(p.name));
  const [saved, setSaved] = usePersistentState<Omit<KernelDraft, 'interpreter'> | null>('kernel.resources', null);
  const [draft, setDraftState] = useState<KernelDraft | null>(null);
  const [preview, setPreview] = useState<KernelPreview | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const defaults = (): KernelDraft => {
    const p =
      partitions.find((x) => x.name === saved?.partition) ??
      partitions.find((x) => x.name === project?.partition) ??
      partitions[0];
    const types = p?.gpuTotals.map((t) => t.gresName) ?? [];
    const want = saved?.gres ?? (project?.gresType ? `gpu:${project.gresType}` : '');
    return {
      partition: p?.name ?? '',
      gres: types.includes(want) ? want : (types[0] ?? 'gpu'),
      gpuCount: saved?.gpuCount ?? 1,
      cpus: saved?.cpus ?? 4,
      memoryGb: saved?.memoryGb ?? 16,
      minutes: Math.min(saved?.minutes ?? 60, maxMinutes(p?.maxTimeSeconds ?? null)),
      interpreter: project?.interpreter ?? '',
    };
  };
  const base = draft ?? defaults();
  const partition = partitions.find((p) => p.name === base.partition);
  const gpuTypes = partition?.gpuTotals ?? [];
  // A partition change keeps the GPU type only if the new partition has it.
  const d = gpuTypes.some((t) => t.gresName === base.gres) ? base : { ...base, gres: gpuTypes[0]?.gresName ?? 'gpu' };
  const maxGpus = snapshot ? maxGpusFor(snapshot, partition, d.gres) : 1;
  const times = TIME_CHOICES.filter((m) => m <= maxMinutes(partition?.maxTimeSeconds ?? null));

  const setDraft = (patch: Partial<KernelDraft>) => {
    setDraftState({ ...d, ...patch });
    setPreview(null);
    setChecked(new Set());
  };

  const request = (): KernelRequest => {
    const tc = toolchains.data?.find((t) => t.id === project?.toolchainId);
    return {
      notebookPath,
      interpreter: d.interpreter.trim(),
      toolchain: tc ? tc.spec : { kind: 'none' },
      resources: {
        partition: d.partition,
        gresType: d.gres === 'gpu' ? null : d.gres.replace(/^gpu:/, ''),
        gpuCount: d.gpuCount,
        cpus: d.cpus,
        memoryMib: Math.round(d.memoryGb * 1024),
        timeLimitSeconds: d.minutes * 60,
      },
    };
  };

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.kernelPreview(request()));
      setChecked(new Set());
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { interpreter, ...resources } = d;
      setSaved(resources);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleAck = (i: number) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const reset = () => {
    setDraftState(null);
    setPreview(null);
    setChecked(new Set());
    setError(null);
  };
  const canStart = !!preview?.previewId && preview.acknowledgements.every((_, i) => checked.has(i));

  return {
    project,
    projectsLoading: projects.isLoading,
    partitions,
    partition,
    gpuTypes,
    maxGpus,
    times,
    draft: d,
    setDraft,
    review,
    preview,
    checked,
    toggleAck,
    canStart,
    error,
    busy,
    reset,
  };
}

function maxMinutes(maxTimeSeconds: number | null) {
  return maxTimeSeconds ? Math.floor(maxTimeSeconds / 60) : 240;
}
