import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Loader2, Trash2, ExternalLink, Users, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  AudienceContact,
  BehaviorQuota,
  deleteAudienceContact,
  getBehaviorQuota,
  listAudience,
  parseAudience,
  sendFriendRequests,
} from '../api/db';
import { useAccountsQuery } from '../hooks/useAccounts';
import { ConfirmDialog } from './ConfirmDialog';

const AUDIENCE_QUERY_KEY = ['audience'] as const;
const QUOTA_QUERY_KEY = ['behavior-quota'] as const;

const STATUS_LABEL: Record<string, string> = {
  new: 'Новый',
  friend_requested: 'Заявка отправлена',
  friend: 'В друзьях',
  message_sent: 'Написали',
  skipped: 'Пропущен',
};

const STATUS_STYLE: Record<string, string> = {
  new: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  friend_requested:
    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  friend: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  message_sent: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  skipped: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
};

export function AudienceView() {
  const queryClient = useQueryClient();
  const { data: accounts } = useAccountsQuery();
  const [accountId, setAccountId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const [isParsing, setIsParsing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [friendLimit, setFriendLimit] = useState(5);
  const [confirmFriends, setConfirmFriends] = useState(false);

  const browserAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.auth_type === 'browser'),
    [accounts]
  );

  const effectiveAccountId = accountId || browserAccounts[0]?.id || '';

  const { data: contacts, isLoading } = useQuery<AudienceContact[], Error>({
    queryKey: [...AUDIENCE_QUERY_KEY, effectiveAccountId],
    queryFn: async () => await listAudience(effectiveAccountId || null),
  });

  // Daily budget for the selected account: shown before the user starts a batch
  // so an exhausted quota is visible instead of surfacing as an error.
  const { data: quotas } = useQuery<BehaviorQuota[], Error>({
    queryKey: [...QUOTA_QUERY_KEY, effectiveAccountId],
    queryFn: async () => await getBehaviorQuota(effectiveAccountId),
    enabled: !!effectiveAccountId,
  });

  const quotaFor = (action: string) => quotas?.find((q) => q.action === action);

  const stats = useMemo(() => {
    const list = contacts ?? [];
    return {
      total: list.length,
      fresh: list.filter((c) => c.status === 'new').length,
      requested: list.filter((c) => c.status === 'friend_requested').length,
      friends: list.filter((c) => c.status === 'friend').length,
    };
  }, [contacts]);

  const handleParse = async () => {
    if (!effectiveAccountId) {
      toast.error('Сначала добавьте браузерный аккаунт VK');
      return;
    }
    if (!query.trim()) {
      toast.error('Укажите сообщество');
      return;
    }

    setIsParsing(true);
    try {
      const res = await parseAudience(effectiveAccountId, query.trim(), limit);
      await queryClient.invalidateQueries({ queryKey: AUDIENCE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: QUOTA_QUERY_KEY });
      toast.success(
        `Найдено ${res.parsed}, новых контактов: ${res.inserted}`
      );
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`Ошибка парсинга: ${msg}`);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSendFriends = async () => {
    setConfirmFriends(false);
    setIsSending(true);
    try {
      const res = await sendFriendRequests(effectiveAccountId, friendLimit);
      await queryClient.invalidateQueries({ queryKey: AUDIENCE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: QUOTA_QUERY_KEY });
      const left = res.quota_left != null ? `, осталось на сегодня: ${res.quota_left}` : '';
      toast.success(`Заявок отправлено: ${res.requested}, пропущено: ${res.skipped} (из ${res.total})${left}`);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`Ошибка отправки заявок: ${msg}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAudienceContact(id);
      await queryClient.invalidateQueries({ queryKey: AUDIENCE_QUERY_KEY });
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      toast.error(`Ошибка удаления: ${msg}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-500" />
            Аудитория
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Сбор участников сообществ VK через браузер (без API). Собираются имя и ссылка на
            профиль.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
            Всего: <b>{stats.total}</b>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30">
            Новых: <b>{stats.fresh}</b>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            Заявок: <b>{stats.requested}</b>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
            Друзей: <b>{stats.friends}</b>
          </span>
        </div>
      </div>

      <div className="p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-3">
        <div className="grid gap-3 md:grid-cols-[1.2fr_1.6fr_0.6fr_auto]">
          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Аккаунт (браузер)
            </label>
            <select
              value={effectiveAccountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg"
            >
              {browserAccounts.length === 0 ? (
                <option value="">Нет браузерных аккаунтов</option>
              ) : (
                browserAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.platform})
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Сообщество
            </label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="vk.com/mygroup или mygroup"
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Лимит
            </label>
            <input
              type="number"
              min={1}
              max={300}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg"
            />
          </div>

          <div className="flex items-end">
            <button
              onClick={handleParse}
              disabled={isParsing || !effectiveAccountId}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {isParsing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Собираю...
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  Распарсить
                </>
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          Сбор идёт медленно, с паузами (имитация человека). Списки участников некоторых
          сообществ скрыты.
        </div>
      </div>

      <div className="p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-zinc-600 dark:text-zinc-300">
          <div className="font-medium text-zinc-800 dark:text-zinc-100">
            Заявки в друзья
            {quotaFor('friend_request') && (
              <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                сегодня{' '}
                {quotaFor('friend_request')!.used} / {quotaFor('friend_request')!.limit}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            По одной, с паузами 2–6 минут. Новых контактов: {stats.fresh}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Сколько
            </label>
            <input
              type="number"
              min={1}
              max={15}
              value={friendLimit}
              onChange={(e) => setFriendLimit(Number(e.target.value))}
              className="w-20 px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg"
            />
          </div>
          <button
            onClick={() => setConfirmFriends(true)}
            disabled={
              isSending ||
              stats.fresh === 0 ||
              !effectiveAccountId ||
              (quotaFor('friend_request')?.limit ?? 1) - (quotaFor('friend_request')?.used ?? 0) <= 0
            }
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Отправляю...
              </>
            ) : (
              <>
                <UserPlus className="w-4 h-4" />
                Отправить заявки
              </>
            )}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmFriends}
        title="Отправить заявки в друзья?"
        description={`Будет отправлено до ${friendLimit} заявок с паузами 2–6 минут между ними — батч займёт столько же. Не закрывайте окно браузера и не пользуйтесь им в это время. Массовые заявки могут привести к ограничению аккаунта VK.`}
        isPending={isSending}
        onConfirm={handleSendFriends}
        onCancel={() => setConfirmFriends(false)}
      />

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 flex items-center justify-center text-sm text-zinc-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Загрузка...
          </div>
        ) : (contacts ?? []).length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Контактов пока нет. Укажите сообщество и нажмите «Распарсить».
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/60 text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Имя</th>
                <th className="text-left px-4 py-2.5 font-medium">Профиль</th>
                <th className="text-left px-4 py-2.5 font-medium">Источник</th>
                <th className="text-left px-4 py-2.5 font-medium">Статус</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(contacts ?? []).map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40"
                >
                  <td className="px-4 py-2.5 font-medium text-zinc-800 dark:text-zinc-200">
                    {c.name || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <a
                      href={`https://vk.com${c.profile_href}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {c.profile_href}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400">
                    {c.source || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`px-2 py-0.5 text-xs rounded-md border ${
                        STATUS_STYLE[c.status] || STATUS_STYLE.new
                      }`}
                    >
                      {STATUS_LABEL[c.status] || c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="Удалить контакт"
                      className="p-1.5 text-zinc-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-md transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
