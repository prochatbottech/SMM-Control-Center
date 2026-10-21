import { useState, useEffect, useCallback } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface SystemLog {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: number; // Unix timestamp in seconds
}

export interface RawLogPayload {
  level: string;
  message: string;
  timestamp: number;
}

const MAX_LOGS_LIMIT = 500;

export function useSystemLogs() {
  const [logs, setLogs] = useState<SystemLog[]>([]);

  useEffect(() => {
    let unlistenFn: UnlistenFn | null = null;
    let isMounted = true;

    async function setupListener() {
      try {
        unlistenFn = await listen<RawLogPayload>('system-log', (event) => {
          if (!isMounted) return;

          const payload = event.payload;
          const level: LogLevel = (
            ['info', 'warn', 'error', 'success'].includes(payload.level)
              ? payload.level
              : 'info'
          ) as LogLevel;

          const newLog: SystemLog = {
            id: `${payload.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
            level,
            message: payload.message,
            timestamp: payload.timestamp,
          };

          // Invariant: Strictly retain at most 500 log items to prevent WebView RAM exhaustion
          setLogs((prev) => {
            const next = [...prev, newLog];
            return next.length > MAX_LOGS_LIMIT ? next.slice(-MAX_LOGS_LIMIT) : next;
          });
        });
      } catch (err) {
        console.error('Failed to listen to system-log events:', err);
      }
    }

    setupListener();

    return () => {
      isMounted = false;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;

  return {
    logs,
    clearLogs,
    errorCount,
    warnCount,
    totalCount: logs.length,
    maxLimit: MAX_LOGS_LIMIT,
  };
}
