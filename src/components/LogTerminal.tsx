import React, { useState, useRef, useEffect } from 'react';
import {
  Terminal,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  ArrowDown,
  Search,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { SystemLog, LogLevel } from '../hooks/useSystemLogs';

interface LogTerminalProps {
  logs: SystemLog[];
  onClear: () => void;
  isOpen: boolean;
  onToggle: () => void;
  errorCount: number;
  warnCount: number;
}

type FilterLevel = 'all' | 'error' | 'warn' | 'info';

export const LogTerminal: React.FC<LogTerminalProps> = ({
  logs,
  onClear,
  isOpen,
  onToggle,
  errorCount,
  warnCount,
}) => {
  const [filterLevel, setFilterLevel] = useState<FilterLevel>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [isExpandedFull, setIsExpandedFull] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive (if auto-scroll is enabled)
  useEffect(() => {
    if (isOpen && isAutoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isAutoScroll, isOpen]);

  // Detect user scroll: if user scrolled away from bottom, pause auto-scroll
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    setIsAutoScroll(isAtBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAutoScroll(true);
    }
  };

  const filteredLogs = logs.filter((log) => {
    if (filterLevel === 'error' && log.level !== 'error') return false;
    if (filterLevel === 'warn' && log.level !== 'warn') return false;
    if (filterLevel === 'info' && log.level !== 'info' && log.level !== 'success') return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        log.message.toLowerCase().includes(q) ||
        log.level.toLowerCase().includes(q)
      );
    }

    return true;
  });

  const formatTimestamp = (sec: number) => {
    const d = new Date(sec * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const renderLevelBadge = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase tracking-wider bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <AlertCircle className="w-2.5 h-2.5" />
            ERR
          </span>
        );
      case 'warn':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-2.5 h-2.5" />
            WRN
          </span>
        );
      case 'success':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-2.5 h-2.5" />
            OK
          </span>
        );
      case 'info':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase tracking-wider bg-sky-500/15 text-sky-400 border border-sky-500/30">
            <Info className="w-2.5 h-2.5" />
            INF
          </span>
        );
    }
  };

  const getLogTextColor = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return 'text-rose-300';
      case 'warn':
        return 'text-amber-200';
      case 'success':
        return 'text-emerald-300';
      case 'info':
      default:
        return 'text-zinc-300';
    }
  };

  const lastLog = logs[logs.length - 1];

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-40 transition-all duration-300 ease-in-out border-t shadow-2xl ${
        isOpen
          ? isExpandedFull
            ? 'h-[85vh]'
            : 'h-80 md:h-96'
          : 'h-10'
      } bg-[#0c0e14] border-zinc-800 text-zinc-200 flex flex-col font-mono text-xs`}
    >
      {/* Terminal Title Bar / Drawer Toggle */}
      <div
        onClick={onToggle}
        className="h-10 px-4 bg-[#12151f] hover:bg-[#181c2a] border-b border-zinc-800/80 flex items-center justify-between cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 text-zinc-100 font-bold">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="tracking-tight">Live Console</span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-zinc-800 text-zinc-300 border border-zinc-700">
              {logs.length} строк
            </span>
            {errorCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-rose-500/20 text-rose-400 border border-rose-500/30 font-bold">
                {errorCount} {errorCount === 1 ? 'ошибка' : 'ошибок'}
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold">
                {warnCount} пред.
              </span>
            )}
          </div>

          {!isOpen && lastLog && (
            <div className="hidden sm:flex items-center gap-2 text-zinc-400 text-[11px] truncate ml-3 max-w-md">
              <span className="text-zinc-500">{formatTimestamp(lastLog.timestamp)}</span>
              <span className={`truncate ${getLogTextColor(lastLog.level)}`}>
                {lastLog.message}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isOpen && (
            <>
              <button
                type="button"
                onClick={() => setIsExpandedFull(!isExpandedFull)}
                title={isExpandedFull ? 'Уменьшить' : 'Развернуть'}
                className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 rounded-md transition-colors"
              >
                {isExpandedFull ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onToggle}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 rounded-md transition-colors"
          >
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Terminal Expanded Body */}
      {isOpen && (
        <div className="flex-1 flex flex-col min-h-0 bg-[#090b10]">
          {/* Controls Bar */}
          <div className="px-4 py-2 bg-[#0e111a] border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-2.5">
            {/* Filter Tabs */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFilterLevel('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  filterLevel === 'all'
                    ? 'bg-zinc-800 text-zinc-100 font-bold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                Все ({logs.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterLevel('error')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  filterLevel === 'error'
                    ? 'bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30'
                    : 'text-zinc-400 hover:text-rose-400 hover:bg-zinc-800/50'
                }`}
              >
                Ошибки ({errorCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterLevel('warn')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  filterLevel === 'warn'
                    ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30'
                    : 'text-zinc-400 hover:text-amber-400 hover:bg-zinc-800/50'
                }`}
              >
                Предупреждения ({warnCount})
              </button>
            </div>

            {/* Search & Actions */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Поиск по логам..."
                  className="pl-7 pr-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded-md text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-zinc-700 w-36 sm:w-48"
                />
              </div>

              {/* Auto-scroll toggle status */}
              <button
                type="button"
                onClick={() => setIsAutoScroll(!isAutoScroll)}
                className={`px-2 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1 border transition-colors ${
                  isAutoScroll
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-zinc-800/60 text-zinc-500 border-zinc-800'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isAutoScroll ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                <span>Автопрокрутка</span>
              </button>

              {/* Clear button */}
              <button
                type="button"
                onClick={onClear}
                title="Очистить терминал"
                className="p-1 text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 rounded-md transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Logs View Area */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-3 space-y-1 select-text selection:bg-purple-900 selection:text-white"
          >
            {filteredLogs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-600 text-xs py-8">
                <Terminal className="w-6 h-6 mb-2 opacity-40" />
                <span>Журнал логов пуст</span>
                <span className="text-[10px] mt-0.5 text-zinc-700">
                  События фонового воркера и публикации появятся здесь в реальном времени
                </span>
              </div>
            ) : (
              filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-2.5 py-0.5 leading-relaxed hover:bg-white/[0.02] px-1 rounded-sm"
                >
                  <span className="text-zinc-600 select-none text-[10px] shrink-0 pt-0.5">
                    {formatTimestamp(log.timestamp)}
                  </span>
                  <div className="shrink-0">{renderLevelBadge(log.level)}</div>
                  <span className={`break-words flex-1 text-[11px] ${getLogTextColor(log.level)}`}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Scroll to bottom button if user scrolled up */}
          {!isAutoScroll && filteredLogs.length > 0 && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-4 right-6 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-full shadow-lg flex items-center gap-1.5 text-xs font-bold transition-all animate-bounce"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>К новым логам</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
