import { compatibleField, recordIdPattern } from './write.ts';
import type { AirtableField, AirtableTable, EntityKind, EntityMapping, FieldBinding, MappingIssue, RelationshipMapping } from './types.ts';
import { parseMoney } from '../../lib/sourceAmount.ts';
export { parseMoney } from '../../lib/sourceAmount.ts';
import type { Company, Dpm, SourceData, SourceMapping, SourceAttachment, SourceRow, SourceTable } from './types.ts';
import { airtableMappingCopy, isBuiltinFieldKey, type SourceSection } from '../../lib/sourcePreview.ts';

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const folded = (s: string) => s.trim().toLowerCase();
export function companyTypeChoices(config: SourceMapping['companies']) {
  return config.factoryValues?.length
    ? [...new Set([...config.factoryValues, ...(config.foodServiceValues ?? [])])]
    : undefined;
}

const synonyms: Record<string, string[]> = {
  name: ['Name', 'Item', 'Ingredient', 'Product', 'Product Name', 'Company Name', 'Establishment Name'],
  address: ['Address', 'Street Address', 'Street', 'Location Address'],
  companyFee: ['Annual Fee', 'Yearly Fee', 'Company Fee', 'Certification Fee'],
  mashgiachFee: ['Supervision Fee', 'Mashgiach Fee', 'Inspection Fee', 'Visit Fee'],
  brand: ['Brand', 'Brand Name'],
  certification: ['Certification', 'Hechsher', 'Kosher Certification', 'Certifying Agency'],
  agency: ['Agency', 'Certifying Agency'], status: ['Status', 'Kosher Status', 'DPM', 'Dairy Pareve Meat'],
  code: ['UPC', 'UPC Code', 'Code', 'SKU', 'Code Case', 'Barcode'],
  plant: ['Plant', 'Location', 'Facility', 'Site'],
  companyLink: ['Establishment', 'Establishments', 'Company', 'Companies', 'Factory', 'Client'],
  expiresOn: ['Expiration', 'Expiration Date', 'Expiry', 'Exp Date'],
  type: ['Type', 'Category'], symbolRequired: ['Symbol Required'],
};
const tableNames = {
  companies: ['Establishments', 'Companies', 'Factories', 'Clients'],
  ingredients: ['Ingredients', 'Ingredients List', 'Schedule A', 'Raw Materials'],
  products: ['Products', 'Schedule B', 'Product List'],
};
const shortForms: Record<string, string> = { ingr: 'ingredient', ingred: 'ingredient', cert: 'certification', certif: 'certification', hech: 'hechsher', exp: 'expiration', expir: 'expiration', mfr: 'manufacturer', mfg: 'manufacturer', prod: 'product', est: 'establishment', estab: 'establishment', co: 'company', loc: 'location', fac: 'facility', stat: 'status', desc: 'description', no: 'number', num: 'number' };
function words(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/#/g, ' number ').toLowerCase().split(/[^a-z]+/).filter(Boolean).map(w => {
    const singular = w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('s') && !w.endsWith('ss') && w !== 'status' ? w.slice(0, -1) : w;
    return shortForms[singular] || singular;
  });
}
function overlap(name: string, aliases: string[]): number {
  const a = new Set(words(name));
  return Math.max(0, ...aliases.map(alias => {
    const b = new Set(words(alias)), common = [...a].filter(w => b.has(w)).length;
    return common / Math.max(a.size, b.size, 1);
  }));
}
// Partial mappings deliberately leave missing tables/columns unset for the caller to review.
export type GuessedMapping = { [K in keyof Omit<SourceMapping, 'group1Values' | 'valueAssignments' | 'editableCustomFields' | 'certificationOrganizations' | 'version' | 'entities' | 'relationships'>]: Partial<SourceMapping[K]> } & { group1Values: string[] };
export function guessMapping(tables: SourceTable[]): { mapping: GuessedMapping; guessed: Record<string, number> } {
  const mapping: GuessedMapping = { companies: {}, ingredients: {}, products: {}, group1Values: ['Group 1'] };
  const guessed: Record<string, number> = {};
  for (const kind of Object.keys(tableNames) as (keyof typeof tableNames)[]) {
    let table = tableNames[kind].map(n => tables.find(t => normalized(t.name) === normalized(n))).find(Boolean);
    const exactTable = !!table;
    if (!table) table = tables.map(t => ({ t, score: overlap(t.name, tableNames[kind]) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score)[0]?.t;
    if (!table) continue;
    const attachment = kind === 'companies' && table.name === 'Establishments' ? 'LOC'
      : kind === 'ingredients' && table.name === 'Ingredients List' ? 'Attachments' : undefined;
    if (kind !== 'products' && attachment && table.fieldTypes?.[attachment] === 'multipleAttachments')
      mapping[kind].locAttachment = attachment;
    table = { ...table, columns: table.columns.filter(column => table!.fieldTypes?.[column] !== 'multipleAttachments') };
    mapping[kind].table = table.name;
    guessed[`${kind}.table`] = exactTable ? 1 : 0.6;
    const fields = kind === 'companies' ? ['name', 'type', 'brand', 'plant', 'address', 'companyFee', 'mashgiachFee']
      : kind === 'ingredients' ? ['companyLink', 'name', 'brand', 'certification', 'agency', 'status', 'plant', 'expiresOn']
      : ['companyLink', 'name', 'brand', 'code', 'certification', 'agency', 'status', 'symbolRequired', 'plant'];
    const used = new Set<string>();
    for (const field of fields) {
      const column = synonyms[field].map(n => table.columns.find(c => !used.has(c) && normalized(c) === normalized(n))).find(Boolean);
      if (!column) continue;
      used.add(column);
      (mapping[kind] as Record<string, unknown>)[field] = column;
      guessed[`${kind}.${field}`] = normalized(column) === normalized(synonyms[field][0]) ? 1 : 0.9;
    }
    // Exact assignments reserve their columns before any fuzzy assignment.
    for (const field of fields) {
      if ((mapping[kind] as Record<string, unknown>)[field]) continue;
      const column = table.columns.filter(c => !used.has(c) && (field !== 'brand' || words(c).includes('brand')))
        .map(c => ({ c, score: overlap(c, synonyms[field]) }))
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score)[0]?.c;
      if (!column) continue;
      used.add(column);
      (mapping[kind] as Record<string, unknown>)[field] = column;
      guessed[`${kind}.${field}`] = 0.6;
    }
  }
  return { mapping, guessed };
}
export type ValueAssignment = { agency?: string; dpm?: Dpm; group1?: boolean };
export function assign(text: string, group1Values: string[] = ['Group 1']): ValueAssignment & { confidence: number } {
  const fold = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (text.trim() && group1Values.some(v => fold(v) === fold(text))) return { group1: true, confidence: 1 };
  const equipment = /\b(?:dairy[\s.,_-]*(?:equipment|eq\.?)|d\.?e\.?)(?![a-z])/ig;
  const dairy = /\b(dairy|cholov[\s.,_-]*yisroel|cy|d)\b/ig;
  const meat = /\b(meat|glatt|m)\b/ig;
  const pareve = /\b(parve|pareve|p)\b/ig;
  const dpm: Dpm | undefined = equipment.test(text) ? 'dairy_equipment' : meat.test(text) ? 'meat' : dairy.test(text) ? 'dairy' : pareve.test(text) ? 'pareve' : undefined;
  const agency = text.replace(equipment, '').replace(dairy, '').replace(meat, '').replace(pareve, '').trim().replace(/^[\s.,_-]+|[\s.,_-]+$/g, '');
  const known = /^(ou|ok|star[\s-]*k|kof[\s-]*k|crc)$/i.test(agency);
  return { ...(agency ? { agency } : {}), ...(dpm ? { dpm } : {}), group1: false, confidence: known || (!agency && dpm) ? 1 : text.trim() ? 0.6 : 1 };
}
export function parseDpm(text: string): Dpm | undefined { return assign(text).dpm; }
export function splitCertification(text: string, group1Values: string[] = ['Group 1']): { agency?: string; dpm?: Dpm; group1: boolean } {
  const { confidence, ...value } = assign(text, group1Values);
  return { ...value, group1: value.group1 === true };
}
export function assigned(mapping: SourceMapping, column: string | undefined, value: string, kind?: 'ingredient' | 'product'): ReturnType<typeof assign> {
  const assignments = mapping.valueAssignments as Record<string, any> | undefined;
  const scoped = assignments && Object.keys(assignments).every(k => ['ingredient', 'product'].includes(k));
  const columns = scoped ? (kind ? assignments?.[kind] : undefined) : assignments;
  const values = column && Object.prototype.hasOwnProperty.call(columns || {}, column) ? columns?.[column] : undefined;
  const override = values && Object.prototype.hasOwnProperty.call(values, value) ? values[value] : undefined;
  return { ...assign(value, mapping.group1Values), ...override, ...(override ? { confidence: 1 } : {}) };
}
export function classifyRaw(mapping: SourceMapping, config: { certification?: string; agency?: string; status?: string }, raw: { certificationRaw?: string; agencyRaw?: string; statusRaw?: string }) {
  const kind = config === mapping.products ? 'product' : 'ingredient';
  const cert = assigned(mapping, config.certification, raw.certificationRaw || '', kind);
  const status = assigned(mapping, config.status, raw.statusRaw || '', kind);
  const agency = assigned(mapping, config.agency, raw.agencyRaw || '', kind);
  const assignments = mapping.valueAssignments as Record<string, any> | undefined;
  const columns = assignments?.[kind] ?? assignments;
  const explicit = [[config.certification, raw.certificationRaw], [config.status, raw.statusRaw]]
    .map(([column, value]) => column && value?.trim() && columns?.[column]?.[value]?.agency).find(Boolean);
  const organization = mapping.certificationOrganizations?.[kind === 'ingredient' ? 'ingredients' : 'products'] ??
    (kind === 'ingredient' && mapping.ingredients.table === 'Ingredients List' && config.certification === 'Certification');
  const organizationText = raw.certificationRaw?.trim();
  const statusOnly = /^(?:(?:pareve|parve|dairy(?: equipment)?|de|meat|passover|p|d|m)\b[\s|,/+-]*)+$/i;
  return { certifyingAgency: raw.agencyRaw?.trim() || (organization && organizationText && !statusOnly.test(organizationText) && organizationText) || explicit || undefined, dpm: status.dpm || cert.dpm,
    group1: [cert, status, agency].some(v => v.group1 === true), confidence: Math.min(cert.confidence, status.confidence, agency.confidence) };
}
const text = (value: unknown): string | undefined => typeof value === 'string' ? value.trim() : undefined;
const fieldValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};
export class CompanyLinkError extends Error {
  readonly status = 400;
}

