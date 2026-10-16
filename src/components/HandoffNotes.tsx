import React, { useState, useEffect } from 'react';
import { MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface HandoffNote {
  id: string;
  venueId: string;
  authorEmail: string;
  authorName: string;
  content: string;
  shift: string;
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

  const addNote = async () => {
    if (!content.trim()) return;
    try {
      const res = await apiFetch('/api/handoff-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          content: content.trim(),
          shift,
          authorEmail: currentUserEmail,
          authorName: currentUserName,
        }),
      });
      const data = await res.json();
      if (data.note) {
        setNotes([data.note, ...notes]);
        setContent('');
        setShowAdd(false);
      }
    } catch (e) {
      console.error('Failed to add note:', e);
    }
  };

  const deleteNote = async (id: string) => {
    try {
      await apiFetch(`/api/handoff-notes/${id}`, { method: 'DELETE' });
      setNotes(notes.filter((n) => n.id !== id));
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
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

      {showAdd && (
        <div className="p-3 rounded-xl border border-line bg-sunken space-y-2">
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
          <button
            onClick={addNote}
            disabled={!content.trim()}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-gold text-white disabled:opacity-50 transition cursor-pointer"
          >
            Save Note
          </button>
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
