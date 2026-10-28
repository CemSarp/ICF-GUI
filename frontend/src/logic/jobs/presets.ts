import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { forget } from '../persist';
import type { ConnectionStatus, Preset, PresetJob, WorkflowConfig } from '../../types';

/** A preset chosen in one form whose job type the other form runs; that form loads it when it opens. */
const PENDING = 'preset.pending';
const pendingId = () => {
  try {
    return localStorage.getItem(`icfcc.${PENDING}`);
  } catch {
    return null;
  }
};
/** Hands a preset to the other form (see `PENDING`). */
export function handOver(id: string) {
  try {
    localStorage.setItem(`icfcc.${PENDING}`, id);
  } catch {
    /* storage unavailable: the other form opens without it */
  }
}

/**
 * Saved presets for New job: load one, save the form as a new one, or update, rename or delete the
 * loaded one. A preset keeps the form's settings and its job type (and typed commands); presets live
 * on this Mac (per profile and user) and are re-validated at every review.
 */
export function usePresets(
  status: ConnectionStatus,
  current: () => { config: WorkflowConfig; job: PresetJob },
  load: (p: Preset) => void,
) {
  const qc = useQueryClient();
  const key = ['presets', status.profileId, status.connectedAt];
  const list = useQuery({ queryKey: key, queryFn: api.presets, retry: false, enabled: !status.demo });
  // A preset handed over by the other form is the selected one from the start; it is applied below.
  const [handed] = useState(pendingId);
  const [selected, setSelected] = useState(handed ?? '');
  const [error, setError] = useState<string | null>(null);
  const presets = list.data ?? [];
  const loaded = presets.find((p) => p.id === selected) ?? null;

  const choose = (id: string) => {
    setSelected(id);
    const p = presets.find((x) => x.id === id);
    if (p) load(p);
  };
  // Apply the handed-over preset to the form once the list is here.
  const handedPreset = handed ? presets.find((p) => p.id === handed) : undefined;
  useEffect(() => {
    if (handed && list.data) forget(PENDING);
    if (handedPreset) load(handedPreset);
    // Once, when the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handedPreset?.id, !!list.data]);

  const stored = (l: Preset[]) => {
    qc.setQueryData(key, l);
    setError(null);
    return l;
  };
  const failed = (e: unknown) => setError(errorMessage(e));
  const save = (id: string | null, label: string) => {
    const { config, job } = current();
    return api.savePreset(id, label.trim(), config, job).then(stored);
  };

  return {
    presets,
    loaded,
    error,
    choose,
    /** A new preset from the form; it becomes the loaded one. */
    saveNew: (label: string) =>
      save(null, label)
        .then((l) => setSelected(l.reduce((a, p) => (p.savedAt > a.savedAt ? p : a), l[0]!).id))
        .catch(failed),
    /** The loaded preset, overwritten with the form as it is now (including its job type). */
    update: () => loaded && save(loaded.id, loaded.label).catch(failed),
    rename: (label: string) =>
      loaded &&
      api
        .savePreset(loaded.id, label.trim(), loaded.config, loaded.job ?? null)
        .then(stored)
        .catch(failed),
    remove: () =>
      loaded &&
      api
        .deletePreset(loaded.id)
        .then(stored)
        .then(() => setSelected(''))
        .catch(failed),
  };
}
