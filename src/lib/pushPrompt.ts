// PUSHALWAYS (Don, Oct 29: "even if someone didn't press the button of
// notification on, if it's something that he is tagged to or assigned to,
// he'll get an alert anyway"). Pure decisions for the phone-notification
// button and the "turn on notifications" pop-up (tested in tests/client).
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
  dismissed: boolean;
  /** Another first-run card or its check is still active. */
  firstRunBusy: boolean;
}

/** Which pop-up (if any) a phone gets. Never on a kiosk, never once subscribed. */
export function pushPromptKind(env: PushPromptEnv): PushPromptKind | null {
  if (!env.signedIn || env.kiosk || !env.phone || env.dismissed || env.firstRunBusy) return null;
  if (env.state === null || env.state === 'subscribed') return null;
  if (!env.supported) return env.ios && !env.standalone ? 'ios-install' : null;
  if (env.state === 'unsupported') return null;
  if (env.state === 'denied') return 'blocked';
  return 'turn-on';
}

export const PUSH_PROMPT_TEXT: Record<PushPromptKind, string> = {
  'turn-on': "Turn on notifications so you know when you're tagged or assigned.",
  'ios-install': "To get alerts when you're tagged or assigned, add Shutfey to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.",
  blocked: "Notifications are blocked for Shutfey. To get alerts when you're tagged or assigned, allow them in your phone's settings.",
};

// Memory only: a reload starts a new open, even in the same tab.
const dismissedUsers = new Set<string>();
export function dismissPushPromptForThisOpen(userId: string): void {
  dismissedUsers.add(userId);
}
export function pushPromptDismissedThisOpen(userId: string): boolean {
  return dismissedUsers.has(userId);
}

// Retire the old seven-day snooze once per module load, best effort.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('shutfey_push_prompt_snooze_until:')) localStorage.removeItem(key);
  }
} catch { /* Storage may be unavailable. Dismissal still works in memory. */ }
