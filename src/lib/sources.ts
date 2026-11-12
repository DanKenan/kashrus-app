type ValueAssignment = { agency?: string; dpm?: 'dairy' | 'dairy_equipment' | 'pareve' | 'meat'; group1?: boolean };
import { apiFetch } from './api';

export interface SourceMapping {
  companies: { file?: { id: string; name: string }; address?: string; companyFee?: string; mashgiachFee?: string; table: string; name: string; type?: string; factoryValues?: string[]; foodServiceValues?: string[]; brand?: string; plant?: string };
  ingredients: { file?: { id: string; name: string }; table: string; companyLink: string; name: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { file?: { id: string; name: string }; table: string; companyLink: string; name: string; brand?: string; code?: string; certification?: string; agency?: string; status?: string; symbolRequired?: string; plant?: string };
  valueAssignments?: Record<string, Record<string, ValueAssignment>> | Partial<Record<'ingredient' | 'product', Record<string, Record<string, ValueAssignment>>>>;
  group1Values: string[];
}

export interface SourceTable { name: string; columns: string[] }
export interface SourceConnection {
  group1Label?: string; sourceType: string | null; baseId?: string; access?: 'read' | 'readwrite'; mapping?: SourceMapping;
  hasKey?: boolean; keyHint?: string; status?: 'never' | 'ok' | 'stale' | 'backup' | 'error';
  fileName?: string; accountEmail?: string; canWrite?: boolean; counts?: { companies: number; ingredients: number; products: number };
  upload?: { fileNames: string[]; copiedAt: string; rows: number };
  backupSaveError?: boolean;
  refreshedAt?: string | null; calls?: number; backupTakenAt?: string | null; error?: string | null;
}
export const emptyMapping = (): SourceMapping => ({
  companies: { table: '', name: '' }, ingredients: { table: '', companyLink: '', name: '' },
  products: { table: '', companyLink: '', name: '' }, group1Values: ['Group 1'],
});
export function mappingReady(mapping: SourceMapping): boolean {
  return [mapping.companies, mapping.ingredients, mapping.products].every(g => !!g.table && !!g.name)
    && !!mapping.ingredients.companyLink && !!mapping.products.companyLink;
}
export async function sourceRequest(path: string, method?: string, body?: unknown) {
  const response = await apiFetch(path, method ? { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } : undefined);
  const data = await response.json();
  if (!response.ok || data?.error) throw new Error(data?.error || "Couldn't reach the database. Try again.");
  return data;
}
export function sourceStatus(connection: SourceConnection, timeZone: string): string {
  const backup = connection.backupSaveError ? ' · backup copy not saved yet' : '';
  const source = ({ airtable: 'Airtable', google_sheets: 'Google Sheets', excel: 'Excel', supabase: 'Supabase' } as Record<string, string>)[connection.sourceType] || 'database';
  if (!connection.sourceType) return `Not connected${backup}`;
  if (connection.status === 'never') return `Connected to ${source} · reading your database…${backup}`;
  const day = (value: Date) => new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'short' }).format(value);
  const updatedToday = connection.refreshedAt && day(new Date(connection.refreshedAt)) === day(new Date());
  const date = (value: string, timeOnly = false) => new Intl.DateTimeFormat('en-US', {
    timeZone, ...(timeOnly ? { hour: 'numeric', minute: '2-digit' } as const : { dateStyle: 'medium', timeStyle: 'short' } as const),
  }).format(new Date(value));
  if (connection.error || connection.status === 'error' || connection.status === 'backup') {
    return `Couldn't reach ${source}: ${connection.error || 'Connection unavailable'}${connection.backupTakenAt ? ` · showing the copy saved ${date(connection.backupTakenAt)}` : ''}${backup}`;
  }
  return `Connected to ${source}${connection.refreshedAt ? ` · updated ${date(connection.refreshedAt, !!updatedToday)}` : ''} · ${connection.calls ?? 0} calls${connection.status === 'stale' ? ' · Out of date' : ''}${backup}`;
}
