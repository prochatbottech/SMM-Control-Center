import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck, Users } from 'lucide-react';
import { Platform, VkCommunity, vkListCommunities, vkOauthLogin, setAccountTarget } from '../api/db';
import { useCreateAccountMutation } from '../hooks/useAccounts';
import { toast } from 'sonner';

interface AddAccountFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export const AddAccountForm: React.FC<AddAccountFormProps> = ({ onSuccess, onCancel }) => {
  const [platform, setPlatform] = useState<Platform>('vk');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  // OK (Одноклассники) requires a set of REST API credentials.
  const [okAccessToken, setOkAccessToken] = useState('');
  const [okAppKey, setOkAppKey] = useState('');
  const [okSessionSecret, setOkSessionSecret] = useState('');
  const [okGid, setOkGid] = useState('');

  // VK ID authorization + community selection.
  const [vkToken, setVkToken] = useState('');
  const [vkUserId, setVkUserId] = useState('');
  const [vkCommunities, setVkCommunities] = useState<VkCommunity[]>([]);
  const [vkLoading, setVkLoading] = useState(false);
  const [vkTarget, setVkTarget] = useState<{ id: string; title: string } | null>(null);

  const createMutation = useCreateAccountMutation();

  const resetAll = () => {
    setToken('');
    setOkAccessToken('');
    setOkAppKey('');
    setOkSessionSecret('');
    setOkGid('');
    setVkToken('');
    setVkUserId('');
    setVkCommunities([]);
    setVkTarget(null);
    setName('');
    setPlatform('vk');
  };

  const handleVkLogin = (accessToken: string, userId?: string) => {
    setVkToken(accessToken);
    setVkUserId(userId ?? '');
    setVkLoading(true);
    vkListCommunities(accessToken)
      .then((list) => {
        setVkCommunities(list);
        if (list.length === 0) {
          toast.info('Сообщества не найдены. Доступна публикация на личную стену.');
        }
      })
      .catch((err: any) => {
        const msg = typeof err === 'string' ? err : err?.message || String(err);
        toast.error(`Не удалось получить список сообществ: ${msg}`);
      })
      .finally(() => setVkLoading(false));
  };

  const handleVkLoginClick = async () => {
    setVkLoading(true);
    try {
      const res = await vkOauthLogin();
      handleVkLogin(res.accessToken, res.userId ?? undefined);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`VK вход: ${msg}`);
      setVkLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (platform === 'vk') {
      if (!vkToken) {
        toast.error('Сначала войдите через VK / OK / Mail.ru');
        return;
      }
      if (!vkTarget) {
        toast.error('Выберите сообщество или личную стену для публикации');
        return;
      }
      createMutation.mutate(
        { platform: 'vk', name: vkTarget.title, token: vkToken },
        {
          onSuccess: async (createdAccount) => {
            try {
              await setAccountTarget(createdAccount.id, {
                authType: 'vk_id',
                targetId: vkTarget.id,
                targetTitle: vkTarget.title,
                ownerExternalId: vkUserId || null,
              });
              toast.success(`VK: «${vkTarget.title}» подключено!`);
              resetAll();
              onSuccess?.();
            } catch (err: any) {
              const msg = typeof err === 'string' ? err : err?.message || String(err);
              toast.error(`Аккаунт создан, но target не сохранён: ${msg}`);
            }
          },
          onError: (err: any) => {
            const msg = typeof err === 'string' ? err : err?.message || String(err);
            toast.error(`Ошибка при сохранении: ${msg}`);
          },
        }
      );
      return;
    }

    if (!name.trim()) {
      toast.error('Пожалуйста, укажите отображаемое имя');
      return;
    }

    let tokenValue = token.trim();
    if (platform === 'ok') {
      if (!okAccessToken.trim() || !okAppKey.trim() || !okSessionSecret.trim()) {
        toast.error('Для OK заполните Access Token, Application Key и Session Secret Key');
        return;
      }
      tokenValue = JSON.stringify({
        access_token: okAccessToken.trim(),
        application_key: okAppKey.trim(),
        session_secret_key: okSessionSecret.trim(),
        gid: okGid.trim(),
      });
    } else if (!tokenValue) {
      toast.error('Пожалуйста, введите токен доступа');
      return;
    }

    createMutation.mutate(
      { platform, name: name.trim(), token: tokenValue },
      {
        onSuccess: (createdAccount) => {
          toast.success(`Аккаунт "${createdAccount.name}" успешно подключен!`);
          resetAll();
          onSuccess?.();
        },
        onError: (err: any) => {
          const msg = typeof err === 'string' ? err : err?.message || String(err);
          toast.error(`Ошибка при сохранении: ${msg}`);
        },
      }
    );
  };

