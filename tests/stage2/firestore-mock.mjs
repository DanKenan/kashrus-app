/**
 * Faithful in-memory mock of the Firestore transaction API, for Stage 2 tests.
 *
 * Why a mock: the Firestore emulator's gRPC/HTTP backend does not function in
 * this sandbox (503 "Network closed for unknown reason" on every request, even
 * via REST). This mock implements the exact semantics the Stage 2 code depends on:
 *
 *   - Single-document reads/writes via doc(path).get() / doc(path).set()
 *   - runTransaction(fn): optimistic concurrency. The transaction function sees
 *     a consistent snapshot; if the document version changes between the
 *     transaction's read and its commit (i.e. a concurrent transaction committed
 *     first), the commit aborts with a retryable contention error and the
 *     function is re-run — exactly like Firestore's server-side retry.
 *   - Writes are atomic: either the whole transaction commits or nothing does.
 *   - A transaction that throws a non-retryable error (e.g. the Stage 2
 *     VersionConflictError / OperationConflictError) propagates without retry,
 *     like Firestore does for application errors.
 *   - Persistence: the mock persists to a file (FIRESTORE_MOCK_FILE or a temp
 *     file), so a server restart loads the last committed state — modeling
 *     Firestore's durability for Test 5.
 *
 * What it does NOT model (documented limitations):
 *   - Multi-document transactions (Stage 2 only ever touches one document).
 *   - Real network latency / partial failures.
 *
 * Interface compatibility: exposes doc() and runTransaction() with the same
 * shapes firebase-admin's Firestore uses, so server.ts needs only a one-line
 * switch (FIRESTORE_MOCK=true) to use it.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class MockTransactionAborted extends Error {
  constructor(message = 'Transaction aborted due to contention') {
    super(message);
    this.code = 'aborted';
    this.retryable = true;
  }
}

class MockDocumentSnapshot {
  constructor(data) {
    this._data = data;
  }
  get exists() {
    return this._data !== undefined;
  }
  data() {
    return this._data === undefined ? undefined : JSON.parse(JSON.stringify(this._data));
  }
}

class MockDocumentReference {
  constructor(store, path) {
    this._store = store;
    this.path = path;
  }
  async get() {
    return new MockDocumentSnapshot(this._store._docs[this.path]);
  }
  async set(data) {
    this._store._docs[this.path] = JSON.parse(JSON.stringify(data));
  }
}

class MockTransaction {
  constructor(store, snapshotVersions) {
    this._store = store;
    this._snapshotVersions = snapshotVersions; // path -> _v at tx start
    this._writes = new Map(); // path -> data
  }
  async get(docRef) {
    // Reads see the transaction's own writes first (read-your-writes),
    // otherwise the snapshot taken at transaction start.
    if (this._writes.has(docRef.path)) {
      return new MockDocumentSnapshot(this._writes.get(docRef.path));
    }
    return new MockDocumentSnapshot(this._store._docs[docRef.path]);
  }
  set(docRef, data) {
    this._writes.set(docRef.path, JSON.parse(JSON.stringify(data)));
  }
  /**
   * PR 1 test-harness correction: the mock lacked Firestore's delete().
   * Models delete as an undefined write — reads see the doc as non-existent
   * and _commit()/_save() drop it. (Pre-existing gap: Part 2 step D's
   * dual-write calls tx.delete(); the mock on main only had get/set.)
   */
  delete(docRef) {
    this._writes.set(docRef.path, undefined);
  }
  /** Commit: fail if any read document changed since the snapshot. */
  _commit() {
    for (const [path, writeData] of this._writes) {
      const snapV = this._snapshotVersions[path];
      const currentDoc = this._store._docs[path];
      const currentV = currentDoc ? currentDoc._v : undefined;
      // If the doc changed under us since our snapshot → contention.
      if (snapV !== currentV) {
        throw new MockTransactionAborted(
          `Document ${path} changed during transaction (snapshot _v=${snapV}, current _v=${currentV})`
        );
      }
    }
    for (const [path, writeData] of this._writes) {
      this._store._docs[path] = writeData;
    }
    // Persist after every commit (models Firestore durability).
    this._store._save();
  }
}

export class MockFirestore {
  constructor() {
    this._docs = {}; // path -> data
    // Persist to a file so restarts load the last committed state (Test 5).
    this._file = process.env.FIRESTORE_MOCK_FILE || join(tmpdir(), 'stage2-mock-firestore.json');
    this._load();
  }

  _load() {
    try {
      if (existsSync(this._file)) {
        this._docs = JSON.parse(readFileSync(this._file, 'utf-8'));
      }
    } catch {}
  }

  _save() {
    try {
      writeFileSync(this._file, JSON.stringify(this._docs));
    } catch {}
  }

  doc(path) {
    return new MockDocumentReference(this, path);
  }

  /**
   * PR 1 test-harness correction: the mock lacked Firestore's collection().
   * Returns a minimal CollectionReference supporting doc(id) and get()
   * (empty snapshot). (Pre-existing gap: Part 2 step D's dual-write calls
   * firestoreDb.collection(); the mock on main only had doc()/runTransaction().)
   */
  collection(name) {
    const self = this;
    return {
      doc: (id) => self.doc(`${name}/${id}`),
      get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
    };
  }

  /**
   * Run a transaction with optimistic-concurrency retries, mirroring
   * Firestore's behavior: up to 5 attempts; contention aborts are retried,
   * application errors propagate immediately.
   */
  async runTransaction(updateFunction, options = {}) {
    const maxAttempts = options.maxAttempts || 5;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Snapshot versions of all docs at transaction start.
      const snapshotVersions = {};
      for (const path of Object.keys(this._docs)) {
        const d = this._docs[path];
        snapshotVersions[path] = d ? d._v : undefined;
      }
      const tx = new MockTransaction(this, snapshotVersions);
      try {
        const result = await updateFunction(tx);
        tx._commit();
        return result;
      } catch (err) {
        // Application errors (VersionConflictError, OperationConflictError,
        // and any other non-contention error) propagate without retry —
        // Firestore does not retry transactions that fail in user code.
        if (err instanceof MockTransactionAborted && attempt < maxAttempts) {
          lastError = err;
          // Small yield so truly concurrent transactions interleave.
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** Test helper: seed a document directly (bypasses transactions). */
  _seed(path, data) {
    this._docs[path] = JSON.parse(JSON.stringify(data));
  }

  /** Test helper: read raw document data. */
  _read(path) {
    const d = this._docs[path];
    return d === undefined ? undefined : JSON.parse(JSON.stringify(d));
  }
}

/** Singleton holder so the mock can be shared across imports in one process. */
let instance = null;
export function getMockFirestore() {
  if (!instance) instance = new MockFirestore();
  return instance;
}
