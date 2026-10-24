import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, LaunchResult, ProjectRecord } from '../../types';

const recentKey = (s: ConnectionStatus) => ['projects', s.profileId, s.connectedAt];

/** Recent projects of this identity; opening one validates it on ICF first. */
export function useProjects(
  status: ConnectionStatus,
  selected: string | null,
  onSelect: (path: string | null) => void,
) {
  const qc = useQueryClient();
  const recent = useQuery({ queryKey: recentKey(status), queryFn: api.projectsRecent, retry: false });
  const [error, setError] = useState<string | null>(null);
  const project = recent.data?.find((p) => p.path === selected) ?? null;

  const open = async (path: string) => {
    setError(null);
    try {
      const rec = await api.openProject(path);
      await qc.invalidateQueries({ queryKey: recentKey(status) });
      onSelect(rec.path);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  /** `null` clears the whole history. */
  const forget = (path: string | null) =>
    void api.forgetProject(path).then(() => qc.invalidateQueries({ queryKey: recentKey(status) }));

  return { recent, error, project, open, forget };
}

/** Actions on one project: open it in VS Code, download a file, refresh after environment changes. */
export function useProjectDetail(status: ConnectionStatus, project: ProjectRecord) {
  const qc = useQueryClient();
  const [launch, setLaunch] = useState<LaunchResult | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const openInVsCode = async () => {
    setLaunching(true);
    setLaunchError(null);
    setLaunch(null);
    try {
      setLaunch(await api.vscodeOpen(project.path));
      void qc.invalidateQueries({ queryKey: ['vscode-share'] }); // the app now keeps the connection for VS Code
    } catch (e) {
      setLaunchError(errorMessage(e));
    } finally {
      setLaunching(false);
    }
  };

  const download = async (path: string) => {
    try {
      await api.download(path);
    } catch (e) {
      setLaunchError(errorMessage(e));
    }
  };

  const refresh = () => void qc.invalidateQueries({ queryKey: recentKey(status) });

  return { launch, launchError, launching, openInVsCode, download, refresh };
}
