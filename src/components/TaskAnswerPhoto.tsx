import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X } from 'lucide-react';
import { Task, TaskAnswerPhoto as AnswerPhotoRef } from '../types';
import { apiFetch, apiWrite } from '../lib/api';
import { formatExactTime } from '../lib/utils';

/** PHOTOALL (Don, Oct 27): every answer-type check can carry ONE optional photo. */
export const ANSWER_PHOTO_TYPES = ['toggle', 'yes_no', 'status_select', 'checkbox'] as const;
export const takesAnswerPhoto = (task: Pick<Task, 'inputType'>): boolean =>
  (ANSWER_PHOTO_TYPES as readonly string[]).includes(task.inputType);
/** The server's cap (base64 data-URL characters). */
export const ANSWER_PHOTO_MAX_CHARS = 400_000;
export const ANSWER_PHOTO_CAPTION_MAX = 200;

/** The check-in compression (≤ 800 px, JPEG 0.7), stepping down only if a photo is still over the cap. */
const STEPS: Array<[number, number]> = [[800, 0.7], [800, 0.55], [640, 0.5], [480, 0.45]];
export function compressPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode'));
      img.onload = () => {
        let out = '';
        for (const [max, q] of STEPS) {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
          out = canvas.toDataURL('image/jpeg', q);
          if (out.length <= ANSWER_PHOTO_MAX_CHARS) break;
        }
        resolve(out);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Bytes already fetched this session, by photo id (a photo never changes under its id).
const bytesCache = new Map<string, string>();

interface Props {
  task: Task;
  /** May this person record the answer (and so add or remove the photo)? */
  canAttach: boolean;
  /** 'kiosk' = the wall tablet's larger targets and text. */
  size?: 'phone' | 'kiosk';
}

/**
 * The photo row under the answer: "Add photo" (camera or gallery) for people
 * who may answer; after a photo is saved, a thumbnail with who and when that
 * opens full size on tap. Renders nothing for other task types, and nothing
 * for a read-only viewer when there is no photo.
 */
export const TaskAnswerPhoto: React.FC<Props> = ({ task, canAttach, size = 'phone' }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  // The server's answer, until the task itself (live update) catches up.
  const [override, setOverride] = useState<{ basis: string | null; ref: AnswerPhotoRef | null } | null>(null);
  const live = task.answerPhoto || null;
  const shown = override && override.basis === (live?.id ?? null) ? override.ref : live;
  const [src, setSrc] = useState<string | null>(shown ? bytesCache.get(shown.id) || null : null);

  useEffect(() => {
    if (!shown) { setSrc(null); return; }
    const cached = bytesCache.get(shown.id);
    if (cached) { setSrc(cached); return; }
    setSrc(null);
    let gone = false;
    apiFetch(`/api/tasks/${encodeURIComponent(task.id)}/answer-photo?photoId=${encodeURIComponent(shown.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (gone || !j || typeof j.photoData !== 'string') return;
        bytesCache.set(shown.id, j.photoData);
        setSrc(j.photoData);
      })
      .catch(() => { /* the thumbnail stays a placeholder */ });
    return () => { gone = true; };
  }, [task.id, shown?.id]);

  if (!takesAnswerPhoto(task)) return null;
  if (!shown && !draft && !canAttach) return null;

  const k = size === 'kiosk';
  const btn = k
    ? 'min-h-16 px-4 text-base gap-2 rounded-xl'
    : 'min-h-11 px-3 text-xs gap-2 rounded-xl';
  const icon = k ? 'w-6 h-6' : 'w-4 h-4';
  const text = k ? 'text-base' : 'text-xs';

  const pick = async (file: File) => {
    setError(null);
    try {
      const data = await compressPhoto(file);
      if (data.length > ANSWER_PHOTO_MAX_CHARS) { setError('That photo is too large. Try another one.'); return; }
      setDraft(data);
      setCaption('');
    } catch {
      setError('Could not read that photo. Try another one.');
    }
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    const basis = live?.id ?? null;
    const result = await apiWrite(`/api/tasks/${encodeURIComponent(task.id)}/answer-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoData: draft, photoCaption: caption.trim() || undefined }),
    });
    setBusy(false);
    if (result.ok && result.data?.answerPhoto?.id) {
      bytesCache.set(result.data.answerPhoto.id, draft);
      setOverride({ basis, ref: result.data.answerPhoto });
      setDraft(null);
      setCaption('');
    } else {
      setError(result.error || 'The photo was not saved. Please try again.');
    }
  };

  const remove = async () => {
    if (!shown || busy) return;
    setBusy(true);
    setError(null);
    const basis = live?.id ?? null;
    const result = await apiWrite(
      `/api/tasks/${encodeURIComponent(task.id)}/answer-photo?photoId=${encodeURIComponent(shown.id)}`,
      { method: 'DELETE' }
    );
    setBusy(false);
    if (result.ok) {
      setOverride({ basis, ref: result.data?.answerPhoto || null });
      setFull(false);
    } else {
      setError(result.error || 'The photo was not removed. Please try again.');
    }
  };

  const who = shown ? (shown.byName || shown.byEmail || 'Someone') : '';

  return (
    <div data-answer-photo className={`mt-2 flex flex-col gap-2 ${text}`}>
      {shown && (
        <div className="flex items-center gap-3 rounded-xl bg-sunken border border-line p-2">
          <button
            type="button"
            data-answer-photo-thumb
            onClick={() => src && setFull(true)}
            aria-label="Open the photo full size"
            className={`pressable shrink-0 overflow-hidden rounded-lg border border-line bg-surface cursor-pointer ${k ? 'w-20 h-20' : 'w-14 h-14'}`}
          >
            {src ? (
              <img src={src} alt={shown.caption || 'Photo'} className="w-full h-full object-cover" />
            ) : (
              <span className="w-full h-full flex items-center justify-center text-ink-faint">
                <Camera className={icon} aria-hidden />
              </span>
            )}
          </button>
          <div className="min-w-0 flex-1">
            {shown.caption && <p dir="auto" className="font-semibold text-ink break-words">{shown.caption}</p>}
            <p className="text-ink-soft truncate">
              Photo by <span className="font-semibold text-ink">{who}</span> · {formatExactTime(shown.at)}
            </p>
          </div>
          {canAttach && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              title="Remove the photo"
              aria-label="Remove the photo"
              className={`pressable shrink-0 flex items-center justify-center rounded-lg text-ink-faint hover:text-bad cursor-pointer ${k ? 'w-16 h-16' : 'w-11 h-11'}`}
            >
              <X className={icon} aria-hidden />
            </button>
          )}
        </div>
      )}

      {draft && (
        <div className="flex flex-col gap-2 rounded-xl bg-sunken border border-line p-2">
          <div className="flex items-center gap-3">
            <img src={draft} alt="New photo" className={`shrink-0 rounded-lg border border-line object-cover ${k ? 'w-20 h-20' : 'w-14 h-14'}`} />
            <input
              type="text"
              dir="auto"
              value={caption}
              maxLength={ANSWER_PHOTO_CAPTION_MAX}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Caption (optional)"
              aria-label="Photo caption (optional)"
              className={`min-w-0 flex-1 rounded-lg bg-surface border border-line px-2 text-ink placeholder-ink-faint focus:outline-none focus:border-gold ${k ? 'min-h-16 text-base' : 'min-h-11 text-sm'}`}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className={`pressable flex-1 flex items-center justify-center font-bold border border-gold-deep bg-gold-deep text-paper cursor-pointer ${btn}`}
            >
              {busy ? 'Saving…' : 'Save photo'}
            </button>
            <button
              type="button"
              onClick={() => { setDraft(null); setCaption(''); }}
              disabled={busy}
              className={`pressable flex items-center justify-center font-bold border border-line bg-surface text-ink-soft cursor-pointer ${btn}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {canAttach && !draft && (
        <label
          data-answer-photo-add
          className={`pressable self-start flex items-center font-bold border border-line bg-sunken text-ink-soft hover:text-ink cursor-pointer ${btn}`}
          title={shown ? 'Take or choose a new photo (replaces this one)' : 'Add a photo (optional)'}
        >
          <Camera className={icon} aria-hidden />
          <span>{shown ? 'Change photo' : 'Add photo'}</span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pick(file);
              e.target.value = '';
            }}
          />
        </label>
      )}

      {error && <p role="alert" className="text-bad font-semibold">{error}</p>}

      {full && src && shown && typeof document !== 'undefined' && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo"
          data-answer-photo-full
          onClick={() => setFull(false)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-scrim backdrop-blur-sm p-4"
        >
          <img src={src} alt={shown.caption || 'Photo'} className="max-w-full max-h-[75vh] rounded-lg object-contain" />
          <div className="max-w-md rounded-xl bg-surface border border-line px-3 py-2 text-sm text-ink text-center">
            {shown.caption ? <p dir="auto" className="font-semibold break-words">{shown.caption}</p> : null}
            <p className="text-ink-soft">Photo by {who} · {formatExactTime(shown.at)}</p>
          </div>
          <button
            type="button"
            onClick={() => setFull(false)}
            className="pressable min-h-11 px-4 rounded-xl border border-line bg-surface text-sm font-bold text-ink cursor-pointer"
          >
            Close
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};
