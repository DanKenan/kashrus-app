import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import { apiFetch, setKioskDevice, setKioskVenueName } from '../lib/api';

interface KioskPairingProps {
  onPaired: (device: string) => void;
  onExitKiosk: () => void;
  darkMode: boolean;
}

interface ApprovedDevice {
  id: string;
  name: string;
  venueId: string;
  venueName: string;
  agencyId: string;
}

/**
 * KioskPairing — the first screen on an unpaired tablet.
 *
 * The tablet asks the server for a one-time pairing code and shows it large.
 * A person pairs the tablet from their phone in "Kiosk tablets"; the tablet
 * polls until the pairing is approved, then stores its device credential
 * and moves on to the PIN screen. The tablet never lists venues.
 */
export function KioskPairing({ onPaired, onExitKiosk, darkMode }: KioskPairingProps) {
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [deviceSecret, setDeviceSecret] = useState('');
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const startingRef = useRef(false);

  // Same inline-arrow trap as KioskLogin: keep the latest onPaired in a
  // ref so the polling effect is created once per pairing — with the
  // callback in its deps, every parent re-render would tear down and
  // recreate the 3 s interval and fire an immediate extra poll.
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  }, [onPaired]);

  const startPairing = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError('');
    setExpired(false);
    try {
      const r = await apiFetch('/api/kiosk/pairing/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not start pairing. Try again.');
      setPairingId(d.pairingId);
      setCode(d.code || '');
      setDeviceSecret(d.deviceSecret || '');
    } catch (e: any) {
      setError(e.message || 'Could not start pairing. Try again.');
    } finally {
      setBusy(false);
      startingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void startPairing();
  }, [startPairing]);

  useEffect(() => {
    if (!pairingId || !deviceSecret || expired) return;
    let stopped = false;
    const poll = async () => {
      try {
        const r = await apiFetch('/api/kiosk/pairing/status', {
          headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` },
        });
        if (stopped) return;
        if (r.status === 404) {
          setExpired(true);
          return;
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok || stopped) return;
        if (d.status === 'approved' && d.device) {
          const device = d.device as ApprovedDevice;
          const storedDevice = `${device.id}.${deviceSecret}`;
          setKioskDevice(storedDevice);
          setKioskVenueName(device.venueName || null);
          onPairedRef.current(storedDevice);
        }
      } catch {
        // A failed poll is not fatal; the next poll tries again.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pairingId, deviceSecret, expired]);

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col items-center px-6 py-8 transition-colors">
      <ShutfeyLogo size="md" darkMode={darkMode} />

      <div className="mt-6 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-deep">Staff sign-in</p>
        <h1 className="mt-1 text-3xl font-black font-sans">Pair this tablet</h1>
        <p className="mt-3 max-w-md text-ink-soft font-semibold">
          In the app, open Kiosk tablets and enter this code.
        </p>
      </div>

      <div className="mt-10 w-full max-w-md flex flex-col items-center gap-5">
        {expired ? (
          <>
            <p className="text-lg font-bold text-red-600">Code expired</p>
            <button
              onClick={() => void startPairing()}
              disabled={busy}
              className="tactile-4 inline-flex items-center gap-2 rounded-2xl bg-gold-deep px-6 py-4 text-lg font-extrabold text-white active:scale-95 transition-transform disabled:opacity-40"
            >
              <RefreshCw className="w-5 h-5" />
              <span>New code</span>
            </button>
          </>
        ) : code ? (
          <div
            className="tactile-4 bg-card border-2 border-line-strong rounded-3xl px-8 py-7 text-center"
            aria-label={`Pairing code ${code}`}
          >
            <span className="block text-6xl font-black tracking-[0.18em] font-sans">{code}</span>
          </div>
        ) : (
          <p className="text-ink-soft animate-pulse">Getting a code…</p>
        )}

        {!expired && code && (
          <p className="text-center text-sm text-ink-soft">Waiting for someone to pair this tablet…</p>
        )}
        {error && <p className="text-center text-sm font-bold text-red-600">{error}</p>}
        {error && !code && (
          <button
            onClick={() => void startPairing()}
            disabled={busy}
            className="tactile-4 inline-flex items-center gap-2 rounded-2xl bg-gold-deep px-6 py-4 text-lg font-extrabold text-white active:scale-95 transition-transform disabled:opacity-40"
          >
            <RefreshCw className="w-5 h-5" />
            <span>Try again</span>
          </button>
        )}

        <button
          onClick={onExitKiosk}
          className="mt-4 text-center text-xs text-ink-faint underline underline-offset-2"
        >
          ← Back to regular sign-in
        </button>
      </div>
    </div>
  );
}
