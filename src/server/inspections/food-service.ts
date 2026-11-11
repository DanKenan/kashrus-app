import { randomInt } from 'node:crypto';
import { normalizeSubmit, type Fee } from './model.ts';
export const invalid = (message: string): never => { throw Object.assign(Error(message), { status: 400 }); };
export const identifier = (prefix: string, length: number) => prefix + Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
export function strict(body: any, keys: string[], required = keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(body, k))) invalid('Invalid fields');
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid('Invalid text');
  return value as string;
}
export type ChecklistItem = { id: string; label: string; type: 'yes_no' | 'number' | 'text'; required: boolean; help: string; problemIf?: 'no' | 'yes'; min?: number | null; max?: number | null };
export type Template = { id: string; name: string; items: ChecklistItem[]; version: number; updatedAt: string };
export function validateTemplate(body: any, existing: Template[] = [], id?: string) {
  strict(body, ['name', 'items']);
  const name = text(body.name, 60, true);
  if (existing.some(t => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) invalid('Checklist name already exists');
  if (!Array.isArray(body.items) || body.items.length > 60) invalid('Invalid checklist items');
  const ids = new Set<string>();
  const items: ChecklistItem[] = body.items.map((item: any) => {
    strict(item, ['id', 'label', 'type', 'required', 'help', 'problemIf', 'min', 'max'], ['id', 'label', 'type', 'required']);
    if (typeof item.id !== 'string' || !/^i_[a-z0-9]{10}$/.test(item.id) || ids.has(item.id)) invalid('Invalid item id');
    ids.add(item.id);
    if (!['yes_no', 'number', 'text'].includes(item.type) || typeof item.required !== 'boolean') invalid('Invalid item type');
    const result: ChecklistItem = { id: item.id, label: text(item.label, 200, true), type: item.type, required: item.required, help: text(item.help === undefined ? '' : item.help, 300) };
    if (item.type === 'yes_no') {
      if (item.problemIf !== undefined && !['yes', 'no'].includes(item.problemIf)) invalid('Invalid problem answer');
      result.problemIf = item.problemIf ?? 'no';
    } else if (item.problemIf !== undefined) invalid('Invalid problem answer');
    if (item.type === 'number') {
      for (const k of ['min', 'max'] as const) {
        const v = item[k] ?? null;
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) invalid('Invalid number bounds');
        result[k] = v;
      }
      if (result.min !== null && result.max !== null && result.min! > result.max!) invalid('Invalid number bounds');
    } else if (item.min != null || item.max != null) invalid('Invalid number bounds');
    return result;
  });
  return { name, items };
}
export function failedItem(item: ChecklistItem, value: boolean | number | string | null) {
  if (value === null) return false;
  if (item.type === 'yes_no') return value === (item.problemIf === 'yes');
  return item.type === 'number' && typeof value === 'number' && ((item.min != null && value < item.min) || (item.max != null && value > item.max));
}
export const typeMatched = (company: { type?: string }, values: string[] = []) => values.some(v => v.trim().toLowerCase() === (company.type ?? '').trim().toLowerCase());
export function classifyPlace(company: { id: string; type?: string }, values: string[] = [], marked: string[] = [], manual: Record<string, unknown> = {}) {
  return Object.hasOwn(manual, company.id) || typeMatched(company, values) || marked.includes(company.id) ? 'food_service' as const : 'factory' as const;
}
export function buildFoodServiceReport(body: any, template: Template | null, context: { id: string; agencyId: string; userId: string; userName: string; companyName: string; now: string; fee: Fee }, maxPhotoChars: number, photoRe: RegExp) {
  strict(body, ['kind', 'clientReportId', 'companyId', 'startedAt', 'templateId', 'templateVersion', 'answers', 'note', 'photo'], ['kind', 'clientReportId', 'companyId', 'startedAt', 'templateId', 'templateVersion', 'answers']);
  if (body.kind !== 'food_service' || body.templateId !== (template?.id ?? null) || body.templateVersion !== (template?.version ?? null)) throw Object.assign(Error('This checklist changed. Check it and send again.'), { status: 409, template });
  if (!Array.isArray(body.answers) || body.answers.length > 60) invalid('Invalid answers');
  const answers = new Map<string, any>(), photos: Record<string, string> = {};
  for (const answer of body.answers) {
    strict(answer, ['itemId', 'value', 'note', 'photo'], ['itemId', 'value']);
    if (!template?.items.some(i => i.id === answer.itemId) || answers.has(answer.itemId)) invalid('Unknown itemId');
    answers.set(answer.itemId, answer);
  }
  // Reuse the P2 photo validator and its combined size/count limits.
  const photoInputs: any[] = [];
  const checklist = (template?.items ?? []).map(item => {
    const a = answers.get(item.id), value = a?.value ?? null;
    if (item.required && (value === null || (typeof value === 'string' && !value.trim()))) invalid('Answer every required item');
    if (value !== null && (item.type === 'yes_no' ? typeof value !== 'boolean' : item.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== 'string' || value.length > 4000)) invalid('Invalid answer type');
    if (a?.photo !== undefined) { photoInputs.push({ kind: 'ingredient', itemId: item.id, status: 'checked', photo: a.photo }); }
    return { itemId: item.id, label: item.label, type: item.type, required: item.required, help: item.help, problemIf: item.problemIf ?? null, min: item.min ?? null, max: item.max ?? null, value, note: text(a?.note === undefined ? '' : a.note, 500), failed: failedItem(item, value), hasPhoto: false };
  });
  if (body.photo !== undefined) photoInputs.push({ kind: 'ingredient', itemId: 'general', status: 'checked', photo: body.photo });
  const normalized = normalizeSubmit({ clientReportId: body.clientReportId, companyId: body.companyId, startedAt: body.startedAt, listVersion: '', marks: photoInputs, offList: [], note: body.note }, maxPhotoChars, photoRe);
  photoInputs.forEach((p, i) => { if (normalized.photos[`mark:${i}`]) photos[p.itemId === 'general' ? 'general' : `item:${p.itemId}`] = normalized.photos[`mark:${i}`]; });
  for (const item of checklist) item.hasPhoto = Object.hasOwn(photos, `item:${item.itemId}`);
  const counts = { checked: checklist.filter(i => i.value !== null && i.value !== '').length, not_used: 0, alert: checklist.filter(i => i.failed).length, offList: 0 };
  return { photos, report: { id: context.id, agencyId: context.agencyId, companyId: body.companyId as string, companyName: context.companyName, clientReportId: normalized.clientReportId, mashgiachId: context.userId, mashgiachName: context.userName, startedAt: normalized.startedAt, submittedAt: context.now, receivedAt: context.now, note: normalized.note, fee: context.fee, kind: 'food_service' as const, templateId: template?.id ?? null, templateName: template?.name ?? '', templateVersion: template?.version ?? null, checklist, counts, hasAlerts: counts.alert > 0, listChanged: false, photoCount: Object.keys(photos).length } };
}
