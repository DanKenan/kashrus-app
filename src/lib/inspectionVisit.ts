/** Visit state and storage rules. No network, DOM, or source mutations. */
export type Kind = 'ingredient' | 'product';
export type MarkStatus = 'checked' | 'not_used' | 'alert';
export const markLabels: Record<MarkStatus, string> = { checked: 'Checked', not_used: 'No longer used by the company', alert: 'Alert' };
export interface VisitItem { id: string; name: string; brand: string; code: string; certificationRaw: string; statusRaw: string; agency: string; dpm: 'dairy' | 'dairy_equipment' | 'pareve' | 'meat' | ''; group1: boolean }
export interface Factory { id: string; name: string; brand: string; plant: string; ingredientCount: number; productCount: number }
export interface FactoryList { company: Pick<Factory, 'id' | 'name' | 'brand' | 'plant'>; listVersion: string; group1Label: string; refreshedAt: string | null; backupTakenAt?: string | null; ingredients: VisitItem[]; products: VisitItem[] }
export type ItemSnapshot = Pick<VisitItem, 'name' | 'brand' | 'code' | 'certificationRaw' | 'statusRaw'> & Partial<Pick<VisitItem, 'agency' | 'dpm' | 'group1'>>;
export interface Mark { item?: ItemSnapshot; kind: Kind; itemId: string; status: MarkStatus; note?: string; photo?: string }
export interface OffListItem { name: string; brand?: string; note?: string; photo?: string }
export interface DraftEditor { kind?: Kind; itemId?: string; index?: number; initial: OffListItem }
export interface VisitDraft { factorySnapshot?: FactoryList; editor?: DraftEditor; clientReportId: string; companyId: string; listVersion: string; startedAt: string; note: string; marks: Mark[]; offList: OffListItem[] }
export interface Counts { checked: number; not_used: number; alert: number; offList: number }
export interface ReportSummary { id: string; companyId: string; companyName: string; mashgiachId: string; mashgiachName: string; submittedAt: string; startedAt: string; counts: Counts; hasAlerts: boolean; listChanged: boolean; photoCount: number }
export interface SentReport { report: ReportSummary; fee: { amount: number; currency: string } | null }
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export const visitScope = (userId: string, agencyId: string) => `inspection-visit:${encodeURIComponent(agencyId)}:${encodeURIComponent(userId)}`;
export const draftKey = (scope: string, companyId: string) => `${scope}:draft:${encodeURIComponent(companyId)}`;
export function boundedSnapshot(list: FactoryList): FactoryList {
  if (list.ingredients.length + list.products.length > 10000 || JSON.stringify(list).length > 2_000_000) throw Error('This factory list is too large to save on this phone.');
  return list;
}
export function itemSnapshot(item: VisitItem): ItemSnapshot {
  const { name, brand, code, certificationRaw, statusRaw, agency, dpm, group1 } = item;
  return { name, brand, code, certificationRaw, statusRaw, agency, dpm, group1 };
}
export function newDraft(list: FactoryList, id: string, now: string): VisitDraft {
  return { factorySnapshot: boundedSnapshot(list), clientReportId: id, companyId: list.company.id, listVersion: list.listVersion, startedAt: now, note: '', marks: [], offList: [] };
}
export function saveDraft(storage: StorageLike, scope: string, draft: VisitDraft) { storage.setItem(draftKey(scope, draft.companyId), JSON.stringify(draft)); }
export function restoreDraft(storage: StorageLike, scope: string, list: FactoryList): { draft: VisitDraft; listChanged: boolean } | null {
  const raw = storage.getItem(draftKey(scope, list.company.id));
  if (!raw) return null;
  const draft: VisitDraft = JSON.parse(raw);
  if (!draft || draft.companyId !== list.company.id || !Array.isArray(draft.marks) || !Array.isArray(draft.offList) || typeof draft.clientReportId !== 'string') throw new Error('The saved draft could not be opened.');
  const listChanged = draft.listVersion !== list.listVersion;
  const exists = (kind: Kind, id: string) => (kind === 'ingredient' ? list.ingredients : list.products).some(item => item.id === id);
  const editor = draft.editor?.kind && !exists(draft.editor.kind, draft.editor.itemId || '') ? undefined : draft.editor;
  const marks = draft.marks.map(mark => {
    if (mark.item) return mark;
    const oldList = draft.factorySnapshot || list;
    const item = (mark.kind === 'ingredient' ? oldList.ingredients : oldList.products).find(item => item.id === mark.itemId);
    return item ? { ...mark, item: itemSnapshot(item) } : mark;
  });
  return { draft: { ...draft, ...(draft.editor ? { editor } : {}), factorySnapshot: boundedSnapshot(list), marks }, listChanged };
}
export function visitCounts(draft: Pick<VisitDraft, 'marks' | 'offList'>): Counts {
  const counts = { checked: 0, not_used: 0, alert: 0, offList: draft.offList.length };
  for (const mark of draft.marks) if (mark.status in markLabels) counts[mark.status]++;
  return counts;
}
export function setMark(draft: VisitDraft, kind: Kind, itemId: string, mark: Omit<Mark, 'kind' | 'itemId'> | null): VisitDraft {
  const previous = draft.marks.find(row => row.kind === kind && row.itemId === itemId);
  const item = (kind === 'ingredient' ? draft.factorySnapshot?.ingredients : draft.factorySnapshot?.products)?.find(row => row.id === itemId);
  const snapshot = previous?.item || mark?.item || (item && itemSnapshot(item));
  return { ...draft, marks: [...draft.marks.filter(row => row.kind !== kind || row.itemId !== itemId), ...(mark ? [{ kind, itemId, ...mark, ...(snapshot ? { item: snapshot } : {}) }] : [])] };
}
export function buildPayload(draft: VisitDraft, photoCap = 400_000): VisitDraft {
  const fail = (message: string): never => { throw new Error(message); };
  if (!/^[A-Za-z0-9-]{8,64}$/.test(draft.clientReportId)) fail('Invalid report identifier.');
  if (!draft.companyId || !draft.listVersion || !Number.isFinite(Date.parse(draft.startedAt))) fail('Invalid visit details.');
  if (draft.note.length > 4000 || draft.marks.length > 2000 || draft.offList.length > 50) fail('The report exceeds its limit.');
  let photos = 0, photoChars = 0;
  const attachment = (row: { note?: string; photo?: string }) => {
    if ((row.note?.length || 0) > 1000) fail('Notes can contain up to 1000 characters.');
    if (row.photo) {
      photos++; photoChars += row.photo.length;
      if (photoChars > 900_000) fail('The photos together are too large. Remove a photo or choose smaller photos (900,000 characters total).');
      if (row.photo.length > photoCap || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(row.photo)) fail('Choose a smaller JPEG, PNG or WebP photo.');
    }
    return { ...(row.note !== undefined ? { note: row.note } : {}), ...(row.photo ? { photo: row.photo } : {}) };
  };
  const seen = new Set<string>();
  const marks = draft.marks.map(mark => {
    if (!['ingredient', 'product'].includes(mark.kind) || !Object.prototype.hasOwnProperty.call(markLabels, mark.status) || !mark.itemId) fail('Invalid item mark.');
    const key = `${mark.kind}:${mark.itemId}`;
    if (seen.has(key)) fail('Each item can have only one mark.');
    seen.add(key);
    if (mark.status === 'alert' && !mark.note?.trim() && !mark.photo) fail('An Alert needs a note or photo.');
    return { kind: mark.kind, itemId: mark.itemId, status: mark.status, ...(mark.item ? { item: mark.item } : {}), ...attachment(mark) };
  });
  const offList = draft.offList.map(row => {
    if (!row.name.trim() || row.name.length > 200 || (row.brand?.length || 0) > 200) fail('Add an item name of up to 200 characters.');
    return { name: row.name, ...(row.brand !== undefined ? { brand: row.brand } : {}), ...attachment(row) };
  });
  if (photos > 4) fail('A report can contain up to 4 photos.');
  return { clientReportId: draft.clientReportId, companyId: draft.companyId, listVersion: draft.listVersion, startedAt: draft.startedAt, note: draft.note, marks, offList };
}
export interface OutboxEntry { draft: VisitDraft; attempts: number; nextAttempt: number; error?: string; stopped: boolean; sending?: boolean; sent?: SentReport }
const outboxKey = (scope: string, id: string) => `${scope}:outbox:${id}`;
export function readOutbox(storage: StorageLike, scope: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => !!key && key.startsWith(`${scope}:outbox:`));
  for (const key of keys) {
    const raw = storage.getItem(key)!;
    try {
      const entry = JSON.parse(raw);
      if (!entry || !entry.draft || !Array.isArray(entry.draft.marks) || !Array.isArray(entry.draft.offList) || typeof entry.draft.clientReportId !== 'string' || typeof entry.stopped !== 'boolean' || !Number.isFinite(entry.attempts) || !Number.isFinite(entry.nextAttempt)) throw Error('Invalid outbox entry');
      buildPayload(entry.draft);
      entries.push(entry);
    } catch {
      storage.setItem(`${scope}:quarantine:${key.slice(`${scope}:outbox:`.length)}`, raw);
      storage.removeItem(key);
    }
  }
  return entries;
}
export function storeOutbox(storage: StorageLike, scope: string, entry: OutboxEntry) { storage.setItem(outboxKey(scope, entry.draft.clientReportId), JSON.stringify(entry)); }
export function queueReport(storage: StorageLike, scope: string, draft: VisitDraft): OutboxEntry {
  const entry = { draft: buildPayload(draft), attempts: 0, nextAttempt: 0, stopped: false };
  storeOutbox(storage, scope, entry);
  return entry;
}
export function removeOutbox(storage: StorageLike, scope: string, id: string) { storage.removeItem(outboxKey(scope, id)); }
export function retryResult(entry: OutboxEntry, status: number, error: string, now: number): OutboxEntry {
  const attempts = entry.attempts + 1;
  return { ...entry, sending: false, attempts, stopped: status >= 400 && status < 500, error, nextAttempt: now + Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000) };
}
/** Persist success before clearing the draft, so an acknowledged report cannot become an editable duplicate. */
export function acceptReport(storage: StorageLike, scope: string, entry: OutboxEntry, sent: SentReport) {
  storeOutbox(storage, scope, { ...entry, sending: false, draft: { ...entry.draft, marks: [], offList: [], note: '' }, sent });
  const key = draftKey(scope, entry.draft.companyId);
  const raw = storage.getItem(key);
  if (raw && JSON.parse(raw).clientReportId === entry.draft.clientReportId) storage.removeItem(key);
}
export const retryDue = (entry: OutboxEntry, now: number) => !entry.stopped && !entry.sent && entry.nextAttempt <= now;

/** Serialize a membership's outbox across tabs; leases recover after a closed tab. */
export async function withOutboxLock(storage: StorageLike, scope: string, send: () => Promise<void>) {
  const name = `${scope}:send-lock`;
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request(name, { ifAvailable: true }, async lock => { if (lock) await send(); });
    return;
  }
  const owner = globalThis.crypto.randomUUID();
  const read = () => { try { return JSON.parse(storage.getItem(name) || 'null'); } catch { return null; } };
  if (read()?.expires > Date.now()) return;
  const renew = () => storage.setItem(name, JSON.stringify({ owner, expires: Date.now() + 60000 }));
  renew();
  // Let simultaneous claims settle before either tab starts a request.
  await new Promise(resolve => setTimeout(resolve, 50));
  if (read()?.owner !== owner) return;
  const timer = setInterval(() => { if (read()?.owner === owner) renew(); }, 10000);
  try { await send(); }
  finally { clearInterval(timer); if (read()?.owner === owner) storage.removeItem(name); }
}
