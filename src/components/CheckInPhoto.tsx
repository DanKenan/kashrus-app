import React, { useEffect, useState } from 'react';
import { Task, TaskCheckIn } from '../types';
import { apiFetch } from '../lib/api';
import { ANSWER_PHOTO_MAX_CHARS } from './TaskAnswerPhoto';

/**
 * CHECKINPHOTO: the photo under one check-in, looking exactly as before (the
 * same <img>, the same tap-to-enlarge). New check-ins carry only a photoId and
 * the bytes come from the photo store on demand; older check-ins still carry
 * the photo inline (photoData) and show it straight away, as before.
 */

// Bytes already fetched (or just sent) this session, by photo id (a photo never changes under its id).
const bytesCache = new Map<string, string>();

/** Seed the cache with the photo this device just sent, so it does not flicker or load again. */
export function rememberCheckInPhoto(photoId: string, photoData: string): void {
  if (photoId && photoData) bytesCache.set(photoId, photoData);
}

/** Test hook: is this photo id cached? */
export function checkInPhotoCached(photoId: string): boolean {
  return bytesCache.has(photoId);
}

export const CHECKIN_PHOTO_TOO_LARGE = 'That photo is too large. Try another one.';
export const CHECKIN_PHOTO_NOT_SAVED = 'Check logged, but the photo could not be saved.';

/** Over the server's photo cap: the check-in is not sent (the person picks another photo). */
export function checkInPhotoTooLarge(photoData?: string): boolean {
  return typeof photoData === 'string' && photoData.length > ANSWER_PHOTO_MAX_CHARS;
}

/**
 * After a check-in WITH a photo was saved: find this person's new check-in in
 * the server's answer. Stored photo → keep the bytes we already have (no
 * reload, no flicker) and answer null. Logged without its photo (the server
 * could not keep it) → the message to show. Ambiguous (several new ones) → null.
 */
export function afterCheckInWithPhoto(beforeIds: ReadonlySet<string>, fresh: Pick<Task, 'checkIns'> | null | undefined, byEmail: string | null | undefined, photoData: string): string | null {
  const me = String(byEmail || '').toLowerCase();
  const added = (fresh?.checkIns || []).filter((c) => c && !beforeIds.has(c.id) && String(c.byEmail || '').toLowerCase() === me);
  if (added.length !== 1) return null;
  const mine = added[0];
  if (mine.photoId) { rememberCheckInPhoto(mine.photoId, photoData); return null; }
  if (mine.photoData) return null; // an older server kept it inline
  return CHECKIN_PHOTO_NOT_SAVED;
}

export function checkInPhotoUrl(taskId: string, checkInId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/check-in/${encodeURIComponent(checkInId)}/photo`;
}

interface Props {
  taskId: string;
  checkIn: TaskCheckIn;
  /** The classes of the <img> this replaces (phone card or kiosk). */
  className: string;
}

export const CheckInPhoto: React.FC<Props> = ({ taskId, checkIn, className }) => {
  const inline = checkIn.photoData || null;
  const photoId = !inline && checkIn.photoId ? checkIn.photoId : null;
  const [src, setSrc] = useState<string | null>(inline || (photoId ? bytesCache.get(photoId) || null : null));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setMissing(false);
    if (inline) { setSrc(inline); return; }
    if (!photoId) { setSrc(null); return; }
    const cached = bytesCache.get(photoId);
    if (cached) { setSrc(cached); return; }
    setSrc(null);
    let gone = false;
    apiFetch(checkInPhotoUrl(taskId, checkIn.id))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (gone) return;
        if (!j || typeof j.photoData !== 'string') { setMissing(true); return; }
        bytesCache.set(photoId, j.photoData);
        setSrc(j.photoData);
      })
      .catch(() => { if (!gone) setMissing(true); });
    return () => { gone = true; };
  }, [taskId, checkIn.id, inline, photoId]);

  if (!inline && !photoId) return null;
  if (!src) {
    if (missing) return null;
    // Loading: a quiet placeholder in the photo's place.
    return <div data-checkin-photo-loading aria-hidden className={`${className} h-24 bg-line/30 animate-pulse`} />;
  }
  return (
    <img
      data-checkin-photo
      src={src}
      alt={checkIn.photoCaption || 'Check-in photo'}
      className={className}
      onClick={() => {
        const w = window.open();
        if (w) {
          w.document.write(`<img src="${src}" style="max-width:100%"/>`);
        }
      }}
    />
  );
};
