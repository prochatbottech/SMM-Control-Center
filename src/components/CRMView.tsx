import React, { useState } from 'react';
import {
  Users,
  Plus,
  Clock,
  Send,
  Share2,
  Trash2,
  Sparkles,
  ShieldCheck,
  Loader2,
  Snowflake,
  Activity,
  Bot,
  X,
} from 'lucide-react';
import {
  useLeadsQuery,
  useAddLeadMutation,
  useUpdateLeadStageMutation,
  useDeleteLeadMutation,
  useAutomationQueueQuery,
  useScheduleActionMutation,
  useDeleteQueueItemMutation,
  useMarkDeadLeadsMutation,
} from '../hooks/useCRM';
import { useAccountsQuery } from '../hooks/useAccounts';
import { Lead, Platform, ActionType, FunnelStage } from '../api/db';
import { toast } from 'sonner';

const FUNNEL_COLUMNS: { id: FunnelStage; title: string; color: string; badge: string }[] = [
  { id: 'new', title: 'Новые', color: 'border-blue-500/30', badge: 'bg-blue-500/10 text-blue-500' },
  { id: 'request_sent', title: 'Заявка отправлена', color: 'border-amber-500/30', badge: 'bg-amber-500/10 text-amber-500' },
  { id: 'request_accepted', title: 'Заявка принята', color: 'border-emerald-500/30', badge: 'bg-emerald-500/10 text-emerald-500' },
  { id: 'aida_attention', title: 'AIDA: Внимание', color: 'border-purple-500/30', badge: 'bg-purple-500/10 text-purple-500' },
  { id: 'aida_interest', title: 'AIDA: Интерес', color: 'border-indigo-500/30', badge: 'bg-indigo-500/10 text-indigo-500' },
  { id: 'closed', title: 'Закрыто / Сделка', color: 'border-teal-500/30', badge: 'bg-teal-500/10 text-teal-500' },
  { id: 'cold', title: 'Холодные (3+ дня)', color: 'border-zinc-500/30', badge: 'bg-zinc-500/10 text-zinc-400' },
];

