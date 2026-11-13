import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { projectFor } from '../jobs/projectEnv';
import { useJobs } from '../jobs/useJobs';
import { useNow, usePersistentState } from '../persist';
import { recentKey } from '../projects/useProjects';
import type { ConnectionStatus, DevTask, ProjectRecord, RunRecord } from '../../types';
import {
  environmentNote,
  findSession,
  isActiveRun,
  newTaskId,
  pollDelay,
  sessionEnded,
  sessionRequest,
  UNKNOWN_GIVE_UP_MS,
} from './workbench';
import { analyze } from './diagnostics';
import { filesToRead, suggestions, usesPytest } from './discovery';

const CLIENT_CAP = 512 * 1024; // at most ~512 KB of one run's output in view

export interface RunOutput {
  runId: string | null;
  text: string;
  /** Older output was dropped from view, or only the end of the file was read. */
  trimmed: boolean;
  note: string | null;
  error: string | null;
  loaded: boolean;
}

const noOutput: RunOutput = { runId: null, text: '', trimmed: false, note: null, error: null, loaded: false };

export const runsKey = (status: ConnectionStatus, path: string) => [
  'wb-runs',
  status.profileId,
  path,
  status.connectedAt,
];

/**
 * One project's GPU Workbench: its session (from receipts + the jobs list the app already polls),
 * its tasks (stored locally per project), and its runs. While a run is queued or running and the
 * window is visible, the oldest such run — the one the session is working on — is read every
 * 2–10 s from its files on ICF; nothing is read while hidden, and nothing ever asks SLURM.
 */