export class AmbiguousCompanyLink extends CompanyLinkError {
  constructor(name:string) {
    super(`Multiple companies match "${name}". Use the company's unique ID in the company-link column.`);
  }
}

type LinkCompany = Pick<Company, 'id' | 'name' | 'sourceKey'>;
type UnmatchedLinks = 'reject' | 'ignore';
export function companyLinkResolver(eligible: LinkCompany[], others: LinkCompany[] = [], unmatched: UnmatchedLinks = 'reject') {
  const eligibleIds = new Set(eligible.map(c => c.id));
  const companies = [...eligible, ...others];
  const ids = new Set(companies.map(c => c.id));
  const sourceKeys = new Map(companies.filter(c => c.sourceKey).map(c => [c.sourceKey, c.id]));
  const names = new Map<string, string[]>();
  let maxParts = 1;
  for (const company of companies) {
    const name = folded(company.name);
    const matches = names.get(name) ?? [];
    matches.push(company.id);
    names.set(name,matches);
    for (const key of [company.id, company.sourceKey, name]) {
      if (key) maxParts = Math.max(maxParts,key.split(',').length);
    }
  }
  function candidates(link:string): string[] {
    if (!link) return [];
    if (ids.has(link)) return [link];
    const sourceId = sourceKeys.get(link);
    return sourceId === undefined ? names.get(folded(link)) ?? [] : [sourceId];
  }
  function resolveOne(value: unknown, required: boolean): string | undefined {
    const link = fieldValue(value)?.trim() ?? '';
    const matches = candidates(link);
    if (matches.length > 1) throw new AmbiguousCompanyLink(link);
    if (required && unmatched === 'reject' && link && !matches.length) throw new CompanyLinkError(`Unknown company link "${link}". Use the company's unique ID.`);
    return matches[0];
  }
  function resolve(value: unknown): string[] {
    if (Array.isArray(value)) return [...new Set(value.map(v => resolveOne(v, true)).filter((id): id is string => id !== undefined))];
    const list = typeof value === 'string' && value.includes(',');
    const whole = resolveOne(value, !list);
    if (whole !== undefined) return [whole];
    if (!list) return [];

    // Strict sources require a complete parse. Airtable may skip unmatched
    // fragments, preferring the unique parse that skips the fewest.
    const parts = value.split(',');
    const ways = new Uint8Array(parts.length + 1);
    const skipped = new Uint32Array(parts.length + 1);
    const next: {id?:string; end:number}[] = [];
    ways[parts.length] = 1;
    for (let start = parts.length - 1; start >= 0; start--) {
      let best = Infinity;
      if (unmatched === 'ignore') {
        best = skipped[start + 1] + 1;
        ways[start] = ways[start + 1];
        next[start] = {end:start + 1};
      }
      let span = '';
      for (let end = start + 1; end <= Math.min(parts.length, start + maxParts); end++) {
        span += (end === start + 1 ? '' : ',') + parts[end - 1];
        if (!ways[end]) continue;
        const matches = candidates(span.trim());
        if (!matches.length || skipped[end] > best) continue;
        if (skipped[end] < best) {
          best = skipped[end];
          ways[start] = 0;
        }
        ways[start] = Math.min(2, ways[start] + matches.length * ways[end]);
        next[start] = {id:matches[0],end};
        if (ways[start] > 1 && best === 0) break;
      }
      if (ways[start]) skipped[start] = best;
    }
    if (ways[0] !== 1) throw new CompanyLinkError(`Cannot uniquely resolve the company list "${value}". Use a list of unique company IDs.`);
    const linked = new Set<string>();
    for (let i = 0; i < parts.length; i = next[i].end) {
      const id = next[i].id;
      if (id !== undefined) linked.add(id);
    }
    return [...linked];
  }
  return (value: unknown) => resolve(value).filter(id => eligibleIds.has(id));
}

