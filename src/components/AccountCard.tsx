import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Trash2,
  Lock,
  Send,
  Share2,
  Users,
  Globe,
  Loader2,
  Calendar,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Account, vkAddCommunity, vkChangeCommunity } from '../api/db';
import { useDeleteAccountMutation, ACCOUNTS_QUERY_KEY } from '../hooks/useAccounts';
import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { toast } from 'sonner';

interface AccountCardProps {
  account: Account;
}

export const AccountCard: React.FC<AccountCardProps> = ({ account }) => {
  const deleteMutation = useDeleteAccountMutation();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const queryClient = useQueryClient();
  const [promptMode, setPromptMode] = React.useState<'add' | 'change' | null>(null);
  const [promptPending, setPromptPending] = React.useState(false);

  const handlePromptConfirm = async (value: string) => {
    if (!promptMode) return;
    setPromptPending(true);
    try {
      if (promptMode === 'add') {
        const created = await vkAddCommunity(account.id, value);
        toast.success(`Добавлено сообщество: ${created.name}`);
      } else {
        const res = await vkChangeCommunity(account.id, value);
        toast.success(`Сообщество изменено: ${res.title}`);
      }
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      setPromptMode(null);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`Ошибка: ${msg}`);
    } finally {
      setPromptPending(false);
    }
  };

  const handleDelete = () => {
    deleteMutation.mutate(account.id, {
      onSuccess: () => {
        toast.success(`Аккаунт "${account.name}" успешно удален`);
        setConfirmDelete(false);
      },
      onError: (err: any) => {
        const msg = typeof err === 'string' ? err : err?.message || String(err);
        toast.error(`Ошибка при удалении: ${msg}`);
      },
    });
  };

  const getPlatformMeta = (platform: string) => {
    switch (platform.toLowerCase()) {
      case 'vk':
        return {
          label: 'ВКонтакте',
          bg: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
          icon: <Share2 className="w-5 h-5 text-blue-500" />,
        };
      case 'tg':
      case 'telegram':
        return {
          label: 'Telegram',
          bg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
          icon: <Send className="w-5 h-5 text-sky-500" />,
        };
      case 'ok':
        return {
          label: 'Одноклассники',
          bg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
          icon: <Users className="w-5 h-5 text-amber-500" />,
        };
      case 'instagram':
        return {
          label: 'Instagram',
          bg: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
          icon: (
            <svg className="w-5 h-5 text-pink-500 fill-current" viewBox="0 0 24 24">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
            </svg>
          ),
        };
      default:
        return {
          label: platform.toUpperCase(),
          bg: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
          icon: <Globe className="w-5 h-5 text-slate-500" />,
        };
    }
  };

  const platformMeta = getPlatformMeta(account.platform);
  const createdDate = new Date(account.created_at * 1000).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col justify-between p-5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xs hover:shadow-md transition-shadow">
      <div>
        {/* Header: Platform badge & Delete Button */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg border ${platformMeta.bg}`}>
              {platformMeta.icon}
            </div>
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {platformMeta.label}
              </span>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]">
                {account.name}
              </h3>
            </div>
          </div>

          <button
            onClick={() => setConfirmDelete(true)}
            disabled={deleteMutation.isPending}
            title="Удалить аккаунт"
            className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-500/10 dark:hover:bg-red-500/20 rounded-lg transition-colors disabled:opacity-50"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin text-red-500" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Security / Token preview info */}
        <div className="mt-3 p-2.5 bg-zinc-50 dark:bg-zinc-800/60 rounded-lg border border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-1">
            <span className="flex items-center gap-1 font-medium">
              <Lock className="w-3 h-3 text-emerald-500" />
              Токен защищен (AES-256)
            </span>
          </div>
          <p className="font-mono text-xs text-zinc-700 dark:text-zinc-300 truncate">
            {account.masked_token || `${account.platform}_***encrypted`}
          </p>
        </div>

        {/* VK: publishing target + community management */}
        {account.platform === 'vk' && (
          <div className="mt-3 space-y-2">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Публикация:{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {account.target_title || 'личная стена'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPromptMode('add')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Добавить сообщество
              </button>
              <button
                type="button"
                onClick={() => setPromptMode('change')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 rounded-lg transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Сменить сообщество
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer: Date */}
      <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center text-xs text-zinc-400">
        <Calendar className="w-3.5 h-3.5 mr-1.5" />
        <span>Подключен {createdDate}</span>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить аккаунт?"
        description={`Аккаунт "${account.name}" будет удален. Связанные записи публикаций также будут удалены.`}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <PromptDialog
        open={promptMode !== null}
        title={promptMode === 'add' ? 'Добавить сообщество' : 'Сменить сообщество'}
        description="Введите ссылку, короткое имя или ID сообщества (например, vk.com/mygroup или 12345678)."
        placeholder="vk.com/mygroup"
        confirmLabel={promptMode === 'add' ? 'Добавить' : 'Сохранить'}
        isPending={promptPending}
        onConfirm={handlePromptConfirm}
        onCancel={() => setPromptMode(null)}
      />
    </div>
  );
};
