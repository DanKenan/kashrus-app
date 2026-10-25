import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Tablet } from 'lucide-react';
import type { User } from '../types';
import { getSessionToken, isCookieSession, syncCookieSession } from '../lib/api';
import { KQR_UI_TEXT as T, clearPendingKqr, clockText, kqrErrorFor, kqrPhoneFetch, markRefusedKqr, type KqrError } from '../lib/kioskQr';

/** The phone asks how the tablet is doing about once a second; the tablet has 30 s to open (server C2). */
export const KQR_APPROVAL_POLL_MS = 1000;
export const KQR_APPROVAL_GIVE_UP_MS = 40000;
/** A new sign-in moves to the sign-in cookie first (the server approves on the cookie only). */
export const KQR_COOKIE_WAIT_MS = 15000;

type TabletInfo = { name: string; venueName: string; agencyName: string };
type Phase =
  | { kind: 'starting' }
  | { kind: 'signing'; tablet: TabletInfo }
  | { kind: 'done'; tablet: TabletInfo; endsAtMs: number }
  | { kind: 'ended'; tablet: TabletInfo }
  | { kind: 'error'; error: KqrError; tablet?: TabletInfo };

interface KioskQrPhoneProps {
  code: string | null;
  user: User;
  /** The agency name to show before the server names the tablet's (this address's agency, or the person's). */
  agencyName: string;
  onLeave: () => void;
  onScanAgain: () => void;
}

const DARK_BG = 'radial-gradient(120% 70% at 50% 0%, #33241a 0%, #1b130c 55%, #140e09 100%)';
const SERIF = '"Shutfey Home Serif", Georgia, "Times New Roman", serif';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const str = (x: unknown) => (typeof x === 'string' ? x.slice(0, 200) : '');

/**
 * The page a tablet's code opens on a signed-in phone (/k/<code>). Scan =
 * approve (Don, Oct 24): no button to press. It shows "Signing in to the
 * <venue> tablet…", then "You're signed in", or the server's reason.
 */
