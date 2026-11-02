/**
 * WRITECUT (Nov 2 2026): a process-wide count of Firestore document writes.
 *
 * The live app hit the free-tier daily WRITE quota (20,000 document
 * writes/day) on Nov 1 and sign-in hung. Like the read meter
 * (src/server/read-meter.ts) this patches the write path of whatever
 * Firestore object the server uses (the real SDK, the emulator, or the
 * stage2 mock) and counts every COMMITTED document write the way Google
 * bills them: set / update / create = 1 write per document, a batch or a
 * transaction = 1 per document it writes; a delete = 1 delete (Google counts
 * deletes on their own daily quota, so they are counted apart). A transaction attempt that does
 * not commit (contention, error) writes nothing and is not counted.
 * Writes are counted by collection and by caller (the commitState label or
 * the HTTP route that caused them; "background" otherwise). A
 * RESOURCE_EXHAUSTED answer on a commit is counted too.
 * It changes no behaviour: each patched method calls the original.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isQuotaError, noteQuotaError } from './read-meter.ts';

type Bucket = Record<string, number>;
interface Ctx { route?: string; label?: string; req?: any }
const als = new AsyncLocalStorage<Ctx>();
const state = {
  total: 0,
  deletes: 0, // Google bills deletes on their own daily quota (20,000/day free), not as writes
  byCollection: {} as Bucket,
  byCaller: {} as Bucket,
  exhausted: 0,
  sinceMs: Date.now(),
};
let windowStart = { total: 0, deletes: 0, byCollection: {} as Bucket, byCaller: {} as Bucket, exhausted: 0, atMs: Date.now() };
const PATCHED = '__shutfeyWriteMeter';

function collectionOfPath(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'unknown';
  const parts = path.split('/').filter(Boolean);
  return parts.length % 2 === 0 ? parts[parts.length - 2] : parts[parts.length - 1];
}

function routeOf(ctx: Ctx | undefined): string | null {
  if (!ctx) return null;
  if (ctx.route) return ctx.route;
  const req = ctx.req;
  if (!req) return null;
  const p = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : String(req.path || req.url || '').split('?')[0]
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id').replace(/\/(?:task|venue|user|shift|agency|note|inc|ann)[-_][^/]+/gi, '/:id');
  return `${req.method || '?'} ${p}`;
}
/** The caller a write is attributed to right now. */
export function currentWriteCaller(): string {
  const ctx = als.getStore();
  const route = routeOf(ctx);
  if (ctx?.label) return route ? `${ctx.label} @ ${route}` : ctx.label;
  return route || 'background';
}

export function countWrite(collection: string, n = 1, caller: string = currentWriteCaller()): void {
  if (!(n > 0)) return;
  state.total += n;
  state.byCollection[collection] = (state.byCollection[collection] || 0) + n;
  state.byCaller[caller] = (state.byCaller[caller] || 0) + n;
}
/** A delete is billed on its own quota: counted apart from writes. */
export function countDelete(n = 1): void {
  if (n > 0) state.deletes += n;
}
function countPaths(paths: Array<{ path: string; del: boolean }>, caller: string): void {
  for (const p of paths) {
    if (p.del) countDelete(1);
    else countWrite(collectionOfPath(p.path), 1, caller);
  }
}
/** Real SDK: an op is a delete when its proto has a `delete` target. */
function opIsDelete(o: any): boolean {
  try { const pr = typeof o?.op === 'function' ? o.op() : null; return !!(pr && pr.delete); } catch { return false; }
}
function noteCommitError(err: any): never {
  if (isQuotaError(err)) { state.exhausted++; noteQuotaError(err); }
  throw err;
}

/** Runs fn with every write under it attributed to this request (Express middleware). */
export function writeMeterMiddleware(req: any, _res: any, next: () => void): void {
  als.run({ req }, next);
}
/** Runs fn with every write under it attributed to `label` (e.g. a commitState label). */
export function withWriteLabel<T>(label: string, fn: () => T): T {
  const parent = als.getStore();
  return als.run({ ...(parent || {}), label }, fn);
}

function ownerOf(obj: any, name: string): any {
  let p = obj;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p);
  return p || null;
}

