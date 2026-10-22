import { useState, useEffect, useCallback, useRef } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { toast } from 'sonner';

const ONE_HOUR_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'last_update_check';
const PENDING_VERSION_KEY = 'pending_update_version';
const PENDING_NOTES_KEY = 'pending_update_notes';

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export function useUpdater() {
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<Update | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const isBusyRef = useRef(false);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (isBusyRef.current) return;

    if (!manual) {
      const lastCheck = localStorage.getItem(STORAGE_KEY);
      if (lastCheck) {
        const timeSince = Date.now() - Number(lastCheck);
        if (timeSince < ONE_HOUR_MS) {
          // Throttled: background check skipped to avoid pending locks and redundant requests
          return;
        }
      }
    }

    isBusyRef.current = true;
    setIsChecking(true);

    try {
      const update = await check();
      localStorage.setItem(STORAGE_KEY, Date.now().toString());

      if (update) {
        setUpdateAvailable(update);
        setShowDialog(true);
      } else if (manual) {
        toast.info('У вас установлена актуальная версия приложения');
      }
    } catch (err) {
      // Invariant: Non-blocking silent failure for background check (no toast on network loss)
      if (manual) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Не удалось проверить обновления: ${message}`);
      } else {
        // Silently log in debug, do not interrupt user with red toast
        console.debug('Background updater check error (offline or unreachable):', err);
      }
    } finally {
      setIsChecking(false);
      isBusyRef.current = false;
    }
  }, []);

  const dismissDialog = useCallback(async () => {
    if (updateAvailable) {
      try {
        await updateAvailable.close();
      } catch {
        // ignore close error
      }
    }
    setUpdateAvailable(null);
    setShowDialog(false);
  }, [updateAvailable]);

  const installUpdate = useCallback(async () => {
    if (!updateAvailable || isDownloading) return;

    isBusyRef.current = true;
    setIsDownloading(true);
    let downloadedBytes = 0;
    let totalBytes = 0;

    // Persist the target version + changelog so we can confirm success after restart.
    localStorage.setItem(PENDING_VERSION_KEY, updateAvailable.version);
    localStorage.setItem(PENDING_NOTES_KEY, updateAvailable.body ?? '');

    try {
      await updateAvailable.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? 0;
          setDownloadProgress({ downloaded: 0, total: totalBytes, percent: 0 });
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength;
          const pct = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
          setDownloadProgress({
            downloaded: downloadedBytes,
            total: totalBytes,
            percent: pct,
          });
        } else if (event.event === 'Finished') {
          setDownloadProgress({
            downloaded: downloadedBytes,
            total: totalBytes,
            percent: 100,
          });
        }
      });

      toast.success('Обновление скачано. Перезапуск приложения…');
      // On Windows the NSIS installer may restart/exit the app itself; relaunch()
      // ensures a cross-platform restart. Either way the pending flag powers the
      // post-restart success toast on next launch.
      setTimeout(async () => {
        try {
          await relaunch();
        } catch {
          // Window may already be closing/restarted by the installer
        }
      }, 600);
    } catch (err) {
      // Update did not install — drop the pending marker so we don't show a false success.
      localStorage.removeItem(PENDING_VERSION_KEY);
      localStorage.removeItem(PENDING_NOTES_KEY);
      isBusyRef.current = false;
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Ошибка при установке обновления: ${message}`);
      setIsDownloading(false);
    }
  }, [updateAvailable, isDownloading]);

  // After a restart, confirm that the update actually took effect and show changelog.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending = localStorage.getItem(PENDING_VERSION_KEY);
      if (!pending) return;
      try {
        const installed = await getVersion();
        if (!cancelled && installed === pending) {
          const notes = localStorage.getItem(PENDING_NOTES_KEY) || '';
          const description = notes
            ? notes.length > 280
              ? `${notes.slice(0, 280)}…`
              : notes
            : 'Приложение перезапущено на новой версии.';
          toast.success(`Обновление до v${pending} успешно установлено`, {
            description,
            duration: 10000,
          });
        }
      } catch {
        // ignore version read errors
      } finally {
        localStorage.removeItem(PENDING_VERSION_KEY);
        localStorage.removeItem(PENDING_NOTES_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial non-blocking background check on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdates(false);
    }, 1500);

    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  return {
    isChecking,
    isDownloading,
    downloadProgress,
    updateAvailable,
    showDialog,
    checkForUpdates,
    dismissDialog,
    installUpdate,
  };
}
