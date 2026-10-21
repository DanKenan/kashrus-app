import React from 'react';
import { Bell } from 'lucide-react';

// 5a — the header bell. count === null is the kiosk: a bell with no badge
// and no number in the label (a shared tablet shows no one's unread count).
export function UpdatesBell({
  count,
  onClick,
  sizeClass = 'w-11 h-11',
}: {
  count: number | null;
  onClick: () => void;
  // D3c: the kiosk top bar passes a 64 px tablet size (kiosk targets are 64 px).
  sizeClass?: string;
}) {
  const label =
    count === null ? 'Updates' : count > 0 ? `Updates, ${count} unread` : 'Updates';
  return (
    <button
      id="updates-bell"
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`pressable relative flex items-center justify-center ${sizeClass} rounded-xl border border-line bg-sunken hover:bg-line/40 text-ink transition cursor-pointer shrink-0`}
    >
      <Bell className="w-5 h-5" />
      {count !== null && count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-gold text-white text-xs font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}
