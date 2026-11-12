import { inflateRawSync } from 'node:zlib';
import { matrixRows } from './tabular.ts';
import { tabularConnector } from './tabular.ts';
import type { SourceMapping, SourceRow } from './types.ts';
export interface UploadedFile {
    id: string;
    name: string;
    tabs: {
        name: string;
        columns: string[];
        rows: SourceRow[];
    }[];
}
export const uploadTypeError = 'Save the file as CSV or XLSX and upload it again.';
export const uploadRowsError = 'This file has more than 5,000 rows. Split it into smaller files.';
export function parseCsv(input: string): string[][] {
    input = input.replace(/^\uFEFF/, '');
    // Count only unquoted delimiters in the first logical record.
    let quoted = false, commas = 0, semis = 0;
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '"') {
            if (quoted && input[i + 1] === '"')
                i++;
            else
                quoted = !quoted;
        }
        else if (!quoted) {
            if (c === '\r' || c === '\n')
                break;
            if (c === ',')
                commas++;
            if (c === ';')
                semis++;
        }
    }
    const delimiter = semis > commas ? ';' : ',';
    const rows: string[][] = [], row: string[] = [];
    let cell = '', inQuote = false, closed = false;
    const endCell = () => { row.push(cell); cell = ''; closed = false; };
    const endRow = () => { endCell(); rows.push(row.splice(0)); if (rows.length > 5001)
        throw Error(uploadRowsError); };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (inQuote) {
            if (c === '"') {
                if (input[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else {
                    inQuote = false;
                    closed = true;
                }
            }
            else
                cell += c;
        }
        else if (c === '"' && !cell && !closed)
            inQuote = true;
        else if (c === delimiter)
            endCell();
        else if (c === '\n' || c === '\r') {
            endRow();
            if (c === '\r' && input[i + 1] === '\n')
                i++;
        }
        else {
            if (closed && c.trim())
                throw Error('Invalid CSV');
            cell += c;
        }
    }
    if (inQuote)
        throw Error('Invalid CSV');
    if (cell || row.length || closed)
        endRow();
    return rows;
}
const decode = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (_, hex, num, name) => hex || num ? String.fromCodePoint(parseInt(hex || num, hex ? 16 : 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as any)[name]);
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1], decode(m[2])]));
const texts = (s: string) => [...s.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => decode(m[1])).join('');
function unzip(buffer: Buffer): Map<string, string> {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw Error(uploadTypeError);
    const count = buffer.readUInt16LE(eocd + 10), size = buffer.readUInt32LE(eocd + 12), start = buffer.readUInt32LE(eocd + 16);
    if (count === 65535 || start + size > eocd)
        throw Error('Invalid XLSX');
    const entries: {
        name: string;
        method: number;
        size: number;
        compressed: number;
        offset: number;
    }[] = [];
    let at = start, total = 0;
    for (let i = 0; i < count; i++) {
        if (at + 46 > eocd || buffer.readUInt32LE(at) !== 0x02014b50)
            throw Error('Invalid XLSX');
        const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24), n = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), offset = buffer.readUInt32LE(at + 42);
        total += size;
        if (total > 30 * 1024 * 1024)
            throw Error('XLSX is too large');
        if (flags & 1 || ![0, 8].includes(method) || at + 46 + n + extra + comment > eocd)
            throw Error('Invalid XLSX');
        const name = buffer.subarray(at + 46, at + 46 + n).toString('utf8');
        if (entries.some(e => e.name === name))
            throw Error('Invalid XLSX');
        entries.push({ name, method, size, compressed, offset });
        at += 46 + n + extra + comment;
    }
    const files = new Map<string, string>();
    for (const e of entries) {
        if (e.offset + 30 > start || buffer.readUInt32LE(e.offset) !== 0x04034b50)
            throw Error('Invalid XLSX');
        const p = e.offset + 30 + buffer.readUInt16LE(e.offset + 26) + buffer.readUInt16LE(e.offset + 28);
        if (p + e.compressed > start)
            throw Error('Invalid XLSX');
        const data = buffer.subarray(p, p + e.compressed), raw = e.method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) }) : data;
        if (raw.length !== e.size)
            throw Error('Invalid XLSX');
        files.set(e.name, raw.toString('utf8'));
    }
    return files;
}
export function parseXlsx(buffer: Buffer): UploadedFile['tabs'] {
    const files = unzip(buffer), workbook = files.get('xl/workbook.xml') || '', rels = files.get('xl/_rels/workbook.xml.rels') || '';
    const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)].map(m => { const a = attrs(m[1]); return [a.Id, a.Target]; }));
    const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
    const styles = files.get('xl/styles.xml') || '';
    const dateFormats = new Set([...styles.matchAll(/<numFmt\b([^>]*?)\/?\s*>/g)].filter(m => /[ydhms]/i.test((attrs(m[1]).formatCode || '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))).map(m => Number(attrs(m[1]).numFmtId)));
    const xfs = [...(styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '').matchAll(/<xf\b([^>]*?)>/g)].map(m => Number(attrs(m[1]).numFmtId));
    const date1904 = /date1904=["'](?:1|true)["']/.test(workbook);
    let total = 0;
    const tabs = [...workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)].map(m => {
        const a = attrs(m[1]), target = targets.get(a['r:id']);
        if (!target || target.includes('..') || /^https?:/.test(target))
            throw Error('Invalid XLSX');
        const xml = files.get(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
        if (xml === undefined)
            throw Error('Invalid XLSX');
        const matrix: unknown[][] = [], rowNumbers: number[] = [];
        for (const match of xml.matchAll(/<row\b([^>]*?)>([\s\S]*?)<\/row>/g)) {
            const cells: unknown[] = [];
            for (const c of match[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const ca = attrs(c[1]), body = c[2] || '';
                let index = 0;
                for (const ch of (ca.r?.match(/^[A-Z]+/)?.[0] || 'A'))
                    index = index * 26 + ch.charCodeAt(0) - 64;
                if (index > 16384)
                    throw Error('Invalid XLSX');
                const v = decode(body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] || '');
                let value = ca.t === 's' ? shared[Number(v)] || '' : ca.t === 'inlineStr' ? texts(body) : v;
                const format = xfs[Number(ca.s || 0)];
                if (!ca.t && v && (format >= 14 && format <= 22 || format >= 27 && format <= 36 || format >= 45 && format <= 47 || format >= 50 && format <= 58 || dateFormats.has(format))) {
                    const serial = Number(v);
                    if (Number.isFinite(serial))
                        value = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + (serial + (!date1904 && serial < 60 ? 1 : 0)) * 86400000).toISOString();
                }
                cells[index - 1] = value;
            }
            const rowNumber = Number(attrs(match[1]).r || matrix.length + 1);
            rowNumbers.push(rowNumber);
            matrix.push(cells);
            if (matrix.length > 5001)
                throw Error(uploadRowsError);
        }
        const parsed = matrixRows(matrix, 3 * 1024 * 1024);
        for (const r of parsed.rows)
            r.id = `r${rowNumbers[Number(r.id.slice(1)) - 1]}`;
        total += parsed.rows.length;
        if (total > 5000)
            throw Error(uploadRowsError);
        return { name: a.name, ...parsed };
    });
    if (!tabs.length)
        throw Error('Invalid XLSX');
    return tabs;
}
export function parseUpload(buffer: Buffer, name: string): UploadedFile {
    if (buffer.length > 5 * 1024 * 1024)
        throw Error('File exceeds 5 MiB');
    const tabs = /\.csv$/i.test(name) ? [{ name: name.replace(/\.csv$/i, ''), ...matrixRows(parseCsv(buffer.toString('utf8')), 3 * 1024 * 1024) }] : /\.xlsx$/i.test(name) ? parseXlsx(buffer) : (() => { throw Error(uploadTypeError); })();
    if (tabs.reduce((n, t) => n + t.rows.length, 0) > 5000)
        throw Error(uploadRowsError);
    return { id: name, name, tabs };
}
export function createUploadConnector(config: {
    mapping: SourceMapping;
    files: UploadedFile[];
}) {
    return tabularConnector('upload', config.mapping, {
        calls: () => 0,
        async listTables() { return config.files.flatMap(f => f.tabs.map(t => ({ name: t.name, columns: t.columns }))); },
        async readRows(table, file) { const found = config.files.filter(f => !file || f.id === file.id).flatMap(f => f.tabs).find(t => t.name === table); if (!found)
            throw Error('Unknown tab'); return found.rows; },
    });
}