export const CRMView: React.FC = () => {
  const { data: leads, isLoading: isLeadsLoading } = useLeadsQuery();
  const { data: accounts } = useAccountsQuery();
  const { data: queueItems } = useAutomationQueueQuery();

  const addLeadMutation = useAddLeadMutation();
  const updateStageMutation = useUpdateLeadStageMutation();
  const deleteLeadMutation = useDeleteLeadMutation();
  const scheduleActionMutation = useScheduleActionMutation();
  const deleteQueueItemMutation = useDeleteQueueItemMutation();
  const markDeadLeadsMutation = useMarkDeadLeadsMutation();

  // Modals state
  const [showAddLeadModal, setShowAddLeadModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [selectedLeadForAction, setSelectedLeadForAction] = useState<Lead | null>(null);

  // Add lead form state
  const [leadPlatform, setLeadPlatform] = useState<Platform>('vk');
  const [leadExternalId, setLeadExternalId] = useState('');
  const [leadName, setLeadName] = useState('');
  const [leadStage, setLeadStage] = useState<FunnelStage>('new');

  // Schedule action form state
  const [actionType, setActionType] = useState<ActionType>('send_friend_request');
  const [actionAccountId, setActionAccountId] = useState('');
  const [actionText, setActionText] = useState('');
  const [delayMode, setDelayMode] = useState<'random' | 'quick' | 'custom'>('random');
  const [customDelayMinutes, setCustomDelayMinutes] = useState(15);

  const handleCreateLead = (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadName.trim() || !leadExternalId.trim()) {
      toast.error('Заполните имя и ID контакта');
      return;
    }

    addLeadMutation.mutate(
      {
        platform: leadPlatform,
        external_id: leadExternalId.trim(),
        name: leadName.trim(),
        funnel_stage: leadStage,
      },
      {
        onSuccess: () => {
          toast.success(`Лид "${leadName}" добавлен в воронку!`);
          setLeadName('');
          setLeadExternalId('');
          setShowAddLeadModal(false);
        },
        onError: (err) => {
          toast.error(`Ошибка при сохранении: ${err.message}`);
        },
      }
    );
  };

  const handleOpenScheduleModal = (lead: Lead) => {
    setSelectedLeadForAction(lead);
    // Auto-select account matching lead's platform
    const matchingAcc = accounts?.find((a) => a.platform.toLowerCase() === lead.platform.toLowerCase());
    if (matchingAcc) {
      setActionAccountId(matchingAcc.id);
    } else if (accounts && accounts.length > 0) {
      setActionAccountId(accounts[0].id);
    }
    setShowScheduleModal(true);
  };

  const handleScheduleAction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLeadForAction) return;

    if (!actionAccountId) {
      toast.error('Выберите аккаунт для выполнения действия');
      return;
    }

    const payload = JSON.stringify({
      text: actionText.trim() || undefined,
      sticker_id: actionType === 'send_sticker' ? 1 : undefined,
    });

    let minDelay: number | undefined = undefined;
    let maxDelay: number | undefined = undefined;
    let executeAfter: number | null = null;

    if (delayMode === 'random') {
      minDelay = 15;
      maxDelay = 45;
    } else if (delayMode === 'quick') {
      executeAfter = Math.floor(Date.now() / 1000) + 5 * 60;
    } else {
      executeAfter = Math.floor(Date.now() / 1000) + customDelayMinutes * 60;
    }

    scheduleActionMutation.mutate(
      {
        lead_id: selectedLeadForAction.id,
        account_id: actionAccountId,
        action_type: actionType,
        payload,
        execute_after: executeAfter,
        min_delay_minutes: minDelay,
        max_delay_minutes: maxDelay,
      },
      {
        onSuccess: () => {
          toast.success(`Действие запланировано с анти-бан задержкой!`);
          setActionText('');
          setShowScheduleModal(false);
        },
        onError: (err) => {
          toast.error(`Ошибка планирования: ${err.message}`);
        },
      }
    );
  };

  const handleMoveStage = (leadId: string, nextStage: string) => {
    updateStageMutation.mutate(
      { id: leadId, stage: nextStage },
      {
        onSuccess: () => {
          toast.success('Этап воронки обновлен');
        },
      }
    );
  };

  const handleDeleteLead = (id: string, name: string) => {
    if (confirm(`Удалить контакт "${name}" и связанные задачи?`)) {
      deleteLeadMutation.mutate(id, {
        onSuccess: () => {
          toast.success(`Лид "${name}" удален`);
        },
      });
    }
  };

  const handleMarkDeadLeads = () => {
    markDeadLeadsMutation.mutate(3, {
      onSuccess: (data) => {
        if (data.marked_cold_count > 0) {
          toast.info(`Переведено в "Холодные": ${data.marked_cold_count} лид(ов)`);
        } else {
          toast.info('Нет лидов без ответа более 3 дней');
        }
      },
    });
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform.toLowerCase()) {
      case 'vk':
        return <Share2 className="w-3.5 h-3.5 text-blue-500" />;
      case 'tg':
      case 'telegram':
        return <Send className="w-3.5 h-3.5 text-sky-500" />;
      case 'ok':
        return <Users className="w-3.5 h-3.5 text-amber-500" />;
      default:
        return <Bot className="w-3.5 h-3.5 text-zinc-400" />;
    }
  };

  const formatTimestamp = (sec: number | null) => {
    if (!sec) return 'Нет данных';
    return new Date(sec * 1000).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const pendingQueueCount = queueItems?.filter((q) => q.status === 'pending').length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
            <Users className="w-6 h-6 text-purple-600 dark:text-purple-400" />
            <span>Local CRM & Воронка лидогенерации</span>
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Канбан-доска стадий лидов, анти-бан планировщик (рандомизация 15-45 мин) и защита от спама
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleMarkDeadLeads}
            disabled={markDeadLeadsMutation.isPending}
            title="Перевести в статус 'cold' всех лидов, не отвечающих 3+ дня"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-xl transition-colors cursor-pointer"
          >
            <Snowflake className="w-3.5 h-3.5 text-blue-400" />
            <span>Отсеять молчунов (3+ дн)</span>
          </button>

          <button
            type="button"
            onClick={() => setShowQueueModal(true)}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-xl transition-colors cursor-pointer"
          >
            <Clock className="w-3.5 h-3.5 text-purple-500" />
            <span>Очередь задач</span>
            {pendingQueueCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-purple-600 text-white font-bold">
                {pendingQueueCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowAddLeadModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Добавить контакт</span>
          </button>
        </div>
      </div>

      {/* Safety Notice Badge */}
      <div className="p-3 bg-purple-500/5 dark:bg-purple-950/20 border border-purple-500/20 rounded-xl flex items-center justify-between text-xs text-purple-700 dark:text-purple-300">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-purple-500 shrink-0" />
          <span>
            <strong>Анти-Бан Защита активна:</strong> Global Rate Limiter разрешает не более 1 действия в минуту на аккаунт. Очередь персистентна и сохраняется при перезапуске приложения.
          </span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[11px] text-zinc-500">
          <Activity className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
          <span>Воркер активен</span>
        </div>
      </div>

      {/* Kanban Board View */}
      {isLeadsLoading ? (
        <div className="flex items-center justify-center py-20 text-zinc-400 gap-2 text-sm">
          <Loader2 className="w-5 h-5 animate-spin text-purple-500" />
          <span>Загрузка контактов CRM...</span>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-6 pt-1 select-none">
          {FUNNEL_COLUMNS.map((col) => {
            const colLeads = leads?.filter((l) => l.funnel_stage === col.id) ?? [];
            return (
              <div
                key={col.id}
                className="w-72 shrink-0 bg-zinc-100/70 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800 rounded-2xl flex flex-col max-h-[75vh]"
              >
                {/* Column Header */}
                <div className="p-3.5 border-b border-zinc-200/60 dark:border-zinc-800 flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-bold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                      {col.title}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${col.badge}`}>
                      {colLeads.length}
                    </span>
                  </div>
                </div>

                {/* Cards List */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                  {colLeads.length === 0 ? (
                    <div className="py-8 text-center text-zinc-400 text-xs italic">
                      Нет контактов
                    </div>
                  ) : (
                    colLeads.map((lead) => (
                      <div
                        key={lead.id}
                        className="p-3 bg-white dark:bg-zinc-800/90 rounded-xl border border-zinc-200 dark:border-zinc-700/60 shadow-2xs hover:border-purple-500/40 transition-all space-y-2.5"
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {getPlatformIcon(lead.platform)}
                              <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                                {lead.name}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                              {lead.external_id}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleDeleteLead(lead.id, lead.name)}
                            className="p-1 text-zinc-400 hover:text-rose-500 rounded-md transition-colors"
                            title="Удалить лида"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-1 border-t border-zinc-100 dark:border-zinc-700/50">
                          <span className="truncate">
                            Контакт: {formatTimestamp(lead.last_interaction_at)}
                          </span>
                        </div>

                        {/* Card Actions */}
                        <div className="flex items-center gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => handleOpenScheduleModal(lead)}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1 px-2 bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 dark:text-purple-300 rounded-lg text-[11px] font-semibold transition-colors"
                          >
                            <Sparkles className="w-3 h-3 text-purple-500" />
                            <span>Действие</span>
                          </button>

                          {/* Stage mover dropdown */}
                          <select
                            value={lead.funnel_stage}
                            onChange={(e) => handleMoveStage(lead.id, e.target.value)}
                            className="py-1 px-1.5 bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-lg text-[11px] font-medium border border-zinc-200 dark:border-zinc-600 focus:outline-hidden"
                            title="Сменить этап воронки"
                          >
                            {FUNNEL_COLUMNS.map((c) => (
                              <option key={c.id} value={c.id}>
                                → {c.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 1. Modal: Add Lead */}
      {showAddLeadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="relative w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <Users className="w-5 h-5 text-purple-500" />
                <span>Новый контакт воронки</span>
              </h3>
              <button
                onClick={() => setShowAddLeadModal(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateLead} className="space-y-3.5">
              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                  Платформа
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['vk', 'tg', 'ok'] as Platform[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setLeadPlatform(p)}
                      className={`p-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 border transition-all ${
                        leadPlatform === p
                          ? 'bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300'
                          : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      {getPlatformIcon(p)}
                      <span className="uppercase">{p}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                  Имя контакта
                </label>
                <input
                  type="text"
                  value={leadName}
                  onChange={(e) => setLeadName(e.target.value)}
                  placeholder="Например: Александр Петров"
                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                  ID пользователя или юзернейм
                </label>
                <input
                  type="text"
                  value={leadExternalId}
                  onChange={(e) => setLeadExternalId(e.target.value)}
                  placeholder="Например: id987654321 или @username"
                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                  Начальный этап воронки
                </label>
                <select
                  value={leadStage}
                  onChange={(e) => setLeadStage(e.target.value as FunnelStage)}
                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden"
                >
                  {FUNNEL_COLUMNS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddLeadModal(false)}
                  className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={addLeadMutation.isPending}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors"
                >
                  {addLeadMutation.isPending ? 'Сохранение...' : 'Добавить контакт'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Modal: Schedule Automation Action */}
      {showScheduleModal && selectedLeadForAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-500" />
                  <span>Запланировать авто-действие</span>
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Контакт: <strong>{selectedLeadForAction.name}</strong> ({selectedLeadForAction.platform.toUpperCase()})
                </p>
              </div>
              <button
                onClick={() => setShowScheduleModal(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleScheduleAction} className="space-y-4">
              {/* Action type */}
              <div>
                <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 block mb-1">
                  Тип действия
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'send_friend_request', label: 'Добавить в друзья' },
                    { id: 'send_message', label: 'Отправить сообщение' },
                    { id: 'send_sticker', label: 'Отправить стикер' },
                    { id: 'check_status', label: 'Проверить статус' },
                  ].map((act) => (
                    <button
                      key={act.id}
                      type="button"
                      onClick={() => setActionType(act.id as ActionType)}
                      className={`p-2.5 rounded-lg text-xs font-semibold text-left border transition-all ${
                        actionType === act.id
                          ? 'bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300'
                          : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      {act.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Account selection */}
              <div>
                <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 block mb-1">
                  Аккаунт-исполнитель
                </label>
                {!accounts || accounts.length === 0 ? (
                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 rounded-lg text-xs">
                    Нет подключенных аккаунтов. Добавьте аккаунт в разделе «Аккаунты».
                  </div>
                ) : (
                  <select
                    value={actionAccountId}
                    onChange={(e) => setActionAccountId(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.platform.toUpperCase()})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Message text if action is send_message */}
              {actionType === 'send_message' && (
                <div>
                  <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 block mb-1">
                    Текст сообщения
                  </label>
                  <textarea
                    rows={3}
                    value={actionText}
                    onChange={(e) => setActionText(e.target.value)}
                    placeholder="Привет! Увидел твой профиль..."
                    className="w-full p-2.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:border-purple-500"
                  />
                </div>
              )}

              {/* Human-Like Delay options */}
              <div className="p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-700 space-y-2">
                <label className="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  <span>Анти-Бан Задержка (Human-like)</span>
                </label>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setDelayMode('random')}
                    className={`p-2 rounded-lg text-[11px] font-semibold border text-center transition-all ${
                      delayMode === 'random'
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                        : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <div>15 - 45 мин</div>
                    <div className="text-[9px] opacity-75">Рандомизация</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDelayMode('quick')}
                    className={`p-2 rounded-lg text-[11px] font-semibold border text-center transition-all ${
                      delayMode === 'quick'
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                        : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <div>+5 минут</div>
                    <div className="text-[9px] opacity-75">Тестовый</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDelayMode('custom')}
                    className={`p-2 rounded-lg text-[11px] font-semibold border text-center transition-all ${
                      delayMode === 'custom'
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                        : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <div>Свое время</div>
                    <div className="text-[9px] opacity-75">Минуты</div>
                  </button>
                </div>

                {delayMode === 'custom' && (
                  <div className="pt-2 flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Задержка (мин):</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={customDelayMinutes}
                      onChange={(e) => setCustomDelayMinutes(parseInt(e.target.value) || 1)}
                      className="w-20 px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-md text-xs font-mono"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowScheduleModal(false)}
                  className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={scheduleActionMutation.isPending || !actionAccountId}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors"
                >
                  {scheduleActionMutation.isPending ? 'Планирование...' : 'Добавить в очередь'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. Modal: Automation Queue Inspection */}
      {showQueueModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="relative w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-purple-600/10 text-purple-600 rounded-xl">
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                    Очередь задач автоматизации
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Персистентные задачи с анти-бан задержками (токен Rate Limit: 1/мин)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowQueueModal(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-3">
              {!queueItems || queueItems.length === 0 ? (
                <div className="text-center py-12 text-zinc-400 text-xs">
                  Очередь задач пуста. Выберите лида на Канбан-доске и нажмите «Действие».
                </div>
              ) : (
                queueItems.map((item) => (
                  <div
                    key={item.id}
                    className="p-3.5 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-zinc-900 dark:text-zinc-100">
                          {item.action_type}
                        </span>
                        <span
                          className={`px-1.5 py-0.2 rounded-sm text-[10px] font-mono uppercase font-bold ${
                            item.status === 'completed'
                              ? 'bg-emerald-500/10 text-emerald-500'
                              : item.status === 'processing'
                              ? 'bg-blue-500/10 text-blue-500 animate-pulse'
                              : item.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-500'
                              : 'bg-amber-500/10 text-amber-500'
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>

                      <div className="text-[11px] text-zinc-500 flex items-center gap-3">
                        <span>Лид: <strong className="text-zinc-700 dark:text-zinc-300">{item.lead_name}</strong></span>
                        <span>Аккаунт: <strong className="text-zinc-700 dark:text-zinc-300">{item.account_name}</strong></span>
                      </div>

                      <div className="text-[10px] text-zinc-400 font-mono flex items-center gap-1">
                        <Clock className="w-3 h-3 text-zinc-400" />
                        <span>Выполнить не ранее: {formatTimestamp(item.execute_after)}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => deleteQueueItemMutation.mutate(item.id)}
                      disabled={deleteQueueItemMutation.isPending}
                      className="p-1.5 text-zinc-400 hover:text-rose-500 rounded-lg hover:bg-rose-500/10 transition-colors"
                      title="Удалить из очереди"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="px-6 py-3 bg-zinc-50 dark:bg-zinc-800/40 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-500">
              <span>Всего задач в очереди: {queueItems?.length ?? 0}</span>
              <button
                onClick={() => setShowQueueModal(false)}
                className="px-3 py-1.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-lg font-medium"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
