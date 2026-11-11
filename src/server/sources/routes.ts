import { createConnector, type SourceSettings } from './stubs.ts';
import { createSourceCache, nextNightlyRun } from './cache.ts';
import { encryptKey, decryptKey, keyHint } from './crypto.ts';
import { guessMapping } from './mapping.ts';
import { createSourceStore, type Connection } from './store.ts';
import type { ConnectionResult, SourceMapping } from './types.ts';

const unreadableKey = "The saved key can't be read. Enter the key again in Settings.";
class SavedKeyError extends Error {
  constructor() { super(unreadableKey); }
}
const emptyMapping: SourceMapping = { companies: { table: '', name: '' }, ingredients: { table: '', name: '', companyLink: '' }, products: { table: '', name: '', companyLink: '' }, group1Values: [] };
function settings(body: any, mapping = true) {
  if (!body || !['airtable', 'google_sheets', 'excel', 'supabase'].includes(body.sourceType)) throw Error('Invalid sourceType');
  if (typeof body.baseId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.baseId) || (body.sourceType === 'airtable' && !/^app[A-Za-z0-9]+$/.test(body.baseId))) throw Error('Invalid baseId');
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096)) throw Error('Invalid apiKey');
  if (body.sourceType !== 'airtable') throw Error('This source is not available yet.');
  if (!mapping) return;
  if (body.group1Label !== undefined && (typeof body.group1Label !== 'string' || !body.group1Label.trim() || body.group1Label.trim().length > 30)) throw Error('Invalid group1Label');
  if (!['read', 'readwrite'].includes(body.access)) throw Error('Invalid access');
  const m = body.mapping;
  const str = (v: any) => typeof v === 'string' && v.length <= 200;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Invalid mapping');
  for (const kind of ['companies', 'ingredients', 'products']) {
    const c = m[kind];
    if (!c || !str(c.table) || !c.table.trim() || !str(c.name) || !c.name.trim() || (kind !== 'companies' && (!str(c.companyLink) || !c.companyLink.trim()))) throw Error('Invalid mapping');
    for (const [k, v] of Object.entries(c)) {
      if (k === 'factoryValues') { if (!Array.isArray(v) || v.length > 50 || !v.every(str)) throw Error('Invalid mapping'); }
      else if (!str(v)) throw Error('Invalid mapping');
    }
  }
  if (m.valueAssignments !== undefined) {
    if (!m.valueAssignments || typeof m.valueAssignments !== 'object' || Array.isArray(m.valueAssignments)) throw Error('Invalid valueAssignments');
    let count = 0;
    for (const [column, values] of Object.entries(m.valueAssignments)) {
      if (!str(column) || !values || typeof values !== 'object' || Array.isArray(values)) throw Error('Invalid valueAssignments');
      for (const [value, a] of Object.entries(values)) {
        const assignment = a as any;
        if (++count > 300 || value.length > 10000 || !assignment || typeof assignment !== 'object' || Array.isArray(assignment) || Object.keys(assignment).some(k => !['agency', 'dpm', 'group1'].includes(k)) || (assignment.agency !== undefined && !str(assignment.agency)) || (assignment.dpm !== undefined && !['', 'dairy', 'pareve', 'meat'].includes(assignment.dpm)) || (assignment.group1 !== undefined && typeof assignment.group1 !== 'boolean')) throw Error('Invalid valueAssignments');
      }
    }
  }
  if (!Array.isArray(m.group1Values) || m.group1Values.length > 50 || !m.group1Values.every(str)) throw Error('Invalid group1Values');
}
export function registerSourceRoutes(app: any, deps: {
  db(): any; dataDir: string; staged(): boolean; secret(): string; testMode: boolean;
  requireAdmin(req: any, res: any): any; timeZone(id: string): string | undefined;
}) {
  const store = createSourceStore(deps), connections = new Map<string, Connection>();
  let apiBase: string | undefined;
  const tested = new Map<string, { baseId: string; sourceType: string; key: string; at: number; result: ConnectionResult }>();
  const backupErrors = new Set<string>();
  const pending = new Map<string, { connection: Connection; backups: import('./cache.ts').Backup[]; attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  const keyErrors = new Set<string>();
  function storedKey(c: Connection): string {
    try {
      const plain = decryptKey(c.encryptedKey, deps.secret(), c.agencyId);
      keyErrors.delete(c.agencyId);
      return plain;
    } catch {
      keyErrors.add(c.agencyId);
      throw new SavedKeyError();
    }
  }
  const status = (id: string) => keyErrors.has(id) ? 'error' : cache.state(id).status;
  const connector = (c: Connection, plain?: string) => createConnector({ kind: c.sourceType, baseId: c.baseId, spreadsheetId: c.baseId, workbookId: c.baseId, url: c.baseId, mapping: c.mapping, ...(deps.testMode && apiBase ? { apiBase } : {}) } as SourceSettings, plain || storedKey(c));
  const loadBackups = (id: string) => store.load(id, Object.keys(connections.get(id)?.backupHashes || {}));
  const cache = createSourceCache({ mappingFor: id => connections.get(id)?.mapping, connectorFor: id => connector(connections.get(id)!), backups: { load: loadBackups }, group1SettingsFor: id => ({ group1Label: connections.get(id)?.group1Label || 'Group 1', group1Overrides: connections.get(id)?.group1Overrides, valueAssignments: connections.get(id)?.mapping.valueAssignments }) });
  const flights = new Map<string, Promise<any>>(), last = new Map<string, number>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(id: string) {
    clearTimeout(timers.get(id));
    let next: number;
    try { next = nextNightlyRun(Date.now(), deps.timeZone(id) || 'America/New_York', 3); }
    catch { next = nextNightlyRun(Date.now(), 'America/New_York', 3); }
    const timer = setTimeout(() => { void refresh(id); schedule(id); }, next - Date.now());
    timer.unref(); timers.set(id, timer);
  }
  const mutations = new Map<string, Promise<any>>();
  function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = mutations.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    mutations.set(id, next);
    void next.finally(() => { if (mutations.get(id) === next) mutations.delete(id); }).catch(() => {});
    return next;
  }
  // Serialize persistence so an already-running retry cannot overwrite a later PUT.
  const saves = new Map<string, Promise<void>>();
  function save(c: Connection, backups: import('./cache.ts').Backup[] = []) {
    const previous = saves.get(c.agencyId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => store.save(c, backups));
    saves.set(c.agencyId, next);
    void next.finally(() => { if (saves.get(c.agencyId) === next) saves.delete(c.agencyId); }).catch(() => {});
    return next;
  }
  function retrySave(id: string, connection: Connection, backups: import('./cache.ts').Backup[], attempt = 0) {
    clearTimeout(pending.get(id)?.timer);
    const job = { connection, backups, attempt, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    pending.set(id, job);
    job.timer = setTimeout(() => { void serialize(id, async () => {
      if (pending.get(id) !== job) return;
      try {
        if (deps.staged()) { retrySave(id, job.connection, backups, attempt + 1); return; }
        await save(job.connection, backups);
        if (pending.get(id) !== job) return;
        connections.set(id, job.connection); cache.setKnownHashes(id, job.connection.backupHashes);
        backupErrors.delete(id); pending.delete(id);
      } catch { if (pending.get(id) === job) retrySave(id, job.connection, backups, attempt + 1); }
    }); }, Math.min(3600_000, 5000 * 3 ** Math.min(attempt, 10)));
    job.timer.unref();
  }
  function refresh(id: string): Promise<any> {
    if (flights.has(id)) return flights.get(id)!;
    last.set(id, Date.now());
    const start = Date.now();
    const priorSave = pending.get(id);
    clearTimeout(priorSave?.timer); pending.delete(id);
    const p = (async () => {
      await saves.get(id)?.catch(() => {});
      const c = connections.get(id)!;
      const cached = await cache.refresh(id);
      const result = keyErrors.has(id) ? { ...cached, ok: false, error: unreadableKey } : cached;
      const toSave = result.ok ? result.changedBackups : priorSave?.backups || [];
      const at = new Date().toISOString();
      const hashes = { ...c.backupHashes };
      for (const b of toSave) hashes[b.companyId] = b.hash;
      const updated = { ...c, backupHashes: hashes, lastRefresh: { at, ok: result.ok, calls: result.calls, ...(result.error ? { error: result.error } : {}) } };
      try {
        if (!deps.staged() && (toSave.length || c.lastRefresh?.at.slice(0, 10) !== at.slice(0, 10))) {
          await save(updated, toSave);
          connections.set(id, updated); backupErrors.delete(id); cache.setKnownHashes(id, hashes);
        }
      } catch { console.warn(`[sources] persistence failed agency=${id}`); backupErrors.add(id); cache.setKnownHashes(id, c.backupHashes); retrySave(id, updated, toSave); }
      console.info(`[sources] agency=${id} ok=${result.ok} calls=${result.calls} ms=${Date.now() - start}`);
      return { ok: result.ok, status: status(id), calls: result.calls, refreshedAt: cache.state(id).refreshedAt || null };
    })().finally(() => flights.delete(id));
    flights.set(id, p); return p;
  }
  const own = (req: any, res: any) => { const u = deps.requireAdmin(req, res); return u ? { user: u, id: u.agencyId || 'agency-hkc' } : null; };
  const safe = (id: string) => {
    const c = connections.get(id), s = cache.state(id);
    return { group1Label: c?.group1Label || 'Group 1', sourceType: c?.sourceType || null, baseId: c?.baseId || '', access: c?.access || 'read', mapping: c?.mapping || null, hasKey: !!c?.encryptedKey, keyHint: c?.keyHint || '', status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: keyErrors.has(id) ? unreadableKey : s.error || null };
  };
  const handler = (fn: any) => async (req: any, res: any) => { const caller = own(req, res); if (!caller) return; try { await fn(req, res, caller); } catch (cause) { res.status(cause instanceof SavedKeyError ? 400 : 503).json({ error: cause instanceof SavedKeyError ? unreadableKey : 'Source operation failed' }); } };
  const mutation = (fn: any) => handler((req: any, res: any, caller: any) => serialize(caller.id, () => fn(req, res, caller)));
  app.get('/api/sources/connection', handler((_req: any, res: any, { id }: any) => res.json(safe(id))));
  app.put('/api/sources/connection', mutation(async (req: any, res: any, { id, user }: any) => {
    try { settings(req.body); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    if (flights.has(id)) await flights.get(id);
    await saves.get(id)?.catch(() => {});
    const old = connections.get(id), plain = req.body.apiKey?.trim();
    if (!plain && !old?.encryptedKey) return res.status(400).json({ error: 'API key required' });
    const c: Connection = { group1Label: req.body.group1Label?.trim() ?? old?.group1Label ?? 'Group 1', group1Overrides: old?.group1Overrides || { ingredient: {}, product: {} }, agencyId: id, sourceType: req.body.sourceType, baseId: req.body.baseId, access: req.body.access, mapping: req.body.mapping, encryptedKey: plain ? encryptKey(plain, deps.secret(), id) : old!.encryptedKey, keyHint: plain ? keyHint(plain) : old!.keyHint, updatedAt: new Date().toISOString(), updatedBy: user.id, backupHashes: old?.backupHashes || {}, ...(old?.lastRefresh ? { lastRefresh: old.lastRefresh } : {}) };
    const key = plain || storedKey(c), recent = tested.get(id);
    let validation = recent && recent.baseId === c.baseId && recent.sourceType === c.sourceType && recent.key === key && Date.now() - recent.at < 30 * 60_000 ? recent.result : undefined;
    if (!validation) {
      validation = await connector(c, key).testConnection();
      if (validation.ok) tested.set(id, { baseId: c.baseId, sourceType: c.sourceType, key, at: Date.now(), result: validation });
    }
    if (!validation.ok) return res.status(400).json({ error: validation.error || 'Connection test failed' });
    for (const kind of ['companies', 'ingredients', 'products'] as const) {
      const config = c.mapping[kind], table = validation.tables?.find(t => t.name === config.table);
      if (!table || Object.entries(config).some(([field, column]) => field !== 'table' && typeof column === 'string' && !table.columns.includes(column))) return res.status(400).json({ error: 'Mapped tables and columns must exist in the source.' });
    }
    let keyChanged = false;
    if (plain && old) {
      try { keyChanged = plain !== decryptKey(old.encryptedKey, deps.secret(), id); }
      catch { keyChanged = true; }
    }
    const changed = !old || old.baseId !== c.baseId || old.sourceType !== c.sourceType || JSON.stringify(old.mapping) !== JSON.stringify(c.mapping) || keyChanged;
    if (changed) { c.backupHashes = {}; delete c.lastRefresh; }
    if (old?.backupParts) c.backupParts = old.backupParts;
    const job = pending.get(id); clearTimeout(job?.timer); pending.delete(id);
    try { await save(c); } catch (cause) { if (job) retrySave(id, job.connection, job.backups, job.attempt); throw cause; }
    backupErrors.delete(id);
    connections.set(id, c); keyErrors.delete(id);
    if (changed && (!old || old.baseId !== c.baseId || old.sourceType !== c.sourceType || keyChanged || JSON.stringify({ ...old.mapping, valueAssignments: undefined }) !== JSON.stringify({ ...c.mapping, valueAssignments: undefined }))) cache.reset(id);
    else cache.reassign(id, c.mapping);
    res.json(safe(id)); schedule(id); void refresh(id);
  }));
  app.post('/api/sources/test', handler(async (req: any, res: any, { id }: any) => {
    try { settings(req.body, false); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    const old = connections.get(id), plain = req.body.apiKey?.trim();
    if (!plain && !old) return res.status(400).json({ error: 'API key required' });
    const c = { ...old, ...req.body, agencyId: id, mapping: old?.mapping || emptyMapping } as Connection;
    const adapter = connector(c, plain), result = await adapter.testConnection();
    if (!result.ok) return res.json({ ok: false, error: result.error, calls: adapter.calls() });
    tested.set(id, { baseId: c.baseId, sourceType: c.sourceType, key: plain || storedKey(c), at: Date.now(), result });
    const guess = guessMapping(result.tables || []);
    const preferred = new Set([guess.mapping.companies.table, guess.mapping.ingredients.table, guess.mapping.products.table]);
    const tables = [...(result.tables || [])].sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)));
    let samples;
    try { samples = adapter.samples ? await adapter.samples(tables.slice(0, 15)) : {}; }
    catch { return res.json({ ok: false, error: 'Source preview failed', calls: adapter.calls() }); }
    res.json({ ...result, guess, samples, calls: adapter.calls() });
  }));
  app.post('/api/sources/refresh', handler(async (_req: any, res: any, { id }: any) => {
    if (!connections.has(id)) return res.status(400).json({ error: 'No source connected' });
    if (Date.now() - (last.get(id) || 0) < 60_000) return res.status(429).json({ error: 'Just refreshed, try again in a minute' });
    res.json(await refresh(id));
  }));
  app.get('/api/sources/values', handler((req: any, res: any, { id }: any) => {
    const mapping = connections.get(id)?.mapping, data = cache.data(id);
    const counts = new Map<string, { column: string; value: string; count: number }>();
    if (mapping && data) for (const kind of ['ingredients', 'products'] as const) {
      const config = mapping[kind];
      for (const column of new Set([config.certification, config.status, config.agency].filter(Boolean))) {
        const field = config.certification === column ? 'certificationRaw' : config.status === column ? 'statusRaw' : 'agencyRaw';
        for (const item of data[kind]) {
          const value = item[field]; if (!value) continue;
          const key = JSON.stringify([column, value]), prior = counts.get(key);
          counts.set(key, { column: column!, value, count: (prior?.count || 0) + 1 });
        }
      }
    }
    const all = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const search = typeof req.query?.q === 'string' ? req.query.q.toLowerCase() : '';
    res.json({ total: all.length, values: all.filter(v => v.value.toLowerCase().includes(search)).slice(0, 300) });
  }));
  const items = (id: string, companyId: string, kind: 'ingredient' | 'product') =>
    cache.state(id).itemsFor(companyId, kind).map(item => {
      const override = connections.get(id)?.group1Overrides?.[kind]?.[item.id];
      return { certificationRaw: item.certificationRaw, statusRaw: item.statusRaw, agencyRaw: item.agencyRaw, confidence: item.confidence, id: item.id, name: item.name, agency: 'certifyingAgency' in item ? item.certifyingAgency || '' : '',
        dpm: item.dpm || null, group1: typeof override === 'boolean' ? override : item.group1 === true,
        group1Source: typeof override === 'boolean' ? 'admin' : 'source' };
    });
  app.get('/api/factories/:companyId/items', handler((req: any, res: any, { id }: any) => {
    if (!cache.state(id).companies.some(c => c.id === req.params.companyId)) return res.status(404).json({ error: 'Company not found' });
    res.json({ ingredients: items(id, req.params.companyId, 'ingredient'), products: items(id, req.params.companyId, 'product') });
  }));
  app.put('/api/sources/group1', mutation(async (req: any, res: any, { id, user }: any) => {
    const { kind, itemId, group1 } = req.body || {};
    if (!['ingredient', 'product'].includes(kind) || typeof itemId !== 'string' || !itemId.trim() || itemId.length > 200 || !(typeof group1 === 'boolean' || group1 === null))
      return res.status(400).json({ error: 'Invalid status change' });
    // Wait for in-flight refresh persistence; never fetch the source for a hand mark.
    if (flights.has(id)) await flights.get(id);
    await saves.get(id)?.catch(() => {});
    const c = connections.get(id), state = cache.state(id);
    if (!c || !state.companies.some(company => state.itemsFor(company.id, kind).some(item => item.id === itemId)))
      return res.status(404).json({ error: 'Item not found' });
    const overrides = { ingredient: { ...c.group1Overrides?.ingredient }, product: { ...c.group1Overrides?.product } };
    if (group1 === null) delete overrides[kind as 'ingredient' | 'product'][itemId];
    else overrides[kind as 'ingredient' | 'product'] = { ...overrides[kind as 'ingredient' | 'product'], [itemId]: group1 };
    const updated = { ...c, group1Overrides: overrides, updatedAt: new Date().toISOString(), updatedBy: user.id };
    // A pending retry must retain the latest settings too.
    const job = pending.get(id);
    await save(updated);
    connections.set(id, updated);
    if (job) job.connection = { ...job.connection, group1Overrides: overrides };
    const company = state.companies.find(company => state.itemsFor(company.id, kind).some(item => item.id === itemId))!;
    res.json({ item: items(id, company.id, kind).find(item => item.id === itemId) });
  }));
  app.get('/api/factories', handler((_req: any, res: any, { id }: any) => {
    const s = cache.state(id), c = connections.get(id);
    res.json({ status: { group1Label: c?.group1Label || 'Group 1', connected: !!c, sourceType: c?.sourceType || null, status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: s.error || null }, companies: s.companies.map(c => ({ id: c.id, name: c.name, brand: c.brand || '', plant: c.plant || '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length, lastVisitAt: null, nextDueAt: null, overdue: null })).sort((a, b) => a.name.localeCompare(b.name)) });
  }));
  if (deps.testMode) {
    app.post('/api/__test__/sources-api-base', handler((req: any, res: any) => { const url = new URL(req.body.url); if (!['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ error: 'Invalid URL' }); apiBase = url.origin; res.json({ ok: true }); }));
    app.post('/api/__test__/source-raw', handler(async (req: any, res: any, { id }: any) => { if (req.body.agencyId && req.body.agencyId !== id) return res.status(403).json({ error: 'Forbidden' }); res.json({ connection: await store.raw(id), backupIds: (await loadBackups(id)).map(b => `${id}__${b.companyId}`) }); }));
  }
  let bootAttempt = 0;
  async function boot() {
    try {
      for (const c of await store.connections()) {
        if (connections.has(c.agencyId)) continue;
        connections.set(c.agencyId, c);
        cache.setKnownHashes(c.agencyId, c.backupHashes || {});
        schedule(c.agencyId);
        void refresh(c.agencyId).catch(() => console.warn('[sources] startup refresh failed'));
      }
    } catch {
      console.warn('[sources] startup failed');
      const delay = [5000, 15000, 45000, 120000, 300000][Math.min(bootAttempt++, 4)];
      const timer = setTimeout(() => { void boot(); }, delay); timer.unref();
    }
  }
  return { boot };
}
