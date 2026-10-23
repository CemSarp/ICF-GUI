import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ConnectionStatus, SnapshotResponse } from '../../types';

export const MANUAL_DEBOUNCE_MS = 10_000;

/**
 * Scheduled refresh while connected and the window is visible (TanStack Query pauses
 * intervals for hidden documents). The backend enforces the same budget independently.
 */
export function useSnapshot(status: ConnectionStatus, pollIntervalSecs: number) {
  const qc = useQueryClient();
  const enabled = status.state === 'connected' || status.state === 'degraded';
  const key = ['snapshot', status.profileId, status.demo, status.connectedAt];

  const query = useQuery<SnapshotResponse>({
    queryKey: key,
    queryFn: () => api.snapshot(false),
    enabled,
    refetchInterval: enabled ? pollIntervalSecs * 1000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: Infinity,
  });

  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const manual = useMutation({
    mutationFn: () => api.snapshot(true),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  const refreshNow = () => {
    if (manual.isPending || cooling) return;
    setCooling(true);
    timer.current = setTimeout(() => setCooling(false), MANUAL_DEBOUNCE_MS);
    manual.mutate();
  };

  return {
    data: query.data,
    error: query.error ?? manual.error,
    loading: query.isLoading,
    refreshing: query.isFetching || manual.isPending,
    refreshNow,
    refreshDisabled: !enabled || manual.isPending || cooling,
  };
}
