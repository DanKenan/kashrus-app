import type { ScheduleCompany } from './visitSchedule';
import type { StorageLike } from './inspectionVisit';
export type AnswerValue = boolean | number | string | null;
export interface ChecklistItem { id: string; label: string; type: 'yes_no' | 'number' | 'text'; required: boolean; help: string; problemIf?: 'no' | 'yes'; min: number | null; max: number | null }
export interface Template { id: string; name: string; items: ChecklistItem[]; version: number; updatedAt: string }
export interface FoodPlace extends ScheduleCompany { address: string; source: 'connected' | 'manual'; type: string; templateId: string | null; templateName: string; assigned?: boolean; itemCount?: number }
export interface FoodData { today: string; timeZone: string; templates: Template[]; places: FoodPlace[]; candidates: { id: string; name: string; type: string }[] }
export interface FoodAnswer { itemId: string; value: AnswerValue; note?: string; photo?: string }
export interface FoodDraft { kind: 'food_service'; clientReportId: string; companyId: string; startedAt: string; templateId: string | null; templateVersion: number | null; answers: FoodAnswer[]; note: string; photo?: string }
export interface ChecklistAnswer extends Omit<ChecklistItem, 'id'> { itemId: string; value: AnswerValue; note: string; failed: boolean; hasPhoto: boolean }
export const hasAnswer = (value: AnswerValue | undefined) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
export function failedItem(item: ChecklistItem, value: AnswerValue | undefined): boolean {
  if (!hasAnswer(value)) return false;
  if (item.type === 'yes_no') return typeof value === 'boolean' && value === (item.problemIf === 'yes');
  return item.type === 'number' && typeof value === 'number' && ((item.min !== null && value < item.min) || (item.max !== null && value > item.max));
}
export const requiredAnswered = (template: Template | null, answers: FoodAnswer[]) => !template?.items.some(item => item.required && !hasAnswer(answers.find(a => a.itemId === item.id)?.value));
export function newFoodDraft(companyId: string, template: Template | null, id: string, now: string): FoodDraft { return { kind: 'food_service', clientReportId: id, companyId, startedAt: now, templateId: template?.id ?? null, templateVersion: template?.version ?? null, answers: [], note: '' }; }
export function reconcileTemplate(draft: FoodDraft, template: Template | null): FoodDraft { return { ...draft, templateId: template?.id ?? null, templateVersion: template?.version ?? null, answers: draft.answers.filter(a => template?.items.some(i => i.id === a.itemId)) }; }
export function foodPayload(draft: FoodDraft): FoodDraft {
  if (draft.kind !== 'food_service' || !/^[A-Za-z0-9-]{8,64}$/.test(draft.clientReportId) || typeof draft.companyId !== 'string' || !draft.companyId || !Number.isFinite(Date.parse(draft.startedAt)) || typeof draft.note !== 'string' || !Array.isArray(draft.answers) || draft.answers.length > 60) throw Error('Invalid visit details.');
  if (draft.answers.some(a => typeof a.itemId !== 'string' || !a.itemId || ![null, 'boolean', 'number', 'string'].includes(a.value === null ? null : typeof a.value) || typeof a.value === 'number' && !Number.isFinite(a.value)) || new Set(draft.answers.map(a => a.itemId)).size !== draft.answers.length) throw Error('Invalid checklist answers.');
  if (draft.note.length > 4000 || draft.answers.some(a => (a.note?.length || 0) > 500)) throw Error('The report exceeds its limit.');
  const photos = [draft.photo, ...draft.answers.map(a => a.photo)].filter((v): v is string => !!v);
  if (photos.length > 4 || photos.reduce((n, p) => n + p.length, 0) > 900000 || photos.some(p => p.length > 400000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p))) throw Error('Choose smaller photos. A report can contain up to 4 photos.');
  return { kind: 'food_service', clientReportId: draft.clientReportId, companyId: draft.companyId, startedAt: draft.startedAt, templateId: draft.templateId, templateVersion: draft.templateVersion, answers: draft.answers.map(({ itemId, value, note, photo }) => ({ itemId, value, ...(note !== undefined ? { note } : {}), ...(photo ? { photo } : {}) })), note: draft.note, ...(draft.photo ? { photo: draft.photo } : {}) };
}
export const foodDraftKey = (scope: string, id: string) => `${scope}:food-draft:${encodeURIComponent(id)}`;
export const saveFoodDraft = (storage: StorageLike, scope: string, draft: FoodDraft) => storage.setItem(foodDraftKey(scope, draft.companyId), JSON.stringify(draft));
export type InboxFilters = Partial<Record<'type' | 'status' | 'companyId' | 'mashgiachId' | 'from' | 'to' | 'amountCheck', string>>;
export function reportQuery(filters: InboxFilters, before?: string, more = false) { const query = new URLSearchParams({ limit: '50' }); for (const key of ['type', 'status', 'companyId', 'mashgiachId', 'from', 'to', 'amountCheck'] as const) if (filters[key]) query.set(key, filters[key]!); if (before) query.set('before', before); if (more) query.set('more', '1'); return query.toString(); }
export const statusLabel = (status?: string) => status === 'follow_up' ? 'Needs follow-up' : status === 'seen' ? 'Seen' : 'New';
