import React, { useState, useEffect } from 'react';
import {
  Calendar,
  Clock,
  Loader2,
  Send,
  Share2,
  Users,
  Globe,
  AlertCircle,
  BookmarkCheck,
  Image as ImageIcon,
  Sparkles,
  Wand2,
  Undo2,
  Bot,
  Settings,
  UserCheck,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAccountsQuery } from '../hooks/useAccounts';
import { useCreatePostMutation } from '../hooks/usePosts';
import { useApiCredentialsQuery } from '../hooks/useApiCredentials';
import { generateAiRewrite } from '../api/db';
import { AISettingsModal } from './AISettingsModal';
import { MediaPreviewList } from './MediaPreviewList';
import { MarkdownPreview } from './MarkdownPreview';
import { toast } from 'sonner';

interface CreatePostFormProps {
  initialContent?: string;
  initialMediaUrls?: string[];
  onSuccess?: () => void;
  onCancel?: () => void;
}

export const CreatePostForm: React.FC<CreatePostFormProps> = ({
  initialContent = '',
  initialMediaUrls = [],
  onSuccess,
  onCancel,
}) => {
  const [content, setContent] = useState(initialContent);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [mediaUrls, setMediaUrls] = useState<string[]>(initialMediaUrls);
  const [format, setFormat] = useState<'post' | 'article'>('post');
  const [showPreview, setShowPreview] = useState(false);

  // Telegram regular message limit (characters). Above this we suggest an article.
  const TG_POST_LIMIT = 4096;
  const charCount = content.length;
  const overPostLimit = charCount > TG_POST_LIMIT;
  const effectiveFormat: 'post' | 'article' =
    format === 'post' && overPostLimit ? 'article' : format;

  // AI Assistant state
  const [showAIPanel, setShowAIPanel] = useState(false);
  const [showAISettingsModal, setShowAISettingsModal] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>('');
  const [aiModel, setAiModel] = useState<string>('gpt-4o-mini');
  const [aiInstruction, setAiInstruction] = useState<string>(
    'Исправить ошибки и стиль, сделать текст более вовлекающим и добавить эмодзи'
  );
  const [applyHumanizer, setApplyHumanizer] = useState<boolean>(true);
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [previousContent, setPreviousContent] = useState<string | null>(null);

  const { data: accounts, isLoading: isAccountsLoading } = useAccountsQuery();
  const { data: credentials } = useApiCredentialsQuery();
  const createMutation = useCreatePostMutation();

  const isPending = createMutation.isPending || isGeneratingAI;

  // Auto-select first credential if available
  useEffect(() => {
    if (credentials && credentials.length > 0 && !selectedCredentialId) {
      const first = credentials[0];
      setSelectedCredentialId(first.id);
      if (first.provider === 'anthropic') {
        setAiModel('claude-3-5-sonnet-20241022');
      } else {
        setAiModel('gpt-4o-mini');
      }
    }
  }, [credentials, selectedCredentialId]);

  // Update default model when switching credentials
  const handleCredentialChange = (id: string) => {
    setSelectedCredentialId(id);
    const selected = credentials?.find((c) => c.id === id);
    if (selected) {
      if (selected.provider === 'anthropic') {
        setAiModel('claude-3-5-sonnet-20241022');
      } else if (selected.name.toLowerCase().includes('deepseek')) {
        setAiModel('deepseek-chat');
      } else if (selected.name.toLowerCase().includes('openrouter')) {
        setAiModel('meta-llama/llama-3.3-70b-instruct');
      } else {
        setAiModel('gpt-4o-mini');
      }
    }
  };

  const handleGenerateRewrite = async () => {
    if (!content.trim()) {
      toast.error('Введите исходный текст поста для обработки нейросетью');
      return;
    }
    if (!selectedCredentialId) {
      toast.error('Выберите или добавьте API-ключ в настройках');
      setShowAISettingsModal(true);
      return;
    }
    if (!aiModel.trim()) {
      toast.error('Укажите название модели');
      return;
    }

    setIsGeneratingAI(true);
    try {
      const original = content;
      const rewritten = await generateAiRewrite(
        content,
        aiInstruction,
        aiModel.trim(),
        selectedCredentialId,
        applyHumanizer
      );
      setPreviousContent(original);
      setContent(rewritten);
      toast.success('Текст поста успешно улучшен нейросетью!');
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`Ошибка генерации: ${msg}`);
    } finally {
      setIsGeneratingAI(false);
    }
  };

  const handleUndoRewrite = () => {
    if (previousContent !== null) {
      setContent(previousContent);
      setPreviousContent(null);
      toast.info('Возвращен предыдущий вариант текста');
    }
  };

  // Native file selection dialog via @tauri-apps/plugin-dialog
  // Invariant: strictly filter to images, limit to max 10 files
  const handleAttachMedia = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: 'Изображения',
            extensions: ['jpg', 'jpeg', 'png', 'webp'],
          },
        ],
      });

      if (!selected) return;

      const incoming: string[] = Array.isArray(selected)
        ? selected
        : [selected];

      if (incoming.length === 0) return;

      setMediaUrls((prev) => {
        // Filter out already attached files
        const uniqueNew = incoming.filter((p) => !prev.includes(p));
        const combined = [...prev, ...uniqueNew];

        // Invariant: Max 10 files per post
        if (combined.length > 10) {
          const cutCount = combined.length - 10;
          toast.warning(
            `Превышен лимит: прикреплено максимум 10 файлов (отсечено ${cutCount})`
          );
          return combined.slice(0, 10);
        }

        return combined;
      });
    } catch (err) {
      toast.error(`Ошибка при открытии диалога файлов: ${err}`);
    }
  };

  const handleRemoveMedia = (index: number) => {
    setMediaUrls((prev) => prev.filter((_, idx) => idx !== index));
  };

  // Helper to format date for datetime-local input
  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
      now.getHours()
    )}:${pad(now.getMinutes())}`;
  };

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((accId) => accId !== id) : [...prev, id]
    );
  };

  const selectAllAccounts = () => {
    if (!accounts) return;
    if (selectedAccountIds.length === accounts.length) {
      setSelectedAccountIds([]);
    } else {
      setSelectedAccountIds(accounts.map((a) => a.id));
    }
  };

  // Convert input datetime-local string to Unix timestamp (seconds, UTC)
  const parseScheduledTimestamp = (dtString: string): number | null => {
    if (!dtString) return null;
    const parsed = new Date(dtString).getTime();
    if (isNaN(parsed)) return null;
    return Math.floor(parsed / 1000);
  };

  // Quick preset helper
  const setQuickSchedule = (minutesFromNow: number) => {
    const target = new Date(Date.now() + minutesFromNow * 60 * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    setScheduledAt(
      `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(
        target.getHours()
      )}:${pad(target.getMinutes())}`
    );
  };

  // Handle Draft submission (Rule: Draft relaxes accounts and time validation)
  const handleSaveDraft = () => {
    const scheduledTimestamp = parseScheduledTimestamp(scheduledAt);

    createMutation.mutate(
      {
        content: content.trim(),
        destination_account_ids: selectedAccountIds,
        status: 'draft',
        scheduled_for: scheduledTimestamp,
        media_urls: mediaUrls,
        format: effectiveFormat,
      },
      {
        onSuccess: () => {
          toast.success('Черновик успешно сохранен!');
          resetForm();
          onSuccess?.();
        },
        onError: (err: any) => {
          const msg = typeof err === 'string' ? err : err?.message || String(err);
          toast.error(`Ошибка при сохранении черновика: ${msg}`);
        },
      }
    );
  };

  // Handle Scheduled submission (Rule: Strict validation of accounts and future time)
  const handleSchedulePost = () => {
    // Invariant 1: Content must not be empty (unless photos are attached)
    if (!content.trim() && mediaUrls.length === 0) {
      toast.error('Пожалуйста, введите текст публикации или прикрепите фото');
      return;
    }

    // Invariant 2: At least 1 account must be selected
    if (selectedAccountIds.length === 0) {
      toast.error('Выберите хотя бы один аккаунт для публикации');
      return;
    }

    // Invariant 3: Scheduled time must be set
    const scheduledTimestamp = parseScheduledTimestamp(scheduledAt);
    if (!scheduledTimestamp) {
      toast.error('Укажите дату и время отложенной публикации');
      return;
    }

    // Invariant 4: Scheduled time must be strictly in the future
    const nowTimestamp = Math.floor(Date.now() / 1000);
    if (scheduledTimestamp <= nowTimestamp) {
      toast.error('Время публикации должно быть позже текущего момента');
      return;
    }

    createMutation.mutate(
      {
        content: content.trim(),
        destination_account_ids: selectedAccountIds,
        status: 'scheduled',
        scheduled_for: scheduledTimestamp,
        media_urls: mediaUrls,
        format: effectiveFormat,
      },
      {
        onSuccess: () => {
          const dateStr = new Date(scheduledTimestamp * 1000).toLocaleString('ru-RU');
          toast.success(`Пост успешно запланирован на ${dateStr}!`);
          resetForm();
          onSuccess?.();
        },
        onError: (err: any) => {
          const msg = typeof err === 'string' ? err : err?.message || String(err);
          toast.error(`Ошибка планирования: ${msg}`);
        },
      }
    );
  };

  const resetForm = () => {
    setContent('');
    setSelectedAccountIds([]);
    setScheduledAt('');
    setMediaUrls([]);
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
        return <Globe className="w-3.5 h-3.5 text-slate-500" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Account Selection (Checkboxes) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
            Целевые аккаунты ({selectedAccountIds.length})
          </label>
          {accounts && accounts.length > 0 && (
            <button
              type="button"
              onClick={selectAllAccounts}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {selectedAccountIds.length === accounts.length ? 'Снять все' : 'Выбрать все'}
            </button>
          )}
        </div>

        {isAccountsLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            Загрузка аккаунтов...
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>Нет подключенных аккаунтов. Вы можете сохранить черновик, но для отложенной публикации добавьте аккаунт в разделе «Аккаунты».</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
            {accounts.map((acc) => {
              const isSelected = selectedAccountIds.includes(acc.id);
              return (
                <label
                  key={acc.id}
                  onClick={() => toggleAccount(acc.id)}
                  className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer select-none transition-all ${
                    isSelected
                      ? 'bg-blue-500/10 border-blue-500/40 text-zinc-900 dark:text-zinc-100 shadow-2xs'
                      : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {}} // handled by label onClick
                    className="w-4 h-4 rounded-sm text-blue-600 border-zinc-300 dark:border-zinc-700 focus:ring-blue-500/20"
                  />
                  <div className="flex items-center gap-1.5 min-w-0">
                    {getPlatformIcon(acc.platform)}
                    <span className="text-xs font-medium truncate">{acc.name}</span>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Post Content & Media */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
              Текст публикации
            </label>
            <div className="flex items-center p-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
              <button
                type="button"
                onClick={() => setFormat('post')}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  effectiveFormat === 'post'
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                Пост
              </button>
              <button
                type="button"
                onClick={() => setFormat('article')}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  effectiveFormat === 'article'
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                Статья
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {previousContent !== null && (
              <button
                type="button"
                onClick={handleUndoRewrite}
                title="Отменить последнее изменение нейросети"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Вернуть оригинал</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowAIPanel(!showAIPanel)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                showAIPanel
                  ? 'bg-purple-600 text-white shadow-xs'
                  : 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/30'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>ИИ Ассистент</span>
            </button>

            <span
              className={`text-xs font-mono ${
                overPostLimit && format === 'post'
                  ? 'text-rose-500 font-semibold'
                  : 'text-zinc-400'
              }`}
              title={format === 'post' ? `Лимит поста: ${TG_POST_LIMIT} символов` : 'Режим статьи'}
            >
              {charCount}
              {format === 'post' ? ` / ${TG_POST_LIMIT}` : ''} симв.
            </span>
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                showPreview
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              {showPreview ? 'Редактор' : 'Превью'}
            </button>
            <button
              type="button"
              onClick={handleAttachMedia}
              disabled={isPending || mediaUrls.length >= 10}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              <ImageIcon className="w-3.5 h-3.5 text-blue-500" />
              <span>Прикрепить фото</span>
              {mediaUrls.length > 0 && (
                <span className="font-mono text-[10px] text-zinc-400">
                  ({mediaUrls.length}/10)
                </span>
              )}
            </button>
          </div>
        </div>

        {/* AI Assistant Expandable Panel */}
        {showAIPanel && (
          <div className="p-4 bg-gradient-to-b from-purple-500/5 to-purple-500/10 dark:from-purple-950/20 dark:to-purple-900/10 rounded-2xl border border-purple-500/30 space-y-3.5 animate-in fade-in duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-purple-600 text-white rounded-lg">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                    Умный рерайтер контента
                  </h4>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Перепишите или улучшите текст поста с помощью выбранной модели
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAISettingsModal(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400 hover:text-purple-600 dark:hover:text-purple-400 bg-white/60 dark:bg-zinc-800/60 rounded-lg border border-zinc-200/60 dark:border-zinc-700/60 transition-colors"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>Ключи API</span>
                </button>
              </div>
            </div>

            {/* Credential and Model Selector */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 block mb-1">
                  Активный провайдер / Ключ
                </label>
                {!credentials || credentials.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAISettingsModal(true)}
                    className="w-full text-left px-3 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg text-xs font-medium text-amber-700 dark:text-amber-400 transition-colors"
                  >
                    + Подключить API-ключ нейросети
                  </button>
                ) : (
                  <select
                    value={selectedCredentialId}
                    onChange={(e) => handleCredentialChange(e.target.value)}
                    disabled={isGeneratingAI}
                    className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 font-medium"
                  >
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compat'}, {c.masked_key || '***'})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 block mb-1">
                  Модель
                </label>
                <input
                  type="text"
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  disabled={isGeneratingAI}
                  placeholder="gpt-4o-mini или claude-3-5-sonnet-20241022"
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                />
              </div>
            </div>

            {/* Quick Model Badges */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-zinc-400">Быстрый выбор модели:</span>
              {['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-20241022', 'deepseek-chat'].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAiModel(m)}
                  disabled={isGeneratingAI}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded-md border transition-colors ${
                    aiModel === m
                      ? 'bg-purple-600 text-white border-purple-600'
                      : 'bg-white/80 dark:bg-zinc-900/80 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-purple-500'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Instruction presets */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                  Инструкция для рерайтинга
                </label>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: 'Ошибки и стиль', text: 'Исправить грамматику, опечатки, пунктуацию и сделать текст легко читаемым' },
                    { label: 'Сделать короче', text: 'Сделать текст максимально кратким, ёмким и динамичным' },
                    { label: 'Хук + Эмодзи', text: 'Добавить вовлекающий цепляющий заголовок, уместные эмодзи и призыв к действию в конце' },
                    { label: 'Продающий (AIDA)', text: 'Переписать текст по маркетинговой формуле AIDA (Внимание, Интерес, Желание, Действие)' },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setAiInstruction(preset.text)}
                      disabled={isGeneratingAI}
                      className="px-2 py-0.5 text-[10px] font-medium bg-white/80 dark:bg-zinc-900/80 hover:bg-purple-50 dark:hover:bg-purple-950/40 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 text-zinc-700 dark:text-zinc-300 rounded-md transition-colors"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="text"
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                disabled={isGeneratingAI}
                placeholder="Например: Переписать в неформальном стиле для Telegram"
                className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
              />
            </div>

            {/* Humanizer switch & AI Action button */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-purple-500/15">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <div className="relative inline-flex items-center">
                  <input
                    type="checkbox"
                    checked={applyHumanizer}
                    onChange={(e) => setApplyHumanizer(e.target.checked)}
                    disabled={isGeneratingAI}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-hidden rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-purple-600"></div>
                </div>
                <div>
                  <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <UserCheck className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                    Очеловечить текст (Humanizer)
                  </span>
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400 block">
                    Burstiness, Perplexity и бан стоп-слов ИИ для обхода детекторов
                  </span>
                </div>
              </label>

              <button
                type="button"
                onClick={handleGenerateRewrite}
                disabled={isGeneratingAI || !content.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white rounded-xl text-xs font-bold shadow-md shadow-purple-500/20 disabled:opacity-50 transition-all cursor-pointer ml-auto"
              >
                {isGeneratingAI ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Wand2 className="w-4 h-4" />
                )}
                {isGeneratingAI ? 'Генерация ответа...' : 'Сгенерировать улучшение'}
              </button>
            </div>
          </div>
        )}

        {/* Media Preview list if files attached */}
        {mediaUrls.length > 0 && (
          <MediaPreviewList
            mediaUrls={mediaUrls}
            onRemove={handleRemoveMedia}
          />
        )}

        {/* Warning: post exceeds Telegram message limit */}
        {overPostLimit && format === 'post' && (
          <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-800 dark:text-amber-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Превышен лимит поста ({TG_POST_LIMIT} символов — сейчас {charCount}). Для Telegram
              публикация будет отправлена <strong>как статья</strong> (rich-сообщение) с
              Markdown-форматированием.
            </span>
          </div>
        )}

        {/* Editor / Markdown preview */}
        {showPreview ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <textarea
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isPending}
              placeholder="Markdown: # заголовок, **жирный**, *курсив*, - список, > цитата, `код`…"
              className="w-full p-3.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50 resize-y font-mono"
            />
            <div className="w-full p-3.5 min-h-[16rem] max-h-[24rem] overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl">
              <MarkdownPreview content={content} />
            </div>
          </div>
        ) : (
          <textarea
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={isPending}
            placeholder={
              effectiveFormat === 'article'
                ? 'Текст статьи в Markdown: # заголовок, списки, цитаты, ссылки…'
                : 'Напишите текст вашего поста...'
            }
            className="w-full p-3.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50 resize-y"
          />
        )}
      </div>

      {/* 3. Schedule Time (datetime-local + quick presets) */}
      <div className="p-4 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 space-y-3">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5 text-blue-500" />
            Время отложенной публикации
          </label>
          <span className="text-xs text-zinc-400">Локальное время</span>
        </div>

        <input
          type="datetime-local"
          value={scheduledAt}
          min={getMinDateTime()}
          onChange={(e) => setScheduledAt(e.target.value)}
          disabled={isPending}
          className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50"
        />

        {/* Quick presets */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs text-zinc-400">Быстро:</span>
          <button
            type="button"
            onClick={() => setQuickSchedule(1)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-blue-500 hover:text-blue-600 rounded-md transition-colors"
          >
            +1 мин
          </button>
          <button
            type="button"
            onClick={() => setQuickSchedule(10)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-blue-500 hover:text-blue-600 rounded-md transition-colors"
          >
            +10 мин
          </button>
          <button
            type="button"
            onClick={() => setQuickSchedule(60)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-blue-500 hover:text-blue-600 rounded-md transition-colors"
          >
            +1 час
          </button>
          <button
            type="button"
            onClick={() => setQuickSchedule(1440)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-blue-500 hover:text-blue-600 rounded-md transition-colors"
          >
            +1 день
          </button>
        </div>
      </div>

      {/* 4. Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
        <div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
            >
              Отмена
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          {/* Draft button */}
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={isPending}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-sm font-medium rounded-xl transition-colors disabled:opacity-50"
          >
            <BookmarkCheck className="w-4 h-4" />
            Сохранить черновик
          </button>

          {/* Schedule button */}
          <button
            type="button"
            onClick={handleSchedulePost}
            disabled={isPending}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-xl transition-colors shadow-xs disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Calendar className="w-4 h-4" />
            )}
            {isPending ? 'Сохранение...' : 'Запланировать'}
          </button>
        </div>
      </div>

      {/* AI Settings Modal */}
      <AISettingsModal
        isOpen={showAISettingsModal}
        onClose={() => setShowAISettingsModal(false)}
      />
    </div>
  );
};