export function attachmentDescriptors(value: unknown): SourceAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(file => file && typeof file.id === 'string' && typeof file.filename === 'string'
    ? [{ id: file.id, filename: file.filename, ...(Number.isSafeInteger(file.size) && { size: file.size }),
      ...(typeof (file.type ?? file.contentType) === 'string' && { contentType: file.type ?? file.contentType }) }] : []);
}
export function applyMapping(rows: Record<string, SourceRow[]>, mapping: SourceMapping, unmatched: UnmatchedLinks = 'reject'): SourceData {
  return mapSourceLists({
    companies: rows[mapping.companies.table],
    ingredients: rows[mapping.ingredients.table],
    products: rows[mapping.products.table],
  }, mapping, { unmatched });
}

export function mapSourceLists(
  rows: Partial<Record<SourceSection, SourceRow[]>>, mapping: SourceMapping,
  options: { resolveLinks?: ReturnType<typeof companyLinkResolver>; unmatched?: UnmatchedLinks } = {},
): SourceData {
  const read = (row: SourceRow, column?: string): string | undefined => column ? fieldValue(row.fields[column]) : undefined;
  const extra = (row: SourceRow, config: object, group: SourceSection) => {
    const mapped = new Set(Object.entries(config).filter(([k, v]) => k !== 'table' && typeof v === 'string').map(([, v]) => v));
    const out = Object.fromEntries(Object.entries(row.fields).filter(([k, v]) => !mapped.has(k) && typeof v === 'string')) as Record<string, string>;
    for (const [key, column] of Object.entries(config)) {
      if (isBuiltinFieldKey(group, key) || typeof column !== 'string') continue;
      const value = fieldValue(row.fields[column]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  };
  const c = mapping.companies;
  const types = companyTypeChoices(c)?.map(folded);
  const companies = (rows.companies ?? []).filter(r => !types || types.includes(folded(read(r, c.type) ?? '')))
    .map(r => ({ ...(c.locAttachment && {attachments: attachmentDescriptors(r.fields[c.locAttachment])}), id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), ...(r.archiveKey ? { archiveKey: r.archiveKey } : {}), name: read(r, c.name) ?? '', type: read(r, c.type), brand: read(r, c.brand), plant: read(r, c.plant), address: read(r, c.address), companyFee: parseMoney(read(r, c.companyFee)), mashgiachFee: parseMoney(read(r, c.mashgiachFee)), extra: extra(r, c, 'companies') }));
  const keptIds = new Set(companies.map(c => c.id));
  const otherCompanies = (rows.companies ?? []).filter(r => !keptIds.has(r.id))
    .map(r => ({ id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), ...(r.archiveKey ? { archiveKey: r.archiveKey } : {}), name: read(r, c.name) ?? '', type: read(r, c.type) }));
  const links = options.resolveLinks ?? companyLinkResolver(companies, otherCompanies, options.unmatched);
  const i = mapping.ingredients, p = mapping.products;
  const ingredients = (rows.ingredients ?? []).map(r => {
    const raw = { certificationRaw: read(r, i.certification), statusRaw: read(r, i.status), agencyRaw: read(r, i.agency) };
    return { ...(i.locAttachment && {attachments: attachmentDescriptors(r.fields[i.locAttachment])}), id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), companyIds: links(i.companyLink && r.fields[i.companyLink]), name: read(r, i.name) ?? '', brand: read(r, i.brand),
      ...raw, ...classifyRaw(mapping, i, raw),
      plant: read(r, i.plant), expiresOn: read(r, i.expiresOn), extra: extra(r, i, 'ingredients') };
  });
  const products = (rows.products ?? []).map(r => {
    const raw = p.symbolRequired ? r.fields[p.symbolRequired] : undefined;
    const symbolRequired = typeof raw === 'boolean' ? raw : typeof raw === 'string' && /^(yes|true|1|no|false|0)$/i.test(raw.trim()) ? /^(yes|true|1)$/i.test(raw.trim()) : undefined;
    const classifiedRaw = { certificationRaw: read(r, p.certification), statusRaw: read(r, p.status), agencyRaw: read(r, p.agency) };
    return { ...classifiedRaw, ...classifyRaw(mapping, p, classifiedRaw), id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), companyIds: links(p.companyLink && r.fields[p.companyLink]), name: read(r, p.name) ?? '', brand: read(r, p.brand),
      code: read(r, p.code), symbolRequired, ...(typeof raw === 'string' && {symbolRaw: raw}), plant: read(r, p.plant), extra: extra(r, p, 'products') };
  });
  return { companies, ingredients, products, otherCompanies };
}

