import { createOAuth, isOAuthProvider, type OAuthProvider } from './oauth.ts';
import { createGoogleSheetsApi } from './google-sheets.ts';
import { createExcelApi } from './excel.ts';
import { validSupabaseUrl } from './supabase.ts';
import type { CompanyRemoval, SheetRemovalEvidence } from '../inspections/company-removal.ts';
import { createHash, randomUUID } from 'node:crypto';
import { parseUpload, uploadRowsError, uploadTypeError, type UploadedFile } from './upload.ts';
import { createAirtableConnector, type AirtableCompanyField } from './airtable.ts';
import { registerCompanyItems } from './company-items.ts';
import { guardSourceWrite } from './write.ts';
import { CompanyLinkError, mapSourceLists, companyLinkResolver } from './mapping.ts';
import { summarizeValues, customFieldTypes, isMappedCustomField, type SourceSection } from '../../lib/sourcePreview.ts';
import { createConnector, type SourceSettings } from './stubs.ts';
import { createSourceCache, nextNightlyRun } from './cache.ts';
import { encryptKey, decryptKey, keyHint } from './crypto.ts';
import { guessMapping } from './mapping.ts';
import { normalizeConnection, createSourceStore, type Connection } from './store.ts';
import type { AddTarget, AirtableEditAudit, Change, Edit } from './tagged-row.ts';
import { cellText } from './tabular.ts';
import type { Company, SourceMapping } from './types.ts';

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
  if (m.certificationOrganizations !== undefined && (!m.certificationOrganizations || typeof m.certificationOrganizations !== 'object'
    || Array.isArray(m.certificationOrganizations) || Object.entries(m.certificationOrganizations).some(([k,v]) => !['ingredients','products'].includes(k) || typeof v !== 'boolean')))
    throw Error('Invalid certification mapping.');
  if (m.editableCustomFields !== undefined) {
    if (!m.editableCustomFields || typeof m.editableCustomFields !== 'object' || Array.isArray(m.editableCustomFields)) throw Error('Invalid editable custom fields');
    for (const [section, declarations] of Object.entries(m.editableCustomFields)) {
      if (!['companies', 'ingredients', 'products'].includes(section) || !declarations || typeof declarations !== 'object' || Array.isArray(declarations)) throw Error('Invalid editable custom fields');
      for (const [field, rule] of Object.entries(declarations)) {
        if (!Object.hasOwn(m[section], field) || typeof m[section][field] !== 'string' ||
            (!isMappedCustomField(section as SourceSection, field) || typeof rule !== 'string' || !Object.hasOwn(customFieldTypes, rule))) throw Error('Declare a type for each mapped editable custom field.');
      }
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
  if (m.hidden !== undefined) {
    if (!m.hidden || typeof m.hidden !== 'object' || Array.isArray(m.hidden)) throw Error('Invalid mapping');
    const hiddenFields: Record<string, string[]> = {
      companies: ['type', 'brand', 'plant'],
      ingredients: ['brand', 'certification', 'agency', 'status', 'plant', 'expiresOn'],
      products: ['brand', 'code', 'certification', 'agency', 'status', 'symbolRequired', 'plant'],
    };
    for (const [kind, fields] of Object.entries(m.hidden)) {
      if (!hiddenFields[kind] || !Array.isArray(fields) || fields.length > 50 || fields.some(f => typeof f !== 'string' || f.length > 200 || !hiddenFields[kind].includes(f))) throw Error('Invalid mapping');
      // A hidden field must not keep a column mapping: the pair is stale
      // (the row was removed and the mapping was never cleared).
      const config = m[kind];
      if (fields.some(f => typeof config[f] === 'string' && config[f].trim())) throw Error('Invalid mapping');
    }
  }
}
function companySourceIdentity(c: Connection | undefined) {
  if (!c?.mapping.companies?.table) return undefined;
  const { file, table } = c.mapping.companies;
  return createHash('sha256').update(JSON.stringify([c.sourceType, file?.id || c.baseId, table])).digest('base64url');
}

type LinkCompany = Pick<Company, 'id' | 'sourceKey' | 'name'>;
function associationChanges(values: unknown[], eligible: LinkCompany[], others: LinkCompany[],
  recordId: string | undefined, name: string, unmatched: 'ignore' | 'reject') {
  const before = companyLinkResolver(eligible, others, unmatched);
  const renamed = recordId ? eligible.map(row => (row.sourceKey || row.id) === recordId ? { ...row, name } : row)
    : [...eligible, { id: randomUUID(), name }];
  const after = companyLinkResolver(renamed, others, unmatched);
  function resolve(resolver: typeof before, value: unknown) {
    try { return JSON.stringify(resolver(value).sort()); }
    catch (cause) { if (!(cause instanceof CompanyLinkError)) throw cause; return null; }
  }
  return values.some(value => {
    const original = resolve(before, value);
    if (original === null) return unmatched === 'reject';
    return original !== resolve(after, value);
  });
}

export function registerSourceRoutes(app: any, deps: {
  db(): any; dataDir: string; staged(): boolean; secret(): string; testMode: boolean;
  agencyName?(agencyId: string): string;
  foodServiceCompanyIds?(agencyId: string): Promise<string[]>;
  companyRemoval?: {
    withRemoval<T>(agencyId: string, action: () => Promise<T>): Promise<T>;
    removal(agencyId: string, id: string, source: string, archiveKey?: string): CompanyRemoval | undefined;
    setRemoval(agencyId: string, id: string, status: CompanyRemoval): Promise<unknown>;
    bindSheetArchives(agencyId: string, source: string, rows: readonly { id: string; archiveKey?: string }[]): Promise<void>;
    pendingRemovals(agencyId: string, source: string): Promise<[string, CompanyRemoval][]>;
  };
  now?(): Date;
  itemUser?(req: any): any;
  itemVisible?(user: any, companyId: string): Promise<boolean>;
  requireAdmin(req: any, res: any): any; timeZone(id: string): string | undefined;
}) {
  const store = createSourceStore(deps), connections = new Map<string, Connection>();
  let apiBase: string | undefined = deps.testMode ? 'http://127.0.0.1:1' : undefined;
  const apiBases = new Map<string,string>(), uploads = new Map<string,UploadedFile[]>();
  const drafts = new Map<string,{token:string;files:UploadedFile[]}>();
  const oauth = createOAuth({secret:deps.secret,apiBase:p=>deps.testMode?apiBases.get(p):undefined});
  const oauthRecord=(id:string,p:OAuthProvider)=>connections.get(id)?.oauth?.[p];
  const token=(id:string,p:OAuthProvider)=>(force=false)=>oauth.token(id,p,oauthRecord(id,p),force).then(t=>t.accessToken);
  const providerApi=(id:string,p:OAuthProvider,fileId='')=>p==='google_sheets'?createGoogleSheetsApi({spreadsheetId:fileId,mapping:emptyMapping,apiBase:apiBases.get(p),token:token(id,p)}):createExcelApi({workbookId:fileId,mapping:emptyMapping,apiBase:apiBases.get(p),token:token(id,p)});
  const unconfirmedAdds = async (spreadsheetId: string) => new Set(
    (await store.sheetAdds(spreadsheetId, true)).map(add => add.recordId));
  const sheetsApi = (c: Connection, section: SourceSection) => createGoogleSheetsApi({
    spreadsheetId: c.mapping[section].file?.id || c.baseId, mapping: c.mapping,
    apiBase: apiBases.get('google_sheets'), token: token(c.agencyId, 'google_sheets'), unconfirmedAdds,
  });
  function blank(id:string,userId:string,sourceType:Connection['sourceType']):Connection {return {agencyId:id,sourceType,baseId:sourceType==='upload'?'upload':'',access:'read',mapping:structuredClone(emptyMapping),encryptedKey:'',keyHint:'',updatedAt:new Date().toISOString(),updatedBy:userId,backupHashes:{}};}

  const baseWriteEligibility = new Map<string, {
    baseId: string; tokenKey: string; access: 'read' | 'readwrite'; at: number; typeOptions?: string[];
  }>();
  function airtable(c: Connection) {
    return createAirtableConnector({ baseId: c.baseId, apiKey: storedKey(c), mapping: c.mapping,
      apiBase: deps.testMode ? apiBase : undefined, contentBase: deps.testMode ? apiBases.get('airtableContent') ?? 'http://127.0.0.1:1' : undefined });
  }
  const eligibilityTime = () => deps.now?.().getTime() ?? Date.now();
  async function verifyBaseAccess(c: Connection, adapter: ReturnType<typeof airtable>, editing = false) {
    baseWriteEligibility.delete(c.agencyId);
    const result = await adapter.testConnection();
    if (!result.ok || !result.access) throw Object.assign(Error(result.error || 'Connection test failed'), { status: editing ? result.status || 503 : 400 });
    const eligibility = { baseId: c.baseId, tokenKey: c.encryptedKey, access: result.access, at: eligibilityTime(), typeOptions: adapter.typeOptions() };
    return { eligibility, tables: result.tables };
  }
  async function editorEligibility(c: Connection, adapter: ReturnType<typeof airtable>) {
    const cached = baseWriteEligibility.get(c.agencyId);
    if (cached && cached.baseId === c.baseId && cached.tokenKey === c.encryptedKey && eligibilityTime() < cached.at + 5 * 60_000)
      return cached;
    const { eligibility } = await verifyBaseAccess(c, adapter, true);
    if (eligibility.access !== 'readwrite') {
      const next = { ...c, access: 'read' as const, updatedAt: new Date().toISOString() };
      await save(next);
      connections.set(c.agencyId, next);
      throw Object.assign(Error('Airtable write access was lost. This source is read only.'), { status: 403, readOnly: true });
    }
    baseWriteEligibility.set(c.agencyId, eligibility);
    return eligibility;
  }
  async function permissionError(c: Connection, adapter: ReturnType<typeof airtable>, cause: any) {
    if (cause.status === 403 && cause.airtable) {
      baseWriteEligibility.delete(c.agencyId);
      try { await editorEligibility(c, adapter); }
      catch (check: any) { if (check.readOnly) return check; baseWriteEligibility.delete(c.agencyId); }
    }
    return cause;
  }
  const backupErrors = new Set<string>();
  const pending = new Map<string, { connection: Connection; expected:Connection; backups: import('./cache.ts').Backup[]; attempt: number; timer?: ReturnType<typeof setTimeout> }>();
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
  const connector = (c: Connection, plain?: string, files = uploads.get(c.agencyId) || []) => createConnector({ kind: c.sourceType, baseId: c.baseId, spreadsheetId: c.baseId, workbookId: c.baseId, url: c.baseId, mapping: c.mapping, files, ...(c.sourceType === 'google_sheets' ? { unconfirmedAdds } : {}), ...(isOAuthProvider(c.sourceType)?{token:token(c.agencyId,c.sourceType)}:{}), ...(deps.testMode ? { apiBase: c.sourceType==='airtable'?apiBase:apiBases.get(c.sourceType) } : {}) } as SourceSettings, plain || (['airtable','supabase'].includes(c.sourceType)?storedKey(c):''));
  async function bindSheetArchives(c: Connection) {
    const source = companySourceIdentity(c), data = cache.data(c.agencyId);
    if (c.sourceType === 'google_sheets' && source && data && !deps.staged())
      await deps.companyRemoval?.bindSheetArchives(c.agencyId, source, [...data.companies, ...(data.otherCompanies ?? [])]);
  }
  const loadBackups = (id: string) => store.load(id, Object.keys(connections.get(id)?.backupHashes || {}));
  const cache = createSourceCache({ mappingFor: id => connections.get(id)?.mapping, connectorFor: id => connector(connections.get(id)!), backups: { load: loadBackups }, group1SettingsFor: id => ({ group1Label: connections.get(id)?.group1Label || 'Group 1', group1Overrides: connections.get(id)?.group1Overrides, valueAssignments: connections.get(id)?.mapping.valueAssignments }) });
  const flights = new Map<string, Promise<any>>(), last = new Map<string, number>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(id: string) {
    clearTimeout(timers.get(id));
    let next: number;
    try { next = nextNightlyRun(Date.now(), deps.timeZone(id) || 'America/New_York', 3); }
    catch { next = nextNightlyRun(Date.now(), 'America/New_York', 3); }
    const timer = setTimeout(() => { void serialize(id, () => connections.has(id) ? refresh(id) : Promise.resolve()); schedule(id); }, next - Date.now());
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
  function save(c: Connection, backups: import('./cache.ts').Backup[] = [], expected?: Connection, includeDirty = true) {
    const previous = saves.get(c.agencyId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (expected && connections.get(c.agencyId) !== expected) return;
      const dirty = includeDirty ? unconfirmed.get(c.agencyId) : undefined;
      const newest = new Map(backups.map(b => [b.companyId, b]));
      for (const b of dirty?.values() || []) newest.set(b.companyId, b);
      const snapshot = [...newest.values()];
      const hashes = { ...c.backupHashes };
      for (const b of snapshot) hashes[b.companyId] = b.hash;
      const persisted = { ...c, backupHashes: hashes };
      await store.save(persisted, snapshot, connections.get(c.agencyId)?.upload);
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
  function retrySave(id: string, expected:Connection, connection: Connection, backups: import('./cache.ts').Backup[], attempt = 0) {
    clearTimeout(pending.get(id)?.timer);
    const job = { expected, connection, backups, attempt, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    pending.set(id, job);
    job.timer = setTimeout(() => { void serialize(id, async () => {
      if (pending.get(id) !== job || connections.get(id) !== expected) { if (pending.get(id) === job) pending.delete(id); return; }
      try {
        if (deps.staged()) { retrySave(id, job.expected, job.connection, backups, attempt + 1); return; }
        await save(job.connection, backups, expected);
        if (pending.get(id) !== job || connections.get(id) !== expected) { if (pending.get(id) === job) pending.delete(id); return; }
        connections.set(id, job.connection); cache.setKnownHashes(id, job.connection.backupHashes);
        backupErrors.delete(id); pending.delete(id);
      } catch { if (pending.get(id) === job) retrySave(id, job.expected, job.connection, backups, attempt + 1); }
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
      if (cached.ok) await bindSheetArchives(c).catch(() => console.warn('[sources] company archive binding will retry'));
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
          await save(updated, toSave, c);
          if (connections.get(id) !== c) return {ok:false,status:status(id)};
          connections.set(id, updated); backupErrors.delete(id); cache.setKnownHashes(id, updated.backupHashes);
        }
        else if (toSave.length) retrySave(id, c, updated, toSave);
      } catch { console.warn(`[sources] persistence failed agency=${id}`); backupErrors.add(id); cache.setKnownHashes(id, c.backupHashes); retrySave(id, c, updated, toSave); }
      console.info(`[sources] agency=${id} ok=${result.ok} calls=${result.calls} ms=${Date.now() - start}`);
      return { ok: result.ok, status: status(id), calls: result.calls, refreshedAt: cache.state(id).refreshedAt || null };
    })().finally(() => flights.delete(id));
    flights.set(id, p); return p;
  }
  const sections = ['companies', 'ingredients', 'products'] as const;
  const sheetAccess = (c?: Connection): c is Connection => c?.sourceType === 'google_sheets' &&
    c.access === 'readwrite' && c.oauth?.google_sheets?.access === 'readwrite';
  const sheetTags = (c: Connection, list: SourceSection) => c.sheetsTables?.[list] ||
    (list === 'companies' ? c.sheetsPilot : undefined);
  const sheetConflict = (message: string): never => { throw Object.assign(Error(message), { status: 409 }); };
  function assertSeparateSheetTabs(c: Connection) {
    const tabs = new Set<string>();
    for (const section of sections) {
      const { table, file } = c.mapping[section];
      if (!table) continue;
      const key = JSON.stringify([file?.id || c.baseId, table]);
      if (tabs.has(key)) return sheetConflict('Choose a separate Google Sheets tab for each mapped section before editing.');
      tabs.add(key);
    }
  }
  const sheetRows = (c: Connection, list: SourceSection) => sheetsApi(c, list).readRows(c.mapping[list].table);
  async function sheetCompanies(c: Connection) {
    return (await sheetRows(c, 'companies')).map(row => ({
      id: row.id, sourceKey: row.sourceKey, name: String(row.fields[c.mapping.companies.name] ?? ''),
    }));
  }
  const companyLinks = (companies: Awaited<ReturnType<typeof sheetCompanies>>) => {
    const keys = new Map(companies.map(row => [row.id, row.sourceKey]));
    return { resolve: companyLinkResolver(companies), sourceKey: (id: string) => keys.get(id) };
  };
  const noLinks = companyLinks([]);
  function cachedSheetRows(id: string, list: SourceSection) {
    const data = cache.data(id);
    return list === 'companies' ? [...(data?.companies ?? []), ...(data?.otherCompanies ?? [])] : data?.[list] ?? [];
  }
  function sheetAddTarget(c: Connection, list: SourceSection, actorId: string) {
    assertSeparateSheetTabs(c);
    const tags = sheetTags(c, list);
    if (!tags) return sheetConflict('Enable editing on the mapped tab.');
    const config = c.mapping[list];
    const target: AddTarget = { actorId, agencyId: c.agencyId, section: list,
      spreadsheetId: config.file?.id || c.baseId, table: config.table };
    const edit: Edit = { mapping: c.mapping, section: list, idHeader: tags.idHeader, fields: {}, links: noLinks,
      customTypes: new Map(Object.entries(c.mapping.editableCustomFields?.[list] ?? {})) };
    return { target, edit };
  }
  async function confirmedAdds(target: AddTarget) {
    return (await store.sheetAdds(target.spreadsheetId)).filter(add =>
      add.table === target.table && add.outcome === 'confirmed');
  }
  async function sheetTarget(c: Connection, list: SourceSection, rowId: string, actorId: string) {
    const { target, edit } = sheetAddTarget(c, list, actorId);
    const tags = sheetTags(c, list)!;
    const row = cachedSheetRows(c.agencyId, list).find(r => r.id === rowId);
    if (!row?.sourceKey) return sheetConflict('Record tag missing. Refresh and review the source.');
    const record = tags.records.find(r => r.key === row.sourceKey);
    const metadataId = record?.metadataId ?? (await confirmedAdds(target)).find(add => add.recordId === row.sourceKey)?.metadataId;
    if (!metadataId) return sheetConflict('Record tag missing. Refresh and review the source.');
    return { target: { ...target, metadataId, recordId: row.sourceKey }, edit };
  }
  async function checkCompanyName(c: Connection, changes: readonly Change[], recordId?: string) {
    const rename = changes.find(change => change.field === 'name');
    if (!rename) return;
    const dependentFields = sections.flatMap(section => {
      if (!c.mapping[section].table) return [];
      const config = c.mapping[section] as Record<string, unknown>;
      const columns = new Set(Object.entries(c.mapping.editableCustomFields?.[section] ?? {})
        .filter(([, rule]) => rule === 'companyLink').map(([field]) => config[field]));
      if (section !== 'companies') columns.add(config.companyLink);
      return columns.size ? [{ section, columns }] : [];
    });
    if (!dependentFields.length) return;
    const companies = await sheetCompanies(c);
    const links: unknown[] = [];
    for (const { section, columns } of dependentFields)
      for (const row of await sheetRows(c, section))
        for (const column of columns) if (typeof column === 'string') links.push(row.fields[column]);
    if (associationChanges(links, companies, [], recordId, cellText(rename.requested), 'reject'))
      return sheetConflict(recordId
        ? 'This name change would leave company links unresolved or change which company they match. Review the linked records in Google Sheets and use permanent company IDs before renaming.'
        : 'This name would change existing company links. Use permanent company IDs in the linked sheet rows before adding the company.');
  }

  const own = (req: any, res: any) => { const u = deps.requireAdmin(req, res); return u ? { user: u, id: u.agencyId || 'agency-hkc' } : null; };
  const safe = (id: string) => {
    const c = connections.get(id), s = cache.state(id);
    if (!c && startupRetries.get(id)?.sourceType === 'upload') {
      return {sourceType:'upload',status:'recovering',access:'read',canWrite:false};
    }
    const sheetsEditSections = sheetAccess(c) ? sections.filter(section => sheetTags(c, section)) : [];
    return { sheetsEditSections, sheetsFeeEditing: sheetsEditSections.includes('companies'), canWrite:!!c && c.access==='readwrite' && c.sourceType==='supabase', counts:{companies:s.companies.length,ingredients:cache.data(id)?.ingredients.length||0,products:cache.data(id)?.products.length||0}, ...(c?.upload?{fileName:c.upload.fileNames[0],upload:{fileNames:c.upload.fileNames,copiedAt:c.upload.copiedAt,rows:c.upload.rows}}:{}), ...(c && isOAuthProvider(c.sourceType) && c.oauth?.[c.sourceType]?{accountEmail:oauth.email(id,c.oauth[c.sourceType])}:{}), group1Label: c?.group1Label || 'Group 1', sourceType: c?.sourceType || null, baseId: c?.baseId || '', access: c?.access || 'read', mapping: c?.mapping || null, hasKey: !!c?.encryptedKey, keyHint: c?.keyHint || '', status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: keyErrors.has(id) ? unreadableKey : s.error || null };
  };
  const handler = (fn: any) => async (req: any, res: any) => { const caller = own(req, res); if (!caller) return; try { await fn(req, res, caller); } catch (cause:any) { const code=cause instanceof SavedKeyError?400:[400,403,409,429].includes(cause.status)?cause.status:503; res.status(code).json({ error: cause instanceof SavedKeyError ? unreadableKey : code===503?'Source operation failed':cause.message,...(cause.notSetUp?{notSetUp:true}:{}),...(cause.addRevisionStale?{addRevisionStale:true}:{}) }); } };
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
      const draft = drafts.get(id);
      if (p === 'upload' && body.draftId && draft?.token !== body.draftId)
          return res.status(409).json({error:'Upload draft expired.'});
      const files = body.draftId ? draft?.files : uploads.get(id);
      if (p === 'upload' && !files?.length)
          return res.status(400).json({ error: 'Upload a file first' });
      const plain = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (p === 'supabase' && !plain && !(old?.sourceType === 'supabase' && old.encryptedKey))
          return res.status(400).json({ error: 'API key required' });
      const c: Connection = { ...(old || blank(id, user.id, p)), sourceType: p, baseId: body.baseId, access: p === 'upload' ? 'read' : body.access, mapping: body.mapping, group1Label: body.group1Label?.trim() || old?.group1Label || 'Group 1', updatedAt: new Date().toISOString(), updatedBy: user.id, encryptedKey: p === 'supabase' ? (plain ? encryptKey(plain, deps.secret(), id) : old!.encryptedKey) : '', keyHint: p === 'supabase' ? (plain ? keyHint(plain) : old!.keyHint) : '', backupHashes: {} };
      delete c.sheetsPilot;
      delete c.sheetsTables;
      const adapter = connector(c, plain || undefined, files);
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
      if (old) await bindSheetArchives(old);
      // Mapping save is exactly one config write; last-good backups follow explicit refresh.
      if (p === 'upload' && body.draftId) {
          await store.saveUpload(c, files!);
          uploads.set(id, files!);
          drafts.delete(id);
      } else {
          if (p !== 'upload') delete c.upload;
          await save(c, [], undefined, false);
      }
      if (p !== 'upload') uploads.delete(id);
      unconfirmed.delete(id);
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
      const draft = drafts.get(id);
      if (!draft || req.query.draftId !== draft.token) return res.status(409).json({error:'Upload draft expired.'});
      const previous = draft.files;
      if (previous.some(f => f.name === file.name)) return res.status(400).json({error:'Choose files with distinct names.'});
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
      draft.files = next;
      res.json({ fileName: file.name, rows: file.tabs.reduce((n, t) => n + t.rows.length, 0), tables: file.tabs.map(t => ({ name: t.name, columns: t.columns })), samples: Object.fromEntries(file.tabs.map(t => [t.name, t.rows.slice(0, 3)])) });
  }));
  app.post('/api/sources/upload/reset', mutation(async (req: any, res: any, { id }: any) => {
      if (blocked(res)) return;
      const draftId = randomUUID();
      drafts.set(id, {token:draftId, files:[]});
      res.json({draftId});
  }));
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
  app.put('/api/sources/sheets-editing', mutation(async (req: any, res: any, { id, user }: any) => {
      if (blocked(res)) return;
      const c = connections.get(id);
      if (c?.sourceType !== 'google_sheets' || typeof req.body?.enabled !== 'boolean')
          return res.status(400).json({ error: 'Choose a connected Google sheet.' });
      const next = { ...c, updatedAt: new Date().toISOString(), updatedBy: user.id };
      if (req.body.enabled) {
          if (!sheetAccess(c))
              return res.status(403).json({ error: 'Change access to enable editing.' });
          assertSeparateSheetTabs(c);
          if (sections.every(section => !c.mapping[section].table || c.sheetsTables?.[section])) return res.json(safe(id));
          next.sheetsTables = { ...c.sheetsTables };
          for (const section of sections) {
              const { table, pk } = c.mapping[section];
              if (table && !next.sheetsTables[section]) next.sheetsTables[section] = await sheetsApi(c, section).tagManagedRows(table, pk);
          }
      } else delete next.sheetsTables;
      delete next.sheetsPilot;
      await save(next);
      connections.set(id, next);
      res.json(safe(id));
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
      if (flights.has(id)) await flights.get(id);
      const needsSignIn = isOAuthProvider(c.sourceType) && req.body.access === 'readwrite' && c.oauth?.[c.sourceType]?.access !== 'readwrite';
      const next = { ...connections.get(id)!, access: needsSignIn ? 'read' as const : req.body.access, updatedAt: new Date().toISOString(), updatedBy: user.id };
      if (c.sourceType === 'airtable' && next.access === 'readwrite') {
        const { eligibility } = await verifyBaseAccess(c, airtable(c), true);
        next.access = eligibility.access;
        if (next.access === 'readwrite') baseWriteEligibility.set(id, eligibility);
      }
      if (next.access === 'read') { baseWriteEligibility.delete(id); delete next.sheetsPilot; delete next.sheetsTables; }
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
      const c = connections.get(id) ?? await store.raw(id);
      if (c)
          await store.remove(c);
      clearTimeout(startupRetries.get(id)?.timer);
      startupRetries.delete(id);
      clearTimeout(timers.get(id));
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      connections.delete(id);
      uploads.delete(id);
      drafts.delete(id);
      cache.reset(id);
      oauth.clear(id);
      baseWriteEligibility.delete(id);
      keyErrors.delete(id);
      backupErrors.delete(id);
      unconfirmed.delete(id);
      res.json({ ok: true });
  }));
  const sectionOf = (value: any): value is SourceSection => sections.includes(value);
  const validAddToken = (value: unknown): value is string => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  app.get('/api/sources/sheet-editor/:list', handler(async (req: any, res: any, { id, user }: any) => {
    const c = connections.get(id), list = req.params.list;
    if (!sheetAccess(c) || !sectionOf(list) || !sheetTags(c, list))
      return res.status(403).json({ error: 'This source is read only.' });
    const { target } = sheetAddTarget(c, list, user.id);
    const tags = new Set([...sheetTags(c, list)!.records.map(record => record.key),
      ...(await confirmedAdds(target)).map(add => add.recordId)]);
    res.json({ rows: cachedSheetRows(id, list).filter(row => row.sourceKey && tags.has(row.sourceKey)).map(({ id, name }) => ({ id, name })) });
  }));
  app.get('/api/sources/sheet-editor/:list/new', handler(async (req: any, res: any, { id, user }: any) => {
    const c = connections.get(id), list = req.params.list;
    if (!sheetAccess(c) || !sectionOf(list) || !sheetTags(c, list))
      return res.status(403).json({ error: 'This source is read only.' });
    const { target, edit } = sheetAddTarget(c, list, user.id);
    const { fields, addRevision } = await sheetsApi(c, list).readAddEditor(edit, target);
    const companies = fields.some(field => field.rule === 'companyLink') ? await sheetCompanies(c) : [];
    res.json({ fields, addRevision, companies: companies.map(row => ({ id: row.id, name: row.name, key: row.sourceKey })),
      addScope: [id, user.id, list, target.spreadsheetId, target.table] });
  }));
  app.post('/api/sources/sheet-editor/:list/abandon', handler(async (req: any, res: any, { id, user }: any) => {
    if (blocked(res)) return;
    const { list } = req.params, token = req.body?.token;
    if (!sectionOf(list) || !validAddToken(token))
      return res.status(400).json({ error: 'A valid Add request token is required.' });
    const prior = await store.addLedger(id, token).abandon(user.id, list);
    if (!prior || prior.actorId !== user.id || prior.section !== list)
      return res.status(409).json({ error: 'Check whether the Add was saved before abandoning it.' });
    if (prior.outcome === 'confirmed')
      return res.status(409).json({ error: 'This Add was already confirmed. Check again to see the saved record.' });
    res.json({ abandoned: true });
  }));
  app.get('/api/sources/sheet-editor/:list/:rowId', handler(async (req: any, res: any, { id, user }: any) => {
    const c = connections.get(id), list = req.params.list;
    if (!sheetAccess(c) || !sectionOf(list) || !sheetTags(c, list))
      return res.status(403).json({ error: 'This source is read only.' });
    const { target, edit } = await sheetTarget(c, list, req.params.rowId, user.id);
    const needsLinks = list !== 'companies' || [...edit.customTypes!.values()].includes('companyLink');
    const companies = needsLinks ? await sheetCompanies(c) : [];
    edit.links = companyLinks(companies);
    const fields = await sheetsApi(c, list).readTaggedEditor(edit, target);
    res.json({ fields, companies: companies.map(row => ({ id: row.id, name: row.name, key: row.sourceKey })) });
  }));
  function editableCompany(c: Connection, recordId: string) {
    if (!/^rec[A-Za-z0-9]+$/.test(recordId)) throw Object.assign(Error('Invalid Airtable record ID.'), { status: 400 });
    const row = cache.data(c.agencyId)?.companies.find(company => company.id === recordId);
    if (!row) return sheetConflict('This company is no longer in the current company list.');
    const removal = deps.companyRemoval?.removal(c.agencyId, recordId, companySourceIdentity(c)!, row.archiveKey);
    if (removal?.archived || removal?.requested || removal?.deletedAt)
      return sheetConflict('This company is archived or being removed.');
  }
  function editError(res: any, error: any, extra = {}) {
    return res.status(error.status || 503).json({ error: error.message, ...(error.readOnly && { readOnly: true }), ...extra });
  }
  app.get('/api/sources/rows/companies/:rowId/edit', mutation(async (req: any, res: any, { id }: any) => {
    const c = connections.get(id);
    if (c?.sourceType !== 'airtable') return res.status(409).json({ error: 'Editing from the app is not available for this source.' });
    const recordId = req.params.rowId;
    if (c.access !== 'readwrite') return res.status(403).json({ error: 'This source is read only.', readOnly: true });
    const adapter = airtable(c);
    try {
      editableCompany(c, recordId);
      const eligibility = await editorEligibility(c, adapter);
      const record = await adapter.readCompany(recordId);
      if (record.recordId !== recordId) return res.status(404).json({ error: 'Company record not found.' });
      res.set?.('Cache-Control', 'no-store');
      res.json({ warnings: record.warnings, fields: record.values, baseId: c.baseId, updatedAt: c.updatedAt, access: eligibility.access, typeOptions: eligibility.typeOptions });
    } catch (cause) { return editError(res, await permissionError(c, adapter, cause)); }
  }));

  const refreshAfterEdit = new Set<string>();
  async function saveAirtableCompany(c: Connection, req: any, res: any, actorId: string) {
    const recordId = req.params.rowId || '';
    const entry: AirtableEditAudit = { operationId: randomUUID(), sourceType: 'airtable', baseId: c.baseId,
      table: c.mapping.companies.table, recordId, actorId, agencyId: c.agencyId, section: 'companies',
      at: new Date().toISOString(), outcome: 'rejected', changedFields: [], previous: {}, requested: {},
      verified: false, writeEvidence: {} };
    let adapter: ReturnType<typeof airtable> | undefined;
    let sent = false;
    let error: any;
    try {
      guardSourceWrite(c, req.params.list, req.body?.fields);
      if (!recordId) {
        if (req.method === 'PATCH') throw Object.assign(Error('Choose an existing mapped record.'), { status: 400 });
        sheetConflict('Adding Airtable companies is not available.');
      }
      const { fields, originals, baseId, updatedAt } = req.body;
      const changed = Object.keys(fields) as AirtableCompanyField[]; // Validated by guardSourceWrite.
      entry.changedFields = changed;
      entry.requested = fields;
      limitWrites(c.agencyId);
      if (baseId !== c.baseId || updatedAt !== c.updatedAt) sheetConflict('The source connection changed. Reopen the company.');
      editableCompany(c, recordId);
      adapter = airtable(c);
      const eligibility = await editorEligibility(c, adapter);
      for (const field of changed) {
        if (!c.mapping.companies[field])
          throw Object.assign(Error('Only mapped list columns can be edited.'), { status: 400 });
        if (!originals || !Object.hasOwn(originals, field) || !(originals[field] === null || typeof originals[field] === 'string'))
          throw Object.assign(Error('Include the original value for every changed field.'), { status: 400 });
      }
      if ('name' in fields) {
        const { data, links } = await adapter.renameData();
        if (associationChanges(links, data.companies, data.otherCompanies ?? [], recordId, fields.name, 'ignore'))
          sheetConflict('This name change would change company links. Use permanent company IDs before renaming.');
      }
      if (fields.type && eligibility.typeOptions && !eligibility.typeOptions.includes(fields.type))
        throw Object.assign(Error('Choose a type from the Airtable column options.'), { status: 400 });
      const before = await adapter.readCompany(recordId);
      entry.writeEvidence.verifyGet = before;
      if (before.recordId !== recordId) throw Object.assign(Error('Company record not found.'), { status: 404 });
      const included = changed.filter(field => {
        if (!Object.hasOwn(before.values, field)) throw Object.assign(Error('Only mapped list columns can be edited.'), {status: 400});
        const current = before.values[field];
        entry.previous[field] = current;
        if (current === (fields[field] || null)) return false;
        if (current !== (originals[field] || null))
          throw Object.assign(Error('The company changed in Airtable. Reload and review.'), { status: 409, code: 'STALE_COMPANY_VALUE' });
        return true;
      });
      if (included.length) {
        const patch = Object.fromEntries(included.map(field => [c.mapping.companies[field]!, fields[field] || null]));
        entry.outcome = 'attempted';
        try { await store.saveEditAudit(entry); }
        catch { return res.status(503).json({ error: 'The audit could not be recorded. The edit was stopped before saving.' }); }
        sent = true;
        try { await adapter.patchCompany(recordId, patch); }
        catch (cause: any) { if (cause.status >= 400 && cause.status < 500) sent = false; throw cause; }
        const after = await adapter.readCompany(recordId);
        entry.writeEvidence.confirmGet = after;
        if (after.recordId !== recordId || included.some(field => after.values[field] !== (fields[field] || null)))
          throw Error('Airtable confirmation did not match.');
      }
      entry.verified = true;
      entry.outcome = 'confirmed';
    } catch (cause) {
      entry.outcome = sent ? 'unconfirmed' : 'rejected';
      error = adapter ? await permissionError(c, adapter, cause) : cause;
    }
    let auditWarning: string | undefined;
    try { await store.saveEditAudit(entry); }
    catch { auditWarning = 'The final edit audit could not be recorded.'; }
    if (entry.outcome === 'unconfirmed') return res.status(409).json({ outcome: entry.outcome, auditWarning,
      readOnly: error?.readOnly, error: 'Airtable may have saved these changes. Reload and review before retrying.' });
    if (error) return editError(res, error, { auditWarning, ...(error.code === 'STALE_COMPANY_VALUE' && { code: error.code }), ...(c.access === 'read' && { readOnly: true }) });
    const values = (entry.writeEvidence.confirmGet ?? entry.writeEvidence.verifyGet)!.values;
    return res.json({ saved: true, fields: values, auditWarning, ...await republishAirtable(c, adapter!) });
  }
  async function republishAirtable(c: Connection, adapter: ReturnType<typeof airtable>) {
    try {
      cache.publish(c.agencyId, await adapter.loadAll());
      refreshAfterEdit.delete(c.agencyId);
      return {};
    } catch (cause) {
      await permissionError(c, adapter, cause);
      const warning = 'Saved in Airtable. Refresh required.';
      refreshAfterEdit.add(c.agencyId);
      cache.requireRefresh(c.agencyId, warning);
      return { refreshRequired: true, warning, readOnly: connections.get(c.agencyId)?.access === 'read' };
    }
  }
  const writeTimes = new Map<string, number[]>();
  function limitWrites(id: string) {
    const recent = (writeTimes.get(id) || []).filter(t => Date.now() - t < 60000);
    if (recent.length >= 30) throw Object.assign(Error('Too many writes. Try again in a minute.'), { status: 429 });
    recent.push(Date.now());
    writeTimes.set(id, recent);
  }
  registerCompanyItems(app, {
    user: req => deps.itemUser?.(req), visible: (user, id) => deps.itemVisible?.(user, id) ?? Promise.resolve(false),
    serialize, withAssignmentLock: (id, fn) => deps.companyRemoval?.withRemoval(id, fn) ?? fn(),
    connection: id => connections.get(id), state: cache.state, adapter: airtable, eligible: editorEligibility,
    permissionError, ledger: store.airtableLedger, limit: limitWrites, blocked: deps.staged,
    republish: republishAirtable,
  });
  const write = mutation(async (req: any, res: any, { id, user }: any) => {
      if (blocked(res))
          return;
      if (flights.has(id))
          await flights.get(id);
      const c = connections.get(id), list: SourceSection = req.params.list;
      if (c?.sourceType === 'airtable') return saveAirtableCompany(c, req, res, user.id);
      if (req.method === 'PATCH' && !req.params.rowId)
          return res.status(400).json({ error: 'Choose an existing mapped record.' });
      const sheets = c?.sourceType === 'google_sheets' && (c.sheetsTables || c.sheetsPilot);
      if (!req.params.rowId && !sheets && (req.body?.addRevision !== undefined || req.body?.token !== undefined))
          return res.status(409).json({ error: 'The mapped sheet or columns changed. Close and reopen the Add form.',
              ...(req.body?.fields !== undefined && { addRevisionStale: true }) });
      if (req.body?.originals !== undefined || req.body?.updatedAt !== undefined)
          return res.status(409).json({ error: 'The source connection changed. Reopen the company.' });
      const fields = sheets ? req.body?.fields : guardSourceWrite(c, list, req.body?.fields);
      if (isOAuthProvider(c!.sourceType))
          oauth.requireSetUp(c!.sourceType);
      limitWrites(id);
      if (sheets) {
          if (c.access !== 'readwrite' || c.oauth?.google_sheets?.access !== 'readwrite')
              return res.status(403).json({ error: 'This source is read only.' });
          if (!sectionOf(list)) return res.status(400).json({ error: 'Choose an existing mapped record.' });
          if (!req.params.rowId) {
              const token = req.body?.token;
              if (!validAddToken(token))
                  return res.status(400).json({ error: 'A valid Add request token is required.' });
              const { target, edit } = sheetAddTarget(c, list, user.id);
              edit.fields = fields;
              if (list !== 'companies' || [...edit.customTypes!.values()].includes('companyLink'))
                  edit.refreshLinks = async () => companyLinks(await sheetCompanies(c));
              if (list === 'companies') edit.validateChanges = changes => checkCompanyName(c, changes);
              const result = await sheetsApi(c, list).addTaggedRow(edit, target, token, store.addLedger(id, token),
                  fields === undefined, req.body?.addRevision)
                  .catch(cause => {
                      if (cause.sheetNeedsReview) cache.requireRefresh(id, cause.message);
                      throw cause;
                  });
              try {
                  cache.publish(id, await connector(c).loadAll!());
              } catch {
                  const warning = 'The new record was confirmed in Google Sheets. Refresh the source to update the inspection list.';
                  cache.requireRefresh(id, warning);
                  return res.json({ ...result, saved: true, refreshRequired: true, warning });
              }
              return res.json({ ...result, saved: true });
          }
          const { target, edit } = await sheetTarget(c, list, req.params.rowId, user.id);
          edit.fields = fields;
          edit.expected = req.body?.expected;
          edit.requireRevision = true;
          const linkFields = Object.keys(fields ?? {}).some(field => field === 'companyLink' || edit.customTypes?.get(field) === 'companyLink');
          if (linkFields) {
              edit.refreshLinks = async () => companyLinks(await sheetCompanies(c));
              edit.links = await edit.refreshLinks();
          }
          if (list === 'companies') edit.validateChanges = changes => checkCompanyName(c, changes, target.recordId);
          const result = await sheetsApi(c, list).updateTaggedRow(edit, target, store.saveEditAudit).catch(cause => {
              if (cause.sheetNeedsReview) cache.requireRefresh(id, cause.message);
              throw cause;
          });
          try {
              cache.publish(id, await connector(c).loadAll!());
          } catch {
              const warning = 'Refresh the source to update the inspection list.';
              cache.requireRefresh(id, warning);
              return res.json({ saved: true, refreshRequired: true, warning });
          }
          return res.json({ saved: true, ...(result.otherFieldsChanged && {
              warning: 'Other cells in this row changed while you were saving. Review the record in Google Sheets.',
          }) });
      }
      const config = c!.mapping[list];
      const data = cache.data(id);
      const links = companyLinkResolver(data?.companies ?? [], data?.otherCompanies);
      if ('companyLink' in config && config.companyLink && Object.hasOwn(fields, config.companyLink)) {
          links(fields[config.companyLink]);
      }
      const adapter = connector(c!);
      const row = await adapter.writeRow!(config.table, { ...(req.params.rowId ? { id: req.params.rowId } : {}), fields }, config.file);
      try {
          // Company names and eligibility can change associations in both item lists.
          // Publish all three together, keeping the previous snapshot readable during the load.
          if (list === 'companies' || !data || cache.state(id).status !== 'ok') {
              cache.publish(id, await adapter.loadAll!());
          } else {
              const mapped = mapSourceLists({ [list]: [row] }, c!.mapping, { resolveLinks: links });
              const rows = [...data[list]];
              const index = rows.findIndex(item => item.id === row.id);
              if (index < 0) rows.push(mapped[list][0]);
              else rows[index] = mapped[list][0];
              cache.publish(id, { ...data, [list]: rows });
          }
      } catch (cause) {
          const warning = cause instanceof CompanyLinkError ? cause.message : 'Refresh the source to update the inspection list.';
          cache.requireRefresh(id, warning);
          return res.json({ row, saved: true, refreshRequired: true, warning });
      }
      res.json({ row, saved: true });
  });
  app.patch?.('/api/sources/rows/:list', write);
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
    c.airtableDirectRemoval = old?.sourceType === 'airtable' && old.baseId === c.baseId &&
      old.airtableDirectRemoval === true && old.mapping.companies?.table === c.mapping.companies.table;
    const validation = await verifyBaseAccess(c, airtable(c));
    if (validation.eligibility.access === 'read') c.access = 'read';
    for (const kind of ['companies', 'ingredients', 'products'] as const) {
      const config = c.mapping[kind], table = validation.tables?.find(t => t.name === config.table);
      if (kind !== 'products' && c.mapping[kind].locAttachment && table?.fieldTypes?.[c.mapping[kind].locAttachment!] !== 'multipleAttachments')
        return res.status(400).json({ error: 'Choose an Airtable attachment column.' });
      if (!table || Object.entries(config).some(([field, column]) => field !== 'table' && typeof column === 'string' && !(field === 'locAttachment' && !column) && !table.columns.includes(column))) return res.status(400).json({ error: 'Mapped tables and columns must exist in the source.' });
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
    try { await save(c, [], undefined, !changed); if(changed) unconfirmed.delete(id); } catch (cause) { if (job) retrySave(id, job.expected, job.connection, job.backups, job.attempt); throw cause; }
    uploads.delete(id);
    backupErrors.delete(id);
    connections.set(id, c); keyErrors.delete(id);
    if (c.access === 'readwrite') baseWriteEligibility.set(id, validation.eligibility);
    if (changed && (!old || old.baseId !== c.baseId || old.sourceType !== c.sourceType || keyChanged || JSON.stringify({ ...old.mapping, valueAssignments: undefined }) !== JSON.stringify({ ...c.mapping, valueAssignments: undefined }))) cache.reset(id);
    else cache.reassign(id, c.mapping);
    res.json(safe(id)); schedule(id); void serialize(id, () => refresh(id));
  }));
  app.post('/api/sources/test', handler(async (req: any, res: any, { id }: any) => {
    try { settings(req.body, false); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    const old = connections.get(id), plain = req.body.apiKey?.trim();
    if (!plain && !old) return res.status(400).json({ error: 'API key required' });
    const c = { ...old, ...req.body, agencyId: id, mapping: old?.mapping || emptyMapping } as Connection;
    const adapter = connector(c, plain), result = await adapter.testConnection();
    if (old?.sourceType === 'airtable' && c.sourceType === 'airtable' && c.baseId === old.baseId &&
        (!result.ok || result.access !== 'readwrite')) baseWriteEligibility.delete(id);
    if (!result.ok) return res.json({ ok: false, error: result.error, calls: adapter.calls() });
    const guess = guessMapping(result.tables || []);
    const preferred = new Set([guess.mapping.companies.table, guess.mapping.ingredients.table, guess.mapping.products.table]);
    const tables = [...(result.tables || [])].sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)));
    let samples;
    try { samples = adapter.samples ? await adapter.samples(tables.slice(0, 15)) : {}; }
    catch { return res.json({ ok: false, error: 'Source preview failed', calls: adapter.calls() }); }
    res.json({ ...result, guess, samples, calls: adapter.calls() });
  }));
  app.post('/api/sources/refresh', mutation(async (_req: any, res: any, { id }: any) => {
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
        ...('expiresOn' in item && { expiresOn: item.expiresOn }), dpm: item.dpm || null, group1: typeof override === 'boolean' ? override : item.group1 === true,
        group1Source: typeof override === 'boolean' ? 'admin' : 'source' };
    });
  app.get('/api/factories/:companyId/items', handler(async (req: any, res: any, { id }: any) => {
    const source = companySourceIdentity(connections.get(id));
    if (source && deps.companyRemoval) await deps.companyRemoval.pendingRemovals(id, source);
    if ((source && deps.companyRemoval?.removal(id, req.params.companyId, source)?.deletedAt) ||
        !cache.state(id).companies.some(c => c.id === req.params.companyId)) return res.status(404).json({ error: 'Company not found' });
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
  const removalMode = (c: Connection): CompanyRemoval['requested'] | null => c.sourceType === 'google_sheets' ? 'guided'
    : c.sourceType === 'airtable' && c.access === 'readwrite' && c.airtableDirectRemoval === true ? 'direct' : null;
  const linkedLabels = { companies: 'Companies', ingredients: 'Schedule A', products: 'Schedule B' };
  const verifyCompanyIdentity = 'Check linked records and verify the company identity before continuing.';
  async function sheetRemovalIdentity(c: Connection, companyId: string, entry?: CompanyRemoval) {
    const api = sheetsApi(c, 'companies'), snapshot = await api.companyRemovalSnapshot();
    const companies = snapshot.rows.map(row => ({
      id: row.id, sourceKey: row.sourceKey, name: cellText(row.fields[c.mapping.companies.name]), rowNumber: row.rowNumber,
    }));
    const company = companies.find(row => row.id === companyId);
    const tags = company ? snapshot.tags.filter(tag => tag.rowNumber === company.rowNumber) : [];
    const metadataId = tags[0]?.metadataId;
    const validTags = !tags.length || (tags.length === 1 && Number.isSafeInteger(metadataId) && tags[0].metadataValue === company?.sourceKey);
    const evidence: SheetRemovalEvidence | undefined = company && validTags ? {
      binding: snapshot.binding, rowCount: snapshot.rowCount, remainingRowsHash: snapshot.remainingRowsHash(companyId),
      ...(metadataId === undefined ? {} : { metadataId }),
    } : undefined;
    if (entry?.requested !== 'guided') return { companies, company, evidence, consistent: validTags };

    const original = entry.sheetEvidence;
    const sameRow = !!company && validTags && company.sourceKey === entry.recordKey && company.name === entry.name;
    const sameBinding = original?.binding === snapshot.binding;
    if (company) return {
      companies, company, evidence,
      consistent: sameRow && (!original || (sameBinding && original.metadataId === metadataId)),
    };

    // Compare the full source tab, including records hidden by filters or Add quarantine.
    // A physical row deletion reduces the grid by one and leaves the other rows intact.
    const oldKeyOrName = companies.some(row => row.sourceKey === entry.recordKey || row.name.toLowerCase() === entry.name.toLowerCase());
    const consistent = !!original && sameBinding && !oldKeyOrName &&
      snapshot.rowCount === original.rowCount - 1 && snapshot.remainingRowsHash() === original.remainingRowsHash &&
      (original.metadataId === undefined || (!snapshot.tags.some(tag => tag.metadataId === original.metadataId) &&
        !await api.hasRowMetadata(original.metadataId)));
    return { companies, company, evidence, consistent };
  }
  async function removalPlan(c: Connection, companyId: string, entry?: CompanyRemoval) {
    const mode = removalMode(c), adapter = connector(c);
    const { table, file } = c.mapping.companies;
    const sheet = c.sourceType === 'google_sheets';
    const identity = sheet ? await sheetRemovalIdentity(c, companyId, entry) : undefined;
    const rawCompanies = identity?.companies ?? [];
    const data = mode === 'direct' ? await adapter.loadAll!() : cache.data(c.agencyId);
    const all = [...(data?.companies ?? []), ...(data?.otherCompanies ?? [])];
    const freshCompany = sheet ? identity?.company : all.find(row => row.id === companyId);
    const native = mode === 'direct' ? await adapter.companyDeletion!(companyId) : undefined;
    const present = native?.present ?? !!freshCompany;
    const recordKey = (sheet ? freshCompany?.sourceKey : companyId) ?? entry?.recordKey;
    const name = freshCompany?.name ?? entry?.name ?? '';
    const blockers = new Set(native?.blockers);
    if (identity && !identity.consistent) blockers.add(verifyCompanyIdentity);
    if (!mode) blockers.add(c.sourceType === 'airtable'
      ? 'Enable write access in Source settings to delete this company in Shutfey.'
      : 'Shutfey cannot safely verify and permanently delete this company from the connected source.');
    if (mode && (present || entry?.requested)) {
      for (const list of ['ingredients', 'products'] as const) {
        const config = c.mapping[list];
        if (config.table && config.table === table && (config.file?.id || c.baseId) === (file?.id || c.baseId))
          blockers.add(`The company shares its source table with ${linkedLabels[list]}. Move those records to a separate table first.`);
      }
      if (sheet) {
        if (!present && rawCompanies.some(row => cellText(row.name).toLowerCase() === cellText(name).toLowerCase()))
          blockers.add('A row with this company name has a different permanent ID. Contact support to verify the removal.');
        // When the row is gone, its old key and name still identify any links
        // an editor added after the guided removal was started.
        const companies = present ? rawCompanies : [...rawCompanies, { id: companyId, sourceKey: recordKey, name }];
        const resolve = companyLinkResolver(companies);
        for (const list of sections) {
          const config = c.mapping[list] as Record<string, unknown>;
          if (!config.table) continue;
          const columns = new Set(Object.entries(c.mapping.editableCustomFields?.[list] ?? {})
            .filter(([, rule]) => rule === 'companyLink').map(([field]) => config[field]));
          if (list !== 'companies') columns.add(config.companyLink);
          if (!columns.size) continue;
          for (const row of await sheetRows(c, list)) {
            if (list === 'companies' && row.id === companyId) continue;
            for (const column of columns) {
              if (typeof column !== 'string' || !column) continue;
              try {
                if (resolve(row.fields[column]).includes(companyId)) {
                  const name = typeof config.name === 'string' ? cellText(row.fields[config.name]) : '';
                  blockers.add(`${linkedLabels[list]} · ${name || row.sourceKey || row.id}`);
                }
              } catch (error) {
                if (!(error instanceof CompanyLinkError)) throw error;
                blockers.add(`Review unresolved company links in ${linkedLabels[list]}.`);
              }
            }
          }
        }
      }
    }
    return {
      mode, name, present, recordKey, blockers: [...blockers], remove: native?.remove,
      sheetEvidence: identity?.evidence, consistent: identity?.consistent,
      ...(sheet ? { spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(file?.id || c.baseId)}/edit`, table } : {}),
    };
  }
  const companyRemovalRoute = '/api/factories/:companyId/removal';
  app.get(companyRemovalRoute, mutation(async (req: any, res: any, { id, user }: any) => {
    const c = connections.get(id), source = companySourceIdentity(c), lifecycle = deps.companyRemoval;
    if (req.kiosk || !user.agencyId) return res.status(403).json({ error: 'Forbidden' });
    if (!c || !source || !lifecycle || req.query.source !== source) return sheetConflict('The source changed. Refresh company data and try again.');
    const companyId = req.params.companyId;
    await lifecycle.withRemoval(id, async () => {
      const row = cache.state(id).companies.find(row => row.id === companyId);
      const entry = lifecycle.removal(id, companyId, source, row?.archiveKey);
      if (entry?.deletedAt || (!row && !entry?.requested) || (await deps.foodServiceCompanyIds?.(id))?.includes(companyId))
        return res.status(404).json({ error: 'Company not found' });
      if (entry?.requested && entry.source !== source) return sheetConflict('The source changed. Refresh company data and try again.');
      const plan = await removalPlan(c, companyId, entry);
      res.json({ ...plan, remove: undefined, sheetEvidence: undefined, consistent: undefined, pending: entry?.requested ?? null });
    });
  }));
  app.post(companyRemovalRoute, mutation(async (req: any, res: any, { id, user }: any) => {
    if (blocked(res)) return;
    const c = connections.get(id), source = companySourceIdentity(c), lifecycle = deps.companyRemoval;
    if (req.kiosk || !user.agencyId) return res.status(403).json({ error: 'Forbidden' });
    if (!c || !source || !lifecycle || req.body?.source !== source) return sheetConflict('The source changed. Refresh company data and try again.');
    const companyId = req.params.companyId, { action, confirmation, name } = req.body;
    await lifecycle.withRemoval(id, async () => {
      const row = cache.state(id).companies.find(row => row.id === companyId);
      const entry = lifecycle.removal(id, companyId, source, row?.archiveKey);
      if (entry?.deletedAt) return res.json({ status: 'deleted' });
      const archiveKey = row?.archiveKey ?? entry?.archiveKey;
      if ((!row && !entry?.requested) || (await deps.foodServiceCompanyIds?.(id))?.includes(companyId))
        return res.status(404).json({ error: 'Company not found' });
      if (action === 'archive' || action === 'restore') {
        if (entry?.requested) return sheetConflict('Finish checking the permanent removal first.');
        if (!row) return sheetConflict('Refresh company data and try again.');
        const archived = action === 'archive';
        if (c.sourceType === 'google_sheets' && !archiveKey) return sheetConflict('Refresh company data and try again.');
        await lifecycle.setRemoval(id, companyId, { source, archived, name: row.name, ...(archiveKey ? { archiveKey } : {}) });
        return res.json({ status: archived ? 'archived' : 'restored' });
      }
      if (action !== 'delete' && action !== 'refresh' && action !== 'cancel') return res.status(400).json({ error: 'Invalid removal action' });
      if (action === 'delete' && confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
      if (action === 'refresh' && !entry?.requested) return sheetConflict('Start permanent removal before checking the source.');
      if (entry?.requested && entry.source !== source) return sheetConflict('The source changed. Refresh company data and try again.');
      const plan = await removalPlan(c, companyId, entry);
      if (!plan.mode) return sheetConflict(plan.blockers[0]);
      if (action === 'cancel') {
        if (entry?.requested !== 'guided' || !plan.present || !plan.consistent) return sheetConflict('Refresh company data to verify removal.');
        await lifecycle.setRemoval(id, companyId, { source, archived: entry.archived, name: plan.name, ...(archiveKey ? { archiveKey } : {}) });
        return res.json({ status: 'cancelled' });
      }
      if (plan.blockers.length) return sheetConflict(verifyCompanyIdentity);
      if (action === 'delete' && plan.present) {
        if (plan.name !== name) return sheetConflict('The company name changed. Review the company and try again.');
        if (plan.mode === 'guided') {
          if (!plan.recordKey || !plan.sheetEvidence) return sheetConflict('The permanent ID could not be verified. Contact support before deleting anything.');
          if (entry?.requested === 'guided') return res.json({ status: 'guided' });
        }
        await lifecycle.setRemoval(id, companyId, {
          source, archived: entry?.archived ?? false, name: plan.name, requested: plan.mode,
          ...(plan.recordKey ? { recordKey: plan.recordKey } : {}),
          ...(archiveKey ? { archiveKey } : {}),
          ...(plan.sheetEvidence ? { sheetEvidence: plan.sheetEvidence } : {}),
          ...(row?.companyFee === undefined ? {} : { companyFee: row.companyFee }),
          ...(row?.mashgiachFee === undefined ? {} : { mashgiachFee: row.mashgiachFee }),
        });
        if (plan.mode === 'guided') return res.json({ status: 'guided' });
        await plan.remove!();
      } else if (plan.present) {
        const result = await refresh(id);
        if (!result.ok) return sheetConflict('The source could not be read. Try refreshing again.');
        return res.json({ status: 'present' });
      } else if (!entry?.requested) {
        return sheetConflict('The company could not be found in the source. Refresh company data and review the record.');
      }
      const result = await refresh(id);
      const latest = cache.data(id);
      if (!result.ok || !latest || [...latest.companies, ...(latest.otherCompanies ?? [])].some(row => row.id === companyId || (plan.mode === 'guided' && plan.recordKey && row.sourceKey === plan.recordKey)))
        return sheetConflict('Removal could not be confirmed. Refresh company data and try again.');
      const confirmed = lifecycle.removal(id, companyId, source)!;
      if (plan.mode === 'guided') {
        const verified = await sheetRemovalIdentity(c, companyId, confirmed);
        if (verified.company || !verified.consistent) return sheetConflict(verifyCompanyIdentity);
      }
      const { requested: _requested, sheetEvidence: _sheetEvidence, ...saved } = confirmed;
      await lifecycle.setRemoval(id, companyId, { ...saved, deletedAt: (deps.now?.() ?? new Date()).toISOString() });
      res.json({ status: 'deleted' });
    });
  }));
  app.get('/api/factories', handler(async (_req: any, res: any, { id }: any) => {
    if (refreshAfterEdit.has(id)) await serialize(id, async () => {
      if (!refreshAfterEdit.has(id)) return;
      const c = connections.get(id);
      if (c?.sourceType === 'airtable') {
        try { cache.publish(id, await connector(c).loadAll!()); } catch { return; }
      }
      refreshAfterEdit.delete(id);
    });
    const s = cache.state(id), c = connections.get(id);
    const foodServiceIds = new Set(await deps.foodServiceCompanyIds?.(id) ?? []);
    const source = companySourceIdentity(c), lifecycle = deps.companyRemoval;
    const pending = source ? await lifecycle?.pendingRemovals(id, source) ?? [] : [];
    const rows = s.companies.filter(c => !foodServiceIds.has(c.id)).flatMap(company => {
      const entry = source ? lifecycle?.removal(id, company.id, source, company.archiveKey) : undefined;
      if (entry?.deletedAt) return [];
      return [{
        id: company.id, name: company.name, address: company.address || '', companyFee: company.companyFee,
        mashgiachFee: company.mashgiachFee, brand: company.brand || '', plant: company.plant || '',
        ingredientCount: s.itemsFor(company.id, 'ingredient').length, productCount: s.itemsFor(company.id, 'product').length,
        lastVisitAt: null, nextDueAt: null, overdue: null,
        ...(entry?.archived || entry?.requested ? { archived: true, removalPending: !!entry.requested } : {}),
      }];
    });
    const pendingOnly = pending.filter(([companyId]) => !rows.some(row => row.id === companyId))
      .map(([companyId, entry]) => ({ id: companyId, name: entry.name, archived: true, removalPending: true }));
    res.json({ status: { group1Label: c?.group1Label || 'Group 1', connected: !!c, sourceType: c?.sourceType || null, status: status(id), refreshedAt: s.refreshedAt || null, calls: s.calls, backupSaveError: backupErrors.has(id), backupTakenAt: s.backupTakenAt || null, error: s.error || null, companySource: source },
      companies: [...rows, ...pendingOnly].sort((a, b) => a.name.localeCompare(b.name)) });
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
  const retryDelay = (attempt:number) => [5000,15000,45000,120000,300000][Math.min(attempt,4)];
  const startupRetries = new Map<string, {timer:ReturnType<typeof setTimeout>; sourceType:Connection['sourceType']}>();
  async function loadConnection(c:Connection) {
    if (connections.has(c.agencyId)) return;
    if (c.sourceType === 'upload') {
      const files = await store.loadUpload(c);
      uploads.set(c.agencyId,files);
    }
    connections.set(c.agencyId,c);
    cache.setKnownHashes(c.agencyId,c.backupHashes || {});
    schedule(c.agencyId);
    if (c.sourceType === 'airtable' || c.mapping.companies?.table)
      void serialize(c.agencyId, () => refresh(c.agencyId)).catch(() => console.warn('[sources] startup refresh failed'));
  }
  function retryAgency(id:string, sourceType:Connection['sourceType'], attempt = 0) {
    if (startupRetries.has(id)) return;
    const timer = setTimeout(() => {
      void serialize(id, async () => {
        if (startupRetries.get(id)?.timer !== timer) return;
        try {
          if (!connections.has(id)) {
            const latest = await store.raw(id);
            if (latest) {
              sourceType = latest.sourceType;
              await loadConnection(normalizeConnection(latest));
            }
          }
          startupRetries.delete(id);
        } catch {
          startupRetries.delete(id);
          retryAgency(id,sourceType,attempt+1);
        }
      });
    },retryDelay(attempt));
    startupRetries.set(id,{timer,sourceType});
    timer.unref();
  }
  let bootAttempt = 0;
  async function boot() {
    await store.reclaimLocalUploads().catch(store.retryLocalCleanup);
    let saved:Connection[];
    try { saved = await store.connections(); }
    catch {
      console.warn('[sources] startup failed');
      const timer = setTimeout(() => { void boot(); },retryDelay(bootAttempt++));
      timer.unref();
      return;
    }
    bootAttempt = 0;
    for (const c of saved) {
      await serialize(c.agencyId, async () => {
        try { await loadConnection(c); }
        catch { retryAgency(c.agencyId,c.sourceType); }
      });
    }
  }
  return { boot, inspectionAgencyIds: () => [...connections.keys()], inspectionSource: inspectionSourceAccessor(cache, connections) };
}

// Read-only bridge for factory visits; no source calls or persistence.
export function inspectionSourceAccessor(cache: ReturnType<typeof createSourceCache>, connections: Map<string, Connection>) {
  return (agencyId: string) => {
    const connection = connections.get(agencyId), state = cache.state(agencyId);
    return {
      state, identity: companySourceIdentity(connection), connection: connection ? {...connection, fees:{...connection.fees,mashgiach:{...connection.fees?.mashgiach,...Object.fromEntries(state.companies.filter(c=>c.mashgiachFee!==undefined).map(c=>[c.id,{amount:c.mashgiachFee!,currency:'USD'}]))}}} : undefined,
      listVersion: (companyId: string) => connection?.backupHashes?.[companyId] || '',
      items: (companyId: string, kind: 'ingredient' | 'product') => state.itemsFor(companyId, kind).map(item => ({
        id: item.id, name: item.name, brand: item.brand ?? '', code: 'code' in item ? item.code ?? '' : '',
        certificationRaw: item.certificationRaw ?? '', statusRaw: item.statusRaw ?? '', agency: item.certifyingAgency ?? '',
        ...('expiresOn' in item && { expiresOn: item.expiresOn }), dpm: item.dpm ?? '', group1: connection?.group1Overrides?.[kind]?.[item.id] ?? item.group1 === true,
      })),
    };
  };
}
