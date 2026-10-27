/**
 * Don 2026-10-27: a refresh (or the app reloading itself, e.g. after an
 * update) must not throw him back to the agency home. The main screen the
 * person is on is remembered for this tab and put back after a reload.
 *
 * What is remembered: the base view (the admin's agency home or the venue
 * board) and which main sheet is open on top of it (Events, Team, History,
 * Venues, or the admin's agency-wide Events from the dashboard). Nothing else: no task editor, dialog or form is ever restored.
 * The selected venue is already remembered by venueSelection.ts.
 *
 * Where: sessionStorage. It survives a refresh, a reload and an app update in
 * the same tab, but a freshly opened app still starts where it does today,
 * and nothing is left behind for the next person on a shared device. The key
 * carries the agency and the user id, so one person's screen never opens for
 * another.
 *
 * Fail closed: a saved screen is checked against the person's role every
 * time it is read. A view or sheet the role cannot see (Team for a mashgiach,
 * Venues or the agency home for anyone but an admin), an unknown value or a
 * broken entry falls back to the default screen. The kiosk never reads or
 * writes it (App.tsx).
 *
 * The role used at load comes from this device's cached sign-in, which can be
 * stale (e.g. an admin made a mashgiach since). So the sheets only some roles
 * may see (Team, Venues, agency Events) are reopened only after the server
 * confirms who is signed in and their role (restoreConfirmed); Events and
 * History, which every role sees, reopen at once.
 */
import type { User } from '../types';
import { venueTabsFor } from '../components/VenueTabs';

export type ScreenView = 'home' | 'board';
export type ScreenSheet = 'events' | 'team' | 'history' | 'venues' | 'agency-events';
export interface SavedScreen {
  view: ScreenView;
  sheet: ScreenSheet | null;
}

type ScreenUser = Pick<User, 'id' | 'role'> & { agencyId?: string };

export const SCREEN_STORAGE_PREFIX = 'shutfey_screen:';

export function screenStorageKey(user: ScreenUser): string {
  return `${SCREEN_STORAGE_PREFIX}${user.agencyId || '-'}:${user.id}`;
}

/** The screen a person lands on when nothing (allowed) is remembered. */
export function defaultScreen(user: Pick<User, 'role'> | null | undefined): SavedScreen {
  return { view: user?.role === 'admin' ? 'home' : 'board', sheet: null };
}

/** May this role see this sheet? Mirrors the menus that open them. */
export function sheetAllowed(user: Pick<User, 'role'> | null | undefined, sheet: unknown): sheet is ScreenSheet {
  if (!user) return false;
  if (sheet === 'venues' || sheet === 'agency-events') return user.role === 'admin';
  if (sheet === 'events' || sheet === 'team' || sheet === 'history') return venueTabsFor(user).includes(sheet);
  return false;
}

/** Sheets only some roles may see: reopened only once the server confirms the role. */
export function isRestrictedSheet(sheet: ScreenSheet | null): boolean {
  return sheet === 'team' || sheet === 'venues' || sheet === 'agency-events';
}

/**
 * Pure: may a restricted sheet be reopened, given the cached user this page
 * loaded with and the server's answer to GET /api/auth/me? Only when the
 * server names the same person, not as a kiosk, with a role that may see it.
 */
export function restoreConfirmed(cached: Pick<User, 'id'> | null | undefined, me: unknown, sheet: ScreenSheet | null): boolean {
  if (!cached || !sheet || !me || typeof me !== 'object') return false;
  const { user, kiosk } = me as { user?: unknown; kiosk?: unknown };
  if (kiosk || !user || typeof user !== 'object') return false;
  const u = user as { id?: unknown; role?: unknown };
  if (typeof u.id !== 'string' || u.id !== cached.id || typeof u.role !== 'string') return false;
  return sheetAllowed({ role: u.role as User['role'] }, sheet);
}

/** Pure: a stored value -> the screen to open, or the default when it is not allowed. */
export function screenFromStored(user: Pick<User, 'role'> | null | undefined, raw: string | null | undefined): SavedScreen {
  const fallback = defaultScreen(user);
  if (!user || !raw) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const { view, sheet } = parsed as { view?: unknown; sheet?: unknown };
  // The agency home is the admin's only; anyone else's base view is the board.
  const okView = view === 'board' || (view === 'home' && user.role === 'admin');
  if (!okView) return fallback;
  if (sheet == null) return { view: view as ScreenView, sheet: null };
  if (!sheetAllowed(user, sheet)) return fallback;
  return { view: view as ScreenView, sheet };
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The remembered screen for this person in this tab (default when none, not allowed, or storage is blocked). */
export function readSavedScreen(user: ScreenUser | null | undefined): SavedScreen {
  if (!user || !user.id) return defaultScreen(user);
  try {
    return screenFromStored(user, storage()?.getItem(screenStorageKey(user)));
  } catch {
    return defaultScreen(user);
  }
}

/** Remembers the screen for this person in this tab; a screen the role cannot see is never stored. */
export function saveScreen(user: ScreenUser | null | undefined, screen: SavedScreen): void {
  if (!user || !user.id) return;
  const safe = screenFromStored(user, JSON.stringify(screen));
  try {
    storage()?.setItem(screenStorageKey(user), JSON.stringify(safe));
  } catch {
    // storage full or blocked: nothing is remembered, the app works as before
  }
}

/** Forgets every remembered screen in this tab (sign-out, kiosk). */
export function forgetSavedScreens(): void {
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(SCREEN_STORAGE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {
    // ignore
  }
}
