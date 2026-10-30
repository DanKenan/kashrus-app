/**
 * READCUT (Oct 29 2026): a process-wide count of Firestore document reads.
 *
 * The live app hit the free-tier daily read quota (50,000 reads/day). This
 * meter patches the read methods of whatever Firestore object the server
 * uses (the real SDK, the emulator, or the stage2 mock) so every read is
 * counted by its collection, the way Google bills them: a document get = 1,
 * getAll = 1 per document, a query = 1 per document returned (minimum 1).
 * It changes no behaviour: each patched method calls the original and only
 * adds to a counter. A RESOURCE_EXHAUSTED answer (quota) is counted too.
 */

type Bucket = Record<string, number>;
const state = {
  total: 0,
  byCollection: {} as Bucket,
  exhausted: 0,
  sinceMs: Date.now(),
};
let windowStart = { total: 0, byCollection: {} as Bucket, exhausted: 0, atMs: Date.now() };
const PATCHED = '__shutfeyReadMeter';
let inDocGet = 0;

function collectionOfPath(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'unknown';
  const parts = path.split('/').filter(Boolean);
  // a subcollection counts under its own name
  return parts.length % 2 === 0 ? parts[parts.length - 2] : parts[parts.length - 1];
}
function collectionOfQuery(q: any): string {
  try {
    if (q && typeof q.path === 'string' && q.path) return collectionOfPath(q.path);
    const id = q?._queryOptions?.collectionId;
    if (typeof id === 'string' && id) return id;
    if (typeof q?._name === 'string') return q._name;
    if (typeof q?._collection === 'string') return q._collection;
  } catch { /* fall through */ }
  return 'query';
}

export function countRead(collection: string, n = 1): void {
  if (!(n > 0)) return;
  state.total += n;
  state.byCollection[collection] = (state.byCollection[collection] || 0) + n;
}

/** True for Google's "out of quota" answer (gRPC 8 / RESOURCE_EXHAUSTED / HTTP 429). */
export function isQuotaError(err: any): boolean {
  if (!err) return false;
  if (err.code === 8 || err.code === 'resource-exhausted' || err.code === 'RESOURCE_EXHAUSTED' || err.status === 429) return true;
  const msg = String(err.message || err);
  return /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

let lastQuotaErrorAtMs = 0;
function noteError(err: any): never {
  if (isQuotaError(err)) { state.exhausted++; lastQuotaErrorAtMs = Date.now(); }
  throw err;
}
/** Records a quota answer seen outside the patched reads (a commit). */
export function noteQuotaError(err: any): boolean {
  if (!isQuotaError(err)) return false;
  state.exhausted++;
  lastQuotaErrorAtMs = Date.now();
  return true;
}
/** Background jobs stand down while the store answered "out of quota" within this window (READCUT). */
export const QUOTA_BACKOFF_MS = 10 * 60 * 1000;
export function quotaBackoffActive(nowMs: number = Date.now()): boolean {
  return lastQuotaErrorAtMs > 0 && nowMs - lastQuotaErrorAtMs < QUOTA_BACKOFF_MS;
}
/** Test mode only. */
export function setQuotaErrorAtForTests(ms: number): void { lastQuotaErrorAtMs = ms; }

function ownerOf(obj: any, name: string): any {
  let p = obj;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p);
  return p || null;
}
function sizeOfResult(r: any): number {
  if (r && Array.isArray(r.docs)) return Math.max(1, r.docs.length);
  if (r && typeof r.size === 'number') return Math.max(1, r.size);
  return 1;
}

