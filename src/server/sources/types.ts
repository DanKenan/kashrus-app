type ValueAssignment = { agency?: string; dpm?: 'dairy' | 'dairy_equipment' | 'pareve' | 'meat'; group1?: boolean };
export type Dpm = 'dairy' | 'dairy_equipment' | 'pareve' | 'meat';
export type SourceKind = 'airtable' | 'google_sheets' | 'excel' | 'supabase' | 'upload';
export interface Company {
  sourceKey?: string;
  archiveKey?: string;
  id: string; name: string; address?: string; companyFee?: number; mashgiachFee?: number; type?: string; brand?: string; plant?: string; extra: Record<string, string>;
}
export interface Ingredient {
  sourceKey?: string;
  id: string; companyIds: string[]; name: string; brand?: string; certifyingAgency?: string;
  dpm?: Dpm; group1: boolean; plant?: string; expiresOn?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; confidence?: number; extra: Record<string, string>;
}
export interface Product {
  sourceKey?: string;
  id: string; companyIds: string[]; name: string; brand?: string; code?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; certifyingAgency?: string; confidence?: number;
  dpm?: Dpm; group1?: boolean; symbolRequired?: boolean; plant?: string; extra: Record<string, string>;
}
export interface AirtableContactMapping {
  table: string; companyLink: string; name: string; phone?: string; email?: string; roles?: string; firstName?: string;
}
export interface AirtableContact {
  id: string; companyIds: string[]; name: string; phone: string; email: string; roles: string[]; source: 'airtable';
}
export interface SourceMapping {
  contacts?: AirtableContactMapping;
  editableCustomFields?: import('../../lib/sourcePreview.ts').EditableCustomFields;
  companies: { table: string; file?: SourceFile; pk?: string; address?: string; companyFee?: string; mashgiachFee?: string; name: string; type?: string; factoryValues?: string[]; foodServiceValues?: string[]; brand?: string; plant?: string };
  ingredients: { table: string; file?: SourceFile; pk?: string; companyLink?: string; name?: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { table: string; file?: SourceFile; pk?: string; companyLink?: string; name?: string; brand?: string; code?: string; certification?: string; agency?: string; status?: string; symbolRequired?: string; plant?: string };
  valueAssignments?: Record<string, Record<string, ValueAssignment>> | Partial<Record<'ingredient' | 'product', Record<string, Record<string, ValueAssignment>>>>;
  group1Values: string[];
}
export interface SourceData { companies: Company[]; otherCompanies?: Pick<Company, 'id' | 'name' | 'type' | 'sourceKey' | 'archiveKey'>[]; ingredients: Ingredient[]; products: Product[] }
export interface SourceFile { id: string; name: string }
export interface AirtableField { name: string; type: string; linkedTableId?: string; resultType?: string }
export interface SourceTable { name: string; columns: string[]; id?: string; fields?: AirtableField[] }
export type SourceSamples = Record<string, { id: string; fields: Record<string, string> }[]>;
export interface ConnectionResult { ok: boolean; access?: 'read' | 'readwrite'; tables?: SourceTable[]; error?: string }
export interface SourceConnector {
  kind: SourceKind;
  testConnection(): Promise<ConnectionResult>;
  listCompanies(): Promise<Company[]>;
  listItems(companyId: string, kind: 'ingredient' | 'product'): Promise<(Ingredient | Product)[]>;
  loadAll?(): Promise<SourceData>;
  readContacts?(mapping: AirtableContactMapping): Promise<AirtableContact[]>;
  samples?(tables: SourceTable[]): Promise<SourceSamples>;
  listTables?(): Promise<SourceTable[]>;
  readRows?(table: string, file?: SourceFile): Promise<SourceRow[]>;
  writeRow?(table: string, row: { id?: string; fields: Record<string, string> }, file?: SourceFile): Promise<SourceRow>;
  companyDeletion?(id: string): Promise<{
    present: boolean; blockers: string[]; remove?(): Promise<void>;
  }>;
  calls(): number;
}
export interface SourceRow { archiveKey?: string; rowNumber?: number; sourceKey?: string; id: string; fields: Record<string, unknown> }

export type Group1Overrides = { ingredient: Record<string, boolean>; product: Record<string, boolean> };
