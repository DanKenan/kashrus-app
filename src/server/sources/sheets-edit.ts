import { createHash, randomUUID } from 'node:crypto';
import { addedRowHash, describeTaggedEdit, planTaggedAdd, updateTaggedRow, type AddAudit, type AddTarget, type Cell, type Change, type Edit, type EditAudit, type FieldWriteEvidence, type Target } from './tagged-row.ts';

type Post = (path: string, body: unknown) => Promise<any>;
type Grid = { sheetId?: number; startRowIndex?: number; endRowIndex: number; startColumnIndex?: number; endColumnIndex: number };
type Binding = { namedRangeId: string; name: string; range: Grid };
type GridCell = { userEnteredValue?: { stringValue?: string; boolValue?: boolean; numberValue?: number; formulaValue?: string };
  effectiveValue?: unknown; effectiveFormat?: { numberFormat?: { type?: string } } };
const conflict = () => Object.assign(Error('The tagged row or its columns changed. Refresh and review.'), { status: 409 });
function cell(data?: GridCell): Cell {
  const v = data?.userEnteredValue;
  // Spill/pivot output also belongs to the sheet.
  return { raw: v?.stringValue ?? v?.boolValue ?? v?.numberValue ?? null,
    formula: v?.formulaValue ?? (!v && data?.effectiveValue ? 'derived' : undefined),
    dateSerial: data?.effectiveFormat?.numberFormat?.type === 'DATE' && (!v || v.stringValue === '' || typeof v.numberValue === 'number') };
}
const tabRange = (table: string) => "'" + table.replace(/'/g, "''") + "'";
function readHeaders(values: GridCell[]): string[] {
  const headers = values.map(c => c.userEnteredValue?.stringValue);
  while (headers.length && headers.at(-1) === undefined) headers.pop();
  if (!headers.length || headers.some(h => typeof h !== 'string' || !h.trim()) || new Set(headers).size !== headers.length) throw conflict();
  return headers as string[];
}
const equalHeaders = (a: string[], b: string[]) => a.length === b.length && a.every((h,i) => h === b[i]);
const singleCell = (grid: Grid, sheetId: number, row: number, col: number) =>
  (grid.sheetId === undefined ? 0 : grid.sheetId) === sheetId &&
  (grid.startRowIndex ?? 0) === row &&
  grid.endRowIndex === row + 1 &&
  (grid.startColumnIndex ?? 0) === col &&
  grid.endColumnIndex === col + 1;

function taggedSnapshot(post: Post, edit: Edit, target: Target) {
  const tag = { developerMetadataLookup: { metadataId: target.metadataId, metadataKey: 'recordId',
    metadataValue: target.recordId, locationType: 'ROW' } };
  const header = { a1Range: tabRange(target.table) + '!1:1' };
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
    const headers = readHeaders(top[0].values);
    const cells: Cell[] = rows[0].values.map(cell);
    const id = cells[headers.indexOf(edit.idHeader)];
    if (!id || id.formula || String(id.raw ?? '') !== target.recordId) throw conflict();
    const names = new Map<string, Binding>((result.namedRanges || []).map((n: Binding) => [n.namedRangeId, n]));
    return { headers, cells, sheetId: properties.sheetId ?? 0, row: rows[0].index, names, metadataId: target.metadataId, recordId: target.recordId };
  }
  return snapshot;
}

export async function readSheetEditor(post: Post, edit: Edit, target: Target) {
  return describeTaggedEdit(edit, target, await taggedSnapshot(post, edit, target)());
}

