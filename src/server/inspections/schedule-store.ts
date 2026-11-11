import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { defaultSettings, type Schedule, type Settings, type LastVisit, type Mute, type Alert } from './schedule.ts';
export type CompanySchedule = { schedule: Schedule | null; mashgiachIds: string[]; coordinatorIds: string[]; mute: Mute | null; lastVisit: LastVisit | null; alert: Alert | null };
export type ScheduleDoc = { settings: Settings; companies: Record<string, CompanySchedule>; updatedAt: string };
export const emptyCompany = (): CompanySchedule => ({ schedule: null, mashgiachIds: [], coordinatorIds: [], mute: null, lastVisit: null, alert: null });
export function createScheduleStore(deps: { db(): any; dataDir: string; staged(): boolean; now(): Date }) {
  const memory = new Map<string, ScheduleDoc>(), loads = new Map<string, Promise<void>>(), queues = new Map<string, Promise<unknown>>();
  const failures = new Map<string, { retryAt: number; attempts: number }>();
  const empty = (): ScheduleDoc => ({ settings: { ...defaultSettings }, companies: Object.create(null), updatedAt: '' });
  const doc = (agency: string) => memory.get(agency) || empty();
  const company = (agency: string, id: string): CompanySchedule => Object.hasOwn(doc(agency).companies, id) ? { ...emptyCompany(), ...doc(agency).companies[id] } : emptyCompany();
  const ref = (agency: string) => deps.db().collection('inspectionSchedules').doc(agency);
  const file = (agency: string) => path.join(deps.dataDir, 'inspection-schedules', encodeURIComponent(agency) + '.json');
  async function ensure(agency: string) {
    if (memory.has(agency)) return;
    if (!loads.has(agency)) {
      const failed = failures.get(agency);
      if (failed && Date.now() < failed.retryAt) throw Error('Schedules unavailable');
      const task = (async () => {
        let value;
        if (deps.db()) value = (await ref(agency).get()).data();
        else try { value = JSON.parse(await fs.readFile(file(agency), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        memory.set(agency, value ? { ...value, settings: { ...defaultSettings, ...value.settings } } : empty());
        failures.delete(agency);
      })().catch(error => {
        loads.delete(agency);
        const attempts = (failed?.attempts || 0) + 1;
        failures.set(agency, { attempts, retryAt: Date.now() + Math.min(1000 * 2 ** Math.min(attempts - 1, 6), 60000) });
        throw error;
      });
      loads.set(agency, task);
    }
    await loads.get(agency);
  }
  // All mutations, including report batches, share this per-agency lock. No read-before-write.
  async function locked<T>(agency: string, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(agency) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(agency, next);
    try { return await next; } finally { if (queues.get(agency) === next) queues.delete(agency); }
  }
  function prepare(agency: string, change: { settings?: Partial<Settings>; companies?: Record<string, Partial<CompanySchedule>> }) {
    if (deps.staged()) throw Object.assign(Error('Writes blocked'), { status: 503 });
    if (!memory.has(agency)) throw Error('Schedules unavailable');
    const old = doc(agency), companies = Object.assign(Object.create(null), old.companies) as ScheduleDoc['companies'], patch: any = {};
    const settings = { ...old.settings, ...change.settings };
    if (!isDeepStrictEqual(settings, old.settings)) patch.settings = change.settings;
    for (const [id, fields] of Object.entries(change.companies || {})) {
      const before = company(agency, id), after = { ...before, ...fields };
      if (!isDeepStrictEqual(before, after)) {
        companies[id] = after;
        // Merge only changed leaves. A new row needs no default values on disk.
        patch.companies ||= Object.create(null); patch.companies[id] = { ...fields };
        // merge:true preserves nested map keys. Remove obsolete shape keys when switching kinds.
        if (deps.db() && fields.schedule && before.schedule) {
          const schedule: Record<string, unknown> = { ...fields.schedule };
          for (const key of Object.keys(before.schedule)) if (!Object.hasOwn(schedule, key)) schedule[key] = FieldValue.delete();
          patch.companies[id].schedule = schedule;
        }
      }
    }
    if (!Object.keys(patch).length) return null;
    const updatedAt = deps.now().toISOString(), next = { settings, companies, updatedAt };
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 900_000) throw Object.assign(Error('Schedule document too large'), { status: 400 });
    patch.updatedAt = updatedAt;
    return { next, patch, ref: deps.db() ? ref(agency) : null };
  }
  async function persistLocal(agency: string, next: ScheduleDoc) {
    const target = file(agency), temporary = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, JSON.stringify(next)); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function update(agency: string, change: Parameters<typeof prepare>[1]) {
    return locked(agency, async () => {
      const p = prepare(agency, change); if (!p) return false;
      if (deps.db()) { const batch = deps.db().batch(); batch.set(p.ref, p.patch, { merge: true }); await batch.commit(); }
      else await persistLocal(agency, p.next);
      memory.set(agency, p.next); return true;
    });
  }
  return { boot: async (agencies: string[]) => { await Promise.allSettled([...new Set(agencies)].map(ensure)); }, ensure, ready: (agency: string) => memory.has(agency), doc, company: (a: string, id: string) => ({ ...emptyCompany(), ...company(a, id) }), locked, prepare, persistLocal, install: (a: string, next: ScheduleDoc) => memory.set(a, next), update };
}
