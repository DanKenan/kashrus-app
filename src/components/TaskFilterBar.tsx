import React from 'react';
import { filterChipClass, FilterCheck } from '../lib/filterChip';
import { motion } from 'motion/react';
import { Search, LayoutGrid, Table as TableIcon, X, Plus, Layers } from 'lucide-react';
import { categoryVars } from '../lib/categoryStyle';

interface TaskFilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** Picked category chips (AND); empty = All. */
  selectedCategories: string[];
  /** 'all' clears every pick; a category toggles on/off. */
  onCategoryChange: (cat: string) => void;
  categories: string[];
  categoryCounts?: Record<string, number>;
  viewMode: 'table' | 'cards';
  onViewModeChange: (mode: 'table' | 'cards') => void;
  dayView: 'today' | 'all';
  onDayViewChange: (view: 'today' | 'all') => void;
  onOpenTaskModal: () => void;
  isAdmin: boolean;
}

export const TaskFilterBar: React.FC<TaskFilterBarProps> = ({
  searchQuery,
  onSearchChange,
  selectedCategories,
  onCategoryChange,
  categories,
  categoryCounts,
  viewMode,
  onViewModeChange,
  dayView,
  onDayViewChange,
  onOpenTaskModal,
  isAdmin,
}) => {
  const counts: Record<string, number> = categoryCounts ?? {};
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const allActive = selectedCategories.length === 0;

  return (
    <div className="max-sm:-order-1 flex flex-col gap-3 mb-5">
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
            className="max-sm:min-h-11 max-sm:text-base w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm rounded-2xl bg-surface border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition tactile-1"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="max-sm:min-h-11 max-sm:min-w-11 max-sm:right-0 max-sm:flex max-sm:items-center max-sm:justify-center absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filters, View Switcher & New Assignment Button */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 flex-wrap sm:flex-nowrap">
          {isAdmin && (
            <div className="flex items-center gap-2" role="group" aria-label="Task days">
              {(['today', 'all'] as const).map((view) => (
                <button
                  key={view}
                  id={view === 'today' ? 'day-view-today' : 'day-view-all'}
                  onClick={() => onDayViewChange(view)}
                  aria-pressed={dayView === view}
                  className={`pressable inline-flex items-center gap-1.5 min-h-11 shrink-0 px-3 py-2 rounded-full text-xs font-semibold border transition cursor-pointer ${
                    filterChipClass(dayView === view)
                  }`}
                >
                  <FilterCheck on={dayView === view} />{view === 'today' ? 'Today' : 'All days'}
                </button>
              ))}
            </div>
          )}

          {/* View Switcher: Table vs Cards */}
          <div className="flex items-center bg-sunken p-1 rounded-2xl border border-line shrink-0">
            <button
              id="view-cards-btn"
              aria-pressed={viewMode === 'cards'}
              onClick={() => onViewModeChange('cards')}
              className={`max-sm:min-h-11 max-sm:min-w-11 max-sm:flex max-sm:items-center max-sm:justify-center pressable inline-flex items-center gap-1.5 text-xs p-2 rounded-xl transition cursor-pointer ${
                filterChipClass(viewMode === 'cards')
              }`}
              title="Card Dossier View"
            >
              <FilterCheck on={viewMode === 'cards'} /><LayoutGrid className="w-4 h-4" /> Cards
            </button>
            <button
              id="view-table-btn"
              aria-pressed={viewMode === 'table'}
              onClick={() => onViewModeChange('table')}
              className={`max-sm:min-h-11 max-sm:min-w-11 max-sm:flex max-sm:items-center max-sm:justify-center pressable inline-flex items-center gap-1.5 text-xs p-2 rounded-xl transition cursor-pointer ${
                filterChipClass(viewMode === 'table')
              }`}
              title="Grid Audit Table View"
            >
              <FilterCheck on={viewMode === 'table'} /><TableIcon className="w-4 h-4" /> Table
            </button>
          </div>

          {/* PROMINENT "+ New Assignment" BUTTON (Admin Only) */}
          {isAdmin && (
            <button
              id="filter-bar-add-task-btn"
              onClick={onOpenTaskModal}
              className="max-sm:hidden pressable shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-black rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 hover:brightness-105 transition cursor-pointer"
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
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Filter by category">
          <motion.button
            whileTap={{ scale: 0.94 }}
            onClick={() => onCategoryChange('all')}
            aria-pressed={allActive}
            className={`min-h-11 shrink-0 inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full text-xs font-bold border transition cursor-pointer ${
              filterChipClass(allActive)
            }`}
          >
            <FilterCheck on={allActive} /><Layers className="w-3.5 h-3.5" />
            <span>All</span>
            {categoryCounts && (
              <span className={`tnum text-xs font-black px-1.5 py-0.5 rounded-full ${allActive ? '' : 'bg-sunken'}`}>
                {totalCount}
              </span>
            )}
          </motion.button>

          {categories.map((c) => {
            const active = selectedCategories.includes(c);
            const count = categoryCounts?.[c];
            return (
              <motion.button
                key={c}
                whileTap={{ scale: 0.94 }}
                onClick={() => onCategoryChange(c)}
                aria-pressed={active}
                style={categoryVars(c)}
                className={`min-h-11 shrink-0 inline-flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-bold border transition cursor-pointer ${
                  filterChipClass(active)
                }`}
                title={active ? `Unselect ${c}` : `Filter by ${c}`}
              >
                <FilterCheck on={active} />{!active && <span className="cat-dot w-2.5 h-2.5 rounded-full shrink-0" />}
                <span className="max-w-[140px] truncate">{c}</span>
                {typeof count === 'number' && (
                  <span className={`tnum text-xs font-black px-1.5 py-0.5 rounded-full ${active ? '' : 'bg-sunken'}`}>
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
