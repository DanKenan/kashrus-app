import React from 'react';
import { Bell } from 'lucide-react';

// 5a — the header bell. count === null is the kiosk: a bell with no badge
// and no number in the label (a shared tablet shows no one's unread count).
export function UpdatesBell({
  count,
  onClick,
  // H1: fixed px so large text does not grow the target
  sizeClass = 'w-[44px] h-[44px]',
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
      {/* H1: fixed px so large text does not grow the target */}
      <Bell className="w-[20px] h-[20px]" />
      {/* H1: fixed px so large text does not grow the target */}
      {count !== null && count > 0 && (
        <span className="absolute top-[2px] right-[2px] min-w-[1.55em] h-[1.55em] px-[0.3em] leading-none rounded-full bg-gold text-white text-[length:clamp(11px,0.75rem,16px)] font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}
