import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, RefreshCw, Tablet } from 'lucide-react';
import type { User } from '../types';
import { apiFetch, endUnusedKioskSignIn, noteServerCookieSignIn, setSessionToken, signOutsSettled, trackCookieSignInRequest } from '../lib/api';
import { makeQr, qrPath } from '../lib/qrEncode';
import { KQR_UI_TEXT as T, countdownText } from '../lib/kioskQr';
import { useSite, useSiteLogo } from '../lib/site';
import { ShutfeyLogo } from './ShutfeyLogo';

/** The tablet asks again about every 2 s (server limit: 120 a minute per tablet). */
export const KQR_POLL_MS = 2000;
/** "Hi Yossi – Hill Bakery" stays this long before the tablet opens (B14). */
export const KQR_WELCOME_MS = 3000;

/**
 * "Use your code instead" sends cancel and leaves this screen. A screen opened again before that
 * answer lands waits for it, so the late cancel never kills the new screen's code.
 */
let cancelInFlight: Promise<unknown> | null = null;
const CANCEL_WAIT_MAX_MS = 5000;
/** "Use your code instead" waits this long at most for a poll on its way. */
const KQR_LEAVE_WAIT_MS = 3000;

type Shown =
  | { kind: 'loading' }
  | { kind: 'code'; link: string; shownAt: number; ttlMs: number }
  | { kind: 'soon' }
  | { kind: 'welcome'; firstName: string; venueName: string };

interface KioskQrScreenProps {
  /** 12a-c: one plain line (the kiosk-ended line), as on the PIN screen. */
  notice?: string | null;
  onNoticeDone?: () => void;
  onLoginSuccess: (user: User) => void;
  /** "Use your code instead": today's PIN screen. */
  onUseCode: () => void;
  /** This server has no QR sign-in (an older server): the PIN screen, as today. */
  onUnavailable: () => void;
  onUnpaired?: () => void;
  onExitKiosk: () => void;
}

const DARK_BG = 'radial-gradient(120% 70% at 50% 0%, #33241a 0%, #1b130c 55%, #140e09 100%)';
const SERIF = '"Shutfey Home Serif", Georgia, "Times New Roman", serif';

/**
 * The tablet's QR sign-in screen (Don, Oct 24 9:14 PM: the dark one). A
 * signed-in phone scans the code and the tablet opens: "Hi <first> – <venue>"
 * for 3 s, then the usual kiosk view. "Use your code instead" is today's PIN
 * sign-in, unchanged.
 */