export function useWorkbench(status: ConnectionStatus, project: ProjectRecord) {
  const qc = useQueryClient();
  const path = project.path;
  const home = status.capabilities?.home ?? '';
  const jobs = useJobs(status);
  const receipts = useQuery({ queryKey: ['receipts', status.connectedAt], queryFn: api.jobsReceipts, retry: false });
  const toolchains = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const key = runsKey(status, path);
  const runs = useQuery({ queryKey: key, queryFn: () => api.workbenchRuns(path), retry: false });
  const list = jobs.data?.list ?? null;
  const session = findSession(path, receipts.data ?? [], list);
  const allRuns = runs.data ?? [];
  const tasks = project.tasks ?? [];

  // ---- tasks ----
  const [taskError, setTaskError] = useState<string | null>(null);
  const saveTasks = async (next: DevTask[]) => {
    setTaskError(null);
    try {
      await api.workbenchSaveTasks(path, next);
      await qc.invalidateQueries({ queryKey: recentKey(status) });
      return true;
    } catch (e) {
      setTaskError(errorMessage(e));
      return false;
    }
  };
  /** Adds (empty id) or replaces a task. */
  const saveTask = (t: DevTask) => {
    const ids = tasks.map((x) => x.id);
    if (!t.id) return saveTasks([...tasks, { ...t, name: t.name.trim(), id: newTaskId(t.name, ids) }]);
    return saveTasks(tasks.map((x) => (x.id === t.id ? { ...t, name: t.name.trim() } : x)));
  };
  const duplicateTask = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return Promise.resolve(false);
    const name = `${t.name} (copy)`.slice(0, 60);
    return saveTasks([
      ...tasks,
      {
        ...t,
        name,
        id: newTaskId(
          name,
          tasks.map((x) => x.id),
        ),
      },
    ]);
  };
  const deleteTask = (id: string) => saveTasks(tasks.filter((x) => x.id !== id));

  // ---- runs ----
  const [selectedId, setSelectedId] = usePersistentState<string | null>(`wb.run.${path}`, null);
  const selected = allRuns.find((r) => r.id === selectedId) ?? allRuns[0] ?? null;
  const setRun = (r: RunRecord) =>
    qc.setQueryData<RunRecord[]>(key, (old) =>
      [r, ...(old ?? []).filter((x) => x.id !== r.id)].sort((a, b) => b.sentMs - a.sentMs),
    );

  const [sending, setSending] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Last run of a task that is still queued or running (its Run is disabled until it ends). */
  const activeRunOf = (taskId: string) => allRuns.find((r) => r.taskId === taskId && isActiveRun(r)) ?? null;
  /** One press = one block. A second press while the first is being handed over does nothing. */
  const run = async (taskId: string) => {
    if (sendingRef.current || session.kind !== 'running' || activeRunOf(taskId)) return false;
    sendingRef.current = true;
    setSending(taskId);
    setRunError(null);
    try {
      const r = await api.workbenchRun(path, taskId, session.jobId);
      setRun(r);
      setSelectedId(r.id);
      return true;
    } catch (e) {
      setRunError(errorMessage(e));
      return false;
    } finally {
      sendingRef.current = false;
      setSending(null);
    }
  };

  // ---- output and status reads ----
  const [output, setOutput] = useState<RunOutput>(noOutput);
  const offsets = useRef(new Map<string, number>());
  const reading = useRef(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  /** One status read. `fresh` re-reads the end of the output instead of what follows. */
  const read = async (r: RunRecord, fresh: boolean) => {
    if (reading.current) return;
    reading.current = true;
    const shown = selected?.id === r.id;
    const offset = fresh ? null : (offsets.current.get(r.id) ?? null);
    try {
      const res = await api.workbenchRunStatus(path, r.id, offset, sessionEnded(r, list));
      setPollError(null);
      setRun(res.run);
      if (res.chunk) offsets.current.set(r.id, res.chunk.next);
      if (shown)
        setOutput((o) => {
          const c = res.chunk;
          const same = o.runId === r.id && offset !== null && !c?.rotated;
          let text = c ? (same ? o.text + c.text : c.text) : same ? o.text : '';
          let trimmed = (same && o.trimmed) || (!!c && c.from > 0 && !same);
          if (text.length > CLIENT_CAP) {
            text = text.slice(text.length - CLIENT_CAP);
            trimmed = true;
          }
          return { runId: r.id, text, trimmed, note: res.logNote, error: null, loaded: true };
        });
    } catch (e) {
      const msg = errorMessage(e);
      setPollError(msg);
      if (shown) setOutput((o) => ({ ...o, runId: r.id, error: msg, loaded: true }));
    } finally {
      reading.current = false;
    }
  };
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  // Showing a run reads the end of its output once (also for finished runs).
  const selectedRunId = selected?.id ?? null;
  useEffect(() => {
    const r = allRuns.find((x) => x.id === selectedRunId);
    if (r) void readRef.current(r, true);
    // Once per run shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  // The run the session is working on: the oldest one still queued or running (blocks run in order).
  const now = useNow(60_000);
  const head =
    [...allRuns]
      .reverse()
      .find((r) => isActiveRun(r) && (r.status !== 'unknown' || now - r.sentMs < UNKNOWN_GIVE_UP_MS)) ?? null;
  const headId = head?.id ?? null;
  const headSent = head?.sentMs ?? 0;
  useEffect(() => {
    if (!headId || pollError) return;
    const t = setTimeout(
      () => {
        const r = (qc.getQueryData<RunRecord[]>(key) ?? []).find((x) => x.id === headId);
        if (r && document.visibilityState === 'visible')
          void readRef.current(r, false).then(() => setTick((n) => n + 1));
        else setTick((n) => n + 1);
      },
      pollDelay(Date.now() - headSent),
    );
    return () => clearTimeout(t);
    // `key` is derived from status/path; the read itself goes through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headId, headSent, tick, pollError]);

  const shownText = output.runId === selected?.id ? output.text : '';
  const analysis = useMemo(
    () => (selected ? analyze(shownText, selected.workingDir, path) : null),
    [shownText, selected, path],
  );
  const [noteError, setNoteError] = useState<string | null>(null);
  const setNote = async (runId: string, note: string) => {
    setNoteError(null);
    try {
      setRun(await api.workbenchSetNote(path, runId, note));
      return true;
    } catch (e) {
      setNoteError(errorMessage(e));
      return false;
    }
  };

  const toolchainList = toolchains.data ?? [];
  const previous = session.kind === 'none' ? null : session.request;

  return {
    session,
    jobs,
    tasks,
    taskError,
    saveTask,
    duplicateTask,
    deleteTask,
    runs: allRuns,
    runsError: runs.error ? errorMessage(runs.error) : null,
    selected,
    select: setSelectedId,
    output,
    /** Compiler errors, test counts and CUDA hints found in the shown output. */
    analysis,
    setNote,
    noteError,
    sending,
    runError,
    pollError,
    activeRunOf,
    run,
    /** The task of the newest run, if it still exists (⌘↩ runs it again). */
    lastTask: tasks.find((t) => t.id === allRuns[0]?.taskId) ?? null,
    /** Read the shown run again (and resume checking after an error). */
    refreshOutput: () => {
      setPollError(null);
      if (selected) void read(selected, true);
    },
    /** The request New job opens with for "Start GPU session" (reviewed there before submitting). */
    startRequest: () => sessionRequest(project, previous, toolchainList, home),
    envNote: environmentNote(project, toolchainList, home),
  };
}

/**
 * Suggested tasks from one listing of the project folder and, when present, its Makefile and
 * pytest configuration (read as text, never executed). Read once per project and connection.
 */
export function useSuggestions(status: ConnectionStatus, project: ProjectRecord) {
  const path = project.path;
  const q = useQuery({
    queryKey: ['wb-suggest', status.profileId, path, status.connectedAt],
    queryFn: async () => {
      const listing = await api.browse(path);
      const f = filesToRead(listing.entries);
      const read = (name: string) =>
        api.filesRead(`${path}/${name}`).then(
          (x) => x.content,
          () => null,
        );
      const [mk, py, cfg] = await Promise.all([
        f.makefile ? read(f.makefile) : null,
        f.pyproject ? read('pyproject.toml') : null,
        f.setupCfg ? read('setup.cfg') : null,
      ]);
      return {
        makefile: f.makefile && mk !== null ? { name: f.makefile, text: mk } : null,
        pytest: usesPytest(
          listing.entries.map((e) => e.name),
          py,
          cfg,
        ),
      };
    },
    retry: false,
    staleTime: Infinity,
  });
  return q.data ? suggestions(q.data.makefile, q.data.pytest, project.tasks ?? []) : [];
}

/** The opened project that holds `path` (the editor's file), if any. */
export function useProjectOf(status: ConnectionStatus, path: string): ProjectRecord | null {
  const recent = useQuery({ queryKey: recentKey(status), queryFn: api.projectsRecent, retry: false });
  return projectFor(path, recent.data ?? []);
}

/** The end of two runs' output for a side-by-side look (read once each, on request). */
export function useCompare(status: ConnectionStatus, path: string, ids: string[]) {
  const one = (id: string | undefined) => ({
    queryKey: ['wb-compare', status.profileId, path, id, status.connectedAt],
    queryFn: () => api.workbenchRunStatus(path, id!, null, false),
    enabled: !!id,
    retry: 1, // the run may have been read a moment ago (1 s floor)
    retryDelay: 1100,
    staleTime: Infinity,
  });
  const a = useQuery(one(ids[0]));
  const b = useQuery(one(ids[1]));
  const text = (q: typeof a) =>
    q.data ? (q.data.chunk?.text ?? q.data.logNote ?? '') : q.error ? errorMessage(q.error) : null;
  return [text(a), text(b)] as const;
}
