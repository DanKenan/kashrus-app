/**
 * Stage 4 PR R: Restore tool tests.
 * Proves: production/(default)/non-throwaway refusal; non-empty target refusal;
 * checksum mismatch refusal; successful restore writes counts matching manifest.
 */
import { runRestore } from '../../src/server/restore-backup.ts';
import * as crypto from 'crypto';

// --- Mocks ---

function createMockDb(existingDocs = {}, opts = {}) {
  const docs = new Map(Object.entries(existingDocs));
  const listError = opts.listError || null;
  // Derive collection names from doc paths
  const collectionNames = new Set();
  for (const k of docs.keys()) {
    const parts = k.split('/');
    if (parts.length >= 2) collectionNames.add(parts[0]);
  }
  // Always include the known collections so listCollections finds them
  for (const c of ['tasks', 'venues', 'users', 'usersByEmail', 'media']) collectionNames.add(c);
  return {
    _docs: docs,
    _collectionNames: collectionNames,
    doc(path) {
      return {
        _path: path,
        async get() {
          return { exists: docs.has(path), data: () => docs.get(path) };
        },
      };
    },
    collection(name) {
      const makeColl = (n) => ({
        _collName: n,
        doc(id) {
          const docPath = `${n}/${id}`;
          return {
            _path: docPath,
            async get() {
              return { exists: docs.has(docPath), data: () => docs.get(docPath) };
            },
          };
        },
        limit(x) {
          return {
            async get() {
              const has = [...docs.keys()].some(k => k.startsWith(n + '/'));
              return { empty: !has };
            },
          };
        },
        async get() {
          const matching = [...docs.keys()].filter(k => k.startsWith(n + '/'));
          return {
            size: matching.length,
            docs: matching.map(k => ({ id: k.split('/')[1], data: () => docs.get(k) })),
          };
        },
      });
      return makeColl(name);
    },
    async listCollections() {
      if (listError) throw new Error(listError);
      return [...collectionNames].map(n => {
        const c = {
          id: n,
          _collName: n,
          limit: (x) => ({
            async get() {
              const has = [...docs.keys()].some(k => k.startsWith(n + '/'));
              return { empty: !has };
            },
          }),
        };
        return c;
      });
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) {
          ops.push({ ref, data });
        },
        async commit() {
          for (const { ref, data } of ops) {
            docs.set(ref._path, data);
          }
        },
      };
    },
  };
}

function createMockStorage(manifest, dataJson) {
  const files = new Map();
  files.set('manifest.json', JSON.stringify(manifest));
  files.set('backup.json', dataJson);
  return {
    bucket(name) {
      return {
        file(path) {
          const filename = path.split('/').pop();
          return {
            async download() {
              const content = files.get(filename);
              if (!content) throw new Error(`Not found: ${path}`);
              return [Buffer.from(content)];
            },
          };
        },
      };
    },
  };
}

const PROD_DB = 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d';
const PROD_PROJECT = 'gen-lang-client-0875538181';

function makeBackup() {
  const payload = {
    monolith: { _v: 5, venues: [{ id: 'v1', name: 'Crown' }], users: [] },
    collections: {
      tasks: [],
      venues: [{ id: 'v1', name: 'Crown', _v: 1 }],
      users: [{ id: 'u1', email: 'a@x.com', _v: 1 }],
      usersByEmail: [],
      media: [],
    },
  };
  const dataJson = JSON.stringify(payload);
  const checksum = crypto.createHash('sha256').update(dataJson, 'utf8').digest('hex');
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    databaseId: PROD_DB,
    tier: 'tier1',
    collections: { tasks: 0, venues: 1, users: 1, usersByEmail: 0, media: 0 },
    monolithPresent: true,
    monolithVersion: 5,
    checksum,
    secretsScrubbed: true,
  };
  return { manifest, dataJson };
}