export const entitySections = { company: 'companies', ingredient: 'ingredients', product: 'products' } as const;
export type PilotKind = keyof typeof entitySections;
export const mappingFields: Record<PilotKind, Record<string, string>> = {
  company: { name: 'Name', address: 'Address', type: 'Type', brand: 'Brand', plant: 'Plant', locAttachment: 'Letter of Certification (LOC)' },
  ingredient: { name: 'Name', brand: 'Brand', plant: 'Plant', certification: 'Certification', agency: 'Certifying agency', status: 'Status', expiresOn: 'Expiration date', locAttachment: 'Letter of Certification (LOC)' },
  product: { name: 'Name', brand: 'Brand', plant: 'Plant', certification: 'Certification', agency: 'Certifying agency', status: 'Status', code: 'Code / UPC', symbolRequired: 'Symbol required' },
};
const computedTypes = new Set(['formula', 'rollup', 'multipleLookupValues', 'lookup']);
const definition = (key: string, field: AirtableField) => key === 'locAttachment'
  ? field.type === 'multipleAttachments'
  : compatibleField(key, field);

// Project the v1 shape for inspection without changing its reader, writer, IDs or permissions.
export function describeAirtableMapping(mapping: SourceMapping, tables: AirtableTable[]) {
  if (mapping.version === 2) return { entities: mapping.entities ?? [], relationships: mapping.relationships ?? [] };
  const entities: EntityMapping[] = [], relationships: RelationshipMapping[] = [];
  for (const [kind, section] of Object.entries(entitySections) as [PilotKind, SourceSection][]) {
    const config = mapping[section] as Record<string, unknown>;
    const table = tables.find(t => t.name === config.table || t.id === config.table);
    if (!table?.id) continue;
    const fields = Object.fromEntries(Object.entries(config).flatMap(([key, name]) => {
      const field = table.fields.find(f => f.name === name);
      return field?.id && Object.hasOwn(mappingFields[kind], key) ? [[key, {fieldId: field.id, fieldName: field.name, expectedType: field.type, writable: false}]] : [];
    }));
    entities.push({ id: kind, kind, tableId: table.id, tableName: table.name, fields });
    const field = kind !== 'company' && table.fields.find(f => f.name === config.companyLink);
    if (field && field.id) relationships.push({ id: kind, fromEntity: kind, toEntity: 'company', kind: field.type === 'multipleRecordLinks' ? 'linked-record' : 'text-reference',
      ownership: 'from', cardinality: 'many-to-many', fieldId: field.id, fieldName: field.name, writable: false });
  }
  return { entities, relationships };
}

