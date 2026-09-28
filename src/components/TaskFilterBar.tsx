import React from 'react';
import { Search, LayoutGrid, Table as TableIcon, Filter, X, Plus } from 'lucide-react';

interface TaskFilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  categories: string[];
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
  viewMode,
  onViewModeChange,
  showOnlyTodaySchedule,
  onToggleScheduleFilter,
  onOpenTaskModal,
  isAdmin,
}) => {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-5">
      {/* Search Bar */}
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
        <input
          id="task-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search inspections, mashgiach name, notes..."
          className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm rounded-2xl bg-white dark:bg-slate-900 border border-stone-200/90 dark:border-stone-800 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition shadow-2xs"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Filters, View Switcher & Prominent New Assignment Button */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 flex-wrap sm:flex-nowrap">
        {/* Category Dropdown */}
        <div className="relative shrink-0">
          <select
            id="category-filter-select"
            value={selectedCategory}
            onChange={(e) => onCategoryChange(e.target.value)}
            className="appearance-none pl-3.5 pr-8 py-2.5 text-xs font-bold rounded-2xl bg-white dark:bg-slate-900 border border-stone-200/90 dark:border-stone-800 text-stone-700 dark:text-stone-300 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition cursor-pointer shadow-2xs"
          >
            <option value="all">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Filter className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
        </div>

        {/* Today's Schedule Only Toggle */}
        <button
          id="today-schedule-toggle"
          onClick={onToggleScheduleFilter}
          className={`shrink-0 px-3.5 py-2.5 text-xs font-bold rounded-2xl border transition cursor-pointer shadow-2xs ${
            showOnlyTodaySchedule
              ? 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-800'
              : 'bg-white dark:bg-slate-900 text-stone-600 dark:text-stone-400 border-stone-200/90 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-slate-800'
          }`}
          title="Filter tasks scheduled for today's active shift"
        >
          {showOnlyTodaySchedule ? '✓ Active Today' : 'All Shift Days'}
        </button>

        {/* View Switcher: Table vs Cards */}
        <div className="flex items-center bg-stone-100 dark:bg-slate-800 p-1 rounded-2xl border border-stone-200/80 dark:border-stone-700/60 shrink-0">
          <button
            id="view-cards-btn"
            onClick={() => onViewModeChange('cards')}
            className={`p-1.5 rounded-xl transition cursor-pointer ${
              viewMode === 'cards'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-2xs font-bold'
                : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200'
            }`}
            title="Card Dossier View"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            id="view-table-btn"
            onClick={() => onViewModeChange('table')}
            className={`p-1.5 rounded-xl transition cursor-pointer ${
              viewMode === 'table'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-2xs font-bold'
                : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200'
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
            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-black rounded-2xl bg-gradient-to-r from-amber-600 via-amber-700 to-amber-800 hover:from-amber-700 hover:to-amber-900 active:scale-95 text-white shadow-sm shadow-amber-700/20 transition cursor-pointer"
            title="Register a new daily task assignment"
          >
            <Plus className="w-4 h-4" />
            <span>New Assignment</span>
          </button>
        )}
      </div>
    </div>
  );
};

