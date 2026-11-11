import { randomUUID } from 'node:crypto';
import { normalizeSubmit, buildReport, summary, type Fee } from './model.ts';
import { createReportStore } from './store.ts';
import type { inspectionSourceAccessor } from '../sources/routes.ts';
export function registerInspectionRoutes(app: any, deps: {
  db(): any; dataDir: string; staged(): boolean; source: ReturnType<typeof inspectionSourceAccessor>;
  user(req: any): { id: string; name: string; role: string; agencyId?: string } | undefined;
  maxPhotoChars: number; photoRe: RegExp;
}) {
  const store = createReportStore(deps), pending = new Map<string, Promise<any>>();
  let ready = false;
  const handler = (admin: boolean, fn: any) => async (req: any, res: any) => {
    const user = deps.user(req);
    if (req.kiosk || !user?.agencyId || !(admin ? user.role === 'admin' : ['admin', 'coordinator', 'mashgiach'].includes(user.role))) return res.status(403).json({ error: 'Forbidden' });
    if (!ready) return res.status(503).json({ error: 'Reports unavailable' });
    try { await fn(req, res, user, user.agencyId); }
    catch { res.status(503).json({ error: 'Report operation failed' }); }
  };
  app.get('/api/visits/factories', handler(false, (_req: any, res: any, _u: any, agency: string) => {
    const { state: s, connection: c } = deps.source(agency);
    res.json({ group1Label: c?.group1Label ?? 'Group 1', refreshedAt: s.refreshedAt ?? null, companies: s.companies.map(c => ({ id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length })).sort((a, b) => a.name.localeCompare(b.name)) });
  }));
  app.get('/api/visits/factories/:companyId', handler(false, (req: any, res: any, _u: any, agency: string) => {
    const source = deps.source(agency), c = source.state.companies.find(c => c.id === req.params.companyId);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    res.json({ company: { id: c.id, name: c.name, brand: c.brand ?? '', plant: c.plant ?? '' }, listVersion: source.listVersion(c.id), group1Label: source.connection?.group1Label ?? 'Group 1', refreshedAt: source.state.refreshedAt ?? null, ingredients: source.items(c.id, 'ingredient'), products: source.items(c.id, 'product') });
  }));
  app.post('/api/visits/reports', handler(false, async (req: any, res: any, u: any, agency: string) => {
    if (deps.staged()) return res.status(503).json({ error: 'Writes blocked' });
    const clientId = req.body?.clientReportId;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Invalid clientReportId' });
    const identity = JSON.stringify([agency, u.id, clientId]);
    const existing = store.duplicate(agency, u.id, clientId);
    if (existing) { const r = store.get(agency, existing)!; return res.status(200).json({ report: summary(r), fee: r.fee }); }
    if (pending.has(identity)) return res.status(200).json(await pending.get(identity));
    let input, report;
    try {
      input = normalizeSubmit(req.body, deps.maxPhotoChars, deps.photoRe);
      const source = deps.source(agency), company = source.state.companies.find(c => c.id === input.companyId);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      const value = source.connection?.fees?.mashgiach?.[company.id];
      const fee: Fee = value && Number.isFinite(value.amount) && typeof value.currency === 'string' ? { amount: value.amount, currency: value.currency } : null;
      report = buildReport(input, { id: randomUUID(), agencyId: agency, userId: u.id, userName: u.name, companyName: company.name, listVersion: source.listVersion(company.id), items: kind => source.items(company.id, kind), now: new Date().toISOString(), fee });
    } catch { return res.status(400).json({ error: 'Invalid report' }); }
    const task = store.save(report, input.photos).then(() => {
      console.info(`[inspections] report=${report.id} checked=${report.counts.checked} not_used=${report.counts.not_used} alert=${report.counts.alert} offList=${report.counts.offList} photos=${report.photoCount}`);
      return { report: summary(report), fee: report.fee };
    });
    pending.set(identity, task);
    try { res.status(201).json(await task); } finally { pending.delete(identity); }
  }));
  function list(req: any, res: any, agency: string, userId?: string) {
    const raw = req.query.limit, limit = raw === undefined ? (userId ? 20 : 50) : Number(raw);
    const before = req.query.before;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (before !== undefined && (typeof before !== 'string' || !Number.isFinite(Date.parse(before))))) return res.status(400).json({ error: 'Invalid pagination' });
    res.json({ reports: store.list(agency).filter(r => (!userId || r.mashgiachId === userId) && (!before || Date.parse(r.submittedAt) < Date.parse(before))).slice(0, limit).map(summary) });
  }
  app.get('/api/visits/reports/mine', handler(false, (req: any, res: any, u: any, agency: string) => list(req, res, agency, u.id)));
  app.get('/api/inspections/reports', handler(true, (req: any, res: any, _u: any, agency: string) => list(req, res, agency)));
  app.get('/api/inspections/reports/:id', handler(true, (req: any, res: any, _u: any, agency: string) => {
    const r = store.get(agency, req.params.id);
    if (!r) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: { ...summary(r), note: r.note, marks: r.marks, offList: r.offList } });
  }));
  app.get('/api/inspections/reports/:id/photos', handler(true, async (req: any, res: any, _u: any, agency: string) => {
    const r = store.get(agency, req.params.id);
    if (!r) return res.status(404).json({ error: 'Report not found' });
    res.json({ photos: await store.readPhotos(r) });
  }));
  return { boot: async () => { await store.boot(); ready = true; } };
}
