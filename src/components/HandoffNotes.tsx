import { formatNoteTime, shiftForHour } from '../lib/dateText';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare, Trash2, Mic, Square, Play, Send, X, Lock, CheckCheck, AtSign } from 'lucide-react';
import { apiWrite } from '../lib/api';
import { HandoffNoteItem, MarkKind, NoteSeenCount, NoteSeenList, fetchNoteSeen, fetchNoteSeenCounts, fetchNoteTeam, useVisibleMarks } from '../lib/updates';
import { TeamMember, applyMention, filterTeam, joinNames, mentionQueryAt, privateNotice, removeTagText, seenLabel, splitMentions } from '../lib/mentions';

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
  /** Mirrors the server: own notes, the admin, or this venue's coordinator. */
  canDelete: (note: HandoffNoteItem) => boolean;
  unreadIds: Set<string>;
  venueId: string;
  currentUserEmail: string;
  currentUserName: string;
  /** TEAMNOTES: who "Tagged you" is about, and who the picker leaves out. */
  currentUserId?: string;
  active: boolean;
  onMark: (kind: MarkKind, id: string) => void;
  onPosted: (item: HandoffNoteItem) => void;
  onDeleted: (id: string) => void;
}

type RecordState = 'idle' | 'recording' | 'preview';

export function HandoffNotes({
  items,
  loading,
  readOnly,
  canDelete,
  unreadIds,
  venueId,
  currentUserEmail,
  currentUserId = '',
  active,
  onMark,
  onPosted,
  onDeleted,
}: HandoffNotesProps) {
  const [content, setContent] = useState('');
  const [shift, setShift] = useState<string>(() => shiftForHour(new Date().getHours())); // QA2 #30: from the clock, not always Morning
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [voiceNoteData, setVoiceNoteData] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // TEAMNOTES: @ picker, tags, private, seen-by.
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamFailed, setTeamFailed] = useState(false);
  const [teamTry, setTeamTry] = useState(0);
  const [mentionQ, setMentionQ] = useState<{ start: number; query: string } | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [tagged, setTagged] = useState<{ id: string; name: string }[]>([]);
  const [tagAll, setTagAll] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [seenCounts, setSeenCounts] = useState<Record<string, NoteSeenCount>>({});
  const [seenOpen, setSeenOpen] = useState<string | null>(null);
  const [seenList, setSeenList] = useState<NoteSeenList | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const seenReqRef = useRef(0);
  const pendingCaretRef = useRef<{ text: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const p = pendingCaretRef.current;
    if (!p) return;
    pendingCaretRef.current = null;
    const e = textRef.current;
    if (!e || e.value !== p.text) return;
    try { e.focus(); e.setSelectionRange(p.caret, p.caret); } catch { /* noop */ }
  }, [content]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // Mic lifecycle guards: nothing from an in-flight permission prompt, a
  // recorder callback or a file read may set state after unmount or after
  // the context moved on (the sheet unmounts on every context switch).
  const disposedRef = useRef(false);
  const recordSessionRef = useRef(0);
  const startedAtRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  const idsKey = items.map((n) => n.id).join(',');
  useVisibleMarks(listRef, active && !readOnly, idsKey, onMark);

  // TEAMNOTES (RV1 P2): picker, tags, Private and seen-by belong to ONE venue —
  // a venue change drops them at once (the draft text stays).
  const tagVenueRef = useRef(venueId);
  useEffect(() => {
    if (tagVenueRef.current === venueId) return;
    tagVenueRef.current = venueId;
    setTeam([]); setTagged([]); setTagAll(false); setIsPrivate(false); setMentionQ(null);
    setSeenCounts({}); setSeenOpen(null); setSeenList(null); seenReqRef.current += 1;
  }, [venueId]);

  // TEAMNOTES: the venue team for the @ picker (not on the kiosk).
  useEffect(() => {
    if (!active || readOnly || !venueId) return;
    const ctl = new AbortController();
    fetchNoteTeam(venueId, ctl.signal)
      .then((t) => { if (!ctl.signal.aborted && tagVenueRef.current === venueId) { setTeam(t || []); setTeamFailed(t === null); } })
      .catch(() => { if (!ctl.signal.aborted) setTeamFailed(true); });
    return () => ctl.abort();
  }, [active, readOnly, venueId, teamTry]);

  // Seen-by counts: on open, when the list changes and when marks land.
  const unreadKey = [...unreadIds].join(',');
  useEffect(() => {
    if (!active || readOnly || !venueId) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetchNoteSeenCounts(venueId, ctl.signal)
        .then((c) => { if (c && !ctl.signal.aborted) setSeenCounts(Object.fromEntries(c.map((x) => [x.id, x]))); })
        .catch(() => {});
    }, 300);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [active, readOnly, venueId, idsKey, unreadKey]);

  // Private needs at least one tagged PERSON and never goes to @All.
  const canPrivate = tagged.length > 0 && !tagAll;
  useEffect(() => { if (!canPrivate && isPrivate) setIsPrivate(false); }, [canPrivate, isPrivate]);

  const pickable = team.filter((m) => m.id !== currentUserId && !tagged.some((t) => t.id === m.id));
  const picker = mentionQ ? filterTeam(pickable, mentionQ.query) : null;
  const pickRows: Array<{ kind: 'all' } | { kind: 'person'; m: TeamMember }> = picker
    ? [...(picker.all && !tagAll ? [{ kind: 'all' as const }] : []), ...picker.people.slice(0, 8).map((m) => ({ kind: 'person' as const, m }))]
    : [];

  const updateMentionQuery = (value: string, caret: number | null) => {
    const q = mentionQueryAt(value, caret ?? value.length);
    setMentionQ(q);
    setPickIndex(0);
  };

  const choose = (row: { kind: 'all' } | { kind: 'person'; m: TeamMember }) => {
    if (!mentionQ) return;
    const el = textRef.current;
    const caret = el?.selectionStart ?? content.length;
    const label = row.kind === 'all' ? 'All' : row.m.name;
    const next = applyMention(content, caret, mentionQ, label);
    setContent(next.text);
    if (row.kind === 'all') setTagAll(true);
    else setTagged((t) => (t.some((x) => x.id === row.m.id) ? t : [...t, { id: row.m.id, name: row.m.name }]));
    setMentionQ(null);
    // The caret goes after the inserted tag in the SAME commit as the new text
    // (layout effect below) — a later frame would move it under fast typing.
    pendingCaretRef.current = { text: next.text, caret: next.caret };
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionQ || pickRows.length === 0) {
      if (e.key === 'Escape' && mentionQ) setMentionQ(null);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setPickIndex((i) => (i + 1) % pickRows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPickIndex((i) => (i - 1 + pickRows.length) % pickRows.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(pickRows[Math.min(pickIndex, pickRows.length - 1)]); }
    else if (e.key === 'Escape') { e.preventDefault(); setMentionQ(null); }
  };

  const openSeen = async (id: string) => {
    if (seenOpen === id) { seenReqRef.current += 1; setSeenOpen(null); setSeenList(null); return; }
    setSeenOpen(id); setSeenList(null);
    const req = ++seenReqRef.current;
    const list = await fetchNoteSeen(venueId, id).catch(() => null);
    if (disposedRef.current || req !== seenReqRef.current) return;
    setSeenList(list);
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  // Leaving the sheet / switching context / kiosk idle sign-out unmounts
  // this component: release the mic and stop everything (plan C4).
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      recordSessionRef.current += 1;
      stopTimer();
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRefs.current.forEach((a) => { try { a.pause(); } catch { /* noop */ } });
    };
  }, []);

  const startRecording = async () => {
    setErrorMsg(null);
    const session = ++recordSessionRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!disposedRef.current) setErrorMsg('Microphone is not available on this device.');
      return;
    }
    // The permission prompt can outlive the component (sheet closed, context
    // switched while it was open): a late stream is stopped on the spot and
    // never recorded from.
    if (disposedRef.current || session !== recordSessionRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (disposedRef.current || session !== recordSessionRef.current) return;
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size === 0) { setRecordState('idle'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (disposedRef.current || session !== recordSessionRef.current) return;
        setVoiceNoteData(reader.result as string);
        setRecordState('preview');
      };
      reader.readAsDataURL(blob);
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setElapsed(0);
    setRecordState('recording');
    // The 2-minute cap runs on real elapsed time, not tick counts — a
    // throttled interval can never stretch a recording past the cap.
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(Math.min(secs, MAX_RECORD_SECONDS));
      if (secs >= MAX_RECORD_SECONDS) stopRecording();
    }, 250);
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
    if (tagVenueRef.current !== venueId) return; // tags are re-made for the new venue first
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
        mentions: tagged.map((t) => t.id),
        mentionAll: tagAll,
        private: isPrivate && canPrivate,
      }),
    });
    setSending(false);
    if (!result.ok) {
      // Keep the text, the recording, the tags and Private so nothing is lost (plan Q5).
      const code = result.code || (result.data as any)?.code;
      setErrorMsg(code === 'PRIVATE_NEEDS_TAG' || code === 'MENTION_NOT_ON_TEAM' || code === 'NOTE_TOO_LONG'
        ? (result.error || "Couldn't send — try again")
        : "Couldn't send — try again");
      return;
    }
    if (result.data?.note) onPosted(result.data.note);
    setContent('');
    setTagged([]);
    setTagAll(false);
    setIsPrivate(false);
    setMentionQ(null);
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
            const tagNames = (note.mentions || []).map((m) => m.name);
            const taggedMe = !mine && (!!note.mentionAll || (note.mentions || []).some((m) => m.id === currentUserId));
            const sc = seenCounts[note.id];
            const seenText = sc ? seenLabel(sc.seen, sc.total) : '';
            return (
              <article
                key={note.id}
                {...(unread ? { 'data-mark-kind': 'n', 'data-mark-id': note.id } : {})}
                data-note-id={note.id}
                {...(note.private ? { 'data-note-private': '1' } : {})}
                className="p-3 rounded-xl border border-line bg-surface"
              >
                {note.private && (
                  <p
                    data-private-label
                    className="flex items-center gap-1.5 -mx-1 mb-2 px-2 py-1.5 rounded-lg text-sm font-bold bg-gold-wash text-gold-ink"
                  >
                    <Lock className="w-4 h-4 shrink-0" />
                    <span dir="auto">{privateNotice(tagNames, 'posted')}</span>
                  </p>
                )}
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
                    {taggedMe && (
                      <span data-tagged-you className="inline-flex items-center gap-0.5 text-xs font-bold px-2 py-0.5 rounded-full bg-gold text-white">
                        <AtSign className="w-3 h-3" /> Tagged you
                      </span>
                    )}
                  </div>
                  {!readOnly && canDelete(note) && confirmId !== note.id && (
                    <button
                      type="button"
                      onClick={() => setConfirmId(note.id)}
                      aria-label="Delete this note"
                      className="pressable w-11 h-11 -mt-2 -mr-2 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink transition cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-faint mt-0.5">
                  {formatNoteTime(note.createdAt)}
                </p>
                {confirmId === note.id && (
                  <div className="flex items-center gap-2 mt-2 p-2 rounded-lg" style={{ backgroundColor: 'var(--bad-bg)' }}>
                    <span className="text-sm font-bold flex-1" style={{ color: 'var(--bad)' }}>Delete this note?</span>
                    <button
                      type="button"
                      onClick={() => { setConfirmId(null); void remove(note.id); }}
                      className="pressable px-3 h-11 rounded-lg text-sm font-bold cursor-pointer"
                      style={{ backgroundColor: 'var(--bad)', color: 'var(--bad-bg)' }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="pressable px-3 h-11 rounded-lg border border-line bg-surface text-sm font-bold cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {note.content && (
                  <p dir="auto" className={`text-base whitespace-pre-wrap mt-1.5 ${unread ? 'font-semibold' : ''}`}>
                    {splitMentions(note.content, tagNames, !!note.mentionAll).map((part, i) =>
                      part.mention
                        ? <span key={i} className="font-bold text-gold-deep">{part.text}</span>
                        : <React.Fragment key={i}>{part.text}</React.Fragment>
                    )}
                  </p>
                )}
                {(tagNames.length > 0 || note.mentionAll) && (
                  <p className="text-xs text-ink-soft mt-1" dir="auto">
                    Tagged: {note.mentionAll ? (tagNames.length ? `All, ${joinNames(tagNames)}` : 'All (everyone at this venue)') : joinNames(tagNames)}
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
                      className="flex-1 h-11 min-w-0"
                    />
                    <div className="flex rounded-lg border border-line overflow-hidden shrink-0" role="group" aria-label="Playback speed">
                      {[1, 1.5].map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRate(note.id, r)}
                          className={`pressable px-3 h-11 text-sm font-bold cursor-pointer ${rate === r ? 'bg-ink text-paper' : 'text-ink-soft'}`}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!readOnly && seenText && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      data-seen-by={note.id}
                      onClick={() => void openSeen(note.id)}
                      aria-expanded={seenOpen === note.id}
                      className="pressable inline-flex items-center gap-1.5 min-h-11 -ml-1 px-1 text-sm font-semibold text-ink-soft cursor-pointer"
                    >
                      <CheckCheck className="w-4 h-4" /> {seenText}
                    </button>
                    {seenOpen === note.id && (
                      <div data-seen-list className="mt-1 p-2.5 rounded-lg bg-sunken text-sm space-y-1.5">
                        {!seenList ? (
                          <p className="text-ink-faint">Loading…</p>
                        ) : (
                          <>
                            <p className="font-bold">Seen</p>
                            {seenList.seen.length === 0 ? <p className="text-ink-faint">Nobody yet</p> : seenList.seen.map((r, i) => (
                              <p key={`s${i}`} className="flex justify-between gap-2"><span dir="auto">{r.name}</span><span className="text-ink-faint shrink-0">{formatNoteTime(r.at)}</span></p>
                            ))}
                            {seenList.notYet.length > 0 && <p className="font-bold pt-1">Not yet</p>}
                            {seenList.notYet.map((r, i) => (
                              <p key={`n${i}`} className="text-ink-soft" dir="auto">{r.name}</p>
                            ))}
                          </>
                        )}
                      </div>
                    )}
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
          {mentionQ && teamFailed && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-sunken text-sm">
              <span className="flex-1">Couldn't load the team.</span>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setTeamTry((n) => n + 1)} className="pressable px-3 min-h-11 rounded-lg border border-line font-bold cursor-pointer">Retry</button>
            </div>
          )}
          {pickRows.length > 0 && (
            <div data-mention-picker role="listbox" aria-label="Tag someone" className="rounded-xl border border-line bg-surface shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              {pickRows.map((row, i) => (
                <button
                  key={row.kind === 'all' ? '@all' : row.m.id}
                  type="button"
                  role="option"
                  aria-selected={i === pickIndex}
                  data-mention-option={row.kind === 'all' ? 'all' : row.m.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(row)}
                  className={`pressable w-full flex items-center gap-3 px-3 min-h-12 text-left cursor-pointer ${i === pickIndex ? 'bg-gold-wash' : ''}`}
                >
                  <span className="w-8 h-8 rounded-full bg-sunken flex items-center justify-center text-sm font-bold shrink-0">
                    {row.kind === 'all' ? <AtSign className="w-4 h-4" /> : (row.m.name || '?').slice(0, 1).toUpperCase()}
                  </span>
                  {row.kind === 'all' ? (
                    <span className="min-w-0"><span className="block text-base font-bold">All</span><span className="block text-xs text-ink-faint">Everyone at this venue</span></span>
                  ) : (
                    <span className="min-w-0"><span className="block text-base font-semibold truncate" dir="auto">{row.m.name}</span><span className="block text-xs text-ink-faint capitalize">{row.m.role}</span></span>
                  )}
                </button>
              ))}
            </div>
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
              ref={textRef}
              value={content}
              onChange={(e) => { setContent(e.target.value); updateMentionQuery(e.target.value, e.target.selectionStart); }}
              onKeyDown={onComposerKey}
              onSelect={(e) => updateMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
              onBlur={() => setTimeout(() => { if (!disposedRef.current) setMentionQ(null); }, 150)}
              placeholder="Note… type @ to tag"
              aria-label="Note for the next shift"
              rows={1}
              className="flex-1 px-3 py-3 text-base rounded-lg bg-surface border border-line min-w-0 resize-none"
            />
          </div>

          {(tagged.length > 0 || tagAll) && (
            <div className="flex flex-wrap gap-1.5" aria-label="Tagged">
              {tagAll && (
                <button type="button" data-tag-chip="All" onClick={() => { setTagAll(false); setContent((c) => removeTagText(c, 'All')); }} aria-label="Remove All"
                  className="pressable inline-flex items-center gap-1 pl-2.5 pr-1.5 min-h-9 rounded-full bg-gold-wash text-gold-ink text-sm font-bold cursor-pointer">
                  @All <X className="w-3.5 h-3.5" />
                </button>
              )}
              {tagged.map((t) => (
                <button key={t.id} type="button" data-tag-chip={t.name} onClick={() => { setTagged((list) => list.filter((x) => x.id !== t.id)); setContent((c) => removeTagText(c, t.name)); }} aria-label={`Remove ${t.name}`}
                  className="pressable inline-flex items-center gap-1 pl-2.5 pr-1.5 min-h-9 rounded-full bg-gold-wash text-gold-ink text-sm font-bold cursor-pointer">
                  <span dir="auto">@{t.name}</span> <X className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
              <button
                type="button"
                data-private-toggle
                onClick={() => canPrivate && setIsPrivate((p) => !p)}
                disabled={!canPrivate}
                aria-pressed={isPrivate}
                title={canPrivate ? 'Only the tagged people, admins and coordinators will see it' : 'Tag someone to send privately'}
                className={`pressable flex items-center justify-center gap-1.5 px-3 h-11 rounded-xl border text-sm font-bold disabled:opacity-40 transition cursor-pointer ${isPrivate ? 'bg-ink text-paper border-ink' : 'border-line'}`}
              >
                <Lock className="w-4 h-4" /> Private
              </button>
            <span className="text-xs text-ink-faint" dir="auto">
              {canPrivate
                ? (isPrivate ? '' : 'Only the tagged people, admins and coordinators')
                : tagAll ? '@All notes are for everyone' : 'Tag someone with @ to send privately'}
            </span>
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
              {isPrivate ? <Lock className="w-5 h-5" /> : <Send className="w-5 h-5" />}
              {sending ? 'Sending…' : isPrivate ? 'Send privately' : 'Send note'}
            </button>
          </div>
          {isPrivate && canPrivate ? (
            <p data-private-notice className="flex items-start gap-1.5 p-2 rounded-lg text-sm font-bold bg-gold-wash text-gold-ink">
              <Lock className="w-4 h-4 mt-0.5 shrink-0" />
              <span dir="auto">{privateNotice(tagged.map((t) => t.name), 'compose')}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
