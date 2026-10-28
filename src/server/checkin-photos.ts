/**
 * CHECKINPHOTO (Don, Oct 28 2026: "Sure do it"): check-in photos ("Log check
 * with photo evidence") live OUTSIDE app-state/main, in the separate photo
 * storage built for the answer photos (#176): one Firestore document per photo
 * (no-Firestore mode: one JSON file per photo under DATA_DIR), the same cap,
 * format and orphan sweep. They use their OWN collection, checkInPhotos/
 * {taskId}__{photoId} (local: DATA_DIR/checkin-photos), so a server revision
 * that predates this change (during a rolling deploy or after a rollback),
 * whose sweep only knows answer photos, never enumerates or deletes them.
 *
 * The check-in record in the shared document keeps only a small reference
 * ({id, byName, byEmail, at, photoId, photoCaption?}) and never base64, so
 * photos no longer grow the document toward its 900 KiB guard (the guard
 * itself is unchanged).
 *
 * Older check-ins that already carry inline base64 (photoData) are read and
 * shown exactly as before; nothing here rewrites them (they leave the document
 * at the next daily reset, which clears check-ins, or at the 30-day expiry).
 *
 * Rule: a photo problem never loses the check-in itself. If the photo is too
 * large, not an image, cannot be stored (or the store does not answer in
 * time), or the save took too long, the check-in is still logged (without the
 * photo) and the client says the photo was not saved.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Photo ids of check-in photos (answer photos use 'aph-'). */
export const CHECKIN_PHOTO_ID_PREFIX = 'cph-';
const CHECKIN_PHOTO_ID_RE = /^cph-[A-Za-z0-9-]{8,64}$/;
export const CHECKIN_PHOTO_COLLECTION = 'checkInPhotos';
/** How long a check-in waits for the photo store before it is logged without the photo. */
export const CHECKIN_PHOTO_STORE_TIMEOUT_MS = 15_000;

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

/** Resolves with the promise, or rejects after `ms` (the promise itself keeps running). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

interface StoreDeps {
  /** The Firestore handle, or null in no-Firestore (local file) mode. */
  db: () => any;
  dataDir: string;
  /** Path of the shared document (the sweep reads the STORED references from it). */
  stateDocPath: string;
  /** This instance's tasks (no-Firestore mode). */
  memoryTasks: () => any[];
  /** An unreferenced photo younger than this is a save still in flight. */
  graceMs: number;
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void };
}

