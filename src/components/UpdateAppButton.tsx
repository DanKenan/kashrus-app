import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * "Update app" button — for when the app is stuck on an old cached version
 * (e.g. right after a deploy). It unregisters the service worker, wipes all
 * caches, and reloads fresh from the network. Non-technical users can tap
 * this instead of doing a hard refresh.
 */
async function forceAppUpdate(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    // ignore — proceed to cache wipe anyway
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // ignore — Cache API may be unavailable
  }
  window.location.reload();
}

export const UpdateAppButton: React.FC = () => {
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await forceAppUpdate();
    } finally {
      // reload() normally navigates away; reset if we're somehow still here
      setTimeout(() => setBusy(false), 4000);
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer disabled:cursor-default"
      title="Clear cached files and load the newest version"
    >
      <span className="flex items-center gap-2 text-ink-soft">
        <RefreshCw className={`w-4 h-4 text-ink-faint ${busy ? 'animate-spin' : ''}`} />
        <span>{busy ? 'Updating…' : 'Update app'}</span>
      </span>
      <span className="text-[11px] text-ink-faint font-normal">newest version</span>
    </button>
  );
};
