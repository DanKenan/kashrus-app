import { useState, useEffect } from 'react';
import { Delete, LogIn } from 'lucide-react';
import { KeepingKosherLogo } from './KeepingKosherLogo';
import type { User } from '../types';

interface KioskStaff {
  id: string;
  name: string;
  avatarColor?: string;
  role: string;
}

interface KioskLoginProps {
  venueId: string;
  onLoginSuccess: (user: User) => void;
  onExitKiosk: () => void;
  darkMode: boolean;
}

/**
 * KioskLogin — the shared-tablet login screen.
 * Hung on a wall in the establishment: pick your name, punch in your
 * 4-6 digit code, and you're in. Big targets, no typing, no passwords.
 */
export function KioskLogin({ venueId, onLoginSuccess, onExitKiosk, darkMode }: KioskLoginProps) {
  const [venueName, setVenueName] = useState('Loading…');
  const [staff, setStaff] = useState<KioskStaff[]>([]);
  const [selected, setSelected] = useState<KioskStaff | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/kiosk/users?venueId=${encodeURIComponent(venueId)}`)
      .then((r) => r.json())
      .then((d) => {
        setVenueName(d.venueName || 'Kiosk');
        setStaff(Array.isArray(d.users) ? d.users : []);
        setLoaded(true);
      })
      .catch(() => {
        setVenueName('Kiosk');
        setLoaded(true);
      });
  }, [venueId]);

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
      const r = await fetch('/api/kiosk/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selected.id, pin }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Wrong code. Try again.');
      onLoginSuccess(d.user);
    } catch (e: any) {
      setError(e.message || 'Wrong code. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const pickStaff = (s: KioskStaff) => {
    setSelected(s);
    setPin('');
    setError('');
  };

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col items-center px-6 py-8 transition-colors">
      <KeepingKosherLogo size="md" darkMode={darkMode} />

      <div className="mt-6 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-deep">Mashgiach sign-in</p>
        <h1 className="mt-1 text-3xl font-black font-sans">{venueName}</h1>
      </div>

      {!loaded ? (
        <p className="mt-16 text-ink-soft animate-pulse">Loading…</p>
      ) : !selected ? (
        <div className="mt-10 w-full max-w-md flex flex-col gap-4">
          <p className="text-center text-ink-soft font-semibold">Tap your name</p>
          {staff.length === 0 && (
            <p className="text-center text-sm text-ink-soft">
              No sign-in codes set up yet. Ask your administrator to add a kiosk code for each mashgiach.
            </p>
          )}
          {staff.map((s) => (
            <button
              key={s.id}
              onClick={() => pickStaff(s)}
              className="tactile-4 bg-card border-2 border-line-strong rounded-3xl px-6 py-6 flex items-center gap-4 active:scale-[0.98] transition-transform text-left"
            >
              <span
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-black text-white shrink-0"
                style={{ backgroundColor: s.avatarColor || '#b45309' }}
              >
                {s.name.charAt(0).toUpperCase()}
              </span>
              <span>
                <span className="block text-xl font-extrabold font-sans">{s.name}</span>
                <span className="block text-sm text-ink-soft capitalize">{s.role}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-8 w-full max-w-xs flex flex-col items-center">
          <button
            onClick={() => { setSelected(null); setPin(''); setError(''); }}
            className="text-sm font-bold text-gold-deep mb-4"
          >
            ← Not {selected.name}?
          </button>
          <p className="text-xl font-extrabold font-sans">{selected.name}</p>
          <p className="text-sm text-ink-soft mt-1 mb-6">Enter your code</p>

          <div className="flex gap-3 mb-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span
                key={i}
                className={`w-4 h-4 rounded-full border-2 ${
                  i < pin.length ? 'bg-gold-deep border-gold-deep' : 'border-line-strong'
                }`}
              />
            ))}
          </div>

          {error && <p className="mb-4 text-sm font-bold text-red-600">{error}</p>}

          <div className="grid grid-cols-3 gap-3 w-full">
            {['1','2','3','4','5','6','7','8','9'].map((d) => (
              <button
                key={d}
                onClick={() => pressDigit(d)}
                className="tactile-4 bg-card border-2 border-line-strong rounded-2xl py-5 text-2xl font-black font-sans active:scale-95 transition-transform"
              >
                {d}
              </button>
            ))}
            <button
              onClick={backspace}
              className="tactile-4 bg-card border-2 border-line-strong rounded-2xl py-5 flex items-center justify-center active:scale-95 transition-transform"
              aria-label="Delete"
            >
              <Delete className="w-6 h-6" />
            </button>
            <button
              onClick={() => pressDigit('0')}
              className="tactile-4 bg-card border-2 border-line-strong rounded-2xl py-5 text-2xl font-black font-sans active:scale-95 transition-transform"
            >
              0
            </button>
            <button
              onClick={submit}
              disabled={pin.length < 4 || busy}
              className="tactile-4 rounded-2xl py-5 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40 bg-gold-deep text-white"
              aria-label="Sign in"
            >
              <LogIn className="w-6 h-6" />
            </button>
          </div>
        </div>
      )}

      <button
        onClick={onExitKiosk}
        className="mt-auto pt-10 text-xs text-ink-soft underline"
      >
        Exit kiosk mode
      </button>
    </div>
  );
}
