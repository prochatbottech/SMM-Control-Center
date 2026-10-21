import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import {
  Users,
  Send,
  MessageSquare,
  CheckCircle2,
  Snowflake,
  TrendingUp,
  Loader2,
  BarChart3,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { useFunnelAnalyticsQuery } from '../hooks/useAnalytics';

interface AnalyticsViewProps {
  onNavigateToCRM?: () => void;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ onNavigateToCRM }) => {
  const { data: metrics, isLoading, isError, error } = useFunnelAnalyticsQuery();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-28 text-zinc-400 gap-3">
        <Loader2 className="w-7 h-7 animate-spin text-purple-500" />
        <span className="text-sm font-medium">Загрузка данных сквозной аналитики...</span>
      </div>
    );
  }

  if (isError || !metrics) {
    return (
      <div className="p-6 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-rose-600 dark:text-rose-400 flex items-center gap-3">
        <ShieldAlert className="w-5 h-5 shrink-0" />
        <div className="text-sm">
          <strong>Ошибка получения метрик аналитики:</strong> {error?.message || 'Неизвестная ошибка'}
        </div>
      </div>
    );
  }

  // Edge case: Empty State when no leads are in CRM yet
  const isEmpty = metrics.total_leads === 0;

  const funnelChartData = [
    {
      stage: 'Все лиды',
      count: metrics.total_leads,
      fill: '#3b82f6',
      subtext: 'Сформированная база',
    },
    {
      stage: 'Заявки отправлены',
      count: metrics.requests_sent,
      fill: '#f59e0b',
      subtext: 'Массфрендинг и первичный контакт',
    },
    {
      stage: 'Активные диалоги',
      count: metrics.dialogs_active,
      fill: '#8b5cf6',
      subtext: 'Модели AIDA & SPIN',
    },
    {
      stage: 'Закрытые сделки',
      count: metrics.closed,
      fill: '#10b981',
      subtext: 'Финальный этап конверсии',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-purple-600 dark:text-purple-400" />
            <span>Дашборд сквозной аналитики воронки</span>
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Ключевые метрики эффективности Social Selling, конверсия этапов продаж и активность базы
          </p>
        </div>

        {onNavigateToCRM && (
          <button
            type="button"
            onClick={onNavigateToCRM}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 rounded-xl transition-colors cursor-pointer self-start md:self-auto"
          >
            <span>Перейти в воронку CRM</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* KPI Cards Grid (Upper Section) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {/* 1. Total Leads */}
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Всего контактов</span>
            <Users className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-black text-zinc-900 dark:text-zinc-100">
            {metrics.total_leads}
          </div>
          <div className="text-[11px] text-zinc-400">В базе CRM</div>
        </div>

        {/* 2. Requests Sent */}
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Заявки в друзья</span>
            <Send className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-black text-amber-600 dark:text-amber-400">
            {metrics.requests_sent}
          </div>
          <div className="text-[11px] text-zinc-400">
            {metrics.total_leads > 0
              ? `${((metrics.requests_sent / metrics.total_leads) * 100).toFixed(0)}% от базы`
              : '0% от базы'}
          </div>
        </div>

        {/* 3. Dialogs Active */}
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Активные диалоги</span>
            <MessageSquare className="w-4 h-4 text-purple-500" />
          </div>
          <div className="text-2xl font-black text-purple-600 dark:text-purple-400">
            {metrics.dialogs_active}
          </div>
          <div className="text-[11px] text-zinc-400">AIDA & SPIN</div>
        </div>

        {/* 4. Closed Deals */}
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Закрытые сделки</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
            {metrics.closed}
          </div>
          <div className="text-[11px] text-zinc-400">Успешный финал</div>
        </div>

        {/* 5. Cold Leads */}
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400">
            <span className="text-xs font-medium">Холодные лиды</span>
            <Snowflake className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="text-2xl font-black text-zinc-700 dark:text-zinc-300">
            {metrics.cold}
          </div>
          <div className="text-[11px] text-zinc-400">Молчат 3+ дня</div>
        </div>

        {/* 6. Conversion Rate */}
        <div className="p-4 bg-gradient-to-br from-purple-500/10 to-indigo-500/10 dark:from-purple-950/40 dark:to-indigo-950/40 rounded-2xl border border-purple-500/20 shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-purple-700 dark:text-purple-300">
            <span className="text-xs font-bold">Конверсия</span>
            <TrendingUp className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="text-2xl font-black text-purple-700 dark:text-purple-300">
            {metrics.conversion_rate.toFixed(1)}%
          </div>
          <div className="text-[11px] text-purple-600/80 dark:text-purple-400/80 font-medium">
            Сделок от общего пула
          </div>
        </div>
      </div>

      {/* Main Visual Funnel Chart Section */}
      <div className="p-6 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-500" />
              <span>Гистограмма этапов воронки продаж</span>
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Динамика прохождения контактов по стадиям прогрева и закрытия
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 font-medium">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
              Все
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              Заявки
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
              Диалоги
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              Сделки
            </span>
          </div>
        </div>

        {/* Empty State vs BarChart */}
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-20 px-4 text-center rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-dashed border-zinc-300 dark:border-zinc-700 space-y-3">
            <div className="p-3 bg-purple-500/10 text-purple-500 rounded-2xl">
              <BarChart3 className="w-8 h-8" />
            </div>
            <div className="max-w-md space-y-1">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                Нет данных для построения аналитики
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Добавьте первых лидов в CRM, отправьте заявки и запустите ИИ-генератор воронки, чтобы увидеть динамику конверсий.
              </p>
            </div>
            {onNavigateToCRM && (
              <button
                type="button"
                onClick={onNavigateToCRM}
                className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-xl shadow-xs transition-colors cursor-pointer"
              >
                <span>Перейти в CRM и добавить лидов</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ) : (
          <div className="h-80 w-full pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={funnelChartData}
                margin={{ top: 20, right: 30, left: 10, bottom: 20 }}
              >
                <XAxis
                  dataKey="stage"
                  stroke="#71717a"
                  fontSize={12}
                  tickLine={false}
                  axisLine={{ stroke: '#3f3f46' }}
                />
                <YAxis
                  stroke="#71717a"
                  fontSize={12}
                  tickLine={false}
                  axisLine={{ stroke: '#3f3f46' }}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(168, 85, 247, 0.08)' }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      const percentage =
                        metrics.total_leads > 0
                          ? ((data.count / metrics.total_leads) * 100).toFixed(1)
                          : '0.0';

                      return (
                        <div className="p-3 bg-zinc-900 text-white rounded-xl shadow-xl border border-zinc-700 text-xs space-y-1">
                          <div className="font-bold flex items-center justify-between gap-4">
                            <span>{data.stage}</span>
                            <span className="font-mono text-purple-400">{data.count}</span>
                          </div>
                          <div className="text-[11px] text-zinc-400">{data.subtext}</div>
                          <div className="text-[11px] text-zinc-300 pt-1 border-t border-zinc-800 flex items-center justify-between">
                            <span>Доля от базы:</span>
                            <strong className="text-emerald-400">{percentage}%</strong>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar
                  dataKey="count"
                  radius={[8, 8, 0, 0]}
                  barSize={56}
                >
                  {funnelChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Summary insights breakdown */}
      {!isEmpty && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs space-y-1">
            <span className="text-zinc-500 dark:text-zinc-400">Проходимость первого контакта</span>
            <div className="text-base font-bold text-zinc-800 dark:text-zinc-200">
              {metrics.total_leads > 0
                ? `${((metrics.requests_sent / metrics.total_leads) * 100).toFixed(1)}%`
                : '0.0%'}
            </div>
            <p className="text-[11px] text-zinc-400">Доля лидов, которым отправлен запрос в друзья</p>
          </div>

          <div className="p-4 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs space-y-1">
            <span className="text-zinc-500 dark:text-zinc-400">Вовлечение в квалификацию</span>
            <div className="text-base font-bold text-zinc-800 dark:text-zinc-200">
              {metrics.total_leads > 0
                ? `${((metrics.dialogs_active / metrics.total_leads) * 100).toFixed(1)}%`
                : '0.0%'}
            </div>
            <p className="text-[11px] text-zinc-400">Доля контактов в активных диалогах AIDA/SPIN</p>
          </div>

          <div className="p-4 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs space-y-1">
            <span className="text-zinc-500 dark:text-zinc-400">Сквозная конверсия в сделку</span>
            <div className="text-base font-bold text-emerald-600 dark:text-emerald-400">
              {metrics.conversion_rate.toFixed(1)}%
            </div>
            <p className="text-[11px] text-zinc-400">Финальный процент закрытых клиентов от всей базы</p>
          </div>
        </div>
      )}
    </div>
  );
};
