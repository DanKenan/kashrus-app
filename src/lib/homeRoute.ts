/**
 * Which public screen a signed-out visitor sees first on the shared address.
 *
 * - A normal browser tab: the home page (with "Sign in" in its top bar).
 * - The installed home-screen app (display-mode standalone / fullscreen /
 *   minimal-ui, or iOS's navigator.standalone): the sign-in form, since people
 *   who installed the app came to sign in. Detected at run time rather than by
 *   a new manifest start_url, because phones that installed the app earlier
 *   keep the start_url they installed with.
 *
 * Kiosk tablets, invite/reset links, agency addresses and signed-in people are
 * decided before this in App.tsx and never reach the home page.
 */
export type AuthView = 'landing' | 'auth';

type WinLike = {
  matchMedia?: (q: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
};

export function isInstalledApp(win: WinLike | undefined = typeof window !== 'undefined' ? (window as unknown as WinLike) : undefined): boolean {
  if (!win) return false;
  try {
    if (win.navigator?.standalone === true) return true;
    if (typeof win.matchMedia !== 'function') return false;
    return ['standalone', 'fullscreen', 'minimal-ui'].some((mode) => win.matchMedia!(`(display-mode: ${mode})`).matches);
  } catch {
    return false;
  }
}

export function initialAuthView(win?: WinLike): AuthView {
  return isInstalledApp(win === undefined && typeof window !== 'undefined' ? (window as unknown as WinLike) : win) ? 'auth' : 'landing';
}
