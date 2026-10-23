/**
 * "Set up this device as a venue kiosk": the same entry the old home screen
 * had. Marks this browser as a kiosk and opens ?kiosk=1 (App.tsx then shows
 * the pairing screen and ends any signed-in session on this device).
 * Used by the public home page and the shared address's sign-in screen.
 */
export function enterKioskSetup(): void {
  try {
    localStorage.setItem('kiosk_mode', '1');
  } catch {
    // ignore
  }
  window.location.href = `${window.location.pathname}?kiosk=1`;
}
