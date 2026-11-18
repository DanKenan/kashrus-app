import { randomUUID } from 'node:crypto';
import { updateTaggedRow, type Cell, type Change, type Edit, type EditAudit, type Target } from './tagged-row.ts';

type Post = (path: string, body: unknown) => Promise<any>;
type Grid = { sheetId: number; startRowIndex?: number; endRowIndex: number; startColumnIndex?: number; endColumnIndex: number };
type Binding = { namedRangeId: string; name: string; range: Grid };
type GridCell = { userEnteredValue?: { stringValue?: string; boolValue?: boolean; numberValue?: number; formulaValue?: string };
  effectiveValue?: unknown; effectiveFormat?: { numberFormat?: { type?: string } } };
const conflict = () => Object.assign(Error('The tagged row or its columns changed. Refresh and review.'), { status: 409 });
function cell(data?: GridCell): Cell {
  const v = data?.userEnteredValue;
  // Spill/pivot output also belongs to the sheet.
  return { raw: v?.stringValue ?? v?.boolValue ?? v?.numberValue ?? null,
    formula: v?.formulaValue ?? (!v && data?.effectiveValue ? 'derived' : undefined),
    dateSerial: data?.effectiveFormat?.numberFormat?.type === 'DATE' && (!v || typeof v.numberValue === 'number') };
}
const equalHeaders = (a: string[], b: string[]) => a.length === b.length && a.every((h,i) => h === b[i]);
const singleCell = (grid: Grid, sheetId: number, row: number, col: number) =>
  grid.sheetId === sheetId && (grid.startRowIndex ?? 0) === row && grid.endRowIndex === row + 1 &&
  (grid.startColumnIndex ?? 0) === col && grid.endColumnIndex === col + 1;

