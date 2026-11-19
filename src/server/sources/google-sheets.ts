import { editSheetRow } from './sheets-edit.ts';
import type { Edit, EditAudit, Target } from './tagged-row.ts';
import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector, keyRows } from './tabular.ts';
import type { SourceMapping, SourceFile } from './types.ts';
export interface TaggedTable {
    records: { key: string; metadataId: number }[];
    headers: string[];
    idHeader: string;

}
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
            if (!res.ok) {
                const body = await res.clone().json().catch(() => null);
                console.warn('[sources] Google API rejected request', {
                    service,
                    operation: path.includes('/values/') ? 'read-values' : path.includes('/spreadsheets/') ? 'read-spreadsheet' : 'other',
                    httpStatus: res.status,
                    reason: body?.error?.errors?.[0]?.reason || body?.error?.status || 'unknown',
                });
                throw Object.assign(Error('Google Sheets request failed'), { rejected: res.status >= 400 && res.status < 500 });
            }
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
    const conflict = (message: string) => Object.assign(Error(message), { status: 409 });
    // Setup requires exclusive access to the managed tab while dimensions
    // are resolved. Never use these coordinates for a record edit.
    async function tagManagedRows(table: string, primary?: string): Promise<TaggedTable> {
        const metadata = await request('sheets', sheet() +
            '?fields=sheets(properties(sheetId,title))');
        const tab = metadata.sheets?.find((s: any) => s.properties.title === table);
        if (!tab) throw conflict('Managed tab missing. Refresh the source.');
        const sheetId = tab.properties.sheetId;
        const matrix = (await request('sheets', sheet() + '/values/' +
            encodeURIComponent(range(table)) + '?valueRenderOption=UNFORMATTED_VALUE')).values || [];
        const headers: string[] = matrix[0] || [];
        const idHeader = primary || headers.find(h => typeof h === 'string' && /^id$/i.test(h));
        if (!idHeader ||
            !headers.every(h => typeof h === 'string' && h.trim()) || new Set(headers).size !== headers.length)
            throw conflict('Check the ID and mapped columns. Refresh and review the mapping.');
        const column = headers.indexOf(idHeader);
        if (column < 0 || headers.lastIndexOf(idHeader) !== column)
            throw conflict('Choose one unique ID column.');
        // The app imports displayed IDs. A number format can change an ID's text or
        // even make it look like a different record's key.
        const displayed = await values(table);
        const found = await request('sheets', sheet() + '/developerMetadata:search', {
            method: 'POST', body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: {
                metadataLocation: { sheetId }, locationMatchingStrategy: 'INTERSECTING_LOCATION',
            } }] }),
        });
        const tags = (found.matchedDeveloperMetadata || []).map((match: any) => match.developerMetadata);
        const rows = new Map<string, number>();
        const requests = [];
        let characters = tags.reduce((sum: number, tag: any) =>
            sum + tag.metadataKey.length + (tag.metadataValue || '').length, 0);
        for (let index = 1; index < matrix.length; index++) {
            if (!matrix[index].some((value: unknown) => value !== '' && value != null)) continue;
            const id = String(matrix[index][column] ?? '');
            if (id !== String(displayed[index]?.[column] ?? '').trim())
                throw conflict('Use permanent IDs that display exactly as entered. Refresh the source.');
            if (!id.trim() || rows.has(id)) throw conflict('Every data row needs a unique ID.');
            rows.set(id, index);
        }
        const existing = new Map<string, number>();
        for (const tag of tags) {
            if (tag.metadataKey !== 'recordId') continue;
            const location = tag.location?.dimensionRange;
            if (tag.visibility !== 'DOCUMENT' || location?.dimension !== 'ROWS' ||
                location.sheetId !== sheetId || location.endIndex !== location.startIndex + 1 ||
                rows.get(tag.metadataValue) !== location.startIndex || existing.has(tag.metadataValue))
                throw conflict('Record tags conflict. Review the managed tab.');
            existing.set(tag.metadataValue, tag.metadataId);
        }
        for (const [id, index] of rows) {
            if (existing.has(id)) continue;
            characters += 'recordId'.length + id.length;
            requests.push({ createDeveloperMetadata: { developerMetadata: {
                metadataKey: 'recordId', metadataValue: id, visibility: 'DOCUMENT',
                location: { dimensionRange: { sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 } },
            } } });
        }
        if (characters > 30000) throw conflict('This tab exceeds the Google Sheets metadata budget.');
        if (requests.length) {
            const result = await request('sheets', sheet() + ':batchUpdate', {
                method: 'POST', body: JSON.stringify({ requests }),
            });
            for (const reply of result.replies || []) {
                const tag = reply.createDeveloperMetadata?.developerMetadata;
                if (tag) existing.set(tag.metadataValue, tag.metadataId);
            }
        }
        const records = Array.from(rows.keys(), key => ({ key, metadataId: existing.get(key)! }));
        if (records.some(r => !Number.isSafeInteger(r.metadataId)))
            throw conflict('Record tags could not be confirmed. Refresh the source.');
        return { records, headers, idHeader };
    }
    const post = (path: string, body: unknown) => request('sheets', sheet() + path, {
        method: 'POST', body: JSON.stringify(body),
    });
    return { calls: () => calls, listTables, tagManagedRows,
        updateTaggedRow(edit: Edit, target: Target, audit: (entry: EditAudit) => Promise<void>) {
            return editSheetRow(post, edit, target, audit);
        },
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
