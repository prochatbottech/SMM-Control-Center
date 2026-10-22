import React, { useState } from 'react';
import { Plus, RefreshCw, Send, Sparkles, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { usePostsQuery } from '../hooks/usePosts';
import { PostList } from './PostList';
import { CreatePostModal } from './CreatePostModal';
import { AutostartToggle } from './AutostartToggle';

export const PostsView: React.FC = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const { data: posts, isLoading, isError, error, refetch, isFetching } = usePostsQuery();

  const totalCount = posts?.length ?? 0;
  const scheduledCount = posts?.filter((p) => p.status === 'scheduled').length ?? 0;
  const publishedCount = posts?.filter((p) => p.status === 'published').length ?? 0;
  const partiallyPublishedCount = posts?.filter((p) => p.status === 'partially_published').length ?? 0;

  return (
    <div className="space-y-8">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Sparkles className="w-3 h-3" />
              SMM Scheduler
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              <Clock className="w-3 h-3" />
              Tokio Worker (Scheduler 30s / Automation 15s)
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Публикации и Планировщик
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
            Создание постов, управление черновиками и автоматическая отправка по расписанию
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Обновить список публикаций"
            className="p-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded-xl transition-colors shadow-2xs disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-blue-500' : ''}`} />
          </button>

          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-xl transition-colors shadow-xs"
          >
            <Plus className="w-4 h-4" />
            Создать публикацию
          </button>
        </div>
      </div>

      {/* System Daemon & Autostart Control */}
      <AutostartToggle />

      {/* Metrics Banner */}
      {posts && posts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex items-center gap-3 p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xs">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs text-zinc-400 font-medium">Всего публикаций</div>
              <div className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{totalCount}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xs">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs text-zinc-400 font-medium">Запланировано</div>
              <div className="text-xl font-bold text-blue-600 dark:text-blue-400">{scheduledCount}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xs">
            <div className="p-2.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs text-zinc-400 font-medium">Опубликовано</div>
              <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{publishedCount}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xs">
            <div className="p-2.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs text-zinc-400 font-medium">Частично</div>
              <div className="text-xl font-bold text-amber-600 dark:text-amber-400">{partiallyPublishedCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Posts List Component */}
      <PostList
        posts={posts}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onCreateNew={() => setIsCreateModalOpen(true)}
      />

      {/* Create Post Modal */}
      <CreatePostModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </div>
  );
};
