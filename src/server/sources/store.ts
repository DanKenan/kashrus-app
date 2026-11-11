import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Backup } from './cache.ts';
import type { SourceKind, SourceMapping } from './types.ts';

export interface Connection {
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
  async function save(connection: Connection, backups: Backup[] = []) {
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
    await commit([{ collection: 'sourceConnections', id: connection.agencyId, doc: { ...connection, backupParts: counts } }]);
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
  return { connections: () => list('sourceConnections') as Promise<Connection[]>, save, load, raw };
}
