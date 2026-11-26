import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { attachmentDescriptors, companyTypeChoices } from './mapping.ts';
import type { createAirtableConnector } from './airtable.ts';
import type { Connection, createSourceStore } from './store.ts';
import type { AirtableOperation } from './tagged-row.ts';
import type { SourceState } from './cache.ts';
import { attachmentColumn, fail, guardSourceWrite, itemSchema, recordIdPattern, tableSchema, type Cell, type ItemList } from './write.ts';

type Adapter = ReturnType<typeof createAirtableConnector>;
type User = { id: string; agencyId: string; role: string };
type Deps = {
  user(req: any): User | null;
  visible(user: User, companyId: string): Promise<boolean>;
  serialize<T>(agency: string, fn: () => Promise<T>): Promise<T>;
  withAssignmentLock<T>(agency: string, fn: () => Promise<T>): Promise<T>;
  connection(agency: string): Connection | undefined;
  refreshAfterEdit(agency: string): boolean;
  state(agency: string): SourceState;
  adapter(c: Connection): Adapter;
  eligible(c: Connection, adapter: Adapter): Promise<unknown>;
  permissionError(c: Connection, adapter: Adapter, cause: any): Promise<any>;
  republish(c: Connection, adapter: Adapter): Promise<object>;
  ledger: ReturnType<typeof createSourceStore>['airtableLedger'];
  blocked(): boolean; limit(id: string): void;
};
const staleItem = 'This record changed in Airtable. Reload and review before saving.';
const staleFiles = 'These certificates changed in Airtable. Reload and review before replacing a file.';
const bindingError = 'The source connection changed. Reopen the record.';
const unclear = {
  edit: 'Airtable may have saved these changes. Reload and review before retrying.',
  add: 'Airtable may have created this item. Reload and review before trying again.',
  upload: 'Airtable may have received this PDF. Reload and review before trying again.',
};
const kept = 'New PDF uploaded. The previous PDF was kept because the final replacement could not be confirmed. Review both files in Airtable.';
const tooLarge = 'PDF is too large. The maximum size is 5 MB.';
const invalidPdf = 'Choose a valid PDF file.';
const noField = 'Certificate field not configured in Airtable source settings.';
const baselineError = "Couldn't load the latest record from Airtable. Editing is unavailable until the connection works.";
function sameIds(a: string[], b: string[]) {
  const expected = new Set(b);
  return a.length === b.length && a.every(id => expected.has(id));
}
function ids(value: unknown, pattern: RegExp) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !pattern.test(v)) || new Set(value).size !== value.length)
    fail(409, 'Reload and review the record.');
  return value as string[];
}
export const canViewCompanyDocuments = (user: User) => ['admin', 'coordinator'].includes(user.role);
export const canEditCompanyDocuments = canViewCompanyDocuments;
function itemList(value: string): ItemList {
  if (value !== 'ingredients' && value !== 'products') fail(404, 'List not found.');
  return value;
}
function token(value: unknown) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) fail(400, 'Include a valid operation ID.');
  return value;
}
const pdfType = (f: { filename: string; contentType?: string }) => /\.pdf$/i.test(f.filename) && (!f.contentType || f.contentType === 'application/pdf');
async function readPdf(req: any, res: any) {
  if (req.headers['content-type'] !== 'application/pdf' || req.headers['content-encoding']) fail(400, invalidPdf);
  const limit = 5 * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit) fail(413, tooLarge);
  await new Promise<void>((resolve, reject) => express.raw({ type: 'application/pdf', limit, inflate: false })(req, res, err => err ? reject(Object.assign(Error(err.status === 413 ? tooLarge : invalidPdf), { status: err.status || 400 })) : resolve()));
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || !/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 10).toString('latin1'))) fail(400, invalidPdf);
  const trailer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(bytes.subarray(-1024).toString('latin1'));
  const offset = Number(trailer?.[1]);
  // Both classic xref tables and PDF 1.5+ cross-reference streams are valid.
  if (!Number.isSafeInteger(offset) || offset < 8 || offset >= bytes.length ||
      !/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(bytes.subarray(offset, offset + 60).toString('latin1')) ||
      !/\b\d+\s+\d+\s+obj\b/.test(bytes.toString('latin1'))) fail(400, invalidPdf);
  let filename: string;
  try { filename = decodeURIComponent(req.headers['x-pdf-name'] ?? '').normalize('NFC'); } catch { fail(400, invalidPdf); }
  if (!filename.trim() || filename.length > 180 || /[\/\\\x00-\x1f\x7f]/.test(filename) || !/\.pdf$/i.test(filename)) fail(400, invalidPdf);
  return { bytes, filename };
}
type Context = { req: any; res: any; c: Connection; adapter: Adapter; user: User; companyId: string };
function bound(c: Connection, baseId: unknown, updatedAt: unknown) {
  if (baseId !== c.baseId || updatedAt !== c.updatedAt) fail(409, bindingError);
}
function itemValues(schema: ReturnType<typeof itemSchema>, cells: Record<string, unknown>, empty = false) {
  const fields: Record<string, Cell> = {};
  for (const [key, f] of Object.entries(schema.fields)) {
    const v = cells[f.name];
    if (f.type === 'checkbox') {
      if (v == null || typeof v === 'boolean') fields[key] = v === true;
    }
    else if (v == null || typeof v === 'string') fields[key] = v as string || null;
  }
  if (!empty && (typeof fields.name !== 'string' || !fields.name.trim())) fail(409, 'A valid item name is required.');
  return fields;
}
function docRows(value: unknown) {
  const rows = value ?? [];
  const files = attachmentDescriptors(rows);
  if (!Array.isArray(rows) || files.length !== rows.length) fail(409, staleFiles);
  ids(files.map(f => f.id), /^att[a-zA-Z0-9]+$/);
  return files;
}
export function registerCompanyItems(app: any, deps: Deps) {
  const root = '/api/sources/companies/:companyId';
  const listPath = root + '/items/:list';
  const rowPath = listPath + '/:rowId';
  function route(access: 'list' | 'admin' | 'edit' | 'documents', fn: (ctx: Context) => Promise<any>) {
    return async (req: any, res: any) => {
      const user = deps.user(req), companyId = req.params.companyId, writing = req.method !== 'GET';
      try {
        if (!user?.agencyId || req.kiosk || !['admin','coordinator','mashgiach'].includes(user.role)) fail(403, 'Forbidden');
        if ((access === 'admin' || access === 'edit') && user.role !== 'admin') fail(403, 'Forbidden');
        if (access === 'documents' && !(writing ? canEditCompanyDocuments(user) : canViewCompanyDocuments(user)))
          fail(403, writing ? "You don't have permission to change this certificate." : 'Forbidden');
        const run = async () => {
          const c = deps.connection(user.agencyId);
          if (!c || !await deps.visible(user, companyId)) fail(403, 'Forbidden');
          res.set?.('Cache-Control', 'no-store');
          const state = deps.state(user.agencyId);
          const company = state.companies.find(row => row.id === companyId);
          if (!company) fail(403, 'Forbidden');
          const recovery = state.status === 'stale' && deps.refreshAfterEdit(user.agencyId);
          const docs = canViewCompanyDocuments(user);
          if (access === 'list') {
            const items = (kind: 'ingredient' | 'product') => state.itemsFor(companyId, kind).map(item => {
              const { id, name, brand, certifyingAgency, certificationRaw, statusRaw, agencyRaw, dpm, confidence, plant } = item;
              return { id, name, brand, certifyingAgency, certificationRaw, statusRaw, agencyRaw, dpm, confidence, plant,
                ...('expiresOn' in item && { expiresOn: item.expiresOn }), ...('code' in item && {code: item.code}),
                ...('symbolRaw' in item && {symbolRaw: item.symbolRaw}), ...('symbolRequired' in item && { symbolRequired: item.symbolRequired }),
                ...(docs && 'attachments' in item && { attachments: item.attachments }) };
            });
            return res.json({ company: { name: company.name, address: company.address, type: company.type }, ingredients: items('ingredient'), products: items('product'), status: state.status, recovery,
              savedAt: state.refreshedAt ?? state.companyBackupTimes?.[companyId] ?? state.backupTakenAt ?? null, sourceType: c.sourceType, access: c.access,
              ...(docs && company.attachments && {attachments: company.attachments}) });
          }
          if (c.sourceType !== 'airtable') fail(409, 'This operation requires Airtable.');
          if (writing && deps.blocked()) fail(503, 'Writes blocked');
          const editing = access === 'admin' || access === 'edit' || writing;
          if (editing && c.access !== 'readwrite') fail(403, 'This Airtable connection is read only. Contact an administrator.');
          if (editing && state.status !== 'ok' && !(access === 'edit' && recovery)) fail(503, baselineError);
          const adapter = deps.adapter(c);
          try {
            if (editing) await deps.eligible(c, adapter);
            if (writing) deps.limit(user.agencyId);
            const current = await adapter.readCompany(companyId);
            const choices = companyTypeChoices(c.mapping.companies);
            if (choices && !choices.some(v => v.trim().toLowerCase() === current.values.type?.trim().toLowerCase())) fail(403, 'Forbidden');
            await fn({ req, res, c, adapter, user, companyId });
          } catch (cause: any) {
            if (cause.airtable && cause.status === 404) fail(403, 'Forbidden');
            throw await deps.permissionError(c, adapter, cause);
          }
        };
        await deps.serialize(user.agencyId, () => writing ? deps.withAssignmentLock(user.agencyId, run) : run());
      } catch (error: any) {
        res.status(error.status ?? 503).json({ error: error.status ? error.message : baselineError, ...(error.outcome && {outcome: error.outcome}) });
      }
    };
  }
  app.get(root + '/items', route('list', async () => {}));
  async function operate(ctx: Context, action: AirtableOperation['action'], table: string, details: Partial<AirtableOperation>, fingerprint: unknown,
    execute: (entry: AirtableOperation, sent: () => Promise<void>) => Promise<void>) {
    const { req, res, c, user, companyId, adapter } = ctx;
    const entry: AirtableOperation = { operationId: action === 'upload' ? token(req.headers['x-operation-id']) : action === 'add' ? token(req.body?.operationId) : randomUUID(),
      agencyId: c.agencyId, actorId: user.id, companyId, baseId: c.baseId, updatedAt: c.updatedAt, table,
      section: req.params.list ?? (req.params.rowId ? 'ingredients' : 'companies'), ...(req.params.rowId && { recordId: req.params.rowId }),
      action, at: new Date().toISOString(), outcome: 'attempted', ...details,
      requestHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex') };
    const ledger = deps.ledger(c.agencyId, entry.operationId);
    const previous = await ledger.claim(entry);
    const ambiguous = action === 'upload' ? unclear.upload : action === 'add' ? unclear.add : unclear.edit;
    if (previous) {
      if (previous.actorId !== user.id || previous.action !== action || previous.companyId !== companyId || previous.table !== table ||
          previous.baseId !== c.baseId || previous.updatedAt !== c.updatedAt || previous.requestHash !== entry.requestHash) fail(409, bindingError);
      if (action === 'add' && previous.outcome === 'unconfirmed' && previous.recordId) {
        const schema = itemSchema(c, itemList(req.params.list), await adapter.readSchema());
        const row = await adapter.readRecord(table, previous.recordId);
        const values = itemValues(schema, row.fields);
        if (ids(row.fields[schema.link.name] ?? [], recordIdPattern).includes(companyId) &&
            Object.entries(previous.requested ?? {}).every(([key,value]) => values[key] === value)) {
          previous.outcome = 'confirmed';
          await ledger.finish(previous);
        }
      }
      if (previous.outcome === 'confirmed') return res.json({ saved: true, recordId: previous.recordId, ...await deps.republish(c, adapter) });
      fail(409, previous.outcome === 'review' ? kept : ambiguous);
    }
    let sent = false;
    try {
      await execute(entry, async () => {
        // Persist the live comparison before permitting the outbound mutation.
        await ledger.finish(entry);
        sent = true;
      });
      entry.outcome = 'confirmed';
    } catch (err: any) {
      const rejected = !sent || err.definiteRejection === true;
      entry.outcome = entry.newId ? 'review' : rejected ? 'rejected' : 'unconfirmed';
      await ledger.finish(entry);
      if (rejected) throw err;
      if (err.airtable) await deps.permissionError(c, adapter, err);
      throw Object.assign(Error(entry.newId ? kept : ambiguous), {status: 409, outcome: entry.outcome});
    }
    let auditWarning: string | undefined;
    try { await ledger.finish(entry); } catch { auditWarning = 'The final edit audit could not be recorded.'; }
    return res.json({ saved: true, recordId: entry.recordId, auditWarning, ...await deps.republish(c, adapter) });
  }
  async function itemContext({req, c, adapter}: Context) {
    const list = itemList(req.params.list);
    const schema = itemSchema(c, list, await adapter.readSchema());
    return { list, schema, table: schema.table.name };
  }
  async function pendingAdd(ctx: Context, table: string, operationId: unknown) {
    const ledger = deps.ledger(ctx.c.agencyId, token(operationId));
    const entry = await ledger.get();
    if (entry && (entry.actorId !== ctx.user.id || entry.action !== 'add' || entry.section !== ctx.req.params.list ||
        entry.companyId !== ctx.companyId || entry.table !== table || entry.baseId !== ctx.c.baseId || entry.updatedAt !== ctx.c.updatedAt))
      fail(409, bindingError);
    return {ledger, entry};
  }
  async function editor(ctx: Context) {
    const {req, res, c, adapter, companyId} = ctx;
    const {schema, table, list} = await itemContext(ctx);
    const row = req.params.rowId ? await adapter.readRecord(table, req.params.rowId) : null;
    const companyIds = ids(row?.fields[schema.link.name] ?? [], recordIdPattern);
    if (row && !companyIds.includes(companyId)) fail(403, 'Forbidden');
    const fields = itemValues(schema, row?.fields ?? {}, !row);
    const candidates = row ? [] : (await adapter.loadAll())[list];
    const describe = ({id,name,brand,plant}: typeof candidates[number]) => ({id,name,brand,plant});
    const choices = Object.entries(schema.fields).filter(([, f]) => f.type === 'singleSelect');
    const entry = !row && req.query?.operationId ? (await pendingAdd(ctx, table, req.query.operationId)).entry : null;
    res.json({ ...(!row && {addScope: [c.agencyId, ctx.user.id, c.baseId, c.updatedAt],
        pending: entry && entry.outcome !== 'abandoned' ? {name: entry.requested?.name, recordId: entry.recordId} : null}),
      fields, companyIds, baseId: c.baseId, updatedAt: c.updatedAt, warnings: schema.warnings,
      typeOptions: Object.fromEntries(choices.map(([k,f]) => [k, f.options!.choices!.map(v => v.name)])),
      fieldTypes: Object.fromEntries(Object.entries(schema.fields).map(([k,f]) => [k,f.type])),
      ...(!row && { existing: candidates.filter(item => !item.companyIds.includes(companyId)).map(describe),
        linked: candidates.filter(item => item.companyIds.includes(companyId)).map(describe) }) });
  }
  app.get(listPath + '/add', route('admin', editor));
  app.post(listPath + '/reconcile', route('admin', async ctx => {
    const {req, res, c, adapter, companyId} = ctx;
    const {operationId, recordId, decision} = req.body ?? {};
    bound(c, req.body?.baseId, req.body?.updatedAt);
    const {schema, table} = await itemContext(ctx);
    const {ledger, entry} = await pendingAdd(ctx, table, operationId);
    if (decision === 'abandon') {
      if (entry && entry.outcome !== 'confirmed') await ledger.finish({...entry, outcome:'abandoned'});
      return res.json({abandoned:true});
    }
    if (decision !== 'accept' || !entry || entry.outcome === 'abandoned' || !entry.requested?.name ||
        !recordIdPattern.test(recordId) || entry.recordId && entry.recordId !== recordId) fail(409, staleItem);
    const row = await adapter.readRecord(table, recordId);
    const fields = itemValues(schema, row.fields);
    if (!ids(row.fields[schema.link.name] ?? [], recordIdPattern).includes(companyId) ||
        !Object.entries(entry.requested).every(([key,value]) => fields[key] === value)) fail(409, staleItem);
    await ledger.finish({...entry, recordId, outcome:'confirmed'});
    res.json({saved:true, recordId, ...await deps.republish(c, adapter)});
  }));
  app.get(rowPath + '/edit', route('edit', editor));
  app.get(rowPath + '/relationship', route('admin', async ctx => {
    const {schema, table} = await itemContext(ctx);
    const row = await ctx.adapter.readRecord(table, ctx.req.params.rowId);
    ctx.res.json({ companyIds: ids(row.fields[schema.link.name] ?? [], recordIdPattern), baseId: ctx.c.baseId, updatedAt: ctx.c.updatedAt });
  }));
  async function writeItem(ctx: Context, action: 'add' | 'edit' | 'unlink' | 'restore') {
    const {req, c, adapter, companyId} = ctx;
    const body = req.body ?? {};
    bound(c, body.baseId, body.updatedAt);
    const {schema, table, list} = await itemContext(ctx);
    const isFields = action === 'edit' || action === 'add';
    const desired = isFields ? guardSourceWrite(c, list, body.fields, schema) : {};
    if (action === 'add' && !desired.name) fail(400, 'Enter an item name.');
    const link = schema.link.name;
    return operate(ctx, action, table, { changedFields: isFields ? Object.keys(desired) : ['companyLink'] }, body, async (entry, sent) => {
      const patch: Record<string, unknown> = Object.create(null);
      const row = action === 'add' ? null : await adapter.readRecord(table, req.params.rowId);
      const links = ids(row?.fields[link] ?? [], recordIdPattern);
      if (row && action === 'edit' && !links.includes(companyId)) fail(403, 'Forbidden');
      if (isFields) {
        const current = itemValues(schema, row?.fields ?? {}, !row);
        entry.requested = desired;
        if (row) entry.previous = Object.fromEntries(Object.keys(desired).filter(key => key in current).map(key => [key,current[key]]));
        for (const [key, value] of Object.entries(desired)) {
          if (!Object.hasOwn(current, key)) fail(400, 'Only mapped list columns can be edited.');
          if (row) {
            if (!body.originals || !Object.hasOwn(body.originals, key)) fail(400, 'Include the original value for every changed field.');
            const original = body.originals[key];
            if (!(original === null || typeof original === (schema.fields[key].type === 'checkbox' ? 'boolean' : 'string')))
              fail(400, 'Include the original value for every changed field.');
            if (current[key] === value) continue;
            if (current[key] !== body.originals[key]) fail(409, staleItem);
          }
          patch[schema.fields[key].name] = value;
        }
        if (!row) patch[link] = [companyId];
      } else {
        const original = ids(body.companyIds, recordIdPattern);
        if (!sameIds(original, links)) {
          const alreadyRestored = action === 'restore' && sameIds([...new Set([...original, companyId])], links);
          if (!alreadyRestored) fail(409, staleItem);
        }
        if (action === 'unlink' && !links.includes(companyId)) fail(403, 'Forbidden');
        const next = action === 'unlink' ? links.filter(id => id !== companyId) : [...new Set([...links, companyId])];
        if (!sameIds(links, next)) patch[link] = next;
        entry.originalIds = links;
      }
      if (!Object.keys(patch).length) return;
      await sent();
      if (row && !isFields) {
        const fresh = await adapter.readRecord(table, row.id);
        if (!sameIds(links, ids(fresh.fields[link] ?? [], recordIdPattern)))
          throw Object.assign(Error(staleItem), {status:409, definiteRejection:true});
      }
      // A rejected mutation differs from a failed read-back after a successful mutation.
      const onMutationError = (error: any): never => {
        if (error.airtable && error.status >= 400 && error.status < 500) error.definiteRejection = true;
        throw error;
      };
      if (row) await adapter.patchRecord(table, row.id, patch).catch(onMutationError);
      else {
        const created = await adapter.createRecord(table, patch).catch(onMutationError);
        if (!recordIdPattern.test(created?.id ?? '')) throw Error('Missing record ID');
        entry.recordId = created.id;
      }
      const after = await adapter.readRecord(table, entry.recordId!);
      const confirmed = itemValues(schema, after.fields);
      if (Object.entries(desired).some(([k,v]) => confirmed[k] !== v) ||
          patch[link] && !sameIds(ids(after.fields[link] ?? [], recordIdPattern), patch[link] as string[]))
        throw Error('Airtable confirmation did not match.');
    });
  }
  app.post(listPath, route('admin', ctx => writeItem(ctx, 'add')));
  app.patch?.(rowPath, route('edit', ctx => writeItem(ctx, 'edit')));
  for (const action of ['unlink', 'restore'] as const) app.post(rowPath + '/' + action, route('admin', ctx => writeItem(ctx, action)));
  async function documentTarget({req, c, adapter, companyId}: Context) {
    const list = req.params.rowId ? 'ingredients' : 'companies';
    const config = c.mapping[list], tables = await adapter.readSchema();
    const table = tableSchema(tables, config.table);
    const column = attachmentColumn(table, config.locAttachment, list);
    const id = req.params.rowId || companyId;
    const link = list === 'ingredients' ? itemSchema(c, list, tables).link : null;
    async function read() {
      const row = await adapter.readRecord(table.name, id);
      if (link && !ids(row.fields[link.name] ?? [], recordIdPattern).includes(companyId)) fail(403, 'Forbidden');
      const raw = column ? row.fields[column.name] : undefined;
      const all = docRows(raw);
      return { all, ids: all.map(f => f.id), raw: (raw ?? []) as {id: string; url?: string}[] };
    }
    return { read, table, column, id };
  }
  for (const path of [root + '/documents', root + '/items/ingredients/:rowId/documents']) {
    app.get(path, route('documents', async ctx => {
      const target = await documentTarget(ctx);
      const files = await target.read();
      ctx.res.json({ attachments: files.all.filter(pdfType), attachmentIds: files.ids, configured: !!target.column,
        baseId: ctx.c.baseId, updatedAt: ctx.c.updatedAt });
    }));
    app.get(path + '/:attachmentId/open', route('documents', async ctx => {
      const files = await (await documentTarget(ctx)).read();
      const id = ctx.req.params.attachmentId;
      if (!files.all.some(f => f.id === id && pdfType(f))) fail(403, 'Forbidden');
      const url = new URL(files.raw.find(f => f.id === id)?.url ?? 'about:blank');
      if (url.protocol !== 'https:' || !/(^|\.)(airtableusercontent\.com|airtable\.com)$/i.test(url.hostname))
        fail(503, "Couldn't open the PDF from Airtable. Try again.");
      ctx.res.json({ url: url.href });
    }));
    app.post(path, route('documents', async ctx => {
      const {req, res, c, adapter} = ctx;
      const h = req.headers;
      bound(c, h['x-base-id'], h['x-connection-updated-at']);
      const {bytes, filename} = await readPdf(req, res);
      let baseline: string[];
      try { baseline = ids(JSON.parse(h['x-attachment-ids']), /^att[A-Za-z0-9]+$/); } catch { fail(409, staleFiles); }
      const target = await documentTarget(ctx);
      if (!target.column) fail(409, noField);
      const column = target.column;
      const replaceId = h['x-replace-id'];
      // Authorize the live relationship even for a replay of a confirmed operation.
      const initial = await target.read();
      return operate(ctx, 'upload', target.table.name, { originalIds: baseline, ...(replaceId && { replaceId }), filename, size: bytes.length },
        [target.id, column.id, baseline, replaceId, filename, createHash('sha256').update(bytes).digest('hex')], async (entry, sent) => {
          if (!sameIds(initial.ids, baseline) || replaceId && !initial.all.some(f => f.id === replaceId && pdfType(f))) fail(409, staleFiles);
          await sent();
          try { await adapter.uploadPdf(target.id, column.id || column.name, filename, bytes); }
          catch (err: any) {
            if (err.airtable && err.status < 500) { err.definiteRejection = true; throw err; }
            // The request may have committed. Reconcile by ID delta, filename and size.
          }
          const after = await target.read();
          const matches = after.all.filter(f => !baseline.includes(f.id) && f.filename === filename && f.size === bytes.length && pdfType(f));
          if (matches.length !== 1) throw Error('Upload could not be identified.');
          entry.newId = matches[0].id;
          if (!replaceId) return;
          const expected = [...baseline, entry.newId];
          if (!sameIds(expected, after.ids)) throw Error('Concurrent attachment change.');
          const finalBaseline = await target.read();
          if (!sameIds(expected, finalBaseline.ids)) throw Error('Concurrent attachment change.');
          const retained = finalBaseline.ids.filter(id => id !== replaceId);
          await adapter.patchRecord(target.table.name, target.id, { [column.name]: retained.map(id => ({ id })) });
          if (!sameIds((await target.read()).ids, retained)) throw Error('Replacement could not be confirmed.');
        });
    }));
  }
}