export async function editSheetRow(post: Post, edit: Edit, target: Target, audit: (entry: EditAudit) => Promise<void>) {
  const tag = { developerMetadataLookup: { metadataId: target.metadataId, metadataKey: 'recordId',
    metadataValue: target.recordId, locationType: 'ROW' } };
  const header = { a1Range: "'" + target.table.replace(/'/g, "''") + "'!1:1" };
  async function snapshot() {
    const mask = 'namedRanges,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,effectiveFormat(numberFormat(type))))))';
    const result = await post(':getByDataFilter?fields=' + encodeURIComponent(mask), { dataFilters: [tag, header] });
    const sheets = result.sheets || [];
    if (sheets.length !== 1 || sheets[0].properties.title !== target.table) throw conflict();
    const { data = [], properties } = sheets[0];
    const blocks = data.flatMap((block: any) => {
      if (block.startColumn) throw conflict();
      return (block.rowData || []).map((r: any, i: number) => ({ index: (block.startRow || 0) + i, values: r.values || [] }));
    });
    const top = blocks.filter((b: any) => b.index === 0), rows = blocks.filter((b: any) => b.index > 0);
    if (top.length !== 1 || rows.length !== 1) throw conflict();
    const headers: string[] = top[0].values.map((c: GridCell) => c.userEnteredValue?.stringValue);
    while (headers.length && headers.at(-1) === undefined) headers.pop();
    if (!headers.length || headers.some(h => typeof h !== 'string' || !h.trim()) || new Set(headers).size !== headers.length) throw conflict();
    const cells: Cell[] = rows[0].values.map(cell);
    const id = cells[headers.indexOf(edit.idHeader)];
    if (!id || id.formula || String(id.raw ?? '') !== target.recordId) throw conflict();
    const names = new Map<string, Binding>((result.namedRanges || []).map((n: Binding) => [n.namedRangeId, n]));
    return { headers, cells, sheetId: properties.sheetId, row: rows[0].index, names, metadataId: target.metadataId, recordId: target.recordId };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  function receiptAt(address: string, row: number, col: number) {
    const end = address.lastIndexOf('!'), title = address.slice(0, end);
    if (title !== target.table && title !== "'" + target.table.replace(/'/g, "''") + "'") return false;
    const [first, last = first] = address.slice(end + 1).split(':');
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(first);
    if (!match || last !== first || Number(match[2]) !== row + 1) return false;
    const column = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return column === col + 1;
  }
  const receipts = new Map<string, string>();
  const bindings: { name: string; namedRangeId: string; change: Change }[] = [];
  let dispatched: Snapshot | undefined;
  const batch = (requests: unknown[]) => post(':batchUpdate', { requests });
  const current = (s: Snapshot, c: Change) => {
    const col = s.headers.indexOf(c.header), value = s.cells[col] ?? { raw: null };
    return col >= 0 && !value.formula && value.raw === c.previous &&
      (c.rule !== 'date' || !!value.dateSerial === (typeof c.requested === 'number'));
  };
  async function apply(_target: Target, changes: readonly Change[]): Promise<'rejected' | 'applied' | 'unconfirmed'> {
    try {
      const start = await snapshot();
      if (!changes.every(c => current(start,c))) return 'rejected';
      // A DataFilter selects one dimension. Column and row tags cannot be
      // intersected in a values write. A single-cell named range lets Sheets
      // resolve both dimensions at dispatch during structural moves. A sort,
      // paste, or collaborator changing a range can still defeat its identity.
      const requests = changes.map(change => {
        const col = start.headers.indexOf(change.header), id = randomUUID();
        const name = 'Shutfey_' + id.replaceAll('-', '');
        bindings.push({ name, namedRangeId: id, change });
        return { addNamedRange: { namedRange: { name, namedRangeId: id, range: { sheetId: start.sheetId,
          startRowIndex: start.row, endRowIndex: start.row + 1, startColumnIndex: col, endColumnIndex: col + 1 } } } };
      });
      await batch(requests);
      const fresh = await snapshot();
      if (!bindings.every(({ namedRangeId, name, change }) => {
        const bound = fresh.names.get(namedRangeId);
        return current(fresh, change) && bound?.name === name &&
          singleCell(bound.range, fresh.sheetId, fresh.row, fresh.headers.indexOf(change.header));
      })) return 'rejected';
      dispatched = fresh;
    } catch { return 'rejected'; }
    try {
      const result = await post('/values:batchUpdate', { valueInputOption: 'RAW',
        data: bindings.map(({ name, change }) => ({ range: name, values: [[change.requested]] })) });
      for (const [i, binding] of bindings.entries()) {
        const address = result.responses?.[i]?.updatedRange;
        if (typeof address === 'string') receipts.set(binding.namedRangeId, address);
      }
      return result.totalUpdatedCells === changes.length && receipts.size === changes.length ? 'applied' : 'unconfirmed';
    } catch (error) {
      if ((error as { rejected?: boolean }).rejected) {
        try {
          const after = await read();
          return changes.every(c => current(after, c)) ? 'rejected' : 'unconfirmed';
        } catch { return 'unconfirmed'; }
      }
      throw error; // Lost response: the engine verifies once, without replay.
    }
  }
  async function read() {
    const s = await snapshot();
    if (dispatched && (dispatched.sheetId !== s.sheetId || !equalHeaders(dispatched.headers, s.headers) || !bindings.every(b => {
      const bound = s.names.get(b.namedRangeId);
      const col = s.headers.indexOf(b.change.header), receipt = receipts.get(b.namedRangeId);
      return (!receipt || receiptAt(receipt, s.row, col)) && bound?.name === b.name && singleCell(bound.range, s.sheetId, s.row, col);
    }))) throw conflict();
    return s;
  }
  async function recover() {
    const before = dispatched;
    const restoredHeaders: string[] = [];
    if (!before) return restoredHeaders;
    for (const b of bindings) {
      const now = await snapshot(), bound = now.names.get(b.namedRangeId);
      if (!bound || bound.name !== b.name || now.sheetId !== before.sheetId ||
          !equalHeaders([...before.headers].sort(), [...now.headers].sort())) continue;
      const col = bound.range.startColumnIndex ?? 0, header = now.headers[col];
      if (!singleCell(bound.range, now.sheetId, now.row, col) || !header || header === edit.idHeader || header === b.change.header) continue;
      const receipt = receipts.get(b.namedRangeId);
      if (!receipt || !receiptAt(receipt, now.row, col)) continue;
      const previous = before.cells[before.headers.indexOf(header)] ?? { raw: null };
      const value = now.cells[col];
      // Never infer a target by scanning for equal values. Require the exact
      // surviving binding, record identity, prior header, and our raw value.
      if (!value || value.formula || value.raw !== b.change.requested || previous.raw === value.raw ||
          previous.formula === 'derived' || bindings.some(other => other.change.header === header && other.change.requested === value.raw)) continue;
      if (!previous.formula && previous.raw === null) await post('/values/' + b.name + ':clear', {});
      else await post('/values:batchUpdate', { valueInputOption: previous.formula ? 'USER_ENTERED' : 'RAW',
        data: [{ range: b.name, values: [[previous.formula || previous.raw]] }] });
      const checked = await snapshot(), restored = checked.cells[checked.headers.indexOf(header)] ?? { raw: null };
      if (restored.formula !== previous.formula || restored.raw !== previous.raw) break;
      restoredHeaders.push(header);
    }
    return restoredHeaders;
  }
  try {
    return await updateTaggedRow(edit, target, { read, applyIfCurrent: apply, recover }, audit);
  } finally {
    if (bindings.length) await batch(bindings.map(b => ({ deleteNamedRange: { namedRangeId: b.namedRangeId } })))
      .catch(() => console.warn('[sources] Temporary Sheets edit ranges could not be removed.'));
  }
}
