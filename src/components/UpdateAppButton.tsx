import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * "Update app" button — for when the app is stuck on an old cached version
 * (e.g. right after a deploy). It asks the service worker to check for a new
 * version, then reloads. Deliberately NON-destructive: it never unregisters
 * the service worker or wipes caches, so even if the update is interrupted
 * (dying phone, dropped network) the app falls back to the last working
 * cached version instead of white-screening.
 */
async function safeAppUpdate(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update()));
    }
  } catch {
    // ignore — reload anyway; the SW updates itself on next launch too
  }
  window.location.reload();
}

export const UpdateAppButton: React.FC = () => {
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await safeAppUpdate();
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
      title="Check for a new version and reload"
    >
      <span className="flex items-center gap-2 text-ink-soft">
        <RefreshCw className={`w-4 h-4 text-ink-faint ${busy ? 'animate-spin' : ''}`} />
        <span>{busy ? 'Updating…' : 'Update app'}</span>
      </span>
      <span className="text-[11px] text-ink-faint font-normal">newest version</span>
    </button>
  );
};
