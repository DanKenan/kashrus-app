import React, { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import {
  getPushState,
  subscribeForPush,
  unsubscribeFromPush,
  pushSupported,
  type PushState,
} from '../lib/push';

/**
 * Phone-notification toggle for the user menu.
 * Tapping enables Web Push on this device (works even with the app closed);
 * tapping again unsubscribes. iOS needs the PWA on the Home Screen (16.4+).
 */
export const PushNotificationToggle: React.FC<{ userEmail: string }> = ({ userEmail }) => {
  const [state, setState] = useState<PushState>('default');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  if (!pushSupported()) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    if (state === 'subscribed') {
      await unsubscribeFromPush();
      setState(await getPushState());
    } else {
      const result = await subscribeForPush(userEmail);
      if (result === 'subscribed') {
        setState('subscribed');
      } else if (result === 'denied') {
        setState('denied');
        setHint('Notifications are blocked — allow them in your browser settings.');
      } else {
        setState(await getPushState());
        setHint('Could not enable — on iPhone, install the app to your Home Screen first.');
      }
    }
    setBusy(false);
  };

  const on = state === 'subscribed';

  return (
    <div>
      <button
        onClick={toggle}
        disabled={busy || state === 'denied'}
        className="pressable min-h-11 bg-surface border border-line-control text-ink w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-ink-soft">
          {on ? (
            <Bell className="w-4 h-4 text-gold-deep" />
          ) : (
            <BellOff className="w-4 h-4 text-ink-faint" />
          )}
          <span>Phone notifications</span>
        </span>
        <span
          className={`text-xs font-bold ${
            on ? 'text-ok' : 'text-ink-soft font-normal'
          }`}
        >
          {busy ? '…' : on ? 'On' : state === 'denied' ? 'Blocked' : 'Off'}
        </span>
      </button>
      {hint && <p className="px-2.5 pb-1 text-xs text-ink-soft leading-snug">{hint}</p>}
      {!on && state !== 'denied' && (
        <p className="px-2.5 pb-1 text-xs text-ink-soft leading-snug">
          Get event & task assignments on this phone, even with the app closed.
        </p>
      )}
    </div>
  );
};
