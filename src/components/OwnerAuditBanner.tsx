import React from 'react';
import { 
  Building2, 
  CheckCircle2, 
  AlertCircle, 
  History, 
  Eye, 
  Clock, 
  ShieldCheck,
  UserCheck
} from 'lucide-react';

interface OwnerAuditBannerProps {
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  activeFilter: string;
  onSelectFilter: (filter: string) => void;
  onOpenHistoryModal: () => void;
  ownerName: string;
}

export const OwnerAuditBanner: React.FC<OwnerAuditBannerProps> = ({
  totalTasks,
  completedTasks,
  completionRate,
  activeFilter,
  onSelectFilter,
  onOpenHistoryModal,
  ownerName,
}) => {
  const pendingTasks = totalTasks - completedTasks;

  return (
    <div className="mb-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 text-white p-5 sm:p-6 border border-slate-700/60 shadow-lg">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-700/60">
        <div className="flex items-start sm:items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-400 shrink-0">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-white">
                Restaurant & Venue Owner Audit Portal
              </h2>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-400/20 text-amber-300 border border-amber-400/30">
                <Eye className="w-3 h-3" /> Read-Only Inspector
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-0.5">
              Welcome, <strong className="text-white">{ownerName}</strong>. Live monitoring of shift duties, Mashgiach execution times, and incomplete tasks.
            </p>
          </div>
        </div>

        {/* Historical Log Quick Trigger */}
        <button
          id="owner-history-shortcut-btn"
          onClick={onOpenHistoryModal}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 border border-slate-600 text-xs font-semibold text-slate-200 hover:text-white transition shadow-sm self-start lg:self-center"
        >
          <History className="w-4 h-4 text-blue-400" />
          <span>Full Shift History & Archives</span>
        </button>
      </div>

      {/* 3 Interactive Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-5">
        {/* Card 1: Shift Compliance Score */}
        <button
          onClick={() => onSelectFilter('all')}
          className={`text-left p-4 rounded-xl border transition-all ${
            activeFilter === 'all'
              ? 'bg-slate-800/90 border-slate-500 shadow-md ring-1 ring-slate-400/30'
              : 'bg-slate-850/60 hover:bg-slate-800/60 border-slate-700/50'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-medium">
            <span>Overall Shift Progress</span>
            <span className="font-bold text-white text-xs">{totalTasks} Total Tasks</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{completionRate}%</span>
            <span className="text-xs text-slate-400 font-medium">
              ({completedTasks}/{totalTasks} complete)
            </span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-1.5 mt-2 overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-500"
              style={{ width: `${completionRate}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-400 mt-2 font-medium">
            Click to view all scheduled tasks
          </p>
        </button>

        {/* Card 2: "Who Did What & When" */}
        <button
          id="owner-filter-completed-btn"
          onClick={() => onSelectFilter('completed')}
          className={`text-left p-4 rounded-xl border transition-all ${
            activeFilter === 'completed'
              ? 'bg-emerald-950/40 border-emerald-500 shadow-md ring-1 ring-emerald-400/30'
              : 'bg-slate-850/60 hover:bg-slate-800/60 border-slate-700/50'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-emerald-400 mb-1 font-medium">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Who Did What & When
            </span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
              Verified
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-400">{completedTasks}</span>
            <span className="text-xs text-slate-400 font-medium">tasks verified</span>
          </div>
          <p className="text-[11px] text-slate-300 mt-2 line-clamp-1">
            {activeFilter === 'completed' ? '✓ Showing completed tasks only' : 'Inspect mashgiach names & timestamps'}
          </p>
        </button>

        {/* Card 3: "What Wasn't Done" */}
        <button
          id="owner-filter-pending-btn"
          onClick={() => onSelectFilter('pending')}
          className={`text-left p-4 rounded-xl border transition-all ${
            activeFilter === 'pending'
              ? 'bg-amber-950/40 border-amber-500 shadow-md ring-1 ring-amber-400/30'
              : 'bg-slate-850/60 hover:bg-slate-800/60 border-slate-700/50'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-amber-400 mb-1 font-medium">
            <span className="flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-amber-400" />
              What Wasn't Done
            </span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">
              Needs Attention
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-amber-400">{pendingTasks}</span>
            <span className="text-xs text-slate-400 font-medium">pending items</span>
          </div>
          <p className="text-[11px] text-slate-300 mt-2 line-clamp-1">
            {activeFilter === 'pending' ? '⚠ Showing incomplete tasks only' : 'Inspect unexecuted tasks & deadlines'}
          </p>
        </button>
      </div>
    </div>
  );
};
