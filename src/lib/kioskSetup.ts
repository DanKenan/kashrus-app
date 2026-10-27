/**
 * "Set up this device as a venue kiosk": the same entry the old home screen
 * had. Marks this browser as a kiosk and opens ?kiosk=1 (App.tsx then shows
 * the pairing screen and ends any signed-in session on this device).
 * Used by the public home page and the sign-in screen (the shared address and
 * an agency's own address, so the installed app can become a kiosk too).
 */
export function enterKioskSetup(): void {
  try {
    localStorage.setItem('kiosk_mode', '1');
  } catch {
    // ignore
  }
  window.location.href = `${window.location.pathname}?kiosk=1`;
}

/** True when this page load is a kiosk entry (?kiosk=1). */
export function isKioskEntryUrl(search: string): boolean {
  try {
    return new URLSearchParams(search).get('kiosk') === '1';
  } catch {
    return false;
  }
}

/** True when this device is in kiosk mode (stored flag). */
export function isKioskModeOn(): boolean {
  try {
    return localStorage.getItem('kiosk_mode') === '1';
  } catch {
    return false;
  }
}

/**
 * Every stored key that keeps a signed-in person (or their agency context) on
 * this device. Kiosk entry removes all of them, so a kiosk never opens as the
 * person who was signed in before (Don, Oct 26: ?kiosk=1 opened as the admin).
 * The kiosk's own keys (kiosk_mode, kiosk_device) are not here.
 */
export const KIOSK_ENTRY_CLEARED_KEYS = [
  'shutfey_session_token',
  'shutfey_user',
  'current_user',
  'selected_venue_id',
  'shutfey_agency_logo',
] as const;

/** Kiosk entry: forget the signed-in person on this device (storage only). */
export function forgetSignedInUserForKiosk(): void {
  for (const key of KIOSK_ENTRY_CLEARED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}
