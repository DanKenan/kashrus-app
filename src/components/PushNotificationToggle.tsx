import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import {
  PUSH_CHANGED_EVENT,
  getPushSetup,
  pushSupported,
  setPushMode,
  turnOnPush,
  type PushMode,
  type PushSetup,
  type PushState,
} from '../lib/push';
import { pushToggleView } from '../lib/pushPrompt';

/**
 * Phone-notification button for the user menu (PUSHALWAYS, Don Oct 29).
 * Not set up -> tapping turns notifications on for this phone (all of them).
 * On -> tapping turns them "Off": the phone stays subscribed and still gets
 * the alerts about the person themselves (tagged, @All, assigned, overdue on
 * their task, their alerts) — like a muted WhatsApp group that still rings
 * on a mention. Off -> tapping turns everything on again.
 * iOS needs the app on the Home Screen (16.4+).
 */
export const PushNotificationToggle: React.FC<{ userEmail: string; userId: string }> = ({ userEmail, userId }) => {
  const [state, setState] = useState<PushState>('default');
  const [mode, setMode] = useState<PushMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Only the newest read may update the button, and never one that a tap or a
  // sign-in change overtook (review PARV6).
  const readSeq = useRef(0);
  const readRef = useRef<() => void>(() => {});
  const apply = (r: PushSetup) => {
    setState(r.state);
    setMode(r.state === 'subscribed' ? r.mode ?? 'all' : null);
  };

  useEffect(() => {
    let live = true;
    // Server-confirmed (review PARV1): "On"/"Off" only when the server holds this phone for this person.
    const read = () => {
      const seq = ++readSeq.current;
      void getPushSetup(userId).then((r) => {
        if (!live || seq !== readSeq.current || r.stale) return;
        apply(r);
      });
    };
    readRef.current = read;
    read();
    window.addEventListener(PUSH_CHANGED_EVENT, read);
    return () => { live = false; readRef.current = () => {}; window.removeEventListener(PUSH_CHANGED_EVENT, read); };
  }, [userId]);

  if (!pushSupported()) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    readSeq.current++; // a read already in flight predates this tap: it may not repaint the button
    if (state === 'subscribed') {
      const next: PushMode = mode === 'tagged' ? 'all' : 'tagged';
      const r = await setPushMode(next, userId);
      if (r === 'done') setMode(next);
      else if (r === 'failed') setHint('Could not change it — try again.');
      else readRef.current(); // superseded by a newer tap: show what the server holds now
    } else {
      // Server-confirmed after a failure (review PARV3): never "On" unless the server holds this phone.
      const { result, setup } = await turnOnPush(userEmail, userId);
      if (result === 'superseded') readRef.current();
      else {
        if (!setup.stale) apply(setup);
        else readRef.current();
        if (result === 'denied') setHint('Notifications are blocked — allow them in your browser settings.');
        else if (result === 'failed') setHint('Could not turn on notifications — try again.');
      }
    }
    setBusy(false);
  };

  const view = pushToggleView(state, mode);

  return (
    <div>
      <button
        onClick={toggle}
        disabled={busy || state === 'denied'}
        data-push-toggle={view.key}
        className="pressable min-h-11 bg-surface border border-line-control text-ink w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-ink-soft">
          {view.on ? (
            <Bell className="w-4 h-4 text-gold-deep" />
          ) : (
            <BellOff className="w-4 h-4 text-ink-faint" />
          )}
          <span>Phone notifications</span>
        </span>
        <span
          className={`text-xs font-bold ${
            view.on ? 'text-ok' : 'text-ink-soft font-normal'
          }`}
        >
          {busy ? '…' : view.value}
        </span>
      </button>
      {hint && <p className="px-2.5 pb-1 text-xs text-ink-soft leading-snug">{hint}</p>}
      {!hint && view.note && (
        <p data-push-note className="px-2.5 pb-1 text-xs text-ink-soft leading-snug">{view.note}</p>
      )}
    </div>
  );
};
