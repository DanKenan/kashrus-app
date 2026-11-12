import { addDays, calendarDate, daysBetween } from './schedule.ts';
import type { FeesDoc, PayTable, Timing } from './fees.ts';
import { csv, xlsx, xml, exportRows, csvType, xlsxType } from './export.ts';
import type { Message } from './email.ts';
const monthStart = (date: string) => date.slice(0, 7) + '-01';
export function afterReportDelayMs(last: FeesDoc['lastSent'], newestSubmittedAt: string | undefined, now: Date): number | null {
  if (!last || !newestSubmittedAt || newestSubmittedAt <= last.at) return null;
  const remaining = Date.parse(last.at) + 600_000 - now.getTime();
  return remaining > 0 ? remaining : null;
}
export function accountantPeriod(timing: Timing, last: FeesDoc['lastSent'], now: Date, zone: string, newestSubmittedAt?: string): { from: string; to: string } | null {
  const today = calendarDate(now.toISOString(), zone), yesterday = addDays(today, -1);
  if (timing.mode === 'after_report') {
    if (!newestSubmittedAt || (last && (newestSubmittedAt <= last.at || now.getTime() - Date.parse(last.at) < 600000))) return null;
    const reportDay = calendarDate(newestSubmittedAt, zone);
    // A deferred report arriving before midnight still belongs to that month's summary.
    return { from: monthStart(reportDay), to: reportDay };
  }
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (last && last.periodEnd >= yesterday) return null;
  if (timing.mode === 'dates') {
    if (hour < 7) return null;
    const day = Number(today.slice(8));
    if (!timing.days.some(d => d === 'last' ? day === 1 : d === day)) return null;
    return { from: last ? addDays(last.periodEnd, 1) : monthStart(addDays(monthStart(today), -1)), to: yesterday };
  }
  if (last && daysBetween(last.periodEnd, today) < timing.everyDays + 1) return null;
  return { from: last ? addDays(last.periodEnd, 1) : addDays(today, -timing.everyDays), to: yesterday };
}
export function nextAccountantDate(timing: Timing | undefined, last: FeesDoc['lastSent'], now: Date, zone: string): string | null {
  if (!timing || timing.mode === 'after_report') return null;
  const today = calendarDate(now.toISOString(), zone);
  for (let i = 0; i < 400; i++) {
    const date = addDays(today, i);
    if (timing.mode === 'every_days') { if (!last || daysBetween(last.periodEnd, date) >= timing.everyDays + 1) return date; }
    else if ((!last || last.periodEnd < addDays(date, -1)) && timing.days.some(d => d === 'last' ? date.endsWith('-01') : Number(date.slice(8)) === d)) return date;
  }
  return null;
}
export function buildAccountantMessage(agency: string, to: string, table: PayTable): Message {
  const fullMonth = table.from.endsWith('-01') && addDays(table.to, 1).endsWith('-01') && table.from.slice(0, 7) === table.to.slice(0, 7);
  const label = fullMonth ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(table.from + 'T12:00:00Z')) : `${table.from} to ${table.to}`;
  const subject = `${agency} pay summary – ${label}`, note = `Amounts are the fees set by ${agency}'s admin.`, footer = "This summary is sent automatically. The agency's admin can change when it is sent. No email is sent in a period with no visits.";
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const rows = exportRows(table).map((row, i) => row.map((v, j) => i && j > 1 && typeof v === 'number' ? money.format(v) : v)), mismatch = `Open mismatches: ${table.mismatches}`;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:16px"><h1>${xml(subject)}</h1><p>${table.totals.visits} ${table.totals.visits === 1 ? 'visit' : 'visits'}</p><p>${xml(note)}</p><table style="border-collapse:collapse">${rows.map((r, i) => `<tr>${r.map(v => `<${i ? 'td' : 'th'} style="padding:8px;border:1px solid currentColor">${xml(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table><p>${mismatch}</p><p>${xml(footer)}</p></body></html>`;
  const visitCount = `${table.totals.visits} ${table.totals.visits === 1 ? 'visit' : 'visits'}`;
  const text = [subject, visitCount, note, ...rows.map(r => r.join('\t')), mismatch, footer].join('\n');
  const filename = `pay-${table.from}-${table.to}`;
  return { to, subject, html, text, attachments: [{ filename: filename + '.xlsx', contentType: xlsxType, contentBase64: xlsx(table).toString('base64') }, { filename: filename + '.csv', contentType: csvType, contentBase64: csv(table).toString('base64') }] };
}
