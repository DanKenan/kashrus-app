import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Tablet, X } from 'lucide-react';
import { KQR_UI_TEXT as T, clockText, kqrTabletLines, kqrLinkFromScan, kqrPhoneFetch, loadAppOrigins, parseTablets, wasJustRefused, type KqrTablet } from '../lib/kioskQr';

interface TabletSignInSheetProps {
  open: boolean;
  /** Open on the list of tablets instead of the camera. */
  startOn?: 'scan' | 'tablets';
  onClose: () => void;
  /** A code for a tablet on THIS address: the app shows the link page without a reload. */
  onScanned: (code: string) => void;
}

type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> };

function makeDetector(): Detector | null {
  const BD = (globalThis as any).BarcodeDetector;
  if (typeof BD !== 'function') return null;
  try { return new BD({ formats: ['qr_code'] }) as Detector; } catch { return null; }
}

/**
 * "Sign in to a tablet" (phone menu): the camera, which reads only a tablet
 * link on an address the server lists (/api/site appOrigins), and "Tablets
 * you're signed in on" with Sign out on each. A phone whose browser has no
 * code reader is told to use its camera app (the link page does the rest).
 */
export function TabletSignInSheet({ open, startOn = 'scan', onClose, onScanned }: TabletSignInSheetProps) {
  const [view, setView] = useState<'scan' | 'tablets'>(startOn);
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [hint, setHint] = useState<string | null>(null);
  const [tablets, setTablets] = useState<KqrTablet[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cbRef = useRef({ onScanned, onClose });
  cbRef.current = { onScanned, onClose };

  useEffect(() => { if (open) setView(startOn); }, [open, startOn]);

  const loadTablets = async () => {
    try {
      const r = await kqrPhoneFetch('/api/kiosk/qr/tablets');
      if (r.status !== 200) { setListError(typeof r.body?.error === 'string' ? r.body.error : 'Please try again in a moment.'); return; }
      setListError(null);
      setTablets(parseTablets(r.body));
    } catch {
      setListError('Please try again in a moment.');
    }
  };
  useEffect(() => { if (open) { setTablets(null); void loadTablets(); } }, [open]);

  // The camera, only while the scan view is showing.
  useEffect(() => {
    if (!open || view !== 'scan') return;
    let live = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let origins: string[] = [];
    let hintTimer: ReturnType<typeof setTimeout> | null = null;
    setCamera('starting');
    setHint(null);
    const detector = makeDetector();
    (async () => {
      origins = await loadAppOrigins();
      if (!live) return;
      if (!detector || !navigator.mediaDevices?.getUserMedia) { setCamera('off'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        if (live) setCamera('off');
        return;
      }
      if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      try { await v.play(); } catch { /* autoplay muted inline normally works */ }
      if (!live) return;
      setCamera('on');
      const tick = async () => {
        if (!live) return;
        try {
          if (v.readyState >= 2) {
            const found = await detector.detect(v);
            if (!live) return;
            for (const f of found) {
              const link = kqrLinkFromScan(f.rawValue, origins);
              if (link && wasJustRefused(link.code)) {
                setHint(T.scanOldCode);
                if (hintTimer) clearTimeout(hintTimer);
                hintTimer = setTimeout(() => { if (live) setHint(null); }, 3000);
                continue;
              }
              if (link) {
                live = false;
                stream?.getTracks().forEach((t) => t.stop());
                if (link.origin === window.location.origin) cbRef.current.onScanned(link.code);
                else window.location.assign(`${link.origin}/k/${link.code}`);
                return;
              }
              if (f.rawValue) {
                setHint(T.scanNotOurs);
                if (hintTimer) clearTimeout(hintTimer);
                hintTimer = setTimeout(() => { if (live) setHint(null); }, 3000);
              }
            }
          }
        } catch { /* a frame that could not be read */ }
        if (live) timer = setTimeout(tick, 250);
      };
      void tick();
    })();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (hintTimer) clearTimeout(hintTimer);
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [open, view]);

  if (!open) return null;

  const signOut = async (ref: string) => {
    setBusyRef(ref);
    try {
      const r = await kqrPhoneFetch('/api/kiosk/qr/tablets/signout', { method: 'POST', body: { ref } });
      if (r.status !== 200 && r.status !== 404) setListError(typeof r.body?.error === 'string' ? r.body.error : 'Please try again in a moment.');
    } catch {
      setListError('Please try again in a moment.');
    } finally {
      setBusyRef(null);
      await loadTablets();
    }
  };

  if (view === 'tablets') {
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="kqr-tablets-title" data-kqr-tablets className="fixed inset-0 z-[70] bg-paper text-ink flex flex-col overflow-y-auto">
        <div className="flex items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2">
          <button type="button" onClick={() => (startOn === 'tablets' ? onClose() : setView('scan'))} aria-label="Back" className="min-w-11 min-h-11 flex items-center justify-center rounded-full hover:bg-sunken">
            <ChevronLeft className="w-6 h-6" />
          </button>
        </div>
        <div className="px-5 pb-10 max-w-lg w-full mx-auto">
          <h1 id="kqr-tablets-title" className="text-[26px] leading-tight font-bold">{T.tabletsTitle}</h1>
          <p className="mt-2 text-[15px] text-ink-soft">{T.tabletsIntro}</p>
          {listError && <p role="alert" className="mt-4 text-sm font-semibold text-bad">{listError}</p>}
          <ul className="mt-5 space-y-3">
            {tablets === null ? (
              <li className="text-ink-soft text-sm animate-pulse">Loading…</li>
            ) : tablets.length === 0 ? (
              <li data-kqr-tablets-none className="text-ink-soft text-[15px]">{T.tabletsNone}</li>
            ) : tablets.map((t) => (
              <li key={t.ref} data-kqr-tablet-row className="rounded-2xl bg-surface border border-line p-4 e1">
                <div className="flex items-start gap-3">
                  <span className="w-10 h-10 rounded-xl bg-gold-wash text-gold-ink flex items-center justify-center shrink-0"><Tablet className="w-5 h-5" aria-hidden /></span>
                  <div className="flex-1 min-w-0">
                    <p dir="auto" className="font-semibold text-[16px] truncate">{t.tabletName || 'Tablet'}</p>
                    {kqrTabletLines(t).map((line, i) => (
                      i === 0 && (!t.agencyName || t.venueName) ? (
                        <p key={i} dir="auto" className="text-sm text-ink-soft truncate">{line}</p>
                      ) : (
                        <p key={i} dir="auto" data-kqr-tablet-agency className="text-sm text-ink-soft line-clamp-2 break-words">{line}</p>
                      )
                    ))}
                  </div>
                  <button type="button" data-kqr-signout disabled={busyRef === t.ref} onClick={() => void signOut(t.ref)}
                    className="min-h-11 px-4 rounded-full border border-line-strong text-sm font-semibold text-bad bg-surface pressable disabled:opacity-50">
                    {T.signOut}
                  </button>
                </div>
                <p className="mt-2 text-[13px] text-ink-faint">{T.since(clockText(t.sinceMs), clockText(t.endsAtMs))}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[13px] text-ink-faint">{T.tabletsFoot}</p>
        </div>
      </div>
    );
  }

  const count = tablets ? tablets.length : null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="kqr-scan-title" data-kqr-scanner={camera} className="fixed inset-0 z-[70] bg-[#0f0b08] text-white flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <button type="button" onClick={onClose} aria-label="Close" className="min-w-11 min-h-11 flex items-center justify-center rounded-full hover:bg-white/10">
          <X className="w-6 h-6" />
        </button>
        <h1 id="kqr-scan-title" className="text-[17px] font-semibold">{T.scanTitle}</h1>
        <span className="min-w-11" />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="relative w-[280px] h-[280px] max-w-full rounded-[28px] overflow-hidden bg-black/60">
          <video ref={videoRef} muted playsInline className={`absolute inset-0 w-full h-full object-cover ${camera === 'on' ? '' : 'hidden'}`} />
          {camera === 'off' && (
            <p data-kqr-no-camera className="absolute inset-0 flex items-center justify-center text-center px-6 text-[15px] leading-relaxed text-white/80">{T.scanNoCamera}</p>
          )}
          {(['top-0 left-0 border-t-4 border-l-4 rounded-tl-[28px]', 'top-0 right-0 border-t-4 border-r-4 rounded-tr-[28px]', 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-[28px]', 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-[28px]'] as const).map((c) => (
            <span key={c} aria-hidden className={`absolute w-12 h-12 border-[#f0be6b] ${c}`} />
          ))}
        </div>
        <p className="mt-6 text-center text-[19px] font-semibold max-w-[300px]">{T.scanPoint}</p>
        <p role="status" className="mt-2 min-h-6 text-center text-sm font-semibold text-[#f0be6b]">{hint || ''}</p>
        {camera !== 'off' && <p className="mt-4 text-center text-sm leading-relaxed text-white/65 max-w-[300px]">{T.scanTip}</p>}
      </div>
      <button type="button" data-kqr-open-tablets onClick={() => setView('tablets')}
        className="mx-4 mb-[max(16px,env(safe-area-inset-bottom))] min-h-14 px-4 rounded-2xl bg-white/10 border border-white/10 flex items-center gap-3 text-left pressable">
        <Tablet className="w-5 h-5 text-[#f0be6b] shrink-0" aria-hidden />
        <span className="flex-1 font-semibold">{T.tabletsLink}{count !== null ? ` · ${count}` : ''}</span>
        <ChevronRight className="w-5 h-5 text-white/60" aria-hidden />
      </button>
    </div>
  );
}
