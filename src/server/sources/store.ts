import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AddAudit, AirtableEditAudit, EditAudit } from './tagged-row.ts';
import type { Backup } from './cache.ts';
import type { Group1Overrides, SourceKind, SourceMapping } from './types.ts';

export interface Connection {
  sheetsPilot?: import('./google-sheets.ts').TaggedTable; // Existing Fee pilot connections
  sheetsTables?: Partial<Record<'companies' | 'ingredients' | 'products', import('./google-sheets.ts').TaggedTable>>;
  oauth?: Partial<Record<import('./oauth.ts').OAuthProvider, import('./oauth.ts').OAuthRecord>>;
  upload?: {fileNames:string[];copiedAt:string;rows:number;parts:number;hash:string;versioned?:boolean;slotHash?:string};
  fees?: {mashgiach?:Record<string,{amount:number;currency:string}>};
  group1Label?: string; group1Overrides?: Group1Overrides;
  agencyId: string; sourceType: SourceKind; baseId: string; access: 'read' | 'readwrite';
  mapping: SourceMapping; encryptedKey: string; keyHint: string; updatedAt: string; updatedBy: string;
  backupParts?: Record<string, { parts: number; hash: string }>; backupHashes: Record<string, string>; lastRefresh?: { at: string; ok: boolean; calls: number; error?: string };
}
// Normalize undefined values without discarding any items.
export function boundedBackup(backup: Backup): Backup {
  return JSON.parse(JSON.stringify(backup));
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function createSourceStore(deps: { db(): any; dataDir: string; staged(): boolean }) {
  const dir = path.join(deps.dataDir, 'source-connections');
  const file = (collection: string, id: string) => path.join(dir, collection, encodeURIComponent(id) + '.json');
  async function list(collection: string): Promise<any[]> {
    const db = deps.db();
    if (db) return (await db.collection(collection).get()).docs.map((d: any) => d.data());
    let names: string[];
    try { names = await fs.readdir(path.join(dir, collection)); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(dir, collection, n), 'utf8').then(JSON.parse)));
  }
  type Write = { collection: string; id: string; doc?: any };
  async function commit(writes: Write[]) {
    if (deps.staged()) return;
    const db = deps.db();
    for (let offset = 0; offset < writes.length;) {
      const chunk: Write[] = [];
      let bytes = 0;
      while (offset < writes.length && chunk.length < 400) {
        const size = Buffer.byteLength(JSON.stringify(writes[offset])) + 1024;
        if (chunk.length && bytes + size > 8 * 1024 * 1024) break;
        bytes += size; chunk.push(writes[offset++]);
      }
      if (db) {
        const apply = (batch: any) => {
          for (const w of chunk) {
            const ref = db.collection(w.collection).doc(w.id);
            if (w.doc === undefined) batch.delete(ref); else batch.set(ref, w.doc);
          }
        };
        if (typeof db.batch === 'function') { const batch = db.batch(); apply(batch); await batch.commit(); }
        else await db.runTransaction(async (tx: any) => apply(tx));
      } else {
        for (const w of chunk) {
          const target = file(w.collection, w.id);
          if (w.doc === undefined) { await fs.rm(target, { force: true }); continue; }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target + '.tmp', JSON.stringify(w.doc));
          await fs.rename(target + '.tmp', target);
        }
      }
    }
  }
  async function read(collection: string, id: string): Promise<any> {
    const db = deps.db();
    if (db) { const snap = await db.collection(collection).doc(id).get(); return snap.exists ? snap.data() : null; }
    try { return JSON.parse(await fs.readFile(file(collection, id), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function save(connection: Connection, backups: Backup[] = [], previousUpload?: Connection['upload']) {
    if (deps.staged()) return;
    const counts = { ...connection.backupParts };
    for (const backup of backups) {
      const id = `${connection.agencyId}__${backup.companyId}`;
      const text = JSON.stringify(boundedBackup(backup));
      // Base64 chunks bound the encoded document size even for escaped text.
      const hash = digest(text);
      const encoded = Buffer.from(text).toString('base64'), parts = Math.ceil(encoded.length / (480 * 1024));
      const writes: Write[] = Array.from({ length: parts }, (_, i) => ({ collection: 'sourceBackupParts', id: `${id}__${hash}__${i}`, doc: { data: encoded.slice(i * 480 * 1024, (i + 1) * 480 * 1024) } }));
      await commit(writes);
      // Immutable parts leave the previous backup usable until this manifest commits.
      await commit([{ collection: 'sourceBackups', id, doc: { parts, hash, savedAt: backup.takenAt } }]);
      const old = counts[backup.companyId];
      if (old && old.hash !== hash) {
        await commit(Array.from({ length: old.parts }, (_, n) => ({ collection: 'sourceBackupParts', id: `${id}__${old.hash}__${n}` })));
      }
      counts[backup.companyId] = { parts, hash };
    }
    await activate({...connection, backupParts:counts}, previousUpload);
    connection.backupParts = counts;
  }
  async function load(agencyId: string, companyIds: string[]): Promise<Backup[] & { invalidCompanyIds?: string[] }> {
    const out: Backup[] & { invalidCompanyIds?: string[] } = [];
    out.invalidCompanyIds = [];
    for (const companyId of companyIds) {
      const id = `${agencyId}__${companyId}`;
      try {
        const manifest = await read('sourceBackups', id);
        if (!manifest || !Number.isInteger(manifest.parts) || manifest.parts < 1) throw Error('Invalid manifest');
        const chunks = await Promise.all(Array.from({ length: manifest.parts }, (_, i) => read('sourceBackupParts', `${id}__${manifest.hash}__${i}`)));
        if (chunks.some(p => typeof p?.data !== 'string')) throw Error('Missing part');
        const text = Buffer.from(chunks.map(p => p.data).join(''), 'base64').toString('utf8');
        if (digest(text) !== manifest.hash) throw Error('Invalid hash');
        const backup = JSON.parse(text);
        if (backup.agencyId !== agencyId || backup.companyId !== companyId) throw Error('Invalid company');
        out.push(backup);
      } catch { out.invalidCompanyIds.push(companyId); }
    }
    return out;
  }
  async function raw(id: string): Promise<Connection | null> {
    const db = deps.db();
    if (db) { const snap = await db.collection('sourceConnections').doc(id).get(); return snap.exists ? snap.data() : null; }
    try { return JSON.parse(await fs.readFile(file('sourceConnections', id), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function saveUpload(connection:Connection, files:import('./upload.ts').UploadedFile[]) {
    if(deps.staged()) throw Error('Writes blocked');
    const text=JSON.stringify(files);
    if(Buffer.byteLength(text)>3*1024*1024) throw Object.assign(Error('This file is too big to copy. Split it into smaller files.'),{status:400});
    const encoded=Buffer.from(text).toString('base64'), hash=digest(text), parts=Math.ceil(encoded.length/(480*1024));
    const old=connection.upload;
    // Firestore overwrites existing chunk slots in the same atomic batch as the manifest.
    // Local files keep content-addressed slots until the manifest rename completes.
    const slot = deps.db() ? {versioned:old?.versioned ?? false, ...(old?.versioned ? {slotHash:old.slotHash ?? old.hash} : {})} : {versioned:true};
    const upload={...slot,fileNames:files.map(f=>f.name),copiedAt:new Date().toISOString(),rows:files.reduce((n,f)=>n+f.tabs.reduce((n,t)=>n+t.rows.length,0),0),parts,hash};
    const partId = (i:number) => uploadPart(connection.agencyId,upload,i);
    const chunks = Array.from({length:parts},(_,i)=>({collection:'sourceUploads',id:partId(i),doc:{data:encoded.slice(i*480*1024,(i+1)*480*1024)}}));
    await activate({...connection, upload}, old, chunks);
    connection.upload=upload;
  }
  // Filesystem renames commit one manifest at a time. Reclaim unreachable chunks under the
  // same lock as activation so recovery cannot delete chunks from an in-progress upload.
  let localWrites: Promise<void> = Promise.resolve();
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  function localWrite(fn: () => Promise<void>) {
    const next = localWrites.then(fn);
    localWrites = next.catch(() => {});
    return next;
  }
  async function reclaimLocalUploads() {
    if (deps.db() || deps.staged()) return;
    await localWrite(async () => {
      let names: string[];
      try { names = await fs.readdir(path.join(dir,'sourceUploads')); }
      catch (e:any) { if (e.code === 'ENOENT') return; throw e; }
      const active = new Set<string>();
      for (const c of await list('sourceConnections')) {
        if (!c.upload) continue;
        // Keep all chunks when the manifest itself needs recovery.
        if (!Number.isInteger(c.upload.parts) || c.upload.parts < 1 || c.upload.parts > 10) return;
        for (let i=0; i<c.upload.parts; i++) active.add(uploadPart(c.agencyId,c.upload,i));
      }
      for (const name of names) {
        if (name.endsWith('.json') && !active.has(decodeURIComponent(name.slice(0,-5))))
          await fs.rm(path.join(dir,'sourceUploads',name),{force:true});
      }
    });
  }
  function retryLocalCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = undefined;
      void reclaimLocalUploads().catch(retryLocalCleanup);
    },5000);
    cleanupTimer.unref();
  }
  async function activate(c:Connection, previous:Connection['upload'], chunks:Write[] = []) {
    const manifest = {collection:'sourceConnections', id:c.agencyId, doc:c};
    const live = new Set(Array.from({length:c.upload?.parts || 0}, (_,i)=>uploadPart(c.agencyId,c.upload!,i)));
    const obsolete = Array.from({length:previous?.parts || 0}, (_,i)=>uploadPart(c.agencyId,previous!,i))
      .filter(id => !live.has(id)).map(id => ({collection:'sourceUploads',id}));
    // At most 3 MiB of source data: the encoded chunks, manifest and deletes fit one Firestore batch.
    // A rejected batch leaves the old connection intact and the entire activation can be retried.
    if (deps.db()) {
      await commit([...chunks, manifest, ...obsolete]);
      return;
    }
    await localWrite(async () => {
      try { await commit([...chunks, manifest]); }
      catch (error) { retryLocalCleanup(); throw error; }
      await commit(obsolete).catch(retryLocalCleanup);
    });
  }
  function uploadPart(id:string, upload:NonNullable<Connection['upload']>, i:number) {
    return `${id}__copy__${upload.versioned ? (upload.slotHash ?? upload.hash) + '__' : ''}${i}`;
  }
  async function loadUpload(c:Connection):Promise<import('./upload.ts').UploadedFile[]> {
    if (!c.upload || !Number.isInteger(c.upload.parts) || c.upload.parts < 1 || c.upload.parts > 10) throw Error('Invalid upload manifest');
    const parts=await Promise.all(Array.from({length:c.upload.parts},(_,i)=>read('sourceUploads',uploadPart(c.agencyId,c.upload!,i))));
    if(parts.some(p=>typeof p?.data!=='string'))throw Error('Missing upload part');
    const text=Buffer.from(parts.map(p=>p.data).join(''),'base64').toString('utf8');if(digest(text)!==c.upload.hash)throw Error('Invalid upload');const files = JSON.parse(text);
    if (!Array.isArray(files) || !files.length || files.length > 3 || files.some(f =>
      typeof f?.name !== 'string' || !Array.isArray(f.tabs) || f.tabs.some((t:any) =>
        !Array.isArray(t.columns) || !Array.isArray(t.rows) || t.rows.some((r:any) => typeof r?.id !== 'string' || !r.fields)))) throw Error('Invalid upload');
    return files;
  }
  async function remove(c:Connection) {
    if(deps.staged())throw Error('Writes blocked');
    const removals = [{collection:'sourceConnections',id:c.agencyId},...Array.from({length:c.upload?.parts||0},(_,i)=>({collection:'sourceUploads',id:uploadPart(c.agencyId,c.upload!,i)}))];
    if (deps.db()) await commit(removals);
    else await localWrite(async () => { await commit(removals.slice(0,1)); await commit(removals.slice(1)).catch(retryLocalCleanup); });
  }
  const auditCollection = 'sourceFeeAudit';
  async function saveEditAudit(entry: EditAudit | AirtableEditAudit) {
    if (deps.staged()) throw Error('Writes blocked');
    await commit([{ collection: auditCollection, id: entry.operationId, doc: entry }]);
  }

  function addLedger(agencyId: string, token: string) {
    const id = 'add-' + digest(JSON.stringify([agencyId, token]));
    async function update(choose: (current: AddAudit | null) => AddAudit | undefined) {
      if (deps.staged()) throw Error('Writes blocked');
      const db = deps.db();
      if (db) {
        const ref = db.collection(auditCollection).doc(id);
        return db.runTransaction(async (tx: any) => {
          const doc = await tx.get(ref);
          const current: AddAudit | null = doc.exists ? doc.data() : null;
          const next = choose(current);
          if (next) tx.set(ref, next);
          return current;
        });
      }
      let current: AddAudit | null = null;
      await localWrite(async () => {
        current = await read(auditCollection, id);
        const next = choose(current);
        if (next) await commit([{ collection: auditCollection, id, doc: next }]);
      });
      return current;
    }
    return {
      get: (): Promise<AddAudit | null> => read(auditCollection, id),
      claim: (entry: AddAudit) => update(current => current ? undefined : entry),
      abandon(actorId: string, section: AddAudit['section']) {
        return update(current => {
          if (current?.actorId !== actorId || current.section !== section) return;
          if (current.outcome === 'attempted' || current.outcome === 'unconfirmed')
            // Keep the workbook quarantine if Google commits after abandonment.
            return { ...current, outcome: 'abandoned', abandonedAt: new Date().toISOString() };
        });
      },
      async finish(entry: AddAudit) {
        const prior = await update(current => {
          if (current?.operationId !== entry.operationId) throw Error('Missing Add operation');
          if (['confirmed', 'rejected', 'abandoned'].includes(current.outcome)) return;
          if (entry.outcome === 'unconfirmed' && current.outcome === 'unconfirmed' &&
              (!entry.metadataId || entry.metadataId === current.metadataId)) return;
          const next = { ...entry };
          if (next.outcome === 'confirmed' || next.outcome === 'rejected') delete next.pendingSpreadsheetId;
          return next;
        });
        return prior?.outcome !== 'abandoned' && prior?.outcome !== 'rejected';
      },
    };
  }

  async function sheetAdds(spreadsheetId: string, pendingOnly = false): Promise<AddAudit[]> {
    const field = pendingOnly ? 'pendingSpreadsheetId' : 'addSpreadsheetId';
    const db = deps.db();
    if (db) return (await db.collection(auditCollection).where(field, '==', spreadsheetId).get()).docs.map((d: any) => d.data());
    return (await list(auditCollection)).filter(entry => entry[field] === spreadsheetId);
  }

  return { saveEditAudit, addLedger, sheetAdds, retryLocalCleanup, reclaimLocalUploads,
    connections: async () => (await list('sourceConnections')).map(normalizeConnection), save, load, raw, saveUpload, loadUpload, remove };
}
// Read legacy connection settings without rewriting source values.
export function normalizeConnection(connection: any): Connection {
  const mapping = { ...connection.mapping };
  mapping.group1Values = mapping.group1Values ?? mapping.noSymbolValues ?? ['Group 1'];
  delete mapping.noSymbolValues;
  return { ...connection, mapping, group1Label: connection.group1Label || 'Group 1' };
}
