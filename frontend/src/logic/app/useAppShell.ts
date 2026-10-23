import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSnapshot } from '../cluster/useSnapshot';
import { isLive, useConnection } from '../connection/useConnection';
import type { JobMode } from '../jobs/newJob';
import { usePersistentState } from '../persist';
import { useApplyTheme, type Theme } from '../settings/theme';
import type { WizardInit } from '../training/wizardDraft';
import type { Settings } from '../../types';

export type View =
  'overview' | 'partitions' | 'nodes' | 'request' | 'jobs' | 'projects' | 'training' | 'transfers' | 'settings';

/**
 * App-wide state: connection, settings, the cluster snapshot, which screen and item is open, and
 * navigation that is held back while the editor has unsaved changes (or VS Code uses the connection).
 */
export function useAppShell() {
  const { status, challenges, setChallenges } = useConnection();
  const [settings, setSettings] = useState<Settings>({ pollIntervalSecs: 60 });
  const [view, setView] = usePersistentState<View>('view', 'overview');
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
  const [editorDirty, setEditorDirty] = useState(false);
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

  const go = (v: View) => {
    setEditingFile(null);
    setEditorDirty(false);
    setSelectedNode(null);
    setSelectedJob(null);
    setRequestPartition(null);
    if (v !== 'training') setSelectedRun(null);
    setView(v);
  };
  const startTraining = (init: WizardInit) => {
    setWizardInit((w) => ({ init, key: w.key + 1 }));
    setJobMode('workflow');
    go('request');
  };
  const disconnect = () => {
    setEditingFile(null);
    setEditorDirty(false);
    void api.disconnect().then(() => qc.clear());
  };
  /** Sidebar click: asks first while the editor has unsaved changes. */
  const navigate = (v: View) => (editorDirty ? setPendingLeave(v) : go(v));
  const requestDisconnect = () => (editorDirty || vscodeInUse ? setPendingLeave('disconnect') : disconnect());
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
    setJobMode,
    wizardInit,
    selectedRun,
    setSelectedRun,
    uploadDir,
    editingFile,
    setEditingFile,
    editorDirty,
    setEditorDirty,
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
