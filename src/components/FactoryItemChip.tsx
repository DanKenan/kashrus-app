import React from 'react';

/** Shared with the Phase 1 factory item list. */
export function FactoryItemChip({ children }: { key?: string; children: React.ReactNode }) {
  return <span className="inline-flex min-h-6 items-center rounded-full bg-sunken px-2 text-xs text-ink-soft">{children}</span>;
}
