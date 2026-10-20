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
import { consistencyRoute } from '../../../src/server/consistency-route.ts';
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
} else if (scenario === 'info-throws') {
  // The first finding's INFO line goes out; every later stdout write throws.
  // addIssue must swallow it (best-effort) so the ERROR summary survives.
  let writes = 0;
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    writes++;
    if (writes > 1) throw new Error('stdout broken');
    return origWrite(...args);
  };
  out = await handleConsistencyCheck(groupedDb(), { checkBackup: freshBackup });
} else if (scenario === 'status-throws') {
  // perEntityStatus throws a long multi-line error (via collection reads):
  // the retry WARNING lines must come out bounded and single-line.
  const base = groupedDb();
  const db = {
    doc: (...a) => base.doc(...a),
    collection: () => {
      throw new Error('per-entity read exploded badly on the first line\nsecond line of the failure\n' + 'x'.repeat(300));
    },
  };
  out = await handleConsistencyCheck(db, { checkBackup: freshBackup });
} else if (scenario === 'route-import-fails') {
  // The module that carries the handler fails to load: the route owes the
  // run exactly one ERROR line in the summary shape (run=pre-run).
  const recorded = { statusCode: 0, body: undefined };
  const res = {
    headersSent: false,
    status(c) { recorded.statusCode = c; return this; },
    json(b) { recorded.body = b; return this; },
  };
  await consistencyRoute(groupedDb(), res, async () => {
    throw new Error('Cannot find module ./consistency.js\nRequire stack: fake');
  });
  out = { httpStatus: recorded.statusCode, body: recorded.body };
} else if (scenario === 'route-json-throws') {
  // The summary is emitted, then the response write throws: the route must
  // add a WARNING, never a second ERROR. Default loader = the real module.
  const recorded = { statusCode: 0 };
  const res = {
    headersSent: false,
    status(c) { recorded.statusCode = c; return this; },
    json() { throw new Error('res.json exploded'); },
  };
  await consistencyRoute(groupedDb(), res);
  out = { httpStatus: recorded.statusCode, body: null };
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}
writeFileSync(resultFile, JSON.stringify(out));
