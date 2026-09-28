import React from 'react';
import { 
  CheckCircle2, 
  Clock, 
  ListChecks, 
  Sparkles, 
  UserCheck, 
  ShieldCheck, 
  Building2, 
  Award, 
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
    if (totalTasks === 0) return { label: 'Awaiting Daily Roster', color: 'text-stone-500 bg-stone-100 dark:bg-slate-800' };
    if (isAllDone) return { label: 'Full Kashrut Compliance Verified', color: 'text-emerald-700 dark:text-emerald-300 bg-emerald-100/80 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-800' };
    if (completionRate >= 75) return { label: 'Advanced Inspection Phase', color: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800' };
    if (completionRate >= 35) return { label: 'Active Service Supervision', color: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800' };
    return { label: 'Morning Open & Setup Phase', color: 'text-amber-900 dark:text-amber-200 bg-amber-100/70 dark:bg-amber-950/60 border border-amber-300/80 dark:border-amber-800' };
  };

  const status = getReadinessStatus();

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 sm:p-5 border border-stone-200/90 dark:border-stone-800 shadow-sm mb-5 transition-all relative overflow-hidden">
      {/* Subtle warm background ambient glow */}
      <div className="absolute -top-24 -right-24 w-72 h-72 bg-gradient-to-br from-amber-500/10 via-amber-600/5 to-transparent rounded-full blur-3xl pointer-events-none" />

      {/* Top Administrative Masthead */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 mb-3.5 border-b border-stone-100 dark:border-stone-800/80 relative">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-600 via-amber-700 to-stone-800 text-white flex items-center justify-center shadow-md shadow-amber-700/20 shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded-md border border-amber-200/60 dark:border-amber-800/50">
                Institutional Kashrus Oversight
              </span>
              {venueName && (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-stone-700 dark:text-stone-200">
                  <Building2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>{venueName}</span>
                  {venueCategory && (
                    <span className="text-stone-400 font-normal">({venueCategory})</span>
                  )}
                </span>
              )}
              {venueCertification && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-md border border-emerald-200/60 dark:border-emerald-800/50">
                  <ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  <span>{venueCertification}</span>
                </span>
              )}
              {isRealtimeConnected !== undefined && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-stone-500 dark:text-stone-400">
                  <span className={`w-1.5 h-1.5 rounded-full ${isRealtimeConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  <span>{isRealtimeConnected ? 'Live' : 'Offline'}</span>
                </span>
              )}
            </div>
            <h2 className="text-base font-black text-stone-900 dark:text-white tracking-tight leading-tight mt-0.5">
              Daily Kashrut Operational Roster
            </h2>
          </div>
        </div>

        {/* Live Status Badge */}
        <div className="flex items-center gap-2 self-start sm:self-center">
          <span className={`px-3 py-1 rounded-xl text-xs font-bold tracking-tight inline-flex items-center gap-1.5 shadow-2xs ${status.color}`}>
            <Activity className="w-3.5 h-3.5 animate-pulse" />
            <span>{status.label}</span>
          </span>
          {isAllDone && (
            <button
              onClick={triggerCelebration}
              className="cursor-pointer inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-bold bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-xs hover:shadow-md transition active:scale-95"
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
            <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-gradient-to-br from-stone-50 to-stone-100 dark:from-slate-800 dark:to-slate-850 border border-stone-200 dark:border-stone-700/80 flex flex-col items-center justify-center p-2 shadow-inner">
              <span className="text-xl sm:text-2xl font-black text-stone-900 dark:text-white tabular-nums tracking-tight">
                {completionRate}%
              </span>
              <span className="text-[9px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                Verified
              </span>
            </div>
          </div>

          <div>
            <div className="text-xs text-stone-500 dark:text-stone-400 font-medium">
              Daily Shift Status
            </div>
            <div className="text-base sm:text-lg font-bold text-stone-800 dark:text-stone-100">
              <span className="tabular-nums font-black text-stone-900 dark:text-white">{completedTasks}</span>
              <span className="text-stone-400 mx-1 font-normal">of</span>
              <span className="tabular-nums">{totalTasks} assignments completed</span>
            </div>
            <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
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
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'all'
                ? 'bg-stone-900 dark:bg-white text-white dark:text-stone-900 shadow-xs'
                : 'bg-stone-100 dark:bg-slate-800 text-stone-600 dark:text-stone-300 hover:bg-stone-200/80 dark:hover:bg-slate-700'
            }`}
          >
            <ListChecks className="w-3.5 h-3.5" />
            <span>All Tasks ({totalTasks})</span>
          </button>

          <button
            id="filter-mine-btn"
            onClick={() => onSelectFilter('mine')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'mine'
                ? 'bg-gradient-to-r from-amber-600 to-amber-700 text-white shadow-xs'
                : 'bg-stone-100 dark:bg-slate-800 text-stone-600 dark:text-stone-300 hover:bg-stone-200/80 dark:hover:bg-slate-700'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>Assigned to Me ({myCompleted}/{myTotal})</span>
          </button>

          <button
            id="filter-pending-btn"
            onClick={() => onSelectFilter('pending')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeFilter === 'pending'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'bg-stone-100 dark:bg-slate-800 text-stone-600 dark:text-stone-300 hover:bg-stone-200/80 dark:hover:bg-slate-700'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Pending ({remainingTasks})</span>
          </button>
        </div>
      </div>

      {/* Visual Progress Bar with Glow */}
      <div className="w-full bg-stone-100 dark:bg-slate-800 rounded-full h-3 overflow-hidden p-0.5 border border-stone-200/60 dark:border-stone-800">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out shadow-xs ${
            completionRate === 100
              ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400'
              : completionRate > 50
              ? 'bg-gradient-to-r from-amber-600 via-amber-500 to-emerald-500'
              : 'bg-gradient-to-r from-stone-400 via-amber-600 to-amber-500'
          }`}
          style={{ width: `${Math.max(completionRate, 3)}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-stone-400 dark:text-stone-500 mt-2.5 font-medium">
        <span>Automatic daily cycle resets at midnight (00:00)</span>
        <span className="font-semibold text-stone-600 dark:text-stone-400">
          {agencyName}
        </span>
      </div>
    </div>
  );
};

