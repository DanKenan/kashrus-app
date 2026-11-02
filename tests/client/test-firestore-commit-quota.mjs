import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { Firestore } from '@google-cloud/firestore';
import { installNoQuotaRetry } from '../../src/server/firestore-no-quota-retry.ts';
import { runFirestoreTransaction } from '../../src/server/firestore-tx.ts';
import { readMeterSnapshot, setQuotaErrorAtForTests } from '../../src/server/read-meter.ts';

const require = createRequire(import.meta.url);
// Firestore injects THIS gax module into firestore-api's FirestoreClient.
// createStub supplies the raw gRPC methods; GAPIC initialize() wraps them with
// createApiCall afterwards. Do not stub request(), commit(), or innerApiCalls.
const sdkRequire = createRequire(require.resolve('@google-cloud/firestore'));
const { GrpcClient } = sdkRequire('google-gax');
const previous = GrpcClient.prototype.createStub;
let active;
const watchdog = setTimeout(() => { console.error('FAIL: SDK quota test exceeded 10 s'); process.exit(1); }, 10000);
GrpcClient.prototype.createStub = async function () {
  const scenario = active;
  return {
    commit(request, metadata, options, callback) {
      scenario.transactionIds.push(request.transaction);
      const reply = scenario.codes[scenario.commits++] ?? 3; // Bound a broken/no-op install too.
      const code = typeof reply === 'number' ? reply : reply.code;
      if (!code || reply.applied) scenario.applied++;
      const err = code ? Object.assign(new Error(`scripted Commit code ${code}`), { code }) : null;
      if (err) scenario.errors.push(err); else scenario.successes++;
      queueMicrotask(() => callback(err, err ? undefined : {
        writeResults: request.writes.map(() => ({ updateTime: { seconds: '1', nanos: 0 } })),
        commitTime: { seconds: '1', nanos: 0 },
      }));
      return { cancel() {} };
    },
    beginTransaction(request, metadata, options, callback) {
      queueMicrotask(() => callback(null, { transaction: Buffer.from('t') }));
      return { cancel() {} };
    },
    rollback(request, metadata, options, callback) {
      queueMicrotask(() => callback(null, {}));
      return { cancel() {} };
    },
    batchGetDocuments(request) {
      scenario.reads++;
      if (scenario.readCodes?.shift() === 14) {
        const stream = new Readable({ objectMode: true, read() {} });
        // Deliver the transaction header first: the SDK's stream-start retry
        // layer has finished, so this read failure reaches the callback.
        stream.push({ transaction: Buffer.from('t') });
        setImmediate(() => stream.destroy(Object.assign(new Error('read unavailable'), { code: 14 })));
        return stream;
      }
      const stream = Readable.from(request.documents.map((missing) => ({
        missing, transaction: Buffer.from('t'), readTime: { seconds: '1', nanos: 0 },
      })), { objectMode: true });
      // Real gRPC streams send status after end; GAX waits for both.
      stream.on('end', () => stream.emit('status', { code: 0 }));
      stream.cancel = () => stream.destroy();
      return stream;
    },
    runQuery: () => Readable.from([], { objectMode: true }),
    close() {},
  };
};

