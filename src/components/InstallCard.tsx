import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Copy, PlusSquare, Share, Star, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { installCardPath, snoozeInstallCard, type InstallCardEnv } from '../lib/installCard';

export const InstallCard: React.FC<{ env: InstallCardEnv; install: () => Promise<boolean>; onClose: () => void }> = ({ env, install, onClose }) => {
  const [view, setView] = useState<'offer' | 'ios-steps' | 'ios-open-safari'>('offer');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = () => { snoozeInstallCard(); onClose(); };
  const path = installCardPath(env);
  const visible = !!path || busy;
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('root');
    const previousInert = appRoot?.getAttribute('inert') ?? null;
    appRoot?.setAttribute('inert', '');
    return () => {
      clearTimeout(timer.current);
      if (previousInert === null) appRoot?.removeAttribute('inert');
      else appRoot?.setAttribute('inert', previousInert);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [visible]);
  useEffect(() => {
    // View changes remove Install; disabling it can also drop focus onto body.
    title.current?.focus();
  }, [view, busy]);
  useEffect(() => {
    if (path === null && !busy) onClose();
  }, [path, busy, onClose]);
  if (!visible) return null;
  const add = async () => {
    if (path === 'ios-safari') { setView('ios-steps'); return; }
    if (path === 'ios-other') { setView('ios-open-safari'); return; }
    if (busy || path !== 'prompt') return;
    setBusy(true);
    if (await install()) onClose(); else close();
  };
  const link = location.origin + '/';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setCopyFailed(true); }
  };
  const primary = 'w-full min-h-12 rounded-xl bg-gold-deep text-paper text-base font-semibold pressable disabled:opacity-60';
  return createPortal(
    <div ref={root} data-install-card data-install-card-view={view} role="dialog" aria-modal="true" aria-labelledby="install-card-title"
      className="fixed inset-0 z-50 flex items-end bg-scrim animate-fade-in"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const targets = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []);
          const first = targets[0] ?? title.current;
          const last = targets[targets.length - 1] ?? title.current;
          if (!first || !last) return;
          const active = document.activeElement;
          if (!targets.length || active === title.current || !root.current?.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="w-full max-h-full overflow-y-auto rounded-t-2xl bg-surface border border-line p-6 e3 animate-slide-up space-y-4" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center gap-4">
          {view === 'offer' && <img src="/pwa-192x192.png" alt="" width={56} height={56} className="w-14 h-14 rounded-xl e2 shrink-0" />}
          <h2 ref={title} id="install-card-title" tabIndex={-1} className="outline-none flex-1 text-start text-lg font-bold text-ink">{view === 'offer' ? 'Add Shutfey to your home screen' : view === 'ios-steps' ? 'Add to Home Screen' : 'Open in Safari first'}</h2>
          <button aria-label="Close" onClick={close} className="min-h-11 min-w-11 flex items-center justify-center rounded-xl text-ink-soft pressable"><X /></button>
        </div>
        {view === 'offer' && <>
          <p className="text-base text-ink-soft">Open it in one tap, like any app.</p>
          <button data-install-card-install onClick={add} disabled={busy} className={primary}>Install</button>
        </>}
        {view === 'ios-steps' && <>
          <div className="space-y-4 text-base text-ink-soft">
            <div className="rounded-xl border border-line bg-sunken p-4 space-y-4">
              <div className="flex items-center gap-2"><span aria-hidden="true" className="w-7 h-7 rounded-full bg-gold-wash text-gold-deep text-sm font-bold flex items-center justify-center shrink-0">1</span><p className="text-ink font-semibold">Tap Share</p></div>
              <div aria-hidden="true" className="flex items-center justify-around rounded-xl bg-surface p-4 text-ink-faint"><ChevronLeft /><ChevronRight /><span className="rounded-lg ring-2 ring-gold p-2 text-gold-deep"><Share /></span><BookOpen /><Copy /></div>
              <p>In Safari's toolbar. On newer iPhones, tap ••• first.</p>
            </div>
            <div className="rounded-xl border border-line bg-sunken p-4 space-y-4">
              <div className="flex items-center gap-2"><span aria-hidden="true" className="w-7 h-7 rounded-full bg-gold-wash text-gold-deep text-sm font-bold flex items-center justify-center shrink-0">2</span><p className="text-ink font-semibold">Tap Add to Home Screen</p></div>
              <div aria-hidden="true" className="rounded-xl border border-line bg-surface p-4 space-y-4">
                <div className="flex items-center gap-4 text-ink-faint"><span className="p-2"><Star /></span><span>Add to Favorites</span></div>
                <div className="flex items-center gap-4 text-ink"><span className="rounded-lg ring-2 ring-gold p-2"><PlusSquare className="text-gold-deep" /></span><span>Add to Home Screen</span></div>
              </div>
              <p>Scroll down if you don't see it. Then tap Add.</p>
            </div>
          </div>
          <button data-install-card-done onClick={close} className={primary}>Done</button>
        </>}
        {view === 'ios-open-safari' && <>
          <p className="text-base text-ink-soft">Only Safari can add Shutfey to your home screen. Copy the link, then open it in Safari.</p>
          <button data-install-card-copy onClick={copy} className={primary}>{copied ? 'Copied' : 'Copy link'}</button>
          {copyFailed && <p className="select-all break-all text-base text-ink" tabIndex={0}>{link}</p>}
        </>}
        {view !== 'ios-steps' && <button data-install-card-notnow onClick={close} className="min-h-11 w-full text-base text-ink-soft pressable">Not now</button>}
      </div>
    </div>, document.body);
};
