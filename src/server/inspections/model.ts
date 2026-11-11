import { classifyCheckInPhoto } from '../checkin-photos.ts';
export type Item = { id: string; name: string; brand: string; code: string; certificationRaw: string; statusRaw: string; agency: string; dpm: string; group1: boolean };
export type Fee = { amount: number; currency: string } | null;
export function normalizeSubmit(body: any, maxPhotoChars: number, photoRe: RegExp) {
  const text = (value: any, max: number, required = false): string => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error('Invalid text');
    return value;
  };
  if (!body || !/^[A-Za-z0-9-]{8,64}$/.test(body.clientReportId) || typeof body.clientReportId !== 'string') throw Error('Invalid clientReportId');
  const companyId = text(body.companyId, 200, true);
  if (typeof body.listVersion !== 'string') throw Error('Invalid listVersion');
  const listVersion = body.listVersion;
  const startedAt = text(body.startedAt, 64, true);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(startedAt) || !Number.isFinite(Date.parse(startedAt))) throw Error('Invalid startedAt');
  if (!Array.isArray(body.marks) || body.marks.length > 2000 || !Array.isArray(body.offList) || body.offList.length > 50) throw Error('Invalid items');
  const photos: Record<string, string> = {}, seen = new Set<string>();
  function photo(value: any, key: string) {
    const verdict = classifyCheckInPhoto(value, maxPhotoChars, photoRe);
    if (!['none', 'ok'].includes(verdict)) throw Error('Invalid photo');
    if (verdict === 'ok') photos[key] = value;
    if (Object.keys(photos).length > 4) throw Error('Too many photos');
    return verdict === 'ok';
  }
  const marks = body.marks.map((m: any, i: number) => {
    if (!m || !['ingredient', 'product'].includes(m.kind) || !['checked', 'not_used', 'alert'].includes(m.status)) throw Error('Invalid mark');
    const itemId = text(m.itemId, 200, true), key = JSON.stringify([m.kind, itemId]);
    if (seen.has(key)) throw Error('Duplicate mark'); seen.add(key);
    const note = text(m.note, 1000), hasPhoto = photo(m.photo, `mark:${i}`);
    if (m.status === 'alert' && !note.trim() && !hasPhoto) throw Error('Alert needs a note or photo');
    return { kind: m.kind as 'ingredient' | 'product', itemId, status: m.status as 'checked' | 'not_used' | 'alert', note, hasPhoto };
  });
  const offList = body.offList.map((o: any, i: number) => {
    if (!o) throw Error('Invalid off-list item');
    return { name: text(o.name, 200, true), brand: text(o.brand, 200), note: text(o.note, 1000), hasPhoto: photo(o.photo, `off:${i}`) };
  });
  return { clientReportId: body.clientReportId as string, companyId, listVersion, startedAt, note: text(body.note, 4000), marks, offList, photos };
}
export function buildReport(input: ReturnType<typeof normalizeSubmit>, context: { id: string; agencyId: string; userId: string; userName: string; companyName: string; listVersion: string; items(kind: 'ingredient' | 'product'): Item[]; now: string; fee: Fee }) {
  const { photos, ...body } = input;
  const items = { ingredient: new Map(context.items('ingredient').map(i => [i.id, i])), product: new Map(context.items('product').map(i => [i.id, i])) };
  const marks = input.marks.map(m => {
    const found = items[m.kind].get(m.itemId);
    if (!found) throw Error('Unknown item');
    const { name, brand, code, certificationRaw, statusRaw } = found;
    return { ...m, item: { name, brand, code, certificationRaw, statusRaw } };
  });
  const counts = { checked: 0, not_used: 0, alert: 0, offList: input.offList.length };
  for (const m of marks) counts[m.status]++;
  return { ...body, marks, id: context.id, agencyId: context.agencyId, mashgiachId: context.userId, mashgiachName: context.userName, companyName: context.companyName, submittedAt: context.now, receivedAt: context.now, listChanged: input.listVersion !== context.listVersion, counts, hasAlerts: counts.alert > 0 || counts.offList > 0, photoCount: Object.keys(photos).length, fee: context.fee };
}
export type Report = ReturnType<typeof buildReport>;
export function summary(r: Report) {
  const { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, startedAt, counts, hasAlerts, listChanged, photoCount } = r;
  return { id, companyId, companyName, mashgiachId, mashgiachName, submittedAt, startedAt, counts, hasAlerts, listChanged, photoCount };
}
