import { addSheetRow, editSheetRow, readSheetAddEditor, readSheetEditor } from './sheets-edit.ts';
import { isAddRecordId, isoDateFromSheetsSerial, type AddTarget, type Edit, type EditAudit, type Target } from './tagged-row.ts';
import { sourceFetch } from './http.ts';
import { matrixRows, tabularConnector, keyRows } from './tabular.ts';
import type { SourceMapping, SourceFile } from './types.ts';
type GridValue = {
    formattedValue?: string;
    effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean };
    effectiveFormat?: { numberFormat?: { type?: string } };
};
type GridData = {
    rowData?: { values?: GridValue[] }[];
    rowMetadata?: { developerMetadata?: { metadataKey: string; metadataValue: string }[] }[];
};
const effectiveValue = (cell?: GridValue) =>
    cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.effectiveValue?.boolValue;
const hasValue = (value: unknown) => value !== '' && value != null;
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
    unconfirmedAdds?(spreadsheetId: string): Promise<Set<string>>;
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
                throw Object.assign(Error('Google Sheets request failed'), { rejected: res.status >= 400 && res.status < 500 && res.status !== 408 });
            return res.status === 204 ? {} : res.json();
        }
        throw Error('Google Sheets request failed');
    }
    const sheet = (file?: SourceFile) => `/v4/spreadsheets/${encodeURIComponent(file?.id || config.spreadsheetId)}`;
    const range = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
    const matrices = new Map<string, unknown[][]>();
    async function values(table: string, file?: SourceFile) { const path = `${sheet(file)}/values/${encodeURIComponent(range(table))}`; if (!matrices.has(path))
        matrices.set(path, (await request('sheets', path)).values || []); return matrices.get(path)!; }
    async function readGridData(table: string, file?: SourceFile, expiration?: string): Promise<GridData> {
        // Fetch row tags, values and date formats together so a row move cannot
        // make a tag or date serial apply to a different record.
        const format = expiration ? ',effectiveFormat(numberFormat(type))' : '';
        const tags = config.unconfirmedAdds ? ',rowMetadata(developerMetadata(metadataKey,metadataValue))' : '';
        const query = new URLSearchParams({ ranges: range(table),
            fields: `sheets(properties(title),data(rowData(values(formattedValue,effectiveValue${format}))${tags}))` });
        const result = await request('sheets', `${sheet(file)}?${query}`);
        const tab = result.sheets?.find((entry: { properties: { title: string } }) => entry.properties?.title === table);
        if (!tab) throw Error('Google Sheets tab missing.');
        return tab.data?.[0] ?? {};
    }
    async function readGridRows(table: string, file: SourceFile | undefined, expiration: string | undefined) {
        const data = await readGridData(table, file, expiration);
        const grid = (data.rowData ?? []).map(row => row.values ?? []);
        const parsed = matrixRows(grid.map(row => row.map(cell => cell.formattedValue ?? effectiveValue(cell))));
        const index = expiration ? parsed.columns.indexOf(expiration) : -1;
        if (expiration && index >= 0) {
            for (const row of parsed.rows) {
                const cell = grid[row.rowNumber! - 1]?.[index];
                const value = cell?.effectiveValue;
                if (value?.stringValue && /^\d{4}-\d{2}-\d{2}$/.test(value.stringValue)) {
                    row.fields[expiration] = value.stringValue;
                } else if (cell?.effectiveFormat?.numberFormat?.type === 'DATE') {
                    const iso = isoDateFromSheetsSerial(value?.numberValue);
                    if (iso !== undefined) row.fields[expiration] = iso;
                }
            }
        }
        const recordTags = new Map<number, string[]>();
        for (const [index, row] of (data.rowMetadata ?? []).entries()) {
            const ids = (row.developerMetadata ?? []).filter(tag =>
                tag.metadataKey === 'recordId' && isAddRecordId(tag.metadataValue)).map(tag => tag.metadataValue);
            if (ids.length) recordTags.set(index + 1, ids);
        }
        return { ...parsed, recordTags };
    }
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
    async function blockedAddRow(table: string, idHeader: string) {
        const pending = await config.unconfirmedAdds?.(config.spreadsheetId);
        if (!pending?.size) return;
        // Read cells and tags together so the last-seen row number matches the tagged row in this snapshot.
        const { rowData = [], rowMetadata = [] } = await readGridData(table);
        const headers = rowData[0]?.values?.map(effectiveValue) ?? [];
        const column = headers.indexOf(idHeader);
        if (column < 0 || headers.lastIndexOf(idHeader) !== column) return;
        const row = rowMetadata.findIndex((metadata, index) => {
            const cells = rowData[index]?.values ?? [];
            return index > 0 && metadata.developerMetadata?.some(tag =>
                tag.metadataKey === 'recordId' && isAddRecordId(tag.metadataValue) && pending.has(tag.metadataValue)) &&
                !String(effectiveValue(cells[column]) ?? '').trim() &&
                cells.some(cell => hasValue(effectiveValue(cell)));
        });
        if (row > 0) return row + 1;
    }
    async function readIds(table: string, idHeader: string, explainBlankId?: boolean) {
        const result = await request('sheets', sheet() + '/values/' +
            encodeURIComponent(range(table)) + '?valueRenderOption=UNFORMATTED_VALUE');
        const [headers = [], ...rows]: unknown[][] = result.values || [];
        const index = headers.indexOf(idHeader);
        if (index < 0 || headers.lastIndexOf(idHeader) !== index) throw conflict('Choose one unique ID column.');
        const ids = rows.filter(row => row.some(hasValue))
            .map(row => String(row[index] ?? '').trim());
        const blankId = ids.includes('');
        if (blankId && explainBlankId) {
            const row = await blockedAddRow(table, idHeader).catch(() => undefined);
            if (row !== undefined) throw conflict('A previous Add left a row hidden in Shutfey on this tab. ' +
                `In Google Sheets, it was last seen at row ${row} on the “${table}” tab and may have moved. ` +
                `Verify which row matches the details you entered in the previous Add and check that its ${idHeader} cell is blank. ` +
                'If you can identify the row unambiguously, delete the entire row and try adding again. ' +
                'If you’re unsure which row it is, contact support before deleting anything.');
        }
        if (blankId || new Set(ids).size !== ids.length) throw conflict('Every data row needs a unique ID.');
        return ids;
    }
    return { calls: () => calls, listTables, tagManagedRows,
        readAddEditor(edit: Edit, target: AddTarget) { return readSheetAddEditor(post, edit, target); },
        addTaggedRow(edit: Edit, target: AddTarget, token: string, ledger: Parameters<typeof addSheetRow>[4], resume: boolean, revision: unknown) {
            return addSheetRow(post, edit, target, token, ledger, explainBlankId => readIds(target.table, edit.idHeader, explainBlankId), resume, revision);
        },
        readTaggedEditor(edit: Edit, target: Target) { return readSheetEditor(post, edit, target); },
        updateTaggedRow(edit: Edit, target: Target, audit: (entry: EditAudit) => Promise<void>) {
            return editSheetRow(post, edit, target, audit);
        },
        async readRows(table: string, file?: SourceFile) {
            const fileId = file?.id || config.spreadsheetId;
            const ingredients = config.mapping.ingredients;
            const expiration = ingredients.table === table && (ingredients.file?.id || config.spreadsheetId) === fileId
                ? ingredients.expiresOn : undefined;
            const grid = expiration || config.unconfirmedAdds ? await readGridRows(table, file, expiration) : undefined;
            const parsed = grid ?? matrixRows(await values(table, file));
            const primary = [config.mapping.companies, config.mapping.ingredients, config.mapping.products]
                .find(section => section.table === table && (section.file?.id || config.spreadsheetId) === fileId)?.pk ||
                parsed.columns.find(column => /^id$/i.test(column));
            const hasAdd = grid?.recordTags.size || (primary && parsed.rows.some(row => isAddRecordId(String(row.fields[primary]))));
            const blocked = hasAdd ? await config.unconfirmedAdds?.(fileId) : undefined;
            const rows = blocked?.size ? parsed.rows.filter(row =>
                !grid?.recordTags.get(row.rowNumber!)?.some(id => blocked.has(id)) &&
                !(primary && blocked.has(String(row.fields[primary])))) : parsed.rows;
            return keyRows(rows, parsed.columns, ['google_sheets', fileId, table], config.mapping);
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
