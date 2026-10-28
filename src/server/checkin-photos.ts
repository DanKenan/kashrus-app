/**
 * CHECKINPHOTO (Don, Oct 28 2026: "Sure do it"): check-in photos ("Log check
 * with photo evidence") live OUTSIDE app-state/main, in the same photo store
 * as the answer photos (#176): taskPhotos/{taskId}__{photoId}. The check-in
 * record in the shared document keeps only a small reference
 * ({id, byName, byEmail, at, photoId, photoCaption?}) and never base64, so
 * photos no longer grow the document toward its 900 KiB guard (the guard
 * itself is unchanged).
 *
 * Older check-ins that already carry inline base64 (photoData) are read and
 * shown exactly as before; nothing here rewrites them (they leave the document
 * at the next daily reset, which clears check-ins, or at the 30-day expiry).
 *
 * Rule: a photo problem never loses the check-in itself. If the photo is too
 * large, not an image, cannot be stored, or the save took too long, the
 * check-in is still logged (without the photo) and the client says the photo
 * was not saved.
 */

/** Photo ids of check-in photos (answer photos use 'aph-'). */
export const CHECKIN_PHOTO_ID_PREFIX = 'cph-';
const CHECKIN_PHOTO_ID_RE = /^cph-[A-Za-z0-9-]{8,64}$/;

/** Same key format as the answer photos (one store, one sweep). */
export const checkInPhotoKey = (taskId: string, photoId: string): string => `${taskId}__${photoId}`;

export type CheckInPhotoVerdict = 'none' | 'ok' | 'MEDIA_TOO_LARGE' | 'BAD_MEDIA';

/**
 * What to do with the photo sent with a check-in. `none` = no photo was sent
 * (undefined / null / ''). The size cap and the data-URL pattern are the
 * answer-photo ones, passed in by the caller.
 */
export function classifyCheckInPhoto(photoData: unknown, maxChars: number, dataRe: RegExp): CheckInPhotoVerdict {
  if (photoData === undefined || photoData === null || photoData === '') return 'none';
  if (typeof photoData !== 'string') return 'BAD_MEDIA';
  if (photoData.length > maxChars) return 'MEDIA_TOO_LARGE';
  return dataRe.test(photoData) ? 'ok' : 'BAD_MEDIA';
}

/** A stored check-in's photo reference, or null (old inline photos have none). */
export function checkInPhotoIdOf(checkIn: any): string | null {
  const id = checkIn && typeof checkIn.photoId === 'string' ? checkIn.photoId : null;
  return id && CHECKIN_PHOTO_ID_RE.test(id) ? id : null;
}

/** Store keys of every check-in photo a task references (for the sweep). */
export function checkInPhotoKeys(task: any): string[] {
  if (!task || typeof task.id !== 'string' || !Array.isArray(task.checkIns)) return [];
  const keys: string[] = [];
  for (const c of task.checkIns) {
    const pid = checkInPhotoIdOf(c);
    if (pid) keys.push(checkInPhotoKey(task.id, pid));
  }
  return keys;
}

/**
 * 30-day media expiry for one check-in (as before for inline photos; the
 * reference of a stored photo goes too, and the sweep then removes its bytes).
 * Returns the same object when nothing expires.
 */
export function expireCheckInPhoto<T extends Record<string, any>>(checkIn: T, cutoffIso: string): T {
  if (!checkIn || !(checkIn.at < cutoffIso) || (!checkIn.photoData && !checkIn.photoId)) return checkIn;
  const copy: any = { ...checkIn };
  delete copy.photoData;
  delete copy.photoId;
  return copy;
}

interface ReadDeps {
  requireAuthUser: (req: any, res: any) => any | null;
  findTask: (id: string) => any | undefined;
  /** The answer-photo read gate (agency, kiosk scope / RULE T + private-task rule). Answers the refusal itself. */
  gate: (req: any, res: any, task: any, caller: any) => boolean;
  getPhotoDoc: (key: string) => Promise<any | null>;
  log: { error: (...a: any[]) => void };
}

/**
 * GET /api/tasks/:id/check-in/:checkInId/photo — the bytes of one check-in
 * photo, behind the same visibility as the task itself. Serves a stored photo
 * (new) and an inline one (old) alike.
 */
export function registerCheckInPhotoRead(app: any, deps: ReadDeps): void {
  app.get('/api/tasks/:id/check-in/:checkInId/photo', async (req: any, res: any) => {
    const caller = deps.requireAuthUser(req, res);
    if (!caller) return;
    const { id, checkInId } = req.params;
    const task = deps.findTask(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!deps.gate(req, res, task, caller)) return;
    const entry = (Array.isArray(task.checkIns) ? task.checkIns : []).find((c: any) => c && c.id === checkInId);
    if (!entry) return res.status(404).json({ error: 'No photo' });
    res.set('Cache-Control', 'private, no-store');
    const pid = checkInPhotoIdOf(entry);
    if (!pid) {
      if (typeof entry.photoData === 'string' && entry.photoData) return res.json({ id: checkInId, photoData: entry.photoData });
      return res.status(404).json({ error: 'No photo' });
    }
    let doc: any = null;
    try {
      doc = await deps.getPhotoDoc(checkInPhotoKey(id, pid));
    } catch (e) {
      deps.log.error('[checkin-photo] read failed:', e);
      return res.status(503).json({ error: 'Could not load the photo. Please try again.' });
    }
    const agencyId = task.agencyId || 'agency-hkc';
    if (!doc || doc.taskId !== id || doc.checkInId !== checkInId || (doc.agencyId || 'agency-hkc') !== agencyId || typeof doc.photoData !== 'string') {
      return res.status(404).json({ error: 'No photo' });
    }
    res.json({ id: pid, photoData: doc.photoData });
  });
}
