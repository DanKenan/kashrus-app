import { useState, useEffect, useRef } from 'react';
import { AlertCircle, Delete, LogIn } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import type { User } from '../types';
import { apiFetch, setSessionToken } from '../lib/api';

interface KioskStaff {
  id: string;
  name: string;
  avatarColor?: string;
  role: string;
}

interface KioskLoginProps {
  /** 12a-c: one plain line over the name list (the kiosk-ended line from END_DATE_TEXT). */
  notice?: string | null;
  onNoticeDone?: () => void;
  onLoginSuccess: (user: User) => void;
  onExitKiosk: () => void;
  onUnpaired?: () => void;
  darkMode: boolean;
}

/**
 * KioskLogin — the shared-tablet login screen.
 * Hung on a wall in the establishment: pick your name, punch in your
 * 4-6 digit code, and you're in. Big targets, no typing, no passwords.
 */
export function KioskLogin({ notice, onNoticeDone, onLoginSuccess, onExitKiosk, onUnpaired, darkMode }: KioskLoginProps) {
  const [venueName, setVenueName] = useState('Loading…');
  const [staff, setStaff] = useState<KioskStaff[]>([]);
  const [selected, setSelected] = useState<KioskStaff | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // The parent passes onUnpaired as an inline arrow — a new function on
  // every render. Keep the latest callback in a ref so the load effect
  // below runs ONCE per mount; with the callback in its deps, every
  // parent re-render (on an unauthenticated tablet, every realtime
  // socket status flip) would re-fetch the device and roster.
  const onUnpairedRef = useRef(onUnpaired);
  useEffect(() => {
    onUnpairedRef.current = onUnpaired;
  }, [onUnpaired]);

  useEffect(() => {
    let cancelled = false;
    // The tablet is paired to exactly one venue: the server returns that
    // venue's name and its PIN-enabled staff for the device credential.
    apiFetch('/api/kiosk/device')
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          if (d.code === 'KIOSK_UNPAIRED') {
            onUnpairedRef.current?.();
            return;
          }
          throw new Error(d.error || 'Could not load this tablet.');
        }
        setVenueName(d.device?.venueName || 'Kiosk');
        setStaff(Array.isArray(d.users) ? d.users : []);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setVenueName('Kiosk');
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pressDigit = (d: string) => {
    setError('');
    if (pin.length < 6) setPin(pin + d);
  };

  const backspace = () => {
    setError('');
    setPin(pin.slice(0, -1));
  };

  const submit = async () => {
    if (!selected || pin.length < 4 || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/kiosk/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selected.id, pin }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Wrong code. Try again.');
      if (d.token) setSessionToken(d.token);
      onLoginSuccess(d.user);
    } catch (e: any) {
      setError(e.message || 'Wrong code. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  // 12a-c: the notice stays a short while, and goes when the next person taps their name.
  const onNoticeDoneRef = useRef(onNoticeDone);
  onNoticeDoneRef.current = onNoticeDone;
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => onNoticeDoneRef.current?.(), 20000);
    return () => clearTimeout(t);
  }, [notice]);

  const pickStaff = (s: KioskStaff) => {
    if (notice) onNoticeDone?.();
    setSelected(s);
    setPin('');
    setError('');
  };

  // Hidden exit: tap the logo 5 times to leave kiosk mode.
  // No visible button — this tablet is meant to stay locked.
  const logoTaps = useRef<{ count: number; firstAt: number }>({ count: 0, firstAt: 0 });
  const handleLogoTap = () => {
    const now = Date.now();
    if (now - logoTaps.current.firstAt > 3000) {
      logoTaps.current = { count: 1, firstAt: now };
    } else {
      logoTaps.current.count += 1;
    }
    if (logoTaps.current.count >= 5) {
      logoTaps.current = { count: 0, firstAt: 0 };
      if (window.confirm('Exit kiosk mode?')) onExitKiosk();
    }
  };

  // Presentation only: avatar letters. One letter, or two when another
  // person on this tablet starts with the same letter ("MF" / "MO").
  const initialsFor = (s: KioskStaff) => {
    const name = s.name.trim();
    const first = name.charAt(0).toUpperCase();
    const clash = staff.some((o) => o.id !== s.id && o.name.trim().charAt(0).toUpperCase() === first);
    if (!clash) return first;
    const words = name.split(/\s+/);
    const second = words.length > 1 ? words[words.length - 1].charAt(0) : name.charAt(1);
    return (first + second).toUpperCase();
  };

  // Quiet Workstation look (D3a). Kiosk floor: text 20 (labels 16), targets
  // 64 px from 640 px up, 44 px on a phone-width screen.
  return (
    <div
      data-kiosk={!loaded || !selected ? 'locked' : 'pin'}
      className="min-h-screen bg-paper text-ink flex flex-col items-center px-4 sm:px-8 py-4 sm:py-6 transition-colors"
    >
      <div className="w-full max-w-5xl flex flex-col items-center text-center">
        <button
          onClick={handleLogoTap}
          aria-label="Shutfey logo"
          className="cursor-default min-h-11 sm:min-h-16 min-w-16 px-2 flex items-center justify-center"
        >
          <ShutfeyLogo size="lg" showSubtitle={false} darkMode={darkMode} />
        </button>
        <p className="mt-2 text-base font-medium text-ink-soft">Staff sign-in</p>
        <h1
          dir="auto"
          className="mt-1 max-w-3xl text-[28px] leading-9 sm:text-k-display font-bold line-clamp-2 break-words"
        >
          {venueName}
        </h1>
      </div>

      {!loaded ? (
        <p className="mt-16 text-k-body text-ink-soft animate-pulse">Loading…</p>
      ) : !selected ? (
        <div className="mt-6 sm:mt-8 w-full max-w-5xl flex flex-col gap-4">
          {notice && (
            <p data-kiosk-notice role="status"
              className="mx-auto max-w-xl w-full px-5 py-4 rounded-2xl bg-sunken border border-line text-center text-k-body font-semibold text-ink">
              {notice}
            </p>
          )}
          <p className="text-center text-k-body text-ink-soft">Tap your name</p>
          {staff.length === 0 && (
            <p className="text-center text-base text-ink-soft max-w-xl mx-auto">
              No sign-in codes set up yet. Ask your administrator to add a kiosk code for each person who signs in here.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {staff.map((s) => (
              <button
                key={s.id}
                data-kiosk-staff
                onClick={() => pickStaff(s)}
                className="pressable e1 bg-surface border border-line hover:border-line-strong rounded-2xl min-h-16 px-4 py-3 flex items-center gap-4 text-left"
              >
                <span
                  aria-hidden
                  className="w-14 h-14 rounded-full flex items-center justify-center text-[22px] font-bold shrink-0"
                  style={{
                    backgroundColor: s.avatarColor || 'var(--avatar-fallback)',
                    color: s.avatarColor ? '#fff' : 'var(--paper)',
                  }}
                >
                  {initialsFor(s)}
                </span>
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block text-k-body font-semibold line-clamp-2 break-words">{s.name}</span>
                  <span className="block text-base text-ink-soft capitalize">{s.role}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex justify-center">
            <button
              onClick={onExitKiosk}
              className="mt-2 min-h-11 sm:min-h-16 px-6 text-base text-ink-soft underline underline-offset-4"
            >
              ← Back to regular sign-in
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 sm:mt-6 w-full max-w-4xl flex flex-col lg:flex-row lg:items-center lg:justify-center gap-6 lg:gap-16">
          <div className="flex flex-col items-center text-center lg:w-80 shrink-0">
            <button
              onClick={() => { setSelected(null); setPin(''); setError(''); }}
              className="min-h-11 sm:min-h-16 px-4 text-base font-semibold text-gold-ink"
            >
              ← Not {selected.name}?
            </button>
            <p dir="auto" className="mt-1 text-[28px] leading-9 sm:text-k-display font-bold line-clamp-2 break-words max-w-full">{selected.name}</p>
            <p className="text-k-body text-ink-soft mt-1 mb-5">Enter your code</p>

            <div className="flex gap-3 sm:gap-4 mb-4" aria-label={`${pin.length} digits entered`}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span
                  key={i}
                  data-kiosk-dot
                  className={`w-4 h-4 sm:w-6 sm:h-6 rounded-full border-2 ${
                    i < pin.length ? 'bg-ink border-ink' : 'border-line-strong'
                  }`}
                />
              ))}
            </div>

            {error && (
              <p role="alert" className="mb-2 flex items-center justify-center gap-2 text-k-body font-semibold text-bad">
                <AlertCircle className="w-6 h-6 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 w-full max-w-sm mx-auto lg:mx-0">
            {['1','2','3','4','5','6','7','8','9'].map((d) => (
              <button
                key={d}
                data-kiosk-key
                onClick={() => pressDigit(d)}
                className="pressable e1 bg-surface border border-line rounded-2xl h-16 sm:h-20 text-k-display font-semibold tnum"
              >
                {d}
              </button>
            ))}
            <button
              data-kiosk-key
              onClick={backspace}
              className="pressable e1 bg-surface border border-line rounded-2xl h-16 sm:h-20 flex items-center justify-center"
              aria-label="Delete"
            >
              <Delete className="w-8 h-8" />
            </button>
            <button
              data-kiosk-key
              onClick={() => pressDigit('0')}
              className="pressable e1 bg-surface border border-line rounded-2xl h-16 sm:h-20 text-k-display font-semibold tnum"
            >
              0
            </button>
            <button
              data-kiosk-key
              onClick={submit}
              disabled={pin.length < 4 || busy}
              className="pressable e2 rounded-2xl h-16 sm:h-20 flex items-center justify-center gap-2 disabled:opacity-40 bg-gold-deep text-paper text-k-body font-semibold"
              aria-label="Sign in"
            >
              <LogIn className="w-7 h-7" aria-hidden />
              <span>Sign in</span>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
