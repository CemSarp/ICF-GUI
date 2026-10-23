import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/** One node from the cached snapshot; `version` refetches it when a new snapshot arrives. */
export function useNodeDetail(nodeId: string, version: number) {
  return useQuery({ queryKey: ['node', nodeId, version], queryFn: () => api.nodeDetail(nodeId), retry: false });
}
