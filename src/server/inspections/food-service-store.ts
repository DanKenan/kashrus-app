import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import type { Template } from './food-service.ts';
export type DocumentDeps = { db(): any; dataDir: string; staged(): boolean; now(): Date };
export type FoodServiceDoc = { templates: Record<string, Template>; templateOrder: string[]; marked: string[]; placeTemplates: Record<string, string | null>; manualPlaces: Record<string, { name: string; address: string; createdAt: string }>; updatedAt: string };
// Shared agency-document persistence: one boot read, memory-only mutations, changed leaves only.
export function createAgencyDocument<T extends { updatedAt: string }>(deps: DocumentDeps, collection: string, empty: () => T) {
  const memory = new Map<string, T>(), loads = new Map<string, Promise<void>>(), queues = new Map<string, Promise<unknown>>();
  const failures = new Map<string, { retryAt: number; attempts: number }>();
  const doc = (agency: string): T => memory.get(agency) ?? empty();
  const file = (agency: string) => path.join(deps.dataDir, collection, encodeURIComponent(agency) + '.json');
  async function ensure(agency: string) {
    if (memory.has(agency)) return;
    const failed = failures.get(agency);
    if (!loads.has(agency) && failed && deps.now().getTime() < failed.retryAt) throw Error('Inspection document unavailable');
    if (!loads.has(agency)) loads.set(agency, (async () => {
      let value;
      if (deps.db()) value = (await deps.db().collection(collection).doc(agency).get()).data();
      else try { value = JSON.parse(await fs.readFile(file(agency), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      memory.set(agency, { ...empty(), ...value }); failures.delete(agency);
    })().catch(e => {
      loads.delete(agency);
      const attempts = (failed?.attempts ?? 0) + 1;
      failures.set(agency, { attempts, retryAt: deps.now().getTime() + Math.min(1000 * 2 ** Math.min(attempts - 1, 6), 60_000) });
      throw e;
    }));
    await loads.get(agency);
  }
  async function locked<R>(agency: string, action: () => Promise<R>): Promise<R> {
    const next = (queues.get(agency) ?? Promise.resolve()).catch(() => {}).then(action); queues.set(agency, next);
    try { return await next; } finally { if (queues.get(agency) === next) queues.delete(agency); }
  }
  function check(next: T) {
    if (deps.staged()) throw Object.assign(Error('Writes blocked'), { status: 503 });
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 900_000) throw Object.assign(Error('Inspection document too large'), { status: 400 });
  }
  function patch(old: any, next: any): any {
    const result: any = Object.create(null);
    for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (isDeepStrictEqual(old[k], next[k])) continue;
      if (!Object.hasOwn(next, k)) result[k] = FieldValue.delete();
      else if (next[k] && old[k] && typeof next[k] === 'object' && typeof old[k] === 'object' && !Array.isArray(next[k]) && !Array.isArray(old[k])) result[k] = patch(old[k], next[k]);
      else result[k] = next[k];
    }
    return result;
  }
  async function persist(agency: string, before: T, next: T) {
    check(next);
    if (deps.db()) {
      const batch = deps.db().batch();
      batch.set(deps.db().collection(collection).doc(agency), patch(before, next), { merge: true });
      await batch.commit();
    }
    else {
      const target = file(agency), temporary = `${target}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      try { await fs.writeFile(temporary, JSON.stringify(next)); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, { force: true }); }
    }
  }
  async function update(agency: string, change: (next: T) => void) {
    return locked(agency, async () => {
      if (!memory.has(agency)) throw Error('Inspection document unavailable');
      const before = doc(agency), next = structuredClone(before); change(next); check(next);
      if (isDeepStrictEqual(before, next)) return false;
      next.updatedAt = deps.now().toISOString(); check(next);
      await persist(agency, before, next); memory.set(agency, next); return true;
    });
  }
  return { doc, ensure, locked, check, persist, update, install: (a: string, d: T) => memory.set(a, d), ready: (a: string) => memory.has(a), boot: async (agencies: string[]) => { await Promise.allSettled([...new Set(agencies)].map(ensure)); } };
}
export const createFoodServiceStore = (deps: DocumentDeps) => createAgencyDocument<FoodServiceDoc>(deps, 'inspectionFoodService', () => ({ templates: {}, templateOrder: [], marked: [], placeTemplates: {}, manualPlaces: {}, updatedAt: '' }));
