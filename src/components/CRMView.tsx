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
  Copy,
  Check,
  BrainCircuit,
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
  useGenerateFunnelMessageMutation,
  useGenerateAndScheduleMessageMutation,
} from '../hooks/useCRM';
import { useAccountsQuery } from '../hooks/useAccounts';
import { useApiCredentialsQuery } from '../hooks/useApiCredentials';
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
  const { data: apiCredentials } = useApiCredentialsQuery();

  const addLeadMutation = useAddLeadMutation();
  const updateStageMutation = useUpdateLeadStageMutation();
  const deleteLeadMutation = useDeleteLeadMutation();
  const scheduleActionMutation = useScheduleActionMutation();
  const deleteQueueItemMutation = useDeleteQueueItemMutation();
  const markDeadLeadsMutation = useMarkDeadLeadsMutation();
  const generateFunnelMessageMutation = useGenerateFunnelMessageMutation();
  const generateAndScheduleMessageMutation = useGenerateAndScheduleMessageMutation();

  // Modals state
  const [showAddLeadModal, setShowAddLeadModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [showAIFunnelModal, setShowAIFunnelModal] = useState(false);
  const [selectedLeadForAction, setSelectedLeadForAction] = useState<Lead | null>(null);
  const [selectedLeadForAI, setSelectedLeadForAI] = useState<Lead | null>(null);

  // AI Funnel form state
  const [aiFramework, setAiFramework] = useState<'aida' | 'spin'>('aida');
  const [aiStage, setAiStage] = useState('attention');
  const [aiAccountId, setAiAccountId] = useState('');
  const [aiCredentialId, setAiCredentialId] = useState('');
  const [aiModelName, setAiModelName] = useState('gpt-4o-mini');
  const [aiCustomContext, setAiCustomContext] = useState('');
  const [aiApplyHumanizer, setAiApplyHumanizer] = useState(true);
  const [aiGeneratedText, setAiGeneratedText] = useState('');
  const [hasCopied, setHasCopied] = useState(false);

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

  const handleOpenAIFunnelModal = (lead: Lead) => {
    setSelectedLeadForAI(lead);
    // Pre-select account for platform
    const matchingAcc = accounts?.find(
      (a) => a.platform.toLowerCase() === lead.platform.toLowerCase()
    );
    if (matchingAcc) {
      setAiAccountId(matchingAcc.id);
    } else if (accounts && accounts.length > 0) {
      setAiAccountId(accounts[0].id);
    }

    // Pre-select credential
    if (apiCredentials && apiCredentials.length > 0) {
      setAiCredentialId(apiCredentials[0].id);
      if (apiCredentials[0].provider === 'anthropic') {
        setAiModelName('claude-3-5-sonnet-20241022');
      } else {
        setAiModelName('gpt-4o-mini');
      }
    }

    // Pre-select stage
    if (lead.funnel_stage.includes('interest')) {
      setAiFramework('aida');
      setAiStage('interest');
    } else if (lead.funnel_stage.includes('attention')) {
      setAiFramework('aida');
      setAiStage('attention');
    } else {
      setAiFramework('aida');
      setAiStage('attention');
    }

    setAiGeneratedText('');
    setShowAIFunnelModal(true);
  };

  const handleGenerateAIDraft = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedLeadForAI) return;
    if (!aiCredentialId) {
      toast.error('Выберите или настройте LLM API ключ');
      return;
    }

    generateFunnelMessageMutation.mutate(
      {
        leadId: selectedLeadForAI.id,
        credentialId: aiCredentialId,
        framework: aiFramework,
        stage: aiStage,
        customContext: aiCustomContext.trim(),
        applyHumanizer: aiApplyHumanizer,
        modelName: aiModelName.trim() || undefined,
      },
      {
        onSuccess: (text) => {
          setAiGeneratedText(text);
          toast.success('Сообщение успешно сгенерировано нейросетью!');
        },
        onError: (err) => {
          toast.error(`Ошибка генерации: ${err.message}`);
        },
      }
    );
  };

  const handleGenerateAndSchedule = () => {
    if (!selectedLeadForAI) return;
    if (!aiAccountId) {
      toast.error('Выберите аккаунт для отправки');
      return;
    }
    if (!aiCredentialId) {
      toast.error('Выберите LLM API ключ');
      return;
    }

    generateAndScheduleMessageMutation.mutate(
      {
        leadId: selectedLeadForAI.id,
        accountId: aiAccountId,
        credentialId: aiCredentialId,
        framework: aiFramework,
        stage: aiStage,
        customContext: aiCustomContext.trim(),
        applyHumanizer: aiApplyHumanizer,
        modelName: aiModelName.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(
            'Сообщение сгенерировано и запланировано с анти-бан задержкой 15–45 мин!'
          );
          setShowAIFunnelModal(false);
          setAiGeneratedText('');
        },
        onError: (err) => {
          toast.error(`Ошибка планирования: ${err.message}`);
        },
      }
    );
  };

  const handleCopyGeneratedText = () => {
    if (!aiGeneratedText) return;
    navigator.clipboard.writeText(aiGeneratedText);
    setHasCopied(true);
    toast.success('Текст скопирован в буфер обмена');
    setTimeout(() => setHasCopied(false), 2000);
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
                            onClick={() => handleOpenAIFunnelModal(lead)}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1 px-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-[11px] font-semibold transition-colors shadow-2xs"
                            title="Сгенерировать сообщение по моделям AIDA / SPIN"
                          >
                            <Sparkles className="w-3 h-3" />
                            <span>ИИ Воронка</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleOpenScheduleModal(lead)}
                            className="p-1 px-2 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg text-[11px] font-medium transition-colors"
                            title="Запланировать действие вручную"
                          >
                            <Clock className="w-3 h-3 text-purple-500" />
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

      {/* 4. Modal: AI Funnel Message Generator (AIDA / SPIN) */}
      {showAIFunnelModal && selectedLeadForAI && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="relative w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4 max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-xl">
                  <BrainCircuit className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <span>ИИ-Генератор сообщений воронки</span>
                    <span className="text-xs font-mono font-normal px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                      {selectedLeadForAI.platform.toUpperCase()}
                    </span>
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Персонализированная генерация для <strong className="text-zinc-700 dark:text-zinc-200">{selectedLeadForAI.name}</strong> ({selectedLeadForAI.external_id})
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowAIFunnelModal(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Form Body */}
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Framework Switcher (AIDA vs SPIN) */}
              <div>
                <label className="text-xs font-bold text-zinc-700 dark:text-zinc-300 block mb-1.5">
                  Методология воронки
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAiFramework('aida');
                      setAiStage('attention');
                    }}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      aiFramework === 'aida'
                        ? 'bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300 shadow-2xs'
                        : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700/60 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                    }`}
                  >
                    <div className="font-bold text-xs flex items-center justify-between">
                      <span>AIDA</span>
                      <span className="text-[10px] font-mono opacity-75">Классика</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                      Внимание → Интерес → Желание → Действие
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAiFramework('spin');
                      setAiStage('problem');
                    }}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      aiFramework === 'spin'
                        ? 'bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300 shadow-2xs'
                        : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700/60 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                    }`}
                  >
                    <div className="font-bold text-xs flex items-center justify-between">
                      <span>SPIN</span>
                      <span className="text-[10px] font-mono opacity-75">B2B Продажи</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                      Ситуация → Проблема → Извлечение → Направление
                    </div>
                  </button>
                </div>
              </div>

              {/* Stage Selection */}
              <div>
                <label className="text-xs font-bold text-zinc-700 dark:text-zinc-300 block mb-1.5">
                  Этап диалога ({aiFramework.toUpperCase()})
                </label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {aiFramework === 'aida' ? (
                    <>
                      {[
                        { id: 'attention', label: '1. Attention', desc: 'Внимание и контакт' },
                        { id: 'interest', label: '2. Interest', desc: 'Инсайт и интерес' },
                        { id: 'desire', label: '3. Desire', desc: 'Выгода решения' },
                        { id: 'action', label: '4. Action', desc: 'Призыв к действию' },
                      ].map((st) => (
                        <button
                          key={st.id}
                          type="button"
                          onClick={() => setAiStage(st.id)}
                          className={`p-2 rounded-xl border text-center transition-all cursor-pointer ${
                            aiStage === st.id
                              ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                              : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100'
                          }`}
                        >
                          <div className="font-bold text-xs">{st.label}</div>
                          <div className="text-[10px] opacity-80 mt-0.5">{st.desc}</div>
                        </button>
                      ))}
                    </>
                  ) : (
                    <>
                      {[
                        { id: 'situation', label: '1. Situation', desc: 'Текущие процессы' },
                        { id: 'problem', label: '2. Problem', desc: 'Боль и проблемы' },
                        { id: 'implication', label: '3. Implication', desc: 'Скрытые риски' },
                        { id: 'need_payoff', label: '4. Need-Payoff', desc: 'Ценность решения' },
                      ].map((st) => (
                        <button
                          key={st.id}
                          type="button"
                          onClick={() => setAiStage(st.id)}
                          className={`p-2 rounded-xl border text-center transition-all cursor-pointer ${
                            aiStage === st.id
                              ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                              : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100'
                          }`}
                        >
                          <div className="font-bold text-xs">{st.label}</div>
                          <div className="text-[10px] opacity-80 mt-0.5">{st.desc}</div>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {/* LLM & Sending Account Configuration */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    LLM API Ключ
                  </label>
                  {!apiCredentials || apiCredentials.length === 0 ? (
                    <div className="text-[11px] text-amber-500 bg-amber-500/10 p-2 rounded-xl border border-amber-500/20">
                      Нет ключей. Добавьте в настройках LLM Gateway.
                    </div>
                  ) : (
                    <select
                      value={aiCredentialId}
                      onChange={(e) => {
                        setAiCredentialId(e.target.value);
                        const sel = apiCredentials.find((c) => c.id === e.target.value);
                        if (sel?.provider === 'anthropic') {
                          setAiModelName('claude-3-5-sonnet-20241022');
                        } else {
                          setAiModelName('gpt-4o-mini');
                        }
                      }}
                      className="w-full p-2 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 focus:outline-hidden"
                    >
                      {apiCredentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.provider})
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    Модель нейросети
                  </label>
                  <input
                    type="text"
                    value={aiModelName}
                    onChange={(e) => setAiModelName(e.target.value)}
                    placeholder="gpt-4o-mini"
                    className="w-full p-2 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 focus:outline-hidden font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    Аккаунт отправки
                  </label>
                  <select
                    value={aiAccountId}
                    onChange={(e) => setAiAccountId(e.target.value)}
                    className="w-full p-2 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 focus:outline-hidden"
                  >
                    {accounts?.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.platform.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Custom Context */}
              <div>
                <label className="text-xs font-bold text-zinc-700 dark:text-zinc-300 block mb-1">
                  Контекст темы / боли / предложения
                </label>
                <textarea
                  value={aiCustomContext}
                  onChange={(e) => setAiCustomContext(e.target.value)}
                  rows={2}
                  placeholder="Например: Автоматизация постинга контента во ВКонтакте и Telegram, защита от спам-фильтров и экономия 15 часов в неделю"
                  className="w-full p-2.5 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 focus:outline-hidden resize-none"
                />
              </div>

              {/* Humanizer switch */}
              <div className="p-3 bg-purple-500/5 dark:bg-purple-950/20 border border-purple-500/20 rounded-xl flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                      Модуль Humanizer (Очеловечивание текста)
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-sm bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold">
                      Anti-Detector
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Чередование длины предложений, непредсказуемая лексика и фильтрация маркеров ИИ
                  </div>
                </div>

                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={aiApplyHumanizer}
                    onChange={(e) => setAiApplyHumanizer(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-zinc-300 peer-focus:outline-hidden rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-purple-600"></div>
                </label>
              </div>

              {/* Generated Text Preview Area */}
              {aiGeneratedText && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                      <span>Сгенерированное сообщение:</span>
                    </span>

                    <button
                      type="button"
                      onClick={handleCopyGeneratedText}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-600 hover:text-purple-700 transition-colors"
                    >
                      {hasCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                          <span className="text-emerald-500">Скопировано</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Копировать</span>
                        </>
                      )}
                    </button>
                  </div>

                  <textarea
                    value={aiGeneratedText}
                    onChange={(e) => setAiGeneratedText(e.target.value)}
                    rows={4}
                    className="w-full p-3 bg-zinc-900 text-zinc-100 rounded-xl text-xs font-sans border border-zinc-700 focus:outline-hidden leading-relaxed"
                  />
                </div>
              )}
            </div>

            {/* Modal Actions Footer */}
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="text-[11px] text-zinc-500 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-purple-500" />
                <span>Автоматический расчет анти-бан задержки (15–45 мин + джиттер)</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAIFunnelModal(false)}
                  className="px-3.5 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors cursor-pointer"
                >
                  Отмена
                </button>

                <button
                  type="button"
                  onClick={handleGenerateAIDraft}
                  disabled={generateFunnelMessageMutation.isPending || !aiCredentialId}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
                >
                  {generateFunnelMessageMutation.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Генерация...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Сгенерировать черновик</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleGenerateAndSchedule}
                  disabled={
                    generateAndScheduleMessageMutation.isPending ||
                    generateFunnelMessageMutation.isPending ||
                    !aiAccountId ||
                    !aiCredentialId
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                >
                  {generateAndScheduleMessageMutation.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Планирование...</span>
                    </>
                  ) : (
                    <>
                      <Clock className="w-3.5 h-3.5" />
                      <span>Сгенерировать и запланировать</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
