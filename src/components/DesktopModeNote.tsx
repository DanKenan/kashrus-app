import React, { useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import {
  DESKTOP_NOTE_DISMISS_KEY,
  desktopNoteText,
  getDesktopModeState,
  noteBrowserFromUa,
  shouldShowDesktopNote,
  subscribeDesktopMode,
} from '../lib/desktopMode';
import { isKioskEntryUrl, isKioskModeOn } from '../lib/kioskSetup';

function inInstalledApp(): boolean {
  try {
    const mm = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
    return mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)')
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

function onKiosk(): boolean {
  try {
    const search = window.location.search;
    if (new URLSearchParams(search).get('kiosk') === '0') return false;
    return isKioskModeOn() || isKioskEntryUrl(search);
  } catch { return false; }
}

function readDismissed(): string | null {
  try { return localStorage.getItem(DESKTOP_NOTE_DISMISS_KEY); } catch { return null; }
}

/**
 * "This phone is showing the desktop version": shown at the top only when the
 * phone draws a desktop-width layout and the automatic fix (lib/desktopMode.ts)
 * could not take. Never on a kiosk. Dismiss hides it on this device for 7 days.
 * The page is shrunk to fit the phone then, so the note is zoomed back up by the
 * same amount (layout width / screen width) to stay readable.
 */
export const DesktopModeNote: React.FC = () => {
  const state = useSyncExternalStore(subscribeDesktopMode, getDesktopModeState, getDesktopModeState);
  const [hidden, setHidden] = useState(false);
  if (hidden || typeof window === 'undefined') return null;
  if (!shouldShowDesktopNote(state, { kiosk: onKiosk(), dismissedAt: readDismissed(), now: Date.now() })) return null;

  const text = desktopNoteText(noteBrowserFromUa(navigator.userAgent), inInstalledApp());
  const layout = document.documentElement.clientWidth || window.innerWidth;
  const screenW = window.screen?.width || layout;
  const scale = Math.max(1, Math.min(4, layout / screenW));

  const dismiss = () => {
    try { localStorage.setItem(DESKTOP_NOTE_DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setHidden(true);
  };

  return (
    <div data-desktop-note="" className="relative z-[80] w-full bg-gold-wash border-b border-line text-ink">
      <div role="status" style={{ zoom: scale }} className="flex items-start gap-2 px-3 py-2.5">
        <p className="flex-1 min-w-0 text-[15px] font-semibold leading-snug">{text}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          data-desktop-note-dismiss=""
          className="pressable shrink-0 -mr-1 -mt-0.5 w-11 h-11 grid place-items-center rounded-lg text-ink-soft cursor-pointer"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
