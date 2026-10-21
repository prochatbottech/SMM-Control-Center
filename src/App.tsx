import { useState } from 'react';
import { AccountsView } from './components/AccountsView';
import { PostsView } from './components/PostsView';
import { ContentGrabberView } from './components/ContentGrabberView';
import { Calendar, Users, Sparkles, RefreshCw, ArrowDownCircle, Rss, Bot, Terminal } from 'lucide-react';
import { Toaster } from 'sonner';
import { useUpdater } from './hooks/useUpdater';
import { UpdateDialog } from './components/UpdateDialog';
import { AutostartToggle } from './components/AutostartToggle';
import { AISettingsModal } from './components/AISettingsModal';
import { LogTerminal } from './components/LogTerminal';
import { useSystemLogs } from './hooks/useSystemLogs';

type ActiveTab = 'posts' | 'grabber' | 'accounts';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('posts');
  const [showAISettings, setShowAISettings] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const { logs, clearLogs, errorCount, warnCount } = useSystemLogs();
  const {
    isChecking,
    isDownloading,
    downloadProgress,
    updateAvailable,
    showDialog,
    checkForUpdates,
    dismissDialog,
    installUpdate,
  } = useUpdater();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans flex flex-col">
      <Toaster position="top-right" richColors closeButton />

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo & App Title */}
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-tr from-blue-600 to-indigo-600 text-white rounded-xl shadow-xs">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-base tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                SMM Control Center
                <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded-sm bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                  v0.1.0
                </span>
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center p-1 bg-zinc-100 dark:bg-zinc-800/80 rounded-xl border border-zinc-200/60 dark:border-zinc-700/60">
            <button
              onClick={() => setActiveTab('posts')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'posts'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Calendar className="w-4 h-4 text-blue-500" />
              Публикации
            </button>

            <button
              onClick={() => setActiveTab('grabber')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'grabber'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Rss className="w-4 h-4 text-amber-500" />
              Граббер
            </button>

            <button
              onClick={() => setActiveTab('accounts')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'accounts'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Users className="w-4 h-4 text-emerald-500" />
              Аккаунты
            </button>
          </nav>

          {/* Right Header Section: Autostart, Updater & Tokio Worker Status */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAISettings(true)}
              title="Настройки нейросетей и LLM API ключей"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 rounded-lg border border-purple-500/30 transition-colors"
            >
              <Bot className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
              <span>AI Ключи</span>
            </button>

            {/* Live Console Terminal Toggle Button */}
            <button
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
              title="Открыть терминал системных логов"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                isTerminalOpen
                  ? 'bg-zinc-800 text-emerald-400 border-zinc-700 shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 bg-zinc-100/80 dark:bg-zinc-800/80 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 rounded-lg border-zinc-200/60 dark:border-zinc-700/60'
              }`}
            >
              <Terminal className="w-3.5 h-3.5 text-emerald-500" />
              <span className="hidden sm:inline">Консоль</span>
              {errorCount > 0 ? (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-rose-500 text-white font-bold animate-pulse">
                  {errorCount}
                </span>
              ) : logs.length > 0 ? (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-zinc-700 text-zinc-300">
                  {logs.length}
                </span>
              ) : null}
            </button>

            <AutostartToggle compact />

            <button
              onClick={() => checkForUpdates(true)}
              disabled={isChecking || isDownloading}
              title="Проверить наличие обновлений"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 bg-zinc-100/80 dark:bg-zinc-800/80 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 rounded-lg border border-zinc-200/60 dark:border-zinc-700/60 transition-colors disabled:opacity-60"
            >
              {isChecking ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                  <span className="hidden md:inline">Проверка...</span>
                </>
              ) : updateAvailable ? (
                <>
                  <ArrowDownCircle className="w-3.5 h-3.5 text-emerald-500 animate-bounce" />
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                    Доступно v{updateAvailable.version}
                  </span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Обновления</span>
                </>
              )}
            </button>

            {/* Tokio Worker Indicator */}
            <div className="hidden sm:flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>Worker Active</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 md:p-10 pb-16 md:pb-24">
        {activeTab === 'posts' && <PostsView />}
        {activeTab === 'grabber' && <ContentGrabberView />}
        {activeTab === 'accounts' && <AccountsView />}
      </main>

      {/* Live System Log Terminal (Bottom Drawer) */}
      <LogTerminal
        logs={logs}
        onClear={clearLogs}
        isOpen={isTerminalOpen}
        onToggle={() => setIsTerminalOpen(!isTerminalOpen)}
        errorCount={errorCount}
        warnCount={warnCount}
      />

      {/* AI Settings Modal */}
      <AISettingsModal
        isOpen={showAISettings}
        onClose={() => setShowAISettings(false)}
      />

      {/* Update Dialog Modal */}
      <UpdateDialog
        isOpen={showDialog}
        update={updateAvailable}
        isDownloading={isDownloading}
        downloadProgress={downloadProgress}
        onInstall={installUpdate}
        onClose={dismissDialog}
      />
    </div>
  );
}

export default App;
