import assert from 'node:assert/strict';
import { sameJsonValue, dualWriteChangedEntities } from '../../src/server/dualwrite.ts';
import { kqrErrorFor } from '../../src/lib/kioskQr.ts';
import { errorFromAnswer } from '../../src/lib/passkeys.ts';

assert(sameJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 }));
assert(sameJsonValue({ map: { a: 1, b: { x: 2, y: 3 } } }, { map: { b: { y: 3, x: 2 }, a: 1 } }));
assert(!sameJsonValue([1, 2], [2, 1]));
assert(!sameJsonValue({ a: 1 }, { a: 2 }));
assert(!sameJsonValue({ a: 1 }, { a: 1, b: 2 }));
assert(!sameJsonValue({ a: 1, b: 2 }, { a: 1 }));
assert(sameJsonValue({ a: undefined }, {}));
assert(sameJsonValue([undefined, NaN], [null, null]));
assert(sameJsonValue(new Date('2026-01-01'), '2026-01-01T00:00:00.000Z'));
assert(sameJsonValue(undefined, undefined));
assert(!sameJsonValue(undefined, null));
// Production-sorted maps must not generate entity reads/writes or version bumps.
const sorted = { id: 'task', nested: { a: 1, b: 2 }, title: 'Task' };
const rebuilt = { title: 'Task', nested: { b: 2, a: 1 }, id: 'task' };
const writes = [];
const tx = { get: async () => ({ exists: false }), set: (ref, data) => writes.push({ ref, data }) };
const db = { collection: (name) => ({ doc: (id) => `${name}/${id}` }) };
await dualWriteChangedEntities(tx, db, { tasks: [sorted] }, { tasks: [rebuilt] });
assert.equal(writes.length, 0);
const user = { id: 'user', name: 'User', email: 'user@test.local', password: 'test-hash', tokenEpoch: 0 };
const reorderedUser = { tokenEpoch: 0, password: 'test-hash', email: 'user@test.local', name: 'User', id: 'user' };
await dualWriteChangedEntities(tx, db, { users: [user] }, { users: [reorderedUser] });
assert.equal(writes.length, 0);
await dualWriteChangedEntities(tx, db, { tasks: [sorted] }, { tasks: [{ ...rebuilt, title: 'Changed' }] });
assert.deepEqual(writes, [{ ref: 'tasks/task', data: { ...rebuilt, title: 'Changed', _v: 1 } }]);
// The server's fast DAILY_LIMIT answer reaches the person in its own words (no client timer).
const DAILY = { code: 'DAILY_LIMIT', error: 'The app is over its daily limit. Try again after 3 AM.' };
const qrErr = kqrErrorFor(503, DAILY);
assert.equal(qrErr.kind, 'unavailable');
assert.equal(qrErr.body, DAILY.error);
assert.equal(errorFromAnswer(503, DAILY, new Error('fallback')).message, DAILY.error);
console.log('PASS WRITECUT: JSON equality, unchanged writes, exact changed payload, daily-limit words');
