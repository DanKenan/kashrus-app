import { createHash, randomUUID } from 'node:crypto';
import { parseMoney } from '../../lib/sourceAmount.ts';
import { builtinFieldKeys, isMappedCustomField, type ValueRule, type SourceSection } from '../../lib/sourcePreview.ts';
import { companyTypeChoices } from './mapping.ts';
import type { SourceMapping } from './types.ts';

type Scalar = string | number | boolean;
export type Cell = { raw: Scalar | null; formula?: string; dateSerial?: boolean };
export type TaggedSnapshot = {
  metadataId: number; recordId: string; headers: string[]; cells: Cell[];
};
export type Change = { field: string; header: string; previous: Scalar | null; requested: Scalar; rule: ValueRule; companyIds?: string[] };
type CompanyLinks = { resolve(value: string): string[]; sourceKey(id: string): string | undefined };
const reject = (message: string): never => { throw Object.assign(Error(message), { status: 409 }); };

export function feeAlreadySet(previous: unknown, amount: number) {
  return previous === amount || (typeof previous === 'string' && parseMoney(previous) === amount);
}

// Compare source text exactly, except CRLF and CR line endings normalize to LF.
// Preserve spaces, case, and Unicode code points, including for certification and status.
const text = (value: string) => value.replace(/\r\n?/g, '\n');
const day = 86400000;
const sheetsEpoch = Date.UTC(1899, 11, 30);
export function isoDateFromSheetsSerial(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  const date = new Date(sheetsEpoch + value * day);
  if (!Number.isFinite(date.getTime())) return undefined;
  const iso = date.toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : undefined;
}
function isoSerial(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const millis = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) return undefined;
  return (millis - sheetsEpoch) / day;
}
function dateSerial(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return reject('Enter an ISO calendar date.');
  return isoSerial(value) ?? reject('Enter a valid calendar date.');
}
const bool = (value: unknown) => typeof value === 'boolean' ? value : value === 0 || value === 1 ? value === 1 :
  typeof value === 'string' && /^(true|false|yes|no|0|1)$/i.test(value) ? /^(true|yes|1)$/i.test(value) : undefined;
function ids(value: string, links: CompanyLinks) {
  return JSON.stringify([...new Set(links.resolve(value))].sort());
}
function encode(rule: ValueRule, value: unknown, cell: Cell, links: CompanyLinks): Scalar {
  if (rule === 'companyLink') {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) return reject('Choose permanent company IDs.');
    const distinct = [...new Set<string>(value)];
    const keys = distinct.map(id => links.sourceKey(id) || reject('Unknown company ID.'));
    const encoded = keys.join(', ');
    if (ids(encoded, links) !== JSON.stringify(distinct.sort())) return reject('Ambiguous company links.');
    return encoded;
  }
  if (rule === 'money') {
    if (typeof value !== 'number' || parseMoney(value) !== value) return reject('Enter a valid amount.');
    return value;
  }
  if (rule === 'date') {
    if (cell.dateSerial && typeof cell.raw === 'number' && !Number.isInteger(cell.raw))
      return reject('Review the date format in Google Sheets.');
    if (cell.raw !== null && cell.raw !== '' && !cell.dateSerial) dateSerial(cell.raw);
    if (value === '') return '';
    const serial = dateSerial(value);
    if (cell.dateSerial) return serial;
    return String(value);
  }
  if (rule === 'boolean') {
    if (typeof value !== 'boolean') return reject('Choose a checkbox value.');
    if (typeof cell.raw === 'string' && cell.raw !== '') {
      if (bool(cell.raw) === undefined) return reject('Unknown checkbox representation.');
      if (/^(yes|no)$/i.test(cell.raw)) return value ? 'Yes' : 'No';
      if (/^[01]$/.test(cell.raw)) return value ? '1' : '0';
      return value ? 'TRUE' : 'FALSE';
    }
    if (cell.raw === 0 || cell.raw === 1) return value ? 1 : 0;
    if (cell.raw !== null && cell.raw !== '' && typeof cell.raw !== 'boolean') return reject('Unknown checkbox representation.');
    return value;
  }
  if (typeof value !== 'string' || value.length > 2000) return reject('Enter text of up to 2,000 characters.');
  return text(value);
}

