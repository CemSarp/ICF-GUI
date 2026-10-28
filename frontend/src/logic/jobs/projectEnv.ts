import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { recentKey } from '../projects/useProjects';
import type { ConnectionStatus, ProjectRecord } from '../../types';

const trim = (p: string) => p.replace(/\/+$/, '');

/** The project that holds `path` (the folder itself or the nearest parent), if the user opened one. */
export function projectFor(path: string, projects: ProjectRecord[]): ProjectRecord | null {
  const p = trim(path);
  if (!p) return null;
  return (
    projects
      .filter((x) => p === trim(x.path) || p.startsWith(`${trim(x.path)}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  );
}

/** `/home/u/env/bin/python3.11` → `/home/u/env`; null for an interpreter that is no environment in home. */
export function envDirOf(interpreter: string | null | undefined, home: string): string | null {
  const m = /^(.+)\/bin\/python[\d.]*$/.exec(interpreter ?? '');
  return m && m[1]!.startsWith(`${home}/`) ? m[1]! : null;
}

export type ProjectEnv =
  /** No project was opened for this folder (or none chosen yet). */
  | { kind: 'none' }
  /** A project, but no environment chosen in it. */
  | { kind: 'unset'; project: string }
  /** The project's interpreter is not a venv/conda folder in home (e.g. the system python3). */
  | { kind: 'unusable'; project: string; interpreter: string }
  | { kind: 'env'; project: string; interpreter: string; dir: string; toolchainId: string | null };

export function describeProjectEnv(folder: string, projects: ProjectRecord[], home: string): ProjectEnv {
  const p = projectFor(folder, projects);
  if (!p) return { kind: 'none' };
  if (!p.interpreter) return { kind: 'unset', project: p.path };
  const dir = envDirOf(p.interpreter, home);
  return dir
    ? { kind: 'env', project: p.path, interpreter: p.interpreter, dir, toolchainId: p.toolchainId }
    : { kind: 'unusable', project: p.path, interpreter: p.interpreter };
}

/**
 * ADR-037: a job's Python environment defaults to the one chosen in Projects for the folder it runs
 * in. It is filled into the form (so what is sent is what is shown) when the folder changes and the
 * field is empty; Clear keeps it empty for that folder.
 */
export function useProjectEnv(
  status: ConnectionStatus,
  folder: string,
  home: string,
  current: string,
  fill: (env: Extract<ProjectEnv, { kind: 'env' }>) => void,
) {
  const recent = useQuery({ queryKey: recentKey(status), queryFn: api.projectsRecent, retry: false });
  const env = describeProjectEnv(folder, recent.data ?? [], home);
  const [declined, setDeclined] = useState<string | null>(null);
  const key = env.kind === 'env' ? `${folder}\n${env.interpreter}` : '';
  useEffect(() => {
    if (env.kind === 'env' && !current.trim() && declined !== folder) fill(env);
    // Once per folder/project interpreter; `fill` and `current` are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    env,
    /** The field holds the project's environment (to say where it came from). */
    fromProject: (value: string) => env.kind === 'env' && [env.dir, env.interpreter].includes(trim(value)),
    /** Clear: no environment for this folder, and do not fill it again. */
    decline: () => setDeclined(folder),
  };
}