function patchDocGet(ref: any): void {
  const owner = ownerOf(ref, 'get');
  if (!owner || owner[PATCHED + ':get']) return;
  const orig = owner.get;
  owner.get = function (this: any, ...args: any[]) {
    countRead(collectionOfPath(this?.path));
    inDocGet++;
    let p: any;
    try { p = orig.apply(this, args); } finally { inDocGet--; }
    return Promise.resolve(p).catch(noteError);
  };
  owner[PATCHED + ':get'] = true;
}
function patchQueryGet(q: any): void {
  const owner = ownerOf(q, 'get');
  if (!owner || owner[PATCHED + ':get']) return;
  const orig = owner.get;
  owner.get = function (this: any, ...args: any[]) {
    const col = collectionOfQuery(this);
    inDocGet++;
    let p: any;
    try { p = orig.apply(this, args); } finally { inDocGet--; }
    return Promise.resolve(p).then((r: any) => { countRead(col, sizeOfResult(r)); return r; }, noteError);
  };
  owner[PATCHED + ':get'] = true;
}
function patchTx(tx: any): void {
  for (const name of ['get', 'getAll']) {
    const owner = ownerOf(tx, name);
    if (!owner || owner[PATCHED + ':' + name]) continue;
    const orig = owner[name];
    owner[name] = function (this: any, ...args: any[]) {
      inDocGet++;
      let p: any;
      try { p = orig.apply(this, args); } finally { inDocGet--; }
      return Promise.resolve(p).then((r: any) => {
        if (name === 'getAll') {
          for (const a of args) if (a && typeof a.path === 'string') countRead(collectionOfPath(a.path));
        } else {
          const target = args[0];
          if (target && typeof target.path === 'string' && !(r && Array.isArray(r.docs))) countRead(collectionOfPath(target.path));
          else countRead(collectionOfQuery(target), sizeOfResult(r));
        }
        return r;
      }, noteError);
    };
    owner[PATCHED + ':' + name] = true;
  }
}

/** Installs the meter on one Firestore object (idempotent). Never throws. */
export function installReadMeter(db: any): void {
  if (!db || db[PATCHED]) return;
  try {
    patchDocGet(db.doc('readMeterProbe/probe'));
    const col = db.collection('readMeterProbe');
    patchQueryGet(col);
    if (typeof col.where === 'function') { try { patchQueryGet(col.where('x', '==', 1)); } catch { /* mock without where */ } }
    if (typeof col.select === 'function') { try { patchQueryGet(col.select('x')); } catch { /* no select */ } }
    if (typeof col.limit === 'function') { try { patchQueryGet(col.limit(1)); } catch { /* no limit */ } }
    if (typeof db.getAll === 'function') {
      const origGetAll = db.getAll.bind(db);
      db.getAll = (...args: any[]) => {
        // DocumentReference.get() calls getAll in the real SDK: counted once, there.
        if (inDocGet === 0) for (const a of args) if (a && typeof a.path === 'string') countRead(collectionOfPath(a.path));
        return Promise.resolve(origGetAll(...args)).catch(noteError);
      };
    }
    // A collection object that carries its own get (the stage2 mock) is wrapped per call.
    const origCollection = db.collection.bind(db);
    db.collection = (name: string, ...rest: any[]) => {
      const c = origCollection(name, ...rest);
      if (c && Object.prototype.hasOwnProperty.call(c, 'get') && typeof c.get === 'function' && !c[PATCHED]) {
        const g = c.get.bind(c);
        c.get = (...a: any[]) => Promise.resolve(g(...a)).then((r: any) => { countRead(name, sizeOfResult(r)); return r; }, noteError);
        c[PATCHED] = true;
      }
      return c;
    };
    const origRun = db.runTransaction.bind(db);
    db.runTransaction = (fn: any, ...rest: any[]) =>
      Promise.resolve(origRun((tx: any) => { patchTx(tx); return fn(tx); }, ...rest)).catch(noteError);
    db[PATCHED] = true;
  } catch { /* the meter is diagnostics only */ }
}

export function readMeterSnapshot(): { total: number; byCollection: Bucket; exhausted: number; sinceMs: number } {
  return { total: state.total, byCollection: { ...state.byCollection }, exhausted: state.exhausted, sinceMs: state.sinceMs };
}
export function resetReadMeter(): void {
  state.total = 0; state.byCollection = {}; state.exhausted = 0; state.sinceMs = Date.now();
  windowStart = { total: 0, byCollection: {}, exhausted: 0, atMs: Date.now() };
}
/** The reads since the last call, as one log line (for the hourly summary). */
export function readMeterWindowLine(): string | null {
  const now = Date.now();
  const n = state.total - windowStart.total;
  const ex = state.exhausted - windowStart.exhausted;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(state.byCollection)) {
    const d = v - (windowStart.byCollection[k] || 0);
    if (d > 0) parts.push(`${k} ${d}`);
  }
  parts.sort((a, b) => Number(b.split(' ').pop()) - Number(a.split(' ').pop()));
  const mins = Math.max(1, Math.round((now - windowStart.atMs) / 60000));
  windowStart = { total: state.total, byCollection: { ...state.byCollection }, exhausted: state.exhausted, atMs: now };
  if (n === 0 && ex === 0) return null;
  return `[reads] ${n} database reads in the last ${mins} min${ex ? `, ${ex} refused for quota` : ''}: ${parts.join(', ')}`;
}
