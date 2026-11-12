import { sourceJson } from './http.ts';
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
    const pk = (table: string) => Object.values(config.mapping).find((c: any) => c?.table === table)?.pk || 'id';
    const row = (r: any, table: string) => ({ id: String(r[pk(table)]), fields: r });
    return tabularConnector('supabase', config.mapping, {
        calls: () => calls,
        async listTables() { const schema = await request(''); return Object.entries(schema.definitions || schema.components?.schemas || {}).map(([name, def]: [
            string,
            any
        ]) => ({ name, columns: Object.keys(def.properties || {}) })); },
        async readRows(table) { const out = []; for (let start = 0;; start += 1000) {
            const result = await request(`${encodeURIComponent(table)}?select=*`, { headers: { Range: `${start}-${start + 999}`, 'Range-Unit': 'items' } });
            if (!Array.isArray(result))
                throw Error('Invalid source rows');
            out.push(...result.map(r => row(r, table)));
            if (result.length < 1000)
                break;
        } return out; },
        async writeRow(table, input) { const query = input.id ? `?${encodeURIComponent(pk(table))}=eq.${encodeURIComponent(input.id)}` : ''; const result = await request(`${encodeURIComponent(table)}${query}`, { method: input.id ? 'PATCH' : 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(input.fields) }); if (!Array.isArray(result) || !result[0])
            throw Error('Write returned no row'); return row(result[0], table); },
    });
}
