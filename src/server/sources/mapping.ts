import type { Dpm, SourceData, SourceMapping, SourceRow, SourceTable } from './types.ts';

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const folded = (s: string) => s.trim().toLowerCase();
const synonyms: Record<string, string[]> = {
  name: ['Name', 'Item', 'Ingredient', 'Product', 'Product Name', 'Company Name', 'Establishment Name'],
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
export type GuessedMapping = { [K in keyof Omit<SourceMapping, 'group1Values' | 'valueAssignments'>]: Partial<SourceMapping[K]> } & { group1Values: string[] };
export function guessMapping(tables: SourceTable[]): { mapping: GuessedMapping; guessed: Record<string, number> } {
  const mapping: GuessedMapping = { companies: {}, ingredients: {}, products: {}, group1Values: ['Group 1'] };
  const guessed: Record<string, number> = {};
  for (const kind of Object.keys(tableNames) as (keyof typeof tableNames)[]) {
    let table = tableNames[kind].map(n => tables.find(t => normalized(t.name) === normalized(n))).find(Boolean);
    const exactTable = !!table;
    if (!table) table = tables.map(t => ({ t, score: overlap(t.name, tableNames[kind]) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score)[0]?.t;
    if (!table) continue;
    mapping[kind].table = table.name;
    guessed[`${kind}.table`] = exactTable ? 1 : 0.6;
    const fields = kind === 'companies' ? ['name', 'type', 'brand', 'plant']
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
  const dairy = /\b(dairy(?:[\s.,_-]*equipment)?|cholov[\s.,_-]*yisroel|cy|de|d)\b/ig;
  const meat = /\b(meat|glatt|m)\b/ig;
  const pareve = /\b(parve|pareve|p)\b/ig;
  const dpm: Dpm | undefined = meat.test(text) ? 'meat' : dairy.test(text) ? 'dairy' : pareve.test(text) ? 'pareve' : undefined;
  const agency = text.replace(dairy, '').replace(meat, '').replace(pareve, '').trim().replace(/^[\s.,_-]+|[\s.,_-]+$/g, '');
  const known = /^(ou|ok|star[\s-]*k|kof[\s-]*k|crc)$/i.test(agency);
  return { ...(agency ? { agency } : {}), ...(dpm ? { dpm } : {}), group1: false, confidence: known || (!agency && dpm) ? 1 : text.trim() ? 0.6 : 1 };
}
export function parseDpm(text: string): Dpm | undefined { return assign(text).dpm; }
export function splitCertification(text: string, group1Values: string[] = ['Group 1']): { agency?: string; dpm?: Dpm; group1: boolean } {
  const { confidence, ...value } = assign(text, group1Values);
  return { ...value, group1: value.group1 === true };
}
export function assigned(mapping: SourceMapping, column: string | undefined, value: string): ReturnType<typeof assign> {
  const values = column && Object.prototype.hasOwnProperty.call(mapping.valueAssignments || {}, column) ? mapping.valueAssignments?.[column] : undefined;
  const override = values && Object.prototype.hasOwnProperty.call(values, value) ? values[value] : undefined;
  return { ...assign(value, mapping.group1Values), ...override, ...(override ? { confidence: 1 } : {}) };
}
export function classifyRaw(mapping: SourceMapping, config: { certification?: string; agency?: string; status?: string }, raw: { certificationRaw?: string; agencyRaw?: string; statusRaw?: string }) {
  const cert = assigned(mapping, config.certification, raw.certificationRaw || '');
  const status = assigned(mapping, config.status, raw.statusRaw || '');
  const agency = assigned(mapping, config.agency, raw.agencyRaw || '');
  return { certifyingAgency: agency.agency || cert.agency, dpm: status.dpm || cert.dpm,
    group1: [cert, status, agency].some(v => v.group1 === true), confidence: Math.min(cert.confidence, status.confidence, agency.confidence) };
}
const text = (value: unknown): string | undefined => typeof value === 'string' ? value.trim() : undefined;
export function applyMapping(rows: Record<string, SourceRow[]>, mapping: SourceMapping): SourceData {
  const read = (row: SourceRow, column?: string) => column ? text(row.fields[column]) : undefined;
  const extra = (row: SourceRow, config: object) => {
    const mapped = new Set(Object.entries(config).filter(([k, v]) => k !== 'table' && typeof v === 'string').map(([, v]) => v));
    return Object.fromEntries(Object.entries(row.fields).filter(([k, v]) => !mapped.has(k) && typeof v === 'string')) as Record<string, string>;
  };
  const c = mapping.companies;
  const companies = (rows[c.table] ?? []).filter(r => !c.factoryValues?.length || c.factoryValues.some(v => folded(v) === folded(read(r, c.type) ?? '')))
    .map(r => ({ id: r.id, name: read(r, c.name) ?? '', type: read(r, c.type), brand: read(r, c.brand), plant: read(r, c.plant), extra: extra(r, c) }));
  const ids = new Set(companies.map(c => c.id));
  const names = new Map<string, string[]>();
  for (const c of companies) names.set(folded(c.name), [...(names.get(folded(c.name)) ?? []), c.id]);
  const links = (r: SourceRow, column: string) => {
    const value = r.fields[column];
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return [...new Set(values.flatMap(v => {
      const s = text(v); return !s ? [] : ids.has(s) ? [s] : names.get(folded(s)) ?? [];
    }))];
  };
  const i = mapping.ingredients, p = mapping.products;
  const ingredients = (rows[i.table] ?? []).map(r => {
    const raw = { certificationRaw: read(r, i.certification), statusRaw: read(r, i.status), agencyRaw: read(r, i.agency) };
    return { id: r.id, companyIds: links(r, i.companyLink), name: read(r, i.name) ?? '', brand: read(r, i.brand),
      ...raw, ...classifyRaw(mapping, i, raw),
      plant: read(r, i.plant), expiresOn: read(r, i.expiresOn), extra: extra(r, i) };
  });
  const products = (rows[p.table] ?? []).map(r => {
    const raw = p.symbolRequired ? r.fields[p.symbolRequired] : undefined;
    const symbolRequired = typeof raw === 'boolean' ? raw : typeof raw === 'string' && /^(yes|true|1|no|false|0)$/i.test(raw.trim()) ? /^(yes|true|1)$/i.test(raw.trim()) : undefined;
    const classifiedRaw = { certificationRaw: read(r, p.certification), statusRaw: read(r, p.status), agencyRaw: read(r, p.agency) };
    return { ...classifiedRaw, ...classifyRaw(mapping, p, classifiedRaw), id: r.id, companyIds: links(r, p.companyLink), name: read(r, p.name) ?? '', brand: read(r, p.brand),
      code: read(r, p.code), symbolRequired, plant: read(r, p.plant), extra: extra(r, p) };
  });
  return { companies, ingredients, products };
}
