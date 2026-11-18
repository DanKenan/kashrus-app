import { feeAlreadySet } from './tagged-row.ts';
import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector, keyRows } from './tabular.ts';
import type { SourceMapping, SourceFile } from './types.ts';
export interface SheetsFeePilot {
    records: { key: string; metadataId: number }[];
    headers: string[];
    idHeader: string;
    feeHeader: string;
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
            if (!res.ok)
                throw Object.assign(Error('Google Sheets request failed'), { rejected: res.status >= 400 && res.status < 500 });
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
    async function tagManagedRows(table: string, feeHeader: string, primary?: string): Promise<SheetsFeePilot> {
        const metadata = await request('sheets', sheet() +
            '?fields=sheets(properties(sheetId,title))');
        const tab = metadata.sheets?.find((s: any) => s.properties.title === table);
        if (!tab) throw conflict('Managed tab missing. Refresh the source.');
        const sheetId = tab.properties.sheetId;
        const matrix = (await request('sheets', sheet() + '/values/' +
            encodeURIComponent(range(table)) + '?valueRenderOption=UNFORMATTED_VALUE')).values || [];
        const headers: string[] = matrix[0] || [];
        const idHeader = primary || headers.find(h => typeof h === 'string' && /^id$/i.test(h));
        if (!idHeader || !headers.includes(feeHeader) || feeHeader === idHeader ||
            !headers.every(h => typeof h === 'string' && h.trim()) || new Set(headers).size !== headers.length)
            throw conflict('Check the ID and Fee columns. Refresh and review the mapping.');
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
        return { records, headers, idHeader, feeHeader };
    }
    async function saveFee(edit: {
        metadataId: number; table: string; headers: string[]; idHeader: string;
        feeHeader: string; recordId: string; fee: number;
        beforeWrite?(previous: unknown): Promise<void>;
    }) {
        const { metadataId, table, headers, idHeader, feeHeader, recordId, fee } = edit;
        const idColumn = headers.indexOf(idHeader);
        const feeColumn = headers.indexOf(feeHeader);
        if (!Number.isSafeInteger(metadataId) || metadataId <= 0 || !recordId.trim())
            throw conflict('Missing record tag or ID. Refresh the source.');
        if (!Number.isFinite(fee) || fee < 0 || feeColumn < 0 || idColumn < 0 ||
            idColumn === feeColumn || new Set(headers).size !== headers.length)
            throw conflict('Check the fee and mapped columns.');
        const dataFilter = { developerMetadataLookup: { metadataId } };
        const post = (path: string, body: unknown) => request('sheets', sheet() + path, {
            method: 'POST', body: JSON.stringify(body),
        });
        const headerFilter = { a1Range: range(table) + '!1:1' };
        const read = async () => {
            // Read the headers and the tagged row in the same provider response.
            const result = await post('/values:batchGetByDataFilter', {
                dataFilters: [dataFilter, headerFilter], valueRenderOption: 'FORMULA',
            });
            const ranges: any[] = result.valueRanges || [];
            const header = ranges.find(r => r.dataFilters?.some((f: any) => f.a1Range === headerFilter.a1Range));
            if (JSON.stringify(header?.valueRange?.values?.[0]) !== JSON.stringify(headers))
                throw conflict('Columns changed. Refresh and review the mapping.');
            const matches = ranges.filter(r => r.dataFilters?.some((f: any) => f.developerMetadataLookup?.metadataId === metadataId));
            const rowRange = matches[0]?.valueRange;
            const address: string = rowRange?.range || '';
            const tabName = address.slice(0, address.lastIndexOf('!'));
            if (matches.length !== 1 || rowRange?.values?.length !== 1 || (tabName !== range(table) && tabName !== table))
                throw conflict('Record tag missing or ambiguous. Refresh the source.');
            const row = rowRange.values[0];
            if (String(row[idColumn] ?? '') !== recordId)
                throw conflict('Record ID changed. Refresh the source.');
            return row[feeColumn];
        };
        const previous = await read();
        if (typeof previous === 'string' && previous.startsWith('='))
            throw conflict('This fee contains a formula.');
        if (feeAlreadySet(previous, fee))
            throw conflict('The Fee is already set to this amount. Refresh to see the current value.');
        const values = [Array(feeColumn).fill(null).concat(fee)];
        await edit.beforeWrite?.(previous ?? null);
        let result;
        try {
            result = await post('/values:batchUpdateByDataFilter', {
                valueInputOption: 'RAW', data: [{ dataFilter, values }],
            });
        } catch (cause) {
            if ((cause as { rejected?: boolean }).rejected)
                throw conflict('Google Sheets rejected the Fee edit. Refresh and check your access.');
            // The write may already have landed. Verify once without sending it again.
        }
        try {
            const currentFee = await read();
            if (currentFee !== fee || (result && (result.totalUpdatedRows !== 1 || result.totalUpdatedCells !== 1)))
                throw Error();
        } catch {
            throw Object.assign(conflict('Fee save could not be confirmed. The value may be in another cell. Refresh and review the sheet before retrying.'), { unconfirmed: true });
        }
        return previous ?? null;
    }
    return { calls: () => calls, listTables, tagManagedRows, saveFee,
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
