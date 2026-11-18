import { randomUUID } from 'node:crypto';
import { parseMoney } from '../../lib/sourceAmount.ts';
import { builtinFieldKeys, isMappedCustomField, type ValueRule, type SourceSection } from '../../lib/sourcePreview.ts';
import type { SourceMapping } from './types.ts';

type Scalar = string | number | boolean;
export type Cell = { raw: Scalar | null; formula?: string; dateSerial?: boolean };
export type TaggedSnapshot = {
  metadataId: number; recordId: string; headers: string[]; cells: Cell[];
};
export type Change = { field: string; header: string; previous: Scalar | null; requested: Scalar; rule: ValueRule };
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
function dateSerial(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return reject('Enter an ISO calendar date.');
  const millis = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value)
    return reject('Enter a valid calendar date.');
  return (millis - sheetsEpoch) / day;
}
const bool = (value: unknown) => typeof value === 'boolean' ? value :
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
    const serial = dateSerial(value);
    if (cell.dateSerial) return serial;
    if (cell.raw !== null && cell.raw !== '') dateSerial(cell.raw);
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
  if (rule === 'companyLink') return (raw === null || typeof raw === 'string') && ids(String(raw ?? ''), links) === ids(String(requested), links);
  if (rule === 'text') return (raw === null || typeof raw === 'string') && text(String(raw ?? '')) === requested;
  if (rule === 'date' && Boolean(cell.dateSerial) !== (typeof requested === 'number')) return false;
  return raw === requested;
}

export type Edit = {
  mapping: SourceMapping; section: SourceSection; idHeader: string; fields: Record<string, unknown>;
  links: CompanyLinks;
  // Explicitly editable custom fields and their types come from trusted mapping configuration.
  customTypes?: ReadonlyMap<string, ValueRule>;
};
function column(snapshot: TaggedSnapshot, header: string) {
  const index = snapshot.headers.indexOf(header);
  if (index < 0 || snapshot.headers.lastIndexOf(header) !== index) return reject('Mapped column missing or ambiguous. Refresh and review.');
  return snapshot.cells[index] ?? { raw: null };
}
export function planTaggedEdit(edit: Edit, snapshot: TaggedSnapshot): Change[] {
  const config: Record<string, unknown> = { ...edit.mapping[edit.section] };
  const allowed = new Set<string>(builtinFieldKeys[edit.section]);
  if (edit.section === 'companies') for (const key of ['address', 'companyFee', 'mashgiachFee']) allowed.add(key);
  if (!edit.fields || typeof edit.fields !== 'object' || Array.isArray(edit.fields))
    return reject('Invalid fields.');
  const changes: Change[] = [];
  for (const [field, value] of Object.entries(edit.fields)) {
    if (field === 'name' && (typeof value !== 'string' || !value.trim())) return reject('Enter a name.');
    const custom = edit.customTypes?.get(field);
    const header = config[field];
    if (field === 'table' || (!allowed.has(field) && (!custom || !isMappedCustomField(edit.section, field))) || !Object.hasOwn(config, field) || typeof header !== 'string' || !header ||
        header === edit.idHeader || header === config.pk ||
        Object.entries(config).some(([key, mapped]) => key !== field && key !== 'table' && mapped === header))
      return reject('Only independently mapped editable fields can be changed.');
    const cell = column(snapshot, header);
    if (cell.formula) return reject('Formula cells are read only.');
    const rule = allowed.has(field) ? (field === 'companyFee' || field === 'mashgiachFee' ? 'money' :
      field === 'expiresOn' ? 'date' : field === 'symbolRequired' ? 'boolean' : field === 'companyLink' ? 'companyLink' : 'text') : custom!;
    const requested = encode(rule, value, cell, edit.links);
    const change = { field, header, rule, requested, previous: cell.raw };
    if (!matches(cell, change, edit.links) && !(rule === 'money' && feeAlreadySet(cell.raw, Number(requested)))) changes.push(change);
  }
  return changes;
}
export function verifyTaggedEdit(before: TaggedSnapshot, after: TaggedSnapshot, idHeader: string, changes: Change[], links: CompanyLinks) {
  return before.metadataId === after.metadataId && before.recordId === after.recordId &&
    String(column(after, idHeader).raw ?? '') === before.recordId &&
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
  verified: boolean; at: string; writeEvidence?: FieldWriteEvidence[];
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
    if (before.metadataId !== target.metadataId || before.recordId !== target.recordId ||
        String(column(before, edit.idHeader).raw ?? '') !== target.recordId)
      reject('Record identity changed. Refresh and review.');
    changes = planTaggedEdit(edit, before);
    if (!changes.length) reject('No mapped values changed. Refresh to see the current values.');
  } catch (error) {
    await audit({ ...entry, outcome: 'rejected' });
    throw error;
  }
  entry.changedFields = changes.map(change => change.field);
  entry.previous = Object.fromEntries(changes.map(change => [change.field, change.previous]));
  await audit(entry);
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
  try {
    const after = await provider.read(target);
    if (result === 'unconfirmed' || !verifyTaggedEdit(before, after, edit.idHeader, changes, edit.links)) throw Error();
  } catch {
    const writeEvidence = provider.writeEvidence?.();
    await audit({ ...entry, outcome: 'unconfirmed', ...(writeEvidence && { writeEvidence }) });
    return reject('The change could not be confirmed. The sheet may already have changed. Refresh and review.');
  }
  try {
    await audit({ ...entry, outcome: 'confirmed', verified: true });
  } catch {
    return reject('The sheet change was verified but its audit could not be confirmed. Refresh and review.');
  }
  return { operationId: entry.operationId };
}
