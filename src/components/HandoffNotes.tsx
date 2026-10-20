import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Trash2, Mic, Square, Play, Send, X } from 'lucide-react';
import { apiWrite } from '../lib/api';
import { HandoffNoteItem, useVisibleMarks } from '../lib/updates';

// 5a — Shift notes as the Updates sheet's second tab body (was an
// unrendered panel). The note box + mic are pinned at the bottom for
// everyone signed in; on the kiosk (readOnly) there is no box, no mic, no
// delete and no read marks — playback only.
// Voice: 2-minute cap with a visible timer, preview before send, and a
// failed send keeps both the text and the recording. Nothing autoplays;
// playback offers 1× / 1.5×. Unmount (context switch, kiosk idle sign-out)
// stops the recorder, the mic stream and any playback.

const MAX_RECORD_SECONDS = 120;
const SHIFTS = ['Morning', 'Afternoon', 'Evening', 'General'];

interface HandoffNotesProps {
  items: HandoffNoteItem[];
  loading: boolean;
  readOnly: boolean;
  unreadIds: Set<string>;
  venueId: string;
  currentUserEmail: string;
  currentUserName: string;
  active: boolean;
  onMark: (kind: 'a' | 'n', id: string) => void;
  onPosted: (item: HandoffNoteItem) => void;
  onDeleted: (id: string) => void;
}

type RecordState = 'idle' | 'recording' | 'preview';

