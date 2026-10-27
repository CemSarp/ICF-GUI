import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, Preset, WorkflowConfig } from '../../types';

/**
 * Saved presets for New job: load one, save the form as a new one, or update, rename or delete the
 * loaded one. Presets live on this Mac (per profile and user) and are re-validated at every review.
 */
export function usePresets(status: ConnectionStatus, current: () => WorkflowConfig, load: (c: WorkflowConfig) => void) {
  const qc = useQueryClient();
  const key = ['presets', status.profileId, status.connectedAt];
  const list = useQuery({ queryKey: key, queryFn: api.presets, retry: false, enabled: !status.demo });
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const presets = list.data ?? [];
  const loaded = presets.find((p) => p.id === selected) ?? null;

  const stored = (l: Preset[]) => {
    qc.setQueryData(key, l);
    setError(null);
    return l;
  };
  const failed = (e: unknown) => setError(errorMessage(e));

  return {
    presets,
    loaded,
    error,
    choose: (id: string) => {
      setSelected(id);
      const p = presets.find((x) => x.id === id);
      if (p) load(p.config);
    },
    /** A new preset from the form; it becomes the loaded one. */
    saveNew: (label: string) =>
      api
        .savePreset(null, label.trim(), current())
        .then(stored)
        .then((l) => setSelected(l.reduce((a, p) => (p.savedAt > a.savedAt ? p : a), l[0]!).id))
        .catch(failed),
    /** The loaded preset, overwritten with the form as it is now. */
    update: () => loaded && api.savePreset(loaded.id, loaded.label, current()).then(stored).catch(failed),
    rename: (label: string) =>
      loaded && api.savePreset(loaded.id, label.trim(), loaded.config).then(stored).catch(failed),
    remove: () =>
      loaded &&
      api
        .deletePreset(loaded.id)
        .then(stored)
        .then(() => setSelected(''))
        .catch(failed),
  };
}
