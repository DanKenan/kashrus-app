import { apiFetch } from './api';
import { sourceRequest, emptyMapping, type SourceConnection, type SourceMapping, type SourceTable } from './sources';
export type Provider = 'airtable' | 'google_sheets' | 'excel' | 'supabase' | 'upload';
export type Access = 'read' | 'readwrite';
export interface SourceFile { id: string; name: string; path?: string }
export type Samples = Record<string, { id: string; fields: Record<string, string> }[]>;
export interface TabData { tables: SourceTable[]; samples: Samples; byFile?: Record<string, { tables: SourceTable[]; samples: Samples }> }
export const providers: { id: Provider; name: string; description: string }[] = [
  { id: 'airtable', name: 'Airtable', description: 'Use your existing Airtable base.' },
  { id: 'google_sheets', name: 'Google Sheets', description: 'Connect a Google spreadsheet.' },
  { id: 'excel', name: 'Excel', description: 'Use Excel from OneDrive or SharePoint.' },
  { id: 'supabase', name: 'Supabase', description: 'Use tables from your Supabase project.' },
  { id: 'upload', name: 'Upload a file', description: 'One-time copy from a CSV or Excel file.' },
];
export function providerNote(provider: Provider, setUp: boolean) { return !setUp && ['google_sheets', 'excel'].includes(provider) ? `Not set up yet — the app's ${provider === 'excel' ? 'Microsoft' : 'Google'} sign-in is not turned on. Shutfey's team needs to set it up first.` : ''; }
export function tileState(provider: Provider, selected: Provider | null, setUp: boolean) { return { selected: provider === selected, disabled: !setUp, note: providerNote(provider, setUp) }; }
export function canEdit(role: string, connection: SourceConnection | null) { return role === 'admin' && connection?.canWrite === true && connection.access === 'readwrite' && ['google_sheets', 'excel', 'supabase'].includes(connection.sourceType || ''); }
export function mappingBadge(guessed: boolean) { return guessed ? 'Guessed' : 'Check'; }
export function assignChip(mapping: SourceMapping, value: string, target: 'factoryValues' | 'foodServiceValues'): SourceMapping {
  const other = target === 'factoryValues' ? 'foodServiceValues' : 'factoryValues';
  return { ...mapping, companies: { ...mapping.companies, [target]: [...new Set([...(mapping.companies[target] || []), value])], [other]: (mapping.companies[other] || []).filter(v => v !== value) } };
}
export function money(value: unknown) { if (value === '' || value == null) return ''; const amount = Number(String(value).replace(/[$,]/g, '')); return Number.isFinite(amount) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount) : ''; }
export function previewRows(samples: Samples, mapping: SourceMapping) { const m = mapping.companies; return (samples[m.table] || []).slice(0, 3).map(({ fields }) => [fields[m.name] || '', fields[m.address || ''] || '', (m.foodServiceValues || []).includes(fields[m.type || '']) ? 'Food service' : (m.factoryValues || []).includes(fields[m.type || '']) ? 'Factory visits' : fields[m.type || ''] || '', money(fields[m.companyFee || '']), money(fields[m.mashgiachFee || ''])]); }
export function lastReadText(at: string | null | undefined, timeZone: string, now = new Date()) { if (!at) return 'Last read: Not read yet'; const date = new Date(at); if (!Number.isFinite(date.getTime())) return 'Last read: Not read yet'; const day = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'short' }).format(d); return `Last read: ${day(date) === day(now) ? 'today' : new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium' }).format(date)}, ${new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date)}`; }
export function countsText(counts: SourceConnection['counts']) { return counts ? `${counts.companies.toLocaleString('en-US')} companies · ${counts.ingredients.toLocaleString('en-US')} ingredients` : ''; }
export function guessMapping(tables: SourceTable[]) { const mapping = emptyMapping(); const guessed: string[] = []; for (const list of ['companies', 'ingredients', 'products'] as const) { const table = tables.find(t => t.name.toLowerCase() === list) || (list === 'companies' ? tables[0] : undefined); if (!table) continue; mapping[list].table = table.name; const aliases: Record<string, string[]> = { name: ['name', 'company name', 'company', list.slice(0, -1) + ' name'], address: ['address'], type: ['type'], brand: ['brand'], plant: ['plant', 'location'], companyFee: ['company pays', 'company fee', 'yearly fee'], mashgiachFee: ['supervision fee', 'mashgiach fee'], companyLink: ['company', 'company name'] }; for (const [field, names] of Object.entries(aliases)) { if (list !== 'companies' && !['name', 'companyLink'].includes(field)) continue; const column = table.columns.find(c => names.includes(c.toLowerCase())); if (column) { Object.assign(mapping[list], { [field]: column }); guessed.push(`${list}.${field}`); } } } return { mapping, guessed }; }
export function matchingReady(m: SourceMapping) { return !!m.companies.table && !!m.companies.name && [m.ingredients, m.products].every(list => !list.table || !!list.name && !!list.companyLink); }
export const getConnection = () => sourceRequest('/api/sources/connection');
export const getProviders = () => sourceRequest('/api/sources/providers');
export const getAccount = (provider: Provider) => sourceRequest(`/api/sources/oauth/${provider}/account`);
export const getFiles = (provider: Provider) => sourceRequest(`/api/sources/files?provider=${provider}`);
export const getTabs = (provider: Provider, fileId = ''): Promise<TabData> => sourceRequest(`/api/sources/tabs?provider=${provider}&fileId=${encodeURIComponent(fileId)}`);
export const startSignIn = (provider: Provider, access: Access) => sourceRequest(`/api/sources/oauth/${provider}/start`, 'POST', { access });
export const createFile = (provider: Provider) => sourceRequest('/api/sources/create-file', 'POST', { provider });
export const testSupabase = (url: string, apiKey: string) => sourceRequest('/api/sources/supabase/test', 'POST', { url, apiKey });
export const saveConnection = (body: { sourceType: Provider; baseId: string; access: Access; mapping: SourceMapping; apiKey?: string }) => sourceRequest('/api/sources/connection', 'PUT', body);
export const changeAccess = (access: Access) => sourceRequest('/api/sources/access', 'PUT', { access });
export const disconnect = () => sourceRequest('/api/sources/connection', 'DELETE');
export const readAgain = () => sourceRequest('/api/sources/refresh', 'POST');
export const resetUpload = () => sourceRequest('/api/sources/upload/reset', 'POST');
export const saveCompany = (fields: { name: string; address: string; type: string }, id?: string) => sourceRequest(`/api/sources/rows/companies${id ? `/${encodeURIComponent(id)}` : ''}`, id ? 'PATCH' : 'POST', { fields });
export async function uploadFile(file: File) { const response = await apiFetch(`/api/sources/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file }); const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error); return data as TabData & { fileName: string; rows: number }; }
// Picker is loaded only in response to a signed-in account's explicit action.
export async function pickGoogleFile(onPick: (file: SourceFile) => void) {
  const { accessToken, appId } = await sourceRequest('/api/sources/oauth/google_sheets/picker-token', 'POST');
  const browser = window as unknown as { gapi: { load: (name: string, options: { callback: () => void; onerror: () => void }) => void }; google: { picker: any } };
  if (!browser.gapi) await new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://apis.google.com/js/api.js'; script.onload = () => resolve(); script.onerror = () => reject(new Error("Couldn't load Google Drive. Try again.")); document.head.appendChild(script); });
  await new Promise<void>((resolve, reject) => browser.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error("Couldn't load Google Drive. Try again.")) }));
  const picker = browser.google.picker; const builder = new picker.PickerBuilder().addView(new picker.DocsView().setMimeTypes('application/vnd.google-apps.spreadsheet')).setOAuthToken(accessToken).setCallback((data: any) => { if (data.action === picker.Action.PICKED) onPick({ id: data.docs[0].id, name: data.docs[0].name }); }); if (appId) builder.setAppId(appId); builder.build().setVisible(true);
}
