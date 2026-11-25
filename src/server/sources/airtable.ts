import { sourceFetch } from './http.ts';
import { applyMapping, mapSourceLists, companyLinkResolver, CompanyLinkError } from './mapping.ts';
import type { SourceData, SourceMapping, SourceRow } from './types.ts';

import { attachmentColumn, compatibleField, fail, recordIdPattern, tableSchema, type AirtableTable } from './write.ts';
export interface AirtableConfig { baseId: string; apiKey: string; mapping: SourceMapping; apiBase?: string; contentBase?: string; fetchImpl?: typeof fetch }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const companyFields = ['name', 'address', 'type', 'brand', 'plant'] as const;
export type AirtableCompanyField = typeof companyFields[number];
export function createAirtableConnector({ baseId, apiKey, mapping, apiBase = 'https://api.airtable.com', contentBase = 'https://content.airtable.com', fetchImpl = fetch }: AirtableConfig) {
  mapping = structuredClone(mapping);
  let count = 0, lastStart = 0;
  let queue = Promise.resolve();
  let loaded: SourceData | undefined, loading: Promise<SourceData> | undefined;
  let rawRows: Record<string, SourceRow[]> = {};
  // Serialize request starts, including metadata and retries, to stay below 5/s.
  async function request(path: string, method = 'GET', missingAllowed = false, body?: object, host = apiBase): Promise<any> {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await wait(Math.max(0, lastStart + 201 - Date.now()));
        lastStart = Date.now(); count++;
        let response: Response;
        try {
          response = await sourceFetch(`${host.replace(/\/$/, '')}${path}`, { method, headers: { Authorization: `Bearer ${apiKey}`, ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }), redirect: 'error' }, fetchImpl);
        } catch { throw new Error('Airtable request failed'); }
        finally { lastStart = Date.now(); }
        if (response.status === 429 && attempt === 0 && method !== 'POST') {
          const retry = response.headers.get('Retry-After');
          const seconds = retry === null ? NaN : Number(retry);
          const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : retry ? Math.max(0, Date.parse(retry) - Date.now()) : NaN;
          await response.body?.cancel();
          await wait(Number.isFinite(delay) ? delay : 30_000);
          continue;
        }
        if (response.status === 404 && missingAllowed) { await response.body?.cancel(); return null; }
        if (!response.ok) {
          const descriptions: Record<number, string> = { 401: 'authentication failed', 403: 'access denied', 404: 'base or table not found', 429: 'rate limit exceeded after retry' };
          await response.body?.cancel();
          throw Object.assign(Error(`Airtable ${response.status}: ${descriptions[response.status] ?? 'request failed'}`), { status: response.status, airtable: true });
        }
        try { return await response.json(); } catch { throw new Error('Airtable returned invalid JSON'); }
      }
    };
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  let schema: AirtableTable[] | undefined;
  async function readSchema() {
    if (!schema) {
      const result = await request(`/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
      if (!Array.isArray(result?.tables)) throw Error('Airtable schema unavailable.');
      schema = result.tables as AirtableTable[];
    }
    return schema;
  }
  const tablePath = (table: string) => `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  async function readRecord(table: string, id: string): Promise<SourceRow> {
    if (!recordIdPattern.test(id)) fail(403, 'Forbidden');
    const row = await request(tablePath(table) + '/' + id);
    if (row?.id !== id || !row?.fields || typeof row.fields !== 'object' || Array.isArray(row.fields))
      fail(404, 'Airtable record not found.');
    return row;
  }
  async function loadAll(): Promise<SourceData> {
    if (loading) return loading;
    loading = (async () => {
      for (const list of ['companies', 'ingredients'] as const) {
        const config = mapping[list];
        if (config.locAttachment || config.table === (list === 'companies' ? 'Establishments' : 'Ingredients List')) {
          const table = tableSchema(await readSchema(), config.table);
          config.locAttachment = attachmentColumn(table, config.locAttachment, list)?.name ?? '';
        }
      }
      const tables = new Map<string, Set<string>>();
      for (const config of [mapping.companies, mapping.ingredients, mapping.products]) {
        const columns = tables.get(config.table) ?? new Set<string>();
        for (const [field, column] of Object.entries(config)) if (field !== 'table' && typeof column === 'string' && column) columns.add(column);
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
      rawRows = rows;
      loaded = applyMapping(rows, mapping, 'ignore');
      return loaded;
    })();
    try { return await loading; } finally { loading = undefined; }
  }
  const data = () => loaded ? Promise.resolve(loaded) : loading ?? loadAll();
  let options: string[] | undefined;
  const companyPath = (id: string) => `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(mapping.companies.table)}/${encodeURIComponent(id)}`;
  return {
    typeOptions: () => options,
    readSchema, readRecord,
    patchRecord: (table: string, id: string, fields: Record<string, unknown>) =>
      request(tablePath(table) + '/' + encodeURIComponent(id), 'PATCH', false, { fields }),
    createRecord: (table: string, fields: Record<string, unknown>) => request(tablePath(table), 'POST', false, { fields }),
    uploadPdf: (id: string, column: string, filename: string, bytes: Buffer) =>
      request(tablePath(id) + '/' + encodeURIComponent(column) + '/uploadAttachment', 'POST', false,
        { contentType: 'application/pdf', filename, file: bytes.toString('base64') }, contentBase),
    async readCompany(id: string) {
      const table = tableSchema(await readSchema(), mapping.companies.table);
      const record = await readRecord(mapping.companies.table, id);
      const values: Record<string, string | null> = {};
      const warnings: string[] = [];
      for (const key of companyFields) {
        const column = mapping.companies[key];
        if (!column) continue;
        const value = record.fields[column];
        const reserved = [mapping.companies.companyFee, mapping.companies.mashgiachFee, mapping.companies.locAttachment].includes(column);
        const alias = key !== 'name' && companyFields.some(k => k !== key && mapping.companies[k] === column);
        if (reserved || alias || !compatibleField(key, table.fields.find(f => f.name === column)) || (value != null && typeof value !== 'string')) {
          if (key === 'name') fail(409, 'Map the company name to a text column.');
          warnings.push('Review the Airtable mapping for ' + key + '.');
        } else values[key] = typeof value === 'string' && value || null;
      }
      if (!values.name?.trim()) fail(409, 'A company name is required.');
      return { recordId: record.id, values, warnings };
    },
    async patchCompany(id: string, fields: Record<string, string | null>) { await request(companyPath(id), 'PATCH', false, { fields }); },
    async renameData() {
      const mapped = await data().catch(cause => {
        // A pre-existing ambiguous item link has no association to preserve.
        if (!(cause instanceof CompanyLinkError)) throw cause;
        return mapSourceLists({ companies: rawRows[mapping.companies.table] }, mapping);
      });
      const links: unknown[] = [];
      for (const section of ['companies', 'ingredients', 'products'] as const) {
        const config = mapping[section] as Record<string, unknown>;
        const columns = Object.entries(mapping.editableCustomFields?.[section] ?? {})
          .filter(([, rule]) => rule === 'companyLink').map(([field]) => config[field]);
        if (section !== 'companies') columns.push(config.companyLink);
        for (const row of rawRows[mapping[section].table])
          for (const column of columns) if (typeof column === 'string') links.push(row.fields[column]);
      }
      return { data: mapped, links };
    },
    kind: 'airtable' as const, calls: () => count, loadAll,
    async companyDeletion(id: string) {
      if (!/^rec[A-Za-z0-9]+$/.test(id)) throw Error('Invalid Airtable record ID');
      const base = `/v0/${encodeURIComponent(baseId)}`;
      const schema = await request(`/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
      const table = schema.tables.find((t: any) => t.name === mapping.companies.table || t.id === mapping.companies.table);
      if (!table?.id || !Array.isArray(table.fields)) throw Error('Company table unavailable');
      const target = `${base}/${encodeURIComponent(table.id)}/${encodeURIComponent(id)}`;
      const record = await request(target, 'GET', true);
      if (!record) return { present: false, blockers: [] };
      if (record.id !== id || !record.fields) throw Error('Company identity could not be verified');
      const blockers = new Set<string>();
      const mapped = await data();
      const resolve = companyLinkResolver(mapped.companies, mapped.otherCompanies, 'ignore');
      const labels = { companies: 'Companies', ingredients: 'Schedule A', products: 'Schedule B' };
      for (const list of ['companies', 'ingredients', 'products'] as const) {
        const config = mapping[list] as Record<string, unknown>;
        const columns = new Set(Object.entries(mapping.editableCustomFields?.[list] ?? {})
          .filter(([, rule]) => rule === 'companyLink').map(([field]) => config[field]));
        if (list !== 'companies' && config.companyLink) columns.add(config.companyLink);
        for (const row of rawRows[mapping[list].table] ?? []) {
          if (row.id === id) continue;
          for (const column of columns) {
            if (typeof column !== 'string' || !column) continue;
            try {
              if (resolve(row.fields[column]).includes(id))
                blockers.add(`${labels[list]} · ${String(row.fields[mapping[list].name ?? ''] || row.id).trim()}`);
            } catch (error) {
              if (!(error instanceof CompanyLinkError)) throw error;
              blockers.add(`Review unresolved company links in ${labels[list]}.`);
            }
          }
        }
      }
      for (const field of table.fields) {
        if (field.type === 'multipleRecordLinks' && record.fields[field.name]?.length)
          blockers.add(`Airtable linked records in ${table.name} / ${field.name}`);
      }
      // Reciprocal links appear on the company record. Scan one-way links too.
      for (const linkedTable of schema.tables) {
        const fields = linkedTable.fields.filter((field: any) =>
          field.type === 'multipleRecordLinks' && field.options?.linkedTableId === table.id &&
          !table.fields.some((inverse: any) => inverse.id === field.options?.inverseLinkFieldId));
        if (!fields.length) continue;
        const params = new URLSearchParams({ pageSize: '100' });
        for (const field of fields) params.append('fields[]', field.name);
        const seen = new Set<string>();
        for (;;) {
          const page = await request(`${base}/${encodeURIComponent(linkedTable.id)}?${params}`);
          if (!Array.isArray(page.records)) throw Error('Invalid Airtable records');
          for (const field of fields) {
            if (page.records.some((row: any) => row.id !== id && Array.isArray(row.fields?.[field.name]) && row.fields[field.name].includes(id)))
              blockers.add(`Airtable linked records in ${linkedTable.name} / ${field.name}`);
          }
          if (!page.offset) break;
          if (typeof page.offset !== 'string' || seen.has(page.offset)) throw Error('Invalid Airtable pagination');
          seen.add(page.offset);
          params.set('offset', page.offset);
        }
      }
      return { present: true, blockers: [...blockers], async remove() {
        const result = await request(target, 'DELETE');
        if (result?.id !== id || result.deleted !== true) throw Error('Company removal could not be confirmed');
      } };
    },
    async samples(tables: import('./types.ts').SourceTable[]) {
      const samples: import('./types.ts').SourceSamples = Object.create(null);
      for (const table of tables.slice(0, 15)) {
        const params = new URLSearchParams({ maxRecords: '3', cellFormat: 'string', timeZone: 'UTC', userLocale: 'en-us' });
        const page = await request(`/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table.name)}?${params}`);
        if (!Array.isArray(page.records)) throw new Error('Airtable returned invalid records');
        samples[table.name] = page.records.slice(0, 3).map((r: any) => ({ id: String(r.id), fields: Object.fromEntries(Object.entries(r.fields || {}).filter(([k]) => table.fieldTypes?.[k] !== 'multipleAttachments').map(([k, v]) => [k, String(v ?? '').trim().slice(0, 200)])) }));
      }
      return samples;
    },
    async testConnection() {
      try {
        let access: 'read' | 'readwrite';
        let offset: string | undefined;
        const seen = new Set<string>();
        for (;;) {
          const query = offset ? `?offset=${encodeURIComponent(offset)}` : '';
          const page = await request('/v0/meta/bases' + query);
          if (!Array.isArray(page?.bases) || page.bases.some((base: any) => typeof base?.id !== 'string' || !base.id))
            throw Error('Airtable returned invalid base metadata');
          offset = page.offset;
          if (offset !== undefined && (typeof offset !== 'string' || !offset || seen.has(offset)))
            throw Error('Airtable returned invalid pagination');
          const base = page.bases.find((base: any) => base.id === baseId);
          if (base) {
            access = base.permissionLevel === 'create' || base.permissionLevel === 'edit' ? 'readwrite' : 'read';
            break;
          }
          if (!offset) return { ok: false, error: 'This Airtable token cannot see the selected base.' };
          seen.add(offset);
        }
        const tables = await readSchema();
        const type = tables.find(table => table.name === mapping.companies.table || table.id === mapping.companies.table)
          ?.fields.find(field => field.name === mapping.companies.type);
        options = type?.type === 'singleSelect' ? type.options?.choices?.map((choice: any) => choice.name) : undefined;
        return { ok: true, access,
          tables: tables.map(t => ({ name: t.name, columns: t.fields.map(f => f.name), fieldTypes: Object.fromEntries(t.fields.map(f => [f.name, f.type])) })) };
      } catch (e: any) { return { ok: false, status: e.status, error: e instanceof Error && e.message.startsWith('Airtable ') ? e.message : 'Airtable connection failed' }; }
    },
    async listCompanies() { return (await data()).companies; },
    async listItems(companyId: string, kind: 'ingredient' | 'product') { return (kind === 'ingredient' ? (await data()).ingredients : (await data()).products).filter(i => i.companyIds.includes(companyId)); },
  };
}
