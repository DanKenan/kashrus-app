import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { checkForUpdate } from '../lib/swUpdate';

/**
 * "Update app" button — for when the app is stuck on an old cached version
 * (e.g. right after a deploy). It checks for a new version, waits until it
 * has fully downloaded, switches to it and reloads once (lib/swUpdate.ts).
 * If there is nothing new it says so instead of reloading. Deliberately
 * NON-destructive: it never unregisters the service worker or wipes caches,
 * so even if the update is interrupted (dying phone, dropped network) the
 * app keeps the last working cached version instead of white-screening.
 */
type Status = 'idle' | 'checking' | 'current' | 'failed' | 'busy';

const STATUS_MS = 4000;

export const UpdateAppButton: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const showFor = (next: Status) => {
    setStatus(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), STATUS_MS);
  };

  const onClick = async () => {
    if (status === 'checking') return;
    setStatus('checking');
    let result: Awaited<ReturnType<typeof checkForUpdate>>;
    try {
      result = await checkForUpdate();
    } catch {
      result = 'failed';
    }
    if (typeof result === 'object') showFor('busy'); // [UPD-RV1] B1: something is saving, open or being typed
    else if (result === 'current') showFor('current');
    else if (result === 'failed') showFor('failed');
    // 'updating': the new version controls the page and it is reloading.
    else showFor('idle');
  };

  const busy = status === 'checking';
  const label =
    status === 'checking'
      ? 'Checking…'
      : status === 'current'
        ? 'You have the newest version'
        : status === 'failed'
          ? "Couldn't update, try again"
          : status === 'busy'
            ? "Finish what's open, then try again"
            : 'Update app';

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer disabled:cursor-default"
      title="Check for a new version and reload"
    >
      <span className="flex items-center gap-2 text-ink-soft">
        <RefreshCw className={`w-4 h-4 text-ink-faint ${busy ? 'animate-spin' : ''}`} />
        <span aria-live="polite">{label}</span>
      </span>
      {status === 'idle' && (
        <span className="text-[11px] text-ink-faint font-normal">newest version</span>
      )}
    </button>
  );
};