export function HandoffNotes({
  items,
  loading,
  readOnly,
  unreadIds,
  venueId,
  currentUserEmail,
  active,
  onMark,
  onPosted,
  onDeleted,
}: HandoffNotesProps) {
  const [content, setContent] = useState('');
  const [shift, setShift] = useState('Morning');
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [voiceNoteData, setVoiceNoteData] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, number>>({});

  const listRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  const idsKey = items.map((n) => n.id).join(',');
  useVisibleMarks(listRef, active && !readOnly, idsKey, onMark);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  // Leaving the sheet / switching context / kiosk idle sign-out unmounts
  // this component: release the mic and stop everything (plan C4).
  useEffect(() => {
    return () => {
      stopTimer();
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRefs.current.forEach((a) => { try { a.pause(); } catch { /* noop */ } });
    };
  }, []);

  const startRecording = async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) { setRecordState('idle'); return; }
        const reader = new FileReader();
        reader.onload = () => {
          setVoiceNoteData(reader.result as string);
          setRecordState('preview');
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setElapsed(0);
      setRecordState('recording');
      let secs = 0;
      timerRef.current = setInterval(() => {
        secs += 1;
        setElapsed(Math.min(secs, MAX_RECORD_SECONDS));
        if (secs >= MAX_RECORD_SECONDS) stopRecording();
      }, 1000);
    } catch {
      setErrorMsg('Microphone is not available on this device.');
    }
  };

  const stopRecording = () => {
    stopTimer();
    try { mediaRecorderRef.current?.stop(); } catch { /* noop */ }
  };

  const discardRecording = () => {
    setVoiceNoteData('');
    setRecordState('idle');
    setElapsed(0);
  };

  const send = async () => {
    if (sending || (!content.trim() && !voiceNoteData)) return;
    setSending(true);
    setErrorMsg(null);
    const result = await apiWrite('/api/handoff-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venueId,
        content: content.trim(),
        shift,
        voiceNoteData: voiceNoteData || undefined,
      }),
    });
    setSending(false);
    if (!result.ok) {
      // Keep the text AND the recording so nothing is lost (plan Q5).
      setErrorMsg("Couldn't send — try again");
      return;
    }
    if (result.data?.note) onPosted(result.data.note);
    setContent('');
    discardRecording();
  };

  const remove = async (id: string) => {
    setErrorMsg(null);
    const result = await apiWrite(`/api/handoff-notes/${id}`, { method: 'DELETE' });
    if (!result.ok) {
      setErrorMsg(result.error || 'Could not delete the note.');
      return;
    }
    onDeleted(id);
  };

  const setRate = (id: string, rate: number) => {
    setRates((r) => ({ ...r, [id]: rate }));
    const el = audioRefs.current.get(id);
    if (el) el.playbackRate = rate;
  };

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div ref={listRef} className="overflow-y-auto flex-1 px-4 py-3 space-y-2.5">
        {loading ? (
          <div className="space-y-2.5" aria-label="Loading shift notes">
            {[0, 1, 2].map((i) => (
              <div key={i} className="p-3 rounded-xl border border-line">
                <div className="h-4 w-1/4 rounded bg-sunken mb-2" />
                <div className="h-4 w-full rounded bg-sunken" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10">
            <MessageSquare className="w-8 h-8 text-ink-faint mx-auto mb-2" />
            <p className="text-base text-ink-soft">No shift notes yet.</p>
            <p className="text-sm text-ink-faint mt-1">Leave one for the next shift below.</p>
          </div>
        ) : (
          items.map((note) => {
            const mine = note.authorEmail === currentUserEmail;
            const unread = !mine && unreadIds.has(note.id);
            const rate = rates[note.id] || 1;
            return (
              <article
                key={note.id}
                {...(unread ? { 'data-mark-kind': 'n', 'data-mark-id': note.id } : {})}
                className="p-3 rounded-xl border border-line bg-surface"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gold-wash text-gold-ink">
                      {note.shift}
                    </span>
                    <span className="text-sm font-semibold">{note.authorName}</span>
                    {unread && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-gold-deep">
                        <span className="w-2 h-2 rounded-full bg-gold" />
                        New
                      </span>
                    )}
                  </div>
                  {!readOnly && mine && (
                    <button
                      type="button"
                      onClick={() => remove(note.id)}
                      aria-label="Delete my note"
                      className="pressable p-2 rounded-lg text-ink-faint hover:text-ink transition cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-faint mt-0.5">
                  {new Date(note.createdAt).toLocaleString()}
                </p>
                {note.content && (
                  <p className={`text-base whitespace-pre-wrap mt-1.5 ${unread ? 'font-semibold' : ''}`}>
                    {note.content}
                  </p>
                )}
                {note.voiceNoteData && (
                  <div className="mt-2 flex items-center gap-2">
                    <audio
                      ref={(el) => {
                        if (el) { audioRefs.current.set(note.id, el); el.playbackRate = rate; }
                        else audioRefs.current.delete(note.id);
                      }}
                      src={note.voiceNoteData}
                      controls
                      preload="metadata"
                      className="flex-1 h-10 min-w-0"
                    />
                    <div className="flex rounded-lg border border-line overflow-hidden shrink-0" role="group" aria-label="Playback speed">
                      {[1, 1.5].map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRate(note.id, r)}
                          className={`pressable px-2.5 h-10 text-sm font-bold cursor-pointer ${rate === r ? 'bg-ink text-white' : 'text-ink-soft'}`}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      {!readOnly && (
        <div className="border-t border-line bg-surface px-4 py-3 space-y-2.5 shrink-0">
          {errorMsg && (
            <p className="p-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }}>
              {errorMsg}
            </p>
          )}
          <div className="flex gap-2">
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value)}
              aria-label="Shift"
              className="h-12 px-2.5 text-base rounded-lg bg-surface border border-line shrink-0"
            >
              {SHIFTS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Note for the next shift…"
              aria-label="Note for the next shift"
              rows={1}
              className="flex-1 px-3 py-3 text-base rounded-lg bg-surface border border-line min-w-0 resize-none"
            />
          </div>

          {recordState === 'recording' && (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-2 text-base font-bold" style={{ color: 'var(--bad)' }}>
                <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--bad)' }} />
                Recording {mmss(elapsed)} / {mmss(MAX_RECORD_SECONDS)}
              </span>
              <button
                type="button"
                onClick={stopRecording}
                className="pressable flex items-center gap-1.5 px-3 h-11 rounded-lg border border-line text-sm font-bold cursor-pointer"
              >
                <Square className="w-4 h-4" /> Stop
              </button>
            </div>
          )}

          {recordState === 'preview' && voiceNoteData && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Play className="w-4 h-4 text-ink-faint shrink-0" />
                <audio src={voiceNoteData} controls preload="metadata" className="flex-1 h-10 min-w-0" />
              </div>
              <p className="text-xs text-ink-faint">Listen back, then send — or discard and record again.</p>
            </div>
          )}

          <div className="flex gap-2">
            {recordState === 'idle' && (
              <button
                type="button"
                onClick={startRecording}
                className="pressable flex items-center justify-center gap-2 px-4 h-12 rounded-xl border border-line text-base font-bold cursor-pointer"
              >
                <Mic className="w-5 h-5" /> Voice note
              </button>
            )}
            {recordState === 'preview' && (
              <button
                type="button"
                onClick={discardRecording}
                className="pressable flex items-center justify-center gap-2 px-4 h-12 rounded-xl border border-line text-base font-bold cursor-pointer"
              >
                <X className="w-5 h-5" /> Discard
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={sending || (!content.trim() && !voiceNoteData)}
              className="pressable flex-1 flex items-center justify-center gap-2 h-12 rounded-xl bg-gold text-white text-base font-bold disabled:opacity-50 transition cursor-pointer"
            >
              <Send className="w-5 h-5" />
              {sending ? 'Sending…' : 'Send note'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
