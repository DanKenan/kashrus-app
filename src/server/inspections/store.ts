import { addDays, calendarDate } from './schedule.ts';
import { range, type PayReport } from './fees.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { createScheduleStore } from './schedule-store.ts';
import { summary, type Report } from './model.ts';
export const reportId = (agency: string, user: string, client: string) => createHash('sha256').update(JSON.stringify([agency, user, client])).digest('hex');
export type Cursor = { submittedAt: string; id: string };
export const reportOrder = (a: Cursor, b: Cursor) => b.submittedAt.localeCompare(a.submittedAt) || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1);
export function createReportStore(deps: { db(): any; dataDir: string; staged(): boolean; now?(): Date; timeZone?(agency: string): string; schedules?: ReturnType<typeof createScheduleStore> }) {
  // Pay-screen and export caches are process-local: deployment is limited to one Cloud Run instance (maxScale=1).
  // Scheduled accountant sends always query fresh reports, independently of this cache.
  const observedFrom = new Map<string, string>(), partialMonths = new Map<string, string>(), completeMonths = new Set<string>();
  const months = new Map<string, Map<string, PayReport>>(), monthLoads = new Map<string, Promise<void>>();
  const zone = (agency: string) => deps.timeZone?.(agency) || 'America/New_York';
  const monthKey = (agency: string, month: string) => JSON.stringify([agency, month]);
  const financial = (r: Report) => {
    const month = calendarDate(r.submittedAt, zone(r.agencyId)).slice(0, 7), key = monthKey(r.agencyId, month);
    const { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch } = r;
    if (!months.has(key)) months.set(key, new Map());
    months.get(key)!.set(id, { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch });
  };
  const feeReport = (agency: string, id: string) => {
    for (const [key, rows] of months) if (JSON.parse(key)[0] === agency && rows.has(id)) return rows.get(id);
  };
  async function payReportsForRange(agency: string, from: string, to: string): Promise<PayReport[]> {
    range(from, to); await ensure(agency);
    const rows = new Map<string, PayReport>();
    for (let month = from.slice(0, 7); month <= to.slice(0, 7);) {
      const key = monthKey(agency, month), next = new Date(month + '-01T12:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
      const nextMonth = next.toISOString().slice(0, 7);
      const currentMonth = calendarDate((deps.now?.() || new Date()).toISOString(), zone(agency)).slice(0, 7);
      if (!partialMonths.has(key) && month >= observedFrom.get(agency)! && month <= currentMonth) { if (!months.has(key)) months.set(key, new Map()); completeMonths.add(key); }
      if (!completeMonths.has(key) || monthLoads.has(key)) {
        if (!monthLoads.has(key)) monthLoads.set(key, (async () => {
          const start = localMidnight(month + '-01', zone(agency)), end = partialMonths.get(key) ?? localMidnight(nextMonth + '-01', zone(agency));
          const fetched: Report[] = deps.db()
            ? (await collection(agency).where('sortKey', '>=', start).where('sortKey', '<', end).get()).docs.map((d: any) => d.data())
            : (await localRows()).filter(r => r.agencyId === agency && r.submittedAt >= start && r.submittedAt < end);
          // Preserve submissions that arrived while the range query was in flight.
          const current = months.get(key) ?? new Map<string, PayReport>(); months.set(key, current);
          for (const r of fetched) if (!current.has(r.id)) financial(r);
          partialMonths.delete(key); completeMonths.add(key);
        })().finally(() => monthLoads.delete(key)));
        await monthLoads.get(key);
      }
      for (const r of months.get(key)?.values() ?? []) { const day = calendarDate(r.submittedAt, zone(agency)); if (day >= from && day <= to) rows.set(r.id, r); }
      month = nextMonth;
    }
    return [...rows.values()];
  }
  async function freshReportsForRange(agency: string, from: string, to: string): Promise<PayReport[]> {
    range(from, to); await ensure(agency);
    const start = localMidnight(from, zone(agency)), end = localMidnight(addDays(to, 1), zone(agency));
    // One sortKey field, no composite index. This query deliberately bypasses the month cache.
    const fetched: Report[] = deps.db()
      ? (await collection(agency).where('sortKey', '>=', start).where('sortKey', '<', end).get()).docs.map((d: any) => d.data())
      : (await localRows()).filter(r => r.agencyId === agency && r.submittedAt >= start && r.submittedAt < end);
    const selected: PayReport[] = [];
    for (const r of fetched) {
      const day = calendarDate(r.submittedAt, zone(agency));
      if (r.agencyId !== agency || day < from || day > to) continue;
      financial(r);
      const { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch } = r;
      selected.push({ id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, fee, dataFee, feeMismatch });
    }
    return selected;
  }
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
    if (projection) q = q.select('id', 'agencyId', 'companyId', 'companyName', 'mashgiachId', 'mashgiachName', 'submittedAt', 'startedAt', 'counts', 'hasAlerts', 'listChanged', 'photoCount', 'kind', 'templateName', 'fee', 'dataFee', 'feeMismatch');
    return q.limit(limit);
  }
  // One bounded page per agency; failed background work never rejects boot.
  async function ensure(agency: string) {
    if (!loaded.has(agency)) {
      const failed = failures.get(agency);
      if (failed && Date.now() < failed.retryAt) throw Error('Reports unavailable');
      const task = (async () => {
        const rows: Report[] = deps.db()
          ? (await query(agency, 200).get()).docs.map((d: any) => d.data())
          : (await localRows()).filter(r => r.agencyId === agency).sort(reportOrder).slice(0, 200);
        for (const r of rows) { install(r); completeMonths.add(monthKey(agency, calendarDate(r.submittedAt, zone(agency)).slice(0, 7))); }
        if (rows.length === 200) { const oldest = rows.at(-1)!, key = monthKey(agency, calendarDate(oldest.submittedAt, zone(agency)).slice(0, 7)); completeMonths.delete(key); partialMonths.set(key, sortKey(oldest)); }
        const currentMonth = calendarDate((deps.now?.() || new Date()).toISOString(), zone(agency)).slice(0, 7);
        observedFrom.set(agency, currentMonth);
        if (!months.has(monthKey(agency, currentMonth))) months.set(monthKey(agency, currentMonth), new Map());
        if (!partialMonths.has(monthKey(agency, currentMonth))) completeMonths.add(monthKey(agency, currentMonth));
        if (rows.length < 200) ends.set(agency, list(agency).at(-1));
        frontiers.set(agency, rows.length < 200 ? list(agency).at(-1) : rows.at(-1));
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
    install(saved); return { report: saved, created: true };
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
      for (const r of older) financial({ ...r, agencyId: agency } as Report);
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
  return { payReportsForRange, freshReportsForRange, feeReport, boot: async (agencies: string[] = []) => { for (const agency of agencies) void ensure(agency).catch(() => {}); }, settled: (agency: string) => loaded.get(agency)?.catch(() => {}) || Promise.resolve(), ensure, save, readPhotos, get, page, visiblePage, list, latest, cached: (agency: string, id: string) => reports.get(key(agency, id)), cachedDetails: () => reports.size };
}

// Convert agency-local midnight to a UTC sortKey boundary, including DST offsets.
export function localMidnight(day: string, timeZone: string): string {
  const wall = Date.parse(day + 'T00:00:00Z'); let at = wall;
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    const get = (key: string) => Number(parts.find(p => p.type === key)!.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    at += wall - represented;
  }
  return new Date(at).toISOString();
}
