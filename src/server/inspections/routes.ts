import { createScheduleStore } from './schedule-store.ts';
import { validateSchedule, isDate, calendarDate, dueState, isMuted, alertDecision, type LastVisit, type Alert } from './schedule.ts';
import { normalizeSubmit, buildReport, summary, type Fee } from './model.ts';
import { createReportStore, reportId, type Cursor } from './store.ts';
import type { inspectionSourceAccessor } from '../sources/routes.ts';
type Person = { id: string; name: string; role: string; agencyId?: string };
export function registerInspectionRoutes(app: any, deps: {
  agencyIds?(): string[]; db(): any; dataDir: string; staged(): boolean; source: ReturnType<typeof inspectionSourceAccessor>;
  user(req: any): { id: string; name: string; role: string; agencyId?: string } | undefined;
  scheduleAgencyIds?(): string[]; people?(agency: string): Person[]; timeZone?(agency: string): string;
  now?(): Date; testMode?: boolean; push?(user: Person, title: string, body: string): void | Promise<void>;
  maxPhotoChars: number; photoRe: RegExp;
}) {
  const now = () => deps.now?.() || new Date();
  const schedules = createScheduleStore({ ...deps, now });
  const store = createReportStore({ ...deps, schedules }), pending = new Map<string, Promise<any>>();
  const zone = (a: string) => deps.timeZone?.(a) || 'America/New_York';
  const today = (a: string) => calendarDate(now().toISOString(), zone(a));
  const people = (a: string) => (deps.people?.(a) || []).filter(u => u.agencyId === a);
  const assigned = (a: string, id: string, u: Person) => schedules.company(a, id).mashgiachIds.includes(u.id);
  const visible = (a: string, id: string, u: Person, alerts = false) => u.role === 'admin' || (u.role === 'coordinator'
    ? schedules.company(a, id).coordinatorIds.includes(u.id)
    : assigned(a, id, u) || (!alerts && schedules.doc(a).settings.mashgichimSeeAll));
  function lastVisit(a: string, id: string): LastVisit | null {
    let last = schedules.company(a, id).lastVisit;
    const r = store.latest(a, id);
    if (r && (!last || r.submittedAt > last.at || (r.submittedAt === last.at && r.id > last.reportId))) last = { at: r.submittedAt, reportId: r.id, mashgiachName: r.mashgiachName };
    return last;
  }
  function row(a: string, c: { id: string; name: string; brand?: string; plant?: string }) {
    const { schedule, mashgiachIds, coordinatorIds, mute } = schedules.company(a, c.id), last = lastVisit(a, c.id);
    return { id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '', schedule, ...dueState(schedule, schedules.doc(a).settings.countFrom, last, today(a), zone(a)), lastVisit: last, mashgiachIds, coordinatorIds, mute };
  }
  const handler = (admin: boolean | 'only', fn: any, reports = false) => async (req: any, res: any) => {
    const user = deps.user(req);
    if (req.kiosk || !user?.agencyId || !(admin === 'only' ? user.role === 'admin' : admin ? ['admin', 'coordinator'].includes(user.role) : ['admin', 'coordinator', 'mashgiach'].includes(user.role))) return res.status(403).json({ error: 'Forbidden' });
    // The shared auth middleware adds its verified email to legacy request bodies.
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const { userEmail: _verifiedEmail, ...body } = req.body; req.body = body;
    }
    try { await schedules.ensure(user.agencyId); if (reports) await store.ensure(user.agencyId); await fn(req, res, user, user.agencyId); }
    catch (e: any) { res.status(e.status === 400 ? 400 : 503).json({ error: e.status === 400 ? e.message : 'Report operation failed' }); }
  };
  app.get('/api/visits/factories', handler(false, (_req: any, res: any, u: any, agency: string) => {
    const { state: s, connection: c } = deps.source(agency);
    res.json({ group1Label: c?.group1Label ?? 'Group 1', refreshedAt: s.refreshedAt ?? null, backupTakenAt: s.backupTakenAt ?? null, companies: s.companies.filter(c => visible(agency, c.id, u)).map(c => ({ ...dueState(schedules.company(agency, c.id).schedule, schedules.doc(agency).settings.countFrom, lastVisit(agency, c.id), today(agency), zone(agency)), assigned: assigned(agency, c.id, u), id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length })).sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name)) });
  }));
  app.get('/api/visits/factories/:companyId', handler(false, (req: any, res: any, u: any, agency: string) => {
    const source = deps.source(agency), c = source.state.companies.find(c => c.id === req.params.companyId);
    if (!c || !visible(agency, c.id, u)) return res.status(404).json({ error: 'Company not found' });
    res.json({ company: { id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '' }, listVersion: source.listVersion(c.id), group1Label: source.connection?.group1Label ?? 'Group 1', refreshedAt: source.state.refreshedAt ?? null, backupTakenAt: source.state.backupTakenAt ?? null, ingredients: source.items(c.id, 'ingredient'), products: source.items(c.id, 'product') });
  }));
  app.post('/api/visits/reports', handler(false, async (req: any, res: any, u: any, agency: string) => {
    if (deps.staged()) return res.status(503).json({ error: 'Writes blocked' });
    const clientId = req.body?.clientReportId;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Invalid clientReportId' });
    if (typeof req.body?.companyId !== 'string' || !deps.source(agency).state.companies.some(c => c.id === req.body.companyId) || !visible(agency, req.body.companyId, u)) return res.status(404).json({ error: 'Company not found' });
    const identity = JSON.stringify([agency, u.id, clientId]);
    const cached = store.cached(agency, reportId(agency, u.id, clientId));
    if (cached && !visible(agency, cached.companyId, u)) return res.status(404).json({ error: 'Company not found' });
    if (cached) return res.status(200).json({ report: summary(cached), fee: cached.fee });
    if (pending.has(identity)) { const { created, ...body } = await pending.get(identity); if (!visible(agency, body.report.companyId, u)) return res.status(404).json({ error: 'Company not found' }); return res.status(200).json(body); }
    let input, report;
    try {
      input = normalizeSubmit(req.body, deps.maxPhotoChars, deps.photoRe);
      const source = deps.source(agency), company = source.state.companies.find(c => c.id === input.companyId);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      const value = source.connection?.fees?.mashgiach?.[company.id];
      const fee: Fee = value && Number.isFinite(value.amount) && typeof value.currency === 'string' ? { amount: value.amount, currency: value.currency } : null;
      report = buildReport(input, { id: reportId(agency, u.id, clientId), agencyId: agency, userId: u.id, userName: u.name, companyName: company.name, listVersion: source.listVersion(company.id), items: kind => source.items(company.id, kind), now: now().toISOString(), fee });
    } catch { return res.status(400).json({ error: 'Invalid report' }); }
    const task = store.save(report, input.photos).then(({ report: stored, created }) => {
      console.info(`[inspections] report=${report.id} checked=${report.counts.checked} not_used=${report.counts.not_used} alert=${report.counts.alert} offList=${report.counts.offList} photos=${report.photoCount}`);
      return { report: summary(stored), fee: stored.fee, created };
    });
    pending.set(identity, task);
    try { const { created, ...body } = await task; if (!visible(agency, body.report.companyId, u)) return res.status(404).json({ error: 'Company not found' }); res.status(created ? 201 : 200).json(body); } finally { pending.delete(identity); }
  }));
  async function list(req: any, res: any, agency: string, userId?: string, caller?: Person) {
    const raw = req.query.limit, limit = raw === undefined ? (userId ? 20 : 50) : Number(raw);
    let before: Cursor | undefined;
    try {
      if (req.query.before !== undefined) {
        before = JSON.parse(req.query.before);
        if (!before || typeof before.submittedAt !== 'string' || !Number.isFinite(Date.parse(before.submittedAt)) || typeof before.id !== 'string' || !before.id || before.id.length > 200) throw Error();
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Error();
    } catch { return res.status(400).json({ error: 'Invalid pagination' }); }
    res.json(await store.visiblePage(agency, limit, before, r => (!userId || r.mashgiachId === userId) && (!caller || visible(agency, r.companyId, caller))));
  }
  app.get('/api/visits/reports/mine', handler(false, (req: any, res: any, u: any, agency: string) => list(req, res, agency, u.id, u), true));
  app.get('/api/inspections/reports', handler(true, (req: any, res: any, u: any, agency: string) => list(req, res, agency, undefined, u), true));
  app.get('/api/inspections/reports/:id', handler(true, async (req: any, res: any, u: any, agency: string) => {
    const r = await store.get(agency, req.params.id);
    if (!r || !visible(agency, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: { ...summary(r), note: r.note, marks: r.marks, offList: r.offList } });
  }, true));
  app.get('/api/inspections/reports/:id/photos', handler(true, async (req: any, res: any, u: any, agency: string) => {
    const r = await store.get(agency, req.params.id);
    if (!r || !visible(agency, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    res.json({ photos: await store.readPhotos(r) });
  }, true));
  const invalid = () => { throw Object.assign(Error('Invalid schedule change'), { status: 400 }); };
  const strict = (body: any, keys: string[], required: string[] = keys) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(body, k))) invalid();
  };
  const changeCompany = (adminOnly: boolean, fn: any) => handler(adminOnly ? 'only' : true, async (req: any, res: any, u: Person, a: string) => {
    const c = deps.source(a).state.companies.find(c => c.id === req.params.id);
    if (!c || !visible(a, c.id, u)) return res.status(404).json({ error: 'Company not found' });
    await schedules.update(a, { companies: { [c.id]: fn(req.body, u, a, c.id) } });
    res.json({ company: row(a, c) });
  });
  app.get('/api/inspections/schedule', handler(true, (_req: any, res: any, u: Person, a: string) => {
    const select = (role: string) => u.role === 'admin' ? people(a).filter(p => p.role === role).map(({ id, name }) => ({ id, name })) : [];
    res.json({ today: today(a), timeZone: zone(a), settings: schedules.doc(a).settings, companies: deps.source(a).state.companies.filter(c => visible(a, c.id, u)).map(c => row(a, c)).sort((a, b) => a.name.localeCompare(b.name)), people: { mashgichim: select('mashgiach'), coordinators: select('coordinator') } });
  }));
  app.put?.('/api/inspections/schedule/settings', handler('only', async (req: any, res: any, u: Person, a: string) => {
    strict(req.body, ['countFrom', 'mashgichimSeeAll'], []);
    if ((req.body.countFrom !== undefined && !['last_visit', 'planned'].includes(req.body.countFrom)) || (req.body.mashgichimSeeAll !== undefined && typeof req.body.mashgichimSeeAll !== 'boolean')) invalid();
    await schedules.update(a, { settings: req.body }); res.json({ settings: schedules.doc(a).settings });
  }));
  app.put?.('/api/inspections/schedule/companies/:id', changeCompany(false, (body: any) => {
    strict(body, ['schedule']);
    try { return { schedule: validateSchedule(body.schedule) }; } catch { return invalid(); }
  }));
  app.put?.('/api/inspections/schedule/companies/:id/people', changeCompany(true, (body: any, _u: Person, a: string) => {
    strict(body, ['mashgiachIds', 'coordinatorIds']);
    for (const [key, role] of [['mashgiachIds', 'mashgiach'], ['coordinatorIds', 'coordinator']]) {
      const ids = body[key];
      if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length || !ids.every(id => typeof id === 'string' && people(a).some(p => p.id === id && p.role === role))) invalid();
    }
    return { mashgiachIds: body.mashgiachIds, coordinatorIds: body.coordinatorIds };
  }));
  app.put?.('/api/inspections/schedule/companies/:id/mute', changeCompany(false, (body: any, u: Person, a: string, id: string) => {
    strict(body, ['muted', 'until'], ['muted']);
    if (typeof body.muted !== 'boolean' || (body.until !== undefined && body.until !== null && !isDate(body.until))) invalid();
    if (!body.muted) return { mute: null };
    const until = body.until ?? null, old = schedules.company(a, id).mute;
    return { mute: old && old.until === until ? old : { until, by: u.id, at: now().toISOString() } };
  }));
  app.get('/api/inspections/alerts', handler(false, (_req: any, res: any, u: Person, a: string) => {
    const alerts = deps.source(a).state.companies.filter(c => visible(a, c.id, u, true)).map(c => row(a, c)).filter(c => c.status === 'overdue').map(c => ({ companyId: c.id, companyName: c.name, nextDue: c.nextDue, overdueDays: c.overdueDays, muted: isMuted(c.mute, today(a)) })).sort((a, b) => a.nextDue!.localeCompare(b.nextDue!) || a.companyName.localeCompare(b.companyName));
    res.json({ today: today(a), alerts });
  }));
  const pendingAlerts = new Map<string, Record<string, { alert: Alert }>>();
  let checking: Promise<any> | undefined;
  async function runCheck() {
    const sent: { companyId: string; kind: 'first' | 'reminder'; userIds: string[] }[] = []; let writes = 0;
    if (deps.staged()) return { sent, writes };
    for (const a of deps.agencyIds?.() || []) {
      if (!schedules.ready(a)) continue;
      // Await only existing hydration; a failed query leaves stored lastVisit authoritative.
      await store.settled(a);
      await schedules.locked(a, async () => {
        if (deps.staged()) return;
        const persist = async (changes: Record<string, { alert: Alert }>) => {
          const prepared = schedules.prepare(a, { companies: changes });
          if (prepared) {
            if (deps.db()) { const batch = deps.db().batch(); batch.set(prepared.ref, prepared.patch, { merge: true }); await batch.commit(); }
            else await schedules.persistLocal(a, prepared.next);
            schedules.install(a, prepared.next); writes++;
          }
          pendingAlerts.delete(a);
        };
        const retry = pendingAlerts.get(a);
        if (retry) { await persist(retry); return; }
        const changes: Record<string, any> = Object.create(null), messages: { c: ReturnType<typeof row>; kind: 'first' | 'reminder'; recipients: Person[] }[] = [];
        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone(a), hour: 'numeric', hourCycle: 'h23' }).format(now()));
        for (const company of deps.source(a).state.companies) {
          const c = row(a, company), current = schedules.company(a, c.id);
          const decision = alertDecision({ nextDue: c.nextDue, today: today(a), hour, mute: c.mute, alert: current.alert });
          if (!decision) continue;
          const recipients = [...new Map(people(a).filter(p => p.role === 'admin' || (p.role === 'mashgiach' && c.mashgiachIds.includes(p.id)) || (p.role === 'coordinator' && c.coordinatorIds.includes(p.id))).map(p => [p.id, p])).values()];
          changes[c.id] = { alert: decision.alert }; messages.push({ c, kind: decision.kind, recipients });
        }
        if (!schedules.prepare(a, { companies: changes })) return;
        for (const { c, kind, recipients } of messages) {
          const date = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(c.nextDue! + 'T12:00:00Z'));
          for (const user of recipients) {
            try { await deps.push?.(user, 'Visit overdue', `${kind === 'reminder' ? 'Still no visit: ' : ''}${c.name} — due ${date}`); }
            catch { /* One recipient's delivery failure must not block the others or the state write. */ }
          }
          sent.push({ companyId: c.id, kind, userIds: recipients.map(p => p.id) });
        }
        // A crash between push and commit may duplicate this alert once after restart.
        // Failed commits retain this sent state: the next check retries only its write.
        pendingAlerts.set(a, changes);
        await persist(changes);
      });
    }
    return { sent, writes };
  }
  const check = () => checking ||= runCheck().finally(() => { checking = undefined; });
  if (deps.testMode) app.post('/api/__test__/inspections/check', handler('only', async (_req: any, res: any, u: Person) => {
    res.json(await check());
  }));
  return { check, boot: async () => {
    await store.boot(deps.agencyIds?.() || []);
    await schedules.boot(deps.scheduleAgencyIds?.() || deps.agencyIds?.() || []);
  } };

}
