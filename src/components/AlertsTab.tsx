import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BellOff, Bell, Camera, Check, CheckCheck, CheckCircle2, ChevronDown, Image as ImageIcon,
  Mic, Play, Send, ShieldAlert, Square, X,
} from 'lucide-react';
import {
  ALERT_DESCRIPTION_MAX, ALERT_PHOTO_MAX_CHARS, ALERT_TITLE_MAX, ALERT_VOICE_MAX_CHARS, ALERT_VOICE_MAX_SECONDS,
  AlertItem, AlertSeverity, ReceiptCount, acknowledgeAlert, alertCanAcknowledge, alertCanResolve,
  fetchAlertMedia, minutesUntilMorning, raiseAlert, resolveAlert, setAlertMute,
} from '../lib/alerts';
import { MarkKind, useVisibleMarks } from '../lib/updates';
import { AlertDraft } from './UpdatesCenter';
import { ReceiptLine } from './Receipts';

// 5b — the Alerts tab (the server calls them incidents). Anyone signed in at
// the venue raises one (text, photo, voice note). Every alert is delivered
// at once, 24/7, to the venue's coordinators and the agency's admins; each
// receiver controls their own silence with the mute row (silent, never
// held back). Open → Acknowledged (admin / this venue's coordinator) →
// Resolved. Admins and coordinators see ✓✓ read counts. Not on the kiosk.

const SEVERITIES: { id: AlertSeverity; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'critical', label: 'Critical' },
];

const STATUS_WORD: Record<AlertItem['status'], string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
};



