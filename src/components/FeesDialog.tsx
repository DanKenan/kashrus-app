import React from 'react';
import { X } from 'lucide-react';
import { useVisitFocus, visitButton } from './FactoryVisitScreen';
export function FeesDialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const root = useVisitFocus(onClose);
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim"><div ref={root} role="dialog" aria-modal="true" aria-label={title} className="max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto break-words rounded-t-2xl bg-surface p-4 text-base text-ink tactile-4"><div className="flex items-center gap-4"><h2 className="min-w-0 flex-1 break-words text-2xl font-semibold">{title}</h2><button type="button" className={`${visitButton} h-11 w-11 shrink-0 px-0`} aria-label="Close" onClick={onClose}><X aria-hidden="true" className="mx-auto h-5 w-5" /></button></div>{children}</div></div>;
}
