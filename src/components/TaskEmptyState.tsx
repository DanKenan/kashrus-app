import React from 'react';

interface Props {
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  canCreate: boolean;
  onCreate?: () => void;
  kiosk?: boolean;
}
export function TaskEmptyState({ hasActiveFilters = false, onClearFilters, canCreate, onCreate, kiosk = false }: Props) {
  const title = hasActiveFilters ? 'Nothing matches these filters' : canCreate ? 'Nothing here yet' : 'Nothing for you right now.';
  const line = hasActiveFilters ? 'A filter is on. Tap Clear all to see everything.' : canCreate ? null : 'New tasks show up here.';
  const control = kiosk ? 'min-h-16 text-base' : 'min-h-11 text-sm';
  return (
    <div className="rounded-xl bg-surface border border-line p-8 text-center">
      <h3 className={`font-semibold text-ink ${kiosk ? 'text-k-body' : 'text-base'}`}>{title}</h3>
      {line && <p className={`text-ink-soft mt-2 ${kiosk ? 'text-k-body' : 'text-sm'}`}>{line}</p>}
      {hasActiveFilters ? (
        <button type="button" onClick={onClearFilters} className={`pressable mt-4 px-4 rounded-lg border border-line-control bg-surface text-ink ${control}`}>Clear all</button>
      ) : canCreate && onCreate ? (
        <button type="button" onClick={onCreate} className={`pressable mt-4 px-4 rounded-lg chip-on ${control}`}>New task</button>
      ) : null}
    </div>
  );
}
