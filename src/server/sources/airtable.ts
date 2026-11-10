import { applyMapping } from './mapping.ts';
import type { SourceConnector, SourceData, SourceMapping, SourceRow } from './types.ts';

export interface AirtableConfig { baseId: string; apiKey: string; mapping: SourceMapping; apiBase?: string; fetchImpl?: typeof fetch }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function createAirtableConnector({ baseId, apiKey, mapping, apiBase = 'https://api.airtable.com', fetchImpl = fetch }: AirtableConfig): SourceConnector {
  let count = 0, lastStart = 0;
  let queue = Promise.resolve();
  let loaded: SourceData | undefined, loading: Promise<SourceData> | undefined;
  // Serialize request starts, including metadata and retries, to stay below 5/s.
  async function request(path: string): Promise<any> {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await wait(Math.max(0, lastStart + 201 - Date.now()));
        lastStart = Date.now(); count++;
        let response: Response;
        try {
          response = await fetchImpl(`${apiBase.replace(/\/$/, '')}${path}`, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error' });
        } catch { throw new Error('Airtable request failed'); }
        finally { lastStart = Date.now(); }
        if (response.status === 429 && attempt === 0) {
          const retry = response.headers.get('Retry-After');
          const seconds = retry === null ? NaN : Number(retry);
          const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : retry ? Math.max(0, Date.parse(retry) - Date.now()) : NaN;
          await response.body?.cancel();
          await wait(Number.isFinite(delay) ? delay : 30_000);
          continue;
        }
        if (!response.ok) {
          const descriptions: Record<number, string> = { 401: 'authentication failed', 403: 'access denied', 404: 'base or table not found', 429: 'rate limit exceeded after retry' };
          await response.body?.cancel();
          throw new Error(`Airtable ${response.status}: ${descriptions[response.status] ?? 'request failed'}`);
        }
        try { return await response.json(); } catch { throw new Error('Airtable returned invalid JSON'); }
      }
    };
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function loadAll(): Promise<SourceData> {
    if (loading) return loading;
    loading = (async () => {
      const tables = new Map<string, Set<string>>();
      for (const config of [mapping.companies, mapping.ingredients, mapping.products]) {
        const columns = tables.get(config.table) ?? new Set<string>();
        for (const [field, column] of Object.entries(config)) if (field !== 'table' && typeof column === 'string') columns.add(column);
        tables.set(config.table, columns);
      }
      const rows: Record<string, SourceRow[]> = Object.create(null);
      for (const [table, columns] of tables) {
        rows[table] = [];
        let offset: string | undefined;
        const seen = new Set<string>();
        do {
          const params = new URLSearchParams({ pageSize: '100' });
          for (const column of columns) params.append('fields[]', column);
          if (offset) params.set('offset', offset);
          const page = await request(`/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}?${params}`);
          if (!Array.isArray(page.records)) throw new Error('Airtable returned invalid records');
          rows[table].push(...page.records);
          offset = page.offset;
          if (offset && (typeof offset !== 'string' || seen.has(offset))) throw new Error('Airtable returned invalid pagination');
          if (offset) seen.add(offset);
        } while (offset);
      }
      loaded = applyMapping(rows, mapping);
      return loaded;
    })();
    try { return await loading; } finally { loading = undefined; }
  }
  const data = () => loaded ? Promise.resolve(loaded) : loading ?? loadAll();
  return {
    kind: 'airtable', calls: () => count, loadAll,
    async testConnection() {
      try {
        const identity = await request('/v0/meta/whoami');
        const schema = await request(`/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
        return { ok: true, access: identity.scopes?.includes('data.records:write') ? 'readwrite' : 'read',
          tables: schema.tables.map((t: any) => ({ name: t.name, columns: t.fields.map((f: any) => f.name) })) };
      } catch (e) { return { ok: false, error: e instanceof Error && e.message.startsWith('Airtable ') ? e.message : 'Airtable connection failed' }; }
    },
    async listCompanies() { return (await data()).companies; },
    async listItems(companyId, kind) { return (kind === 'ingredient' ? (await data()).ingredients : (await data()).products).filter(i => i.companyIds.includes(companyId)); },
  };
}