export default {
  name: 'Stage 4 PR R: Restore tool',
  whatItProves: 'Refuses unsafe targets; verifies checksum; restores counts matching manifest.',
  run: async () => {
    const SOURCE = 'gs://test-bucket/tier1/2026-10-18/abc123/';
    const base = { source: SOURCE, projectId: PROD_PROJECT, confirm: true };

    // Test 1: Refuses production DB
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: PROD_DB, firestoreDb: db, storage });
        throw new Error('Should have refused production DB');
      } catch (e) {
        if (!e.message.includes('PRODUCTION')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses production database');
    }

    // Test 2: Refuses (default)
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: '(default)', firestoreDb: db, storage });
        throw new Error('Should have refused (default)');
      } catch (e) {
        if (!e.message.includes('(default)')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses (default)');
    }

    // Test 3: Refuses non-throwaway name
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'my-test-db', firestoreDb: db, storage });
        throw new Error('Should have refused non-throwaway name');
      } catch (e) {
        if (!e.message.includes('restore-drill-')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses non-throwaway naming');
    }

    // Test 4: Refuses non-empty target (mock enforces the empty-target rule)
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb({ 'venues/v1': { id: 'v1', name: 'Existing' } });
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-001', firestoreDb: db, storage });
        throw new Error('Should have refused non-empty target');
      } catch (e) {
        if (!e.message.includes('not empty')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses non-empty target');
    }

    // Test 5: Refuses checksum mismatch
    {
      const { manifest, dataJson } = makeBackup();
      const tampered = dataJson.replace('Crown', 'Hacked');
      const db = createMockDb();
      const storage = createMockStorage(manifest, tampered);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-002', firestoreDb: db, storage });
        throw new Error('Should have refused checksum mismatch');
      } catch (e) {
        if (!e.message.includes('CHECKSUM MISMATCH')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses checksum mismatch');
    }

    // Test 6: Successful restore — counts match manifest
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      const storage = createMockStorage(manifest, dataJson);
      const { counts } = await runRestore({
        ...base,
        targetDb: 'restore-drill-003',
        firestoreDb: db,
        storage,
      });
      if (counts['venues'] !== 1) throw new Error(`venues count wrong: ${counts['venues']}`);
      if (counts['users'] !== 1) throw new Error(`users count wrong: ${counts['users']}`);
      if (counts['tasks'] !== 0) throw new Error(`tasks count wrong: ${counts['tasks']}`);
      if (counts['app-state/main'] !== 1) throw new Error('monolith not restored');
      if (!db._docs.has('venues/v1')) throw new Error('venue doc not written');
      if (!db._docs.has('app-state/main')) throw new Error('monolith not written');
      console.log('  ✓ successful restore: counts match manifest');
    }

    // Test 7: Dry run without --confirm writes nothing (but still validates)
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      const storage = createMockStorage(manifest, dataJson);
      const { counts } = await runRestore({
        ...base,
        confirm: false,
        targetDb: 'restore-drill-004',
        firestoreDb: db,
        storage,
      });
      if (Object.keys(counts).length !== 0) throw new Error('Dry run should not write');
      if (db._docs.size !== 0) throw new Error('Dry run wrote to DB!');
      console.log('  ✓ validated dry run writes nothing');
    }

    // Test 8: Refuses non-empty UNRELATED collection (e.g. backups)
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb({ 'backups/latest': { tier: 'tier1' } });
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-005', firestoreDb: db, storage });
        throw new Error('Should have refused non-empty unrelated collection');
      } catch (e) {
        if (!e.message.includes('not empty') || !e.message.includes('backups')) {
          throw new Error(`Wrong error: ${e.message}`);
        }
      }
      console.log('  ✓ refuses non-empty unrelated collection');
    }

    // Test 9: Fails closed on listCollections error
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb({}, { listError: 'permission denied' });
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-006', firestoreDb: db, storage });
        throw new Error('Should have failed closed');
      } catch (e) {
        if (!e.message.includes('Fail closed')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ fails closed on collection-enumeration error');
    }

    // Test 10: Malformed manifest rejected BEFORE any writes
    {
      const { manifest, dataJson } = makeBackup();
      const badManifest = { ...manifest, secretsScrubbed: false }; // not confirmed scrubbed
      const db = createMockDb();
      const storage = createMockStorage(badManifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-007', firestoreDb: db, storage });
        throw new Error('Should have rejected bad manifest');
      } catch (e) {
        if (!e.message.includes('secretsScrubbed')) throw new Error(`Wrong error: ${e.message}`);
      }
      if (db._docs.size !== 0) throw new Error('Wrote before manifest validation!');
      console.log('  ✓ malformed manifest rejected before any writes');
    }

    // Test 11: Wrong source database ID rejected
    {
      const { manifest, dataJson } = makeBackup();
      const badManifest = { ...manifest, databaseId: 'some-other-db' };
      // Recompute checksum for the tampered manifest so we test the DB check, not checksum
      const db = createMockDb();
      const storage = createMockStorage(badManifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-008', firestoreDb: db, storage });
        throw new Error('Should have rejected wrong source DB');
      } catch (e) {
        if (!e.message.includes('databaseId')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ wrong source database ID rejected');
    }

    // Test 12: Post-write verification catches count drift
    // (Simulate by having the mock drop a write — verification must catch it)
    {
      const { manifest, dataJson } = makeBackup();
      const db = createMockDb();
      // Wrap batch to silently drop one write
      const origBatch = db.batch.bind(db);
      let dropNext = true;
      db.batch = () => {
        const b = origBatch();
        const origSet = b.set.bind(b);
        b.set = (ref, data) => {
          if (dropNext && ref._path === 'users/u1') {
            dropNext = false;
            return; // silently drop
          }
          origSet(ref, data);
        };
        return b;
      };
      const storage = createMockStorage(manifest, dataJson);
      try {
        await runRestore({ ...base, targetDb: 'restore-drill-009', firestoreDb: db, storage });
        throw new Error('Should have caught verification mismatch');
      } catch (e) {
        if (!e.message.includes('VERIFY FAILED')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ post-write verification catches missing record');
    }

    console.log('  ✓ All restore tests passed');
  },
};
