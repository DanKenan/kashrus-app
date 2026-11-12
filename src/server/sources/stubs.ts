import { createAirtableConnector } from './airtable.ts';
import type { SourceConnector, SourceMapping } from './types.ts';

import { createGoogleSheetsConnector, type GoogleSheetsConfig } from './google-sheets.ts';
import { createExcelConnector, type ExcelConfig } from './excel.ts';
import { createSupabaseConnector, type SupabaseConfig } from './supabase.ts';
import { createUploadConnector, type UploadedFile } from './upload.ts';
export { createGoogleSheetsConnector, createExcelConnector, createSupabaseConnector };
export class NotAvailableYet extends Error { constructor() { super('Not available yet'); } }
export type SourceSettings =
 | {kind:'airtable';baseId:string;mapping:SourceMapping;apiBase?:string}
 | ({kind:'google_sheets'} & GoogleSheetsConfig)
 | ({kind:'excel'} & ExcelConfig)
 | ({kind:'supabase'} & SupabaseConfig)
 | {kind:'upload';mapping:SourceMapping;files:UploadedFile[]};
export function createConnector(settings:SourceSettings,apiKey:string):SourceConnector {
 if ((settings.kind==='google_sheets'||settings.kind==='excel') && !settings.token && !settings.accessToken || settings.kind==='supabase' && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(settings.url)) return {kind:settings.kind,calls:()=>0,async testConnection(){return {ok:false,error:'Not available yet'};},async loadAll(){throw new NotAvailableYet();},async listCompanies(){throw new NotAvailableYet();},async listItems(){throw new NotAvailableYet();}};
 switch(settings.kind){
 case 'airtable':return createAirtableConnector({...settings,apiKey});
 case 'google_sheets':return createGoogleSheetsConnector(settings);
 case 'excel':return createExcelConnector(settings);
 case 'supabase':return createSupabaseConnector({...settings,apiKey});
 case 'upload':return createUploadConnector(settings);
 }
}
