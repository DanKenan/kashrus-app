import React from 'react';
import { activeFilterChips, clearActiveFilter, type FilterState, type FilterDefaults } from '../lib/activeFilters';

interface Props {
  state: FilterState;
  defaults: FilterDefaults;
  onChange: (state: FilterState) => void;
  kiosk?: boolean;
  onClearAll?: () => void;
}
export function ActiveFilters({ state, defaults, onChange, kiosk = false, onClearAll }: Props) {
  const chips = activeFilterChips(state, defaults);
  if (!chips.length) return null;
  const clear = (key: string) => onChange(clearActiveFilter(state, defaults, key));
  const target = kiosk ? 'min-h-16 text-base' : 'min-h-11 text-xs';
  return (
    <div className={`flex flex-wrap items-center gap-2 mb-4 text-ink-soft ${kiosk ? 'text-base' : 'max-sm:-order-1 text-xs'}`} role="group" aria-label="Active filters">
      <span>Showing:</span>
      {chips.map((chip) => (
        <React.Fragment key={chip.key}>
          <button type="button" onClick={() => clear(chip.key)} aria-label={`Turn off ${chip.label}`} className={`pressable inline-flex items-center gap-2 rounded-full border border-line-control px-3 ${target}`}>
            {chip.label}<span aria-hidden="true">✕</span>
          </button>
          <span aria-hidden="true">·</span>
        </React.Fragment>
      ))}
      <button type="button" onClick={onClearAll ?? (() => clear('all'))} className={`pressable underline ${target}`}>Clear all</button>
    </div>
  );
}
