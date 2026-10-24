import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { EnvReport, ProjectRecord, SettingsPreview, ToolchainProfile } from '../../types';

/** `/home/<user>` part of a project path, for example paths in placeholders. */
export const homePrefix = (path: string) => path.split('/').slice(0, 3).join('/');

/**
 * Python environment of one project: on-request interpreter discovery on the login node, the chosen
 * interpreter/toolchain, and writing it to .vscode/settings.json after a preview.
 */
export function useEnvPanel(project: ProjectRecord, onChanged: () => void) {
  const [report, setReport] = useState<EnvReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  const [preview, setPreview] = useState<SettingsPreview | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const toolchains = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const tc: ToolchainProfile | undefined = toolchains.data?.find((t) => t.id === project.toolchainId);

  const discover = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.pythonDiscover(project.path, extra.trim() || null));
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (prefs: Partial<{ interpreter: string | null; toolchainId: string | null }>) => {
    setError(null);
    try {
      await api.setProjectPrefs(project.path, {
        interpreter: project.interpreter,
        toolchainId: project.toolchainId,
        partition: project.partition,
        gresType: project.gresType,
        ...prefs,
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const previewSettings = async () => {
    if (!project.interpreter) return;
    setError(null);
    setApplied(null);
    try {
      setPreview(await api.vscodeSettingsPreview(project.path, project.interpreter));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const apply = async () => {
    if (!preview?.previewId) return;
    try {
      const r = await api.vscodeSettingsApply(preview.previewId);
      setApplied(r.backup ? `Written. The previous file was backed up as ${r.backup}.` : `Created ${r.file}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreview(null);
    }
  };
  const selected = report?.interpreters.find((i) => i.path === project.interpreter);
  // The project's own .venv/venv/env are always probed; list them only when they exist.
  const isDefault = (p: string) => ['.venv', 'venv', 'env'].some((d) => p === `${project.path}/${d}/bin/python`);
  const shown = report?.interpreters.filter((i) => !(i.status === 'missing' && isDefault(i.path))) ?? [];
  const noProjectEnv = !!report && shown.every((i) => !isDefault(i.path));
  const info = selected ?? project.interpreterInfo;
  const torchCuda = selected?.torchCuda ?? project.interpreterInfo?.torchCuda ?? null;
  const rcStatus =
    tc?.spec.kind === 'rc'
      ? report?.toolchains.find((t) => tc.spec.kind === 'rc' && t.path === tc.spec.path)?.status
      : undefined;

  return {
    report,
    busy,
    error,
    extra,
    setExtra,
    preview,
    setPreview,
    applied,
    toolchains,
    tc,
    discover,
    save,
    previewSettings,
    apply,
    shown,
    noProjectEnv,
    info,
    torchCuda,
    rcStatus,
  };
}
