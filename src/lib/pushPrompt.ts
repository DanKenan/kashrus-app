// PUSHALWAYS (Don, Oct 29: "even if someone didn't press the button of
// notification on, if it's something that he is tagged to or assigned to,
// he'll get an alert anyway"). Pure decisions for the phone-notification
// button and the "turn on notifications" banner (tested in tests/client).
import type { PushMode, PushState } from './push';

export interface PushToggleView { key: 'on' | 'tagged' | 'off' | 'blocked'; on: boolean; value: string; note: string }

/** What the menu button shows for this phone. */
export function pushToggleView(state: PushState, mode: PushMode | null): PushToggleView {
  if (state === 'subscribed' && mode === 'tagged') {
    return { key: 'tagged', on: false, value: 'Off', note: "You still get alerts when you're tagged or assigned." };
  }
  if (state === 'subscribed') return { key: 'on', on: true, value: 'On', note: '' };
  if (state === 'denied') return { key: 'blocked', on: false, value: 'Blocked', note: '' };
  return { key: 'off', on: false, value: 'Off', note: "Turn on to get alerts when you're tagged or assigned, even with the app closed." };
}

export type PushPromptKind = 'turn-on' | 'ios-install' | 'blocked';

export interface PushPromptEnv {
  signedIn: boolean;
  kiosk: boolean;
  phone: boolean;
  /** Web Push exists in this browser (false in iPhone Safari outside the Home-Screen app). */
  supported: boolean;
  /** null = not known yet (the quiet check is still running). */
  state: PushState | null;
  ios: boolean;
  standalone: boolean;
  snoozed: boolean;
  /** Another first-run card (install, passkey) is on screen right now. */
  otherCardOpen: boolean;
}

/** Which banner (if any) a phone gets. Never on a kiosk, never once subscribed. */
export function pushPromptKind(env: PushPromptEnv): PushPromptKind | null {
  if (!env.signedIn || env.kiosk || !env.phone || env.snoozed || env.otherCardOpen) return null;
  if (!env.supported) return env.ios && !env.standalone ? 'ios-install' : null;
  if (env.state === null || env.state === 'subscribed' || env.state === 'unsupported') return null;
  if (env.state === 'denied') return 'blocked';
  return 'turn-on';
}

export const PUSH_PROMPT_TEXT: Record<PushPromptKind, string> = {
  'turn-on': "Turn on notifications so you know when you're tagged or assigned.",
  'ios-install': "To get alerts when you're tagged or assigned, add Shutfey to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.",
  blocked: "Notifications are blocked for Shutfey. To get alerts when you're tagged or assigned, allow them in your phone's settings.",
};

export const PUSH_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const snoozeKey = (userId: string) => `shutfey_push_prompt_snooze_until:${userId}`;
export function pushPromptSnoozed(userId: string, now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(snoozeKey(userId));
    if (raw === null) return false;
    const until = Number(raw);
    if (!Number.isFinite(until) || until > now + PUSH_PROMPT_SNOOZE_MS) return true;
    return until > now;
  } catch { return true; }
}
export function snoozePushPrompt(userId: string, now = Date.now()): void {
  try { localStorage.setItem(snoozeKey(userId), String(now + PUSH_PROMPT_SNOOZE_MS)); } catch { /* fine */ }
}