async function scenario(codes, installed, run, settings = {}) {
  active = { codes, commits: 0, successes: 0, errors: [], applied: 0, reads: 0, transactionIds: [] };
  const state = active;
  const db = new Firestore({ projectId: 'demo-t', ssl: false, host: '127.0.0.1:1', preferRest: false, ...settings });
  try {
    if (installed) installNoQuotaRetry(db);
    await run(db, state);
  } finally {
    await db.terminate();
  }
}
const set = (db, tx) => tx.set(db.doc('quota/test'), { value: 1 });
async function promptly(action, state, label) {
  const start = performance.now();
  let caught;
  await assert.rejects(action, (err) => {
    assert.equal(err.code, 8, `${label}: Commit must expose code 8 without GAX retry`);
    caught = err;
    return true;
  });
  assert.equal(state.commits, 1, `${label}: exactly one Commit RPC`);
  assert(performance.now() - start < 1000, `${label}: quota must reject within 1 s`);
  assert.equal(caught, state.errors[0], `${label}: rethrow the original quota error`);
}
try {
  // MUST precede installation: WriteBatch's prototype is shared by SDK instances.
  await scenario([8, 3], false, async (db, state) => {
    let callbacks = 0;
    await assert.rejects(db.runTransaction(async (tx) => { callbacks++; set(db, tx); }, { maxAttempts: 1 }), { code: 3 });
    assert.equal(state.commits, 2, 'baseline must retry code 8 below the transaction callback');
    assert.equal(callbacks, 1, 'baseline retries are GAX retries, not transaction retries');
    console.log('PASS baseline: 1 transaction callback, 2 Commit RPCs (8 then 3)');
  });
  await scenario([8, 3], true, async (db, state) => {
    await promptly(() => db.runTransaction(async (tx) => set(db, tx), { maxAttempts: 1 }), state, 'installed transaction');
    console.log('PASS installed transaction: 1 Commit RPC, code 8, <1 s');
  });
  await scenario([8, 3], true, async (db, state) => {
    await promptly(() => db.batch().set(db.doc('quota/batch'), { value: 1 }).commit(), state, 'installed batch');
    console.log('PASS installed batch: 1 Commit RPC, code 8, <1 s');
  });
  await scenario([10, 0], true, async (db, state) => {
    let callbacks = 0;
    const result = await runFirestoreTransaction(db, async (tx) => { callbacks++; set(db, tx); return callbacks; });
    assert.equal(callbacks, 2);
    assert.equal(result, 2, 'return the successful callback result');
    assert.equal(state.commits, 2);
    assert.equal(state.successes, 1);
    console.log('PASS helper contention: 2 callbacks, 2 Commit RPCs, 1 successful commit, result 2');
  });
  // An ambiguous response must not replay either the RPC or the callback.
  // Cover both write-only commits (no transaction ID) and commits after reads.
  for (const withRead of [false, true]) {
    for (const code of [14, 4, 13, 2, 1]) {
      await scenario([{ code, applied: true }, 0], true, async (db, state) => {
        let callbacks = 0;
        let caught;
        try { await runFirestoreTransaction(db, async (tx) => {
          callbacks++;
          if (withRead) await tx.get(db.doc('quota/read'));
          set(db, tx);
        }); } catch (err) { caught = err; }
        assert.equal(callbacks, 1, `ambiguous commit ${code}: applied write must not replay callback (commits ${state.commits}, applied ${state.applied})`);
        assert.equal(caught, state.errors[0], 'rethrow the original ambiguous commit error');
        assert.equal(caught?.code, code);
        assert.equal(state.commits, 1, 'GAX must not replay the transaction Commit RPC');
        assert.equal(state.applied, 1);
        assert.equal(state.reads, withRead ? 1 : 0);
        assert.deepEqual(state.transactionIds, [withRead ? Buffer.from('t') : undefined]);
      });
    }
  }
  console.log('PASS ambiguous commits: 14/4/13/2/1, with and without reads, 1 callback/RPC/application');
  await scenario([0], true, async (db, state) => {
    state.readCodes = [14, 0];
    let callbacks = 0;
    const result = await runFirestoreTransaction(db, async (tx) => {
      callbacks++;
      await tx.get(db.doc('quota/read'));
      set(db, tx);
      return callbacks;
    });
    assert.equal(callbacks, 2, 'a read failure before commit still retries our callback');
    assert.equal(result, 2);
    assert.equal(state.reads, 2);
    assert.equal(state.commits, 1);
    assert.equal(state.applied, 1);
    console.log('PASS read UNAVAILABLE: 2 callbacks/reads, 1 Commit RPC/application');
  }, {
    // Disable GAX retries ONLY for this read test, so the real helper must
    // receive and handle the read failure. Commit settings are untouched.
    gaxServerStreamingRetries: true,
    clientConfig: { interfaces: { 'google.firestore.v1.Firestore': {
      retry_codes: { no_retry: [] },
      methods: { BatchGetDocuments: { retry_codes_name: 'no_retry' } },
    } } },
  });
  await scenario([8, 3], true, async (db, state) => {
    const exhausted = readMeterSnapshot().exhausted;
    let callbacks = 0;
    await promptly(() => runFirestoreTransaction(db, async (tx) => { callbacks++; set(db, tx); }), state, 'helper quota');
    assert.equal(callbacks, 1);
    assert.equal(readMeterSnapshot().exhausted, exhausted + 1, 'noteQuotaError records the Commit failure once');
    console.log('PASS helper quota: 1 callback, 1 Commit RPC, noteQuotaError counted once');
  });
} finally {
  clearTimeout(watchdog);
  GrpcClient.prototype.createStub = previous;
  setQuotaErrorAtForTests(0);
}
