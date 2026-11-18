import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector, keyRows } from './tabular.ts';
import type { SourceMapping, SourceFile } from './types.ts';
export interface GoogleSheetsConfig {
    spreadsheetId: string;
    mapping: SourceMapping;
    apiBase?: string;
    accessToken?: string;
    token?(force?: boolean): Promise<string>;
    fetchImpl?: typeof fetch;
}
export function createGoogleSheetsApi(config: GoogleSheetsConfig) {
    let calls = 0;
    async function request(service: 'drive' | 'sheets', path: string, init: RequestInit = {}) {
        const base = config.apiBase || (service === 'drive' ? 'https://www.googleapis.com' : 'https://sheets.googleapis.com');
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = config.token ? await config.token(attempt === 1) : config.accessToken;
            calls++;
            const res = await sourceFetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token}` } }, config.fetchImpl);
            if (res.status === 401 && attempt === 0 && config.token)
                continue;
            if (!res.ok)
                throw Error('Google Sheets request failed');
            return res.status === 204 ? {} : res.json();
        }
        throw Error('Google Sheets request failed');
    }
    const sheet = (file?: SourceFile) => `/v4/spreadsheets/${encodeURIComponent(file?.id || config.spreadsheetId)}`;
    const range = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
    const matrices = new Map<string, unknown[][]>();
    async function values(table: string, file?: SourceFile) { const path = `${sheet(file)}/values/${encodeURIComponent(range(table))}`; if (!matrices.has(path))
        matrices.set(path, (await request('sheets', path)).values || []); return matrices.get(path)!; }
    async function listTables(file?: SourceFile) { const meta = await request('sheets', `${sheet(file)}?fields=sheets.properties`); const tables = []; for (const s of meta.sheets || []) {
        const table = s.properties.title;
        const v = await values(table, file);
        tables.push({ name: table, columns: matrixRows(v).columns });
    } return tables; }
    return { calls: () => calls, listTables,
        async readRows(table: string, file?: SourceFile) {
            const v = await values(table, file);
            const parsed = matrixRows(v);
            return keyRows(parsed.rows, parsed.columns, ['google_sheets', file?.id || config.spreadsheetId, table], config.mapping);
        },
        async sampleRows(table: string) {
            return matrixRows((await values(table)).slice(0,4)).rows;
        },
        async files() { const out = []; let pageToken = ''; do {
            const q = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields: 'files(id,name,modifiedTime),nextPageToken', pageSize: '100', ...(pageToken ? { pageToken } : {}) });
            const result = await request('drive', `/drive/v3/files?${q}`);
            out.push(...(result.files || []).map((f: any) => ({ id: f.id, name: f.name, modifiedAt: f.modifiedTime })));
            pageToken = result.nextPageToken || '';
        } while (pageToken); return out; },
        async createFile(name: string) { const result = await request('sheets', '/v4/spreadsheets', { method: 'POST', body: JSON.stringify({ properties: { title: name }, sheets: ['Companies', 'Ingredients', 'Products'].map(title => ({ properties: { title } })) }) }); const file = { id: result.spreadsheetId, name }; for (const [table, columns] of Object.entries(defaultHeaders))
            await request('sheets', `${sheet(file)}/values/${encodeURIComponent(`${range(table)}!A1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [columns] }) }); return file; },
    };
}
export const defaultHeaders = { Companies: ['ID', 'Name', 'Type', 'Brand', 'Plant', 'Address', 'Annual Fee', 'Supervision Fee'], Ingredients: ['ID', 'Name', 'Company', 'Brand', 'Certification', 'Status'], Products: ['ID', 'Name', 'Company', 'Brand', 'Code', 'Certification', 'Status'] };
export function createGoogleSheetsConnector(config: GoogleSheetsConfig) { return tabularConnector('google_sheets', config.mapping, createGoogleSheetsApi(config)); }
