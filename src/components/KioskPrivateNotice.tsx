import React, { useState } from 'react';
import { Lock, X } from 'lucide-react';
import { kioskPrivateNotice } from '../lib/mentions';

// TEAMNOTES2 (Don, Oct 29: "if the mashgiach does have a private message, it
// should tell him that there's a private message for him to look at"): the
// kiosk never shows a private note. When the person signed in on the tablet
// has unread private notes tagged to them at this venue, this banner says so
// and sends them to their phone. It knows a NUMBER only (the server sends no
// text, author, id or time). "OK" hides it until the number changes or the
// next person signs in (App keys it by both).
export function KioskPrivateNotice({ count }: { count: number }) {
  const [hidden, setHidden] = useState(false);
  const text = kioskPrivateNotice(count);
  if (hidden || !text) return null;
  return (
    <div data-kiosk-private-banner role="status" className="bg-sunken border-b border-line-control text-ink">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3">
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <Lock className="w-5 h-5 shrink-0 text-ink-soft" />
          <span className="text-base font-bold">{text}</span>
        </span>
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-label="Hide"
          className="pressable shrink-0 w-11 h-11 flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