/** Downscale a camera photo until its data URL fits the server cap. */
async function shrinkPhoto(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    for (const [edge, q] of [[1024, 0.7], [800, 0.62], [640, 0.55], [480, 0.5]] as const) {
      const scale = Math.min(1, edge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length <= ALERT_PHOTO_MAX_CHARS) return data;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const timeAgo = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Raise form. The draft (text + in-memory media) belongs to UpdatesCenter
// (A6): it survives this form closing, tab switches and failed sends, and
// ends only on a confirmed send, an explicit Discard, or a context change.
// Every async step re-checks the draft generation after each await (BE):
// a photo or recording that finishes after the draft died is dropped,
// never attached.
// ---------------------------------------------------------------------------
function RaiseAlertForm({
  venueId,
  draft,
  media,
  draftGen,
  onDraftChange,
  onMediaChange,
  onDiscard,
  onCancel,
  onRaised,
}: {
  venueId: string;
  draft: AlertDraft;
  media: { photoData?: string; voiceNoteData?: string };
  draftGen: number;
  onDraftChange: (patch: Partial<AlertDraft>) => void;
  onMediaChange: (m: { photoData?: string; voiceNoteData?: string } | ((prev: { photoData?: string; voiceNoteData?: string }) => { photoData?: string; voiceNoteData?: string })) => void;
  onDiscard: () => void;
  onCancel: () => void;
  onRaised: (a: AlertItem) => void;
}) {
  const { title, description, severity } = draft;
  const photo = media.photoData || '';
  const voice = media.voiceNoteData || '';
  const [recState, setRecState] = useState<'idle' | 'recording' | 'preview'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const disposedRef = useRef(false);
  const sessionRef = useRef(0);
  const genRef = useRef(draftGen);
  genRef.current = draftGen;
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const stopTimer = () => { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; };
  const alive = (session: number, gen: number) =>
    !disposedRef.current && session === sessionRef.current && gen === genRef.current;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      sessionRef.current += 1;
      stopTimer();
      try { recRef.current?.stop(); } catch { /* already stopped */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stopRecording = () => { stopTimer(); try { recRef.current?.stop(); } catch { /* noop */ } };

  const startRecording = async () => {
    setError(null);
    const session = ++sessionRef.current;
    const gen = genRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (alive(session, gen)) setError('Microphone is not available on this device.');
      return;
    }
    if (!alive(session, gen)) { stream.getTracks().forEach((t) => t.stop()); return; }
    streamRef.current = stream;
    // A low bitrate so a 30 s note fits the 90k-char cap (A12). The browser
    // default (~128 kbps in Chrome) fills the cap in about 4 s.
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(stream, { audioBitsPerSecond: 16000 }); } catch { rec = new MediaRecorder(stream); }
    chunksRef.current = [];
    rec.ondataavailable = (e) => chunksRef.current.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (!alive(session, gen)) return;
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
      if (blob.size === 0) { setRecState('idle'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (!alive(session, gen)) return;
        const data = String(reader.result || '');
        if (data.length > ALERT_VOICE_MAX_CHARS) {
          setError('That voice note is too long to send. Record a shorter one.');
          setRecState('idle');
          return;
        }
        onMediaChange((prev) => ({ ...prev, voiceNoteData: data }));
        setRecState('preview');
      };
      reader.readAsDataURL(blob);
    };
    rec.start(250);
    recRef.current = rec;
    setElapsed(0);
    setRecState('recording');
    // Cap on real elapsed time (rule BD), not on tick counts.
    startedRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startedRef.current) / 1000);
      setElapsed(Math.min(secs, ALERT_VOICE_MAX_SECONDS));
      if (secs >= ALERT_VOICE_MAX_SECONDS) stopRecording();
    }, 250);
  };

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError(null);
    const session = sessionRef.current;
    const gen = genRef.current;
    const data = await shrinkPhoto(f);
    // A venue switch during processing attaches nothing late (A6/BE).
    if (!alive(session, gen)) return;
    if (!data) { setError("Couldn't use that photo. Try another one."); return; }
    onMediaChange((prev) => ({ ...prev, photoData: data }));
  };

  const send = async (withoutMedia = false) => {
    if (sending || !title.trim()) return;
    setSending(true);
    setError(null);
    const session = sessionRef.current;
    const gen = genRef.current;
    const r = await raiseAlert({
      venueId,
      title: title.trim(),
      description: description.trim(),
      severity,
      ...(withoutMedia ? {} : { photoData: photo || undefined, voiceNoteData: voice || undefined }),
      // One reference per draft: a retry after a lost answer is the same alert.
      clientRef: draft.clientRef,
    });
    if (!alive(session, gen)) return;
    setSending(false);
    if (r.ok && r.alert) { onRaised(r.alert); return; }
    // Keep everything typed and recorded; the same reference makes the
    // retry safe (no second alert). A 413 keeps the text intact too.
    setTooLarge(!!r.tooLarge);
    setError(r.budget
      ? 'Too many photos and voice notes are stored right now. Your words can still go.'
      : r.tooLarge ? 'The photo or voice note is too large to send.' : "Couldn't send. Try again.");
  };

  const hasContent = !!title || !!description || !!photo || !!voice;

  return (
    <div className="p-3 rounded-xl border border-line bg-sunken space-y-3">
      {error && (
        <div className="p-2 rounded-lg text-sm space-y-2" role="alert" style={{ backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }}>
          <p>{error}</p>
          {tooLarge && (photo || voice) && (
            <button
              type="button"
              onClick={() => void send(true)}
              className="pressable min-h-11 px-3 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              Send without the attachment
            </button>
          )}
        </div>
      )}
      <label className="block">
        <span className="text-sm font-bold text-ink-soft">What happened?</span>
        <input
          value={title}
          onChange={(e) => onDraftChange({ title: e.target.value.slice(0, ALERT_TITLE_MAX) })}
          dir="auto"
          maxLength={ALERT_TITLE_MAX}
          placeholder="e.g. Seal broken on the meat fridge"
          className="mt-1 w-full h-12 px-3 text-base rounded-lg bg-surface border border-line-control text-ink"
        />
      </label>
      <div role="radiogroup" aria-label="How serious" className="grid grid-cols-4 gap-1.5">
        {SEVERITIES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={severity === s.id}
            onClick={() => onDraftChange({ severity: s.id })}
            className={`pressable min-h-11 rounded-lg border text-sm font-bold cursor-pointer ${
              severity === s.id
                ? s.id === 'low' ? 'bg-ok-bg border-ok text-ok' : s.id === 'medium' ? 'bg-warn-bg border-warn text-warn' : 'bg-bad-bg border-bad text-bad'
                : 'bg-surface border-line-control text-ink hover:bg-sunken'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-sm font-bold text-ink-soft">Details (optional)</span>
        <textarea
          value={description}
          onChange={(e) => onDraftChange({ description: e.target.value.slice(0, ALERT_DESCRIPTION_MAX) })}
          dir="auto"
          rows={3}
          maxLength={ALERT_DESCRIPTION_MAX}
          className="mt-1 w-full px-3 py-2 text-base rounded-lg bg-surface border border-line-control text-ink resize-none"
        />
      </label>

      {photo && (
        <div className="flex items-center gap-2">
          <img src={photo} alt="Photo to send" className="w-16 h-16 rounded-lg object-cover border border-line" />
          <button type="button" onClick={() => onMediaChange((prev) => ({ voiceNoteData: prev.voiceNoteData }))} className="pressable min-h-11 px-3 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
            Remove photo
          </button>
        </div>
      )}
      {recState === 'recording' && (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 text-base font-bold" style={{ color: 'var(--bad)' }}>
            <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--bad)' }} />
            Recording {mmss(elapsed)} / {mmss(ALERT_VOICE_MAX_SECONDS)}
          </span>
          <button type="button" onClick={stopRecording} className="pressable flex items-center gap-1.5 px-3 min-h-11 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
            <Square className="w-4 h-4" /> Stop
          </button>
        </div>
      )}
      {recState === 'preview' && voice && (
        <div className="flex items-center gap-2">
          <Play className="w-4 h-4 text-ink-soft shrink-0" />
          <audio src={voice} controls preload="metadata" className="flex-1 h-11 min-w-0" />
          <button type="button" onClick={() => { onMediaChange((prev) => ({ photoData: prev.photoData })); setRecState('idle'); }} className="pressable min-h-11 px-3 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
            Remove
          </button>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickPhoto} />
        {!photo && (
          <button type="button" onClick={() => fileRef.current?.click()} className="pressable flex items-center gap-2 px-3 min-h-12 rounded-xl text-base font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
            <Camera className="w-5 h-5" /> Photo
          </button>
        )}
        {recState === 'idle' && !voice && (
          <button type="button" onClick={startRecording} className="pressable flex items-center gap-2 px-3 min-h-12 rounded-xl text-base font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
            <Mic className="w-5 h-5" /> Voice
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="pressable px-4 min-h-12 rounded-xl text-base font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void send(false)}
          disabled={sending || !title.trim() || recState === 'recording'}
          className="pressable flex-1 flex items-center justify-center gap-2 min-h-12 rounded-xl bg-gold-deep text-paper text-base font-bold disabled:opacity-50 cursor-pointer"
        >
          <Send className="w-5 h-5" /> {sending ? 'Sending…' : 'Send alert now'}
        </button>
      </div>
      {hasContent && (
        <button type="button" onClick={onDiscard} className="pressable min-h-11 px-2 text-sm font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">
          Discard draft
        </button>
      )}
      <p className="text-xs text-ink-soft">
        Goes at once to this venue's coordinators and the agency's admins, day or night.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mute row — the receiver's own silence. Alerts still arrive, silently.
// ---------------------------------------------------------------------------
function MuteRow({ mutedUntil, onChange }: { mutedUntil: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const muted = !!mutedUntil && new Date(mutedUntil).getTime() > Date.now();
  const set = async (minutes: number) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const v = await setAlertMute(minutes);
    setBusy(false);
    if (v === undefined) { setFailed(true); return; }
    onChange(v);
    setOpen(false);
  };
  const untilWord = muted
    ? new Date(mutedUntil!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="pressable w-full min-h-12 px-3 flex items-center gap-2 text-left cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
      >
        {muted ? <BellOff className="w-5 h-5 text-ink-soft shrink-0" /> : <Bell className="w-5 h-5 text-ink-soft shrink-0" />}
        <span className="flex-1 text-base font-semibold">
          {muted ? `Alert sound off until ${untilWord}` : 'Alert sound on'}
        </span>
        <ChevronDown className={`w-5 h-5 text-ink-soft transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-ink-soft">Alerts always arrive right away. This only silences the sound on your devices.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void set(60)} className="pressable h-11 px-3 rounded-lg text-sm font-bold cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken">Silence 1 hour</button>
            <button type="button" disabled={busy} onClick={() => void set(minutesUntilMorning())} className="pressable h-11 px-3 rounded-lg text-sm font-bold cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken">Until 7 AM</button>
            {muted && (
              <button type="button" disabled={busy} onClick={() => void set(0)} className="pressable h-11 px-3 rounded-lg text-sm font-bold cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken">Sound on</button>
            )}
          </div>
          {failed && <p className="text-sm" style={{ color: 'var(--bad)' }}>Couldn't change it. Try again.</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One alert
// ---------------------------------------------------------------------------
function AlertRow({
  a, unread, canAck, canResolve, receipt, flash, onAck, onResolve, onOpenReaders, busy,
}: {
  a: AlertItem;
  unread: boolean;
  canAck: boolean;
  canResolve: boolean;
  receipt: ReceiptCount | undefined | null;
  flash: boolean;
  busy: boolean;
  onAck: () => void;
  onResolve: () => void;
  onOpenReaders: () => void;
}) {
  const [media, setMedia] = useState<{ photoData: string | null; voiceNoteData: string | null } | null>(null);
  const [mediaState, setMediaState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [confirmResolve, setConfirmResolve] = useState(false);
  const liveRef = useRef(true);
  // StrictMode-safe: re-arm on every mount (dev mounts, unmounts, mounts again).
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);

  const loadMedia = async () => {
    if (mediaState === 'loading') return;
    setMediaState('loading');
    const m = await fetchAlertMedia(a.id);
    if (!liveRef.current) return;
    if (!m) { setMediaState('failed'); return; }
    setMedia(m);
    setMediaState('idle');
  };

  const serious = a.severity === 'high' || a.severity === 'critical';
  const resolved = a.status === 'resolved';
  return (
    <article
      data-alert-id={a.id}
      {...(unread ? { 'data-mark-kind': 'i', 'data-mark-id': a.id } : {})}
      className={`p-3 rounded-xl border bg-surface transition ${flash ? 'ring-2 ring-gold' : ''} ${resolved ? 'opacity-80' : ''}`}
      style={{ borderColor: !resolved && serious ? 'var(--bad)' : 'var(--line)' }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full"
          style={serious ? { backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' } : a.severity === 'low' ? { backgroundColor: 'var(--ok-bg)', color: 'var(--ok)' } : { backgroundColor: 'var(--warn-bg)', color: 'var(--warn)' }}
        >
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          {SEVERITIES.find((s) => s.id === a.severity)?.label || a.severity}
        </span>
        <span
          className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full border"
          style={
            a.status === 'open'
              ? { borderColor: 'var(--bad)', color: 'var(--bad)' }
              : a.status === 'acknowledged'
                ? { borderColor: 'var(--warn)', color: 'var(--warn)' }
                : { borderColor: 'var(--ok)', color: 'var(--ok)' }
          }
        >
          {a.status === 'resolved' && <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
          {STATUS_WORD[a.status]}
        </span>
        {unread && (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-gold-deep">
            <span className="w-2 h-2 rounded-full bg-gold" /> New
          </span>
        )}
        {a.mine && <span className="text-xs font-bold text-ink-soft">Your alert</span>}
      </div>
      <h3 dir="auto" className={`text-base mt-1.5 ${unread ? 'font-bold text-ink' : 'font-semibold text-ink-soft'}`}>{a.title}</h3>
      <p className="text-xs text-ink-soft mt-0.5">
        <span dir="auto">{a.reporterName}</span> · {timeAgo(a.createdAt)}
      </p>
      {a.description && <p dir="auto" className="text-base whitespace-pre-wrap mt-1.5">{a.description}</p>}

      {(a.hasPhoto || a.hasVoice) && !media && (
        <button
          type="button"
          onClick={() => void loadMedia()}
          className="pressable mt-2 h-11 px-3 rounded-lg text-sm font-bold inline-flex items-center gap-2 cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
        >
          {a.hasPhoto ? <ImageIcon className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {mediaState === 'loading'
            ? 'Loading…'
            : a.hasPhoto && a.hasVoice ? 'Show photo and voice note' : a.hasPhoto ? 'Show photo' : 'Play voice note'}
        </button>
      )}
      {mediaState === 'failed' && <p className="text-sm mt-1" style={{ color: 'var(--bad)' }}>Couldn't load it. Try again.</p>}
      {media?.photoData && <img src={media.photoData} alt={`Photo: ${a.title}`} className="mt-2 rounded-lg max-h-72 w-auto border border-line" />}
      {media?.voiceNoteData && <audio src={media.voiceNoteData} controls preload="metadata" className="mt-2 w-full h-11" />}

      {a.mine && a.seenByRecipient && (
        <p className="text-sm text-ink-soft mt-2 inline-flex items-center gap-1.5">
          <CheckCheck className="w-4 h-4" style={{ color: 'var(--ok)' }} aria-hidden="true" />
          Seen by a recipient
        </p>
      )}

      {(a.acknowledgedByName || a.resolvedByName) && (
        <p className="text-sm text-ink-soft mt-2">
          {a.acknowledgedByName && <>Acknowledged by <span dir="auto">{a.acknowledgedByName}</span>{a.acknowledgedAt ? `, ${timeAgo(a.acknowledgedAt)}` : ''}. </>}
          {a.resolvedByName && <>Resolved by <span dir="auto">{a.resolvedByName}</span>{a.resolvedAt ? `, ${timeAgo(a.resolvedAt)}` : ''}.</>}
        </p>
      )}

      {/* Plan v2 A1: reads and acknowledgment are separate words — a ✓✓ count never means "handled". */}
      {receipt !== null && (
        <div className="flex flex-wrap items-center gap-x-2">
          <ReceiptLine count={receipt} onOpen={onOpenReaders} />
          {a.status === 'open' && <span className="text-sm font-bold text-ink-soft mt-2">· Not acknowledged</span>}
        </div>
      )}

      {confirmResolve ? (
        <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-sunken">
          <span className="text-sm font-bold flex-1">Mark this alert resolved?</span>
          <button type="button" disabled={busy} onClick={() => { setConfirmResolve(false); onResolve(); }} className="pressable px-3 h-11 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">Resolve</button>
          <button type="button" onClick={() => setConfirmResolve(false)} className="pressable px-3 h-11 rounded-lg text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken">Cancel</button>
        </div>
      ) : (canAck || canResolve) && (
        <div className="flex gap-2 mt-2">
          {canAck && (
            <button type="button" disabled={busy} onClick={onAck} className="pressable flex-1 h-11 rounded-lg text-sm font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken">
              <Check className="w-4 h-4" /> Acknowledge
            </button>
          )}
          {canResolve && (
            <button type="button" disabled={busy} onClick={() => setConfirmResolve(true)} className="pressable flex-1 h-11 rounded-lg text-sm font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken">
              <CheckCircle2 className="w-4 h-4" /> Resolve
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------
interface AlertsTabProps {
  items: AlertItem[];
  loading: boolean;
  unreadIds: Set<string>;
  role: string;
  /** The viewer's venues (rule T); the sheet's venue for everyone below admin. */
  viewerVenueIds: string[];
  canFillTasks: boolean;
  venueId: string;
  active: boolean;
  highlightId?: string | null;
  /** ✓✓ counts by alert id; null = this viewer sees no receipts. */
  receipts: Record<string, ReceiptCount> | null;
  mutedUntil: string | null;
  onMuteChange: (v: string | null) => void;
  onMark: (kind: MarkKind, id: string) => void;
  /** After any write: refetch the lists and counts (REST is the authority, rule BE). */
  onChanged: () => void;
  onOpenReaders: (id: string, title: string) => void;
  /** A6: the raise draft, owned by UpdatesCenter. */
  draft: AlertDraft;
  media: { photoData?: string; voiceNoteData?: string };
  draftGen: number;
  onDraftChange: (patch: Partial<AlertDraft>) => void;
  onMediaChange: (m: { photoData?: string; voiceNoteData?: string } | ((prev: { photoData?: string; voiceNoteData?: string }) => { photoData?: string; voiceNoteData?: string })) => void;
  onDiscardDraft: () => void;
  onDraftSent: () => void;
}

const SEV_RANK: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function AlertsTab({
  items, loading, unreadIds, role, viewerVenueIds, canFillTasks, venueId, active, highlightId,
  receipts, mutedUntil, onMuteChange, onMark, onChanged, onOpenReaders,
  draft, media, draftGen, onDraftChange, onMediaChange, onDiscardDraft, onDraftSent,
}: AlertsTabProps) {
  const draftHasContent = !!(draft.title || draft.description || media.photoData || media.voiceNoteData);
  const [composing, setComposing] = useState(draftHasContent);
  const [showResolved, setShowResolved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  // Optimistic overrides until the refetch lands (rule BE).
  const [overrides, setOverrides] = useState<Record<string, AlertItem>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(true);
  // StrictMode-safe: re-arm on every mount (dev mounts, unmounts, mounts again).
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);
  useEffect(() => { setOverrides({}); }, [items]);

  const shown = useMemo(() => items.map((a) => overrides[a.id] || a), [items, overrides]);
  // A9: open and not yet acknowledged first (critical above the rest), then
  // acknowledged; resolved fold away below. Newest first inside each group.
  const active_ = useMemo(() => {
    const open = shown.filter((a) => a.status === 'open')
      .sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || y.createdAt.localeCompare(x.createdAt));
    const acked = shown.filter((a) => a.status === 'acknowledged')
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return [...open, ...acked];
  }, [shown]);
  const resolved = shown.filter((a) => a.status === 'resolved');
  const idsKey = shown.map((a) => `${a.id}:${a.status}`).join(',') + (showResolved ? '+r' : '');
  useVisibleMarks(listRef, active, idsKey, onMark);

  useEffect(() => {
    if (!highlightId) return;
    if (resolved.some((a) => a.id === highlightId)) setShowResolved(true);
    const el = listRef.current?.querySelector(`[data-alert-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setFlashId(highlightId);
    const t = setTimeout(() => setFlashId(null), 2400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, idsKey]);

  const act = async (a: AlertItem, kind: 'ack' | 'resolve') => {
    if (busyId) return;
    setBusyId(a.id);
    setError(null);
    const r = kind === 'ack' ? await acknowledgeAlert(a.id) : await resolveAlert(a.id);
    if (!liveRef.current) return;
    setBusyId(null);
    if (!r.ok) { setError(r.error || 'Could not update the alert.'); onChanged(); return; }
    if (r.alert) setOverrides((o) => ({ ...o, [a.id]: r.alert! }));
    onChanged();
  };

  const row = (a: AlertItem) => (
    <React.Fragment key={a.id}>
    <AlertRow
      a={a}
      unread={!a.mine && unreadIds.has(a.id)}
      canAck={alertCanAcknowledge(a, role, viewerVenueIds)}
      canResolve={alertCanResolve(a, role, viewerVenueIds, canFillTasks)}
      receipt={receipts ? receipts[a.id] : null}
      flash={flashId === a.id}
      busy={busyId === a.id}
      onAck={() => void act(a, 'ack')}
      onResolve={() => void act(a, 'resolve')}
      onOpenReaders={() => onOpenReaders(a.id, a.title)}
    />
    </React.Fragment>
  );

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div ref={listRef} className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
        {!composing ? (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="pressable w-full h-12 rounded-xl bg-gold-deep text-paper text-base font-bold flex items-center justify-center gap-2 cursor-pointer"
          >
            <ShieldAlert className="w-5 h-5" /> Raise an alert
          </button>
        ) : (
          <RaiseAlertForm
            venueId={venueId}
            draft={draft}
            media={media}
            draftGen={draftGen}
            onDraftChange={onDraftChange}
            onMediaChange={onMediaChange}
            onDiscard={() => { onDiscardDraft(); setComposing(false); }}
            onCancel={() => setComposing(false)}
            onRaised={() => { onDraftSent(); setComposing(false); onChanged(); }}
          />
        )}
        {(role === 'admin' || role === 'coordinator') && <MuteRow mutedUntil={mutedUntil} onChange={onMuteChange} />}
        {error && (
          <p role="alert" className="p-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }}>{error}</p>
        )}

        {loading && shown.length === 0 ? (
          <div className="space-y-2.5" aria-label="Loading alerts">
            {[0, 1].map((i) => (
              <div key={i} className="p-3 rounded-xl border border-line">
                <div className="h-4 w-1/3 rounded bg-sunken mb-2" />
                <div className="h-4 w-full rounded bg-sunken" />
              </div>
            ))}
          </div>
        ) : active_.length === 0 ? (
          <div data-empty-state className="text-center py-8">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--ok)' }} />
            <p className="text-base text-ink-soft">No open alerts at this venue.</p>
            {!composing && <p className="text-base text-ink-soft mt-1">Raise one above if something needs attention.</p>}
          </div>
        ) : (
          active_.map(row)
        )}

        {resolved.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              aria-expanded={showResolved}
              className="pressable w-full min-h-11 flex items-center justify-between text-sm font-bold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              Resolved ({resolved.length})
              <ChevronDown className={`w-5 h-5 transition ${showResolved ? 'rotate-180' : ''}`} />
            </button>
            {showResolved && resolved.map(row)}
          </>
        )}
      </div>
    </div>
  );
}
