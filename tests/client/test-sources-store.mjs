import assert from 'node:assert/strict';
import { createSourceStore } from '../../src/server/sources/store.ts';
const docs = new Map(), commits = [];
let fail = false, failAt = Infinity;
const db = {
  collection: collection => ({ doc: id => ({ collection, id, async get() { const value = docs.get(`${collection}/${id}`); return { exists: !!value, data: () => structuredClone(value) }; } }) }),
  batch() { const ops = []; return {
    set(ref, doc) { ops.push({ ref, doc }); }, delete(ref) { ops.push({ ref }); },
    async commit() { assert.ok(ops.length <= 400); assert.ok(Buffer.byteLength(JSON.stringify(ops)) < 8 * 1024 * 1024); if (fail || commits.length === failAt) throw Error('write failed'); commits.push(ops); for (const { ref, doc } of ops) { const key = `${ref.collection}/${ref.id}`; if (doc) { assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 500 * 1024); docs.set(key, structuredClone(doc)); } else docs.delete(key); } },
  }; },
};
const store = createSourceStore({ db: () => db, dataDir: '/unused', staged: () => false });
const connection = { agencyId: 'a', backupHashes: { c: 'content-hash' } };
const backup = { v: 1, agencyId: 'a', companyId: 'c', companyName: 'Factory', takenAt: 'today', hash: 'content-hash', ingredients: Array.from({ length: 7000 }, (_, i) => ({ name: `${i} ${'א"'.repeat(50)}`, noSymbolNeeded: false })), products: [] };
await store.save(connection, [backup]);
assert.deepEqual([...(await store.load('a', ['c']))], [backup]);
const { parts: partCount, hash } = docs.get('sourceBackups/a__c');
assert.ok(partCount > 2);
assert.equal(commits.at(-2)[0].ref.collection, 'sourceBackups');
assert.equal(commits.at(-1)[0].ref.collection, 'sourceConnections');
const removed = docs.get(`sourceBackupParts/a__c__${hash}__1`);
docs.delete(`sourceBackupParts/a__c__${hash}__1`);
let loaded = await store.load('a', ['c']); assert.equal(loaded.length, 0); assert.deepEqual(loaded.invalidCompanyIds, ['c']);
docs.set(`sourceBackupParts/a__c__${hash}__1`, { data: 'wrong' });
assert.equal((await store.load('a', ['c'])).length, 0);
docs.set(`sourceBackupParts/a__c__${hash}__1`, removed);
const small = { ...backup, ingredients: backup.ingredients.slice(0, 1) };
await store.save(connection, [small]);
assert.deepEqual([...(await store.load('a', ['c']))], [small]);
for (let i = 0; i < partCount; i++) assert.equal(docs.has(`sourceBackupParts/a__c__${hash}__${i}`), false);
const prior = structuredClone(docs.get('sourceConnections/a'));
fail = true; await assert.rejects(store.save({ ...connection, backupHashes: { c: 'new' } }, [backup]));
assert.deepEqual(docs.get('sourceConnections/a'), prior);
fail = false; failAt = commits.length + 1; // all new parts commit, manifest fails
await assert.rejects(store.save({ ...connection, backupHashes: { c: 'new' } }, [backup]));
assert.deepEqual([...(await store.load('a', ['c']))], [small]);
assert.deepEqual(docs.get('sourceConnections/a'), prior);
failAt = Infinity;
// More than 400 parts must use multiple bounded commits.
fail = false;
const many = { ...backup, ingredients: [{ name: 'x'.repeat(151 * 1024 * 1024), noSymbolNeeded: false }] };
await store.save(connection, [many]);
await store.save(connection, [small]);
assert.ok(commits.some(ops => ops.length === 400));
console.log('source backup split, integrity, shrink, commit ordering and 400-operation bounds passed');
