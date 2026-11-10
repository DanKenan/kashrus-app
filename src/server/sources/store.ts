import fs from 'node:fs/promises';
import path from 'node:path';
import type { Backup } from './cache.ts';
import type { SourceKind, SourceMapping } from './types.ts';

export interface Connection {
  agencyId: string; sourceType: SourceKind; baseId: string; access: 'read' | 'readwrite';
  mapping: SourceMapping; encryptedKey: string; keyHint: string; updatedAt: string; updatedBy: string;
  backupHashes: Record<string, string>; lastRefresh?: { at: string; ok: boolean; calls: number; error?: string };
}
export function boundedBackup(backup: Backup): Backup & { truncated?: boolean } {
  // Firestore rejects undefined scalars; JSON also matches the local format.
  backup = JSON.parse(JSON.stringify(backup));
  const out = { ...backup, ingredients: [] as Backup['ingredients'], products: [] as Backup['products'], truncated: true };
  if (Buffer.byteLength(JSON.stringify(backup)) <= 700 * 1024) return backup;
  for (const kind of ['ingredients', 'products'] as const) {
    for (const item of backup[kind]) {
      (out[kind] as any[]).push(item);
      if (Buffer.byteLength(JSON.stringify(out)) > 700 * 1024) { out[kind].pop(); return out; }
    }
  }
  return out;
}
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
  async function save(connection: Connection, backups: Backup[] = []) {
    if (deps.staged()) return;
    const writes = backups.map(b => ({ collection: 'sourceBackups', id: `${connection.agencyId}__${b.companyId}`, doc: boundedBackup(b) }));
    writes.push({ collection: 'sourceConnections', id: connection.agencyId, doc: connection as any });
    const db = deps.db();
    if (db) {
      const apply = (batch: any) => {
        for (const w of writes) batch.set(db.collection(w.collection).doc(w.id), w.doc);
      };
      if (typeof db.batch === 'function') {
        const batch = db.batch(); apply(batch); await batch.commit();
      } else {
        // The stage2 adapter only supplies transactions. A write-only
        // transaction still commits the entire batch atomically, with no reads.
        await db.runTransaction(async (tx: any) => apply(tx));
      }
    } else {
      for (const w of writes) {
        const target = file(w.collection, w.id);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target + '.tmp', JSON.stringify(w.doc));
        await fs.rename(target + '.tmp', target);
      }
    }
  }
  async function load(agencyId: string, companyIds: string[]): Promise<Backup[]> {
    const db = deps.db();
    if (db) {
      const docs = await Promise.all(companyIds.map(id => db.collection('sourceBackups').doc(`${agencyId}__${id}`).get()));
      return docs.filter(d => d.exists).map(d => d.data()).filter(b => b.agencyId === agencyId);
    }
    return (await list('sourceBackups')).filter(b => b.agencyId === agencyId);
  }
  async function raw(id: string): Promise<Connection | null> {
    const db = deps.db();
    if (db) { const snap = await db.collection('sourceConnections').doc(id).get(); return snap.exists ? snap.data() : null; }
    try { return JSON.parse(await fs.readFile(file('sourceConnections', id), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  return { connections: () => list('sourceConnections') as Promise<Connection[]>, save, load, raw };
}
