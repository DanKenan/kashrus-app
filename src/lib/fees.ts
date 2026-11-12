import { apiFetch } from './api';
import { nextVisitDue, type Schedule } from './visitSchedule';
export type CompanyFee = { amount: number; per: 'visit' | 'month' | 'year' };
export interface FeePlace { id: string; name: string; kind: string; company: CompanyFee | null; mashgiach: { amount: number } | null; mashgiachNames: string[] }
export type AccountantTiming = { mode: 'after_report' } | { mode: 'dates'; days: (number | 'last')[] } | { mode: 'every_days'; everyDays: number };
export interface Accountant { name: string; email: string; timing: AccountantTiming }
export interface FeesData { settings: { feeEditors: 'admins' | 'admins_and_coordinators' }; canEdit: boolean; places: FeePlace[]; accountant?: Accountant | null; email?: { setUp: boolean }; nextEmail?: string | null }
export interface PayRow { key: string; name: string; visits: number; perVisit?: number | null; uniformFee?: number | null; breakdown?: { placeId: string; place: string; visits: number; fee: number | null; paid: number }[]; paid: number; companies: number; left: number }
export interface PayData { from: string; to: string; by: string; rows: PayRow[]; totals: Omit<PayRow, 'key' | 'name'>; mismatches: number; noFee: number }
export interface EmailPreview { to: string; subject: string; html: string; text: string; attachments: { filename: string; contentType: string; bytes: number }[] }
export interface FeeCheck { reportAmount: number; setAmount: number; paidAmount?: number | null; decided: { amount?: number; byName: string; at: string } | null }
export async function feesRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(path, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Couldn't save or load. Check the connection and try again.");
  return result;
}
export const getFees = () => feesRequest<FeesData>('/api/inspections/fees');
export const saveFees = (id: string, company: CompanyFee | null, mashgiach: { amount: number } | null) => feesRequest(`/api/inspections/fees/${encodeURIComponent(id)}`, 'PUT', { company, mashgiach });
export const decideFee = (id: string, amount?: number) => feesRequest(`/api/inspections/reports/${encodeURIComponent(id)}/fee-decision`, 'POST', amount === undefined ? {} : { amount });
export const canSeeFees = (role: string) => role === 'admin' || role === 'coordinator';
export const canSeePay = (role: string) => role === 'admin';
export const canChangeFees = (role: string, editors: FeesData['settings']['feeEditors']) => role === 'admin' || role === 'coordinator' && editors === 'admins_and_coordinators';
export const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(amount);
export function amountValue(value: string): number | null { if (!value.trim()) return null; const n = Number(value); if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isFinite(n) || n > 100000) throw Error('Enter an amount from 0 to 100,000 with up to two decimals.'); return n; }
export function monthRange(which: 'this' | 'last', timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find(p => p.type === 'year')!.value), month = Number(parts.find(p => p.type === 'month')!.value) - 1 - (which === 'last' ? 1 : 0);
  return { from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10) };
}
export function yearlyVisits(schedule: Schedule | null | undefined, year: string): number | null {
  if (!schedule || !/^\d{4}$/.test(year)) return null;
  const start = `${year}-01-01`, end = `${year}-12-31`;
  const cursor = new Date(`${start}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() - 1);
  let previous = cursor.toISOString().slice(0, 10), count = 0;
  for (let i = 0; i < 367; i++) {
    const date = nextVisitDue(schedule, 'planned', previous);
    if (!date || date > end) return count;
    if (date <= previous) return null;
    if (date >= start) count++;
    previous = date;
  }
  return null;
}
export function leftLine(company: CompanyFee | null, mashgiach: { amount: number } | null, count: number | null) {
  if (!company || !mashgiach) return null;
  if (company.per === 'visit') return `Left for the agency: ${money(company.amount - mashgiach.amount)} a visit`;
  if (count === null) return null;
  const total = company.amount * (company.per === 'month' ? 12 : 1), paid = mashgiach.amount * count;
  return `If there ${count === 1 ? 'is' : 'are'} ${count} ${count === 1 ? 'visit' : 'visits'} this year: ${money(total)} − ${money(paid)} = ${money(total - paid)} left`;
}
export const payQuery = (from: string, to: string, by: string) => new URLSearchParams({ from, to, by }).toString();
export async function downloadPay(from: string, to: string, by: string, format: 'csv' | 'xlsx') {
  const response = await apiFetch(`/api/inspections/pay/export?${payQuery(from, to, by)}&format=${format}`);
  if (!response.ok) throw Error('Could not download the pay table. Try again.');
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1] || `pay-${from}-${to}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const sendAccountant = (kind: 'test' | 'now', range?: { from: string; to: string }) => feesRequest<{ sent: boolean; reason?: string }>('/api/inspections/accountant/send', 'POST', { kind, ...range });
export const sendMessage = (result: { sent: boolean; reason?: string }) => result.sent ? 'Email sent.' : result.reason === 'no_visits' ? 'No email sent: no visits in this period.' : result.reason === 'no_accountant' ? 'No email sent: add the agency’s accountant first.' : 'Email not set up yet — nothing was sent.';

export const saveFeeSettings = (feeEditors: FeesData['settings']['feeEditors']) => feesRequest('/api/inspections/fee-settings', 'PUT', { feeEditors });
export const saveAccountant = (accountant: Accountant | null) => feesRequest('/api/inspections/accountant', 'PUT', accountant);
export const getPay = (from: string, to: string, by: string) => feesRequest<PayData>(`/api/inspections/pay?${payQuery(from, to, by)}`);
export const previewAccountant = (from: string, to: string) => feesRequest<EmailPreview>(`/api/inspections/accountant/preview?${new URLSearchParams({ from, to })}`);
export function toggleSendDay(days: (number | 'last')[], day: number | 'last'): (number | 'last')[] {
  return days.includes(day) ? days.filter(d => d !== day) : days.length < 3 ? [...days, day] : days;
}

export const accountantTiming = (mode: AccountantTiming['mode'], days: (number | 'last')[], everyDays: number): AccountantTiming => mode === 'dates' ? { mode, days } : mode === 'every_days' ? { mode, everyDays } : { mode };
export const visitsLabel = (count: number) => `${count} ${count === 1 ? 'visit' : 'visits'}`;
export const readableEmailDate = (day: string | null | undefined) => day
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
  : 'Not scheduled';
