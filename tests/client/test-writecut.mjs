import assert from 'node:assert/strict';
import { sameJsonValue, dualWriteChangedEntities } from '../../src/server/dualwrite.ts';
import { signInRequest, SIGN_IN_TIMEOUT_TEXT } from '../../src/lib/signInRequest.ts';

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
// A stalled response body is bounded too; even a fetcher ignoring abort cannot hang.
let signal;
await assert.rejects(signInRequest('/login', {}, async (_, init) => {
  signal = init.signal;
  return { clone: () => ({ json: () => new Promise(() => {}) }) };
}, 10), { message: SIGN_IN_TIMEOUT_TEXT });
assert(signal.aborted);
const answer = await signInRequest('/login', {}, async () => new Response(JSON.stringify({ code: 'DAILY_LIMIT', error: 'Daily limit' }), { status: 503 }));
assert.equal(answer.data.error, 'Daily limit');
assert.equal(answer.res.status, 503);
console.log('PASS WRITECUT: JSON equality, unchanged writes, exact changed payload, bounded sign-in');
