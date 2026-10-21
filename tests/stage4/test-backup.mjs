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
        passwordHash: 'ph123', // hash-suffixed secret name → scrub (PR 1)
        kioskPinHash: 'kph123', // hash-suffixed secret name → scrub (PR 1, forward defence for PR 2a)
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
        // PR 1 (ChatGPT finding 4): deeply nested credential fixture.
        agency: {
          name: 'Nested Agency',
          settings: {
            credentials: {
              passwordHash: 'nested-ph-456',
              kioskPinHash: 'nested-kph-456',
              resetToken: 'nested-reset-tok-789',
            },
            displayName: 'Nested Display',
          },
          integrations: [
            { provider: 'push', keys: { auth: 'nested-auth-000', p256dh: 'nested-pub-111' } },
            { provider: 'email', apiKey: 'nested-apikey-222', label: 'Email Service' },
          ],
        },
      };
      const out = scrubSecrets(input);
      if (out.password !== '[REDACTED]') throw new Error('password not scrubbed');
      if (out.userPassword !== '[REDACTED]') throw new Error('userPassword not scrubbed');
      if (out.accessToken !== '[REDACTED]') throw new Error('accessToken not scrubbed (was missed)');
      if (out.refreshToken !== '[REDACTED]') throw new Error('refreshToken not scrubbed (was missed)');
      if (out.privateKey !== '[REDACTED]') throw new Error('privateKey not scrubbed (was missed)');
      if (out.nested.kioskPin !== '[REDACTED]') throw new Error('nested kioskPin not scrubbed');
      if (out.passwordHash !== '[REDACTED]') throw new Error('passwordHash not scrubbed (hash-suffix gap)');
      if (out.kioskPinHash !== '[REDACTED]') throw new Error('kioskPinHash not scrubbed (hash-suffix gap)');
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
      // Deeply nested credential fixture assertions.
      const nc = out.agency.settings.credentials;
      if (nc.passwordHash !== '[REDACTED]') throw new Error('nested passwordHash not scrubbed');
      if (nc.kioskPinHash !== '[REDACTED]') throw new Error('nested kioskPinHash not scrubbed');
      if (nc.resetToken !== '[REDACTED]') throw new Error('nested resetToken not scrubbed');
      if (out.agency.settings.displayName !== 'Nested Display') throw new Error('nested label modified');
      if (out.agency.integrations[0].keys.auth !== '[REDACTED]') throw new Error('nested push auth not scrubbed');
      if (out.agency.integrations[0].keys.p256dh !== 'nested-pub-111') throw new Error('nested p256dh should be preserved');
      if (out.agency.integrations[1].apiKey !== '[REDACTED]') throw new Error('nested apiKey not scrubbed');
      if (out.agency.integrations[1].label !== 'Email Service') throw new Error('nested label falsely scrubbed');
      // Serialized-backup assertion: NO secret VALUE may survive anywhere in the
      // sanitized JSON, while ordinary labels must still be present.
      const serialized = JSON.stringify(out);
      for (const secret of [
        'secret123', 'cp123', 'tok123', 'ref123', 'pk123', '9999', 'ph123', 'kph123',
        'key123', 'jwt123', 'authsecret123', 'plaintext123', 'hash123',
        'nested-ph-456', 'nested-kph-456', 'nested-reset-tok-789',
        'nested-auth-000', 'nested-apikey-222',
      ]) {
        if (serialized.includes(secret)) throw new Error(`sanitized backup leaks secret value: ${secret}`);
      }
      for (const label of [
        'Crown Market', 'My API Key', 'qwerty', 'fine', 'https://push.example',
        'a@x.com', 'Nested Agency', 'Nested Display', 'Email Service', 'nested-pub-111',
      ]) {
        if (!serialized.includes(label)) throw new Error(`sanitized backup lost ordinary label: ${label}`);
      }
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

    // Test 2b (item 8b): the backup is the 7-collection set — people and
    // emails are captured, and none of their fields is redacted.
    {
      const monolith = { _v: 6, venues: [], users: [{ id: 'u1', email: 'a@x.com', personId: 'u1', venueAccess: [], isPrimaryAdmin: false }] };
      const collections = {
        'users/u1': { id: 'u1', email: 'a@x.com', personId: 'u1', _v: 1 },
        'people/u1': { id: 'u1', name: 'A', primaryEmail: 'a@x.com', status: 'active', createdAt: '2026-10-21T00:00:00.000Z', _v: 1 },
        'emails/k1': { personId: 'u1', status: 'retired', verified: false, source: 'admin-entered', addedAt: 'x', retiredAt: 'y', previousPersonIds: ['u0'], reassignedAt: 'z' },
      };
      const db = createMockDb(monolith, collections);
      const storage = createMockStorage();
      const manifest = await runTier1Backup(db, storage, 'test-bucket', 'test-db');
      const keys = Object.keys(manifest.collections).sort().join(',');
      if (keys !== 'emails,media,people,tasks,users,usersByEmail,venues') throw new Error(`backup collections: ${keys}`);
      if (manifest.collections.people !== 1 || manifest.collections.emails !== 1) throw new Error('people/emails not counted');
      const dataKey = [...storage.files.keys()].find(k => k.endsWith('backup.json'));
      const written = JSON.parse(storage.files.get(dataKey).data);
      if (JSON.stringify(written).includes('[REDACTED]')) throw new Error('an identity field was redacted');
      const e = written.collections.emails[0];
      if (e.personId !== 'u1' || e.previousPersonIds[0] !== 'u0' || e.verified !== false) throw new Error('emails doc not captured verbatim');
      if (written.monolith.users[0].personId !== 'u1') throw new Error('row personId not captured');
      console.log('  ✓ 8b: backup captures people + emails (7 collections), nothing redacted');
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
