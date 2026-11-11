import { createAirtableConnector } from './airtable.ts';
import type { SourceConnector, SourceMapping } from './types.ts';

export class NotAvailableYet extends Error {
  constructor() { super('Not available yet'); this.name = 'NotAvailableYet'; }
}
export interface GoogleSheetsConfig { spreadsheetId: string; mapping: SourceMapping }
export interface ExcelConfig { workbookId: string; mapping: SourceMapping }
export interface SupabaseConfig { url: string; mapping: SourceMapping }
function stub(kind: SourceConnector['kind']): SourceConnector {
  return { kind, calls: () => 0,
    async testConnection() { return { ok: false, error: 'Not available yet' }; },
    async listCompanies() { throw new NotAvailableYet(); },
    async listItems() { throw new NotAvailableYet(); },
    async loadAll() { throw new NotAvailableYet(); },
  };
}
export const createGoogleSheetsConnector = (_config: GoogleSheetsConfig): SourceConnector => stub('google_sheets');
export const createExcelConnector = (_config: ExcelConfig): SourceConnector => stub('excel');
export const createSupabaseConnector = (_config: SupabaseConfig): SourceConnector => stub('supabase');
export type SourceSettings =
  | { kind: 'airtable'; baseId: string; mapping: SourceMapping }
  | ({ kind: 'google_sheets' } & GoogleSheetsConfig)
  | ({ kind: 'excel' } & ExcelConfig)
  | ({ kind: 'supabase' } & SupabaseConfig);
export function createConnector(settings: SourceSettings, apiKey: string): SourceConnector {
  switch (settings.kind) {
    case 'airtable': return createAirtableConnector({ ...settings, apiKey });
    case 'google_sheets': return createGoogleSheetsConnector(settings);
    case 'excel': return createExcelConnector(settings);
    case 'supabase': return createSupabaseConnector(settings);
    default: throw new NotAvailableYet();
  }
}
