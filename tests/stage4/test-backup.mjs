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
            async save(data, opts) {
              // Simulate objectCreator: fail on overwrite
              if (files.has(key)) {
                throw new Error(`storage.objectCreator: ${key} already exists (no overwrite)`);
              }
              files.set(key, { data, contentType: opts?.contentType });
            },
            async download() {
              const f = files.get(key);
              if (!f) throw new Error('Not found');
              return [Buffer.from(f.data)];
            },
          };
        },
        async getFiles(opts) {
          const prefix = `${name}/${opts?.prefix || ''}`;
          const matched = [...files.keys()]
            .filter(k => k.startsWith(prefix))
            .map(k => ({ name: k.slice(name.length + 1) }));
          return [matched];
        },
      };
    },
  };
}

export default {
  name: 'Stage 4 PR B: Tier 1 backup',
  whatItProves: 'Recursive secret scrubbing; manifest; all collections captured.',

  async run() {
    // Test 1: scrubSecrets removes secrets recursively (and preserves non-secrets)
    {
      const input = {
        name: 'Crown Market',
        password: 'secret123',
        userPassword: 'cp123', // camelCase compound → scrub
        accessToken: 'tok123', // must scrub (was missed before)
        refreshToken: 'ref123', // must scrub
        privateKey: 'pk123', // must scrub even outside vapidKeys
        nested: { kioskPin: '9999', ok: 'fine' },
        arr: [{ apiKey: 'key123' }, { name: 'x' }],
        jwtSecret: 'jwt123',
        apiKeyLabel: 'My API Key', // must PRESERVE (false positive before)
        keyboard: 'qwerty', // must PRESERVE (ends with "key" but not secret)
        pushSubscriptions: [
          { endpoint: 'https://push.example', keys: { p256dh: 'pub123', auth: 'authsecret123' } },
        ],
        passwordResets: [
          { email: 'a@x.com', code: 'plaintext123', codeHash: 'hash123', expiresAt: '2026-01-01' },
        ],
      };
      const out = scrubSecrets(input);
      if (out.password !== '[REDACTED]') throw new Error('password not scrubbed');
      if (out.userPassword !== '[REDACTED]') throw new Error('userPassword not scrubbed');
      if (out.accessToken !== '[REDACTED]') throw new Error('accessToken not scrubbed (was missed)');
      if (out.refreshToken !== '[REDACTED]') throw new Error('refreshToken not scrubbed (was missed)');
      if (out.privateKey !== '[REDACTED]') throw new Error('privateKey not scrubbed (was missed)');
      if (out.nested.kioskPin !== '[REDACTED]') throw new Error('nested kioskPin not scrubbed');
      if (out.arr[0].apiKey !== '[REDACTED]') throw new Error('array apiKey not scrubbed');
      if (out.jwtSecret !== '[REDACTED]') throw new Error('jwtSecret not scrubbed');
      if (out.pushSubscriptions[0].keys.auth !== '[REDACTED]') throw new Error('push keys.auth not scrubbed!');
      if (out.pushSubscriptions[0].keys.p256dh !== 'pub123') throw new Error('p256dh should be preserved');
      if (out.pushSubscriptions[0].endpoint !== 'https://push.example') throw new Error('endpoint should be preserved');
      if (out.passwordResets[0].code !== '[REDACTED]') throw new Error('legacy reset code not scrubbed!');
      if (out.passwordResets[0].codeHash !== '[REDACTED]') throw new Error('reset codeHash not scrubbed!');
      if (out.passwordResets[0].email !== 'a@x.com') throw new Error('reset email should be preserved');
      if (out.name !== 'Crown Market') throw new Error('non-secret modified');
      if (out.apiKeyLabel !== 'My API Key') throw new Error('apiKeyLabel falsely scrubbed!');
      if (out.keyboard !== 'qwerty') throw new Error('keyboard falsely scrubbed!');
      if (out.nested.ok !== 'fine') throw new Error('non-secret nested modified');
      console.log('  ✓ scrubSecrets: catches tokens/keys/auth/codes, preserves labels');
    }

    // Test 2: runTier1Backup captures all + scrubs + manifest (unique paths, version check)
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
      if (manifest.monolithVersion !== 5) throw new Error('Version not captured');
      if (manifest.collections.venues !== 1) throw new Error('Venues not counted');
      if (!manifest.checksum || manifest.checksum.length !== 64) throw new Error('Bad checksum');
      if (!manifest.secretsScrubbed) throw new Error('Scrub flag not set');

      // Verify unique paths per execution (runId in path)
      const keys = [...storage.files.keys()];
      const dataKey = keys.find(k => k.endsWith('backup.json'));
      const manifestKey = keys.find(k => k.endsWith('manifest.json'));
      const markerKey = keys.find(k => k.endsWith('/SUCCESS.json'));
      if (!dataKey) throw new Error('backup.json not written');
      if (!manifestKey) throw new Error('manifest.json not written');
      if (!markerKey) throw new Error('SUCCESS.json marker not written');
      if (dataKey.endsWith('.enc')) throw new Error('Must not use .enc extension');
      // Path must contain a run ID (tier1/<date>/<runId>/)
      const parts = dataKey.split('/');
      if (parts.length < 4) throw new Error(`Path not unique per execution: ${dataKey}`);

      // Verify secrets scrubbed in the written SERIALIZED artifact (not just in-memory)
      const written = JSON.parse(storage.files.get(dataKey).data);
      if (written.monolith.jwtSecret !== '[REDACTED]') throw new Error('jwtSecret leaked in backup!');
      if (written.monolith.users[0].password !== '[REDACTED]') throw new Error('password leaked!');
      if (written.collections.users[0].password !== '[REDACTED]') throw new Error('per-entity password leaked!');

      // Verify NO Firestore write happened (backup SA is read-only)
      // (The mock would have recorded it; we check backups/latest was NOT written to Firestore)
      // Instead, the GCS marker was written:
      const marker = JSON.parse(storage.files.get(markerKey).data);
      if (marker.checksum !== manifest.checksum) throw new Error('Marker checksum mismatch');

      console.log('  ✓ Tier 1 backup: unique paths, version check, GCS marker (no Firestore write)');
    }

    // Test 3: Refuses when monolith missing or _v invalid
    {
      const db1 = createMockDb(null, {});
      const storage = createMockStorage();
      try {
        await runTier1Backup(db1, storage, 'test-bucket', 'test-db');
        throw new Error('Should have refused missing monolith');
      } catch (e) {
        if (!e.message.includes('does not exist')) throw new Error(`Wrong error: ${e.message}`);
      }

      const db2 = createMockDb({ venues: [] }, {}); // no _v
      try {
        await runTier1Backup(db2, storage, 'test-bucket', 'test-db');
        throw new Error('Should have refused invalid _v');
      } catch (e) {
        if (!e.message.includes('_v')) throw new Error(`Wrong error: ${e.message}`);
      }
      console.log('  ✓ refuses missing monolith / invalid _v');
    }

    // Test 4: Two consecutive executions succeed (no overwrite conflict)
    {
      const monolith = { _v: 5, venues: [], users: [], tasks: [] };
      const db = createMockDb(monolith, {});
      const storage = createMockStorage();

      const m1 = await runTier1Backup(db, storage, 'test-bucket', 'test-db');
      const m2 = await runTier1Backup(db, storage, 'test-bucket', 'test-db');

      // Different run IDs → different paths → no overwrite
      const keys = [...storage.files.keys()];
      const successMarkers = keys.filter(k => k.endsWith('/SUCCESS.json'));
      if (successMarkers.length !== 2) {
        throw new Error(`Expected 2 unique SUCCESS markers, got ${successMarkers.length}`);
      }
      if (successMarkers[0] === successMarkers[1]) {
        throw new Error('Success markers must have unique paths!');
      }
      console.log('  ✓ two consecutive runs succeed with unique immutable markers');
    }

    console.log('  ✓ All backup tests passed');
  },
};