type CompiledEntity = { mapping: EntityMapping; table: AirtableTable; fields: Record<string, AirtableField>; bindings: FieldBinding[] };
type CompiledRelationship = { mapping: RelationshipMapping; owner: CompiledEntity; field: AirtableField; writable: boolean };
export function validateAirtableMapping(mapping: SourceMapping, tables: AirtableTable[], access: 'read' | 'readwrite' = 'read') {
  const entities: Partial<Record<PilotKind, CompiledEntity>> = {};
  const relationships: Partial<Record<'ingredient' | 'product', CompiledRelationship>> = {};
  const issues: MappingIssue[] = [];
  const report = (entity: EntityKind, message: string, field?: string, blocking = false) => issues.push({ entity, field, message, blocking });
  const source = describeAirtableMapping(mapping, tables);
  const projection: SourceMapping = {
    companies: { table: '', name: '' }, ingredients: { table: '' }, products: { table: '' },
    group1Values: mapping.group1Values, valueAssignments: mapping.valueAssignments, certificationOrganizations: mapping.certificationOrganizations,
  };
  for (const entity of source.entities) {
    if (!Object.hasOwn(entitySections, entity.kind)) continue;
    const kind = entity.kind as PilotKind;
    const table = tables.find(t => t.id === entity.tableId);
    if (!table) { report(kind, airtableMappingCopy.schemaChanged, 'table', true); continue; }
    if (entity.filter) {
      const field = table.fields.find(f => f.id === entity.filter!.fieldId);
      if (field?.type !== 'singleSelect' || !entity.filter.values.every(value => field.options?.choices?.some(choice => choice.name === value))) {
        report(kind, 'Choose available values from a single-select Airtable field.', 'filter', true);
        continue;
      }
    }
    const fields: Record<string, AirtableField> = {};
    const bindings: FieldBinding[] = [];
    for (const [key, binding] of Object.entries(entity.fields)) {
      const field = table.fields.find(f => f.id === binding.fieldId);
      const aliases = Object.entries(entity.fields).filter(([other, value]) => other !== key && value.fieldId === binding.fieldId);
      const computed = !!field && computedTypes.has(field.type);
      const resultType = field?.options?.result?.type;
      const readableComputed = computed && key !== 'locAttachment' && !!resultType && definition(key, { ...field!, type: resultType });
      const label = mappingFields[kind][key] ?? key;
      if (!field || field.type !== binding.expectedType || !(definition(key, field) || readableComputed)) {
        report(kind, airtableMappingCopy.wrongType(label), key, key === 'name');
        continue;
      }
      if (aliases.length && key !== 'name') {
        report(kind, 'Choose a separate Airtable field for ' + label + '.', key);
        continue;
      }
      fields[key] = field;
      bindings.push({ targetField: key, ownerEntity: entity.id, fieldId: field.id,
        writable: access === 'readwrite' && key !== 'locAttachment' && binding.writable && !computed && !aliases.length && field.id !== entity.filter?.fieldId &&
          (key !== 'type' || field.type === 'singleSelect') });
    }
    if (!fields.name) {
      if (!entity.fields.name) report(kind, 'Choose an Airtable field for Name.', 'name', true);
      continue;
    }
    entities[kind] = { mapping: entity, table, fields, bindings };
    Object.assign(projection[entitySections[kind]], { table: table.id }, Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.id])));
  }
  const a = entities.ingredient?.mapping, b = entities.product?.mapping;
  if (a && b && a.tableId === b.tableId && (!a.filter || !b.filter || a.filter.fieldId !== b.filter.fieldId ||
      a.filter.values.some(value => b.filter!.values.includes(value)))) {
    for (const kind of ['ingredient', 'product'] as const) {
      report(kind, 'Choose separate type values for ingredients and products.', 'filter', true);
      delete entities[kind];
    }
  }
  if (!entities.company && !issues.some(issue => issue.entity === 'company')) report('company', 'Choose an Airtable company table.', 'table', true);
  for (const relationship of source.relationships) {
    const entry = (['ingredient', 'product'] as const).find(kind => entities[kind]?.mapping.id === relationship.fromEntity);
    const company = entities.company;
    if (!entry || !company || company.mapping.id !== relationship.toEntity) continue;
    const from = entities[entry]!;
    const reverse = relationship.kind === 'reverse-linked-record';
    const linked = reverse || relationship.kind === 'linked-record';
    const owner = reverse ? company : from;
    const field = owner.table.fields.find(f => f.id === relationship.fieldId);
    if (!field || relationship.ownership !== (reverse ? 'to' : 'from') ||
        !(linked ? field.type === 'multipleRecordLinks' : relationship.kind === 'text-reference' && compatibleField('name', field))) {
      report(entry, airtableMappingCopy.schemaChanged, 'relationship');
      continue;
    }
    if (linked && field.options?.linkedTableId !== (reverse ? from : company).table.id) {
      report(entry, airtableMappingCopy.wrongTable, 'relationship');
      continue;
    }
    // Airtable's single-record UI preference is useful only as a fail-closed constraint.
    const writable = access === 'readwrite' && linked && relationship.writable &&
      !(field.options?.prefersSingleRecordLink && (reverse && relationship.cardinality !== 'one-to-one' ||
        !reverse && relationship.cardinality === 'many-to-many'));
    relationships[entry] = { mapping: relationship, owner, field, writable };
    for (const entity of Object.values(entities)) {
      if (entity.table.id === owner.table.id) for (const binding of entity.bindings)
        if (binding.fieldId === field.id) binding.writable = false;
    }
  }
  return { entities, relationships, issues, projection };
}

