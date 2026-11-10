import { createHash } from 'node:crypto';
import type { Company, Ingredient, Product, SourceConnector, SourceData } from './types.ts';

export interface Backup {
  v: 1; agencyId: string; companyId: string; companyName: string; takenAt: string; hash: string;
  ingredients: { name: string; brand: string; certifyingAgency: string; dpm: string; noSymbolNeeded: boolean; plant: string }[];
  products: { name: string; brand: string; code: string; dpm: string; plant: string }[];
}
export interface SourceState {
  status: 'never' | 'ok' | 'stale' | 'backup' | 'error'; refreshedAt?: string; calls: number;
  companies: Company[]; itemsFor(companyId: string, kind: 'ingredient' | 'product'): (Ingredient | Product)[];
  backupTakenAt?: string; error?: string;
}
export interface RefreshResult { ok: boolean; calls: number; changedBackups: Backup[]; error?: string }
export interface SourceCacheConfig {
  connectorFor(agencyId: string): SourceConnector | Promise<SourceConnector>;
  backups: { load(agencyId: string): Promise<Backup[]> }; now?: () => number;
}
// Only whitelisted scalar text is copied. URLs and attachment structures never enter backups.
const safeText = (value: unknown): string => typeof value === 'string' && !/(?:https?:\/\/|www\.|data:|ftp:\/\/)/i.test(value) ? value : '';
function makeBackups(agencyId: string, data: SourceData, takenAt: string): Backup[] {
  return data.companies.map(c => {
    const content = {
      companyName: safeText(c.name),
      ingredients: data.ingredients.filter(i => i.companyIds.includes(c.id)).map(i => ({
        name: safeText(i.name), brand: safeText(i.brand), certifyingAgency: safeText(i.certifyingAgency),
        dpm: safeText(i.dpm), noSymbolNeeded: i.noSymbolNeeded === true, plant: safeText(i.plant),
      })),
      products: data.products.filter(p => p.companyIds.includes(c.id)).map(p => ({
        name: safeText(p.name), brand: safeText(p.brand), code: safeText(p.code), dpm: safeText(p.dpm), plant: safeText(p.plant),
      })),
    };
    for (const items of [content.ingredients, content.products]) items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return { v: 1, agencyId, companyId: c.id, takenAt, hash, ...content };
  });
}
export function createSourceCache({ connectorFor, backups, now = Date.now }: SourceCacheConfig) {
  const entries = new Map<string, { state: SourceState; data?: SourceData; backupLoaded: boolean; hashes: Map<string, string> }>();
  const flights = new Map<string, Promise<RefreshResult>>();
  function entry(id: string) {
    if (!entries.has(id)) entries.set(id, { state: { status: 'never', calls: 0, companies: [], itemsFor: () => [] }, backupLoaded: false, hashes: new Map() });
    return entries.get(id)!;
  }
  function publish(id: string, data: SourceData, status: SourceState['status'], fields: Partial<SourceState>) {
    const e = entry(id); e.data = data;
    e.state = { status, calls: 0, companies: data.companies,
      itemsFor: (companyId, kind) => (kind === 'ingredient' ? data.ingredients : data.products).filter(i => i.companyIds.includes(companyId)), ...fields };
  }
  async function run(id: string): Promise<RefreshResult> {
    const e = entry(id);
    let connector: SourceConnector | undefined, start = 0;
    try {
      connector = await connectorFor(id); start = connector.calls();
      let data: SourceData;
      if (connector.loadAll) data = await connector.loadAll();
      else {
        const companies = await connector.listCompanies();
        const ingredients = new Map<string, Ingredient>(), products = new Map<string, Product>();
        for (const c of companies) {
          for (const i of await connector.listItems(c.id, 'ingredient')) ingredients.set(i.id, i as Ingredient);
          for (const p of await connector.listItems(c.id, 'product')) products.set(p.id, p as Product);
        }
        data = { companies, ingredients: [...ingredients.values()], products: [...products.values()] };
      }
      const calls = connector.calls() - start, refreshedAt = new Date(now()).toISOString();
      const all = makeBackups(id, data, refreshedAt);
      const changedBackups = all.filter(b => e.hashes.get(b.companyId) !== b.hash);
      publish(id, data, 'ok', { calls, refreshedAt });
      // A successful refresh establishes the baseline; persisted hashes can override it.
      e.hashes = new Map(all.map(b => [b.companyId, b.hash]));
      return { ok: true, calls, changedBackups };
    } catch (cause) {
      const error = cause instanceof Error && cause.message.startsWith('Airtable ') ? cause.message : 'Source refresh failed', calls = connector ? connector.calls() - start : 0;
      if (e.data) e.state = { ...e.state, status: e.state.status === 'backup' ? 'backup' : 'stale', calls, error };
      else {
        if (!e.backupLoaded) {
          e.backupLoaded = true;
          try {
            const saved = (await backups.load(id)).filter(b => b.v === 1 && b.agencyId === id);
            if (saved.length) {
              const data: SourceData = { companies: [], ingredients: [], products: [] };
              for (const b of saved) {
                data.companies.push({ id: b.companyId, name: safeText(b.companyName), extra: {} });
                for (const [kind, items] of [['ingredients', b.ingredients], ['products', b.products]] as const) {
                  items.forEach((item, index) => {
                    const base = { id: `backup:${b.companyId}:${kind}:${index}`, companyIds: [b.companyId], name: safeText(item.name), brand: safeText(item.brand),
                      dpm: ['dairy', 'pareve', 'meat'].includes(item.dpm) ? item.dpm as Ingredient['dpm'] : undefined, plant: safeText(item.plant), extra: {} };
                    if (kind === 'ingredients') data.ingredients.push({ ...base, certifyingAgency: safeText('certifyingAgency' in item ? item.certifyingAgency : ''), noSymbolNeeded: 'noSymbolNeeded' in item && item.noSymbolNeeded === true });
                    else data.products.push({ ...base, code: safeText('code' in item ? item.code : '') });
                  });
                }
              }
              publish(id, data, 'backup', { calls, error, backupTakenAt: saved.map(b => b.takenAt).sort()[0] });
            }
          } catch { /* Backup failures also leave the cache in a usable error state. */ }
        }
        if (!e.data) e.state = { ...e.state, status: 'error', calls, error };
      }
      return { ok: false, calls, changedBackups: [], error };
    }
  }
  return {
    state: (agencyId: string): SourceState => entry(agencyId).state,
    setKnownHashes(agencyId: string, hashes: ReadonlyMap<string, string> | Record<string, string>) {
      entry(agencyId).hashes = new Map(hashes instanceof Map ? hashes : Object.entries(hashes));
    },
    refresh(agencyId: string): Promise<RefreshResult> {
      const active = flights.get(agencyId); if (active) return active;
      const flight = run(agencyId).finally(() => flights.delete(agencyId));
      flights.set(agencyId, flight); return flight;
    },
  };
}
export function nextNightlyRun(nowMs: number, timeZone: string, hour = 3): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Invalid nightly hour');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // Search real instants, so missing and repeated local hours across DST are handled.
  // A skipped hour runs at the first available local time after that hour.
  const parts = (ms: number) => Object.fromEntries(format.formatToParts(ms).map(p => [p.type, p.value]));
  let previous = parts(nowMs);
  for (let ms = Math.floor(nowMs / 60_000) * 60_000 + 60_000; ms <= nowMs + 72 * 3600_000; ms += 60_000) {
    const p = parts(ms);
    const sameDate = p.year === previous.year && p.month === previous.month && p.day === previous.day;
    if ((Number(p.hour) === hour && p.minute === '00') || (sameDate && Number(previous.hour) < hour && Number(p.hour) > hour)) return ms;
    previous = p;
  }
  throw new Error('Unable to determine nightly run');
}
