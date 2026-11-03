export interface FilterState {
  dayView: 'today' | 'all';
  quickFilter: 'all' | 'mine' | 'pending' | 'completed';
  categories: string[];
  search: string;
}
export type FilterDefaults = Pick<FilterState, 'dayView' | 'quickFilter'>;
const quickLabels = { all: 'All Tasks', mine: 'Assigned to Me', pending: 'Pending', completed: 'Completed' };
// Cards/Table is a display preference, not a task filter; Clear all preserves it.
export function activeFilterChips(state: FilterState, defaults: FilterDefaults): { key: string; label: string }[] {
  return [
    ...(state.dayView !== defaults.dayView ? [{ key: 'day', label: state.dayView === 'today' ? 'Today' : 'All days' }] : []),
    ...(state.quickFilter !== defaults.quickFilter ? [{ key: 'quick', label: quickLabels[state.quickFilter] }] : []),
    ...state.categories.map((label) => ({ key: `category:${label}`, label })),
    ...(state.search.trim() ? [{ key: 'search', label: `Search: "${state.search}"` }] : []),
  ];
}
export function clearActiveFilter(state: FilterState, defaults: FilterDefaults, key: string): FilterState {
  if (key === 'all') return { ...defaults, categories: [], search: '' };
  return { ...state,
    ...(key === 'day' ? { dayView: defaults.dayView } : {}),
    ...(key === 'quick' ? { quickFilter: defaults.quickFilter } : {}),
    ...(key === 'search' ? { search: '' } : {}),
    ...(key.startsWith('category:') ? { categories: state.categories.filter((c) => `category:${c}` !== key) } : {}),
  };
}
