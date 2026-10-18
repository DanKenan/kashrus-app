/**
 * Stage 4 PR A: Consistency monitor tests.
 */
import { runConsistencyCheck } from '../../src/server/consistency.ts';
import crypto from 'crypto';

function emailKey(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function createMockDb(monolithData, perEntityDocs = {}, versionChanges = 0) {
  const docs = new Map();
  for (const [k, v] of Object.entries(perEntityDocs)) docs.set(k, v);
  // Add a recent backup so staleness check passes (unless testing staleness)
  docs.set('backups/latest', {
    tier: 'tier1',
    createdAt: new Date().toISOString(),
    checksum: 'abc123',
  });
  let versionCalls = 0;

  const db = {
    doc(path) {
      return {
        async get() {
          if (path === 'app-state/main') {
            versionCalls++;
            // Simulate version change on first N calls if versionChanges > 0
            const v = monolithData._v + (versionCalls <= versionChanges ? 0 : versionChanges);
            // Actually: return _v that changes between before/after
            const effectiveV = versionCalls === 1 ? monolithData._v : monolithData._v + versionChanges;
            return { exists: true, data: () => ({ ...monolithData, _v: effectiveV }) };
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
  return db;
}

const venue = { id: 'v1', agencyId: 'agency-hkc', name: 'Crown Market', category: 'grocery', address: 'x', certification: 'HKC', createdAt: '2026-01-01' };
const user = (id, email) => ({ id, agencyId: 'agency-hkc', email, name: 'U', role: 'mashgiach', avatarColor: '#fff', createdAt: '2026-01-01', updatedAt: '2026-01-01' });

export default {
  name: 'Stage 4 PR A: Consistency monitor',
  whatItProves: 'Version-stable retry, size warning, non-2xx on mismatch.',

  async run() {
    // Test 1: Match + small size = ok (but backup unconfigured = stale)
    // Note: without BACKUP_BUCKET, staleness check fails closed → ok=false.
    // This is intentional: monitoring enabled but unconfigured = error.
    {
      const monolith = { _v: 5, venues: [venue], users: [user('u1', 'a@x.com')], tasks: [] };
      const perEntity = {
        'venues/v1': { ...venue, _v: 1 },
        'users/u1': { ...user('u1', 'a@x.com'), _v: 1 },
        [`usersByEmail/${emailKey('a@x.com')}`]: { userId: 'u1', email: 'a@x.com' },
      };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      // Backup not configured → stale → ok=false (fail closed)
      if (r.ok) throw new Error('Expected not ok when backup unconfigured (fail closed)');
      if (!r.backupStale) throw new Error('Should report backup stale when unconfigured');
      if (r.status && !r.status.match) throw new Error('Data should still match');
      console.log('  ✓ unconfigured backup = stale (fail closed), data still matches');
    }

    // Test 2: Mismatch = not ok
    {
      const monolith = { _v: 5, venues: [{ ...venue, name: 'CHANGED' }], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...venue, _v: 1 } };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      if (r.ok) throw new Error('Expected not ok on mismatch');
      if (!r.status || r.status.match) throw new Error('Status should show mismatch');
      console.log('  ✓ mismatch detected, ok=false');
    }

    // Test 3: Large monolith = size warning
    {
      const bigVenue = { ...venue, description: 'x'.repeat(900 * 1024) }; // ~900 KiB
      const monolith = { _v: 5, venues: [bigVenue], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...bigVenue, _v: 1 } };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      if (r.ok) throw new Error('Expected not ok on size warning');
      if (!r.monolithSizeWarn) throw new Error('Should warn on large doc');
      console.log(`  ✓ size warning at ${Math.round((r.monolithSizeBytes || 0) / 1024)} KiB`);
    }

    // Test 4: Version change mid-check triggers retry, eventually stable
    // (ok=false due to unconfigured backup, but version retry must succeed)
    {
      const monolith = { _v: 5, venues: [venue], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...venue, _v: 1 } };
      // versionChanges=1: first attempt sees v5→v6 (retry), second sees v6→v6 (stable)
      const db = createMockDb(monolith, perEntity, 1);
      const r = await runConsistencyCheck(db);
      // Version retry must have happened and stabilized (error records it)
      if (!r.error || !r.error.includes('version changed')) {
        throw new Error(`Expected retry to be recorded in error field, got: ${r.error || 'none'}`);
      }
      // Data must match (ok=false only because backup unconfigured)
      if (!r.status || !r.status.match) throw new Error('Data should match after retry');
      if (!r.backupStale) throw new Error('Backup should be stale (unconfigured)');
      console.log(`  ✓ version-change retry happened and stabilized (ok=false only for backup)`);
    }

    console.log('  ✓ All consistency tests passed');
  },
};
