/** Visit state and storage rules. No network, DOM, or source mutations. */
export type Kind = 'ingredient' | 'product';
export type MarkStatus = 'checked' | 'not_used' | 'alert';
export const markLabels: Record<MarkStatus, string> = { checked: 'Checked', not_used: 'No longer used by the company', alert: 'Alert' };
export interface VisitItem { id: string; name: string; brand: string; code: string; certificationRaw: string; statusRaw: string; agency: string; dpm: 'dairy' | 'dairy_equipment' | 'pareve' | 'meat' | ''; group1: boolean }
export interface Factory { id: string; name: string; brand: string; plant: string; ingredientCount: number; productCount: number }
export interface FactoryList { company: Pick<Factory, 'id' | 'name' | 'brand' | 'plant'>; listVersion: string; group1Label: string; refreshedAt: string; ingredients: VisitItem[]; products: VisitItem[] }
export interface Mark { kind: Kind; itemId: string; status: MarkStatus; note?: string; photo?: string }
export interface OffListItem { name: string; brand?: string; note?: string; photo?: string }
export interface DraftEditor { kind?: Kind; itemId?: string; index?: number; initial: OffListItem }
export interface VisitDraft { editor?: DraftEditor; clientReportId: string; companyId: string; listVersion: string; startedAt: string; note: string; marks: Mark[]; offList: OffListItem[] }
export interface Counts { checked: number; not_used: number; alert: number; offList: number }
export interface ReportSummary { id: string; companyId: string; companyName: string; mashgiachId: string; mashgiachName: string; submittedAt: string; startedAt: string; counts: Counts; hasAlerts: boolean; listChanged: boolean; photoCount: number }
export interface SentReport { report: ReportSummary; fee: { amount: number; currency: string } | null }
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export const visitScope = (userId: string, agencyId: string) => `inspection-visit:${encodeURIComponent(agencyId)}:${encodeURIComponent(userId)}`;
export const draftKey = (scope: string, companyId: string) => `${scope}:draft:${encodeURIComponent(companyId)}`;
export function newDraft(list: FactoryList, id: string, now: string): VisitDraft {
  return { clientReportId: id, companyId: list.company.id, listVersion: list.listVersion, startedAt: now, note: '', marks: [], offList: [] };
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
  return { draft: { ...draft, ...(draft.editor ? { editor } : {}), marks: draft.marks.filter(mark => exists(mark.kind, mark.itemId)) }, listChanged };
}
export function visitCounts(draft: Pick<VisitDraft, 'marks' | 'offList'>): Counts {
  const counts = { checked: 0, not_used: 0, alert: 0, offList: draft.offList.length };
  for (const mark of draft.marks) if (mark.status in markLabels) counts[mark.status]++;
  return counts;
}
export function setMark(draft: VisitDraft, kind: Kind, itemId: string, mark: Omit<Mark, 'kind' | 'itemId'> | null): VisitDraft {
  return { ...draft, marks: [...draft.marks.filter(row => row.kind !== kind || row.itemId !== itemId), ...(mark ? [{ kind, itemId, ...mark }] : [])] };
}
export function buildPayload(draft: VisitDraft, photoCap = 400_000): VisitDraft {
  const fail = (message: string): never => { throw new Error(message); };
  if (!/^[A-Za-z0-9-]{8,64}$/.test(draft.clientReportId)) fail('Invalid report identifier.');
  if (!draft.companyId || !draft.listVersion || !Number.isFinite(Date.parse(draft.startedAt))) fail('Invalid visit details.');
  if (draft.note.length > 4000 || draft.marks.length > 2000 || draft.offList.length > 50) fail('The report exceeds its limit.');
  let photos = 0;
  const attachment = (row: { note?: string; photo?: string }) => {
    if ((row.note?.length || 0) > 1000) fail('Notes can contain up to 1000 characters.');
    if (row.photo) {
      photos++;
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
    return { kind: mark.kind, itemId: mark.itemId, status: mark.status, ...attachment(mark) };
  });
  const offList = draft.offList.map(row => {
    if (!row.name.trim() || row.name.length > 200 || (row.brand?.length || 0) > 200) fail('Add an item name of up to 200 characters.');
    return { name: row.name, ...(row.brand !== undefined ? { brand: row.brand } : {}), ...attachment(row) };
  });
  if (photos > 4) fail('A report can contain up to 4 photos.');
  return { clientReportId: draft.clientReportId, companyId: draft.companyId, listVersion: draft.listVersion, startedAt: draft.startedAt, note: draft.note, marks, offList };
}
export interface OutboxEntry { draft: VisitDraft; attempts: number; nextAttempt: number; error?: string; stopped: boolean; sent?: SentReport }
const outboxKey = (scope: string, id: string) => `${scope}:outbox:${id}`;
export function readOutbox(storage: StorageLike, scope: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(`${scope}:outbox:`)) entries.push(JSON.parse(storage.getItem(key)!));
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
  return { ...entry, attempts, stopped: status >= 400 && status < 500, error, nextAttempt: now + Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000) };
}
/** Persist success before clearing the draft, so an acknowledged report cannot become an editable duplicate. */
export function acceptReport(storage: StorageLike, scope: string, entry: OutboxEntry, sent: SentReport) {
  storeOutbox(storage, scope, { ...entry, draft: { ...entry.draft, marks: [], offList: [], note: '' }, sent });
  const key = draftKey(scope, entry.draft.companyId);
  const raw = storage.getItem(key);
  if (raw && JSON.parse(raw).clientReportId === entry.draft.clientReportId) storage.removeItem(key);
}
export const retryDue = (entry: OutboxEntry, now: number) => !entry.stopped && !entry.sent && entry.nextAttempt <= now;
