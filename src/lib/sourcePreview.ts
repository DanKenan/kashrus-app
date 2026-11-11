import type { SourceMapping } from './sources';

type Dpm = 'meat' | 'dairy' | 'pareve';
export type SourceSamples = Record<string, { id: string; fields: Record<string, string> }[]>;

export function parseDpm(text: string): Dpm | undefined {
  if (/\b(meat|glatt|m)\b/i.test(text)) return 'meat';
  if (/\b(dairy|de|d)\b/i.test(text)) return 'dairy';
  if (/\b(parve|pareve|p)\b/i.test(text)) return 'pareve';
  return undefined;
}
export function splitCertification(text: string, group1Values: string[] = ['Group 1']): { agency?: string; dpm?: Dpm; group1: boolean } {
  if (group1Values.some(v => v.toLowerCase().replace(/\s/g, '') === text.toLowerCase().replace(/\s/g, '')))
    return { group1: true };
  const dpm = parseDpm(text);
  const agency = text.replace(/(?:[\s-]+)?\b(dairy|de|d|pareve|parve|p|meat|glatt|m)\b/gi, '').trim().replace(/[-\s]+$/, '');
  return { ...(agency ? { agency } : {}), ...(dpm ? { dpm } : {}), group1: false };
}

export function previewRows(samples: SourceSamples, mapping: SourceMapping, group: 'companies' | 'ingredients' | 'products', group1Label = 'Group 1'): { header: string[]; rows: string[][] } {
  const config = mapping[group];
  const optional = ['brand', 'plant', ...(group === 'ingredients' ? ['expiresOn'] : [])].filter(key => config[key as keyof typeof config]);
  const header = group === 'companies' ? ['Company', 'Type', 'Counts as factory', 'Brand', 'Plant']
    : [...(group === 'ingredients' ? ['Ingredient', 'Agency', 'D/P/M', group1Label, 'Company'] : ['Product', 'Code', 'D/P/M', 'Symbol required', group1Label, 'Company']), ...optional.map(key => ({ brand: 'Brand', plant: 'Plant', expiresOn: 'Expiration' })[key])];
  const rows = (samples[config.table] || []).slice(0, 3).map(row => {
    const read = (key: string) => row.fields[(config as unknown as Record<string, string>)[key]]?.trim() || '';
    const dpmLabel = (value?: Dpm) => value ? value[0].toUpperCase() + value.slice(1) : '';
    let cells: string[];
    if (group === 'companies') {
      const types = mapping.companies.factoryValues;
      const factory = !types?.length || types.some(value => value.trim().toLowerCase() === read('type').toLowerCase());
      cells = [read('name'), read('type'), factory ? 'Yes' : 'No', read('brand'), read('plant')];
    } else if (group === 'ingredients') {
      const split = splitCertification(read('certification'), mapping.group1Values);
      cells = [read('name'), read('agency') || split.agency || '', dpmLabel(read('status') ? parseDpm(read('status')) : split.dpm), (split.group1 || splitCertification(read('status'), mapping.group1Values).group1) ? 'Yes' : '—', read('companyLink'), ...optional.map(read)];
    } else {
      const symbol = read('symbolRequired');
      cells = [read('name'), read('code'), dpmLabel(parseDpm(read('status'))), /^(yes|true|1|no|false|0)$/i.test(symbol) ? (/^(yes|true|1)$/i.test(symbol) ? 'Yes' : 'No') : '', splitCertification(read('status'), mapping.group1Values).group1 ? 'Yes' : '—', read('companyLink'), ...optional.map(read)];
    }
    return cells.map(value => value || '—');
  });
  return { header, rows };
}
