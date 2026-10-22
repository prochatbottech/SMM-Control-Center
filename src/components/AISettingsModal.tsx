import React, { useState } from 'react';
import {
  X,
  Key,
  ShieldCheck,
  Trash2,
  Plus,
  Sparkles,
  Loader2,
  Eye,
  EyeOff,
  Server,
  Cpu,
} from 'lucide-react';
import {
  useApiCredentialsQuery,
  useCreateApiCredentialMutation,
  useDeleteApiCredentialMutation,
} from '../hooks/useApiCredentials';
import { ApiCredentialProvider } from '../api/db';
import { toast } from 'sonner';

interface AISettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PROVIDER_PRESETS: Record<
  string,
  { name: string; provider: ApiCredentialProvider; baseUrl: string }
> = {
  openai: {
    name: 'OpenAI',
    provider: 'openai_compat',
    baseUrl: 'https://api.openai.com/v1',
  },
  taynik: {
    name: 'Тайник (Taynik)',
    provider: 'openai_compat',
    baseUrl: 'https://taynik.store/v1',
  },
  proxyapi: {
    name: 'ProxyAPI',
    provider: 'openai_compat',
    baseUrl: 'https://api.proxyapi.ru/openai/v1',
  },
  openrouter: {
    name: 'OpenRouter',
    provider: 'openai_compat',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  deepseek: {
    name: 'DeepSeek',
    provider: 'openai_compat',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  groq: {
    name: 'Groq',
    provider: 'openai_compat',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  anthropic: {
    name: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
  },
};

export const AISettingsModal: React.FC<AISettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { data: credentials, isLoading } = useApiCredentialsQuery();
  const createMutation = useCreateApiCredentialMutation();
  const deleteMutation = useDeleteApiCredentialMutation();

  const [provider, setProvider] = useState<ApiCredentialProvider>('openai_compat');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  if (!isOpen) return null;

  const handleSelectPreset = (key: string) => {
    const preset = PROVIDER_PRESETS[key];
    if (preset) {
      setProvider(preset.provider);
      setName(preset.name);
      setBaseUrl(preset.baseUrl);
    }
  };

  const handleProviderChange = (p: ApiCredentialProvider) => {
    setProvider(p);
    if (p === 'anthropic') {
      setName((prev) => (!prev || prev === 'OpenAI' ? 'Anthropic Claude' : prev));
      setBaseUrl('https://api.anthropic.com/v1');
    } else {
      setName((prev) => (!prev || prev === 'Anthropic Claude' ? 'OpenAI' : prev));
      setBaseUrl('https://api.openai.com/v1');
    }
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Введите название профиля API');
      return;
    }
    if (!baseUrl.trim()) {
      toast.error('Введите Base URL');
      return;
    }
    if (!apiKey.trim()) {
      toast.error('Введите API-ключ');
      return;
    }

    const cleanKey = apiKey.trim().replace(/^Bearer\s+/i, '');
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '');

    createMutation.mutate(
      {
        provider,
        name: name.trim(),
        base_url: cleanBaseUrl,
        api_key: cleanKey,
      },
      {
        onSuccess: () => {
          toast.success('API-ключ успешно зашифрован и сохранен!');
          setName('');
          setApiKey('');
          setIsAdding(false);
        },
        onError: (err) => {
          toast.error(`Ошибка при сохранении: ${err.message}`);
        },
      }
    );
  };

  const handleDelete = (id: string, credName: string) => {
    if (confirm(`Удалить ключ "${credName}"?`)) {
      deleteMutation.mutate(id, {
        onSuccess: () => {
          toast.success(`Ключ "${credName}" удален`);
        },
        onError: (err) => {
          toast.error(`Ошибка при удалении: ${err.message}`);
        },
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div
        className="relative w-full max-w-xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-gradient-to-tr from-purple-600 to-indigo-600 text-white rounded-xl shadow-xs">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                Нейросети & LLM API Ключи
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Управление API-ключами с шифрованием AES-256-GCM в OS Keyring
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* List of Keys */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Подключенные шлюзы ({credentials?.length ?? 0})
              </h3>
              {!isAdding && (
                <button
                  type="button"
                  onClick={() => setIsAdding(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-purple-600 dark:text-purple-400 hover:bg-purple-500/10 rounded-lg transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Добавить ключ
                </button>
              )}
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-6 text-zinc-400 text-xs gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                Загрузка ключей...
              </div>
            ) : !credentials || credentials.length === 0 ? (
              <div className="text-center py-6 px-4 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
                <Key className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Нет сохраненных API-ключей
                </p>
                <p className="text-[11px] text-zinc-400 mt-1 max-w-sm mx-auto">
                  Добавьте ключ OpenAI, OpenRouter или Anthropic для генерации текстов, рерайтинга и улучшения постов с помощью ИИ.
                </p>
                {!isAdding && (
                  <button
                    type="button"
                    onClick={() => setIsAdding(true)}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Подключить нейросеть
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {credentials.map((cred) => (
                  <div
                    key={cred.id}
                    className="flex items-center justify-between p-3.5 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                          {cred.name}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                          {cred.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compat'}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <span className="truncate flex items-center gap-1">
                          <Server className="w-3 h-3 text-zinc-400 shrink-0" />
                          {cred.base_url}
                        </span>
                        <span className="font-mono text-zinc-600 dark:text-zinc-300 shrink-0 flex items-center gap-1">
                          <Key className="w-3 h-3 text-zinc-400" />
                          {cred.masked_key || '***'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(cred.id, cred.name)}
                      disabled={deleteMutation.isPending}
                      className="p-1.5 text-zinc-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0 ml-2"
                      title="Удалить ключ"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add Form */}
          {isAdding && (
            <form
              onSubmit={handleCreate}
              className="p-4 bg-zinc-50 dark:bg-zinc-800/80 rounded-xl border border-purple-500/30 space-y-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <Plus className="w-4 h-4 text-purple-500" />
                  Новый API-ключ
                </span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  Свернуть
                </button>
              </div>

              {/* Quick Presets */}
              <div>
                <label className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1.5 block">
                  Быстрые пресеты:
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(PROVIDER_PRESETS).map(([k, p]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => handleSelectPreset(k)}
                      className="px-2 py-1 text-[11px] font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 hover:text-purple-600 dark:hover:text-purple-400 rounded-md transition-colors"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Provider Selection */}
              <div>
                <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 block mb-1.5">
                  Тип провайдера
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleProviderChange('openai_compat')}
                    className={`p-2.5 rounded-lg border text-xs font-medium text-left transition-all ${
                      provider === 'openai_compat'
                        ? 'bg-purple-500/10 border-purple-500/40 text-purple-700 dark:text-purple-300'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1">
                      <Cpu className="w-3.5 h-3.5" />
                      OpenAI-совместимый
                    </div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">
                      OpenAI, OpenRouter, Groq, DeepSeek, vLLM
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleProviderChange('anthropic')}
                    className={`p-2.5 rounded-lg border text-xs font-medium text-left transition-all ${
                      provider === 'anthropic'
                        ? 'bg-purple-500/10 border-purple-500/40 text-purple-700 dark:text-purple-300'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" />
                      Anthropic
                    </div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">
                      Claude 3.5 Sonnet, Claude 3.5 Haiku
                    </div>
                  </button>
                </div>
              </div>

              {/* Name & Base URL */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    Название профиля
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Например: OpenAI Main"
                    className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                  />
                </div>
              </div>

              {/* API Key */}
              <div>
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 block mb-1">
                  API-ключ
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      provider === 'anthropic' ? 'sk-ant-api03-...' : 'sk-proj-...'
                    }
                    className="w-full pl-3 pr-9 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Submit button & security note */}
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>AES-256-GCM шифрование</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAdding(false)}
                    className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    disabled={createMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors"
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Key className="w-3.5 h-3.5" />
                    )}
                    {createMutation.isPending ? 'Шифрование...' : 'Сохранить ключ'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-zinc-50 dark:bg-zinc-800/40 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span>Ключи хранятся локально и никогда не передаются на сторонние серверы</span>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-800 dark:text-zinc-100 rounded-lg text-xs font-medium transition-colors"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
