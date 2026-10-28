import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSnapshot } from '../cluster/useSnapshot';
import { isLive, useConnection } from '../connection/useConnection';
import { fileKind } from '../editor/languages';
import type { JobMode } from '../jobs/newJob';
import type { RunTarget } from '../jobs/jobRequest';
import { usePersistentState } from '../persist';
import type { PageGuard } from './guard';
import { useApplyTheme, type Theme } from '../settings/theme';
import type { WizardInit } from '../training/wizardDraft';
import type { JobRequest, Settings } from '../../types';

export type View =
  'home' | 'overview' | 'nodes' | 'request' | 'jobs' | 'projects' | 'notebooks' | 'training' | 'transfers' | 'settings';

/**
 * App-wide state: connection, settings, the cluster snapshot, which screen and item is open, and
 * navigation that is held back while the editor has unsaved changes, a notebook's kernel runs (or
 * VS Code uses the connection), and the notebook's full-screen mode.
 */
export function useAppShell() {
  const { status, challenges, setChallenges } = useConnection();
  const [settings, setSettings] = useState<Settings>({ pollIntervalSecs: 60 });
  const [savedView, setView] = usePersistentState<View | 'partitions'>('view', 'home');
  // Partitions became part of Cluster → Overview; a screen remembered from before opens there.
  const view: View = savedView === 'partitions' ? 'overview' : savedView;
  const [theme, setTheme] = usePersistentState<Theme>('theme', 'system');
  const [partitionFilter, setPartitionFilter] = usePersistentState('nodes.partition', '');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [requestPartition, setRequestPartition] = useState<string | null>(null);
  const [project, setProject] = usePersistentState<string | null>('project.selected', null);
  const [jobMode, setJobMode] = usePersistentState<JobMode>('newjob.mode', 'script');
  const [wizardInit, setWizardInit] = useState<{ init: WizardInit | null; key: number }>({ init: null, key: 0 });
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [uploadDir, setUploadDir] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [openNotebook, setOpenNotebook] = usePersistentState<string | null>('notebook.open', null);
  /** The open editor or notebook: unsaved edits and/or a running kernel that leaving would discard. */
  const [guard, setGuard] = useState<PageGuard | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  /** Navigation (or disconnect) held back while the editor has unsaved changes. */
  const [pendingLeave, setPendingLeave] = useState<View | 'disconnect' | null>(null);
  const qc = useQueryClient();
  const live = isLive(status);
  const snap = useSnapshot(status, settings.pollIntervalSecs);
  const share = useQuery({
    queryKey: ['vscode-share', status.connectedAt],
    queryFn: api.vscodeShareStatus,
    enabled: live && !status.demo,
    retry: false,
  });
  const vscodeInUse = !!share.data?.inUse;

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);
  useApplyTheme(theme);

  const setFocus = (on: boolean) => {
    setFocusMode(on);
    void api.setFullscreen(on);
  };
  const go = (v: View) => {
    setEditingFile(null);
    setGuard(null);
    if (focusMode) setFocus(false);
    setSelectedNode(null);
    setSelectedJob(null);
    setRequestPartition(null);
    if (v !== 'training') setSelectedRun(null);
    setView(v);
  };
  /** Projects' Run buttons: New job opens on this folder or file (as a script job). */
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null);
  const runOnGpu = (path: string, isDir: boolean, request?: JobRequest) => {
    setRunTarget((t) => ({
      path,
      isDir,
      key: Math.max(Date.now(), (t?.key ?? 0) + 1),
      ...(request ? { request } : {}),
    }));
    setJobMode('script');
    go('request');
  };
  /** A finished job's "Edit and run again": New job refilled with what was reviewed and submitted. */
  const runAgain = (request: JobRequest) => runOnGpu(request.workingDir, true, request);
  /** New job's "What do you want to run?" moved to the other form: it opens from its saved draft. */
  const switchJobMode = (m: JobMode) => {
    setWizardInit((w) => ({ init: null, key: w.key + 1 }));
    setJobMode(m);
  };
  const startTraining = (init: WizardInit) => {
    setWizardInit((w) => ({ init, key: w.key + 1 }));
    setJobMode('workflow');
    go('request');
  };
  const disconnect = () => {
    setEditingFile(null);
    setGuard(null);
    if (focusMode) setFocus(false);
    void api.disconnect().then(() => qc.clear());
  };
  const guarded = !!guard;
  /** Sidebar click: asks first while the editor has unsaved changes or a kernel runs. */
  const navigate = (v: View) => (v === view && v === 'notebooks' ? undefined : guarded ? setPendingLeave(v) : go(v));
  const requestDisconnect = () => (guarded || vscodeInUse ? setPendingLeave('disconnect') : disconnect());
  /** Project files: notebooks open in the Notebooks tab, other text files in the editor. */
  const openFile = (path: string) => {
    if (fileKind(path) !== 'notebook') return setEditingFile(path);
    setOpenNotebook(path);
    go('notebooks');
  };
  const confirmLeave = () => {
    const target = pendingLeave;
    setPendingLeave(null);
    if (target === 'disconnect') disconnect();
    else if (target) go(target);
  };
  const openNodes = (partition: string) => {
    setPartitionFilter(partition);
    go('nodes');
  };
  const requestOn = (partition: string) => {
    go('request');
    setJobMode('script');
    setRequestPartition(partition);
  };
  const openJobs = (jobId?: string) => {
    go('jobs');
    if (jobId) setSelectedJob(jobId);
  };
  const openRun = (tag: string) => {
    go('training');
    setSelectedRun(tag);
  };
  const uploadTo = (dir: string) => {
    setUploadDir(dir);
    go('transfers');
  };
  const onCacheCleared = () => qc.invalidateQueries({ queryKey: ['node'] });

  const snapshot = snap.data?.snapshot ?? null;
  const challenge = challenges[0];
  const dismissChallenge = (id: string) => setChallenges((q) => q.filter((c) => c.id !== id));
  const err = snap.data?.lastError ?? (snap.error ? { message: errorMessage(snap.error) } : null);

  return {
    status,
    live,
    settings,
    setSettings,
    theme,
    setTheme,
    view,
    snap,
    snapshot,
    err,
    shareActive: !!share.data?.active,
    vscodeInUse,
    challenge,
    dismissChallenge,
    partitionFilter,
    setPartitionFilter,
    selectedNode,
    setSelectedNode,
    selectedJob,
    setSelectedJob,
    requestPartition,
    project,
    setProject,
    jobMode,
    switchJobMode,
    runTarget,
    runOnGpu,
    runAgain,
    setJobMode,
    wizardInit,
    selectedRun,
    setSelectedRun,
    uploadDir,
    editingFile,
    setEditingFile,
    openNotebook,
    setOpenNotebook,
    guard,
    setGuard,
    focusMode,
    toggleFocus: () => setFocus(!focusMode),
    openFile,
    pendingLeave,
    setPendingLeave,
    startTraining,
    navigate,
    requestDisconnect,
    confirmLeave,
    openNodes,
    requestOn,
    openJobs,
    openRun,
    uploadTo,
    onCacheCleared,
  };
}
