import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector } from './tabular.ts';
import { defaultHeaders } from './google-sheets.ts';
import { emptyWorkbook } from './xlsx-template.ts';
import type { SourceMapping, SourceFile } from './types.ts';
export interface ExcelConfig {
    workbookId: string;
    mapping: SourceMapping;
    apiBase?: string;
    accessToken?: string;
    token?(force?: boolean): Promise<string>;
    fetchImpl?: typeof fetch;
}
export function createExcelApi(config: ExcelConfig) {
    let calls = 0;
    async function request(path: string, init: RequestInit = {}) { for (let attempt = 0; attempt < 2; attempt++) {
        const token = config.token ? await config.token(attempt === 1) : config.accessToken;
        calls++;
        const res = await sourceFetch(`${config.apiBase || 'https://graph.microsoft.com'}/v1.0${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token}` } }, config.fetchImpl);
        if (res.status === 401 && !attempt && config.token)
            continue;
        if (!res.ok)
            throw Error('Excel request failed');
        return res.status === 204 ? {} : res.json();
    } throw Error('Excel request failed'); }
    const workbook = (file?: SourceFile) => `/me/drive/items/${encodeURIComponent(file?.id || config.workbookId)}/workbook`;
    const sheet = (table: string, file?: SourceFile) => `${workbook(file)}/worksheets/${encodeURIComponent(table)}`;
    const matrices = new Map<string, unknown[][]>();
    const used = async (table: string, file?: SourceFile) => { const path = `${sheet(table, file)}/usedRange(valuesOnly=true)`; if (!matrices.has(path))
        matrices.set(path, (await request(path)).values || []); return matrices.get(path)!; };
    return { calls: () => calls,
        async listTables() { const r = await request(`${workbook()}/worksheets`), tables = []; for (const t of r.value || [])
            tables.push({ name: t.name, columns: matrixRows(await used(t.name)).columns }); return tables; },
        async readRows(table: string, file?: SourceFile) { return matrixRows(await used(table, file)).rows; },
        async writeRow(table: string, row: {
            id?: string;
            fields: Record<string, string>;
        }, file?: SourceFile) { const v = await used(table, file), parsed = matrixRows(v), n = row.id ? Number(row.id.replace(/^r/, '')) : v.length + 1; if (!Number.isInteger(n) || n < 2 || row.id && n > v.length)
            throw Error('Invalid row'); const fields = { ...(parsed.rows.find(r => r.id === row.id)?.fields || {}), ...row.fields }; let last = '', col = parsed.columns.length; while (col) {
            col--;
            last = String.fromCharCode(65 + col % 26) + last;
            col = Math.floor(col / 26);
        } await request(`${sheet(table, file)}/range(address='A${n}:${last}${n}')`, { method: 'PATCH', body: JSON.stringify({ values: [parsed.columns.map(c => String(fields[c] ?? ''))] }) }); matrices.clear(); return { id: `r${n}`, fields }; },
        async files() { const all = []; for (const path of ["/me/drive/root/search(q='.xlsx')", '/me/drive/sharedWithMe']) {
            let next = path;
            do {
                const r = await request(next);
                for (const entry of r.value || []) {
                    const f = entry.remoteItem || entry;
                    if (/\.xlsx$/i.test(f.name || ''))
                        all.push({ id: f.id, name: f.name, path: f.parentReference?.path, modifiedAt: f.lastModifiedDateTime });
                }
                next = r['@odata.nextLink'] ? new URL(r['@odata.nextLink']).pathname.replace(/^\/v1.0/, '') + new URL(r['@odata.nextLink']).search : '';
            } while (next);
        } return [...new Map(all.map(f => [f.id, f])).values()]; },
        async createFile(name: string) { const r = await request(`/me/drive/root:/${encodeURIComponent(name + '.xlsx')}:/content`, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: emptyWorkbook(defaultHeaders) as any }); return { id: r.id, name: r.name || name }; },
    };
}
export function createExcelConnector(config: ExcelConfig) { return tabularConnector('excel', config.mapping, createExcelApi(config)); }
