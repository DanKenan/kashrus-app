import { randomUUID } from 'node:crypto';
import { updateTaggedRow, type Cell, type Change, type Edit, type EditAudit, type FieldWriteEvidence, type Target } from './tagged-row.ts';

type Post = (path: string, body: unknown) => Promise<any>;
type Grid = { sheetId: number; startRowIndex?: number; endRowIndex: number; startColumnIndex?: number; endColumnIndex: number };
type Binding = { namedRangeId: string; name: string; range: Grid };
type RejectionReason = 'cell_changed' | 'tagged_row_read_failed' | 'range_creation_failed' |
  'range_missing' | 'range_mismatch' | 'values_update_rejected';
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
  function receiptColumn(address: string, row: number) {
    const end = address.lastIndexOf('!'), title = address.slice(0, end);
    if (title !== target.table && title !== "'" + target.table.replace(/'/g, "''") + "'") return -1;
    const [first, last = first] = address.slice(end + 1).split(':');
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(first);
    if (!match || last !== first || Number(match[2]) !== row + 1) return -1;
    const column = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return column - 1;
  }
  const receipts = new Map<string, NonNullable<FieldWriteEvidence['receipt']>>();
  const bindings: { name: string; namedRangeId: string; change: Change }[] = [];
  let dispatched: Snapshot | undefined;
  let readBack: Snapshot | undefined;
  const batch = (requests: unknown[]) => post(':batchUpdate', { requests });
  const current = (s: Snapshot, c: Change) => {
    const col = s.headers.indexOf(c.header), value = s.cells[col] ?? { raw: null };
    return col >= 0 && !value.formula && value.raw === c.previous &&
      (c.rule !== 'date' || !!value.dateSerial === (typeof c.requested === 'number'));
  };
  async function apply(_target: Target, changes: readonly Change[], operationId: string): Promise<'rejected' | 'applied' | 'unconfirmed'> {
    // Temporary diagnostic for the Phase A write pilot.
    function rejectWrite(reason: RejectionReason, details?: {
      observedRangeCount?: number; idMatches?: boolean; nameMatches?: boolean; coordinatesMatch?: boolean;
    }) {
      try {
        console.warn(JSON.stringify({ severity: 'WARNING', message: '[sources] Phase A write rejected',
          operationId, reason, cellUpdateDispatched: dispatched !== undefined, ...details }));
      } catch { /* diagnostics must not affect the write outcome */ }
      return 'rejected' as const;
    }
    let exceptionReason: RejectionReason = 'tagged_row_read_failed';
    try {
      const start = await snapshot();
      if (!changes.every(c => current(start,c))) return rejectWrite('cell_changed');
      // A DataFilter selects one dimension. Column and row tags cannot be
      // intersected in a values write. A single-cell named range lets Sheets
      // resolve both dimensions at dispatch during structural moves. A sort,
      // paste, or collaborator changing a range can still defeat its identity.
      exceptionReason = 'range_creation_failed';
      const requests = changes.map(change => {
        const col = start.headers.indexOf(change.header), id = randomUUID();
        const name = 'Shutfey_' + id.replaceAll('-', '');
        bindings.push({ name, namedRangeId: id, change });
        return { addNamedRange: { namedRange: { name, namedRangeId: id, range: { sheetId: start.sheetId,
          startRowIndex: start.row, endRowIndex: start.row + 1, startColumnIndex: col, endColumnIndex: col + 1 } } } };
      });
      await batch(requests);
      exceptionReason = 'tagged_row_read_failed';
      const fresh = await snapshot();
      exceptionReason = 'range_mismatch';
      for (const { namedRangeId, name, change } of bindings) {
        const bound = fresh.names.get(namedRangeId);
        if (!current(fresh, change)) return rejectWrite('cell_changed');
        if (!bound) {
          if ([...fresh.names.values()].some(candidate => candidate.name === name))
            return rejectWrite('range_mismatch', { idMatches: false, nameMatches: true });
          return rejectWrite('range_missing', { observedRangeCount: fresh.names.size });
        }
        if (bound.name !== name) return rejectWrite('range_mismatch', { idMatches: true, nameMatches: false });
        if (!bound.range || !singleCell(bound.range, fresh.sheetId, fresh.row, fresh.headers.indexOf(change.header)))
          return rejectWrite('range_mismatch', { idMatches: true, nameMatches: true, coordinatesMatch: false });
      }
      dispatched = fresh;
    } catch { return rejectWrite(exceptionReason); }
    try {
      const result = await post('/values:batchUpdate', { valueInputOption: 'RAW',
        data: bindings.map(({ name, change }) => ({ range: name, values: [[change.requested]] })) });
      for (const [i, binding] of bindings.entries()) {
        const receipt = result.responses?.[i];
        if (typeof receipt?.updatedRange === 'string') receipts.set(binding.namedRangeId, receipt);
      }
      return result.totalUpdatedCells === changes.length && receipts.size === changes.length ? 'applied' : 'unconfirmed';
    } catch (error) {
      if ((error as { rejected?: boolean }).rejected) {
        try {
          const after = await read();
          return changes.every(c => current(after, c)) ? rejectWrite('values_update_rejected') : 'unconfirmed';
        } catch { return 'unconfirmed'; }
      }
      throw error; // Lost response: the engine verifies once, without replay.
    }
  }
  async function read() {
    readBack = undefined;
    const s = await snapshot();
    if (dispatched) readBack = s;
    if (dispatched && (dispatched.sheetId !== s.sheetId || !equalHeaders(dispatched.headers, s.headers) || !bindings.every(b => {
      const bound = s.names.get(b.namedRangeId);
      const col = s.headers.indexOf(b.change.header), receipt = receipts.get(b.namedRangeId);
      return (!receipt || receiptColumn(receipt.updatedRange, s.row) === col) && bound?.name === b.name && singleCell(bound.range, s.sheetId, s.row, col);
    }))) throw conflict();
    return s;
  }
  // A receipt identifies the physical write, but cannot tell us what a human
  // entered after our last read. Keep evidence for review without writing back.
  function writeEvidence(): FieldWriteEvidence[] {
    return bindings.map(({ name, namedRangeId, change }) => {
      const receipt = receipts.get(namedRangeId);
      const evidence: FieldWriteEvidence = { field: change.field, intendedHeader: change.header,
        attemptedValue: change.requested, ...(receipt && { receipt }) };
      if (!readBack || readBack.sheetId !== dispatched?.sheetId) return evidence;
      const bound = readBack.names.get(namedRangeId);
      const col = receipt ? receiptColumn(receipt.updatedRange, readBack.row) : (bound?.range.startColumnIndex ?? 0);
      if (!receipt && (bound?.name !== name || !singleCell(bound.range, readBack.sheetId, readBack.row, col))) return evidence;
      if (readBack.headers[col]) {
        const value = readBack.cells[col];
        evidence.readBack = { basis: receipt ? 'receipt' : 'namedRange', header: readBack.headers[col],
          rowNumber: readBack.row + 1, raw: value?.raw ?? null, ...(value?.formula && { formula: value.formula }) };
      }
      return evidence;
    });
  }
  try {
    return await updateTaggedRow(edit, target, { read, applyIfCurrent: apply, writeEvidence }, audit);
  } finally {
    if (bindings.length) await batch(bindings.map(b => ({ deleteNamedRange: { namedRangeId: b.namedRangeId } })))
      .catch(() => console.warn('[sources] Temporary Sheets edit ranges could not be removed.'));
  }
}
