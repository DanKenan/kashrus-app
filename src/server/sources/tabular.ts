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
    return { columns, rows: values.slice(1).map((row, i) => ({ id: `r${i + 2}`, fields: Object.fromEntries(columns.map((c, j) => [c, cellText(row[j])])) })).filter(r => Object.values(r.fields).some(Boolean)) };
}
