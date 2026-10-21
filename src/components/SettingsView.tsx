import { useState } from 'react';
import {
  Database,
  HardDriveDownload,
  HardDriveUpload,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  FileCheck2,
  Layers,
  Lock,
  Info,
} from 'lucide-react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { exportDatabase, importDatabase } from '../api/db';

export function SettingsView() {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedRestoreFile, setSelectedRestoreFile] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [lastExportedPath, setLastExportedPath] = useState<string | null>(null);

  // Invariant: Export database hot snapshot using VACUUM INTO
  const handleExport = async () => {
    try {
      const now = new Date();
      const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const defaultFileName = `smm_backup_${dateStr}.smmbak`;

      // Open save file dialog
      const filePath = await save({
        title: 'Сохранить резервную копию SMM Control Center',
        filters: [{ name: 'SMM Backup (*.smmbak)', extensions: ['smmbak'] }],
        defaultPath: defaultFileName,
      });

      // Invariant: Quiet abort on user cancel (no error toasts)
      if (!filePath) {
        return;
      }

      setIsExporting(true);
      await exportDatabase(filePath);
      setLastExportedPath(filePath);
      toast.success('Резервная копия успешно создана!', {
        description: `Файл сохранен: ${filePath}`,
        duration: 5000,
      });
    } catch (err: any) {
      console.error('Database export failed:', err);
      toast.error('Не удалось создать резервную копию', {
        description: err?.message || String(err),
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Invariant: Select backup file for restore
  const handleSelectRestoreFile = async () => {
    try {
      const selected = await open({
        title: 'Выберите файл резервной копии для восстановления',
        filters: [{ name: 'SMM Backup (*.smmbak)', extensions: ['smmbak'] }],
        multiple: false,
        directory: false,
      });

      // Invariant: Quiet abort on user cancel
      if (!selected) {
        return;
      }

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) {
        return;
      }

      setSelectedRestoreFile(filePath);
      setShowConfirmModal(true);
    } catch (err: any) {
      console.error('File selection failed:', err);
      toast.error('Ошибка выбора файла', {
        description: err?.message || String(err),
      });
    }
  };

  // Invariant: Execute database import and trigger application restart
  const handleConfirmRestore = async () => {
    if (!selectedRestoreFile) return;

    try {
      setIsImporting(true);
      toast.info('Восстановление данных и подготовка к перезапуску...');
      await importDatabase(selectedRestoreFile);
      // The backend calls app.restart() automatically
    } catch (err: any) {
      console.error('Database restore failed:', err);
      setIsImporting(false);
      setShowConfirmModal(false);
      toast.error('Ошибка восстановления базы данных', {
        description: err?.message || String(err),
      });
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* View Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
            <Database className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            Резервное копирование и база данных
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Создание целостных локальных снапшотов данных, восстановление и аварийная защита
          </p>
        </div>
      </div>

      {/* OS Keyring Critical Security Warning Alert */}
      <div className="p-5 rounded-2xl bg-amber-500/10 border-2 border-amber-500/30 text-amber-950 dark:text-amber-200 shadow-xs relative overflow-hidden">
        <div className="flex items-start gap-3.5">
          <div className="p-2 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="space-y-1.5 text-xs sm:text-sm">
            <h3 className="font-bold text-amber-900 dark:text-amber-300 flex items-center gap-2">
              Аппаратная привязка шифрования ключей (OS Keyring / DPAPI)
            </h3>
            <p className="leading-relaxed text-zinc-700 dark:text-zinc-300">
              Токены доступа к соцсетям (VK, TG) и API-ключи нейросетей (OpenAI, Claude) зашифрованы с использованием мастер-ключа вашей локальной связки ключей операционной системы (Windows Credential Manager / DPAPI).
            </p>
            <div className="pt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-white/60 dark:bg-zinc-900/60 border border-amber-500/20">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>
                  <strong>Переносится полностью:</strong> База лидов CRM, этапы воронки AIDA/SPIN, история сообщений, посты, контент и статистика.
                </span>
              </div>
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-white/60 dark:bg-zinc-900/60 border border-amber-500/20">
                <Lock className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>При переносе на другой ПК:</strong> Зашифрованные токены не могут быть расшифрованы на чужой ОС. Их потребуется ввести в настройках заново.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Operations Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Export Card */}
        <div className="p-6 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <HardDriveDownload className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                  Создать резервную копию
                </h2>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Горячий снапшот SQLite (VACUUM INTO)
                </span>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Формирует единый самодостаточный файл снапшота <code className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-xs">.smmbak</code> без блокировки фоновых воркеров. Включает 100% данных базы на текущую секунду.
            </p>

            {lastExportedPath && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span className="truncate">Последний бэкап: {lastExportedPath}</span>
              </div>
            )}
          </div>

          <div className="pt-6">
            <button
              onClick={handleExport}
              disabled={isExporting || isImporting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-[0.99] transition-all shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExporting ? (
                <>
                  <RotateCw className="w-4 h-4 animate-spin" />
                  <span>Создание снапшота базы...</span>
                </>
              ) : (
                <>
                  <HardDriveDownload className="w-4 h-4" />
                  <span>Экспортировать базу (.smmbak)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Import / Restore Card */}
        <div className="p-6 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
                <HardDriveUpload className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                  Восстановить из копии
                </h2>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Импорт снапшота и перезапуск
                </span>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Загружает базу данных из выбранного файла <code className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-xs">.smmbak</code>. Перед заменой соединение корректно закрывается, а приложение автоматически перезапускается для применения изменений.
            </p>

            <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-800/60 border border-zinc-200/60 dark:border-zinc-700/60 text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0 text-zinc-400" />
              <span>Автоматическая проверка сигнатуры SQLite format 3 перед заменой</span>
            </div>
          </div>

          <div className="pt-6">
            <button
              onClick={handleSelectRestoreFile}
              disabled={isExporting || isImporting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-[0.99] transition-all border border-zinc-200 dark:border-zinc-700 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isImporting ? (
                <>
                  <RotateCw className="w-4 h-4 animate-spin" />
                  <span>Восстановление базы...</span>
                </>
              ) : (
                <>
                  <HardDriveUpload className="w-4 h-4" />
                  <span>Выбрать файл бэкапа...</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Architecture & Reliability Guarantees */}
      <div className="p-6 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xs space-y-4">
        <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <FileCheck2 className="w-4 h-4 text-emerald-500" />
          Гарантии надежности и архитектура бэкапов
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-zinc-600 dark:text-zinc-400">
          <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/60 dark:border-zinc-700/60 space-y-1">
            <div className="font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-blue-500" />
              Транзакционная целостность
            </div>
            <p>
              Команда SQLite <code>VACUUM INTO</code> копирует страницы базы данных на уровне движка, гарантируя консистентность без повреждения данных.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/60 dark:border-zinc-700/60 space-y-1">
            <div className="font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-purple-500" />
              Один монолитный файл
            </div>
            <p>
              Снапшот объединяет основную базу и журнал WAL. При переносе не требуются вспомогательные файлы <code>-wal</code> или <code>-shm</code>.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/60 dark:border-zinc-700/60 space-y-1">
            <div className="font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              Защита от сбоев и валидация
            </div>
            <p>
              Перед восстановлением проверяется заголовок <code>SQLite format 3</code>, а текущий пул соединений безопасно закрывается.
            </p>
          </div>
        </div>
      </div>

      {/* Restore Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="max-w-md w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
              <div className="p-2.5 rounded-xl bg-rose-500/10">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-base text-zinc-900 dark:text-zinc-100">
                  Подтверждение восстановления
                </h3>
                <span className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                  Внимание: необратимая операция
                </span>
              </div>
            </div>

            <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Текущие данные приложения будут полностью заменены данными из выбранной резервной копии:
            </p>

            <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/60 dark:border-zinc-700/60 text-xs font-mono text-zinc-800 dark:text-zinc-200 break-all">
              {selectedRestoreFile}
            </div>

            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>После завершения импорта приложение автоматически перезапустится.</span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isImporting}
                onClick={() => {
                  setShowConfirmModal(false);
                  setSelectedRestoreFile(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={isImporting}
                onClick={handleConfirmRestore}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 active:scale-[0.98] transition-all shadow-xs disabled:opacity-50"
              >
                {isImporting ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" />
                    <span>Восстановление...</span>
                  </>
                ) : (
                  <>
                    <HardDriveUpload className="w-4 h-4" />
                    <span>Да, перезаписать и перезапустить</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
