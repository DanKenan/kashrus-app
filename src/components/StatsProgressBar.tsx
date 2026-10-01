import React from 'react';
import {
  Clock,
  ListChecks,
  Sparkles,
  UserCheck,
  ShieldCheck,
  Building2,
  Activity
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface StatsProgressBarProps {
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  myTotal: number;
  myCompleted: number;
  activeFilter: string;
  onSelectFilter: (filter: string) => void;
  agencyName?: string;
  venueName?: string;
  venueCategory?: string;
  venueCertification?: string;
  isRealtimeConnected?: boolean;
  activeWorkersCount?: number;
}

export const StatsProgressBar: React.FC<StatsProgressBarProps> = ({
  totalTasks,
  completedTasks,
  completionRate,
  myTotal,
  myCompleted,
  activeFilter,
  onSelectFilter,
  agencyName = 'Hartford Kashrut Commission',
  venueName,
  venueCategory,
  venueCertification,
  isRealtimeConnected,
  activeWorkersCount,
}) => {
  const isAllDone = totalTasks > 0 && completedTasks === totalTasks;
  const remainingTasks = Math.max(0, totalTasks - completedTasks);

  const triggerCelebration = () => {
    confetti({
      particleCount: 90,
      spread: 75,
      origin: { y: 0.6 },
      colors: ['#d97706', '#059669', '#2563eb', '#f59e0b'],
    });
  };

  const getReadinessStatus = () => {
    if (totalTasks === 0) return { label: 'Awaiting Daily Roster', color: 'text-ink-soft bg-sunken border border-line' };
    if (isAllDone) return { label: 'Full Kashrut Compliance Verified', color: 'text-emerald-800 dark:text-emerald-300 bg-emerald-100/80 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-800' };
    if (completionRate >= 75) return { label: 'Advanced Inspection Phase', color: 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800' };
    if (completionRate >= 35) return { label: 'Active Service Supervision', color: 'text-gold-ink bg-gold-wash border border-gold/40' };
    return { label: 'Morning Open & Setup Phase', color: 'text-gold-ink bg-gold-wash border border-gold/50' };
  };

  const status = getReadinessStatus();

  return (
    <div className="bg-surface rounded-3xl p-4 sm:p-5 border border-line tactile-3 mb-5 transition-all relative overflow-hidden animate-fade-in">
      {/* Subtle warm ambient glow */}
      <div className="absolute -top-24 -right-24 w-72 h-72 bg-gradient-to-br from-gold/10 via-gold/5 to-transparent rounded-full blur-3xl pointer-events-none" />

      {/* Top Administrative Masthead */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-3.5 border-b border-line/70 relative">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2 shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gold-deep bg-gold-wash px-2 py-0.5 rounded-md border border-gold/40">
                Institutional Kashrus Oversight
              </span>
              {venueName && (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-ink-soft">
                  <Building2 className="w-3.5 h-3.5 text-gold-deep" />
                  <span>{venueName}</span>
                  {venueCategory && (
                    <span className="text-ink-faint font-normal">({venueCategory})</span>
                  )}
                </span>
              )}
              {venueCertification && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-md border border-emerald-200/60 dark:border-emerald-800/50">
                  <ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  <span>{venueCertification}</span>
                </span>
              )}
              {isRealtimeConnected !== undefined && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-ink-faint">
                  <span className={`w-1.5 h-1.5 rounded-full ${isRealtimeConnected ? 'bg-emerald-500' : 'bg-gold'}`} />
                  <span>{isRealtimeConnected ? 'Live' : 'Offline'}</span>
                </span>
              )}
            </div>
            <h2 className="text-base font-black text-ink tracking-tight leading-tight mt-0.5">
              Daily Kashrut Operational Roster
            </h2>
          </div>
        </div>

        {/* Live Status Badge */}
        <div className="flex items-center gap-2 self-start sm:self-center">
          <span className={`px-3 py-1 rounded-xl text-xs font-bold tracking-tight inline-flex items-center gap-1.5 tactile-1 ${status.color}`}>
            <Activity className="w-3.5 h-3.5 animate-pulse" />
            <span>{status.label}</span>
          </span>
          {isAllDone && (
            <button
              onClick={triggerCelebration}
              className="pressable cursor-pointer inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-bold bg-gradient-to-b from-emerald-600 to-emerald-700 text-white tactile-2 transition"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Celebrate</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Readiness & Stats Section */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 mb-5">

        {/* Left: Completion Numbers */}
        <div className="flex items-center gap-4">
          <div className="relative flex items-center justify-center">
            {/* Circular Gauge Ring */}
            <div className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-2xl bg-sunken border border-line flex flex-col items-center justify-center p-2 tactile-1">
              <span className="tnum text-xl sm:text-2xl font-black text-ink tracking-tight">
                {completionRate}%
              </span>
              <span className="text-[9px] font-bold uppercase tracking-wider text-ink-faint">
                Verified
              </span>
            </div>
          </div>

          <div>
            <div className="text-xs text-ink-faint font-medium">
              Daily Shift Status
            </div>
            <div className="text-base sm:text-lg font-bold text-ink-soft">
              <span className="tnum font-black text-ink">{completedTasks}</span>
              <span className="text-ink-faint mx-1 font-normal">of</span>
              <span className="tnum">{totalTasks} assignments completed</span>
            </div>
            <div className="text-[11px] text-ink-faint mt-0.5">
              {remainingTasks === 0 ? (
                <span className="text-emerald-700 dark:text-emerald-400 font-semibold">All scheduled inspections verified for today.</span>
              ) : (
                <span>{remainingTasks} pending inspection {remainingTasks === 1 ? 'task' : 'tasks'} awaiting mashgiach signature</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Quick Filter Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            id="filter-all-btn"
            onClick={() => onSelectFilter('all')}
            className={`pressable inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'all'
                ? 'bg-ink text-paper tactile-2'
                : 'bg-sunken text-ink-soft border border-line hover:border-line-strong'
            }`}
          >
            <ListChecks className="w-3.5 h-3.5" />
            <span className="tnum">All Tasks ({totalTasks})</span>
          </button>

          <button
            id="filter-mine-btn"
            onClick={() => onSelectFilter('mine')}
            className={`pressable inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'mine'
                ? 'bg-gradient-to-b from-gold to-gold-deep text-white tactile-2'
                : 'bg-gold-wash text-gold-ink border border-gold/40 hover:border-gold'
            }`}
            title="Show tasks designated for you"
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span className="tnum">Assigned to Me ({myCompleted}/{myTotal})</span>
          </button>

          <button
            id="filter-pending-btn"
            onClick={() => onSelectFilter('pending')}
            className={`pressable inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'pending'
                ? 'bg-ink text-paper tactile-2'
                : 'bg-sunken text-ink-soft border border-line hover:border-line-strong'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="tnum">Pending ({remainingTasks})</span>
          </button>
        </div>
      </div>

      {/* Visual Progress Bar with Glow */}
      <div className="w-full bg-sunken rounded-full h-3 overflow-hidden p-0.5 border border-line/70">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            completionRate === 100
              ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400'
              : completionRate > 50
              ? 'bg-gradient-to-r from-gold-deep via-gold to-emerald-500'
              : 'bg-gradient-to-r from-ink-faint via-gold-deep to-gold'
          }`}
          style={{ width: `${Math.max(completionRate, 3)}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-faint mt-2.5 font-medium">
        <span>Automatic daily cycle resets at midnight (00:00)</span>
        <span className="font-semibold text-ink-soft">
          {agencyName}
        </span>
      </div>
    </div>
  );
};
