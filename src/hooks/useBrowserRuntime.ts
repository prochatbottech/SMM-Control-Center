import { useQuery } from '@tanstack/react-query';
import { getBrowserRuntimeStatus, BrowserRuntimeDiagnostics } from '../api/db';

export const BROWSER_RUNTIME_QUERY_KEY = ['browser-runtime'] as const;

/**
 * Check once per app session whether the Playwright runtime is usable.
 * The backend runs a real worker ping, so a successful result means posting works.
 */
export function useBrowserRuntimeQuery() {
  return useQuery<BrowserRuntimeDiagnostics, Error>({
    queryKey: BROWSER_RUNTIME_QUERY_KEY,
    queryFn: async () => {
      return await getBrowserRuntimeStatus();
    },
    staleTime: Infinity,
    retry: false,
  });
}
