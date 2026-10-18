/**
 * Stage 4 PR R: Restore tool tests.
 * Proves: production/(default)/non-throwaway refusal; non-empty target refusal;
 * checksum mismatch refusal; successful restore writes counts matching manifest.
 */
import { runRestore } from '../../src/server/restore-backup.ts';
import * as crypto from 'crypto';

// --- Mocks ---

function createMockDb(existingDocs = {}) {
  const docs = new Map(Object.entries(existingDocs));
  return {
    _docs: docs,
    doc(path) {
      return {
        _path: path,
        async get() {
          return { exists: docs.has(path), data: () => docs.get(path) };
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          return { _path: `${name}/${id}` };
        },
        limit(n) {
          return {
            async get() {
              const has = [...docs.keys()].some(k => k.startsWith(name + '/'));
              return { empty: !has };
            },
          };
        },
      };
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

    // Test 7: Dry run without --confirm writes nothing
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
      console.log('  ✓ dry run without --confirm writes nothing');
    }

    console.log('  ✓ All restore tests passed');
  },
};
