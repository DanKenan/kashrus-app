import { createFeesStore } from './fees-store.ts';
import { createCompanyInfoStore, validateCompanyInfo, emptyInfo } from './company-info-store.ts';
import { validateFees, validateSettings, validateAccountant, computePay, range, amount, shape } from './fees.ts';
import { accountantPeriod, nextAccountantDate, buildAccountantMessage } from './accountant.ts';
import { createEmailTransport, type Message } from './email.ts';
import { csv, xlsx, csvType, xlsxType } from './export.ts';
import { isDeepStrictEqual } from 'node:util';
import { createFoodServiceStore } from './food-service-store.ts';
import { createInboxStore } from './inbox-store.ts';
import { classifyPlace, typeMatched, validateTemplate, buildFoodServiceReport, identifier, strict as strictFood, text, invalid as invalidFood } from './food-service.ts';
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
  agencyName?(agency: string): string;
  now?(): Date; testMode?: boolean; push?(user: Person, title: string, body: string): void | Promise<void>;
  maxPhotoChars: number; photoRe: RegExp;
}) {
  const now = () => deps.now?.() || new Date();
  const fees = createFeesStore({ ...deps, now }), companyInfo = createCompanyInfoStore({ ...deps, now });
  const email = createEmailTransport(deps.dataDir, !!deps.testMode), outboxes = new Map<string, Message[]>();
  const schedules = createScheduleStore({ ...deps, now });
  const store = createReportStore({ ...deps, schedules, hydratePay: true }), pending = new Map<string, Promise<any>>();
  const food = createFoodServiceStore({ ...deps, now });
  const inbox = createInboxStore({ ...deps, now, submittedAt: (a, id) => store.list(a).find(r => r.id === id)?.submittedAt });
  const reportSummary = (a: string, r: Parameters<typeof summary>[0]) => ({ ...summary(r), ...inbox.status(a, r) });
  const foodValues = (a: string) => deps.source(a).connection?.mapping?.companies?.foodServiceValues ?? [];
  const factoryValues = (a: string) => deps.source(a).connection?.mapping?.companies?.factoryValues ?? [];
  const others = (a: string) => deps.source(a).state.otherCompanies ?? [];
  const kind = (a: string, c: { id: string; type?: string }) => classifyPlace(c, foodValues(a), food.doc(a).marked, food.doc(a).manualPlaces, factoryValues(a));
  const markedOthers = (a: string) => others(a).filter(c => food.doc(a).marked.includes(c.id));
  const places = (a: string) => [...deps.source(a).state.companies.filter(c => kind(a, c) === 'food_service').map(c => ({ ...c, address: '', source: 'connected' as const })), ...markedOthers(a).map(c => ({ ...c, address: '', source: 'connected' as const })), ...Object.entries(food.doc(a).manualPlaces).map(([id, c]) => ({ ...c, id, type: '', source: 'manual' as const }))];
  const allPlaces = (a: string) => [...deps.source(a).state.companies, ...markedOthers(a), ...Object.entries(food.doc(a).manualPlaces).map(([id, c]) => ({ ...c, id, type: '' }))];
  const templateFor = (a: string, id: string) => { const tid = Object.hasOwn(food.doc(a).placeTemplates, id) ? food.doc(a).placeTemplates[id] : null; return tid && Object.hasOwn(food.doc(a).templates, tid) ? food.doc(a).templates[tid] : null; };
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
  function row(a: string, c: { id: string; name: string; brand?: string; plant?: string; type?: string }) {
    const { schedule, mashgiachIds, coordinatorIds, mute } = schedules.company(a, c.id), last = lastVisit(a, c.id);
    return { kind: kind(a, c), id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '', schedule, ...dueState(schedule, schedules.doc(a).settings.countFrom, last, today(a), zone(a)), lastVisit: last, mashgiachIds, coordinatorIds, mute };
  }
  const handler = (admin: boolean | 'only', fn: any, reports = false) => async (req: any, res: any) => {
    const user = deps.user(req);
    if (req.kiosk || !user?.agencyId || !(admin === 'only' ? user.role === 'admin' : admin ? ['admin', 'coordinator'].includes(user.role) : ['admin', 'coordinator', 'mashgiach'].includes(user.role))) return res.status(403).json({ error: 'Forbidden' });
    // The shared auth middleware adds its verified email to legacy request bodies.
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const { userEmail: _verifiedEmail, ...body } = req.body; req.body = body;
    }
    try { await schedules.ensure(user.agencyId); await food.ensure(user.agencyId); await inbox.ensure(user.agencyId); await fees.ensure(user.agencyId); await companyInfo.ensure(user.agencyId); if (reports) await store.ensure(user.agencyId); await fn(req, res, user, user.agencyId); }
    catch (e: any) { res.status([400, 409].includes(e.status) ? e.status : 503).json({ error: [400, 409].includes(e.status) ? e.message : 'Report operation failed', ...(e.status === 409 ? { template: e.template } : {}) }); }
  };
  function foodRow(a: string, c: ReturnType<typeof places>[number]) {
    const template = templateFor(a, c.id);
    const connected = c.source === 'connected';
    return { ...row(a, c), address: c.address, source: c.source, type: c.type ?? '',
      marked: connected && food.doc(a).marked.includes(c.id), typeMatched: connected && typeMatched(c, foodValues(a)), templateId: template?.id ?? null, templateName: template?.name ?? '' };
  }
  const sortedPlaces = (a: string, u: Person) => places(a).filter(c => visible(a, c.id, u)).map(c => foodRow(a, c)).sort((a, b) => a.name.localeCompare(b.name));
  const candidates = (a: string) => [...deps.source(a).state.companies.filter(c => kind(a, c) === 'factory'), ...others(a).filter(c => !food.doc(a).marked.includes(c.id))].map(c => ({ id: c.id, name: c.name, type: c.type ?? '' }));
  const templates = (a: string) => food.doc(a).templateOrder.map(id => food.doc(a).templates[id]);
  const placeFee = (a: string, id: string) => Object.hasOwn(fees.doc(a).places, id) ? fees.doc(a).places[id] : null;
  function visitFee(a: string, id: string): Fee {
    const set = placeFee(a, id)?.mashgiach;
    if (set) return { amount: set.amount, currency: 'USD' };
    const data = deps.source(a).connection?.fees?.mashgiach?.[id];
    return !Object.hasOwn(food.doc(a).manualPlaces, id) && data && Number.isFinite(data.amount) ? { amount: data.amount, currency: data.currency } : null;
  }
  const info = (a: string, id: string) => Object.hasOwn(companyInfo.doc(a).places, id) ? companyInfo.doc(a).places[id] : emptyInfo();
  const pay = (a: string, query: any) => {
    const r = range(query.from, query.to, query.by ?? 'place');
    return computePay(store.payReports(a), fees.doc(a), allPlaces(a), r.from, r.to, r.by, zone(a));
  };
  const message = (a: string, query: any) => buildAccountantMessage(deps.agencyName?.(a) || 'Agency', fees.doc(a).accountant?.email || '', pay(a, query));
  async function sendSummary(a: string, query: any) {
    if (!email.transport) return { sent: false, reason: 'not_set_up' as const };
    if (!fees.doc(a).accountant) return { sent: false, reason: 'no_accountant' as const };
    const table = pay(a, query);
    if (!table.totals.visits) return { sent: false, reason: 'no_visits' as const };
    if (deps.staged()) throw Object.assign(Error('Writes blocked'), { status: 503 });
    const message = buildAccountantMessage(deps.agencyName?.(a) || 'Agency', fees.doc(a).accountant!.email, table);
    await email.transport.send(message);
    if (!outboxes.has(a)) outboxes.set(a, []); outboxes.get(a)!.push(message);
    return { sent: true };
  }
  async function runAccountant(a: string, afterReport = false) {
    if (!email.transport || deps.staged() || !fees.ready(a) || !fees.doc(a).accountant) return;
    await store.ensure(a);
    // One lock covers timing, delivery and lastSent, including simultaneous reports/hourly checks.
    return fees.locked(a, async () => {
      const doc = fees.doc(a), accountant = doc.accountant;
      if (!accountant || deps.staged()) return;
      const period = accountantPeriod(accountant.timing, doc.lastSent, now(), zone(a), afterReport);
      if (!period) return;
      const prepared = fees.stage(a, next => { next.lastSent = { at: now().toISOString(), periodEnd: period.to }; });
      const result = await sendSummary(a, period);
      if (!result.sent && result.reason !== 'no_visits') return;
      if (prepared) { await fees.persist(a, prepared.before, prepared.next); fees.install(a, prepared.next); }
      return result;
    });
  }
  app.get('/api/inspections/fees', handler(true, (_req: any, res: any, u: Person, a: string) => {
    const doc = fees.doc(a);
    res.json({ settings: doc.settings, canEdit: u.role === 'admin' || doc.settings.feeEditors === 'admins_and_coordinators',
      places: allPlaces(a).filter(c => visible(a, c.id, u)).map(c => ({ id: c.id, name: c.name, kind: kind(a, c), company: placeFee(a, c.id)?.company ?? null, mashgiach: placeFee(a, c.id)?.mashgiach ?? null, mashgiachNames: schedules.company(a, c.id).mashgiachIds.map(id => people(a).find(p => p.id === id)?.name).filter(Boolean) })),
      ...(u.role === 'admin' ? { accountant: doc.accountant, email: { setUp: !!email.transport }, nextEmail: email.transport ? nextAccountantDate(doc.accountant?.timing, doc.lastSent, now(), zone(a)) : null } : {}) });
  }));
  app.put?.('/api/inspections/fees/:placeId', handler(true, async (req: any, res: any, u: Person, a: string) => {
    if (u.role !== 'admin' && fees.doc(a).settings.feeEditors !== 'admins_and_coordinators') return res.status(403).json({ error: 'Forbidden' });
    const id = req.params.placeId;
    if (!allPlaces(a).some(c => c.id === id) || !visible(a, id, u)) return res.status(404).json({ error: 'Place not found' });
    const value = validateFees(req.body);
    await fees.update(a, next => { const old = placeFee(a, id); if (!isDeepStrictEqual({ company: old?.company ?? null, mashgiach: old?.mashgiach ?? null }, value)) Object.defineProperty(next.places, id, { value: { ...value, updatedBy: u.id, updatedAt: now().toISOString() }, enumerable: true, configurable: true, writable: true }); });
    res.json(value);
  }));
  app.put?.('/api/inspections/fee-settings', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    const value = validateSettings(req.body); await fees.update(a, next => { next.settings = value; }); res.json({ settings: value });
  }));
  app.put?.('/api/inspections/accountant', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    const value = validateAccountant(req.body); await fees.update(a, next => { next.accountant = value; }); res.json({ accountant: value });
  }));
  app.get('/api/inspections/pay', handler('only', (req: any, res: any, _u: Person, a: string) => res.json(pay(a, req.query)), true));
  app.get('/api/inspections/pay/export', handler('only', (req: any, res: any, _u: Person, a: string) => {
    const table = pay(a, req.query), format = req.query.format;
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'Invalid export format' });
    res.setHeader('Content-Disposition', `attachment; filename="pay-${table.from}-${table.to}.${format}"`);
    res.type(format === 'csv' ? csvType : xlsxType).send(format === 'csv' ? csv(table) : xlsx(table));
  }, true));
  app.get('/api/inspections/accountant/preview', handler('only', (req: any, res: any, _u: Person, a: string) => {
    const m = message(a, req.query); res.json({ ...m, attachments: m.attachments.map(({ contentBase64, ...rest }) => ({ ...rest, bytes: Buffer.from(contentBase64, 'base64').length })) });
  }, true));
  app.post('/api/inspections/accountant/send', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    shape(req.body, ['kind', 'from', 'to'], ['kind']);
    if (!['test', 'now'].includes(req.body.kind)) return res.status(400).json({ error: 'Invalid send kind' });
    const date = today(a), query = { from: req.body.from ?? date.slice(0, 7) + '-01', to: req.body.to ?? date };
    range(query.from, query.to); res.json(await sendSummary(a, query));
  }, true));
  app.post('/api/inspections/reports/:id/fee-decision', handler(true, async (req: any, res: any, u: Person, a: string) => {
    shape(req.body, ['amount']); const value = amount(req.body.amount), r = store.payReports(a).find(r => r.id === req.params.id);
    if (!r || !visible(a, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    if (!r.feeMismatch || ![r.dataFee?.amount, r.fee?.amount].includes(value)) return res.status(400).json({ error: 'Amount must match a report fee' });
    await fees.update(a, next => { next.decisions[r.id] = { amount: value, by: u.id, byName: u.name, at: now().toISOString() }; });
    res.json({ decided: fees.doc(a).decisions[r.id] });
  }, true));
  app.get('/api/inspections/company-info/:placeId', handler(true, (req: any, res: any, u: Person, a: string) => {
    if (!allPlaces(a).some(c => c.id === req.params.placeId) || !visible(a, req.params.placeId, u)) return res.status(404).json({ error: 'Place not found' });
    res.json(info(a, req.params.placeId));
  }));
  app.put?.('/api/inspections/company-info/:placeId', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    const id = req.params.placeId;
    if (!allPlaces(a).some(c => c.id === id)) return res.status(404).json({ error: 'Place not found' });
    const value = validateCompanyInfo(req.body, info(a, id));
    await companyInfo.update(a, next => { Object.defineProperty(next.places, id, { value, enumerable: true, configurable: true, writable: true }); }); res.json(value);
  }));
  app.get('/api/visits/places/:placeId/info', handler(false, (req: any, res: any, u: Person, a: string) => {
    const id = req.params.placeId;
    if (!allPlaces(a).some(c => c.id === id) || !visible(a, id, u)) return res.status(404).json({ error: 'Place not found' });
    const value = info(a, id); res.json(u.role === 'mashgiach' ? { address: value.address, phone: value.phone } : value);
  }));
  if (deps.testMode) {
    app.get('/api/__test__/outbox', handler('only', (_req: any, res: any, _u: Person, a: string) => res.json({ messages: outboxes.get(a) ?? [] })));
    app.post('/api/__test__/inspections/email-transport', handler('only', (req: any, res: any) => {
      if (!['none', 'test'].includes(req.body?.name)) return res.status(400).json({ error: 'Invalid transport' });
      const next = createEmailTransport(deps.dataDir, true, req.body.name); email.transport = next.transport; email.outbox = next.outbox; outboxes.clear(); res.json({ setUp: !!email.transport });
    }));
  }
  async function notifyReport(a: string, r: Parameters<typeof summary>[0]) {
    const hasProblems = r.counts.alert > 0;
    if (!hasProblems && isMuted(schedules.company(a, r.companyId).mute, today(a))) return;
    const n = r.counts.alert;
    const title = hasProblems ? '⚠ Problem found' : 'New report';
    const body = hasProblems ? `${r.companyName} — ${n} ${n === 1 ? 'problem' : 'problems'} · ${r.mashgiachName}` : `${r.companyName} — ${r.mashgiachName}`;
    const recipients = new Map(people(a).filter(p => p.id !== r.mashgiachId && (p.role === 'admin' || (p.role === 'coordinator' && schedules.company(a, r.companyId).coordinatorIds.includes(p.id)))).map(p => [p.id, p]));
    for (const p of recipients.values()) try { await deps.push?.(p, title, body); } catch { /* Delivery never fails a saved report. */ }
  }
  app.get('/api/food-service', handler(true, (_req: any, res: any, u: Person, a: string) => {
    const visiblePlaces = sortedPlaces(a, u);
    const allowed = new Set(visiblePlaces.map(p => p.templateId).filter((id): id is string => id !== null));
    res.json({ today: today(a), timeZone: zone(a), templates: u.role === 'admin' ? templates(a) : templates(a).filter(t => allowed.has(t.id)), places: visiblePlaces, candidates: u.role === 'admin' ? candidates(a) : [] });
  }));
  app.post('/api/food-service/templates', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    let template: any;
    await food.update(a, next => {
      const normalized = validateTemplate(req.body);
      const same = Object.values(next.templates).find(t => t.name.toLowerCase() === normalized.name.toLowerCase());
      if (same && isDeepStrictEqual({ name: same.name, items: same.items }, normalized)) { template = same; return; }
      validateTemplate(req.body, Object.values(next.templates));
      template = { ...normalized, id: identifier('t_', 12), version: 1, updatedAt: now().toISOString() };
      next.templates[template.id] = template; next.templateOrder.push(template.id);
    }); res.status(201).json({ template });
  }));
  app.put?.('/api/food-service/templates/:id', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    const id = req.params.id;
    if (!Object.hasOwn(food.doc(a).templates, id)) return res.status(404).json({ error: 'Checklist not found' });
    await food.update(a, next => {
      const old = next.templates[id], normalized = validateTemplate(req.body, Object.values(next.templates), id);
      if (!isDeepStrictEqual({ name: old.name, items: old.items }, normalized)) next.templates[id] = { ...old, ...normalized, version: old.version + 1, updatedAt: now().toISOString() };
    }); res.json({ template: food.doc(a).templates[id] });
  }));
  app.delete?.('/api/food-service/templates/:id', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    if (!Object.hasOwn(food.doc(a).templates, req.params.id)) return res.status(404).json({ error: 'Checklist not found' });
    await food.update(a, next => {
      delete next.templates[req.params.id]; next.templateOrder = next.templateOrder.filter(id => id !== req.params.id);
      for (const [id, tid] of Object.entries(next.placeTemplates)) if (tid === req.params.id) next.placeTemplates[id] = null;
    }); res.json({ ok: true });
  }));
  app.put?.('/api/food-service/templates-order', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    strictFood(req.body, ['order']);
    await food.update(a, next => {
      const order = req.body.order;
      if (!Array.isArray(order) || order.length !== next.templateOrder.length || new Set(order).size !== order.length || !order.every(id => typeof id === 'string' && Object.hasOwn(next.templates, id))) invalidFood('Invalid checklist order');
      next.templateOrder = order;
    }); res.json({ templates: templates(a) });
  }));
  app.put?.('/api/food-service/places/:id/template', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    const c = places(a).find(c => c.id === req.params.id); if (!c) return res.status(404).json({ error: 'Place not found' });
    strictFood(req.body, ['templateId']);
    await food.update(a, next => {
      const tid = req.body.templateId;
      if (tid !== null && (typeof tid !== 'string' || !Object.hasOwn(next.templates, tid))) invalidFood('Unknown checklist');
      if ((Object.hasOwn(next.placeTemplates, c.id) ? next.placeTemplates[c.id] : null) !== tid) Object.defineProperty(next.placeTemplates, c.id, { value: tid, enumerable: true, writable: true, configurable: true });
    }); res.json({ place: foodRow(a, c) });
  }));
  app.post('/api/food-service/places', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    strictFood(req.body, ['name', 'address'], ['name']);
    const id = identifier('fs_', 20), place = { name: text(req.body.name, 120, true), address: text(req.body.address === undefined ? '' : req.body.address, 200), createdAt: now().toISOString() };
    await food.update(a, next => { next.manualPlaces[id] = place; });
    res.status(201).json({ place: foodRow(a, { ...place, id, source: 'manual', type: '' }) });
  }));
  app.put?.('/api/food-service/places/:id', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    if (!Object.hasOwn(food.doc(a).manualPlaces, req.params.id)) return res.status(404).json({ error: 'Manual place not found' });
    strictFood(req.body, ['name', 'address']);
    await food.update(a, next => { next.manualPlaces[req.params.id] = { ...next.manualPlaces[req.params.id], name: text(req.body.name, 120, true), address: text(req.body.address, 200) }; });
    res.json({ place: foodRow(a, places(a).find(c => c.id === req.params.id)!) });
  }));
  app.delete?.('/api/food-service/places/:id', handler('only', async (req: any, res: any, _u: Person, a: string) => {
    if (!Object.hasOwn(food.doc(a).manualPlaces, req.params.id)) return res.status(404).json({ error: 'Manual place not found' });
    await schedules.locked(a, () => food.locked(a, async () => {
      const preparedFood = food.stage(a, next => {
        delete next.manualPlaces[req.params.id];
        delete next.placeTemplates[req.params.id];
      });
      if (!preparedFood) return;
      const preparedSchedule = Object.hasOwn(schedules.doc(a).companies, req.params.id)
        ? schedules.prepareRemoval(a, req.params.id) : null;
      if (deps.db()) {
        const batch = deps.db().batch();
        batch.set(preparedFood.ref, preparedFood.patch, { merge: true });
        if (preparedSchedule) batch.set(preparedSchedule.ref, preparedSchedule.patch, { merge: true });
        await batch.commit();
      } else {
        if (preparedSchedule) await schedules.persistLocal(a, preparedSchedule.next);
        try { await food.persistLocal(a, preparedFood.next); }
        catch (error) {
          if (preparedSchedule) await schedules.persistLocal(a, schedules.doc(a));
          throw error;
        }
      }
      food.install(a, preparedFood.next);
      if (preparedSchedule) schedules.install(a, preparedSchedule.next);
    }));
    res.json({ ok: true });
  }));
  app.put?.('/api/food-service/marked', handler('only', async (req: any, res: any, u: Person, a: string) => {
    strictFood(req.body, ['add', 'remove'], []);
    await food.update(a, next => {
      for (const k of ['add', 'remove']) {
        const ids = req.body[k] ?? [];
        if (!Array.isArray(ids) || ids.length > 2000 || !ids.every(id => typeof id === 'string')) invalidFood('Unknown connected company');
        for (const id of ids) {
          if (k === 'remove') {
            if (next.marked.includes(id)) continue;
            const connected = [...deps.source(a).state.companies, ...others(a)].find(c => c.id === id);
            if (connected && typeMatched(connected, foodValues(a))) invalidFood('This place is food service because of its type in your connected list');
            invalidFood('Unknown connected company');
          }
          if (!deps.source(a).state.companies.some(c => c.id === id) && !others(a).some(c => c.id === id)) invalidFood('Unknown connected company');
        }
      }
      next.marked = [...new Set([...next.marked, ...(req.body.add ?? [])])].filter(id => !(req.body.remove ?? []).includes(id));
      if (next.marked.length > 2000) invalidFood('Too many marked places');
    }); res.json({ places: sortedPlaces(a, u), candidates: candidates(a) });
  }));
  app.get('/api/visits/food-service', handler(false, (_req: any, res: any, u: Person, a: string) => {
    res.json({ places: sortedPlaces(a, u).map(p => ({ id: p.id, name: p.name, address: p.address, type: p.type, templateId: p.templateId, templateName: p.templateName, itemCount: templateFor(a, p.id)?.items.length ?? 0, assigned: assigned(a, p.id, u), nextDue: p.nextDue, status: p.status, overdueDays: p.overdueDays })).sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name)) });
  }));
  app.get('/api/visits/food-service/:placeId', handler(false, (req: any, res: any, u: Person, a: string) => {
    const p = places(a).find(p => p.id === req.params.placeId); if (!p || !visible(a, p.id, u)) return res.status(404).json({ error: 'Place not found' });
    const fee = visitFee(a, p.id);
    res.json({ place: { id: p.id, name: p.name, address: p.address, type: p.type ?? '' }, template: templateFor(a, p.id), fee });
  }));
  if (deps.testMode) app.post('/api/__test__/inspections/flush-seen', handler('only', async (_req: any, res: any) => { res.json({ writes: await inbox.flush() }); }));
  app.get('/api/visits/factories', handler(false, (_req: any, res: any, u: any, agency: string) => {
    const { state: s, connection: c } = deps.source(agency);
    res.json({ group1Label: c?.group1Label ?? 'Group 1', refreshedAt: s.refreshedAt ?? null, backupTakenAt: s.backupTakenAt ?? null, companies: s.companies.filter(c => kind(agency, c) === 'factory' && visible(agency, c.id, u)).map(c => ({ ...dueState(schedules.company(agency, c.id).schedule, schedules.doc(agency).settings.countFrom, lastVisit(agency, c.id), today(agency), zone(agency)), assigned: assigned(agency, c.id, u), id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length })).sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name)) });
  }));
  app.get('/api/visits/factories/:companyId', handler(false, (req: any, res: any, u: any, agency: string) => {
    const source = deps.source(agency), c = source.state.companies.find(c => c.id === req.params.companyId);
    if (!c || kind(agency, c) !== 'factory' || !visible(agency, c.id, u)) return res.status(404).json({ error: 'Company not found' });
    res.json({ company: { id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '' }, fee: visitFee(agency, c.id), listVersion: source.listVersion(c.id), group1Label: source.connection?.group1Label ?? 'Group 1', refreshedAt: source.state.refreshedAt ?? null, backupTakenAt: source.state.backupTakenAt ?? null, ingredients: source.items(c.id, 'ingredient'), products: source.items(c.id, 'product') });
  }));
  app.post('/api/visits/reports', handler(false, async (req: any, res: any, u: any, agency: string) => {
    if (deps.staged()) return res.status(503).json({ error: 'Writes blocked' });
    const clientId = req.body?.clientReportId;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Invalid clientReportId' });
    const identity = JSON.stringify([agency, u.id, clientId]);
    const cached = store.cached(agency, reportId(agency, u.id, clientId));
    if (cached && !visible(agency, cached.companyId, u)) return res.status(404).json({ error: 'Company not found' });
    if (cached) return res.status(200).json({ report: reportSummary(agency, cached), fee: cached.fee });
    if (pending.has(identity)) { const { created, ...body } = await pending.get(identity); if (!visible(agency, body.report.companyId, u)) return res.status(404).json({ error: 'Company not found' }); return res.status(200).json(body); }
    if (typeof req.body?.companyId !== 'string' || !allPlaces(agency).some(c => c.id === req.body.companyId && kind(agency, c) === (req.body.kind === 'food_service' ? 'food_service' : 'factory')) || !visible(agency, req.body.companyId, u)) return res.status(404).json({ error: 'Company not found' });
    let input, report;
    try {
      const source = deps.source(agency), company = allPlaces(agency).find(c => c.id === req.body.companyId)!;
      const value = source.connection?.fees?.mashgiach?.[company.id];
      const dataFee: Fee = !Object.hasOwn(food.doc(agency).manualPlaces, company.id) && value && Number.isFinite(value.amount) && typeof value.currency === 'string' ? { amount: value.amount, currency: value.currency } : null;
      const fee = visitFee(agency, company.id);
      const context = { id: reportId(agency, u.id, clientId), agencyId: agency, userId: u.id, userName: u.name, companyName: company.name, now: now().toISOString(), fee };
      if (req.body.kind === 'food_service') {
        const built = buildFoodServiceReport(req.body, templateFor(agency, company.id), context, deps.maxPhotoChars, deps.photoRe);
        input = { photos: built.photos }; report = built.report;
      } else {
        input = normalizeSubmit(req.body, deps.maxPhotoChars, deps.photoRe);
        report = buildReport(input, { ...context, listVersion: source.listVersion(company.id), items: kind => source.items(company.id, kind) });
      }
      report = { ...report, dataFee, ...(fee && dataFee && fee.amount !== dataFee.amount ? { feeMismatch: true } : {}) };
    } catch (e: any) { return res.status(e.status === 409 ? 409 : 400).json({ error: e.status ? e.message : 'Invalid report', ...(e.status === 409 ? { template: e.template } : {}) }); }
    const task = store.save(report, input.photos).then(async ({ report: stored, created }) => {
      if (created) { await notifyReport(agency, stored); try { await runAccountant(agency, true); } catch { /* Retry on a later report; saving a report never depends on email. */ } }
      console.info(`[inspections] report=${report.id} checked=${report.counts.checked} not_used=${report.counts.not_used} alert=${report.counts.alert} offList=${report.counts.offList} photos=${report.photoCount}`);
      return { report: reportSummary(agency, stored), fee: stored.fee, created };
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
    const q = req.query;
    if ((q.type !== undefined && !['factory', 'food_service'].includes(q.type)) || (q.status !== undefined && !['new', 'seen', 'follow_up'].includes(q.status)) || (q.from !== undefined && !isDate(q.from)) || (q.to !== undefined && !isDate(q.to)) || (q.from && q.to && q.from > q.to) || (q.more !== undefined && q.more !== '1') || ['companyId', 'mashgiachId'].some(k => q[k] !== undefined && (typeof q[k] !== 'string' || q[k].length > 200))) return res.status(400).json({ error: 'Invalid filters' });
    const filtered = !!userId || caller?.role !== 'admin' || ['type', 'status', 'companyId', 'mashgiachId', 'from', 'to'].some(k => q[k] !== undefined);
    const predicate = (r: ReturnType<typeof summary>) => {
      const date = calendarDate(r.submittedAt, zone(agency));
      return (!userId || r.mashgiachId === userId) && (!caller || visible(agency, r.companyId, caller)) && (!q.type || (r.kind || 'factory') === q.type) && (!q.status || inbox.status(agency, r).status === q.status) && (!q.companyId || r.companyId === q.companyId) && (!q.mashgiachId || r.mashgiachId === q.mashgiachId) && (!q.from || date >= q.from) && (!q.to || date <= q.to);
    };
    const page = await store.visiblePage(agency, limit, before, filtered ? predicate : undefined, !!userId || q.more === '1');
    res.json({ ...page, reports: page.reports.map(r => reportSummary(agency, r as any)) });
  }
  app.get('/api/visits/reports/mine', handler(false, (req: any, res: any, u: any, agency: string) => list(req, res, agency, u.id, u), true));
  app.get('/api/inspections/reports', handler(true, (req: any, res: any, u: any, agency: string) => list(req, res, agency, undefined, u), true));
  app.get('/api/inspections/reports/filters', handler(true, (_req: any, res: any, u: Person, a: string) => {
    const factories = deps.source(a).state.companies.filter(c => kind(a, c) === 'factory');
    const visibleCompanies = [...factories, ...places(a)].filter(c => visible(a, c.id, u));
    const companies = [...new Map(visibleCompanies.map(c => [c.id, { id: c.id, name: c.name }])).values()]
      .sort((x, y) => x.name.localeCompare(y.name));
    const rows = store.list(a).filter(r => visible(a, r.companyId, u));
    const agencyMashgichim = people(a).filter(p => p.role === 'mashgiach');
    let mashgichim: { id: string; name: string }[];
    if (u.role === 'admin') {
      mashgichim = agencyMashgichim.map(({ id, name }) => ({ id, name }));
    } else {
      const assignedIds = new Set(visibleCompanies.flatMap(c => schedules.company(a, c.id).mashgiachIds));
      for (const r of rows) assignedIds.add(r.mashgiachId);
      const names = new Map(agencyMashgichim.map(p => [p.id, p.name]));
      for (const r of rows) if (!names.has(r.mashgiachId)) names.set(r.mashgiachId, r.mashgiachName);
      mashgichim = [...assignedIds].map(id => ({ id, name: names.get(id) ?? id }));
    }
    res.json({ companies, mashgichim: mashgichim.sort((x, y) => x.name.localeCompare(y.name)) });
  }, true));
  app.post('/api/inspections/reports/:id/seen', handler(true, async (req: any, res: any, u: Person, a: string) => {
    const r = await store.get(a, req.params.id); if (!r || !visible(a, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    await inbox.mark(a, r, u); res.json({ status: inbox.status(a, r).status });
  }, true));
  app.put?.('/api/inspections/reports/:id/follow-up', handler(true, async (req: any, res: any, u: Person, a: string) => {
    const r = await store.get(a, req.params.id); if (!r || !visible(a, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    strictFood(req.body, ['on', 'note'], ['on']); if (typeof req.body.on !== 'boolean') invalidFood('Invalid follow-up');
    await inbox.followUp(a, r, u, req.body.on, text(req.body.note === undefined ? '' : req.body.note, 500));
    const { status, followUp } = inbox.status(a, r); res.json({ status, followUp });
  }, true));
  app.get('/api/inspections/reports/:id', handler(true, async (req: any, res: any, u: any, agency: string) => {
    const r = await store.get(agency, req.params.id);
    if (!r || !visible(agency, r.companyId, u)) return res.status(404).json({ error: 'Report not found' });
    await inbox.mark(agency, r, u);
    res.json({ report: { ...reportSummary(agency, r), note: r.note, ...(r.feeMismatch ? { feeCheck: { reportAmount: r.dataFee?.amount ?? null, setAmount: r.fee?.amount ?? null, decided: fees.doc(agency).decisions[r.id] ? (({ amount, byName, at }) => ({ amount, byName, at }))(fees.doc(agency).decisions[r.id]) : null } } : {}), ...(r.kind === 'food_service' ? { checklist: r.checklist, templateId: r.templateId, templateVersion: r.templateVersion } : { marks: r.marks, offList: r.offList }) } });
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
    const c = allPlaces(a).find(c => c.id === req.params.id);
    if (!c || !visible(a, c.id, u)) return res.status(404).json({ error: 'Company not found' });
    await schedules.update(a, { companies: { [c.id]: fn(req.body, u, a, c.id) } });
    res.json({ company: row(a, c) });
  });
  app.get('/api/inspections/schedule', handler(true, (_req: any, res: any, u: Person, a: string) => {
    const select = (role: string) => u.role === 'admin' ? people(a).filter(p => p.role === role).map(({ id, name }) => ({ id, name })) : [];
    res.json({ today: today(a), timeZone: zone(a), settings: schedules.doc(a).settings, companies: allPlaces(a).filter(c => visible(a, c.id, u)).map(c => row(a, c)).sort((a, b) => a.name.localeCompare(b.name)), people: { mashgichim: select('mashgiach'), coordinators: select('coordinator') } });
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
    const alerts = allPlaces(a).filter(c => visible(a, c.id, u, true)).map(c => row(a, c)).filter(c => c.status === 'overdue').map(c => ({ kind: c.kind, companyId: c.id, companyName: c.name, nextDue: c.nextDue, overdueDays: c.overdueDays, muted: isMuted(c.mute, today(a)) })).sort((a, b) => a.nextDue!.localeCompare(b.nextDue!) || a.companyName.localeCompare(b.companyName));
    res.json({ today: today(a), alerts });
  }));
  const pendingAlerts = new Map<string, Record<string, { alert: Alert }>>();
  let checking: Promise<any> | undefined;
  async function runCheck() {
    const sent: { companyId: string; kind: 'first' | 'reminder'; userIds: string[] }[] = []; let writes = 0;
    if (deps.staged()) return { sent, writes };
    for (const a of deps.agencyIds?.() || []) {
      if (!schedules.ready(a) || !food.ready(a)) continue;
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
        for (const company of allPlaces(a)) {
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
    for (const a of deps.scheduleAgencyIds?.() || deps.agencyIds?.() || []) { if (fees.ready(a)) await runAccountant(a); }
    return { sent, writes };
  }
  const check = () => checking ||= runCheck().finally(() => { checking = undefined; });
  if (deps.testMode) app.post('/api/__test__/inspections/check', handler('only', async (_req: any, res: any, u: Person) => {
    res.json(await check());
  }));
  return { check, foodServiceCompanyIds: async (a: string) => { await food.ensure(a); return places(a).filter(p => p.source === 'connected').map(p => p.id); }, flushSeen: inbox.flush, boot: async () => {
    await store.boot(deps.agencyIds?.() || []);
    const agencies = deps.scheduleAgencyIds?.() || deps.agencyIds?.() || [];
    await Promise.all([schedules.boot(agencies), food.boot(agencies), inbox.boot(agencies), fees.boot(agencies), companyInfo.boot(agencies)]);
  } };

}
