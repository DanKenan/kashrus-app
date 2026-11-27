import type { AirtableField, AirtableTable } from './types.ts';
export type { AirtableField, AirtableTable } from './types.ts';
import type { Connection } from './store.ts';
// Every list write passes this single guard. Report routes have no writer reference.
export function guardSourceWrite(c: Connection | undefined, list: string, fields: unknown): Record<string, string>;
export function guardSourceWrite(c: Connection, list: ItemList, fields: unknown, schema: ReturnType<typeof itemSchema>): Record<string, Cell>;
export function guardSourceWrite(c: Connection | undefined, list: string, fields: unknown, schema?: ReturnType<typeof itemSchema>): Record<string, Cell> {
    // Only the company-scoped item routes can supply a server-verified schema.
    if (c && schema && (list === 'ingredients' || list === 'products')) return serializeItemFields(c, schema.fields, fields);
    const reject = (status: number, error: string): never => { throw Object.assign(Error(error), { status }); };
    if (!c || c.sourceType === 'upload')
        return reject(409, 'Editing from the app is not available for this source.');
    if (c.access !== 'readwrite')
        return reject(403, 'This source is read only.');
    if (c.sourceType === 'airtable' && list !== 'companies') return reject(409, 'Only companies can be edited in Airtable.');
    if (c.sourceType !== 'supabase' && c.sourceType !== 'airtable') return reject(409, 'Spreadsheet rows are read only.');
    if (!['companies', 'ingredients', 'products'].includes(list))
        return reject(400, 'Invalid list');
    const config = c.mapping[list as 'companies' | 'ingredients' | 'products'] as any;
    if (!config?.table || !fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length)
        return reject(400, 'Invalid fields');
    const output: Record<string, string> = Object.create(null);
    const allowed = list === 'companies' ? ['name', 'type', 'brand', 'plant', 'address'] : list === 'ingredients' ? ['name', 'companyLink', 'brand', 'certification', 'agency', 'status', 'plant', 'expiresOn'] : ['name', 'companyLink', 'brand', 'code', 'certification', 'agency', 'status', 'symbolRequired', 'plant'];
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed.includes(key) || typeof value !== 'string' || value.length > 2000)
            return reject(400, 'Only mapped list columns can be edited.');
        const company = c.mapping.companies;
        if (config.table === company.table && (config.file?.id || c.baseId) === (company.file?.id || c.baseId) &&
            config[key] && [company.companyFee, company.mashgiachFee].includes(config[key]))
            return reject(400, 'Imported fee columns are read only.');
        if (c.sourceType === 'airtable') {
            if (key === 'name' && !value.trim()) return reject(400, 'Enter a company name.');
            if (config[key] && allowed.some(other => other !== key && config[other] === config[key]))
                return reject(400, 'Map each editable company field to a separate Airtable column.');
        }
        if (typeof config[key] === 'string' && config[key]) output[config[key]] = value;
    }
    if (!Object.keys(output).length) return reject(400, 'Only mapped list columns can be edited.');
    return output;
}

export type ItemList = 'ingredients' | 'products';
export type Cell = string | null | boolean;
export const recordIdPattern = /^rec[A-Za-z0-9]{1,64}$/;
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
export function tableSchema(tables: AirtableTable[], name: string) {
  return tables.find(table => table.name === name || table.id === name) ?? fail(409, 'The mapped Airtable table is unavailable.');
}
export function attachmentColumn(table: AirtableTable, configured: string | undefined, list: 'companies' | 'ingredients') {
  const name = configured ?? (list === 'companies' && table.name === 'Establishments' ? 'LOC'
    : list === 'ingredients' && table.name === 'Ingredients List' ? 'Attachments' : '');
  return table.fields.find(field => field.name === name && field.type === 'multipleAttachments');
}
const textTypes = ['singleLineText', 'multilineText'];
export function compatibleField(key: string, field?: AirtableField) {
  if (!field) return false;
  if (key === 'expiresOn') return field.type === 'date';
  if (key === 'symbolRequired' && field.type === 'checkbox') return true;
  if (['status', 'symbolRequired', 'type'].includes(key) && field.type === 'singleSelect')
    return Array.isArray(field.options?.choices);
  return textTypes.includes(field.type);
}
export function itemSchema(c: Connection, list: ItemList, tables: AirtableTable[]) {
  if (c.mapping.version === 2) fail(409, 'Use the configured Airtable relationship.');
  const config = c.mapping[list], table = tableSchema(tables, config.table);
  const company = tableSchema(tables, c.mapping.companies.table);
  if (new Set([company, tableSchema(tables, c.mapping.ingredients.table), tableSchema(tables, c.mapping.products.table)]).size !== 3)
    fail(409, 'Map each list to a separate Airtable table.');
  const link = table.fields.find(field => field.name === config.companyLink);
  if (!link || link.type !== 'multipleRecordLinks' || !company.id || link.options?.linkedTableId !== company.id)
    fail(409, 'Map the company link to the establishments table.');
  const keys = ['name', 'status', 'brand', 'plant', 'agency', 'certification', ...(list === 'ingredients' ? ['expiresOn'] : ['symbolRequired', 'code'])];
  const fields: Record<string, AirtableField> = Object.create(null);
  const warnings: string[] = [];
  for (const key of keys) {
    const column = (config as Record<string, unknown>)[key];
    if (!column) continue;
    const field = table.fields.find(f => f.name === column);
    const aliases = Object.entries(config).filter(([k, v]) => k !== 'table' && v === column);
    if (compatibleField(key, field) && aliases.length === 1) fields[key] = field!;
    else warnings.push('Review the Airtable mapping for ' + key + '.');
  }
  if (!fields.name) fail(409, 'Map the item name to a unique text column.');
  return { fields, warnings, table, link };
}
export function serializeItemFields(c: Connection, definitions: Record<string, AirtableField>, input: unknown) {
  if (c.sourceType !== 'airtable' || c.access !== 'readwrite') fail(403, 'This Airtable connection is read only. Contact an administrator.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) fail(400, 'Invalid fields');
  const values: Record<string, Cell> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    const field = definitions[key];
    if (!field || !Object.hasOwn(definitions, key)) fail(400, 'Only mapped list columns can be edited.');
    if (field.type === 'checkbox') {
      if (typeof raw !== 'boolean') fail(400, 'Choose a checkbox value.');
      values[key] = raw;
      continue;
    }
    if (!(raw === null || typeof raw === 'string' && raw.length <= 2000)) fail(400, 'Invalid field value.');
    const value = raw || null;
    if (key === 'name' && !value?.trim()) fail(400, 'Enter an item name.');
    if (value && field.type === 'singleSelect' && !field.options?.choices?.some(choice => choice.name === value))
      fail(400, 'Choose a value from the Airtable column options.');
    if (value && field.type === 'date' && (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value))
      fail(400, 'Choose a valid date.');
    values[key] = value;
  }
  return values;
}
