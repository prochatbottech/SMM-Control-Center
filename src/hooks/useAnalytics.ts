import { useQuery } from '@tanstack/react-query';
import { getFunnelAnalytics, FunnelMetrics } from '../api/db';

export const FUNNEL_ANALYTICS_QUERY_KEY = ['funnel_analytics'] as const;

/**
 * Hook to retrieve aggregated funnel analytics metrics directly from SQLite
 */
export function useFunnelAnalyticsQuery() {
  return useQuery<FunnelMetrics, Error>({
    queryKey: FUNNEL_ANALYTICS_QUERY_KEY,
    queryFn: async () => {
      return await getFunnelAnalytics();
    },
    refetchInterval: 15000,
  });
}

export type { FunnelMetrics };
