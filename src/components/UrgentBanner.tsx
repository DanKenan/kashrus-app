import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

// 5a — the urgent banner: only the newest unread urgent announcement for
// this venue. "View" opens the sheet on it; "×" marks it read on the server
// (through the same seen queue as on-screen marks). Never on the kiosk.
export function UrgentBanner({
  item,
  onView,
  onDismiss,
}: {
  item: { id: string; title: string; createdAt: string };
  onView: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      role="alert"
      className="border-b"
      style={{ backgroundColor: 'var(--bad-bg)', borderColor: 'var(--bad)' }}
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3">
        <span className="flex items-center gap-2 min-w-0 flex-1" style={{ color: 'var(--bad)' }}>
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span dir="auto" className="text-base font-bold truncate">
            <span className="uppercase text-xs font-black tracking-wide mr-2">Urgent</span>
            {item.title}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onView(item.id)}
          className="pressable shrink-0 px-3 h-11 flex items-center rounded-lg text-sm font-bold cursor-pointer"
          style={{ backgroundColor: 'var(--bad)', color: 'var(--bad-bg)' }}
        >
          View
        </button>
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss and mark read"
          className="pressable shrink-0 w-11 h-11 flex items-center justify-center rounded-lg cursor-pointer"
          style={{ color: 'var(--bad)' }}
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
