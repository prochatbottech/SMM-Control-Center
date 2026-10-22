import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { Platform } from '../api/db';
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

  const createMutation = useCreateAccountMutation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

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
      {
        platform,
        name: name.trim(),
        token: tokenValue,
      },
      {
        onSuccess: (createdAccount) => {
          toast.success(`Аккаунт "${createdAccount.name}" успешно подключен!`);
          // Invariant: UI Security: Clear raw token and inputs immediately on success
          setToken('');
          setOkAccessToken('');
          setOkAppKey('');
          setOkSessionSecret('');
          setOkGid('');
          setName('');
          setPlatform('vk');
          onSuccess?.();
        },
        onError: (err: any) => {
          // Edge case: Display IPC/Rust error cleanly without crashing React
          const msg = typeof err === 'string' ? err : err?.message || String(err);
          toast.error(`Ошибка при сохранении: ${msg}`);
        },
      }
    );
  };

  const isPending = createMutation.isPending;

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
            Для публичных каналов укажите юзернейм (например, <code>@my_channel</code> или <code>my_channel</code>). Бот должен быть добавлен в администраторы канала.
          </p>
        )}
      </div>

      {platform === 'ok' ? (
        <div className="space-y-3">
          <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
            Для Одноклассников укажите данные REST API приложения и сессии. Все значения будут зашифрованы AES-256.
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
        /* Access Token (Password Input) */
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
            !name.trim() ||
            (platform === 'ok'
              ? !okAccessToken.trim() || !okAppKey.trim() || !okSessionSecret.trim()
              : !token.trim())
          }
          className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {isPending ? 'Шифрование и сохранение...' : 'Добавить аккаунт'}
        </button>
      </div>
    </form>
  );
};
