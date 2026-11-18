import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector, keyRows, columnLetter, prepareSheetWrite } from './tabular.ts';
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
    const used = (table: string, file?: SourceFile) => request(`${sheet(table, file)}/usedRange(valuesOnly=true)`);
    return { calls: () => calls,
        async listTables() { const r = await request(`${workbook()}/worksheets`), tables = []; for (const t of r.value || [])
            tables.push({ name: t.name, columns: matrixRows((await used(t.name)).values || []).columns }); return tables; },
        async readRows(table: string, file?: SourceFile) {
            const rangeData = await used(table, file), v = rangeData.values || [];
            const parsed = matrixRows(v);
            return keyRows(parsed.rows, parsed.columns, ['excel', file?.id || config.workbookId, table], config.mapping);
        },
        async writeRow(table: string, row: {id?: string; fields: Record<string,string>}, file?: SourceFile) {
            const rangeData = await used(table, file), v = rangeData.values || [];
            const {columns, cells, result, rowNumber:n} = prepareSheetWrite(v, ['excel', file?.id || config.workbookId, table], config.mapping, row);
            if (cells.length) {
                const indices = cells.map(([col]) => columns.indexOf(col));
                const first = Math.min(...indices), last = Math.max(...indices);
                const values = Array<string | null>(last - first + 1).fill(null);
                cells.forEach(([,value], i) => { values[indices[i] - first] = value; });
                const address = (i:number) => columnLetter((rangeData.columnIndex ?? 0) + i) + (n + (rangeData.rowIndex ?? 0));
                const target = first === last ? address(first) : address(first) + ':' + address(last);
                await request(`${sheet(table, file)}/range(address='${target}')`, {method:'PATCH', body:JSON.stringify({values:[values]})});
            }
            return result;
        },
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
