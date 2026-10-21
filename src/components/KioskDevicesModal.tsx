import React, { useCallback, useEffect, useState } from 'react';
import { Tablet, X, AlertTriangle, Check, Unlink } from 'lucide-react';
import { User, Venue } from '../types';
import { apiFetch } from '../lib/api';
import { realtimeSocket } from '../lib/socketClient';

interface KioskDevice {
  id: string;
  name: string;
  venueId: string;
  venueName: string;
  agencyId?: string;
  createdAt: string;
  pairedByName: string;
  lastSeenAt?: string;
}

interface KioskDevicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
  venues: Venue[];
}

function relativeLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return 'Not seen yet';
  const then = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(then)) return 'Not seen yet';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const KioskDevicesModal: React.FC<KioskDevicesModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  venues,
}) => {
  const [devices, setDevices] = useState<KioskDevice[]>([]);
  const [code, setCode] = useState('');
  const [venueId, setVenueId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const isCoordinator = currentUser?.role === 'coordinator';
  const coordinatorVenueId = currentUser?.venueId || '';

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/kiosk/devices');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load kiosk tablets.');
      setDevices(Array.isArray(d.devices) ? d.devices : []);
    } catch (e: any) {
      setError(e.message || 'Could not load kiosk tablets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setMessage(null);
    setCode('');
    setName('');
    setVenueId(isCoordinator ? coordinatorVenueId : '');
    void loadDevices();
  }, [isOpen, isCoordinator, coordinatorVenueId, loadDevices]);

  useEffect(() => {
    if (!isOpen) return;
    if (!isCoordinator && !venueId && venues.length > 0) {
      setVenueId(venues[0].id);
    }
  }, [isOpen, isCoordinator, venueId, venues]);

  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = realtimeSocket.onMessage((msg) => {
      if (msg.type === 'KIOSK_DEVICES_UPDATED') {
        void loadDevices();
      }
    });
    return unsubscribe;
  }, [isOpen, loadDevices]);

  if (!isOpen) return null;

  const venueOptions = isCoordinator
    ? venues.filter((v) => v.id === coordinatorVenueId)
    : venues;
  const fixedVenue = isCoordinator
    ? venueOptions[0] || (coordinatorVenueId ? { id: coordinatorVenueId, name: coordinatorVenueId } as Venue : null)
    : null;

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.trim().toUpperCase();
    const selectedVenueId = isCoordinator ? coordinatorVenueId : venueId;
    setError(null);
    setMessage(null);
    if (cleanCode.length !== 6) {
      setError('Enter the 6-character code shown on the tablet.');
      return;
    }
    if (!selectedVenueId) {
      setError('Choose the venue for this tablet.');
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch('/api/kiosk/devices/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cleanCode,
          venueId: selectedVenueId,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not pair this tablet.');
      setCode('');
      setName('');
      setMessage(`Paired ${d.device?.name || 'tablet'}.`);
      await loadDevices();
    } catch (e: any) {
      setError(e.message || 'Could not pair this tablet.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnpair = async (device: KioskDevice) => {
    if (!window.confirm(`Unpair ${device.name}?`)) return;
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const r = await apiFetch(`/api/kiosk/devices/${encodeURIComponent(device.id)}`, {
        method: 'DELETE',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not unpair this tablet.');
      setMessage(`Unpaired ${device.name}.`);
      await loadDevices();
    } catch (e: any) {
      setError(e.message || 'Could not unpair this tablet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm overflow-y-auto">
      <div className="bg-surface rounded-2xl w-full max-w-2xl e3 border border-line my-8 overflow-hidden flex flex-col max-h-[90vh] animate-slide-up">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-sunken text-ink-soft">
              <Tablet className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Kiosk tablets</h2>
              <p className="text-xs text-ink-soft">Pair a tablet to one venue, or unpair it.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            aria-label="Close kiosk tablets"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          <form onSubmit={handlePair} className="space-y-3 pb-5 border-b border-line">
            <h3 className="text-sm font-bold text-ink">Pair a tablet</h3>
            <div className="grid sm:grid-cols-[1fr_1fr] gap-3">
              <label className="block">
                <span className="block text-xs font-bold text-ink-soft mb-1">Code</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                  placeholder="ABC234"
                  autoComplete="off"
                  className="w-full text-base px-3 py-2 rounded-xl border border-line-control bg-sunken text-ink uppercase tracking-[0.2em] focus:outline-none focus:border-gold"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-bold text-ink-soft mb-1">Venue</span>
                {isCoordinator ? (
                  <div className="w-full text-sm px-3 py-2 rounded-xl border border-line bg-sunken text-ink">
                    {fixedVenue?.name || 'Your venue'}
                  </div>
                ) : (
                  <select
                    value={venueId}
                    onChange={(e) => setVenueId(e.target.value)}
                    className="w-full text-base px-3 py-2 rounded-xl border border-line-control bg-sunken text-ink focus:outline-none focus:border-gold"
                  >
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                )}
              </label>
            </div>
            <label className="block">
              <span className="block text-xs font-bold text-ink-soft mb-1">Tablet name <span className="font-normal text-ink-soft">(optional)</span></span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 40))}
                placeholder="Kitchen tablet"
                className="w-full text-base px-3 py-2 rounded-xl border border-line-control bg-sunken text-ink focus:outline-none focus:border-gold"
              />
            </label>
            {error && <p className="text-sm bg-bad-bg border border-bad text-bad rounded-xl p-3 flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{error}</span></p>}
            {message && <p className="text-sm bg-ok-bg text-ok rounded-xl p-3 flex items-start gap-2"><Check className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{message}</span></p>}
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-xl bg-gold-deep text-paper text-xs font-bold transition cursor-pointer disabled:opacity-40"
            >
              Pair tablet
            </button>
          </form>

          <div className="pt-5">
            <h3 className="text-sm font-bold text-ink mb-3">Paired tablets</h3>
            {loading ? (
              <p className="text-sm text-ink-soft animate-pulse">Loading…</p>
            ) : devices.length === 0 ? (
              <div data-empty-state className="text-sm text-ink-soft space-y-2">
                <Tablet className="w-5 h-5" aria-hidden="true" />
                <p>No tablets are paired yet.</p>
                <p>Pair a tablet with the code shown on its screen.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <div key={device.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-sunken border border-line">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-ink truncate">{device.name}</p>
                      <p className="text-xs text-ink-soft truncate">
                        {device.venueName} · Last seen {relativeLastSeen(device.lastSeenAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleUnpair(device)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer disabled:opacity-40 shrink-0 inline-flex items-center gap-2 bg-surface border border-line-control text-bad hover:bg-sunken"
                    >
                      <Unlink className="w-4 h-4" aria-hidden="true" />
                      Unpair
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