/** Real SDK / emulator: every commit (doc.set, batch, transaction) goes through WriteBatch._commit. */
function patchWriteBatch(batch: any): void {
  const owner = ownerOf(batch, '_commit');
  if (!owner || owner[PATCHED + ':_commit']) return;
  const orig = owner._commit;
  owner._commit = function (this: any, ...args: any[]) {
    const caller = currentWriteCaller();
    const paths = Array.isArray(this?._ops) ? this._ops.map((o: any) => ({ path: String(o?.docPath || ''), del: opIsDelete(o) })) : [];
    return Promise.resolve(orig.apply(this, args)).then((r: any) => { countPaths(paths, caller); return r; }, noteCommitError);
  };
  owner[PATCHED + ':_commit'] = true;
}
/** The stage2 mock: its transaction commits synchronously from a Map of writes. */
function patchMockTx(tx: any): void {
  const owner = ownerOf(tx, '_commit');
  if (!owner || owner[PATCHED + ':_commit']) return;
  const orig = owner._commit;
  owner._commit = function (this: any, ...args: any[]) {
    const caller = currentWriteCaller();
    const paths = this?._writes instanceof Map ? [...this._writes.entries()].map(([k, v]) => ({ path: String(k), del: v === undefined })) : [];
    let r: any;
    try { r = orig.apply(this, args); } catch (err) { noteCommitError(err); }
    countPaths(paths, caller);
    return r;
  };
  owner[PATCHED + ':_commit'] = true;
}
function patchMockDocWrites(ref: any): void {
  for (const name of ['set', 'delete', 'update', 'create']) {
    const owner = ownerOf(ref, name);
    if (!owner || owner[PATCHED + ':' + name]) continue;
    const orig = owner[name];
    owner[name] = function (this: any, ...args: any[]) {
      const caller = currentWriteCaller();
      const path = String(this?.path || '');
      return Promise.resolve(orig.apply(this, args)).then((r: any) => { if (name === 'delete') countDelete(1); else countWrite(collectionOfPath(path), 1, caller); return r; }, noteCommitError);
    };
    owner[PATCHED + ':' + name] = true;
  }
}

/** Installs the meter on one Firestore object (idempotent). Never throws. */
export function installWriteMeter(db: any): void {
  if (!db || db[PATCHED]) return;
  try {
    let real = false;
    if (typeof db.batch === 'function') {
      try { const b = db.batch(); if (b && typeof b._commit === 'function') { patchWriteBatch(b); real = true; } } catch { /* mock without batch */ }
    }
    if (!real) {
      // The mock's DocumentReference writes directly (no batch underneath).
      try { patchMockDocWrites(db.doc('writeMeterProbe/probe')); } catch { /* no doc() */ }
    }
    const origRun = db.runTransaction.bind(db);
    db.runTransaction = (fn: any, ...rest: any[]) =>
      Promise.resolve(origRun((tx: any) => {
        if (tx && tx._writeBatch) patchWriteBatch(tx._writeBatch);
        else if (tx && typeof tx._commit === 'function') patchMockTx(tx);
        return fn(tx);
      }, ...rest));
    db[PATCHED] = true;
  } catch { /* the meter is diagnostics only */ }
}

export function writeMeterSnapshot(): { total: number; deletes: number; byCollection: Bucket; byCaller: Bucket; exhausted: number; sinceMs: number } {
  return { total: state.total, deletes: state.deletes, byCollection: { ...state.byCollection }, byCaller: { ...state.byCaller }, exhausted: state.exhausted, sinceMs: state.sinceMs };
}
export function resetWriteMeter(): void {
  state.total = 0; state.deletes = 0; state.byCollection = {}; state.byCaller = {}; state.exhausted = 0; state.sinceMs = Date.now();
  windowStart = { total: 0, deletes: 0, byCollection: {}, byCaller: {}, exhausted: 0, atMs: Date.now() };
}
function topOf(now: Bucket, before: Bucket, max: number): string {
  const parts: [string, number][] = [];
  for (const [k, v] of Object.entries(now)) { const d = v - (before[k] || 0); if (d > 0) parts.push([k, d]); }
  parts.sort((a, b) => b[1] - a[1]);
  const shown = parts.slice(0, max).map(([k, d]) => `${k} ${d}`);
  if (parts.length > max) shown.push(`+${parts.length - max} more`);
  return shown.join(', ');
}
/** The writes since the last call, as one log fragment (for the hourly summary). */
export function writeMeterWindowLine(): string | null {
  const now = Date.now();
  const n = state.total - windowStart.total;
  const dels = state.deletes - windowStart.deletes;
  const ex = state.exhausted - windowStart.exhausted;
  const cols = topOf(state.byCollection, windowStart.byCollection, 12);
  const callers = topOf(state.byCaller, windowStart.byCaller, 8);
  const mins = Math.max(1, Math.round((now - windowStart.atMs) / 60000));
  windowStart = { total: state.total, deletes: state.deletes, byCollection: { ...state.byCollection }, byCaller: { ...state.byCaller }, exhausted: state.exhausted, atMs: now };
  if (n === 0 && ex === 0 && dels === 0) return null;
  return `[writes] ${n} database writes (+${dels} deletes) in the last ${mins} min${ex ? `, ${ex} commits refused for quota` : ''}: ${cols || 'none'}; top callers: ${callers || 'none'}`;
}
export { isQuotaError };