export const rowMatchesEntity = (row: SourceRow, entity: CompiledEntity) => {
  const { filter } = entity.mapping;
  const name = row.fields[entity.fields.name.id];
  return typeof name === 'string' && !!name.trim() && (!filter || filter.values.includes(row.fields[filter.fieldId] as string));
};

export const linkIds = (value: unknown): string[] | undefined => value == null ? [] :
  Array.isArray(value) && value.every(id => typeof id === 'string' && recordIdPattern.test(id)) && new Set(value).size === value.length ? value : undefined;

export function mapAirtableEntities(rows: Record<string, SourceRow[]>, schema: ReturnType<typeof validateAirtableMapping>): SourceData {
  const { entities, relationships, projection, issues } = schema;
  const rawCompanies = entities.company ? rows[entities.company.table.id] ?? [] : [];
  const companies = entities.company ? rawCompanies.filter(row => rowMatchesEntity(row, entities.company!)) : [];
  const input: Partial<Record<SourceSection, SourceRow[]>> = { companies };
  const companyIds = new Set(companies.map(row => row.id));
  const unresolved: MappingIssue[] = [];
  for (const kind of ['ingredient', 'product'] as const) {
    const entity = entities[kind], relationship = relationships[kind], section = entitySections[kind];
    if (!entity || !relationship) continue;
    const fieldId = relationship.field.id;
    const reverse = new Map<string, string[]>();
    if (relationship.mapping.kind === 'reverse-linked-record') {
      for (const row of rawCompanies) for (const itemId of linkIds(row.fields[fieldId]) ?? []) {
        const owners = reverse.get(itemId) ?? [];
        owners.push(row.id);
        reverse.set(itemId, owners);
      }
    }
    const byName = new Map<string, string[]>();
    if (relationship.mapping.kind === 'text-reference' && entities.company) for (const row of rawCompanies) {
      const name = row.fields[entities.company.fields.name.id];
      if (typeof name !== 'string' || !name.trim()) continue;
      const matches = byName.get(folded(name)) ?? [];
      matches.push(row.id);
      byName.set(folded(name), matches);
    }
    projection[section].companyLink = '__shutfeyCompanyIds';
    input[section] = (rows[entity.table.id] ?? []).filter(row => rowMatchesEntity(row, entity)).flatMap(row => {
      const value = row.fields[fieldId];
      const all = relationship.mapping.kind === 'text-reference' ? (typeof value === 'string' ? byName.get(folded(value)) ?? [] : [])
        : relationship.mapping.kind === 'reverse-linked-record' ? reverse.get(row.id) ?? [] : linkIds(value);
      if (!all || (relationship.mapping.cardinality !== 'many-to-many' || relationship.mapping.kind === 'text-reference') && all.length > 1) {
        const message = relationship.mapping.kind === 'text-reference' ? airtableMappingCopy.ambiguous : airtableMappingCopy.schemaChanged;
        if (!unresolved.some(issue => issue.entity === kind && issue.message === message)) unresolved.push({ entity: kind, field: 'relationship', message });
        return [];
      }
      // Only a typed relationship can expose unassigned records to the admin assignment picker.
      const linked = all.filter(id => companyIds.has(id));
      if (!linked.length && !relationship.writable) return [];
      return [{ ...row, fields: { ...row.fields, __shutfeyCompanyIds: linked } }];
    });
  }
  return { ...mapSourceLists(input, projection, { resolveLinks: value => Array.isArray(value) ? value : [] }),
    mappingIssues: [...issues, ...unresolved],
    relationshipWrites: { ingredient: !!relationships.ingredient?.writable, product: !!relationships.product?.writable },
    connectedLists: { company: !!entities.company, ingredient: !!relationships.ingredient, product: !!relationships.product, contact: false } };
}