  const isPending = createMutation.isPending;
  const isVk = platform === 'vk';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Platform Select */}
      <div>
        <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-1.5">
          Платформа
        </label>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          disabled={isPending}
          className="w-full px-3.5 py-2.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50"
        >
          <option value="vk">ВКонтакте (VK)</option>
          <option value="tg">Telegram (Канал/Бот)</option>
          <option value="ok">Одноклассники (OK)</option>
          <option value="instagram">Instagram</option>
        </select>
      </div>

      {isVk ? (
        <div className="space-y-3">
          {!vkToken ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Нажмите «Войти через VK» — откроется браузер (вход через VK / OK / Mail.ru).
                После входа вернитесь в приложение и выберите сообщество.
              </p>
              <button
                type="button"
                onClick={handleVkLoginClick}
                disabled={vkLoading || isPending}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {vkLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                {vkLoading ? 'Ожидание входа в браузере…' : 'Войти через VK'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" /> Вход выполнен
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setVkToken('');
                    setVkCommunities([]);
                    setVkTarget(null);
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  Сменить
                </button>
              </div>

              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
                Куда публиковать
              </label>

              {vkLoading ? (
                <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  Загрузка сообществ…
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-1.5 border border-zinc-200 dark:border-zinc-700 rounded-xl p-2">
                  {vkUserId && (
                    <label
                      className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border ${
                        vkTarget?.id === vkUserId
                          ? 'bg-blue-500/10 border-blue-500/40'
                          : 'bg-zinc-50 dark:bg-zinc-800/60 border-transparent hover:border-zinc-300 dark:hover:border-zinc-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="vkTarget"
                        checked={vkTarget?.id === vkUserId}
                        onChange={() =>
                          setVkTarget({ id: vkUserId, title: 'Личная стена (VK)' })
                        }
                      />
                      <span className="text-xs font-medium">Личная стена</span>
                    </label>
                  )}
                  {vkCommunities.map((c) => {
                    const tid = `-${c.id}`;
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border ${
                          vkTarget?.id === tid
                            ? 'bg-blue-500/10 border-blue-500/40'
                            : 'bg-zinc-50 dark:bg-zinc-800/60 border-transparent hover:border-zinc-300 dark:hover:border-zinc-600'
                        }`}
                      >
                        <input
                          type="radio"
                          name="vkTarget"
                          checked={vkTarget?.id === tid}
                          onChange={() => setVkTarget({ id: tid, title: c.name })}
                        />
                        {c.photo ? (
                          <img src={c.photo} alt="" className="w-6 h-6 rounded-full object-cover" />
                        ) : (
                          <Users className="w-4 h-4 text-zinc-400" />
                        )}
                        <span className="text-xs font-medium truncate">{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Account Name */}
          <div>
            <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-1.5">
              {platform === 'tg' ? 'Канал / Чат (Username или ID)' : 'Название аккаунта'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isPending}
              placeholder={
                platform === 'tg'
                  ? 'Например: @my_channel или -1001234567890'
                  : 'Например: Новости IT / Личный блог'
              }
              className="w-full px-3.5 py-2.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50"
            />
            {platform === 'tg' && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Для публичных каналов укажите юзернейм (например, <code>@my_channel</code> или{' '}
                <code>my_channel</code>). Бот должен быть добавлен в администраторы канала.
              </p>
            )}
          </div>

          {platform === 'ok' ? (
            <div className="space-y-3">
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                Вход через OK пока <b>временный ручной</b> (нужны данные приложения/сессии). Готовится
                полноценный OK-логин через OAuth (требуется application_id). Значения шифруются AES-256.
              </p>
              {[
                { label: 'Access Token', value: okAccessToken, onChange: setOkAccessToken, placeholder: 'Токен доступа сессии' },
                { label: 'Application Key', value: okAppKey, onChange: setOkAppKey, placeholder: 'Публичный ключ приложения' },
                { label: 'Session Secret Key', value: okSessionSecret, onChange: setOkSessionSecret, placeholder: 'Секретный ключ сессии' },
                { label: 'Group ID (gid)', value: okGid, onChange: setOkGid, placeholder: 'ID группы OK (опционально)' },
              ].map((field) => (
                <div key={field.label}>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-1.5">
                    {field.label}
                  </label>
                  <input
                    type="password"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    disabled={isPending}
                    placeholder={field.placeholder}
                    className="w-full px-3.5 py-2.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50 font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-1.5">
                OAuth-токен доступа
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isPending}
                  placeholder="Вставьте токен доступа"
                  className="w-full pl-3.5 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors disabled:opacity-50 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  disabled={isPending}
                  tabIndex={-1}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="flex items-center gap-1.5 mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                Токен шифруется ключом AES-256 в OS Keyring и не сохраняется в открытом виде.
              </p>
            </div>
          )}
        </>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
        )}
        <button
          type="submit"
          disabled={
            isPending ||
            (isVk
              ? !vkToken || !vkTarget
              : !name.trim() ||
                (platform === 'ok'
                  ? !okAccessToken.trim() || !okAppKey.trim() || !okSessionSecret.trim()
                  : !token.trim()))
          }
          className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {isPending ? 'Сохранение...' : 'Добавить аккаунт'}
        </button>
      </div>
    </form>
  );
};
