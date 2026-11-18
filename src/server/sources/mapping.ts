import { parseMoney } from '../../lib/sourceAmount.ts';
export { parseMoney } from '../../lib/sourceAmount.ts';
import type { Company, Dpm, SourceData, SourceMapping, SourceRow, SourceTable } from './types.ts';
import { isBuiltinFieldKey, type SourceSection } from '../../lib/sourcePreview.ts';

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const folded = (s: string) => s.trim().toLowerCase();
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
  return { certifyingAgency: agency.agency || cert.agency, dpm: status.dpm || cert.dpm,
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
export function companyLinkResolver(eligible: LinkCompany[], others: LinkCompany[] = []) {
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
    if (required && link && !matches.length) throw new CompanyLinkError(`Unknown company link "${link}". Use the company's unique ID.`);
    return matches[0];
  }
  function resolve(value: unknown): string[] {
    if (Array.isArray(value)) return [...new Set(value.map(v => resolveOne(v, true)).filter((id): id is string => id !== undefined))];
    const list = typeof value === 'string' && value.includes(',');
    const whole = resolveOne(value, !list);
    if (whole !== undefined) return [whole];
    if (!list) return [];

    // Each suffix has zero, one, or multiple complete parses. Only retain a
    // successor for reconstruction when exactly one path reaches the end.
    const parts = value.split(',');
    const ways = new Uint8Array(parts.length + 1);
    const next: {id:string; end:number}[] = [];
    ways[parts.length] = 1;
    for (let start = parts.length - 1; start >= 0; start--) {
      let span = '';
      for (let end = start + 1; end <= Math.min(parts.length, start + maxParts); end++) {
        span += (end === start + 1 ? '' : ',') + parts[end - 1];
        if (!ways[end]) continue;
        const matches = candidates(span.trim());
        if (!matches.length) continue;
        ways[start] = Math.min(2,ways[start] + matches.length * ways[end]);
        if (ways[start] > 1) break;
        next[start] = {id:matches[0],end};
      }
    }
    if (ways[0] !== 1) throw new CompanyLinkError(`Cannot uniquely resolve the company list "${value}". Use a list of unique company IDs.`);
    const linked = new Set<string>();
    for (let i = 0; i < parts.length; i = next[i].end) linked.add(next[i].id);
    return [...linked];
  }
  return (value: unknown) => resolve(value).filter(id => eligibleIds.has(id));
}

export function applyMapping(rows: Record<string, SourceRow[]>, mapping: SourceMapping): SourceData {
  return mapSourceLists({
    companies: rows[mapping.companies.table],
    ingredients: rows[mapping.ingredients.table],
    products: rows[mapping.products.table],
  }, mapping);
}

export function mapSourceLists(
  rows: Partial<Record<SourceSection, SourceRow[]>>, mapping: SourceMapping,
  resolveLinks?: ReturnType<typeof companyLinkResolver>,
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
  const companies = (rows.companies ?? []).filter(r => !c.factoryValues?.length || [...c.factoryValues, ...(c.foodServiceValues ?? [])].some(v => folded(v) === folded(read(r, c.type) ?? '')))
    .map(r => ({ id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), name: read(r, c.name) ?? '', type: read(r, c.type), brand: read(r, c.brand), plant: read(r, c.plant), address: read(r, c.address), companyFee: parseMoney(read(r, c.companyFee)), mashgiachFee: parseMoney(read(r, c.mashgiachFee)), extra: extra(r, c, 'companies') }));
  const keptIds = new Set(companies.map(c => c.id));
  const otherCompanies = (rows.companies ?? []).filter(r => !keptIds.has(r.id))
    .map(r => ({ id: r.id, ...(r.sourceKey ? {sourceKey:r.sourceKey} : {}), name: read(r, c.name) ?? '', type: read(r, c.type) }));
  const links = resolveLinks ?? companyLinkResolver(companies, otherCompanies);
  const i = mapping.ingredients, p = mapping.products;
  const ingredients = (rows.ingredients ?? []).map(r => {
    const raw = { certificationRaw: read(r, i.certification), statusRaw: read(r, i.status), agencyRaw: read(r, i.agency) };
    return { id: r.id, companyIds: links(i.companyLink && r.fields[i.companyLink]), name: read(r, i.name) ?? '', brand: read(r, i.brand),
      ...raw, ...classifyRaw(mapping, i, raw),
      plant: read(r, i.plant), expiresOn: read(r, i.expiresOn), extra: extra(r, i, 'ingredients') };
  });
  const products = (rows.products ?? []).map(r => {
    const raw = p.symbolRequired ? r.fields[p.symbolRequired] : undefined;
    const symbolRequired = typeof raw === 'boolean' ? raw : typeof raw === 'string' && /^(yes|true|1|no|false|0)$/i.test(raw.trim()) ? /^(yes|true|1)$/i.test(raw.trim()) : undefined;
    const classifiedRaw = { certificationRaw: read(r, p.certification), statusRaw: read(r, p.status), agencyRaw: read(r, p.agency) };
    return { ...classifiedRaw, ...classifyRaw(mapping, p, classifiedRaw), id: r.id, companyIds: links(p.companyLink && r.fields[p.companyLink]), name: read(r, p.name) ?? '', brand: read(r, p.brand),
      code: read(r, p.code), symbolRequired, plant: read(r, p.plant), extra: extra(r, p, 'products') };
  });
  return { companies, ingredients, products, otherCompanies };
}