export function KioskQrScreen({ notice, onNoticeDone, onLoginSuccess, onUseCode, onUnavailable, onUnpaired, onExitKiosk }: KioskQrScreenProps) {
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [line, setLine] = useState<string | null>(null);
  const [device, setDevice] = useState<{ name: string; venueName: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const site = useSite();
  const siteAgency = site?.site === 'agency' ? site.agency : null;
  const logo = useSiteLogo(siteAgency?.logoRev);

  const cb = useRef({ onLoginSuccess, onUnavailable, onUnpaired });
  cb.current = { onLoginSuccess, onUnavailable, onUnpaired };
  // The start/poll on its way (its answer can sign the tablet in), "Use your code instead" pressed,
  // and a sign-in this screen took (the welcome is showing).
  const inflight = useRef<Promise<unknown> | null>(null);
  const leaving = useRef(false);
  const claimed = useRef(false);

  // The tablet's name and venue (the same call the PIN screen makes).
  useEffect(() => {
    let live = true;
    apiFetch('/api/kiosk/device')
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) {
          if (d.code === 'KIOSK_UNPAIRED') cb.current.onUnpaired?.();
          return;
        }
        setDevice({ name: String(d.device?.name || ''), venueName: String(d.device?.venueName || '') });
      })
      .catch(() => { /* names stay blank; the code still works */ });
    return () => { live = false; };
  }, []);

  // start once, then poll: the current code, its rotation, and the sign-in.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastLink: string | null = null;
    // When the code on screen was issued: a poll keeps it only while it names the same code.
    let lastIssuedAt: number | null = null;
    let lastRestartAt = 0;
    let lineTimer: ReturnType<typeof setTimeout> | null = null;
    const later = (ms: number, first: boolean) => {
      if (!live || leaving.current) return;
      timer = setTimeout(() => void step(first), ms);
    };
    const step = async (first: boolean) => {
      if (!live || leaving.current) return;
      if (first && cancelInFlight) {
        await Promise.race([cancelInFlight, new Promise((res) => setTimeout(res, CANCEL_WAIT_MAX_MS))]);
        if (!live || leaving.current) return;
      }
      // A sign-out still on its way deletes this browser's sign-in cookie when its answer lands:
      // no request that can sign the tablet in until it has.
      if (!(await signOutsSettled(KQR_POLL_MS))) return later(KQR_POLL_MS, first);
      if (!live || leaving.current) return;
      const sent = apiFetch(first ? '/api/kiosk/qr/start' : '/api/kiosk/qr/poll', { method: 'POST' }).then(async (res) => ({ res, body: (await res.json().catch(() => ({}))) as any }));
      // Its answer can sign the tablet in. If it does after this screen is gone, nobody uses that
      // sign-in: end it before anything else may sign in (tracked until then).
      const settled = trackCookieSignInRequest(
        sent.then(async ({ res, body }) => {
          if (!live && res.ok && body?.state === 'signed-in') await endUnusedKioskSignIn(typeof body.token === 'string' && body.token ? body.token : null);
        }).catch(() => {})
      );
      inflight.current = settled;
      let r: Response;
      let d: any;
      try {
        ({ res: r, body: d } = await sent);
      } catch {
        return later(KQR_POLL_MS * 2, first);
      }
      if (!live) return;
      if (!r.ok) {
        if (r.status === 404 && !d.code) { cb.current.onUnavailable(); return; }
        if (d.code === 'KIOSK_UNPAIRED') { cb.current.onUnpaired?.(); return; }
        const retry = Number(r.headers.get('Retry-After'));
        return later(r.status === 429 && retry > 0 ? Math.min(retry, 60) * 1000 : KQR_POLL_MS * 2, first);
      }
      if (d.state === 'signed-in' && d.user) {
        claimed.current = true;
        // A tablet paired with the device cookie gets the sign-in cookie from this answer (no token):
        // this device is now signed in on the cookie, like a sign-in moved there.
        if (typeof d.token === 'string' && d.token) setSessionToken(d.token);
        else noteServerCookieSignIn();
        const g = d.greeting || {};
        setShown({ kind: 'welcome', firstName: String(g.firstName || ''), venueName: String(g.venueName || '') });
        const user = d.user as User;
        timer = setTimeout(() => { if (live) cb.current.onLoginSuccess(user); }, KQR_WELCOME_MS);
        return;
      }
      if (d.state === 'waiting') {
        if (d.notFinished) {
          setLine(typeof d.message === 'string' && d.message ? d.message : "Signing you in didn't finish. Scan again.");
          if (lineTimer) clearTimeout(lineTimer);
          lineTimer = setTimeout(() => { if (live) setLine(null); }, 8000);
        }
        if (typeof d.link === 'string' && d.link) {
          if (d.link !== lastLink) {
            lastLink = d.link;
            lastIssuedAt = typeof d.codeIssuedAtMs === 'number' ? d.codeIssuedAtMs : null;
            const ttl = typeof d.expiresAtMs === 'number' && typeof d.codeIssuedAtMs === 'number' ? Math.max(1000, Math.min(120000, d.expiresAtMs - d.codeIssuedAtMs)) : 60000;
            setShown({ kind: 'code', link: d.link, shownAt: Date.now(), ttlMs: ttl });
          }
          return later(KQR_POLL_MS, false);
        }
        // The server keeps only a hash of the code: a poll while the code on screen is still live
        // answers without the link (just its times). Keep showing it.
        if (lastLink && typeof d.codeIssuedAtMs === 'number' && d.codeIssuedAtMs === lastIssuedAt && d.retryInMs === undefined) return later(KQR_POLL_MS, false);
        // A newer code than the one on screen (issued by a call this screen did not make): the one
        // shown is dead and the new one can't be shown, so ask for a fresh one (at most every 10 s).
        if (typeof d.codeIssuedAtMs === 'number' && d.codeIssuedAtMs !== lastIssuedAt && d.retryInMs === undefined && Date.now() - lastRestartAt > 10000) {
          lastRestartAt = Date.now();
          lastLink = null;
          lastIssuedAt = null;
          setShown({ kind: 'soon' });
          return later(0, true);
        }
        lastLink = null;
        lastIssuedAt = null;
        setShown({ kind: 'soon' });
        const wait = typeof d.retryInMs === 'number' && d.retryInMs > 0 ? Math.min(d.retryInMs, 30000) : KQR_POLL_MS;
        // A code the server could not issue yet comes on a later poll.
        return later(Math.max(wait, KQR_POLL_MS), false);
      }
      return later(KQR_POLL_MS, false);
    };
    void step(true);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (lineTimer) clearTimeout(lineTimer);
    };
  }, []);

  // The countdown.
  useEffect(() => {
    if (shown.kind !== 'code') return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [shown.kind]);

  // 12a-c: the notice goes after a while, as on the PIN screen.
  const onNoticeDoneRef = useRef(onNoticeDone);
  onNoticeDoneRef.current = onNoticeDone;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => onNoticeDoneRef.current?.(), 20000);
    return () => clearTimeout(t);
  }, [notice]);

  const qr = useMemo(() => {
    if (shown.kind !== 'code') return null;
    try {
      const m = makeQr(shown.link);
      return { d: qrPath(m, 4), n: m.length + 8 };
    } catch {
      return null;
    }
  }, [shown.kind === 'code' ? shown.link : null]);

  const useCode = async () => {
    if (leaving.current) return;
    leaving.current = true;
    // A poll on its way may already carry a sign-in (someone scanned just now): let it land first.
    // If it signed the tablet in, the welcome goes on for that person; else the PIN screen.
    if (inflight.current) await Promise.race([inflight.current, new Promise((res) => setTimeout(res, KQR_LEAVE_WAIT_MS))]);
    if (claimed.current) return;
    // The code on screen dies with this (a phone that scans it now is told so).
    const p: Promise<unknown> = apiFetch('/api/kiosk/qr/cancel', { method: 'POST' })
      .then((r) => r.text().catch(() => ''))
      .catch(() => {})
      .finally(() => { if (cancelInFlight === p) cancelInFlight = null; });
    cancelInFlight = p;
    onUseCode();
  };

  // Hidden exit, as on the PIN screen: tap the logo 5 times.
  const taps = useRef({ count: 0, firstAt: 0 });
  const tapLogo = () => {
    const t = Date.now();
    if (t - taps.current.firstAt > 3000) taps.current = { count: 1, firstAt: t };
    else taps.current.count += 1;
    if (taps.current.count >= 5) {
      taps.current = { count: 0, firstAt: 0 };
      if (window.confirm('Exit kiosk mode?')) onExitKiosk();
    }
  };

  const agencyName = siteAgency ? (siteAgency.brandName || siteAgency.name) : '';
  const venueName = device?.venueName || '';
  const left = shown.kind === 'code' ? Math.max(0, shown.shownAt + shown.ttlMs - now) : 0;
  const frac = shown.kind === 'code' ? Math.max(0, Math.min(1, left / shown.ttlMs)) : 0;

  return (
    <div data-kiosk="qr" data-kqr-state={shown.kind} className="dark-tablet relative min-h-screen w-full overflow-hidden flex flex-col items-center text-white" style={{ background: DARK_BG }}>
      <div aria-hidden className="pointer-events-none absolute rounded-full" style={{ width: 520, height: 520, top: -220, left: '50%', transform: 'translateX(-50%)', background: 'rgba(224,166,75,.16)', filter: 'blur(80px)' }} />
      <div aria-hidden className="pointer-events-none absolute rounded-full" style={{ width: 420, height: 420, bottom: -200, right: -120, background: 'rgba(224,166,75,.07)', filter: 'blur(80px)' }} />

      <header className="relative z-10 w-full flex items-center justify-between gap-4 px-6 sm:px-10 pt-6">
        <button type="button" onClick={tapLogo} aria-label="Shutfey logo" className="cursor-default flex items-center gap-3 min-h-11 text-left">
          {siteAgency ? (
            <>
              {logo ? <img src={logo} alt="" className="h-[52px] w-auto rounded-md bg-white/95 p-0.5" /> : null}
              <span className="flex flex-col">
                <span data-kqr-agency className="text-[22px] leading-tight font-semibold" style={{ fontFamily: SERIF }}>{agencyName}</span>
                <span className="text-sm text-white/70 mt-0.5">{siteAgency.shortCode ? `${siteAgency.shortCode} · ` : ''}{T.staffSignIn}</span>
              </span>
            </>
          ) : (
            <>
              <span className="rounded-xl bg-white/95 px-2 py-1"><ShutfeyLogo size="md" showSubtitle={false} darkMode={false} /></span>
              <span className="text-sm text-white/70">{T.staffSignIn}</span>
            </>
          )}
        </button>
        {device?.name ? (
          <span className="flex items-center gap-2 text-[15px] text-white/70 min-w-0">
            <Tablet className="w-[18px] h-[18px] shrink-0" aria-hidden />
            <span data-kqr-tablet className="truncate max-w-[40vw]">{device.name}</span>
          </span>
        ) : null}
      </header>

      <main className="relative z-10 flex-1 w-full flex flex-col items-center justify-center px-6 py-6">
        {shown.kind === 'welcome' ? (
          <div data-kqr-welcome className="text-center" role="status">
            <h1 dir="auto" className="text-[56px] leading-[1.1] font-semibold" style={{ fontFamily: SERIF }}>{T.hi(shown.firstName, shown.venueName)}</h1>
            <p className="mt-4 text-k-body text-white/75 animate-pulse">{T.opening}</p>
          </div>
        ) : (
          <>
            {notice && (
              <p data-kiosk-notice role="status" className="mb-5 max-w-xl w-full px-5 py-4 rounded-2xl bg-white/10 border border-white/20 text-center text-k-body font-semibold">
                {notice}
              </p>
            )}
            <div className="w-full max-w-[900px] rounded-[28px] bg-white text-ink border border-white/10 flex flex-col md:flex-row items-center gap-8 md:gap-12 px-8 md:px-12 py-9 md:py-11"
              style={{ boxShadow: '0 30px 80px -24px rgba(0,0,0,.65)' }}>
              <div className="flex-1 min-w-0">
                {venueName ? <p dir="auto" className="text-xs font-bold tracking-[.06em] uppercase text-ink-faint">{venueName}</p> : null}
                <h1 className="mt-2 text-[44px] leading-[1.08] font-semibold" style={{ fontFamily: SERIF }}>{T.tabletTitle}</h1>
                <ol className="mt-2">
                  {[T.step1, null, T.step3].map((s, i) => (
                    <li key={i} className="flex items-start gap-3.5 mt-4">
                      <span aria-hidden className="w-[34px] h-[34px] rounded-full bg-gold-wash text-gold-ink font-extrabold flex items-center justify-center text-[17px] shrink-0">{i + 1}</span>
                      <span className="text-[19px] leading-[1.35] pt-1">{s ?? <>Tap <b>{T.menuRow}</b></>}</span>
                    </li>
                  ))}
                </ol>
                {line && <p data-kqr-line role="alert" className="mt-5 text-base font-semibold text-bad">{line}</p>}
              </div>
              <div className="flex flex-col items-center shrink-0">
                <div className="p-[18px] rounded-[22px] border border-line bg-white">
                  {qr ? (
                    <svg data-kqr-code width="270" height="270" viewBox={`0 0 ${qr.n} ${qr.n}`} role="img" aria-label="Sign-in code" shapeRendering="crispEdges">
                      <rect width={qr.n} height={qr.n} fill="#fff" />
                      <path d={qr.d} fill="#000" />
                    </svg>
                  ) : (
                    <div className="w-[270px] h-[270px] flex items-center justify-center text-ink-soft text-base text-center px-6">
                      {shown.kind === 'soon' ? T.newCodeSoon : 'Loading…'}
                    </div>
                  )}
                </div>
                <div className="w-[306px] h-1.5 rounded-full bg-sunken mt-4 overflow-hidden" aria-hidden>
                  <div className="h-full" style={{ width: `${Math.round(frac * 100)}%`, background: 'linear-gradient(90deg,#f0be6b,#dd9d3e)', transition: 'width 250ms linear' }} />
                </div>
                <p className="mt-2.5 flex items-center gap-1.5 text-base text-ink-soft">
                  <RefreshCw className="w-4 h-4" aria-hidden />
                  {shown.kind === 'code' ? <span data-kqr-countdown>{T.newCodeIn} <b className="text-ink tnum">{countdownText(left)}</b></span> : <span>{T.newCodeSoon}</span>}
                </p>
              </div>
            </div>
            <button type="button" data-kqr-use-code onClick={useCode}
              className="mt-7 h-[60px] px-[30px] inline-flex items-center gap-2.5 rounded-full border-[1.5px] border-white/30 bg-white/5 text-[19px] font-semibold text-white pressable">
              <KeyRound className="w-5 h-5" aria-hidden />
              {T.useCode}
            </button>
          </>
        )}
      </main>

      <footer className="relative z-10 pb-5 text-[13px] text-white/45 flex items-center gap-1.5">
        {T.poweredBy} <span className="font-semibold text-white/60">Shutfey</span>
      </footer>
    </div>
  );
}
