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

/** One read of a stored photo: the bytes, confirmed gone, or worth another try. */
export type CheckInPhotoRead = { kind: 'ok'; data: string } | { kind: 'missing' } | { kind: 'retry' };

/**
 * RV2: tell a confirmed-missing photo (404/410, 403, or an answer with no
 * bytes) from a passing problem (offline, 5xx, 429, 401 while the session
 * refreshes): only the first hides the photo.
 */
export async function readCheckInPhoto(fetcher: (url: string) => Promise<Response>, url: string): Promise<CheckInPhotoRead> {
  try {
    const r = await fetcher(url);
    if (r.ok) {
      const j: any = await r.json().catch(() => null);
      return j && typeof j.photoData === 'string' ? { kind: 'ok', data: j.photoData } : { kind: 'missing' };
    }
    if (r.status === 404 || r.status === 410 || r.status === 403) return { kind: 'missing' };
    return { kind: 'retry' };
  } catch {
    return { kind: 'retry' };
  }
}

/** Waits between tries while a photo stays unreachable (the last one repeats). */
export const CHECKIN_PHOTO_RETRY_MS = [2000, 5000, 15000, 30000, 60000];

/**
 * RV2: load one photo and keep trying through passing problems for as long as
 * it is on screen: backoff on its own, at once when the device comes back
 * online (retryNow). Framework-free so it can be tested without a DOM.
 */
export function createCheckInPhotoLoader(opts: {
  read: () => Promise<CheckInPhotoRead>;
  onResult: (r: CheckInPhotoRead) => void;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (t: any) => void;
  delays?: number[];
}) {
  const setTimer = opts.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t: any) => clearTimeout(t));
  const delays = opts.delays && opts.delays.length ? opts.delays : CHECKIN_PHOTO_RETRY_MS;
  let stopped = false, done = false, inFlight = false, attempt = 0, timer: any = null;
  const run = async (): Promise<void> => {
    if (stopped || done || inFlight) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    inFlight = true;
    const r = await opts.read();
    inFlight = false;
    if (stopped) return;
    opts.onResult(r);
    if (r.kind === 'retry') {
      timer = setTimer(() => { timer = null; void run(); }, delays[Math.min(attempt, delays.length - 1)]);
      attempt++;
      return;
    }
    done = true;
  };
  return {
    start: run,
    retryNow: run,
    stop: () => { stopped = true; if (timer !== null) { clearTimer(timer); timer = null; } },
  };
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
    const url = checkInPhotoUrl(taskId, checkIn.id);
    const loader = createCheckInPhotoLoader({
      read: () => readCheckInPhoto(apiFetch, url),
      onResult: (r) => {
        if (r.kind === 'ok') { bytesCache.set(photoId, r.data); setSrc(r.data); }
        else if (r.kind === 'missing') setMissing(true);
        // 'retry': keep the placeholder; the loader tries again.
      },
    });
    const again = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void loader.retryNow(); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    void loader.start();
    return () => {
      loader.stop();
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
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