function matches(cell: Cell, change: Change, links: CompanyLinks) {
  const { raw } = cell, { requested, rule } = change;
  if (cell.formula) return false;
  if (rule === 'boolean') return bool(raw) === bool(requested);
  if (rule === 'companyLink') return (raw === null || typeof raw === 'string') && ids(String(raw ?? ''), links) === JSON.stringify(change.companyIds);
  if (rule === 'text') return (raw === null || typeof raw === 'string') && text(String(raw ?? '')) === requested;
  if (rule === 'date') {
    if (requested === '') return raw === null || raw === '';
    const calendarDay = cell.dateSerial && typeof raw === 'number' ? raw : isoSerial(raw);
    return calendarDay === (typeof requested === 'number' ? requested : isoSerial(requested));
  }
  return raw === requested;
}

export type Edit = {
  mapping: SourceMapping; section: SourceSection; idHeader: string; fields: Record<string, unknown>;
  links: CompanyLinks;
  expected?: unknown;
  requireRevision?: boolean;
  validateChanges?(changes: readonly Change[]): Promise<void>;
  refreshLinks?(): Promise<CompanyLinks>;
  // Explicitly editable custom fields and their types come from trusted mapping configuration.
  customTypes?: ReadonlyMap<string, ValueRule>;
};
function column(snapshot: TaggedSnapshot, header: string) {
  const index = snapshot.headers.indexOf(header);
  if (index < 0 || snapshot.headers.lastIndexOf(header) !== index) return reject('Mapped column missing or ambiguous. Refresh and review.');
  return snapshot.cells[index] ?? { raw: null };
}
function editableColumn(edit: Edit, field: string) {
  const config: Record<string, unknown> = { ...edit.mapping[edit.section] };
  const custom = edit.customTypes?.get(field);
  const builtIn = (builtinFieldKeys[edit.section] as readonly string[]).includes(field) ||
    (edit.section === 'companies' && ['address', 'companyFee', 'mashgiachFee'].includes(field));
  const header = config[field];
  if (field === 'table' || (!builtIn && (!custom || !isMappedCustomField(edit.section, field))) ||
      !Object.hasOwn(config, field) || typeof header !== 'string' || !header ||
      header === edit.idHeader || header === config.pk ||
      Object.entries(config).some(([key, mapped]) => key !== field && key !== 'table' && mapped === header))
    return undefined;
  const rule: ValueRule = builtIn ? (field === 'companyFee' || field === 'mashgiachFee' ? 'money' :
    field === 'expiresOn' ? 'date' : field === 'symbolRequired' ? 'boolean' : field === 'companyLink' ? 'companyLink' : 'text') : custom!;
  return { header, rule };
}

function revision(target: Target, snapshot: TaggedSnapshot, header: string, cell: Cell, rule: ValueRule) {
  return createHash('sha256').update(JSON.stringify([target.agencyId, target.section, target.spreadsheetId,
    target.table, target.recordId, target.metadataId, snapshot.headers, header, rule, cell.raw, cell.formula, !!cell.dateSerial])).digest('hex');
}

