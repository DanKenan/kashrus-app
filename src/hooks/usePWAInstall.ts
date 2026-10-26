import { useSyncExternalStore } from 'react';
import { isStandalone, markAppInstalled } from '../lib/installCard';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
let revision = 0;
const listeners = new Set<() => void>();
const emit = () => { revision++; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Capture once at startup, before any signed-in component mounts.
try {
  if (typeof window !== 'undefined') {
    installed = isStandalone();
    if (installed) markAppInstalled();
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        emit();
      });
      window.addEventListener('appinstalled', () => {
        installed = true;
        markAppInstalled();
        deferredPrompt = null;
        emit();
      });
    }
  }
} catch { /* Browser APIs may be absent or blocked in embedded contexts. */ }

async function install(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  try {
    // Call directly in the tap handler; the event is single-use.
    const prompting = event.prompt();
    deferredPrompt = null;
    emit();
    await prompting;
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') {
      installed = true;
      markAppInstalled();
      emit();
      return true;
    }
  } catch (err) {
    console.error('Install prompt error:', err);
  } finally {
    deferredPrompt = null;
    emit();
  }
  return false;
}

export function usePWAInstall() {
  useSyncExternalStore(subscribe, () => revision, () => 0);
  let isIOS = false;
  try {
    isIOS = typeof window !== 'undefined' && /iphone|ipad|ipod/i.test(window.navigator?.userAgent ?? '') && !(window as Window & { MSStream?: unknown }).MSStream;
  } catch { /* No usable browser navigator. */ }
  return { isInstallable: !!deferredPrompt, isInstalled: installed, isIOS: !!isIOS, install };
}
