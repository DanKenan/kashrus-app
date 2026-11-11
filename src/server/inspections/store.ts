import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { summary, type Report } from './model.ts';
export const reportId = (agency: string, user: string, client: string) => createHash('sha256').update(JSON.stringify([agency, user, client])).digest('hex');
export type Cursor = { submittedAt: string; id: string };
export const reportOrder = (a: Cursor, b: Cursor) => b.submittedAt.localeCompare(a.submittedAt) || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1);
export function createReportStore(deps: { db(): any; dataDir: string; staged(): boolean }) {
  const reports = new Map<string, Report>(), summaries = new Map<string, ReturnType<typeof summary> & { agencyId: string }>();
  const loaded = new Map<string, Promise<void>>();
  const photos = new Map<string, Record<string, string>>(), flights = new Map<string, Promise<Record<string, string>>>();
  const key = (agency: string, id: string) => `${agency}__${id}`;
  const file = (collection: string, id: string) => path.join(deps.dataDir, 'inspection-reports', collection, encodeURIComponent(id) + '.json');
  const list = (agency: string) => [...summaries.values()].filter(r => r.agencyId === agency).sort(reportOrder);
  function install(r: Report) {
    const id = key(r.agencyId, r.id);
    summaries.set(id, { ...summary(r), agencyId: r.agencyId }); reports.set(id, r);
    const rows = list(r.agencyId);
    for (const row of rows.slice(5000)) summaries.delete(key(r.agencyId, row.id));
    const detailIds = new Set(rows.slice(0, 500).map(row => key(r.agencyId, row.id)));
    for (const [id, row] of reports) if (row.agencyId === r.agencyId && !detailIds.has(id)) reports.delete(id);
  }
  async function localRows(): Promise<Report[]> {
    let names: string[] = [];
    try { names = await fs.readdir(path.dirname(file('inspectionReports', 'x'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(path.dirname(file('inspectionReports', 'x')), n), 'utf8').then(JSON.parse)));
  }
  function query(agency: string, limit: number, before?: Cursor, projection = false) {
    let q = deps.db().collection('inspectionReports').where('agencyId', '==', agency).orderBy('submittedAt', 'desc').orderBy('id', 'desc');
    if (before) q = q.startAfter(before.submittedAt, before.id);
    if (projection) q = q.select('id', 'agencyId', 'companyId', 'companyName', 'mashgiachId', 'mashgiachName', 'submittedAt', 'startedAt', 'counts', 'hasAlerts', 'listChanged', 'photoCount');
    return q.limit(limit);
  }
  // Hydrate each agency once, using bounded queries and no retention window.
  async function ensure(agency: string) {
    if (!loaded.has(agency)) {
      const task = (async () => {
        if (deps.db()) {
          const details: Report[] = (await query(agency, 500).get()).docs.map((d: any) => d.data());
          for (const r of details) install(r);
          if (details.length === 500) {
            const rows = (await query(agency, 4500, details.at(-1), true).get()).docs;
            for (const d of rows) { const r = d.data(); summaries.set(key(agency, r.id), r); }
          }
        } else for (const r of (await localRows()).filter(r => r.agencyId === agency).sort(reportOrder).slice(0, 5000)) install(r);
      })().catch(error => { loaded.delete(agency); throw error; });
      loaded.set(agency, task);
    }
    await loaded.get(agency);
  }
  async function get(agency: string, id: string): Promise<Report | undefined> {
    const cached = reports.get(key(agency, id)); if (cached) return cached;
    const db = deps.db();
    let r: Report | undefined;
    if (db) r = (await db.collection('inspectionReports').doc(key(agency, id)).get()).data();
    else try { r = JSON.parse(await fs.readFile(file('inspectionReports', key(agency, id)), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    return r?.agencyId === agency ? r : undefined;
  }
  async function save(r: Report, photoData: Record<string, string>): Promise<{ report: Report; created: boolean }> {
    if (deps.staged()) throw Error('Writes blocked');
    const id = key(r.agencyId, r.id), db = deps.db();
    let saved = r;
    try {
      if (db) {
        const batch = db.batch();
        batch.create(db.collection('inspectionReports').doc(id), r);
        if (r.photoCount) batch.create(db.collection('inspectionReportPhotos').doc(id), { photos: photoData });
        await batch.commit();
      } else {
        const target = file('inspectionReports', id), nonce = randomUUID();
        const temporary = `${target}.${nonce}.tmp`, photoId = `${id}__${nonce}`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        saved = { ...r, ...(r.photoCount ? { localPhotoId: photoId } : {}) };
        let published = false;
        try {
          if (r.photoCount) { const targetPhoto = file('inspectionReportPhotos', photoId); await fs.mkdir(path.dirname(targetPhoto), { recursive: true }); await fs.writeFile(targetPhoto, JSON.stringify({ photos: photoData })); }
          await fs.writeFile(temporary, JSON.stringify(saved));
          // Atomic, exclusive publication: retries can only observe a complete report.
          await fs.link(temporary, target); published = true;
        } finally {
          await fs.rm(temporary, { force: true });
          if (!published && r.photoCount) await fs.rm(file('inspectionReportPhotos', photoId), { force: true });
        }
      }
    } catch (e: any) {
      if (![6, 'already-exists', 'ALREADY_EXISTS', 'EEXIST'].includes(e.code)) throw e;
      // One document read, no writes, irrespective of the in-memory cache/window.
      const stored = db ? (await db.collection('inspectionReports').doc(id).get()).data() : JSON.parse(await fs.readFile(file('inspectionReports', id), 'utf8'));
      if (!stored) throw e;
      return { report: stored, created: false };
    }
    install(saved); return { report: saved, created: true };
  }
  async function page(agency: string, limit: number, before?: Cursor, userId?: string) {
    await ensure(agency);
    const cached = list(agency), rows = cached.filter(r => (!userId || r.mashgiachId === userId) && (!before || reportOrder(r, before) > 0)).slice(0, limit);
    // Only admins can cross the memory boundary. Projection never reads photo documents.
    if (!userId && cached.length === 5000 && rows.length < limit) {
      const cursor = rows.at(-1) || before || cached.at(-1);
      const db = deps.db();
      const older = db ? (await query(agency, limit - rows.length, cursor, true).get()).docs.map((d: any) => d.data()) : (await localRows()).filter(r => r.agencyId === agency && (!cursor || reportOrder(r, cursor) > 0)).sort(reportOrder).slice(0, limit - rows.length);
      return [...rows, ...older].map(summary);
    }
    return rows.map(summary);
  }
  async function readPhotos(r: Report): Promise<Record<string, string>> {
    if (!r.photoCount) return {};
    const id = key(r.agencyId, r.id), cached = photos.get(id);
    if (cached) { photos.delete(id); photos.set(id, cached); return cached; }
    if (flights.has(id)) return flights.get(id)!;
    const flight = (async () => {
      const db = deps.db();
      const localReport = db ? undefined : await get(r.agencyId, r.id);
      const doc = db ? (await db.collection('inspectionReportPhotos').doc(id).get()).data() : JSON.parse(await fs.readFile(file('inspectionReportPhotos', (localReport as (Report & { localPhotoId?: string }) | undefined)?.localPhotoId || id), 'utf8'));
      if (!doc?.photos) throw Error('Photos unavailable');
      photos.set(id, doc.photos);
      while (photos.size > 8) photos.delete(photos.keys().next().value!);
      return doc.photos;
    })().finally(() => flights.delete(id));
    flights.set(id, flight); return flight;
  }
  return { boot: async (agencies: string[] = []) => { await Promise.all(agencies.map(ensure)); }, ensure, save, readPhotos, get, page, list, cached: (agency: string, id: string) => reports.get(key(agency, id)), cachedDetails: () => reports.size };
}