/** The check-in photo store (bytes outside the shared document). */
export function createCheckInPhotoStore(deps: StoreDeps) {
  const localDir = path.join(deps.dataDir, 'checkin-photos');
  const localFile = (key: string) => path.join(localDir, `${encodeURIComponent(key)}.json`);
  // TEST ONLY (set through the test route). staleCheckInIds: the GET route acts as an
  // instance whose cache has not seen these check-ins yet; failStoredRead: the
  // authoritative read fails.
  const testHooks = { storeDelayMs: 0, storeTimeoutMs: 0, failStore: false, staleCheckInIds: [] as string[], failStoredRead: false };

  async function put(key: string, doc: any): Promise<void> {
    if (testHooks.storeDelayMs > 0) await new Promise((r) => setTimeout(r, testHooks.storeDelayMs));
    if (testHooks.failStore) throw new Error('test: store unavailable');
    const db = deps.db();
    if (!db) {
      await fs.promises.mkdir(localDir, { recursive: true });
      const file = localFile(key);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(doc));
      await fs.promises.rename(tmp, file);
      return;
    }
    await db.collection(CHECKIN_PHOTO_COLLECTION).doc(key).set(doc);
  }
  async function get(key: string): Promise<any | null> {
    const db = deps.db();
    if (!db) {
      try { return JSON.parse(await fs.promises.readFile(localFile(key), 'utf8')); }
      catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
    }
    const snap = await db.collection(CHECKIN_PHOTO_COLLECTION).doc(key).get();
    return snap.exists ? snap.data() : null;
  }
  /** Best effort: never throws (an orphan is removed by the next sweep). */
  async function remove(key: string): Promise<void> {
    try {
      const db = deps.db();
      if (!db) {
        await fs.promises.unlink(localFile(key)).catch((e: any) => { if (e?.code !== 'ENOENT') throw e; });
        return;
      }
      await db.collection(CHECKIN_PHOTO_COLLECTION).doc(key).delete();
    } catch (e) {
      deps.log.warn('[checkin-photo] delete failed:', (e as any)?.message);
    }
  }
  /**
   * Store the bytes, waiting at most the store timeout. Answers true when they
   * are stored; false (logged) when the store failed or did not answer in time
   * — a late write that lands afterwards is unreferenced and swept after the grace.
   */
  async function putBounded(key: string, doc: any): Promise<boolean> {
    try {
      await withTimeout(put(key, doc), testHooks.storeTimeoutMs > 0 ? testHooks.storeTimeoutMs : CHECKIN_PHOTO_STORE_TIMEOUT_MS);
      return true;
    } catch (e) {
      deps.log.warn('[checkin-photo] not stored; logging the check-in without it:', (e as any)?.message);
      return false;
    }
  }
  /** Removes photos no check-in references any more, after the in-flight grace. Never throws. */
  async function sweep(nowMs: number = Date.now()): Promise<number> {
    try {
      // References from the STORED document when there is one (another server
      // instance may have committed a check-in this cache has not seen yet); a
      // failed or empty read aborts the sweep (nothing is deleted).
      const db = deps.db();
      let taskList: any[] = deps.memoryTasks();
      if (db) {
        const snap = await db.doc(deps.stateDocPath).get();
        const stored = snap && snap.exists ? snap.data() : null;
        if (!stored || !Array.isArray(stored.tasks)) return 0;
        taskList = stored.tasks;
      }
      const referenced = new Set<string>();
      for (const t of taskList) for (const k of checkInPhotoKeys(t)) referenced.add(k);
      let entries: Array<{ key: string; createdAt?: string }> = [];
      if (!db) {
        let names: string[] = [];
        try { names = await fs.promises.readdir(localDir); } catch { names = []; }
        for (const n of names) {
          if (!n.endsWith('.json')) continue;
          const key = decodeURIComponent(n.slice(0, -5));
          const d = await get(key).catch(() => null);
          entries.push({ key, createdAt: d?.createdAt });
        }
      } else {
        let q: any = db.collection(CHECKIN_PHOTO_COLLECTION);
        if (typeof q.select === 'function') q = q.select('createdAt');
        const snap = await q.get();
        entries = (snap.docs || []).map((d: any) => ({ key: d.id, createdAt: d.data()?.createdAt }));
      }
      let removed = 0;
      for (const e of entries) {
        if (referenced.has(e.key)) continue;
        const created = Date.parse(e.createdAt || '');
        if (Number.isFinite(created) && nowMs - created < deps.graceMs) continue;
        await remove(e.key);
        removed++;
      }
      if (removed > 0) deps.log.info(`[checkin-photo] swept ${removed} unreferenced photo(s)`);
      return removed;
    } catch (e) {
      deps.log.warn('[checkin-photo] sweep failed:', (e as any)?.message);
      return 0;
    }
  }
  /**
   * RV3: one task as the STORED document has it (another server instance may
   * have committed a check-in this instance's cache has not seen yet). ok:false
   * = the read failed (the caller answers "try again", never "no photo").
   */
  async function readStoredTask(taskId: string): Promise<{ ok: true; task: any | null } | { ok: false }> {
    try {
      if (testHooks.failStoredRead) throw new Error('test: stored read unavailable');
      const db = deps.db();
      if (!db) return { ok: true, task: deps.memoryTasks().find((t: any) => t && t.id === taskId) || null };
      const snap = await db.doc(deps.stateDocPath).get();
      const stored = snap && snap.exists ? snap.data() : null;
      if (!stored || !Array.isArray(stored.tasks)) return { ok: false };
      return { ok: true, task: stored.tasks.find((t: any) => t && t.id === taskId) || null };
    } catch (e) {
      deps.log.warn('[checkin-photo] stored read failed:', (e as any)?.message);
      return { ok: false };
    }
  }
  return { put, putBounded, get, remove, sweep, readStoredTask, testHooks };
}

