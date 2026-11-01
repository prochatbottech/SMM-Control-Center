import React, { useState } from 'react';
import { Plus, RefreshCw, Shield, Sparkles } from 'lucide-react';
import { useAccountsQuery } from '../hooks/useAccounts';
import { AccountList } from './AccountList';
import { AddAccountModal } from './AddAccountModal';
import { BrowserRuntimeBanner } from './BrowserRuntimeBanner';

export const AccountsView: React.FC = () => {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const { data: accounts, isLoading, isError, error, refetch, isFetching } = useAccountsQuery();

  const accountsCount = accounts?.length ?? 0;

  return (
    <div className="space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Sparkles className="w-3 h-3" />
              SMM Control Center
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <Shield className="w-3 h-3" />
              OS Keyring Protected
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Подключенные аккаунты
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
            Управление профилями, сообществами и каналами для кросспостинга
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Обновить список"
            className="p-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded-xl transition-colors shadow-2xs disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-blue-500' : ''}`} />
          </button>

          <button
            onClick={() => setIsAddModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-xl transition-colors shadow-xs"
          >
            <Plus className="w-4 h-4" />
            Подключить аккаунт
          </button>
        </div>
      </div>

      {/* Stats banner if accounts exist */}
      {accounts && accounts.length > 0 && (
        <div className="flex items-center justify-between px-5 py-3.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Всего аккаунтов: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{accountsCount}</span>
          </div>
          <div className="text-xs text-zinc-400">
            Токены хранятся в зашифрованном виде в SQLite + Windows Keyring
          </div>
        </div>
      )}

      {/* Browser automation runtime readiness */}
      <BrowserRuntimeBanner />

      {/* Account List Grid / Empty State */}
      <AccountList
        accounts={accounts}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onAddNew={() => setIsAddModalOpen(true)}
      />

      {/* Add Account Modal */}
      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
      />
    </div>
  );
};
