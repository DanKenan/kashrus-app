import React from 'react';
import { Check } from 'lucide-react';

export function filterChipClass(on: boolean): string {
  return on ? 'chip-on bg-gold-deep border border-gold-deep' : 'bg-surface text-ink-soft border border-line-control';
}
export function FilterCheck({ on }: { on: boolean }) {
  return on ? <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> : null;
}