export function KioskQrPhone({ code, user, agencyName, onLeave, onScanAgain }: KioskQrPhoneProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const userId = user.id;
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;

  useEffect(() => {
    let live = true;
    const fail = (error: KqrError, tablet?: TabletInfo) => {
      if (!live) return;
      if (error.again === 'scan') markRefusedKqr(code);
      setPhase({ kind: 'error', error, tablet });
    };
    (async () => {
      setPhase({ kind: 'starting' });
      if (!code) return fail(kqrErrorFor(404, { code: 'KIOSK_QR_UNUSABLE' }));
      // The approve is accepted on the sign-in cookie only: wait for a new sign-in to move there.
      const until = Date.now() + KQR_COOKIE_WAIT_MS;
      for (;;) {
        await syncCookieSession();
        if (!live) return;
        if (isCookieSession() && !getSessionToken()) break;
        if (Date.now() >= until) return fail(kqrErrorFor(503, {}));
        await sleep(1000);
        if (!live) return;
      }
      let a: { status: number; body: any };
      try {
        a = await kqrPhoneFetch('/api/kiosk/qr/approve', { method: 'POST', body: { code } });
      } catch {
        return fail(kqrErrorFor(503, {}));
      }
      if (!live) return;
      if (a.status !== 200 || typeof a.body?.approvalId !== 'string') {
        // (A 401 was already checked with GET /api/auth/me in kqrPhoneFetch: signed out for real ->
        // the sign-in page, which comes back here with the code.)
        const err = kqrErrorFor(a.status, a.body);
        if (err.kind === 'expired' || err.kind === 'unusable' || err.kind === 'notHere') clearPendingKqr();
        return fail(err);
      }
      clearPendingKqr();
      const t = a.body.tablet || {};
      const tablet: TabletInfo = { name: str(t.name), venueName: str(t.venueName), agencyName: str(t.agencyName) };
      setPhase({ kind: 'signing', tablet });
      const id = a.body.approvalId as string;
      const giveUp = Date.now() + KQR_APPROVAL_GIVE_UP_MS;
      while (live && Date.now() < giveUp) {
        await sleep(KQR_APPROVAL_POLL_MS);
        if (!live) return;
        let p: { status: number; body: any };
        try { p = await kqrPhoneFetch(`/api/kiosk/qr/approval/${encodeURIComponent(id)}`); } catch { continue; }
        if (!live) return;
        if (p.status === 200) {
          const st = p.body?.state;
          if (st === 'waiting') continue;
          if (st === 'done') return setPhase({ kind: 'done', tablet, endsAtMs: typeof p.body.endsAtMs === 'number' ? p.body.endsAtMs : 0 });
          if (st === 'ended') return setPhase({ kind: 'ended', tablet });
          return fail({ kind: 'notOpened', title: T.notOpenedTitle, body: T.notOpenedBody, again: 'scan' }, tablet);
        }
        if (p.status === 404) return fail({ kind: 'notOpened', title: T.notOpenedTitle, body: T.notOpenedBody, again: 'scan' }, tablet);
        if (p.status === 401) return fail(kqrErrorFor(401, p.body), tablet);
        // 429 / 503 / anything else: ask again until the give-up time.
      }
      if (live) fail({ kind: 'notOpened', title: T.notOpenedTitle, body: T.notOpenedBody, again: 'scan' }, tablet);
    })();
    return () => { live = false; };
  }, [code, userId, attempt]);

  const tablet = phase.kind === 'starting' ? null : phase.tablet || null;
  const brand = tablet?.agencyName || agencyName || 'Shutfey';
  const pill = 'w-full h-14 rounded-full font-bold text-[17px] text-[#22170d] flex items-center justify-center pressable';
  const pillStyle = { background: 'linear-gradient(180deg,#f0be6b,#dd9d3e)', boxShadow: '0 8px 22px rgba(224,166,75,.3), inset 0 1px 0 rgba(255,255,255,.5)' };

  return (
    <div data-kqr-phone={phase.kind} className="relative min-h-screen w-full overflow-hidden flex flex-col items-center text-white px-6" style={{ background: DARK_BG }}>
      <div aria-hidden className="pointer-events-none absolute rounded-full" style={{ width: 420, height: 420, top: -220, left: '50%', transform: 'translateX(-50%)', background: 'rgba(224,166,75,.16)', filter: 'blur(80px)' }} />
      <p className="relative z-10 mt-14 text-center text-[22px] leading-tight font-semibold max-w-[260px]" style={{ fontFamily: SERIF }}>{brand}</p>
      <div className="relative z-10 flex-1 w-full max-w-sm flex flex-col justify-center pb-16">
        {phase.kind === 'starting' || phase.kind === 'signing' ? (
          <div role="status" aria-live="polite">
            <div className="mx-auto w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-[#f0be6b]" aria-hidden />
            </div>
            <h1 data-kqr-title className="mt-6 text-center text-[28px] leading-[1.15] font-semibold" style={{ fontFamily: SERIF }}>
              {T.signingIn(phase.kind === 'signing' ? phase.tablet.venueName : '')}
            </h1>
            <p className="mt-3 text-center text-base text-white/70">{T.lookAtTablet}</p>
            {phase.kind === 'signing' && (
              <dl className="mt-8 rounded-2xl bg-white/[.06] border border-white/10 divide-y divide-white/10 text-[15px]">
                {([[T.rowTablet, phase.tablet.name], [T.rowVenue, phase.tablet.venueName], [T.rowAgency, phase.tablet.agencyName], [T.rowYou, user.name]] as const)
                  .filter(([, v]) => !!v)
                  .map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 px-4 py-3">
                      <dt className="text-white/60">{k}</dt>
                      <dd dir="auto" className="font-semibold text-right truncate">{v}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </div>
        ) : phase.kind === 'done' || phase.kind === 'ended' ? (
          <div role="status">
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-400/15 flex items-center justify-center">
              {phase.kind === 'done' ? <CheckCircle2 className="w-9 h-9 text-emerald-300" aria-hidden /> : <Tablet className="w-8 h-8 text-white/80" aria-hidden />}
            </div>
            <h1 data-kqr-title className="mt-6 text-center text-[28px] leading-[1.15] font-semibold" style={{ fontFamily: SERIF }}>
              {phase.kind === 'done' ? T.doneTitle(phase.tablet.venueName) : T.endedTitle(phase.tablet.venueName)}
            </h1>
            <p className="mt-3 text-center text-base leading-relaxed text-white/75">
              {phase.kind === 'done' ? T.doneBody(clockText(phase.endsAtMs)) : T.endedBody}
            </p>
            <button type="button" data-kqr-ok onClick={() => leaveRef.current()} className={`mt-10 ${pill}`} style={pillStyle}>{T.ok}</button>
          </div>
        ) : (
          <div role="alert">
            <div className="mx-auto w-16 h-16 rounded-full bg-red-400/15 flex items-center justify-center">
              <AlertCircle className="w-9 h-9 text-red-300" aria-hidden />
            </div>
            <h1 data-kqr-title data-kqr-error={phase.error.kind} className="mt-6 text-center text-[28px] leading-[1.15] font-semibold" style={{ fontFamily: SERIF }}>{phase.error.title}</h1>
            <p className="mt-3 text-center text-base leading-relaxed text-white/75">{phase.error.body}</p>
            {phase.error.again === 'scan' ? (
              <>
                <button type="button" data-kqr-scan-again onClick={onScanAgain} className={`mt-10 ${pill}`} style={pillStyle}>{T.scanAgain}</button>
                <button type="button" onClick={() => leaveRef.current()} className="mt-3 w-full h-12 text-base text-white/70 underline underline-offset-4">{T.ok}</button>
              </>
            ) : phase.error.again === 'retry' ? (
              <>
                <button type="button" data-kqr-retry onClick={() => setAttempt((n) => n + 1)} className={`mt-10 ${pill}`} style={pillStyle}>{T.tryAgain}</button>
                <button type="button" onClick={() => leaveRef.current()} className="mt-3 w-full h-12 text-base text-white/70 underline underline-offset-4">{T.ok}</button>
              </>
            ) : (
              <button type="button" data-kqr-ok onClick={() => leaveRef.current()} className={`mt-10 ${pill}`} style={pillStyle}>{T.ok}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
