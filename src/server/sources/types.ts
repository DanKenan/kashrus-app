export type Dpm = 'dairy' | 'pareve' | 'meat';
export type SourceKind = 'airtable' | 'google_sheets' | 'excel' | 'supabase';
export interface Company {
  id: string; name: string; type?: string; brand?: string; plant?: string; extra: Record<string, string>;
}
export interface Ingredient {
  id: string; companyIds: string[]; name: string; brand?: string; certifyingAgency?: string;
  dpm?: Dpm; noSymbolNeeded: boolean; plant?: string; expiresOn?: string;
  certificationRaw?: string; extra: Record<string, string>;
}
export interface Product {
  id: string; companyIds: string[]; name: string; brand?: string; code?: string;
  dpm?: Dpm; symbolRequired?: boolean; plant?: string; extra: Record<string, string>;
}
export interface SourceMapping {
  companies: { table: string; name: string; type?: string; factoryValues?: string[]; brand?: string; plant?: string };
  ingredients: { table: string; companyLink: string; name: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { table: string; companyLink: string; name: string; brand?: string; code?: string; status?: string; symbolRequired?: string; plant?: string };
  noSymbolValues: string[];
}
export interface SourceData { companies: Company[]; ingredients: Ingredient[]; products: Product[] }
export interface SourceTable { name: string; columns: string[] }
export interface ConnectionResult { ok: boolean; access?: 'read' | 'readwrite'; tables?: SourceTable[]; error?: string }
export interface SourceConnector {
  kind: SourceKind;
  testConnection(): Promise<ConnectionResult>;
  listCompanies(): Promise<Company[]>;
  listItems(companyId: string, kind: 'ingredient' | 'product'): Promise<(Ingredient | Product)[]>;
  loadAll?(): Promise<SourceData>;
  calls(): number;
}
export interface SourceRow { id: string; fields: Record<string, unknown> }
