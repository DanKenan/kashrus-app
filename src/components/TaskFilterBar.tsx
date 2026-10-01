import React from 'react';
import { motion } from 'motion/react';
import { Search, LayoutGrid, Table as TableIcon, X, Plus, Layers } from 'lucide-react';
import { categoryVars } from '../lib/categoryStyle';

interface TaskFilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  categories: string[];
  categoryCounts?: Record<string, number>;
  viewMode: 'table' | 'cards';
  onViewModeChange: (mode: 'table' | 'cards') => void;
  showOnlyTodaySchedule: boolean;
  onToggleScheduleFilter: () => void;
  onOpenTaskModal: () => void;
  isAdmin: boolean;
}

export const TaskFilterBar: React.FC<TaskFilterBarProps> = ({
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  categories,
  categoryCounts,
  viewMode,
  onViewModeChange,
  showOnlyTodaySchedule,
  onToggleScheduleFilter,
  onOpenTaskModal,
  isAdmin,
}) => {
  const counts: Record<string, number> = categoryCounts ?? {};
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-3 mb-5">
      {/* Row 1: search + controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search Bar */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
          <input
            id="task-search-input"
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search inspections, mashgiach name, notes..."
            className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm rounded-2xl bg-surface border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition tactile-1"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filters, View Switcher & New Assignment Button */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 flex-wrap sm:flex-nowrap">
          {/* Today's Schedule Only Toggle */}
          <button
            id="today-schedule-toggle"
            onClick={onToggleScheduleFilter}
            className={`pressable shrink-0 px-3.5 py-2.5 text-xs font-bold rounded-2xl border transition cursor-pointer tactile-1 ${
              showOnlyTodaySchedule
                ? 'bg-gold-wash text-gold-ink border-gold/50'
                : 'bg-surface text-ink-soft border-line hover:border-line-strong'
            }`}
            title="Filter tasks scheduled for today's active shift"
          >
            {showOnlyTodaySchedule ? '✓ Active Today' : 'All Shift Days'}
          </button>

          {/* View Switcher: Table vs Cards */}
          <div className="flex items-center bg-sunken p-1 rounded-2xl border border-line shrink-0">
            <button
              id="view-cards-btn"
              onClick={() => onViewModeChange('cards')}
              className={`pressable p-1.5 rounded-xl transition cursor-pointer ${
                viewMode === 'cards'
                  ? 'bg-surface text-gold-deep tactile-1 font-bold'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
              title="Card Dossier View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              id="view-table-btn"
              onClick={() => onViewModeChange('table')}
              className={`pressable p-1.5 rounded-xl transition cursor-pointer ${
                viewMode === 'table'
                  ? 'bg-surface text-gold-deep tactile-1 font-bold'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
              title="Grid Audit Table View"
            >
              <TableIcon className="w-4 h-4" />
            </button>
          </div>

          {/* PROMINENT "+ New Assignment" BUTTON (Admin Only) */}
          {isAdmin && (
            <button
              id="filter-bar-add-task-btn"
              onClick={onOpenTaskModal}
              className="pressable shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-black rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 hover:brightness-105 transition cursor-pointer"
              title="Register a new daily task assignment"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>New Assignment</span>
            </button>
          )}
        </div>
      </div>

      {/* Row 2: one-tap category pills — each category carries its own color,
          so the opening-shift and closing-shift mashgichim can jump straight
          to their list without wrestling through everything. */}
      {categories.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="Filter by category">
          <motion.button
            whileTap={{ scale: 0.94 }}
            onClick={() => onCategoryChange('all')}
            className={`shrink-0 inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full text-xs font-bold border transition cursor-pointer ${
              selectedCategory === 'all'
                ? 'bg-ink text-paper border-ink tactile-1'
                : 'bg-surface text-ink-soft border-line hover:border-line-strong tactile-1'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>All</span>
            {categoryCounts && (
              <span className={`tnum text-[10px] font-black px-1.5 py-0.5 rounded-full ${selectedCategory === 'all' ? 'bg-white/20' : 'bg-sunken'}`}>
                {totalCount}
              </span>
            )}
          </motion.button>

          {categories.map((c) => {
            const active = selectedCategory === c;
            const count = categoryCounts?.[c];
            return (
              <motion.button
                key={c}
                whileTap={{ scale: 0.94 }}
                onClick={() => onCategoryChange(active ? 'all' : c)}
                style={categoryVars(c)}
                className={`shrink-0 inline-flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-bold border transition cursor-pointer ${
                  active ? 'cat-chip cat-ring cat-text ring-2 tactile-2' : 'bg-surface text-ink-soft border-line hover:border-line-strong tactile-1'
                }`}
                title={active ? `Show all categories` : `Show only ${c}`}
              >
                <span className="cat-dot w-2.5 h-2.5 rounded-full shrink-0" />
                <span className="max-w-[140px] truncate">{c}</span>
                {typeof count === 'number' && (
                  <span className={`tnum text-[10px] font-black px-1.5 py-0.5 rounded-full ${active ? 'bg-black/10 dark:bg-white/15' : 'bg-sunken'}`}>
                    {count}
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      )}
    </div>
  );
};
