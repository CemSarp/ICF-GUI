import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, Settings, SshConfigReport, ToolchainProfile } from '../../types';

/** Overview poll intervals offered (the backend enforces 45–600 s). */
export const POLL_CHOICES = [45, 60, 90, 120, 300, 600];
/** Per-transfer bandwidth caps offered, Mbit/s (0 = none). */
export const TRANSFER_LIMITS = [0, 50, 100, 200, 500];

/** Diagnostics option: hide user names (keeps at most 8 dots). */
export const redactName = (s: string, redact: boolean) => (redact && s ? s.replace(/./g, '•').slice(0, 8) : s);

/** Settings screen actions: poll interval, clearing the cached snapshot, local SSH config inspection, links. */
export function useSettings(status: ConnectionStatus, onSettings: (s: Settings) => void, onCacheCleared: () => void) {
  const [report, setReport] = useState<SshConfigReport | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const setPollInterval = (seconds: number) =>
    api
      .setPollInterval(seconds)
      .then(onSettings)
      .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }));
  const clearCache = () =>
    api
      .clearCache()
      .then(() => {
        onCacheCleared();
        setMsg({ tone: 'ok', text: 'Cached snapshot cleared.' });
      })
      .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }));
  const inspect = () =>
    api
      .inspectSshConfig(status.profileId ?? 'default')
      .then(setReport)
      .catch((err) => setMsg({ tone: 'bad', text: errorMessage(err) }));
  const openLink = (target: 'icf_status' | 'icf_tutorial' | 'vscode_remote_ssh') => void api.openExternal(target);

  return { report, msg, setPollInterval, clearCache, inspect, openLink };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'toolchain';

/** CUDA toolchain profiles: list, the add form, delete. */
export function useToolchains() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['toolchains'], queryFn: api.toolchains, retry: false });
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'rc' | 'modules'>('rc');
  const [value, setValue] = useState('');
  const [cuda, setCuda] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = (p: ToolchainProfile) =>
    api
      .saveToolchain(p)
      .then(() => {
        setLabel('');
        setValue('');
        setCuda('');
        setError(null);
        return qc.invalidateQueries({ queryKey: ['toolchains'] });
      })
      .catch((e) => setError(errorMessage(e)));
  const add = () =>
    void save({
      id: slug(label),
      label: label.trim(),
      spec: kind === 'rc' ? { kind: 'rc', path: value.trim() } : { kind: 'modules', names: value.trim().split(/\s+/) },
      cuda: cuda.trim() || null,
      note: null,
    });
  const remove = (id: string) =>
    void api
      .deleteToolchain(id)
      .then(() => qc.invalidateQueries({ queryKey: ['toolchains'] }))
      .catch((e) => setError(errorMessage(e)));

  return { q, label, setLabel, kind, setKind, value, setValue, cuda, setCuda, error, add, remove };
}

/** Transfer preferences (bandwidth cap). */
export function useTransferPrefs() {
  const q = useQuery({ queryKey: ['prefs'], queryFn: api.prefs, retry: false });
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const setLimit = (mbps: number) =>
    void api
      .setPrefs({ transferLimitMbps: mbps })
      .then((p) => qc.setQueryData(['prefs'], p))
      .catch((err) => setError(errorMessage(err)));
  return { limit: q.data?.transferLimitMbps ?? 0, error, setLimit };
}