export type CheckInPhotoStore = ReturnType<typeof createCheckInPhotoStore>;

interface RouteDeps {
  store: CheckInPhotoStore;
  requireAuthUser: (req: any, res: any) => any | null;
  findTask: (id: string) => any | undefined;
  /** The answer-photo read gate (agency, kiosk scope / RULE T + private-task rule). Answers the refusal itself. */
  gate: (req: any, res: any, task: any, caller: any) => boolean;
  log: { error: (...a: any[]) => void };
  testMode: boolean;
  requireAdmin: (req: any, res: any) => any;
}

/**
 * GET /api/tasks/:id/check-in/:checkInId/photo — the bytes of one check-in
 * photo, behind the same visibility as the task itself. Serves a stored photo
 * (new) and an inline one (old) alike. Plus TEST-ONLY routes (test mode).
 */
export function registerCheckInPhotoRoutes(app: any, deps: RouteDeps): void {
  app.get('/api/tasks/:id/check-in/:checkInId/photo', async (req: any, res: any) => {
    const caller = deps.requireAuthUser(req, res);
    if (!caller) return;
    const { id, checkInId } = req.params;
    const entryOf = (t: any) => (t && Array.isArray(t.checkIns) ? t.checkIns : []).find((c: any) => c && c.id === checkInId);
    const stale = deps.testMode && deps.store.testHooks.staleCheckInIds.includes(checkInId);
    let task = deps.findTask(id);
    if (task && !deps.gate(req, res, task, caller)) return;
    let entry = task && !stale ? entryOf(task) : undefined;
    if (!task || !entry) {
      // RV3: this instance's cache may be behind another instance's commit
      // (the task answer came from there). Confirm against the STORED document
      // before a terminal "no photo"; a failed read is "try again" (503).
      const stored = await deps.store.readStoredTask(id);
      if (!stored.ok) return res.status(503).json({ error: 'Could not load the photo. Please try again.' });
      if (!task) {
        if (!stored.task) return res.status(404).json({ error: 'Task not found' });
        task = stored.task;
        if (!deps.gate(req, res, task, caller)) return;
      }
      const sameAgency = stored.task && (stored.task.agencyId || 'agency-hkc') === (task.agencyId || 'agency-hkc');
      entry = sameAgency ? entryOf(stored.task) : undefined;
      if (!entry) return res.status(404).json({ error: 'No photo' });
    }
    res.set('Cache-Control', 'private, no-store');
    const pid = checkInPhotoIdOf(entry);
    if (!pid) {
      if (typeof entry.photoData === 'string' && entry.photoData) return res.json({ id: checkInId, photoData: entry.photoData });
      return res.status(404).json({ error: 'No photo' });
    }
    let doc: any = null;
    try {
      doc = await deps.store.get(checkInPhotoKey(id, pid));
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

  if (deps.testMode) {
    // TEST ONLY: run the check-in photo sweep now (nowMs optional).
    app.post('/api/__test__/checkin-photo-sweep', async (req: any, res: any) => {
      if (!deps.requireAdmin(req, res)) return;
      const nowMs = typeof req.body?.nowMs === 'number' ? req.body.nowMs : Date.now();
      res.json({ removed: await deps.store.sweep(nowMs) });
    });
    // TEST ONLY: a slow / failing photo store.
    app.post('/api/__test__/checkin-photo-hooks', (req: any, res: any) => {
      if (!deps.requireAdmin(req, res)) return;
      const h = deps.store.testHooks;
      const num = (v: any) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
      h.storeDelayMs = num(req.body?.storeDelayMs);
      h.storeTimeoutMs = num(req.body?.storeTimeoutMs);
      h.failStore = req.body?.failStore === true;
      h.staleCheckInIds = Array.isArray(req.body?.staleCheckInIds) ? req.body.staleCheckInIds.filter((x: any) => typeof x === 'string') : [];
      h.failStoredRead = req.body?.failStoredRead === true;
      res.json({ ...h });
    });
  }
}
