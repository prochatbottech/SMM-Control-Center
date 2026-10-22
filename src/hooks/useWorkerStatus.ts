import { useQuery } from '@tanstack/react-query';
import { getWorkerStatus, WorkerStatus } from '../api/db';

export const WORKER_STATUS_QUERY_KEY = ['worker-status'] as const;

/**
 * Poll the backend worker health every 15s to power the live status indicator.
 */
export function useWorkerStatusQuery() {
  return useQuery<WorkerStatus, Error>({
    queryKey: WORKER_STATUS_QUERY_KEY,
    queryFn: async () => {
      return await getWorkerStatus();
    },
    refetchInterval: 15000,
  });
}
