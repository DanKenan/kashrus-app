import { calendarDate, isDate, daysBetween, addDays } from './schedule.ts';
export type PlaceFees = { company: { amount: number; per: 'visit' | 'month' | 'year' } | null; mashgiach: { amount: number } | null; updatedAt: string; updatedBy: string };
export type Timing = { mode: 'after_report'; days?: never; everyDays?: never } | { mode: 'dates'; days: (number | 'last')[]; everyDays?: never } | { mode: 'every_days'; everyDays: number; days?: never };
export type Accountant = { name: string; email: string; timing: Timing };
export type Decision = { amount: number; by: string; byName: string; at: string };
export type FeesDoc = { settings: { feeEditors: 'admins' | 'admins_and_coordinators' }; places: Record<string, PlaceFees>; accountant: Accountant | null; lastSent: { at: string; periodEnd: string } | null; decisions: Record<string, Decision>; updatedAt: string };
export const bad = (message = 'Invalid fee data'): never => { throw Object.assign(Error(message), { status: 400 }); };
export function shape(value: any, keys: string[], required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) bad();
}
export function amount(value: any): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000 || Number(value.toFixed(2)) !== value) bad('Invalid amount');
  return value;
}
export function bounded(value: any, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) bad('Invalid text');
  return value;
}
export function validEmail(value: string): boolean {
  const parts = value.split('@'); if (parts.length !== 2) return false;
  const [local, domain] = parts, labels = domain.split('.');
  return local.length <= 64 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && labels.length >= 2 && labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
export function validateFees(v: any): Pick<PlaceFees, 'company' | 'mashgiach'> {
  shape(v, ['company', 'mashgiach']);
  if (v.company !== null) { shape(v.company, ['amount', 'per']); amount(v.company.amount); if (!['visit', 'month', 'year'].includes(v.company.per)) bad(); }
  if (v.mashgiach !== null) { shape(v.mashgiach, ['amount']); amount(v.mashgiach.amount); }
  return { company: v.company === null ? null : { amount: v.company.amount, per: v.company.per }, mashgiach: v.mashgiach === null ? null : { amount: v.mashgiach.amount } };
}
export function validateSettings(v: any): FeesDoc['settings'] {
  shape(v, ['feeEditors']); if (!['admins', 'admins_and_coordinators'].includes(v.feeEditors)) bad(); return { feeEditors: v.feeEditors };
}
export function validateAccountant(v: any): Accountant | null {
  if (v === null) return null;
  shape(v, ['name', 'email', 'timing']); const name = bounded(v.name, 80), email = bounded(v.email, 200, true);
  if (!validEmail(email)) bad('Invalid email');
  const t = v.timing;
  if (!t || !['after_report', 'dates', 'every_days'].includes(t.mode)) bad('Invalid timing');
  shape(t, ['mode', 'days', 'everyDays'], ['mode']);
  if (t.days !== undefined && (!Array.isArray(t.days) || t.days.length < 1 || t.days.length > 3 || new Set(t.days).size !== t.days.length || !t.days.every((d: any) => d === 'last' || Number.isInteger(d) && d >= 1 && d <= 28))) bad('Invalid days');
  if (t.everyDays !== undefined && (!Number.isInteger(t.everyDays) || t.everyDays < 1 || t.everyDays > 90)) bad('Invalid interval');
  if (t.mode === 'dates' && !t.days || t.mode === 'every_days' && t.everyDays === undefined) bad('Invalid timing');
  const timing: Timing = t.mode === 'dates' ? { mode: t.mode, days: [...t.days] } : t.mode === 'every_days' ? { mode: t.mode, everyDays: t.everyDays } : { mode: t.mode };
  return { name, email, timing };
}
export type PayReport = { id: string; companyId: string; companyName: string; mashgiachId: string; mashgiachName: string; submittedAt: string; fee?: { amount: number } | null; dataFee?: { amount: number } | null; feeMismatch?: boolean };
export type PayRow = { key: string; name: string; visits: number; perVisit?: number | null; paid: number; companies: number; left: number };
export type PayTable = { from: string; to: string; by: 'mashgiach' | 'place'; rows: PayRow[]; totals: { visits: number; paid: number; companies: number; left: number }; mismatches: number; noFee: number };
export function range(from: any, to: any, by: any = 'place'): { from: string; to: string; by: 'place' | 'mashgiach' } {
  if (!isDate(from) || !isDate(to) || from > to || !['place', 'mashgiach'].includes(by)) bad('Invalid pay range');
  return { from, to, by };
}
export const cents = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export function monthsCovered(from: string, to: string): number {
  let cursor = from, total = 0;
  while (cursor <= to) {
    const d = new Date(cursor + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 0);
    const end = d.toISOString().slice(0, 10), stop = end < to ? end : to;
    total += (daysBetween(cursor, stop) + 1) / d.getUTCDate(); if (stop === to) break; cursor = addDays(end, 1);
  }
  return total;
}
export function computePay(reports: PayReport[], fees: FeesDoc, places: { id: string; name: string }[], from: string, to: string, by: 'place' | 'mashgiach', zone: string): PayTable {
  range(from, to, by);
  const selected = reports.filter(r => { const day = calendarDate(r.submittedAt, zone); return day >= from && day <= to; });
  const rows = new Map<string, PayRow>(), byPlace = new Map<string, PayReport[]>();
  const get = (key: string, name: string) => { if (!rows.has(key)) rows.set(key, { key, name, visits: 0, paid: 0, companies: 0, left: 0 }); return rows.get(key)!; };
  const all = new Map(places.map(p => [p.id, p.name])); for (const r of selected) if (!all.has(r.companyId)) all.set(r.companyId, r.companyName);
  let noFee = 0, mismatches = 0;
  for (const r of selected) {
    if (!byPlace.has(r.companyId)) byPlace.set(r.companyId, []); byPlace.get(r.companyId)!.push(r);
    const row = get(by === 'place' ? r.companyId : r.mashgiachId, by === 'place' ? all.get(r.companyId)! : r.mashgiachName);
    row.visits++; row.paid += fees.decisions[r.id]?.amount ?? r.fee?.amount ?? 0;
    if (!r.fee && !fees.decisions[r.id]) noFee++;
    if (r.feeMismatch && !fees.decisions[r.id]) mismatches++;
  }
  const months = monthsCovered(from, to);
  for (const [id, name] of all) {
    const fee = Object.hasOwn(fees.places, id) ? fees.places[id] : undefined, company = fee?.company;
    const visits = byPlace.get(id) ?? [], n = visits.length;
    if (!n && (!company || company.per === 'visit')) continue;
    const revenue = !company ? 0 : company.per === 'visit' ? n * company.amount : company.amount * months / (company.per === 'year' ? 12 : 1);
    if (by === 'place') { const row = get(id, name); row.companies += revenue; row.perVisit = fee?.mashgiach?.amount ?? visits[0]?.fee?.amount ?? null; }
    else if (!n) get('__no_visits__', 'No visits in this period').companies += revenue;
    else for (const r of visits) get(r.mashgiachId, r.mashgiachName).companies += revenue / n;
  }
  const values = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totals = { visits: selected.length, paid: cents(values.reduce((s, r) => s + r.paid, 0)), companies: cents(values.reduce((s, r) => s + r.companies, 0)), left: 0 };
  totals.left = cents(totals.companies - totals.paid);
  for (const row of values) { row.paid = cents(row.paid); row.companies = cents(row.companies); row.left = cents(row.companies - row.paid); }
  return { from, to, by, rows: values, totals, mismatches, noFee };
}
