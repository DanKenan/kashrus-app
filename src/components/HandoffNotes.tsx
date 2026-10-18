import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, Plus, Trash2, X, Mic } from 'lucide-react';
import { apiFetch, apiWrite } from '../lib/api';

interface HandoffNote {
  id: string;
  venueId: string;
  authorEmail: string;
  authorName: string;
  content: string;
  shift: string;
  voiceNoteData?: string;
  createdAt: string;
}

interface HandoffNotesProps {
  venueId: string;
  currentUserEmail: string;
  currentUserName: string;
}

export function HandoffNotes({ venueId, currentUserEmail, currentUserName }: HandoffNotesProps) {
  const [notes, setNotes] = useState<HandoffNote[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [content, setContent] = useState('');
  const [shift, setShift] = useState('Morning');
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const [voiceNoteData, setVoiceNoteData] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    loadNotes();
  }, [venueId]);

  const loadNotes = async () => {
    try {
      const res = await apiFetch(`/api/handoff-notes?venueId=${venueId}`);
      const data = await res.json();
      setNotes(data.notes || []);
    } catch (e) {
      console.error('Failed to load handoff notes:', e);
    } finally {
      setLoading(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => setVoiceNoteData(reader.result as string);
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      console.error('Mic access denied:', e);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const addNote = async () => {
    if (!content.trim() && !voiceNoteData) return;
    setErrorMsg(null);
    const result = await apiWrite('/api/handoff-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venueId,
        content: content.trim(),
        shift,
        authorEmail: currentUserEmail,
        authorName: currentUserName,
        voiceNoteData: voiceNoteData || undefined,
      }),
    });
    if (!result.ok) {
      // Keep the form open with the user's text intact so they can retry.
      setErrorMsg(result.error || 'Could not save the note.');
      return;
    }
    const note = result.data?.note;
    if (note) {
      setNotes([note, ...notes]);
      setContent('');
      setVoiceNoteData('');
      setShowAdd(false);
    }
  };

  const deleteNote = async (id: string) => {
    setErrorMsg(null);
    const result = await apiWrite(`/api/handoff-notes/${id}`, { method: 'DELETE' });
    if (!result.ok) {
      setErrorMsg(result.error || 'Could not delete the note.');
      return;
    }
    setNotes(notes.filter((n) => n.id !== id));
  };

  if (loading) return <div className="text-xs text-ink-faint">Loading notes...</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-gold-deep" />
          Shift Handoff Notes
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-gold/10 hover:bg-gold/20 text-gold-deep transition cursor-pointer"
        >
          {showAdd ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          {showAdd ? 'Cancel' : 'Add Note'}
        </button>
      </div>

      {!showAdd && errorMsg && (
        <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-[11px] text-rose-700 dark:text-rose-300">
          {errorMsg}
        </div>
      )}

      {showAdd && (
        <div className="p-3 rounded-xl border border-line bg-sunken space-y-2">
          {errorMsg && (
            <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-[11px] text-rose-700 dark:text-rose-300">
              {errorMsg}
            </div>
          )}
          <select
            value={shift}
            onChange={(e) => setShift(e.target.value)}
            className="w-full px-3 py-2 text-xs rounded-lg bg-white dark:bg-black border border-line"
          >
            <option>Morning</option>
            <option>Afternoon</option>
            <option>Evening</option>
            <option>General</option>
          </select>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Leave a note for the next shift... (e.g. Walk-in temp was 38°F, all good. Bakery delivery arrived late.)"
            className="w-full px-3 py-2 text-xs rounded-lg bg-white dark:bg-black border border-line min-h-[80px]"
          />
          <div className="flex gap-2">
            <button
              onClick={recording ? stopRecording : startRecording}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl border transition cursor-pointer text-xs font-bold ${
                recording
                  ? 'border-rose-500 bg-rose-500/10 text-rose-600 animate-pulse'
                  : 'border-line bg-white dark:bg-black hover:bg-line/20'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              {recording ? 'Stop recording' : voiceNoteData ? 'Re-record' : 'Voice note'}
            </button>
            <button
              onClick={addNote}
              disabled={!content.trim() && !voiceNoteData}
              className="flex-1 px-3 py-2 text-xs font-bold rounded-xl bg-gold text-white disabled:opacity-50 transition cursor-pointer"
            >
              Save Note
            </button>
          </div>
          {voiceNoteData && !recording && (
            <audio src={voiceNoteData} controls className="w-full h-8" />
          )}
        </div>
      )}

      {notes.length === 0 ? (
        <div className="text-xs text-ink-faint text-center py-4">
          No handoff notes yet. Leave one for the next shift.
        </div>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <div key={note.id} className="p-3 rounded-xl border border-line bg-white dark:bg-black">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gold/15 text-gold-deep">
                      {note.shift}
                    </span>
                    <span className="text-[11px] font-semibold">{note.authorName}</span>
                    <span className="text-[10px] text-ink-faint">
                      {new Date(note.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs whitespace-pre-wrap">{note.content}</p>
                  {note.voiceNoteData && (
                    <audio src={note.voiceNoteData} controls className="w-full h-8 mt-1.5" />
                  )}
                </div>
                {note.authorEmail === currentUserEmail && (
                  <button
                    onClick={() => deleteNote(note.id)}
                    className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 text-ink-faint hover:text-rose-600 transition cursor-pointer"
                    title="Delete note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
