import React, { useState } from 'react';
import {
  Calendar,
  Clock,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  FileText,
  Loader2,
  Send,
  Share2,
  Users,
  Globe,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { Post, PostStatus } from '../api/db';
import { useAccountsQuery } from '../hooks/useAccounts';
import { useDeletePostMutation, useRetryPostMutation } from '../hooks/usePosts';
import { MediaPreviewList } from './MediaPreviewList';
import { ConfirmDialog } from './ConfirmDialog';
import { toast } from 'sonner';

interface PostCardProps {
  post: Post;
}

export const PostCard: React.FC<PostCardProps> = ({ post }) => {
  const { data: accounts } = useAccountsQuery();
  const deleteMutation = useDeletePostMutation();
  const retryMutation = useRetryPostMutation();
  const [activeErrorId, setActiveErrorId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canRetry = post.status === 'failed' || post.status === 'partially_published';

  const handleRetry = () => {
    retryMutation.mutate(post.id, {
      onSuccess: () => {
        toast.success('Пост отправлен на повторную публикацию!');
      },
      onError: (err: any) => {
        const msg = typeof err === 'string' ? err : err?.message || String(err);
        toast.error(`Ошибка при повторной отправке: ${msg}`);
      },
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate(post.id, {
      onSuccess: () => {
        toast.success('Пост успешно удален');
        setConfirmDelete(false);
      },
      onError: (err: any) => {
        const msg = typeof err === 'string' ? err : err?.message || String(err);
        toast.error(`Ошибка при удалении: ${msg}`);
      },
    });
  };

  // Helper for status badge
  const getStatusBadge = (status: PostStatus | string) => {
    switch (status) {
      case 'published':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Опубликован
          </span>
        );
      case 'partially_published':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <AlertCircle className="w-3.5 h-3.5" />
            Частично опубликован
          </span>
        );
      case 'publishing':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Отправляется...
          </span>
        );
      case 'scheduled':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Clock className="w-3.5 h-3.5" />
            Запланирован
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
            <AlertTriangle className="w-3.5 h-3.5" />
            Ошибка
          </span>
        );
      case 'draft':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border border-zinc-500/20">
            <FileText className="w-3.5 h-3.5" />
            Черновик
          </span>
        );
    }
  };

  // Resolve target account objects
  const targetAccounts = (post.destination_account_ids || [])
    .map((accId) => accounts?.find((a) => a.id === accId))
    .filter(Boolean);

  const getPlatformIcon = (platform: string) => {
    switch (platform.toLowerCase()) {
      case 'vk':
        return <Share2 className="w-3 h-3 text-blue-500" />;
      case 'tg':
      case 'telegram':
        return <Send className="w-3 h-3 text-sky-500" />;
      case 'ok':
        return <Users className="w-3 h-3 text-amber-500" />;
      default:
        return <Globe className="w-3 h-3 text-slate-500" />;
    }
  };

  const formattedScheduledTime = post.scheduled_for
    ? new Date(post.scheduled_for * 1000).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const formattedCreatedTime = new Date(post.created_at * 1000).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col justify-between p-5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xs hover:shadow-md transition-shadow relative">
      <div>
        {/* Top: Status & Actions */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            {getStatusBadge(post.status)}
            {post.format === 'article' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                Статья
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {canRetry && (
              <button
                onClick={handleRetry}
                disabled={retryMutation.isPending}
                title="Повторить отправку"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/40 border border-blue-200 dark:border-blue-800 rounded-lg transition-colors disabled:opacity-50"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
                <span>Повторить</span>
              </button>
            )}

            <button
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMutation.isPending}
              title="Удалить пост"
              className="p-1.5 text-zinc-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors disabled:opacity-50"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Content Excerpt */}
        <div className="mb-3">
          {post.content ? (
            <p className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap line-clamp-4 font-sans leading-relaxed">
              {post.content}
            </p>
          ) : (
            <p className="text-sm italic text-zinc-400">
              (Пустой черновик без текста)
            </p>
          )}
        </div>

        {/* Attached Media Thumbnails (Read-only) */}
        {post.media_urls && post.media_urls.length > 0 && (
          <div className="mb-3.5">
            <MediaPreviewList mediaUrls={post.media_urls} readOnly={true} />
          </div>
        )}

        {/* Target Accounts Badges with individual destination statuses & error logs */}
        {targetAccounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {targetAccounts.map((acc) => {
              const destInfo = post.destinations?.find((d) => d.account_id === acc!.id);
              const destStatus = destInfo?.status ?? 'pending';
              const errorLog = destInfo?.error_log;

              if (destStatus === 'published') {
                return (
                  <span
                    key={acc!.id}
                    title="Успешно опубликовано"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                  >
                    {getPlatformIcon(acc!.platform)}
                    <span className="truncate max-w-[110px] font-medium">{acc!.name}</span>
                    <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                  </span>
                );
              }

              if (destStatus === 'failed') {
                const isErrorOpen = activeErrorId === acc!.id;
                return (
                  <div key={acc!.id} className="relative group">
                    <button
                      type="button"
                      onClick={() => setActiveErrorId(isErrorOpen ? null : acc!.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 transition-colors cursor-pointer"
                    >
                      {getPlatformIcon(acc!.platform)}
                      <span className="truncate max-w-[110px] font-medium">{acc!.name}</span>
                      <XCircle className="w-3 h-3 text-rose-500 shrink-0" />
                    </button>

                    {/* Tooltip on hover or click */}
                    <div
                      className={`absolute left-0 bottom-full mb-2 z-30 w-72 p-3 bg-zinc-950 text-white rounded-xl shadow-xl border border-zinc-800 ${
                        isErrorOpen ? 'block' : 'hidden group-hover:block'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-400 mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Ошибка отправки ({acc!.name}):
                      </div>
                      <p className="text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-words max-h-36 overflow-y-auto leading-relaxed">
                        {errorLog || 'Причина ошибки не указана'}
                      </p>
                    </div>
                  </div>
                );
              }

              // Pending / default
              return (
                <span
                  key={acc!.id}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700"
                >
                  {getPlatformIcon(acc!.platform)}
                  <span className="truncate max-w-[110px]">{acc!.name}</span>
                  <Clock className="w-3 h-3 text-zinc-400 shrink-0" />
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer Info: Schedule or Created Time */}
      <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-400">
        <div className="flex items-center gap-1.5">
          {post.scheduled_for ? (
            <>
              <Clock className="w-3.5 h-3.5 text-blue-500" />
              <span className="font-medium text-zinc-600 dark:text-zinc-300">
                {formattedScheduledTime}
              </span>
            </>
          ) : (
            <>
              <Calendar className="w-3.5 h-3.5" />
              <span>Создан {formattedCreatedTime}</span>
            </>
          )}
        </div>

        <span className="font-mono text-[11px] text-zinc-400 uppercase">
          ID: {post.id.slice(0, 8)}
        </span>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить пост?"
        description="Пост будет удален безвозвратно вместе с историей отправки."
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
};
