import fs from 'node:fs/promises';
import path from 'node:path';
import type { Report } from './model.ts';
export function createReportStore(deps: { db(): any; dataDir: string; staged(): boolean }) {
  const reports = new Map<string, Report>(), ids = new Map<string, string>();
  const photos = new Map<string, Record<string, string>>(), flights = new Map<string, Promise<Record<string, string>>>();
  const key = (agency: string, id: string) => `${agency}__${id}`;
  const identity = (r: Pick<Report, 'agencyId' | 'mashgiachId' | 'clientReportId'>) => JSON.stringify([r.agencyId, r.mashgiachId, r.clientReportId]);
  const file = (collection: string, id: string) => path.join(deps.dataDir, 'inspection-reports', collection, encodeURIComponent(id) + '.json');
  function install(r: Report) { reports.set(key(r.agencyId, r.id), r); ids.set(identity(r), r.id); }
  async function boot() {
    const cutoff = new Date(Date.now() - 180 * 86400_000).toISOString(), db = deps.db();
    let rows: Report[];
    if (db) {
      const collection = db.collection('inspectionReports');
      const query = typeof collection.where === 'function' ? collection.where('submittedAt', '>=', cutoff) : collection;
      rows = (await query.get()).docs.map((d: any) => d.data());
    } else {
      let names: string[] = [];
      try { names = await fs.readdir(path.dirname(file('inspectionReports', 'x'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      rows = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(path.dirname(file('inspectionReports', 'x')), n), 'utf8').then(JSON.parse)));
    }
    for (const r of rows) if (r.submittedAt >= cutoff) install(r);
  }
  async function save(r: Report, photoData: Record<string, string>) {
    if (deps.staged()) throw Error('Writes blocked');
    const id = key(r.agencyId, r.id), db = deps.db();
    const writes = [{ collection: 'inspectionReports', doc: r }, ...(r.photoCount ? [{ collection: 'inspectionReportPhotos', doc: { photos: photoData } }] : [])];
    if (db) {
      const apply = (batch: any) => { for (const w of writes) batch.set(db.collection(w.collection).doc(id), w.doc); };
      if (typeof db.batch === 'function') { const batch = db.batch(); apply(batch); await batch.commit(); }
      else await db.runTransaction(async (tx: any) => apply(tx));
    } else {
      // Publish the report last; it is the visibility boundary for the local fallback.
      for (const w of [...writes].reverse()) {
        const target = file(w.collection, id); await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target + '.tmp', JSON.stringify(w.doc)); await fs.rename(target + '.tmp', target);
      }
    }
    install(r);
  }
  async function readPhotos(r: Report): Promise<Record<string, string>> {
    if (!r.photoCount) return {};
    const id = key(r.agencyId, r.id), cached = photos.get(id);
    if (cached) { photos.delete(id); photos.set(id, cached); return cached; }
    if (flights.has(id)) return flights.get(id)!;
    const flight = (async () => {
      const db = deps.db();
      const doc = db ? (await db.collection('inspectionReportPhotos').doc(id).get()).data() : JSON.parse(await fs.readFile(file('inspectionReportPhotos', id), 'utf8'));
      if (!doc?.photos) throw Error('Photos unavailable');
      photos.set(id, doc.photos);
      while (photos.size > 8) photos.delete(photos.keys().next().value!);
      return doc.photos;
    })().finally(() => flights.delete(id));
    flights.set(id, flight); return flight;
  }
  return { boot, save, readPhotos, get: (agency: string, id: string) => reports.get(key(agency, id)), duplicate: (agencyId: string, mashgiachId: string, clientReportId: string) => ids.get(identity({ agencyId, mashgiachId, clientReportId })), list: (agency: string) => [...reports.values()].filter(r => r.agencyId === agency && Date.parse(r.submittedAt) >= Date.now() - 180 * 86400_000).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id)) };
}