export function describeTaggedEdit(edit: Edit, target: Target, snapshot: TaggedSnapshot) {
  return Object.keys(edit.mapping[edit.section]).flatMap(field => {
    const spec = editableColumn(edit, field);
    if (!spec || !snapshot.headers.includes(spec.header)) return [];
    const { header, rule } = spec;
    const cell = column(snapshot, header);
    let value: string | number | boolean | string[] = cell.raw ?? '';
    let readOnly = cell.formula ? 'Formula cells are read only.' : undefined;
    if (!readOnly && rule === 'date' && value !== '') {
      if (cell.dateSerial) value = isoDateFromSheetsSerial(value) ?? value;
      if (isoSerial(value) === undefined) readOnly = 'Review the date format in Google Sheets.';
    }
    if (!readOnly && rule === 'money' && value !== '') value = parseMoney(value) ?? value;
    if (!readOnly && rule === 'boolean' && value !== '') {
      const checked = bool(value);
      if (checked === undefined) readOnly = 'Review the checkbox values in Google Sheets.';
      else value = checked;
    }
    if (!readOnly && rule === 'companyLink') {
      try { value = edit.links.resolve(String(value)); }
      catch { readOnly = 'Review the company links in Google Sheets.'; }
    }
    // A formula result is intentionally excluded from the raw editor.
    const choices = edit.section === 'companies' && field === 'type' ? companyTypeChoices(edit.mapping.companies) : undefined;
    return [{ field, header, rule, value, readOnly, ...(choices && { choices }), revision: revision(target, snapshot, header, cell, rule) }];
  });
}

export function planTaggedEdit(edit: Edit, snapshot: TaggedSnapshot, target?: Target): Change[] {
  if (!edit.fields || typeof edit.fields !== 'object' || Array.isArray(edit.fields)) return reject('Invalid fields.');
  const expected = edit.expected as Record<string, unknown> | undefined;
  if (expected !== undefined && (!expected || typeof expected !== 'object' || Array.isArray(expected)))
    return reject('Invalid edit revision. Refresh and review.');
  const changes: Change[] = [];
  for (const [field, value] of Object.entries(edit.fields)) {
    if (field === 'name' && (typeof value !== 'string' || !value.trim())) return reject('Enter a name.');
    const spec = editableColumn(edit, field);
    if (!spec) return reject('Only independently mapped editable fields can be changed.');
    const { header, rule } = spec;
    const cell = column(snapshot, header);
    if (cell.formula) return reject('Formula cells are read only.');
    // Phase A clients can still submit the three original company fields.
    const legacyField = edit.section === 'companies' && ['name', 'address', 'companyFee'].includes(field);
    if ((!expected && edit.requireRevision && !legacyField) ||
        (expected && (!target || !Object.hasOwn(expected, field) || expected[field] !== revision(target, snapshot, header, cell, rule))))
      return reject('This field or its mapped column changed. Refresh and review.');
    if (edit.section === 'companies' && field === 'type') {
      const choices = companyTypeChoices(edit.mapping.companies);
      if (choices && (typeof value !== 'string' || !choices.includes(value)))
        throw Object.assign(Error('Choose a company type from the configured values.'), { status: 400 });
    }
    const requested = encode(rule, value, cell, edit.links);
    const change = { field, header, rule, requested, previous: cell.raw,
      ...(rule === 'companyLink' && { companyIds: [...new Set(value as string[])].sort() }) };
    if (!matches(cell, change, edit.links) && !(rule === 'money' && feeAlreadySet(cell.raw, Number(requested)))) changes.push(change);
  }
  return changes;
}
export function verifyTaggedEdit(before: TaggedSnapshot, after: TaggedSnapshot, idHeader: string, changes: Change[], links: CompanyLinks) {
  const id = column(after, idHeader);
  return before.metadataId === after.metadataId && before.recordId === after.recordId &&
    !id.formula && String(id.raw ?? '') === before.recordId &&
    changes.every(change => matches(column(after, change.header), change, links));
}

export type Target = { actorId: string; agencyId: string; section: SourceSection; spreadsheetId: string; table: string; metadataId: number; recordId: string };
export type FieldWriteEvidence = {
  field: string; intendedHeader: string; attemptedValue: Scalar;
  receipt?: { updatedRange: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number; spreadsheetId?: string };
  readBack?: { basis: 'receipt' | 'namedRange'; header: string; rowNumber: number; raw: Scalar | null; formula?: string };
};
export type EditAudit = Target & {
  operationId: string; outcome: 'attempted' | 'confirmed' | 'unconfirmed' | 'rejected';
  changedFields: string[]; previous: Record<string, Scalar | null>; requested: Record<string, unknown>;
  verified: boolean; at: string; otherFieldsChanged?: boolean; writeEvidence?: FieldWriteEvidence[];
};

