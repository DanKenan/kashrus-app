/**
 * Fixture for test-consistency.mjs run-level tests (item 3, R7).
 *
 * Spawned as a child process with K_SERVICE set, so src/server/log.ts is
 * born in structured (Cloud Run) mode — the parent test then asserts on the
 * child's real stdout/stderr: exactly one ERROR line (the summary) and one
 * INFO line per finding, all carrying the run id.
 *
 * Usage: node consistency-grouped-run.mjs <grouped|throw> <resultFile>
 * Writes { httpStatus, body } JSON to <resultFile>; log lines go to the
 * process's real stdout/stderr, untouched.
 */
import { writeFileSync } from 'node:fs';
import { handleConsistencyCheck } from '../../../src/server/consistency.ts';
import { createMockDb, venue, user, emailKey } from '../test-consistency.mjs';

const [scenario, resultFile] = process.argv.slice(2);

// 12 findings: 7 venues missing in per-entity, 3 users with a field
// mismatch (name), 2 orphan tasks. Email lookups are all correct, so no
// lookup findings sneak in.
function groupedDb() {
  const people = [['u1', 'a@x.com'], ['u2', 'b@x.com'], ['u3', 'c@x.com']];
  const monolith = {
    _v: 5,
    venues: Array.from({ length: 7 }, (_, i) => ({ ...venue, id: `v${i + 1}` })),
    users: people.map(([id, email]) => ({ ...user(id, email), name: 'CHANGED' })),
    tasks: [],
  };
  const perEntity = {};
  for (const [id, email] of people) {
    perEntity[`users/${id}`] = { ...user(id, email), _v: 1 };
    perEntity[`usersByEmail/${emailKey(email)}`] = { userId: id, email };
  }
  perEntity['tasks/t1'] = { id: 't1', title: 'Orphan task 1' };
  perEntity['tasks/t2'] = { id: 't2', title: 'Orphan task 2' };
  return createMockDb(monolith, perEntity);
}

const freshBackup = async () => ({ stale: false, lastAt: new Date().toISOString() });

let out;
if (scenario === 'grouped') {
  out = await handleConsistencyCheck(groupedDb(), { checkBackup: freshBackup });
} else if (scenario === 'throw') {
  out = await handleConsistencyCheck(groupedDb(), {
    checkBackup: async () => {
      throw new Error('gcs exploded\nsecond line');
    },
  });
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}
writeFileSync(resultFile, JSON.stringify(out));
