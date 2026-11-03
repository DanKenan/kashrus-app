import React from 'react';
import { filterChipClass, FilterCheck } from '../lib/filterChip';
import {
  Building2,
  CheckCircle2,
  AlertCircle,
  History,
  Eye,
  ShieldCheck,
} from 'lucide-react';

interface OwnerAuditBannerProps {
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  activeFilter: string;
  onSelectFilter: (filter: string) => void;
  onOpenHistoryModal: () => void;
  ownerName: string;
  /** Manager role (Don 2026-10-27): a manager sees the owner's banner with their own title. */
  isManager?: boolean;
}

export const OwnerAuditBanner: React.FC<OwnerAuditBannerProps> = ({
  totalTasks,
  completedTasks,
  completionRate,
  activeFilter,
  onSelectFilter,
  onOpenHistoryModal,
  ownerName,
  isManager = false,
}) => {
  const pendingTasks = totalTasks - completedTasks;

  return (
    <div className="mb-6 rounded-3xl bg-gradient-to-br from-[#2b2013] via-[#231a0f] to-[#2b2013] text-[#f5efe4] p-5 sm:p-6 border border-[#4a3a24] tactile-4 animate-fade-in">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-[#4a3a24]/70">
        <div className="flex items-start sm:items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gold/15 border border-gold/30 text-gold shrink-0">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-[#f5efe4]">
                {isManager ? 'Restaurant & Venue Manager Audit Portal' : 'Restaurant & Venue Owner Audit Portal'}
              </h2>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-gold/15 text-gold border border-gold/30">
                <Eye className="w-3 h-3" /> View only
              </span>
            </div>
            <p className="text-xs text-[#cbbfa8] mt-0.5">
              Welcome, <strong className="text-[#f5efe4]">{ownerName}</strong>. Live monitoring of shift duties, Mashgiach execution times, and incomplete tasks.
            </p>
          </div>
        </div>

        {/* Historical Log Quick Trigger */}
        <button
          id="owner-history-shortcut-btn"
          onClick={onOpenHistoryModal}
          className="pressable inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-[#4a3a24] text-xs font-semibold text-[#e8dfc9] transition self-start lg:self-center"
        >
          <History className="w-4 h-4 text-gold" />
          <span>Full Shift History & Archives</span>
        </button>
      </div>

      {/* 3 Interactive Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-5">
        {/* Card 1: Shift Compliance Score */}
        <button
          aria-pressed={activeFilter === 'all'}
          onClick={() => onSelectFilter('all')}
          className={`pressable text-left p-4 rounded-2xl border transition-all ${
            activeFilter === 'all' ? 'ring-2 ring-gold border-gold' : 'border-line-control'
          }`}
        >
          {activeFilter === 'all' && <span className={`inline-flex items-center gap-1 px-2 py-1 mb-2 rounded-full text-xs ${filterChipClass(true)}`}><FilterCheck on />Showing</span>}
          <div className="flex items-center justify-between text-xs text-[#a99a7d] mb-1 font-medium">
            <span>Overall Shift Progress</span>
            <span className="tnum font-bold text-[#f5efe4] text-xs">{totalTasks} Total Tasks</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-2xl font-black text-[#f5efe4]">{completionRate}%</span>
            <span className="tnum text-xs text-[#a99a7d] font-medium">
              ({completedTasks}/{totalTasks} complete)
            </span>
          </div>
          <div className="w-full bg-black/40 rounded-full h-1.5 mt-2 overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-500"
              style={{ width: `${completionRate}%` }}
            />
          </div>
          <p className="text-[11px] text-[#a99a7d] mt-2 font-medium">
            Click to view all scheduled tasks
          </p>
        </button>

        {/* Card 2: "Who Did What & When" */}
        <button
          id="owner-filter-completed-btn"
          aria-pressed={activeFilter === 'completed'}
          onClick={() => onSelectFilter('completed')}
          className={`pressable text-left p-4 rounded-2xl border transition-all ${
            activeFilter === 'completed' ? 'ring-2 ring-gold border-gold' : 'border-line-control'
          }`}
        >
          {activeFilter === 'completed' && <span className={`inline-flex items-center gap-1 px-2 py-1 mb-2 rounded-full text-xs ${filterChipClass(true)}`}><FilterCheck on />Showing</span>}
          <div className="flex items-center justify-between text-xs text-emerald-400 mb-1 font-medium">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Who Did What & When
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">
              Verified
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-2xl font-black text-emerald-400">{completedTasks}</span>
            <span className="text-xs text-[#a99a7d] font-medium">tasks verified</span>
          </div>
          <p className="text-[11px] text-[#cbbfa8] mt-2 line-clamp-1">
            {activeFilter === 'completed' ? '✓ Showing completed tasks only' : 'Inspect mashgiach names & timestamps'}
          </p>
        </button>

        {/* Card 3: "What Wasn't Done" */}
        <button
          id="owner-filter-pending-btn"
          aria-pressed={activeFilter === 'pending'}
          onClick={() => onSelectFilter('pending')}
          className={`pressable text-left p-4 rounded-2xl border transition-all ${
            activeFilter === 'pending' ? 'ring-2 ring-gold border-gold' : 'border-line-control'
          }`}
        >
          {activeFilter === 'pending' && <span className={`inline-flex items-center gap-1 px-2 py-1 mb-2 rounded-full text-xs ${filterChipClass(true)}`}><FilterCheck on />Showing</span>}
          <div className="flex items-center justify-between text-xs text-gold mb-1 font-medium">
            <span className="flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-gold" />
              What Wasn't Done
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gold/20 text-gold">
              Needs Attention
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-2xl font-black text-gold">{pendingTasks}</span>
            <span className="text-xs text-[#a99a7d] font-medium">pending items</span>
          </div>
          <p className="text-[11px] text-[#cbbfa8] mt-2 line-clamp-1">
            {activeFilter === 'pending' ? '⚠ Showing incomplete tasks only' : 'Inspect unexecuted tasks & deadlines'}
          </p>
        </button>
      </div>
    </div>
  );
};