export async function editSheetRow(post: Post, edit: Edit, target: Target, audit: (entry: EditAudit) => Promise<void>) {
  const snapshot = taggedSnapshot(post, edit, target);
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  let initial: Snapshot | undefined;
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
      (c.rule !== 'date' || c.requested === '' || !!value.dateSerial === (typeof c.requested === 'number'));
  };
  async function apply(_target: Target, changes: readonly Change[]): Promise<'rejected' | 'applied' | 'unconfirmed'> {
    try {
      const start = await snapshot();
      if (!initial || !equalHeaders(initial.headers, start.headers) || !changes.every(c => current(start,c))) return 'rejected';
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
      if (!equalHeaders(start.headers, fresh.headers)) return 'rejected';
      for (const { namedRangeId, name, change } of bindings) {
        const bound = fresh.names.get(namedRangeId);
        if (!current(fresh, change)) return 'rejected';
        if (!bound || bound.name !== name) return 'rejected';
        if (!bound.range || !singleCell(bound.range, fresh.sheetId, fresh.row, fresh.headers.indexOf(change.header)))
          return 'rejected';
      }
      dispatched = fresh;
    } catch { return 'rejected'; }
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
          return changes.every(c => current(after, c)) ? 'rejected' : 'unconfirmed';
        } catch { return 'unconfirmed'; }
      }
      throw error; // Lost response: the engine verifies once, without replay.
    }
  }
  async function read() {
    readBack = undefined;
    const s = await snapshot();
    initial ??= s;
    if (dispatched) readBack = s;
    if (dispatched && (dispatched.sheetId !== s.sheetId || !equalHeaders(dispatched.headers, s.headers) || !bindings.every(b => {
      const bound = s.names.get(b.namedRangeId);
      const col = s.headers.indexOf(b.change.header), receipt = receipts.get(b.namedRangeId);
      return (!receipt || ((!receipt.spreadsheetId || receipt.spreadsheetId === target.spreadsheetId) &&
        receiptColumn(receipt.updatedRange, s.row) === col)) &&
        bound?.name === b.name && singleCell(bound.range, s.sheetId, s.row, col);
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

async function addLayout(post: Post, edit: Edit, target: AddTarget) {
  const mask = 'sheets(properties(sheetId,title,sheetType,gridProperties(rowCount)),data(startRow,startColumn,rowData(values(userEnteredValue))))';
  const result = await post(':getByDataFilter?fields=' + encodeURIComponent(mask), {
    dataFilters: [{ a1Range: tabRange(target.table) + '!1:1' }],
  });
  const tab = result.sheets?.[0], properties = tab?.properties;
  const top = tab?.data?.[0];
  if (result.sheets?.length !== 1 || properties?.title !== target.table || properties.sheetType !== 'GRID' ||
      !top || top.startRow || top.startColumn) throw conflict();
  if (properties.gridProperties?.rowCount === 1)
    throw Object.assign(Error('Add a blank row below the header in Google Sheets, then try again.'), { status: 409 });
  if (!(properties.gridProperties?.rowCount >= 2)) throw conflict();
  const headers = readHeaders(top.rowData?.[0]?.values ?? []);
  if (!headers.includes(edit.idHeader)) throw conflict();
  return { sheetId: properties.sheetId ?? 0, headers, cells: [] as Cell[], recordId: '', metadataId: 0 };
}

export async function readSheetAddEditor(post: Post, edit: Edit, target: AddTarget) {
  const blank = await addLayout(post, edit, target);
  const fields = describeTaggedEdit(edit, { ...target, recordId: '', metadataId: 0 }, blank);
  if (!fields.some(field => field.field === 'name') ||
      (edit.section !== 'companies' && !fields.some(field => field.field === 'companyLink')))
    throw Object.assign(Error('Review the required mapped columns before adding records.'), { status: 409 });
  return fields;
}

type AddStore = {
  get(): Promise<AddAudit | null>;
  claim(audit: AddAudit): Promise<AddAudit | null>;
  finish(audit: AddAudit): Promise<void>;
};

export async function addSheetRow(post: Post, edit: Edit, target: AddTarget, token: string, ledger: AddStore,
  readIds: () => Promise<string[]>, resume: boolean) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const requestHash = hash(Object.entries(edit.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const review = () => Object.assign(Error('The new record could not be confirmed. It may already be in Google Sheets. Check again or review the sheet.'),
    { status: 409, sheetNeedsReview: true });
  const rejected = () => Object.assign(Error('Google Sheets rejected the new record. Review the sheet and try again.'), { status: 400 });
  const lookup = (recordId: string) => ({ developerMetadataLookup: { metadataKey: 'recordId', metadataValue: recordId, locationType: 'ROW' } });
  async function tags(recordId: string) {
    const found = await post('/developerMetadata:search', { dataFilters: [lookup(recordId)] });
    return (found.matchedDeveloperMetadata || []).map((match: any) => match.developerMetadata);
  }
  function validTag(tag: any, recordId: string, sheetId?: number) {
    const location = tag?.location?.dimensionRange;
    return tag?.metadataKey === 'recordId' && tag.metadataValue === recordId && tag.visibility === 'DOCUMENT' &&
      Number.isSafeInteger(tag.metadataId) && tag.metadataId > 0 && location?.dimension === 'ROWS' &&
      (sheetId === undefined || (location.sheetId ?? 0) === sheetId) &&
      Number.isSafeInteger(location.startIndex) && location.startIndex > 0 && location.endIndex === location.startIndex + 1;
  }
  async function verify(entry: AddAudit, receiptId: number | null = null) {
    let metadataId = receiptId;
    try {
      const found = await tags(entry.recordId);
      if (found.length !== 1 || !validTag(found[0], entry.recordId)) throw Error();
      if (receiptId !== null && receiptId !== found[0].metadataId) throw Error();
      metadataId = found[0].metadataId;
      const after = await taggedSnapshot(post, edit, { ...target, recordId: entry.recordId, metadataId: metadataId! })();
      if (!validTag(found[0], entry.recordId, after.sheetId) ||
          (await readIds()).filter(id => id === entry.recordId).length !== 1) throw Error();
      if (edit.refreshLinks) edit.links = await edit.refreshLinks();
      if (addedRowHash(edit, after, after.sheetId) !== entry.expectedHash) throw Error();
      await ledger.finish({ ...entry, metadataId, outcome: 'confirmed', verified: true });
      return { operationId: entry.operationId, recordId: entry.recordId, metadataId };
    } catch {
      await ledger.finish({ ...entry, metadataId, outcome: 'unconfirmed' }).catch(() =>
        console.warn('[sources] Could not finalize a Sheets Add audit.', entry.operationId));
      throw review();
    }
  }
  async function recover(entry: AddAudit) {
    if (entry.actorId !== target.actorId || entry.section !== target.section || entry.spreadsheetId !== target.spreadsheetId || entry.table !== target.table ||
        (!resume && entry.requestHash !== requestHash))
      throw Object.assign(Error('This Add request belongs to a different record or sheet. Review the original request.'), { status: 409 });
    if (entry.outcome === 'rejected') throw rejected();
    if (entry.outcome === 'confirmed') return { operationId: entry.operationId, recordId: entry.recordId, metadataId: entry.metadataId };
    return verify(entry, entry.metadataId);
  }

  const prior = await ledger.get();
  if (prior) return recover(prior);
  const entry: AddAudit = { ...target, kind: 'add', addSpreadsheetId: target.spreadsheetId, operationId: randomUUID(),
    recordId: randomUUID(), token, outcome: 'attempted', verified: false, metadataId: null, at: new Date().toISOString(),
    name: '', requestHash, expectedHash: '' };
  if (resume) {
    // A response can be lost before the first request claims the token.
    // Reserving it here ensures that an in-flight request cannot write later.
    const winner = await ledger.claim({ ...entry, outcome: 'rejected' });
    if (winner) return recover(winner);
    throw Object.assign(Error('No Add was sent to Google Sheets. You can submit the form again.'), { status: 400 });
  }
  let row: Awaited<ReturnType<typeof addLayout>>;
  try {
    row = await addLayout(post, edit, target);
    if (edit.refreshLinks) edit.links = await edit.refreshLinks();
    const changes = planTaggedAdd(edit, row);
    entry.name = String(changes.find(change => change.field === 'name')!.requested);
    const recordIds = await readIds();
    if (recordIds.includes(entry.recordId) || (await tags(entry.recordId)).length)
      throw Object.assign(Error('The generated record ID already exists. Try again.'), { status: 400 });
    await edit.validateChanges?.(changes);
    row.cells = row.headers.map(header => ({
      raw: header === edit.idHeader ? entry.recordId : changes.find(change => change.header === header)?.requested ?? null,
    }));
    entry.expectedHash = addedRowHash(edit, row, row.sheetId);
  } catch (cause) {
    const winner = await ledger.claim({ ...entry, outcome: 'rejected' });
    if (winner) return recover(winner);
    // No batch was sent. The user can correct the form with a fresh token.
    throw Object.assign(Error(cause instanceof Error && 'status' in cause ? cause.message :
      'Could not prepare the new record. Review the connection and try again.'), { status: 400 });
  }
  entry.pendingSpreadsheetId = target.spreadsheetId;
  const winner = await ledger.claim(entry);
  if (winner) return recover(winner);

  // Insert at the first data row. Each atomic batch creates its own slot even
  // when a different Add has inserted a row since this request read the layout.
  const index = 1;
  const location = { sheetId: row.sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 };
  const values = row.cells.map(({ raw }) => raw === null ? {} : { userEnteredValue:
    typeof raw === 'number' ? { numberValue: raw } : typeof raw === 'boolean' ? { boolValue: raw } : { stringValue: raw } });
  let result;
  try {
    result = await post(':batchUpdate', { requests: [
      { insertDimension: { range: location, inheritFromBefore: false } },
      { updateCells: { start: { sheetId: row.sheetId, rowIndex: index, columnIndex: 0 }, rows: [{ values }], fields: 'userEnteredValue' } },
      { createDeveloperMetadata: { developerMetadata: {
        metadataKey: 'recordId', metadataValue: entry.recordId, visibility: 'DOCUMENT', location: { dimensionRange: location },
      } } },
    ] });
  } catch (cause) {
    if ((cause as { rejected?: boolean }).rejected) {
      await ledger.finish({ ...entry, outcome: 'rejected' });
      throw rejected();
    }
    // A transport error can occur after the batch commits. Never dispatch it again.
    return verify(entry);
  }
  const receipt = result?.replies?.[2]?.createDeveloperMetadata?.developerMetadata;
  if (!validTag(receipt, entry.recordId, row.sheetId) || receipt.location.dimensionRange.startIndex !== index) {
    await ledger.finish({ ...entry, outcome: 'unconfirmed' });
    throw review();
  }
  return verify(entry, receipt.metadataId);
}
