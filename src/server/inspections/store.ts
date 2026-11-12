import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { createScheduleStore } from './schedule-store.ts';
import { summary, type Report } from './model.ts';
export const reportId = (agency: string, user: string, client: string) => createHash('sha256').update(JSON.stringify([agency, user, client])).digest('hex');
export type Cursor = { submittedAt: string; id: string };
export const reportOrder = (a: Cursor, b: Cursor) => b.submittedAt.localeCompare(a.submittedAt) || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1);
export function createReportStore(deps: { db(): any; dataDir: string; staged(): boolean; hydratePay?: boolean; schedules?: ReturnType<typeof createScheduleStore> }) {
  const payReports = new Map<string, Map<string, import('./fees.ts').PayReport>>(), payComplete = new Set<string>();
  const financial = (r: Report) => { const { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch } = r; if (!payReports.has(r.agencyId)) payReports.set(r.agencyId, new Map()); payReports.get(r.agencyId)!.set(id, { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch }); };
  const reports = new Map<string, Report>(), summaries = new Map<string, ReturnType<typeof summary> & { agencyId: string }>();
  const loaded = new Map<string, Promise<void>>();
  const failures = new Map<string, { retryAt: number; attempts: number }>();
  const ends = new Map<string, Cursor | undefined>(), frontiers = new Map<string, Cursor | undefined>();
  // Keep the last bounded query window when its rows fall outside the 5000-summary prefix.
  const windows = new Map<string, { after?: Cursor; rows: ReturnType<typeof summary>[] }>();
  const collection = (agency: string) => deps.db().collection(`inspectionReportsByAgency/${agency}/reports`);
  const sortKey = (r: Cursor) => `${r.submittedAt}|${r.id}`;
  const photos = new Map<string, Record<string, string>>(), flights = new Map<string, Promise<Record<string, string>>>();
  const key = (agency: string, id: string) => `${agency}__${id}`;
  const file = (collection: string, id: string) => path.join(deps.dataDir, 'inspection-reports', collection, encodeURIComponent(id) + '.json');
  const list = (agency: string) => [...summaries.values()].filter(r => r.agencyId === agency).sort(reportOrder);
  const payFile = (agency: string) => path.join(deps.dataDir, 'inspection-pay-cache', encodeURIComponent(agency) + '.json');
  function loadPayCache(agency: string): Set<string> | null {
    if (!deps.hydratePay || !deps.db()) return null;
    try {
      const cached = JSON.parse(readFileSync(payFile(agency), 'utf8'));
      if (cached.version !== 1 || cached.agencyId !== agency || !Array.isArray(cached.reports) || !cached.reports.every((r: any) => typeof r.id === 'string' && typeof r.submittedAt === 'string')) return null;
      const current = payReports.get(agency) ?? new Map();
      for (const r of cached.reports) if (!current.has(r.id)) current.set(r.id, r);
      payReports.set(agency, current);
      return new Set(cached.reports.map((r: any) => r.id));
    } catch { return null; } // A missing/corrupt cache is rebuilt from the authoritative report collection.
  }
  async function persistPayCache(agency: string) {
    if (!deps.hydratePay || !deps.db() || !payComplete.has(agency)) return;
    const target = payFile(agency), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, agencyId: agency, reports: [...(payReports.get(agency)?.values() ?? [])] }));
      await fs.rename(temporary, target);
    } catch { /* Cache failures never fail a committed report; the next boot can rebuild it. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function cacheDetail(r: Report) {
    const id = key(r.agencyId, r.id);
    reports.delete(id); reports.set(id, r);
    const ids = [...reports].filter(([, row]) => row.agencyId === r.agencyId).map(([id]) => id);
    for (const id of ids.slice(0, Math.max(0, ids.length - 500))) reports.delete(id);
  }
  function install(r: Report) {
    const id = key(r.agencyId, r.id), frontier = frontiers.get(r.agencyId), end = ends.get(r.agencyId);
    const complete = frontiers.has(r.agencyId) && ends.has(r.agencyId) && (!end || (!!frontier && reportOrder(frontier, end) >= 0));
    financial(r);
    summaries.set(id, { ...summary(r), agencyId: r.agencyId }); cacheDetail(r);
    const rows = list(r.agencyId);
    for (const row of rows.slice(5000)) summaries.delete(key(r.agencyId, row.id));
    if (ends.has(r.agencyId) && (!ends.get(r.agencyId) || reportOrder(r, ends.get(r.agencyId)!) > 0)) ends.set(r.agencyId, r);
    if (complete) frontiers.set(r.agencyId, rows.slice(0, 5000).at(-1));
  }
  async function localRows(): Promise<Report[]> {
    let names: string[] = [];
    try { names = await fs.readdir(path.dirname(file('inspectionReports', 'x'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(path.dirname(file('inspectionReports', 'x')), n), 'utf8').then(JSON.parse)));
  }
  function query(agency: string, limit: number, before?: Cursor, projection = false) {
    let q = collection(agency).orderBy('sortKey', 'desc');
    if (before) q = q.startAfter(sortKey(before));
    if (projection) q = q.select('id', 'agencyId', 'companyId', 'companyName', 'mashgiachId', 'mashgiachName', 'submittedAt', 'startedAt', 'counts', 'hasAlerts', 'listChanged', 'photoCount', 'kind', 'templateName');
    return q.limit(limit);
  }
  // One bounded page per agency; failed background work never rejects boot.
  async function ensure(agency: string) {
    if (!loaded.has(agency)) {
      const failed = failures.get(agency);
      if (failed && Date.now() < failed.retryAt) throw Error('Reports unavailable');
      const task = (async () => {
        const cachedPayIds = loadPayCache(agency);
        const rows: Report[] = deps.db()
          ? (await query(agency, 200).get()).docs.map((d: any) => d.data())
          : (await localRows()).filter(r => r.agencyId === agency).sort(reportOrder).slice(0, 200);
        // A short head is the entire authoritative collection, including an emptied collection.
        if (rows.length < 200 && cachedPayIds) { const ids = new Set(rows.map(r => r.id)); for (const id of cachedPayIds) if (!ids.has(id)) payReports.get(agency)?.delete(id); }
        for (const r of rows) install(r);
        // Reports are immutable: overlap with a complete cache avoids re-reading older history.
        if (deps.hydratePay && deps.db() && rows.length === 200 && !rows.some(r => cachedPayIds?.has(r.id))) {
          let cursor = rows.at(-1)!;
          for (;;) {
            const page = (await collection(agency).orderBy('sortKey', 'desc').startAfter(sortKey(cursor)).select('id', 'agencyId', 'companyId', 'companyName', 'mashgiachId', 'mashgiachName', 'submittedAt', 'fee', 'dataFee', 'feeMismatch').limit(1000).get()).docs.map((d: any) => d.data());
            for (const r of page) financial(r);
            if (page.length < 1000 || page.some((r: Report) => cachedPayIds?.has(r.id))) break;
            cursor = page.at(-1)!;
          }
        } else if (!deps.db()) for (const r of (await localRows()).filter(r => r.agencyId === agency)) financial(r);
        if (rows.length < 200) ends.set(agency, list(agency).at(-1));
        frontiers.set(agency, rows.length < 200 ? list(agency).at(-1) : rows.at(-1));
        payComplete.add(agency); await persistPayCache(agency);
        failures.delete(agency);
      })().catch(error => {
        loaded.delete(agency);
        const attempts = (failed?.attempts || 0) + 1;
        failures.set(agency, { attempts, retryAt: Date.now() + Math.min(1000 * 2 ** Math.min(attempts - 1, 6), 60000) });
        throw error;
      });
      loaded.set(agency, task);
    }
    await loaded.get(agency);
  }
  async function get(agency: string, id: string): Promise<Report | undefined> {
    const cached = reports.get(key(agency, id)); if (cached) { cacheDetail(cached); return cached; }
    const db = deps.db();
    let r: Report | undefined;
    if (db) r = (await collection(agency).doc(id).get()).data();
    else try { r = JSON.parse(await fs.readFile(file('inspectionReports', key(agency, id)), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (r?.agencyId !== agency) return undefined;
    cacheDetail(r); return r;
  }
  async function saveUnlocked(r: Report, photoData: Record<string, string>): Promise<{ report: Report; created: boolean }> {
    if (deps.staged()) throw Error('Writes blocked');
    const id = key(r.agencyId, r.id), db = deps.db();
    let saved = r;
    const schedules = deps.schedules, previous = schedules?.company(r.agencyId, r.companyId).lastVisit;
    const update = schedules && (!previous || r.submittedAt > previous.at || (r.submittedAt === previous.at && r.id > previous.reportId))
      ? schedules.prepare(r.agencyId, { companies: { [r.companyId]: { lastVisit: { at: r.submittedAt, reportId: r.id, mashgiachName: r.mashgiachName } } } }) : null;
    try {
      if (db) {
        const batch = db.batch();
        batch.create(collection(r.agencyId).doc(r.id), { ...r, sortKey: sortKey(r) });
        if (r.photoCount) batch.create(db.collection('inspectionReportPhotos').doc(id), { photos: photoData });
        if (update) batch.set(update.ref, update.patch, { merge: true });
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
          await fs.link(temporary, target);
          try { if (update) await schedules!.persistLocal(r.agencyId, update.next); }
          catch (error) { await fs.rm(target, { force: true }); throw error; }
          published = true;
        } finally {
          await fs.rm(temporary, { force: true });
          if (!published && r.photoCount) await fs.rm(file('inspectionReportPhotos', photoId), { force: true });
        }
      }
    } catch (e: any) {
      if (![6, 'already-exists', 'ALREADY_EXISTS', 'EEXIST'].includes(e.code)) throw e;
      // One document read, no writes, irrespective of the in-memory cache/window.
      const stored = db ? (await collection(r.agencyId).doc(r.id).get()).data() : JSON.parse(await fs.readFile(file('inspectionReports', id), 'utf8'));
      if (!stored) throw e;
      return { report: stored, created: false };
    }
    if (update) schedules!.install(r.agencyId, update.next);
    install(saved); await persistPayCache(r.agencyId); return { report: saved, created: true };
  }
  async function save(r: Report, photoData: Record<string, string>) {
    return deps.schedules ? deps.schedules.locked(r.agencyId, () => saveUnlocked(r, photoData)) : saveUnlocked(r, photoData);
  }
  async function visiblePage(agency: string, limit: number, before?: Cursor, visible?: (r: ReturnType<typeof summary>) => boolean, more = true) {
    await ensure(agency);
    const rows: ReturnType<typeof summary>[] = [];
    let cursor = before, fetched = 0;
    const atEnd = () => ends.has(agency) && (!ends.get(agency) || (!!cursor && reportOrder(cursor, ends.get(agency)!) >= 0));
    const consume = (r: ReturnType<typeof summary>) => {
      cursor = { submittedAt: r.submittedAt, id: r.id };
      if (!visible || visible(r)) rows.push(summary(r as Report));
    };
    const frontier = frontiers.get(agency);
    for (const r of list(agency)) {
      if ((!before || reportOrder(r, before) > 0) && frontier && reportOrder(r, frontier) <= 0) consume(r);
      if (rows.length === limit) return { reports: rows, nextCursor: atEnd() ? null : cursor! };
    }
    const window = windows.get(agency), last = window?.rows.at(-1);
    if (window && last && (!window.after || (!!cursor && reportOrder(cursor, window.after) >= 0)) && (!cursor || reportOrder(cursor, last) <= 0)) {
      for (const r of window.rows) {
        if (!cursor || reportOrder(r, cursor) > 0) consume(r);
        if (rows.length === limit) return { reports: rows, nextCursor: atEnd() ? null : cursor! };
      }
    }
    while (more && !atEnd() && (fetched < 1000 || !deps.db())) {
      const db = deps.db(), start = cursor, size = visible ? 200 : limit - rows.length;
      const older: ReturnType<typeof summary>[] = db
        ? (await query(agency, size, start, true).get()).docs.map((d: any) => d.data())
        : (await localRows()).filter(r => r.agencyId === agency && (!start || reportOrder(r, start) > 0)).sort(reportOrder).slice(0, size);
      fetched += older.length || 1;
      if (older.length < size) ends.set(agency, older.at(-1) || start);
      windows.set(agency, { after: start, rows: older });
      for (const r of older) summaries.set(key(agency, r.id), { ...summary(r as Report), agencyId: agency });
      const covered = frontiers.get(agency);
      if (!start || (covered && reportOrder(start, covered) <= 0)) frontiers.set(agency, older.at(-1) || covered);
      for (const r of list(agency).slice(5000)) summaries.delete(key(agency, r.id));
      const tail = list(agency).at(-1), extended = frontiers.get(agency);
      if (tail && extended && reportOrder(tail, extended) < 0) frontiers.set(agency, tail);
      for (const r of older) {
        consume(r);
        if (rows.length === limit) return { reports: rows, nextCursor: atEnd() ? null : cursor! };
      }
      if (!older.length) break;
    }
    return { reports: rows, nextCursor: atEnd() ? null : cursor! };
  }
  async function page(agency: string, limit: number, before?: Cursor, userId?: string) {
    return (await visiblePage(agency, limit, before, userId ? r => r.mashgiachId === userId : undefined)).reports;
  }
  function latest(agency: string, companyId: string) {
    let newest: ReturnType<typeof summary> | undefined;
    for (const rows of [summaries.values(), reports.values()]) for (const r of rows) {
      if (r.agencyId === agency && r.companyId === companyId && (!newest || reportOrder(r, newest) < 0)) newest = summary(r as Report);
    }
    return newest;
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
  return { payReports: (agency: string) => [...(payReports.get(agency)?.values() ?? [])], boot: async (agencies: string[] = []) => { for (const agency of agencies) void ensure(agency).catch(() => {}); }, settled: (agency: string) => loaded.get(agency)?.catch(() => {}) || Promise.resolve(), ensure, save, readPhotos, get, page, visiblePage, list, latest, cached: (agency: string, id: string) => reports.get(key(agency, id)), cachedDetails: () => reports.size };
}