export async function updateTaggedRow(edit: Edit, target: Target, provider: {
  read(target: Target): Promise<TaggedSnapshot>;
  // Resolve against freshly read source data immediately before dispatch.
  applyIfCurrent(target: Target, changes: readonly Change[]): Promise<'applied' | 'rejected' | 'unconfirmed'>;
  writeEvidence?(): FieldWriteEvidence[];
}, audit: (entry: EditAudit) => Promise<void>) {
  const entry: EditAudit = { ...target, operationId: randomUUID(), outcome: 'attempted',
    changedFields: [], previous: {}, requested: edit.fields ?? {}, verified: false, at: new Date().toISOString() };
  let before: TaggedSnapshot, changes: Change[];
  try {
    if (target.section !== edit.section || target.table !== edit.mapping[edit.section].table ||
        !Number.isSafeInteger(target.metadataId) || target.metadataId <= 0 || !target.recordId.trim())
      reject('Invalid edit target.');
    before = await provider.read(target);
    const id = column(before, edit.idHeader);
    if (before.metadataId !== target.metadataId || before.recordId !== target.recordId ||
        id.formula || String(id.raw ?? '') !== target.recordId)
      reject('Record identity changed. Refresh and review.');
    changes = planTaggedEdit(edit, before, target);
    await edit.validateChanges?.(changes);
    if (!changes.length) reject('No mapped values changed. Refresh to see the current values.');
  } catch (error) {
    await audit({ ...entry, outcome: 'rejected' });
    throw error;
  }
  entry.changedFields = changes.map(change => change.field);
  entry.previous = Object.fromEntries(changes.map(change => [change.field, change.previous]));
  try { await audit(entry); }
  catch { return reject('The audit could not be recorded. The edit was stopped before saving. Refresh and review.'); }
  let result;
  try {
    result = await provider.applyIfCurrent(target, changes);
  } catch {
    // A lost write response is indeterminate. Read once, without resubmitting.
  }
  if (result === 'rejected') {
    await audit({ ...entry, outcome: 'rejected' });
    return reject('The sheet rejected the change. Refresh and review.');
  }
  let otherFieldsChanged: boolean;
  try {
    const after = await provider.read(target);
    const links = changes.some(change => change.rule === 'companyLink') && edit.refreshLinks ? await edit.refreshLinks() : edit.links;
    if (result === 'unconfirmed' || !verifyTaggedEdit(before, after, edit.idHeader, changes, links)) throw Error();
    const edited = new Set(changes.map(change => change.header));
    otherFieldsChanged = before.headers.some(header => {
      if (edited.has(header)) return false;
      const old = column(before, header), next = column(after, header);
      return old.raw !== next.raw || old.formula !== next.formula || !!old.dateSerial !== !!next.dateSerial;
    });
  } catch {
    const writeEvidence = provider.writeEvidence?.();
    try { await audit({ ...entry, outcome: 'unconfirmed', ...(writeEvidence && { writeEvidence }) }); }
    catch { console.warn('[sources] Could not finalize an unconfirmed Sheets edit audit.', entry.operationId); }
    throw Object.assign(Error('The change could not be confirmed. The sheet may already have changed. Refresh and review.'),
      { status: 409, sheetNeedsReview: true });
  }
  try {
    await audit({ ...entry, outcome: 'confirmed', verified: true, ...(otherFieldsChanged && { otherFieldsChanged }) });
  } catch {
    throw Object.assign(Error('The sheet change was verified but its audit could not be confirmed. Refresh and review.'),
      { status: 409, sheetNeedsReview: true });
  }
  return { operationId: entry.operationId, otherFieldsChanged };
}
