import React, { useEffect, useState } from 'react';
import { Moon, Sun, WifiOff } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import { clockText, weekdayText, hebrewDateText, initialsOf } from '../lib/kioskClock';

/**
 * KioskTopBar — the calm kiosk's only chrome (D3c).
 *
 * On a signed-in kiosk the full app Header is not rendered (App.tsx); this
 * bar carries what the tablet still needs: the brand, the venue, the clock
 * with the weekday and Hebrew date, who is signed in, the Updates bell
 * (announcements + shift notes, read-only on the kiosk), the day/night
 * switch, an "Offline" chip only while the live connection is down, and
 * End shift. Presentation only: every control calls an existing handler.
 */

/** Re-render on each new minute (aligned to the minute boundary). */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const d = new Date();
      setNow(d);
      t = setTimeout(tick, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    const d = new Date();
    t = setTimeout(tick, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}

interface KioskTopBarProps {
  now: Date;
  userName: string;
  avatarColor?: string;
  venueName?: string;
  updatesBell?: React.ReactNode;
  darkMode?: boolean;
  onToggleDarkMode?: () => void;
  isRealtimeConnected?: boolean;
  onEndShift: () => void;
}

const btn64 = 'min-h-11 min-w-11 sm:min-h-16 sm:min-w-16';

export const KioskTopBar: React.FC<KioskTopBarProps> = ({
  now,
  userName,
  avatarColor,
  venueName,
  updatesBell,
  darkMode,
  onToggleDarkMode,
  isRealtimeConnected,
  onEndShift,
}) => {
  const firstName = userName.split(' ')[0];
  const hebrew = hebrewDateText(now);
  return (
    <div data-kiosk-topbar className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-6 py-2 sm:py-3">
      <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1 basis-56">
        <ShutfeyLogo size="md" showSubtitle={false} />
        {venueName && (
          <p
            data-kiosk-venue
            dir="auto"
            className="min-w-0 border-s border-line ps-3 sm:ps-4 text-base sm:text-k-body font-semibold text-ink line-clamp-2 break-words"
          >
            {venueName}
          </p>
        )}
      </div>

      <div data-kiosk-topclock className="flex flex-col items-start sm:items-center shrink-0 leading-tight">
        <span className="tnum text-xl sm:text-k-title font-semibold text-ink">{clockText(now)}</span>
        <span className="text-base text-ink-soft whitespace-nowrap">
          {weekdayText(now)}
          {hebrew && (
            <>
              {' · '}
              <span data-kiosk-hebrew-date dir="rtl" lang="he" className="font-hebrew">{hebrew}</span>
            </>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ms-auto">
        {isRealtimeConnected === false && (
          <span
            data-kiosk-offline
            role="status"
            className="inline-flex items-center gap-2 min-h-11 px-3 rounded-full bg-warn-bg text-warn border border-warn text-base font-semibold"
          >
            <WifiOff className="w-5 h-5" aria-hidden /> Offline
          </span>
        )}
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="w-11 h-11 sm:w-12 sm:h-12 rounded-full flex items-center justify-center text-base font-semibold shrink-0"
            style={{
              backgroundColor: avatarColor || 'var(--avatar-fallback)',
              // Same pairing as the PIN screen's name tiles (KioskLogin).
              color: avatarColor ? 'white' : 'var(--paper)',
            }}
          >
            {initialsOf(userName)}
          </span>
          <span data-kiosk-person dir="auto" className="hidden md:block max-w-[12rem] truncate text-base sm:text-k-body font-semibold text-ink">
            {firstName}
          </span>
        </div>
        {updatesBell}
        {onToggleDarkMode && (
          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={darkMode ? 'Switch to day colours' : 'Switch to night colours'}
            title={darkMode ? 'Day colours' : 'Night colours'}
            className="pressable w-11 h-11 rounded-xl border border-line bg-sunken text-ink flex items-center justify-center shrink-0"
          >
            {darkMode ? <Sun className="w-5 h-5" aria-hidden /> : <Moon className="w-5 h-5" aria-hidden />}
          </button>
        )}
        <button
          data-kiosk-end-shift
          onClick={onEndShift}
          className={`pressable shrink-0 max-w-[16rem] ${btn64} px-4 sm:px-6 rounded-xl bg-red-700 text-white text-base sm:text-k-body font-semibold e2`}
        >
          <span dir="auto" className="block truncate">End shift — {firstName}</span>
        </button>
      </div>
    </div>
  );
};
