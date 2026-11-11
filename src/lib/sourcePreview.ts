import type { SourceMapping } from './sources';

type Dpm = 'meat' | 'dairy' | 'pareve';
export type SourceSamples = Record<string, { id: string; fields: Record<string, string> }[]>;

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

export function previewRows(samples: SourceSamples, mapping: SourceMapping, group: 'companies' | 'ingredients' | 'products', group1Label = 'Group 1'): { header: string[]; rows: string[][]; chips: string[][][] } {
  const config = mapping[group];
  const optional = ['brand', 'plant', ...(group === 'ingredients' ? ['expiresOn'] : [])].filter(key => config[key as keyof typeof config]);
  const header = group === 'companies' ? ['Company', 'Type', 'Counts as factory', 'Brand', 'Plant']
    : [...(group === 'ingredients' ? ['Ingredient', 'Certification', 'Status', 'Agency', group1Label, 'Company'] : ['Product', 'Code', 'Certification', 'Status', 'Agency', 'Symbol required', group1Label, 'Company']), ...optional.map(key => ({ brand: 'Brand', plant: 'Plant', expiresOn: 'Expiration' })[key])];
  const chips: string[][][] = [];
  const rows = (samples[config.table] || []).slice(0, 3).map(row => {
    const read = (key: string) => row.fields[(config as unknown as Record<string, string>)[key]]?.trim() || '';
    const dpmLabel = (value?: Dpm) => value ? value[0].toUpperCase() + value.slice(1) : '';
    let cells: string[];
    if (group === 'companies') {
      const types = mapping.companies.factoryValues;
      const factory = !types?.length || types.some(value => value.trim().toLowerCase() === read('type').toLowerCase());
      cells = [read('name'), read('type'), factory ? 'Yes' : 'No', read('brand'), read('plant')];
    } else {
      const raw = { certificationRaw: read('certification'), statusRaw: read('status'), agencyRaw: read('agency') };
      const result = classifyRaw(mapping, mapping[group], raw);
      const symbol = read('symbolRequired');
      cells = group === 'ingredients'
        ? [read('name'), raw.certificationRaw, raw.statusRaw, raw.agencyRaw, result.group1 ? 'Yes' : '—', read('companyLink'), ...optional.map(read)]
        : [read('name'), read('code'), raw.certificationRaw, raw.statusRaw, raw.agencyRaw, /^(yes|true|1|no|false|0)$/i.test(symbol) ? (/^(yes|true|1)$/i.test(symbol) ? 'Yes' : 'No') : '', result.group1 ? 'Yes' : '—', read('companyLink'), ...optional.map(read)];
      const rowChips = cells.map(() => [] as string[]);
      for (const [offset, field] of ['certification', 'status', 'agency'].entries()) {
        const value = assigned(mapping, mapping[group][field as 'certification' | 'status' | 'agency'], read(field), group === 'ingredients' ? 'ingredient' : 'product');
        rowChips[(group === 'ingredients' ? 1 : 2) + offset] = [value.agency ? `Agency: ${value.agency}` : '', dpmLabel(value.dpm), value.group1 ? group1Label : '', value.confidence < 0.8 ? 'Check' : ''].filter(Boolean);
      }
      chips.push(rowChips);
    }
    return cells.map(value => value || '—');
  });
  return { header, rows, chips };
}
