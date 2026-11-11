export type Dpm = 'dairy' | 'pareve' | 'meat';
export type SourceKind = 'airtable' | 'google_sheets' | 'excel' | 'supabase';
export interface Company {
  id: string; name: string; type?: string; brand?: string; plant?: string; extra: Record<string, string>;
}
export interface Ingredient {
  id: string; companyIds: string[]; name: string; brand?: string; certifyingAgency?: string;
  dpm?: Dpm; group1: boolean; plant?: string; expiresOn?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; confidence?: number; extra: Record<string, string>;
}
export interface Product {
  id: string; companyIds: string[]; name: string; brand?: string; code?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; certifyingAgency?: string; confidence?: number;
  dpm?: Dpm; group1?: boolean; symbolRequired?: boolean; plant?: string; extra: Record<string, string>;
}
export interface SourceMapping {
  companies: { table: string; name: string; type?: string; factoryValues?: string[]; brand?: string; plant?: string };
  ingredients: { table: string; companyLink: string; name: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { table: string; companyLink: string; name: string; brand?: string; code?: string; certification?: string; agency?: string; status?: string; symbolRequired?: string; plant?: string };
  valueAssignments?: Record<string, Record<string, { agency?: string; dpm?: 'dairy' | 'pareve' | 'meat'; group1?: boolean }>>;
  group1Values: string[];
}
export interface SourceData { companies: Company[]; ingredients: Ingredient[]; products: Product[] }
export interface SourceTable { name: string; columns: string[] }
export type SourceSamples = Record<string, { id: string; fields: Record<string, string> }[]>;
export interface ConnectionResult { ok: boolean; access?: 'read' | 'readwrite'; tables?: SourceTable[]; error?: string }
export interface SourceConnector {
  kind: SourceKind;
  testConnection(): Promise<ConnectionResult>;
  listCompanies(): Promise<Company[]>;
  listItems(companyId: string, kind: 'ingredient' | 'product'): Promise<(Ingredient | Product)[]>;
  loadAll?(): Promise<SourceData>;
  samples?(tables: SourceTable[]): Promise<SourceSamples>;
  calls(): number;
}
export interface SourceRow { id: string; fields: Record<string, unknown> }

export type Group1Overrides = { ingredient: Record<string, boolean>; product: Record<string, boolean> };
