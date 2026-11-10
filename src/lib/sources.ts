import { apiFetch } from './api';

export interface SourceMapping {
  companies: { table: string; name: string; type?: string; factoryValues?: string[]; brand?: string; plant?: string };
  ingredients: { table: string; companyLink: string; name: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { table: string; companyLink: string; name: string; brand?: string; code?: string; status?: string; symbolRequired?: string; plant?: string };
  noSymbolValues: string[];
}

export interface SourceTable { name: string; columns: string[] }
export interface SourceConnection {
  sourceType: string | null; baseId?: string; access?: 'read' | 'readwrite'; mapping?: SourceMapping;
  hasKey?: boolean; keyHint?: string; status?: 'never' | 'ok' | 'stale' | 'backup' | 'error';
  refreshedAt?: string | null; calls?: number; backupTakenAt?: string | null; error?: string | null;
}
export const emptyMapping = (): SourceMapping => ({
  companies: { table: '', name: '' }, ingredients: { table: '', companyLink: '', name: '' },
  products: { table: '', companyLink: '', name: '' }, noSymbolValues: ['Group 1'],
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
  if (!connection.sourceType) return 'Not connected';
  if (connection.status === 'never') return 'Connected to Airtable · reading your database…';
  const day = (value: Date) => new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'short' }).format(value);
  const updatedToday = connection.refreshedAt && day(new Date(connection.refreshedAt)) === day(new Date());
  const date = (value: string, timeOnly = false) => new Intl.DateTimeFormat('en-US', {
    timeZone, ...(timeOnly ? { hour: 'numeric', minute: '2-digit' } as const : { dateStyle: 'medium', timeStyle: 'short' } as const),
  }).format(new Date(value));
  if (connection.error || connection.status === 'error' || connection.status === 'backup') {
    return `Couldn't reach Airtable: ${connection.error || 'Connection unavailable'}${connection.backupTakenAt ? ` · showing the copy saved ${date(connection.backupTakenAt)}` : ''}`;
  }
  return `Connected to Airtable${connection.refreshedAt ? ` · updated ${date(connection.refreshedAt, !!updatedToday)}` : ''} · ${connection.calls ?? 0} calls${connection.status === 'stale' ? ' · Out of date' : ''}`;
}
