type ValueAssignment = { agency?: string; dpm?: 'dairy' | 'dairy_equipment' | 'pareve' | 'meat'; group1?: boolean };
export type Dpm = 'dairy' | 'dairy_equipment' | 'pareve' | 'meat';
export type SourceKind = 'airtable' | 'google_sheets' | 'excel' | 'supabase' | 'upload';
export interface Company {
  attachments?: SourceAttachment[];
  sourceKey?: string;
  archiveKey?: string;
  id: string; name: string; address?: string; companyFee?: number; mashgiachFee?: number; type?: string; brand?: string; plant?: string; extra: Record<string, string>;
}
export interface Ingredient {
  attachments?: SourceAttachment[];
  sourceKey?: string;
  id: string; companyIds: string[]; name: string; brand?: string; certifyingAgency?: string;
  dpm?: Dpm; group1: boolean; plant?: string; expiresOn?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; confidence?: number; extra: Record<string, string>;
}
export interface Product {
  sourceKey?: string;
  id: string; companyIds: string[]; name: string; brand?: string; code?: string;
  certificationRaw?: string; statusRaw?: string; agencyRaw?: string; certifyingAgency?: string; confidence?: number;
  dpm?: Dpm; group1?: boolean; symbolRequired?: boolean; symbolRaw?: string; plant?: string; extra: Record<string, string>;
}
export type SourceAttachment = { id: string; filename: string; size?: number; contentType?: string };
export type EntityKind = 'company' | 'ingredient' | 'product' | 'contact' | 'certificate' | 'assignment';
export type EntityMapping = {
  id: string; kind: EntityKind; tableId: string; tableName?: string;
  filter?: { fieldId: string; operator: 'equals' | 'in'; values: string[] };
  fields: Record<string, { fieldId: string; fieldName?: string; expectedType: string; writable: boolean }>;
};
export type RelationshipMapping = {
  id: string; fromEntity: string; toEntity: string;
  kind: 'linked-record' | 'reverse-linked-record' | 'text-reference' | 'junction';
  ownership: 'from' | 'to' | 'junction'; cardinality: 'one-to-one' | 'many-to-one' | 'many-to-many';
  writable: boolean; fieldId?: string; fieldName?: string;
  junctionEntity?: string; junctionFromFieldId?: string; junctionToFieldId?: string;
};
export type FieldBinding = { targetField: string; ownerEntity: string; fieldId: string; path?: string[]; writable: boolean };
export type ConnectionMapping = SourceMapping;
export interface SourceMapping {
  version?: 1 | 2;
  entities?: EntityMapping[];
  relationships?: RelationshipMapping[];
  certificationOrganizations?: Partial<Record<'ingredients' | 'products', boolean>>;
  editableCustomFields?: import('../../lib/sourcePreview.ts').EditableCustomFields;
  companies: { locAttachment?: string; table: string; file?: SourceFile; pk?: string; address?: string; companyFee?: string; mashgiachFee?: string; name: string; type?: string; factoryValues?: string[]; foodServiceValues?: string[]; brand?: string; plant?: string };
  ingredients: { locAttachment?: string; table: string; file?: SourceFile; pk?: string; companyLink?: string; name?: string; brand?: string; certification?: string; agency?: string; status?: string; plant?: string; expiresOn?: string };
  products: { table: string; file?: SourceFile; pk?: string; companyLink?: string; name?: string; brand?: string; code?: string; certification?: string; agency?: string; status?: string; symbolRequired?: string; plant?: string };
  valueAssignments?: Record<string, Record<string, ValueAssignment>> | Partial<Record<'ingredient' | 'product', Record<string, Record<string, ValueAssignment>>>>;
  group1Values: string[];
}
export interface SourceData { mappingIssues?: MappingIssue[]; connectedLists?: Partial<Record<EntityKind, boolean>>; relationshipWrites?: Partial<Record<'ingredient' | 'product', boolean>>; companies: Company[]; otherCompanies?: Pick<Company, 'id' | 'name' | 'type' | 'sourceKey' | 'archiveKey'>[]; ingredients: Ingredient[]; products: Product[] }
export interface SourceFile { id: string; name: string }
export type MappingIssue = { entity: EntityKind; field?: string; message: string; blocking?: boolean };
export type AirtableField = { id: string; name: string; type: string; options?: {
  linkedTableId?: string; inverseLinkFieldId?: string; prefersSingleRecordLink?: boolean;
  choices?: { id?: string; name: string }[]; result?: { type: string };
} };
export type AirtableTable = { id: string; name: string; primaryFieldId?: string; fields: AirtableField[] };
export interface SourceTable { id?: string; primaryFieldId?: string; fields?: AirtableField[]; name: string; columns: string[]; fieldTypes?: Record<string, string> }
export type SourceSamples = Record<string, { id: string; fields: Record<string, string> }[]>;
export interface ConnectionResult { ok: boolean; access?: 'read' | 'readwrite'; tables?: SourceTable[]; error?: string }
export interface SourceConnector {
  kind: SourceKind;
  testConnection(discover?: boolean): Promise<ConnectionResult>;
  listCompanies(): Promise<Company[]>;
  listItems(companyId: string, kind: 'ingredient' | 'product'): Promise<(Ingredient | Product)[]>;
  loadAll?(): Promise<SourceData>;
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
