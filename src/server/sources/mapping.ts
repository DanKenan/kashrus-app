import type { Dpm, SourceData, SourceMapping, SourceRow, SourceTable } from './types.ts';

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const folded = (s: string) => s.trim().toLowerCase();
const synonyms: Record<string, string[]> = {
  name: ['Name', 'Item', 'Ingredient', 'Product', 'Product Name', 'Company Name', 'Establishment Name'],
  brand: ['Brand', 'Brand Name', 'Manufacturer', 'Supplier'],
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
// Partial mappings deliberately leave missing tables/columns unset for the caller to review.
export type GuessedMapping = { [K in keyof Omit<SourceMapping, 'noSymbolValues'>]: Partial<SourceMapping[K]> } & { noSymbolValues: string[] };
export function guessMapping(tables: SourceTable[]): { mapping: GuessedMapping; guessed: Record<string, number> } {
  const mapping: GuessedMapping = { companies: {}, ingredients: {}, products: {}, noSymbolValues: ['Group 1'] };
  const guessed: Record<string, number> = {};
  for (const kind of Object.keys(tableNames) as (keyof typeof tableNames)[]) {
    const table = tableNames[kind].map(n => tables.find(t => normalized(t.name) === normalized(n))).find(Boolean);
    if (!table) continue;
    mapping[kind].table = table.name;
    guessed[`${kind}.table`] = 1;
    const fields = kind === 'companies' ? ['name', 'type', 'brand', 'plant']
      : kind === 'ingredients' ? ['companyLink', 'name', 'brand', 'certification', 'agency', 'status', 'plant', 'expiresOn']
      : ['companyLink', 'name', 'brand', 'code', 'status', 'symbolRequired', 'plant'];
    const used = new Set<string>();
    for (const field of fields) {
      const column = synonyms[field].map(n => table.columns.find(c => !used.has(c) && normalized(c) === normalized(n))).find(Boolean);
      if (!column) continue;
      used.add(column);
      (mapping[kind] as Record<string, unknown>)[field] = column;
      guessed[`${kind}.${field}`] = normalized(column) === normalized(synonyms[field][0]) ? 1 : 0.9;
    }
  }
  return { mapping, guessed };
}
export function parseDpm(text: string): Dpm | undefined {
  if (/\b(meat|glatt|m)\b/i.test(text)) return 'meat';
  if (/\b(dairy|de|d)\b/i.test(text)) return 'dairy';
  if (/\b(parve|pareve|p)\b/i.test(text)) return 'pareve';
  return undefined;
}
export function splitCertification(text: string, noSymbolValues: string[] = ['Group 1']): { agency?: string; dpm?: Dpm; noSymbolNeeded: boolean } {
  if (noSymbolValues.some(v => v.toLowerCase().replace(/\s/g, '') === text.toLowerCase().replace(/\s/g, '')))
    return { noSymbolNeeded: true };
  const dpm = parseDpm(text);
  const agency = text.replace(/(?:[\s-]+)?\b(dairy|de|d|pareve|parve|p|meat|glatt|m)\b/gi, '').trim().replace(/[-\s]+$/, '');
  return { ...(agency ? { agency } : {}), ...(dpm ? { dpm } : {}), noSymbolNeeded: false };
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
    const certificationRaw = read(r, i.certification);
    const split = splitCertification(certificationRaw ?? '', mapping.noSymbolValues ?? ['Group 1']);
    const status = read(r, i.status);
    return { id: r.id, companyIds: links(r, i.companyLink), name: read(r, i.name) ?? '', brand: read(r, i.brand),
      certificationRaw, certifyingAgency: read(r, i.agency) || split.agency,
      dpm: status ? parseDpm(status) : split.dpm, noSymbolNeeded: split.noSymbolNeeded,
      plant: read(r, i.plant), expiresOn: read(r, i.expiresOn), extra: extra(r, i) };
  });
  const products = (rows[p.table] ?? []).map(r => {
    const raw = p.symbolRequired ? r.fields[p.symbolRequired] : undefined;
    const symbolRequired = typeof raw === 'boolean' ? raw : typeof raw === 'string' && /^(yes|true|1|no|false|0)$/i.test(raw.trim()) ? /^(yes|true|1)$/i.test(raw.trim()) : undefined;
    return { id: r.id, companyIds: links(r, p.companyLink), name: read(r, p.name) ?? '', brand: read(r, p.brand),
      code: read(r, p.code), dpm: parseDpm(read(r, p.status) ?? ''), symbolRequired, plant: read(r, p.plant), extra: extra(r, p) };
  });
  return { companies, ingredients, products };
}
