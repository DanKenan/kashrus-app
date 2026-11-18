import { createHash, randomUUID } from 'node:crypto';
import { applyMapping } from './mapping.ts';
import type { SourceConnector, SourceFile, SourceKind, SourceMapping, SourceRow, SourceTable } from './types.ts';
export function tabularConnector(kind: SourceKind, mapping: SourceMapping, methods: {
    listTables(): Promise<SourceTable[]>;
    readRows(table: string, file?: SourceFile): Promise<SourceRow[]>;
    writeRow?(table: string, row: {
        id?: string;
        fields: Record<string, string>;
    }, file?: SourceFile): Promise<SourceRow>;
    calls(): number;
}): SourceConnector {
    const loadAll = async () => {
        const rows: Record<string, SourceRow[]> = Object.create(null), local = structuredClone(mapping);
        const loaded = new Map<string, SourceRow[]>();
        for (const list of ['companies', 'ingredients', 'products'] as const) {
            const config = local[list];
            if (!config.table)
                continue;
            const key = JSON.stringify([config.file?.id, config.table]);
            if (!loaded.has(key))
                loaded.set(key, await methods.readRows(config.table, config.file));
            rows[list] = loaded.get(key)!;
            config.table = list;
        }
        return applyMapping(rows, local);
    };
    return { kind, ...methods, loadAll,
        async testConnection() { try {
            return { ok: true, tables: await methods.listTables() };
        }
        catch {
            return { ok: false, error: 'Source connection failed' };
        } },
        async listCompanies() { return (await loadAll()).companies; },
        async listItems(id, kind) { return (kind === 'ingredient' ? (await loadAll()).ingredients : (await loadAll()).products).filter(i => i.companyIds.includes(id)); },
        async samples(tables) { const samples = Object.create(null); for (const t of tables)
            samples[t.name] = (await methods.readRows(t.name)).slice(0, 3).map(r => ({ id: r.id, fields: Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, String(v ?? '')])) })); return samples; },
    };
}
export function headerNames(values: unknown[]): string[] {
    const used = new Set<string>();
    return values.map((v, i) => { const name = cellText(v) || `Column ${i + 1}`; let unique = name, n = 2; while (used.has(unique))
        unique = `${name} (${n++})`; used.add(unique); return unique; });
}
export const cellText = (v: unknown) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 2000);
export function matrixRows(values: unknown[][], maxBytes = Infinity): {
    columns: string[];
    rows: SourceRow[];
} {
    const width = Math.max(0, ...values.map(r => r.length));
    const tooBig = () => { throw Error('This file is too big to copy. Split it into smaller files.'); };
    if (width * Math.max(1, values.length - 1) * 5 > maxBytes)
        tooBig();
    const columns = headerNames(Array.from({ length: width }, (_, i) => values[0]?.[i]));
    if (Number.isFinite(maxBytes)) {
        const keys = columns.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)) + 4, 0);
        let bytes = keys;
        for (const row of values.slice(1)) {
            bytes += keys + 40;
            for (const cell of row)
                bytes += Buffer.byteLength(JSON.stringify(cellText(cell)));
            if (bytes > maxBytes * 2)
                tooBig();
        }
    }
    return { columns, rows: values.slice(1).map((row, i) => ({ id: randomUUID(), rowNumber: i + 2, fields: Object.fromEntries(columns.map((c, j) => [c, cellText(row[j])])) })).filter(r => Object.values(r.fields).some(Boolean)) };
}

export function columnLetter(index: number): string {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
        name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
}

export function keyRows(rows: SourceRow[], columns: string[], scope: string[], mapping?: SourceMapping, uploadVersion?: string) {
    const config = mapping && [mapping.companies, mapping.ingredients, mapping.products].find(c =>
        c.table === scope[2] && (!c.file || c.file.id === scope[1]));
    const primary = config?.pk || columns.find(c => /^id$/i.test(c));
    if (!uploadVersion && (!primary || !columns.includes(primary) || !/^id$/i.test(primary))) {
        throw Object.assign(Error('Each spreadsheet tab needs a dedicated ID column with permanent, unique record keys.'), {status:400});
    }
    const validPrimary = primary && rows.every(r => String(r.fields[primary] ?? '').trim()) &&
        new Set(rows.map(r => r.fields[primary])).size === rows.length;
    if (!validPrimary && !uploadVersion) throw Object.assign(Error('Every spreadsheet row needs a unique, non-empty ID.'), {status:400});
    const versioned = uploadVersion && !validPrimary;
    const seen = new Set<string>();
    for (const row of rows) {
        const keys = primary ? [primary] : [];
        const values = keys.map(col => row.fields[col]);
        const key = versioned ? [uploadVersion, row.id] : values;
        if (primary && !versioned) row.sourceKey = String(row.fields[primary]);
        row.id = createHash('sha256').update(JSON.stringify([scope, versioned ? null : keys, key])).digest('base64url');
        if (seen.has(row.id)) throw Error('Duplicate record key.');
        seen.add(row.id);
    }
    return rows;
}

export function prepareSheetWrite(matrix: unknown[][], scope: string[], mapping: SourceMapping,
    input: { id?: string; fields: Record<string,string> }) {
    const { columns, rows } = matrixRows(matrix);
    keyRows(rows, columns, scope, mapping);
    const old = rows.find(row => row.id === input.id);
    if (input.id && !old) throw Error('Record is no longer available.');
    const changes = { ...input.fields };
    const primary = [mapping.companies, mapping.ingredients, mapping.products].find(c =>
        c.table === scope[2] && (!c.file || c.file.id === scope[1]))?.pk || columns.find(c => /^id$/i.test(c));
    if (!input.id && primary && !changes[primary]) changes[primary] = randomUUID();
    const fields = { ...old?.fields, ...changes };
    const [result] = keyRows([{id:'', fields}], columns, scope, mapping);
    if (old ? old.id !== result.id : rows.some(row => row.id === result.id))
        throw Error('A unique, unchanged record key is required.');
    const cells = Object.entries(changes).filter(([column,value]) =>
        columns.includes(column) && old?.fields[column] !== value);
    return { columns, cells, result, rowNumber: old?.rowNumber ?? matrix.length + 1 };
}
