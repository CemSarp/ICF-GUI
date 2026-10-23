import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ConnectionStatus, JobsResponse } from '../../types';

export const JOBS_POLL_MS = 45_000;
const MANUAL_DEBOUNCE_MS = 10_000;

export const jobsKey = (status: ConnectionStatus) => ['jobs', status.profileId, status.demo, status.connectedAt];

/**
 * Own jobs, polled every 45 s only while a jobs screen is mounted and the window is visible
 * (TanStack pauses hidden intervals). The backend single-flights and rate-limits regardless.
 */
export function useJobs(status: ConnectionStatus) {
  const qc = useQueryClient();
  const enabled = status.state === 'connected' || status.state === 'degraded';
  const key = jobsKey(status);
  const query = useQuery<JobsResponse>({
    queryKey: key,
    queryFn: () => api.jobsList(false, true),
    enabled,
    refetchInterval: enabled ? JOBS_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const manual = useMutation({
    mutationFn: () => api.jobsList(true, true),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
  return {
    data: query.data,
    error: query.error ?? manual.error,
    loading: query.isLoading,
    refreshing: query.isFetching || manual.isPending,
    refreshDisabled: !enabled || manual.isPending || cooling,
    refreshNow: () => {
      if (manual.isPending || cooling) return;
      setCooling(true);
      timer.current = setTimeout(() => setCooling(false), MANUAL_DEBOUNCE_MS);
      manual.mutate();
    },
  };
}
