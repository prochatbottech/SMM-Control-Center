import { AlertTriangle, CheckCircle2, RefreshCw, Terminal } from 'lucide-react';
import { useBrowserRuntimeQuery } from '../hooks/useBrowserRuntime';

/**
 * Surfaces the state of the CDP-based automation chain: Node + Playwright +
 * worker script + the dedicated Yandex Browser profile listening on the CDP port.
 * A missing browser profile is the most common failure and gets its own,
 * actionable message — the user only has to run the launch script and log in.
 */
export function BrowserRuntimeBanner() {
  const { data, isLoading, isError, error, refetch, isFetching } = useBrowserRuntimeQuery();

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 px-5 py-3.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-500 dark:text-zinc-400">
        <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
        Проверка подключения к браузеру...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-start gap-3 px-5 py-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl">
        <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
        <div className="text-xs text-rose-700 dark:text-rose-300 space-y-1">
          <div className="font-semibold">Не удалось проверить рантайм автоматизации</div>
          <div className="font-mono break-all">{error?.message || String(error)}</div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1.5 rounded-lg hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 disabled:opacity-50"
          title="Повторить проверку"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>
    );
  }

  if (!data) return null;

  if (data.ok) {
    return (
      <div className="flex items-center gap-3 px-5 py-3.5 bg-emerald-500/10 border border-emerald-500/25 rounded-xl">
        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
        <div className="text-xs text-emerald-800 dark:text-emerald-300">
          <span className="font-semibold">Браузер подключён.</span>{' '}
          <span className="text-emerald-700/80 dark:text-emerald-400/80">
            {data.cdp_url} · вкладок: {data.browser_pages ?? 0} · Node{' '}
            {data.node_version ?? '—'}
          </span>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1.5 rounded-lg hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 disabled:opacity-50"
          title="Проверить снова"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2.5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <div className="font-bold text-amber-900 dark:text-amber-300">
            {data.cdp_reachable
              ? 'Браузер отвечает, но автоматизация недоступна'
              : 'Браузер с выделенным профилем не подключён'}
          </div>
          <div className="text-amber-800 dark:text-amber-200/90">
            Публикация в VK/OK через браузер, парсинг аудитории и заявки не будут работать,
            пока не устранены проблемы ниже.
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1.5 rounded-lg hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 disabled:opacity-50"
          title="Проверить снова"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {!data.cdp_reachable && (
        <div className="pl-7 space-y-1.5 text-xs text-amber-900/90 dark:text-amber-200/90">
          <p>
            Запустите браузер с выделенным профилем и войдите в него на{' '}
            <code className="font-mono">vk.com</code> и <code className="font-mono">ok.ru</code>:
          </p>
          <pre className="px-3 py-2 bg-zinc-900 text-zinc-100 rounded-lg text-[11px] font-mono overflow-x-auto">
node scripts/launch-yandex.mjs
          </pre>
        </div>
      )}

      <ul className="space-y-1.5 text-xs text-amber-900/90 dark:text-amber-200/90 pl-7">
        {data.issues.map((issue, idx) => (
          <li key={idx} className="flex items-start gap-2">
            <span className="text-amber-500 shrink-0">•</span>
            <span className="break-words">{issue}</span>
          </li>
        ))}
      </ul>

      <div className="pl-7 pt-1 space-y-1 text-[11px] text-zinc-600 dark:text-zinc-400 font-mono break-all">
        <div className="flex items-start gap-1.5">
          <Terminal className="w-3 h-3 mt-0.5 shrink-0" />
          <span>cdp: {data.cdp_url}</span>
        </div>
        {data.node && (
          <div className="flex items-start gap-1.5">
            <Terminal className="w-3 h-3 mt-0.5 shrink-0" />
            <span>node: {data.node}</span>
          </div>
        )}
        {data.script && (
          <div className="flex items-start gap-1.5">
            <Terminal className="w-3 h-3 mt-0.5 shrink-0" />
            <span>worker: {data.script}</span>
          </div>
        )}
        {data.playwright_module && (
          <div className="flex items-start gap-1.5">
            <Terminal className="w-3 h-3 mt-0.5 shrink-0" />
            <span>playwright: {data.playwright_module}</span>
          </div>
        )}
      </div>
    </div>
  );
}
