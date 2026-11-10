import { createConnector, type SourceSettings } from './stubs.ts';
import { createSourceCache, nextNightlyRun } from './cache.ts';
import { encryptKey, decryptKey, keyHint } from './crypto.ts';
import { guessMapping } from './mapping.ts';
import { createSourceStore, type Connection } from './store.ts';
import type { SourceMapping } from './types.ts';

const unreadableKey = "The saved key can't be read. Enter the key again in Settings.";
class SavedKeyError extends Error {
  constructor() { super(unreadableKey); }
}
const emptyMapping: SourceMapping = { companies: { table: '', name: '' }, ingredients: { table: '', name: '', companyLink: '' }, products: { table: '', name: '', companyLink: '' }, noSymbolValues: [] };
function settings(body: any, mapping = true) {
  if (!body || !['airtable', 'google_sheets', 'excel', 'supabase'].includes(body.sourceType)) throw Error('Invalid sourceType');
  if (typeof body.baseId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.baseId) || (body.sourceType === 'airtable' && !/^app[A-Za-z0-9]+$/.test(body.baseId))) throw Error('Invalid baseId');
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096)) throw Error('Invalid apiKey');
  if (!mapping) return;
  if (!['read', 'readwrite'].includes(body.access)) throw Error('Invalid access');
  const m = body.mapping;
  const str = (v: any) => typeof v === 'string' && v.length <= 200;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Invalid mapping');
  for (const kind of ['companies', 'ingredients', 'products']) {
    const c = m[kind];
    if (!c || !str(c.table) || !str(c.name) || (kind !== 'companies' && !str(c.companyLink))) throw Error('Invalid mapping');
    for (const [k, v] of Object.entries(c)) {
      if (k === 'factoryValues') { if (!Array.isArray(v) || v.length > 50 || !v.every(str)) throw Error('Invalid mapping'); }
      else if (!str(v)) throw Error('Invalid mapping');
    }
  }
  if (!Array.isArray(m.noSymbolValues) || m.noSymbolValues.length > 50 || !m.noSymbolValues.every(str)) throw Error('Invalid noSymbolValues');
}
export function registerSourceRoutes(app: any, deps: {
  db(): any; dataDir: string; staged(): boolean; secret(): string; testMode: boolean;
  requireAdmin(req: any, res: any): any; timeZone(id: string): string | undefined;
}) {
  const store = createSourceStore(deps), connections = new Map<string, Connection>();
  let apiBase: string | undefined;
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
  const cache = createSourceCache({ connectorFor: id => connector(connections.get(id)!), backups: { load: loadBackups } });
  const flights = new Map<string, Promise<any>>(), last = new Map<string, number>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(id: string) {
    clearTimeout(timers.get(id));
    let next: number;
    try { next = nextNightlyRun(Date.now(), deps.timeZone(id) || 'America/New_York', 3); }
    catch { next = nextNightlyRun(Date.now(), 'America/New_York', 3); }
    const timer = setTimeout(() => { void refresh(id); schedule(id); }, next - Date.now());
    timer.unref(); timers.set(id, timer);
  }
  function refresh(id: string): Promise<any> {
    if (flights.has(id)) return flights.get(id)!;
    last.set(id, Date.now());
    const start = Date.now();
    const p = (async () => {
      const c = connections.get(id)!;
      const cached = await cache.refresh(id);
      const result = keyErrors.has(id) ? { ...cached, ok: false, error: unreadableKey } : cached;
      const at = new Date().toISOString();
      const hashes = { ...c.backupHashes };
      for (const b of result.changedBackups) hashes[b.companyId] = b.hash;
      const updated = { ...c, backupHashes: hashes, lastRefresh: { at, ok: result.ok, calls: result.calls, ...(result.error ? { error: result.error } : {}) } };
      try {
        if (result.changedBackups.length || c.lastRefresh?.at.slice(0, 10) !== at.slice(0, 10)) {
          await store.save(updated, result.changedBackups);
          connections.set(id, updated);
        }
      } catch { console.warn(`[sources] persistence failed agency=${id}`); cache.setKnownHashes(id, c.backupHashes); }
      console.info(`[sources] agency=${id} ok=${result.ok} calls=${result.calls} ms=${Date.now() - start}`);
      return { ok: result.ok, status: status(id), calls: result.calls, refreshedAt: cache.state(id).refreshedAt || null };
    })().finally(() => flights.delete(id));
    flights.set(id, p); return p;
  }
  const own = (req: any, res: any) => { const u = deps.requireAdmin(req, res); return u ? { user: u, id: u.agencyId || 'agency-hkc' } : null; };
  const safe = (id: string) => {
    const c = connections.get(id), s = cache.state(id);
    return { sourceType: c?.sourceType || null, baseId: c?.baseId || '', access: c?.access || 'read', mapping: c?.mapping || null, hasKey: !!c?.encryptedKey, keyHint: c?.keyHint || '', status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupTakenAt: s.backupTakenAt || null, error: keyErrors.has(id) ? unreadableKey : s.error || null };
  };
  const handler = (fn: any) => async (req: any, res: any) => { const caller = own(req, res); if (!caller) return; try { await fn(req, res, caller); } catch (cause) { res.status(cause instanceof SavedKeyError ? 400 : 503).json({ error: cause instanceof SavedKeyError ? unreadableKey : 'Source operation failed' }); } };
  app.get('/api/sources/connection', handler((_req: any, res: any, { id }: any) => res.json(safe(id))));
  app.put('/api/sources/connection', handler(async (req: any, res: any, { id, user }: any) => {
    try { settings(req.body); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    if (flights.has(id)) await flights.get(id);
    const old = connections.get(id), plain = req.body.apiKey?.trim();
    if (!plain && !old?.encryptedKey) return res.status(400).json({ error: 'API key required' });
    const c: Connection = { agencyId: id, sourceType: req.body.sourceType, baseId: req.body.baseId, access: req.body.access, mapping: req.body.mapping, encryptedKey: plain ? encryptKey(plain, deps.secret(), id) : old!.encryptedKey, keyHint: plain ? keyHint(plain) : old!.keyHint, updatedAt: new Date().toISOString(), updatedBy: user.id, backupHashes: old?.backupHashes || {}, ...(old?.lastRefresh ? { lastRefresh: old.lastRefresh } : {}) };
    await store.save(c); connections.set(id, c); res.json(safe(id)); schedule(id); void refresh(id);
  }));
  app.post('/api/sources/test', handler(async (req: any, res: any, { id }: any) => {
    try { settings(req.body, false); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    const old = connections.get(id), plain = req.body.apiKey?.trim();
    if (!plain && !old) return res.status(400).json({ error: 'API key required' });
    const c = { ...old, ...req.body, agencyId: id, mapping: old?.mapping || emptyMapping } as Connection;
    const result = await connector(c, plain).testConnection();
    res.json(result.ok ? { ...result, guess: guessMapping(result.tables || []) } : { ok: false, error: result.error });
  }));
  app.post('/api/sources/refresh', handler(async (_req: any, res: any, { id }: any) => {
    if (!connections.has(id)) return res.status(400).json({ error: 'No source connected' });
    if (Date.now() - (last.get(id) || 0) < 60_000) return res.status(429).json({ error: 'Just refreshed, try again in a minute' });
    res.json(await refresh(id));
  }));
  app.get('/api/factories', handler((_req: any, res: any, { id }: any) => {
    const s = cache.state(id), c = connections.get(id);
    res.json({ status: { connected: !!c, sourceType: c?.sourceType || null, status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupTakenAt: s.backupTakenAt || null }, companies: s.companies.map(c => ({ id: c.id, name: c.name, brand: c.brand || '', plant: c.plant || '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length, lastVisitAt: null, nextDueAt: null, overdue: null })).sort((a, b) => a.name.localeCompare(b.name)) });
  }));
  if (deps.testMode) {
    app.post('/api/__test__/sources-api-base', handler((req: any, res: any) => { const url = new URL(req.body.url); if (!['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ error: 'Invalid URL' }); apiBase = url.origin; res.json({ ok: true }); }));
    app.post('/api/__test__/source-raw', handler(async (req: any, res: any, { id }: any) => { if (req.body.agencyId && req.body.agencyId !== id) return res.status(403).json({ error: 'Forbidden' }); res.json({ connection: await store.raw(id), backupIds: (await loadBackups(id)).map(b => `${id}__${b.companyId}`) }); }));
  }
  return {
    async boot() {
      try {
        for (const c of await store.connections()) {
          connections.set(c.agencyId, c);
          cache.setKnownHashes(c.agencyId, c.backupHashes || {});
          schedule(c.agencyId);
          void refresh(c.agencyId).catch(() => console.warn('[sources] startup refresh failed'));
        }
      } catch { console.warn('[sources] startup failed'); }
    },
  };
}
