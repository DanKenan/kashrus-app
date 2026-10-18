/**
 * Stage 4 PR B: Backup tests.
 */
import { scrubSecrets, runTier1Backup } from '../../src/server/backup.ts';

function createMockDb(monolithData, collections = {}) {
  const docs = new Map();
  for (const [k, v] of Object.entries(collections)) docs.set(k, v);
  return {
    doc(path) {
      return {
        async get() {
          if (path === 'app-state/main') {
            return { exists: !!monolithData, data: () => monolithData };
          }
          const d = docs.get(path);
          return { exists: !!d, data: () => d };
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            async get() {
              const d = docs.get(key);
              return { exists: !!d, data: () => d };
            },
            async set(data) { docs.set(key, data); },
          };
        },
        async get() {
          const result = [];
          for (const [k, v] of docs) {
            if (k.startsWith(name + '/')) result.push({ id: k.split('/')[1], data: () => v });
          }
          return { docs: result, size: result.length };
        },
      };
    },
  };
}

function createMockStorage() {
  const files = new Map();
  return {
    files,
    bucket(name) {
      return {
        file(path) {
          const key = `${name}/${path}`;
          return {
            async save(data, opts) { files.set(key, { data, contentType: opts?.contentType }); },
          };
        },
      };
    },
  };
}

export default {
  name: 'Stage 4 PR B: Tier 1 backup',
  whatItProves: 'Recursive secret scrubbing; manifest; all collections captured.',

  async run() {
    // Test 1: scrubSecrets removes secrets recursively
    {
      const input = {
        name: 'Crown Market',
        password: 'secret123',
        nested: { kioskPin: '9999', ok: 'fine' },
        arr: [{ apiKey: 'key123' }, { name: 'x' }],
        jwtSecret: 'jwt123',
      };
      const out = scrubSecrets(input);
      if (out.password !== '[REDACTED]') throw new Error('password not scrubbed');
      if (out.nested.kioskPin !== '[REDACTED]') throw new Error('nested kioskPin not scrubbed');
      if (out.arr[0].apiKey !== '[REDACTED]') throw new Error('array apiKey not scrubbed');
      if (out.jwtSecret !== '[REDACTED]') throw new Error('jwtSecret not scrubbed');
      if (out.name !== 'Crown Market') throw new Error('non-secret modified');
      if (out.nested.ok !== 'fine') throw new Error('non-secret nested modified');
      console.log('  ✓ scrubSecrets removes secrets recursively');
    }

    // Test 2: runTier1Backup captures all + scrubs + manifest
    {
      const monolith = {
        _v: 5,
        venues: [{ id: 'v1', name: 'Crown' }],
        users: [{ id: 'u1', email: 'a@x.com', password: 'hash123', kioskPin: '1111' }],
        jwtSecret: 'supersecret',
        resetPepper: 'pepper123',
      };
      const collections = {
        'venues/v1': { id: 'v1', name: 'Crown', _v: 1 },
        'users/u1': { id: 'u1', email: 'a@x.com', password: 'hash123', _v: 1 },
        'tasks/t1': { id: 't1', title: 'Test' },
      };
      const db = createMockDb(monolith, collections);
      const storage = createMockStorage();

      const manifest = await runTier1Backup(db, storage, 'test-bucket', 'test-db');

      if (manifest.tier !== 'tier1') throw new Error('Wrong tier');
      if (!manifest.monolithPresent) throw new Error('Monolith not captured');
      if (manifest.collections.venues !== 1) throw new Error('Venues not counted');
      if (!manifest.checksum || manifest.checksum.length !== 64) throw new Error('Bad checksum');
      if (!manifest.secretsScrubbed) throw new Error('Scrub flag not set');

      // Verify files written (NOT .enc — Google-managed encryption)
      const dataKey = [...storage.files.keys()].find(k => k.endsWith('backup.json'));
      const manifestKey = [...storage.files.keys()].find(k => k.endsWith('manifest.json'));
      if (!dataKey) throw new Error('backup.json not written');
      if (!manifestKey) throw new Error('manifest.json not written');
      if (dataKey.endsWith('.enc')) throw new Error('Must not use .enc extension');

      // Verify secrets scrubbed in the written data
      const written = JSON.parse(storage.files.get(dataKey).data);
      if (written.monolith.jwtSecret !== '[REDACTED]') throw new Error('jwtSecret leaked in backup!');
      if (written.monolith.users[0].password !== '[REDACTED]') throw new Error('password leaked!');
      if (written.collections.users[0].password !== '[REDACTED]') throw new Error('per-entity password leaked!');

      // Verify backups/latest updated
      const latest = await db.collection('backups').doc('latest').get();
      if (!latest.exists) throw new Error('backups/latest not written');
      if (latest.data().checksum !== manifest.checksum) throw new Error('Checksum mismatch in latest');

      console.log('  ✓ Tier 1 backup: all data captured, secrets scrubbed, manifest written');
    }

    console.log('  ✓ All backup tests passed');
  },
};
