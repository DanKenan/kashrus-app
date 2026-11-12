import { createOAuth, isOAuthProvider, type OAuthProvider } from './oauth.ts';
import { createGoogleSheetsApi } from './google-sheets.ts';
import { createExcelApi } from './excel.ts';
import { validSupabaseUrl } from './supabase.ts';
import { parseUpload, uploadRowsError, uploadTypeError, type UploadedFile } from './upload.ts';
import { guardSourceWrite } from './write.ts';
import { applyMapping } from './mapping.ts';
import { summarizeValues } from '../../lib/sourcePreview.ts';
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
  if (!body || !['airtable', 'google_sheets', 'excel', 'supabase', 'upload'].includes(body.sourceType)) throw Error('Invalid sourceType');
  if (typeof body.baseId !== 'string' || !(body.sourceType === 'supabase' ? validSupabaseUrl(body.baseId) : /^[A-Za-z0-9_-]{1,200}$/.test(body.baseId)) || (body.sourceType === 'airtable' && !/^app[A-Za-z0-9]+$/.test(body.baseId))) throw Error('Invalid baseId');
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096)) throw Error('Invalid apiKey');
  if (body.apiKey !== undefined && !['airtable','supabase'].includes(body.sourceType)) throw Error('API keys are not used for this source.');
  if (!mapping) return;
  if (body.group1Label !== undefined && (typeof body.group1Label !== 'string' || !body.group1Label.trim() || body.group1Label.trim().length > 30)) throw Error('Invalid group1Label');
  if (!['read', 'readwrite'].includes(body.access)) throw Error('Invalid access');
  const m = body.mapping;
  const str = (v: any) => typeof v === 'string' && v.length <= 200;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Invalid mapping');
  for (const kind of ['companies', 'ingredients', 'products']) {
    const c = m[kind];
    if (body.sourceType !== 'airtable' && kind !== 'companies' && c?.table === '') continue;
    if (!c || !str(c.table) || !c.table.trim() || !str(c.name) || !c.name.trim() || (kind !== 'companies' && (!str(c.companyLink) || !c.companyLink.trim()))) throw Error('Invalid mapping');
    for (const [k, v] of Object.entries(c)) {
      if (k === 'file' && body.sourceType !== 'airtable') { const f=v as any; if(!f || !str(f.id) || !str(f.name)) throw Error('Invalid mapping'); }
      else if ((k === 'factoryValues' || k === 'foodServiceValues')) { if (!Array.isArray(v) || v.length > 50 || !v.every(str)) throw Error('Invalid mapping'); }
      else if (!str(v)) throw Error('Invalid mapping');
    }
  }
  if (m.valueAssignments !== undefined) {
    if (!m.valueAssignments || typeof m.valueAssignments !== 'object' || Array.isArray(m.valueAssignments)) throw Error('Invalid valueAssignments');
    let count = 0;
    const scopes = Object.keys(m.valueAssignments).every(k => ['ingredient', 'product'].includes(k))
      ? Object.values(m.valueAssignments) : [m.valueAssignments];
    for (const scope of scopes) {
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw Error('Invalid valueAssignments');
      for (const [column, values] of Object.entries(scope)) {
        if (!str(column) || !values || typeof values !== 'object' || Array.isArray(values)) throw Error('Invalid valueAssignments');
        for (const [value, a] of Object.entries(values)) {
          const assignment = a as any;
          if (++count > 300 || value.length > 10000 || !assignment || typeof assignment !== 'object' || Array.isArray(assignment) || Object.keys(assignment).some(k => !['agency', 'dpm', 'group1'].includes(k)) || (assignment.agency !== undefined && !str(assignment.agency)) || (assignment.dpm !== undefined && !['', 'dairy', 'dairy_equipment', 'pareve', 'meat'].includes(assignment.dpm)) || (assignment.group1 !== undefined && typeof assignment.group1 !== 'boolean')) throw Error('Invalid valueAssignments');
        }
      }
    }
  }
  if (!Array.isArray(m.group1Values) || m.group1Values.length > 50 || !m.group1Values.every(str)) throw Error('Invalid group1Values');
}
export function registerSourceRoutes(app: any, deps: {
  db(): any; dataDir: string; staged(): boolean; secret(): string; testMode: boolean;
  agencyName?(agencyId: string): string;
  foodServiceCompanyIds?(agencyId: string): Promise<string[]>;
  requireAdmin(req: any, res: any): any; timeZone(id: string): string | undefined;
}) {
  const store = createSourceStore(deps), connections = new Map<string, Connection>();
  let apiBase: string | undefined;
  const apiBases = new Map<string,string>(), uploads = new Map<string,UploadedFile[]>();
  const oauth = createOAuth({secret:deps.secret,apiBase:p=>deps.testMode?apiBases.get(p):undefined});
  const oauthRecord=(id:string,p:OAuthProvider)=>connections.get(id)?.oauth?.[p];
  const token=(id:string,p:OAuthProvider)=>(force=false)=>oauth.token(id,p,oauthRecord(id,p),force).then(t=>t.accessToken);
  const providerApi=(id:string,p:OAuthProvider,fileId='')=>p==='google_sheets'?createGoogleSheetsApi({spreadsheetId:fileId,mapping:emptyMapping,apiBase:apiBases.get(p),token:token(id,p)}):createExcelApi({workbookId:fileId,mapping:emptyMapping,apiBase:apiBases.get(p),token:token(id,p)});
  function blank(id:string,userId:string,sourceType:Connection['sourceType']):Connection {return {agencyId:id,sourceType,baseId:sourceType==='upload'?'upload':'',access:'read',mapping:structuredClone(emptyMapping),encryptedKey:'',keyHint:'',updatedAt:new Date().toISOString(),updatedBy:userId,backupHashes:{}};}

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
  const connector = (c: Connection, plain?: string) => createConnector({ kind: c.sourceType, baseId: c.baseId, spreadsheetId: c.baseId, workbookId: c.baseId, url: c.baseId, mapping: c.mapping, files:uploads.get(c.agencyId)||[], ...(isOAuthProvider(c.sourceType)?{token:token(c.agencyId,c.sourceType)}:{}), ...(deps.testMode ? { apiBase: c.sourceType==='airtable'?apiBase:apiBases.get(c.sourceType) } : {}) } as SourceSettings, plain || (['airtable','supabase'].includes(c.sourceType)?storedKey(c):''));
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
  const unconfirmed = new Map<string, Map<string, import('./cache.ts').Backup>>();
  function save(c: Connection, backups: import('./cache.ts').Backup[] = []) {
    const previous = saves.get(c.agencyId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const dirty = unconfirmed.get(c.agencyId);
      const newest = new Map(backups.map(b => [b.companyId, b]));
      for (const b of dirty?.values() || []) newest.set(b.companyId, b);
      const snapshot = [...newest.values()];
      const hashes = { ...c.backupHashes };
      for (const b of snapshot) hashes[b.companyId] = b.hash;
      const persisted = { ...c, backupHashes: hashes };
      await store.save(persisted, snapshot);
      c.backupParts = persisted.backupParts;
      backupErrors.delete(c.agencyId);
      c.backupHashes = hashes;
      cache.setKnownHashes(c.agencyId, hashes);
      for (const b of snapshot) if (dirty?.get(b.companyId)?.hash === b.hash) dirty.delete(b.companyId);
    });
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
      if(c.sourceType==='upload') return {ok:result.ok,status:status(id),calls:0,refreshedAt:cache.state(id).refreshedAt||null};
      const dirty = unconfirmed.get(id) || new Map();
      for (const b of result.latestBackups || [])
        if (dirty.has(b.companyId) || c.backupHashes[b.companyId] !== b.hash) dirty.set(b.companyId, b);
      unconfirmed.set(id, dirty);
      const toSave = [...dirty.values()];
      const at = new Date().toISOString();
      const hashes = { ...c.backupHashes };
      for (const b of toSave) hashes[b.companyId] = b.hash;
      const updated = { ...c, backupHashes: hashes, lastRefresh: { at, ok: result.ok, calls: result.calls, ...(result.error ? { error: result.error } : {}) } };
      try {
        if (!deps.staged() && (toSave.length || c.lastRefresh?.at.slice(0, 10) !== at.slice(0, 10))) {
          await save(updated, toSave);
          connections.set(id, updated); backupErrors.delete(id); cache.setKnownHashes(id, updated.backupHashes);
        }
        else if (toSave.length) retrySave(id, updated, toSave);
      } catch { console.warn(`[sources] persistence failed agency=${id}`); backupErrors.add(id); cache.setKnownHashes(id, c.backupHashes); retrySave(id, updated, toSave); }
      console.info(`[sources] agency=${id} ok=${result.ok} calls=${result.calls} ms=${Date.now() - start}`);
      return { ok: result.ok, status: status(id), calls: result.calls, refreshedAt: cache.state(id).refreshedAt || null };
    })().finally(() => flights.delete(id));
    flights.set(id, p); return p;
  }
  const own = (req: any, res: any) => { const u = deps.requireAdmin(req, res); return u ? { user: u, id: u.agencyId || 'agency-hkc' } : null; };
  const safe = (id: string) => {
    const c = connections.get(id), s = cache.state(id);
    return { canWrite:!!c && c.access==='readwrite' && ['google_sheets','excel','supabase'].includes(c.sourceType), counts:{companies:s.companies.length,ingredients:cache.data(id)?.ingredients.length||0,products:cache.data(id)?.products.length||0}, ...(c?.upload?{fileName:c.upload.fileNames[0],upload:{fileNames:c.upload.fileNames,copiedAt:c.upload.copiedAt,rows:c.upload.rows}}:{}), ...(c && isOAuthProvider(c.sourceType) && c.oauth?.[c.sourceType]?{accountEmail:oauth.email(id,c.oauth[c.sourceType])}:{}), group1Label: c?.group1Label || 'Group 1', sourceType: c?.sourceType || null, baseId: c?.baseId || '', access: c?.access || 'read', mapping: c?.mapping || null, hasKey: !!c?.encryptedKey, keyHint: c?.keyHint || '', status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: keyErrors.has(id) ? unreadableKey : s.error || null };
  };
  const handler = (fn: any) => async (req: any, res: any) => { const caller = own(req, res); if (!caller) return; try { await fn(req, res, caller); } catch (cause:any) { const code=cause instanceof SavedKeyError?400:[400,403,409,429].includes(cause.status)?cause.status:503; res.status(code).json({ error: cause instanceof SavedKeyError ? unreadableKey : code===503?'Source operation failed':cause.message,...(cause.notSetUp?{notSetUp:true}:{}) }); } };
  const mutation = (fn: any) => handler((req: any, res: any, caller: any) => serialize(caller.id, () => fn(req, res, caller)));
  const blocked = (res: any) => { if (deps.staged()) {
      res.status(503).json({ error: 'Writes blocked' });
      return true;
  } return false; };
  const accessValue = (access: any): access is 'read' | 'readwrite' => access === 'read' || access === 'readwrite';
  async function saveOther(req: any, res: any, id: string, user: any) {
      if (blocked(res))
          return;
      try {
          settings(req.body);
      }
      catch (e: any) {
          return res.status(400).json({ error: e.message });
      }
      if (flights.has(id))
          await flights.get(id);
      await saves.get(id)?.catch(() => { });
      const old = connections.get(id), body = req.body, p = body.sourceType;
      if (isOAuthProvider(p)) {
          oauth.requireSetUp(p);
          const r = old?.oauth?.[p];
          if (!r || body.access === 'readwrite' && r.access !== 'readwrite')
              return res.status(409).json({ error: 'Sign in required', needsSignIn: true });
      }
      if (p === 'upload' && !uploads.get(id)?.length)
          return res.status(400).json({ error: 'Upload a file first' });
      const plain = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (p === 'supabase' && !plain && !(old?.sourceType === 'supabase' && old.encryptedKey))
          return res.status(400).json({ error: 'API key required' });
      const c: Connection = { ...(old || blank(id, user.id, p)), sourceType: p, baseId: body.baseId, access: p === 'upload' ? 'read' : body.access, mapping: body.mapping, group1Label: body.group1Label?.trim() || old?.group1Label || 'Group 1', updatedAt: new Date().toISOString(), updatedBy: user.id, encryptedKey: p === 'supabase' ? (plain ? encryptKey(plain, deps.secret(), id) : old!.encryptedKey) : '', keyHint: p === 'supabase' ? (plain ? keyHint(plain) : old!.keyHint) : '', backupHashes: {} };
      const adapter = connector(c, plain || undefined);
      // Validate each file separately, including a list whose tab has the same name.
      for (const list of ['companies', 'ingredients', 'products'] as const) {
          const config = c.mapping[list];
          if (!config.table)
              continue;
          const perFile = config.file && isOAuthProvider(p) ? connector({ ...c, baseId: config.file.id }) : adapter;
          const tables = await perFile.listTables!();
          const table = tables.find(t => t.name === config.table);
          if (!table || Object.entries(config).some(([field, col]) => !['table', 'file', 'pk'].includes(field) && typeof col === 'string' && !table.columns.includes(col)))
              return res.status(400).json({ error: 'Mapped tables and columns must exist in the source.' });
      }
      const data = await adapter.loadAll!();
      // Mapping save is exactly one config write; last-good backups follow explicit refresh.
      await save(c);
      connections.set(id, c);
      cache.reset(id);
      cache.publish(id, data);
      schedule(id);
      res.json(safe(id));
  }
  app.get('/api/sources/providers', handler((_req: any, res: any) => res.json({ airtable: { setUp: true }, google_sheets: { setUp: oauth.setUp('google_sheets') }, excel: { setUp: oauth.setUp('excel') }, supabase: { setUp: true }, upload: { setUp: true, maxRows: 5000, maxBytes: 5242880 } })));
  app.post('/api/sources/oauth/:provider/start', mutation((req: any, res: any, { id, user }: any) => {
      const p = req.params.provider;
      if (!isOAuthProvider(p))
          return res.status(400).json({ error: 'Invalid provider' });
      oauth.requireSetUp(p);
      if (blocked(res))
          return;
      if (!accessValue(req.body?.access))
          return res.status(400).json({ error: 'Invalid access' });
      res.json({ url: oauth.start(id, user.id, p, req.body.access) });
  }));
  app.get('/api/sources/oauth/:provider/callback', async (req: any, res: any) => {
      const p = req.params.provider;
      const done = (ok: boolean) => res.redirect(302, `/?sources=${isOAuthProvider(p) ? p : 'unknown'}&signin=${ok ? 'ok' : 'failed'}`);
      try {
          if (!isOAuthProvider(p) || deps.staged())
              return done(false);
          const result = await oauth.callback(p, typeof req.query.state === 'string' ? req.query.state : '', typeof req.query.code === 'string' ? req.query.code : '');
          if (deps.staged())
              return done(false);
          await serialize(result.agencyId, async () => {
              if (!oauth.valid(result.agencyId, result.generation))
                  throw Error('Sign-in cancelled');
              const old = connections.get(result.agencyId) || blank(result.agencyId, result.userId, p);
              const c = { ...old, oauth: { ...old.oauth, [p]: result.record }, updatedBy: result.userId, updatedAt: new Date().toISOString() };
              await save(c);
              connections.set(result.agencyId, c);
              oauth.accept(result);
          });
          done(true);
      }
      catch {
          done(false);
      }
  });
  app.get('/api/sources/oauth/:provider/account', handler((req: any, res: any, { id }: any) => {
      const p = req.params.provider;
      if (!isOAuthProvider(p))
          return res.status(400).json({ error: 'Invalid provider' });
      oauth.requireSetUp(p);
      const record = oauthRecord(id, p);
      res.json({ signedIn: !!record, ...(record ? { accountEmail: oauth.email(id, record) } : {}) });
  }));
  app.post('/api/sources/oauth/google_sheets/picker-token', handler(async (_req: any, res: any, { id }: any) => {
      oauth.requireSetUp('google_sheets');
      if (blocked(res))
          return;
      const t = await oauth.token(id, 'google_sheets', oauthRecord(id, 'google_sheets'));
      res.json({ ...t, ...(process.env.GOOGLE_PICKER_API_KEY ? { apiKey: process.env.GOOGLE_PICKER_API_KEY } : {}), ...(process.env.GOOGLE_PICKER_APP_ID ? { appId: process.env.GOOGLE_PICKER_APP_ID } : {}) });
  }));
  app.get('/api/sources/files', handler(async (req: any, res: any, { id }: any) => { const p = req.query.provider; if (!isOAuthProvider(p))
      return res.status(400).json({ error: 'Invalid provider' }); oauth.requireSetUp(p); res.json({ files: await providerApi(id, p).files() }); }));
  app.get('/api/sources/tabs', handler(async (req: any, res: any, { id }: any) => {
      const p = req.query.provider;
      if (!['google_sheets', 'excel', 'supabase', 'upload'].includes(p))
          return res.status(400).json({ error: 'Invalid provider' });
      let adapter;
      if (isOAuthProvider(p)) {
          oauth.requireSetUp(p);
          if (typeof req.query.fileId !== 'string' || !req.query.fileId)
              return res.status(400).json({ error: 'File required' });
          adapter = connector({ ...blank(id, '', p), baseId: req.query.fileId });
      }
      else {
          const c = connections.get(id);
          if (!c || c.sourceType !== p)
              return res.status(409).json({ error: 'No source connected' });
          adapter = connector(c);
      }
      const tables = await adapter.listTables!(), samples = await adapter.samples!(tables);
      res.json({ tables, samples });
  }));
  app.post('/api/sources/supabase/test', handler(async (req: any, res: any, { id }: any) => {
      if (!validSupabaseUrl(req.body?.url) || typeof req.body?.apiKey !== 'string' || !req.body.apiKey.trim() || req.body.apiKey.length > 4096)
          return res.status(400).json({ error: 'Invalid Supabase connection' });
      const result = await connector({ ...blank(id, '', 'supabase'), baseId: req.body.url }, req.body.apiKey).testConnection();
      res.json(result);
  }));
  app.post('/api/sources/upload', mutation(async (req: any, res: any, { id, user }: any) => {
      if (blocked(res))
          return;
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      if (!Buffer.isBuffer(req.body) || !['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes((req.headers['content-type'] || '').split(';')[0]) || !name || name.length > 200)
          return res.status(400).json({ error: uploadTypeError });
      let file: UploadedFile;
      try {
          file = parseUpload(req.body, name);
      }
      catch (e: any) {
          return res.status(400).json({ error: e.message });
      }
      const previous = uploads.get(id) || [];
      if (previous.length >= 3)
          return res.status(400).json({ error: 'A copy can contain up to three files.' });
      file.id = `file${previous.length + 1}`;
      const next = [...previous, file];
      if (next.reduce((n, f) => n + f.tabs.reduce((n, t) => n + t.rows.length, 0), 0) > 5000)
          return res.status(400).json({ error: uploadRowsError });
      // Disambiguate tabs across files for upload's single-copy picker.
      const used = new Set(previous.flatMap(f => f.tabs.map(t => t.name)));
      for (const t of file.tabs) {
          const base = t.name;
          let n = 2;
          while (used.has(t.name))
              t.name = `${base} (${n++})`;
          used.add(t.name);
      }
      const old = connections.get(id), c = { ...(old || blank(id, user.id, 'upload')), sourceType: 'upload' as const, baseId: 'upload', access: 'read' as const, encryptedKey: '', keyHint: '' };
      await store.saveUpload(c, next);
      uploads.set(id, next);
      connections.set(id, c);
      res.json({ fileName: file.name, rows: file.tabs.reduce((n, t) => n + t.rows.length, 0), tables: file.tabs.map(t => ({ name: t.name, columns: t.columns })), samples: Object.fromEntries(file.tabs.map(t => [t.name, t.rows.slice(0, 3)])) });
  }));
  app.post('/api/sources/upload/reset', mutation(async (_req: any, res: any, { id }: any) => { if (blocked(res))
      return; const c = connections.get(id); if (c?.sourceType === 'upload') {
      await store.remove(c);
      connections.delete(id);
      cache.reset(id);
  } uploads.delete(id); res.json({ ok: true }); }));
  app.post('/api/sources/create-file', mutation(async (req: any, res: any, { id }: any) => {
      const p = req.body?.provider;
      if (!isOAuthProvider(p))
          return res.status(400).json({ error: 'Invalid provider' });
      oauth.requireSetUp(p);
      if (blocked(res))
          return;
      if (oauthRecord(id, p)?.access !== 'readwrite')
          return res.status(403).json({ error: 'This source is read only.' });
      res.json({ file: await providerApi(id, p).createFile(`Shutfey – ${deps.agencyName?.(id) || 'Agency'}`) });
  }));
  app.put('/api/sources/access', mutation(async (req: any, res: any, { id, user }: any) => {
      if (blocked(res))
          return;
      if (!accessValue(req.body?.access))
          return res.status(400).json({ error: 'Invalid access' });
      const c = connections.get(id);
      if (!c)
          return res.status(409).json({ error: 'No source connected' });
      if (c.sourceType === 'upload')
          return res.status(400).json({ error: 'Uploaded copies are read only.' });
      if (isOAuthProvider(c.sourceType))
          oauth.requireSetUp(c.sourceType);
      const needsSignIn = c.sourceType === 'excel' && req.body.access === 'readwrite' && c.oauth?.excel?.access !== 'readwrite';
      const next = { ...c, access: needsSignIn ? 'read' as const : req.body.access, updatedAt: new Date().toISOString(), updatedBy: user.id };
      await save(next);
      connections.set(id, next);
      res.json({ access: next.access, ...(needsSignIn ? { needsSignIn: true } : {}) });
  }));
  app.delete?.('/api/sources/connection', mutation(async (_req: any, res: any, { id }: any) => {
      if (blocked(res))
          return;
      if (flights.has(id))
          await flights.get(id);
      await saves.get(id)?.catch(() => { });
      const c = connections.get(id);
      if (c)
          await store.remove(c);
      clearTimeout(timers.get(id));
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      connections.delete(id);
      uploads.delete(id);
      cache.reset(id);
      oauth.clear(id);
      tested.delete(id);
      keyErrors.delete(id);
      backupErrors.delete(id);
      unconfirmed.delete(id);
      res.json({ ok: true });
  }));
  const writeTimes = new Map<string, number[]>();
  const write = mutation(async (req: any, res: any, { id }: any) => {
      if (blocked(res))
          return;
      if (flights.has(id))
          await flights.get(id);
      const c = connections.get(id), list = req.params.list, fields = guardSourceWrite(c, list, req.body?.fields);
      if (isOAuthProvider(c!.sourceType))
          oauth.requireSetUp(c!.sourceType);
      const recent = (writeTimes.get(id) || []).filter(t => Date.now() - t < 60000);
      if (recent.length >= 30)
          return res.status(429).json({ error: 'Too many writes. Try again in a minute.' });
      recent.push(Date.now());
      writeTimes.set(id, recent);
      const config = c!.mapping[list as 'companies' | 'ingredients' | 'products'];
      const row = await connector(c!).writeRow!(config.table, { ...(req.params.rowId ? { id: req.params.rowId } : {}), fields }, config.file);
      // Apply only this returned row to the mapped memory model; no Firestore reads/writes.
      const mapped = applyMapping({ [config.table]: [row] }, c!.mapping), data = cache.data(id);
      if (data) {
          const replacement = (mapped as any)[list]?.[0];
          if (replacement) {
              if (list !== 'companies') {
                  const col = (config as any).companyLink, v = col ? row.fields[col] : '';
                  const links = Array.isArray(v) ? v : String(v || '').split(',');
                  replacement.companyIds = data.companies.filter(co => links.some(x => String(x).trim() === co.id || String(x).trim().toLowerCase() === co.name.toLowerCase())).map(co => co.id);
              }
              const rows = (data as any)[list], at = rows.findIndex((r: any) => r.id === row.id);
              if (at < 0)
                  rows.push(replacement);
              else
                  rows[at] = replacement;
              cache.publish(id, data);
          }
      }
      res.json({ row });
  });
  app.post('/api/sources/rows/:list', write);
  app.patch?.('/api/sources/rows/:list/:rowId', write);
  if (deps.testMode)
      app.post('/api/__test__/sources-oauth-config', handler((req: any, res: any) => { for (const p of ['GOOGLE', 'MICROSOFT']) {
          process.env[`${p}_OAUTH_CLIENT_ID`] = req.body.enabled ? 'fake-client-id' : '';
          process.env[`${p}_OAUTH_CLIENT_SECRET`] = req.body.enabled ? 'fake-client-secret' : '';
      } res.json({ ok: true }); }));
  app.get('/api/sources/connection', handler((_req: any, res: any, { id }: any) => res.json(safe(id))));
  app.put('/api/sources/connection', mutation(async (req: any, res: any, { id, user }: any) => {
    if(req.body?.sourceType !== 'airtable') return saveOther(req,res,id,user);
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
    const uses: Parameters<typeof summarizeValues>[0] = [];
    if (mapping && data) for (const kind of ['ingredients', 'products'] as const) {
      const config = mapping[kind];
      for (const column of new Set([config.certification, config.status, config.agency].filter(Boolean))) {
        const field = config.certification === column ? 'certificationRaw' : config.status === column ? 'statusRaw' : 'agencyRaw';
        for (const item of data[kind]) {
          const value = item[field]; if (!value) continue;
          uses.push({ kind: kind === 'ingredients' ? 'ingredient' : 'product', column: column!, value, id: item.id, name: item.name, brand: item.brand });
        }
      }
    }
    const all = summarizeValues(uses).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
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
  app.get('/api/factories', handler(async (_req: any, res: any, { id }: any) => {
    const s = cache.state(id), c = connections.get(id);
    const foodServiceIds = new Set(await deps.foodServiceCompanyIds?.(id) ?? []);
    res.json({ status: { group1Label: c?.group1Label || 'Group 1', connected: !!c, sourceType: c?.sourceType || null, status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: s.error || null }, companies: s.companies.filter(c => !foodServiceIds.has(c.id)).map(c => ({ id: c.id, name: c.name, address: c.address || '', companyFee:c.companyFee, mashgiachFee:c.mashgiachFee, brand: c.brand || '', plant: c.plant || '', ingredientCount: s.itemsFor(c.id, 'ingredient').length, productCount: s.itemsFor(c.id, 'product').length, lastVisitAt: null, nextDueAt: null, overdue: null })).sort((a, b) => a.name.localeCompare(b.name)) });
  }));
  if (deps.testMode) {
    app.post('/api/__test__/source-fees', mutation(async (req: any, res: any, { id }: any) => {
      if (req.body.agencyId !== id) return res.status(403).json({ error: 'Forbidden' });
      if (deps.staged()) return res.status(503).json({ error: 'Writes blocked' });
      const fees = req.body.fees;
      if (!fees || typeof fees !== 'object' || !fees.mashgiach || typeof fees.mashgiach !== 'object' || Array.isArray(fees.mashgiach) || Object.values(fees.mashgiach).some((fee: any) => !fee || !Number.isFinite(fee.amount) || typeof fee.currency !== 'string')) return res.status(400).json({ error: 'Invalid fees' });
      if (flights.has(id)) await flights.get(id);
      await saves.get(id)?.catch(() => {});
      const connection = connections.get(id);
      if (!connection) return res.status(404).json({ error: 'Connection not found' });
      const updated = { ...connection, fees };
      await save(updated);
      connections.set(id, updated);
      const job = pending.get(id); if (job) job.connection = updated;
      res.json({ ok: true });
    }));
    app.post('/api/__test__/sources-api-base', handler((req: any, res: any) => { const url = new URL(req.body.apiBase||req.body.url); if (!['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ error: 'Invalid URL' }); if(req.body.provider && req.body.provider!=='airtable') apiBases.set(req.body.provider,url.origin); else apiBase = url.origin; res.json({ ok: true }); }));
    app.post('/api/__test__/source-raw', handler(async (req: any, res: any, { id }: any) => { if (req.body.agencyId && req.body.agencyId !== id) return res.status(403).json({ error: 'Forbidden' }); res.json({ connection: await store.raw(id), backupIds: (await loadBackups(id)).map(b => `${id}__${b.companyId}`) }); }));
  }
  let bootAttempt = 0;
  async function boot() {
    try {
      for (const c of await store.connections()) {
        if (connections.has(c.agencyId)) continue;
        connections.set(c.agencyId, c);
        cache.setKnownHashes(c.agencyId, c.backupHashes || {});
        if(c.sourceType==='upload') uploads.set(c.agencyId,await store.loadUpload(c));
        schedule(c.agencyId);
        if(c.sourceType!=='airtable'&&!c.mapping.companies?.table) continue;
        void refresh(c.agencyId).catch(() => console.warn('[sources] startup refresh failed'));
      }
    } catch {
      console.warn('[sources] startup failed');
      const delay = [5000, 15000, 45000, 120000, 300000][Math.min(bootAttempt++, 4)];
      const timer = setTimeout(() => { void boot(); }, delay); timer.unref();
    }
  }
  return { boot, inspectionAgencyIds: () => [...connections.keys()], inspectionSource: inspectionSourceAccessor(cache, connections) };
}

// Read-only bridge for factory visits; no source calls or persistence.
export function inspectionSourceAccessor(cache: ReturnType<typeof createSourceCache>, connections: Map<string, Connection>) {
  return (agencyId: string) => {
    const connection = connections.get(agencyId), state = cache.state(agencyId);
    return {
      state, connection: connection ? {...connection, fees:{...connection.fees,mashgiach:{...connection.fees?.mashgiach,...Object.fromEntries(state.companies.filter(c=>c.mashgiachFee!==undefined).map(c=>[c.id,{amount:c.mashgiachFee!,currency:'USD'}]))}}} : undefined,
      listVersion: (companyId: string) => connection?.backupHashes?.[companyId] || '',
      items: (companyId: string, kind: 'ingredient' | 'product') => state.itemsFor(companyId, kind).map(item => ({
        id: item.id, name: item.name, brand: item.brand ?? '', code: 'code' in item ? item.code ?? '' : '',
        certificationRaw: item.certificationRaw ?? '', statusRaw: item.statusRaw ?? '', agency: item.certifyingAgency ?? '',
        dpm: item.dpm ?? '', group1: connection?.group1Overrides?.[kind]?.[item.id] ?? item.group1 === true,
      })),
    };
  };
}
