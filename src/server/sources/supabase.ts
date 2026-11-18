import { sourceJson, sourceFetch } from './http.ts';
import { tabularConnector } from './tabular.ts';
import type { SourceMapping } from './types.ts';
export const validSupabaseUrl = (url: string) => /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url);
export interface SupabaseConfig {
    url: string;
    apiKey?: string;
    mapping: SourceMapping;
    apiBase?: string;
    fetchImpl?: typeof fetch;
}
export function createSupabaseConnector(config: SupabaseConfig) {
    if (!validSupabaseUrl(config.url))
        throw Error('Invalid Supabase URL');
    let calls = 0;
    const request = (path: string, init: RequestInit = {}) => { calls++; return sourceJson(`${config.apiBase || config.url}/rest/v1/${path}`, { ...init, headers: { apikey: config.apiKey || '', Authorization: `Bearer ${config.apiKey || ''}`, 'Content-Type': 'application/json', ...init.headers } }, config.fetchImpl); };
    let schema: Promise<any> | undefined;
    const definitions = async () => {
        const doc = await (schema ??= request(''));
        return doc.definitions || doc.components?.schemas || {};
    };
    async function primaryKey(table: string) {
        const definition = (await definitions())[table];
        const keys = Object.entries(definition?.properties || {}).filter(([,property]: [string, any]) =>
            /<pk\/>/.test(property.description || '')).map(([name]) => name);
        const configured = Object.values(config.mapping).find((c:any) => c?.table === table)?.pk;
        if (keys.length !== 1 || configured && configured !== keys[0]) throw Error('A verified single-column primary key is required.');
        return keys[0];
    }
    function row(r:any, key:string) {
        const value = r?.[key];
        if (!(typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isSafeInteger(value))) throw Error('Invalid record key.');
        return {id:String(value), fields:r};
    }
    return tabularConnector('supabase', config.mapping, {
        calls: () => calls,
        async listTables() {
            return Object.entries(await definitions()).map(([name, def]:[string,any]) => ({name, columns:Object.keys(def.properties || {})}));
        },
        async readRows(table) {
            const key = await primaryKey(table), seen = new Set<string>(), out = [];
            for (;;) {
                const start = out.length;
                const params = new URLSearchParams({select:'*', order:JSON.stringify(key) + '.asc', offset:String(start), limit:'1000'});
                calls++;
                const response = await sourceFetch(`${config.apiBase || config.url}/rest/v1/${encodeURIComponent(table)}?${params}`, {headers:{
                    apikey:config.apiKey || '', Authorization:`Bearer ${config.apiKey || ''}`, Prefer:'count=exact'
                }}, config.fetchImpl);
                if (!response.ok) throw Error('Source request failed');
                const page = await response.json();
                const range = response.headers.get('content-range')?.match(/^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/);
                if (!Array.isArray(page) || !range || (page.length && (Number(range[1]) !== start || Number(range[2]) !== start + page.length - 1))) throw Error('Invalid source page.');
                for (const raw of page) {
                    const entry = row(raw,key);
                    if (seen.has(entry.id)) throw Error('Duplicate record key.');
                    seen.add(entry.id);
                    out.push(entry);
                }
                if (range[3] !== '*' && out.length === Number(range[3])) break;
                if (!page.length) {
                    if (range[3] !== '*') throw Error('Incomplete source page.');
                    break;
                }
            }
            return out;
        },
        async writeRow(table, input) { const key = await primaryKey(table); const query = input.id ? `?${encodeURIComponent(key)}=eq.${encodeURIComponent(input.id)}` : ''; const result = await request(`${encodeURIComponent(table)}${query}`, { method: input.id ? 'PATCH' : 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(input.fields) }); if (!Array.isArray(result) || result.length !== 1)
            throw Error('Write returned no row'); return row(result[0], key); },
    });
}
