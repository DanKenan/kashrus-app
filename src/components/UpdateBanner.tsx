import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, getUpdateState, subscribeUpdate } from '../lib/swUpdate';

/**
 * "New version ready — Tap to update": a slim bar at the top while a new
 * version of the app is waiting. The app never reloads on its own; only this
 * tap (or "Update app" in the menu) does. If something is being saved, typed
 * or is open, the tap changes nothing and the bar says so, then offers the
 * tap again.
 */
type Note = null | 'busy' | 'failed';

const NOTE_MS = 5000;

const BUSY_TEXT = "Will update when you're done. Close what's open, then tap again.";
const FAILED_TEXT = "Couldn't update. Try again.";

export const UpdateBanner: React.FC = () => {
  const state = useSyncExternalStore(subscribeUpdate, getUpdateState, () => 'none' as const);
  const [note, setNote] = useState<Note>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (state === 'none') return null;

  const showNote = (next: Note) => {
    setNote(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const onTap = async () => {
    if (state !== 'ready') return;
    let result: Awaited<ReturnType<typeof applyUpdate>>;
    try {
      result = await applyUpdate();
    } catch {
      result = 'failed';
    }
    if (typeof result === 'object') showNote('busy');
    else if (result === 'failed') showNote('failed');
    else setNote(null);
  };

  const updating = state === 'updating';
  const text = updating ? 'Updating…' : note === 'busy' ? BUSY_TEXT : note === 'failed' ? FAILED_TEXT : 'New version ready';

  return (
    <div
      data-update-banner=""
      className="fixed inset-x-0 top-0 z-[90] px-3 pt-[calc(8px+env(safe-area-inset-top))] pointer-events-none"
    >
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto mx-auto max-w-xl flex items-center gap-3 rounded-xl bg-surface border border-line text-ink tactile-2 pl-3 pr-1.5 py-1.5"
      >
        <RefreshCw className={`w-5 h-5 shrink-0 text-gold-deep ${updating ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span className="flex-1 min-w-0 text-sm font-semibold leading-snug">{text}</span>
        {!updating && (
          <button
            type="button"
            onClick={onTap}
            className="pressable shrink-0 h-11 px-4 rounded-lg bg-gold-deep text-paper text-sm font-bold cursor-pointer"
          >
            Tap to update
          </button>
        )}
      </div>
    </div>
  );
};
