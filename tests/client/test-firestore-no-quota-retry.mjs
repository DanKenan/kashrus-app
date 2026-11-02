import assert from 'node:assert/strict';
import { installNoQuotaRetry } from '../../src/server/firestore-no-quota-retry.ts';

const calls = [];
const result = Promise.resolve('committed');
const prototype = {
  _commit(opts, extra) { calls.push({ batch: this, opts, extra }); return result; },
};
// Find the owning prototype even through an intermediate prototype.
const inherited = Object.create(prototype);
const batch = Object.create(inherited);
const db = { batch: () => batch };
let beforeMeterCalls = 0;
const original = prototype._commit;
prototype._commit = function (...args) {
  beforeMeterCalls++;
  return original.apply(this, args);
};
installNoQuotaRetry(db);
const wrapped = prototype._commit;
installNoQuotaRetry(db);
assert.equal(prototype._commit, wrapped, 'installing twice must not wrap twice');
const opts = { transactionId: 't', requestTag: 'tag', methodName: 'commit' };
assert.equal(batch._commit(opts, 'extra'), result, 'preserve the original return value');
assert.deepEqual(calls.at(-1), { batch, opts: { ...opts, retryCodes: [] }, extra: 'extra' });
assert(!Object.hasOwn(opts, 'retryCodes'), 'do not mutate options');
const codes = [10, 8, 14];
batch._commit({ ...opts, retryCodes: codes });
assert.deepEqual(calls.at(-1).opts, { ...opts, retryCodes: [10] });
assert.deepEqual(codes, [10, 8, 14], 'do not mutate caller retry codes');
batch._commit();
assert.deepEqual(calls.at(-1).opts, { retryCodes: [14] });
batch._commit({ retryCodes: [] });
assert.deepEqual(calls.at(-1).opts.retryCodes, [], 'preserve explicitly disabled retries');
batch._commit({ transactionId: undefined });
assert.deepEqual(calls.at(-1).opts.retryCodes, [], 'write-only transaction commits also disable GAX replay');
assert.equal(beforeMeterCalls, 5, 'a previously installed meter sees every commit once');
// A meter installed afterwards must also compose, including after reinstall.
let afterMeterCalls = 0;
prototype._commit = function (...args) { afterMeterCalls++; return wrapped.apply(this, args); };
const metered = prototype._commit;
installNoQuotaRetry(db);
assert.equal(prototype._commit, metered);
batch._commit({ retryCodes: [10, 8, 14] });
assert.equal(afterMeterCalls, 1);
assert.equal(beforeMeterCalls, 6);
assert.deepEqual(calls.at(-1).opts.retryCodes, [10, 14]);
// All instances sharing the owning prototype use the same wrapper.
Object.create(inherited)._commit({ transactionId: 'other' });
assert.deepEqual(calls.at(-1).opts, { transactionId: 'other', retryCodes: [] });
const failure = new Error('commit refused');
const failingPrototype = { _commit() { throw failure; } };
const failingBatch = Object.create(failingPrototype);
installNoQuotaRetry({ batch: () => failingBatch });
assert.throws(() => failingBatch._commit(), (err) => err === failure);
const mock = { runTransaction() {} };
const noCommit = Object.create({});
const mockKeys = Reflect.ownKeys(mock);
const prototypeKeys = Reflect.ownKeys(Object.getPrototypeOf(noCommit));
installNoQuotaRetry(mock);
installNoQuotaRetry({ batch: () => noCommit });
installNoQuotaRetry({ batch: () => null });
assert.deepEqual(Reflect.ownKeys(mock), mockKeys);
assert.deepEqual(Reflect.ownKeys(Object.getPrototypeOf(noCommit)), prototypeKeys);
assert(!('_commit' in noCommit));
console.log('PASS: Commit RPC quota retries removed; options, receiver, result, errors and meter composition preserved; mock untouched');
