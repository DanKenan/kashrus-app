export const INSTALL_CARD_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'shutfey_install_card_snooze_until';
const INSTALLED_KEY = 'shutfey_install_card_installed';
let storageFailed = false;

export const isIOSDevice = (ua?: string): boolean => /iphone|ipod/i.test(ua ?? '');
export const isIOSSafari = (ua?: string): boolean => isIOSDevice(ua) && /Safari\//i.test(ua ?? '') && !/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line\/|GSA|Twitter|Snapchat|TikTok/i.test(ua ?? '');
export function isStandalone(win: { matchMedia?: Window['matchMedia']; navigator?: Navigator & { standalone?: boolean } } | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  try {
    return !!win && ((typeof win.matchMedia === 'function' && !!win.matchMedia('(display-mode: standalone)')?.matches) || win.navigator?.standalone === true);
  } catch { return false; }
}
export function snoozeInstallCard(now = Date.now()): void {
  try { localStorage.setItem(SNOOZE_KEY, String(now + INSTALL_CARD_SNOOZE_MS)); } catch { storageFailed = true; }
}
export function markAppInstalled(): void {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { storageFailed = true; }
}
export function appMarkedInstalled(): boolean {
  try { return storageFailed || localStorage.getItem(INSTALLED_KEY) === '1'; } catch { return true; }
}
export function installCardSnoozed(now = Date.now()): boolean {
  try {
    if (storageFailed) return true;
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (raw === null) return false;
    const until = Number(raw);
    // Corrupt or implausibly distant dates suppress this offer rather than nagging.
    if (!raw.trim() || !Number.isFinite(until) || until > now + INSTALL_CARD_SNOOZE_MS) return true;
    return until > now;
  } catch { return true; }
}
export interface InstallCardEnv {
  fresh: boolean; kiosk: boolean; phone: boolean; standalone: boolean;
  installedMark: boolean; snoozed: boolean; hasPrompt: boolean; ios: boolean; iosSafari: boolean;
}
export function installCardPath(env: InstallCardEnv): 'prompt' | 'ios-safari' | 'ios-other' | null {
  if (!env.fresh || env.kiosk || !env.phone || env.standalone || env.installedMark || env.snoozed) return null;
  if (env.hasPrompt) return 'prompt';
  return env.ios ? (env.iosSafari ? 'ios-safari' : 'ios-other') : null;
}
