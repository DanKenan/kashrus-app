/**
 * Stage 3A Test: Real lifecycle functions with injected mock Storage.
 * Tests createIntent, markUploaded, validateUpload, commitMedia, and
 * sweepOrphans using the setTestStorage() seam.
 */
import {
  setTestStorage,
  createIntent,
  markUploaded,
  validateUpload,
  commitMedia,
  sweepOrphans,
  getDownloadUrl,
  MediaError,
} from '../../src/server/media.ts';
import crypto from 'crypto';
import { Readable } from 'stream';

// Mock Storage implementation
const mockFiles = new Map();

const mockStorage = {
  bucket: (bucketName) => ({
    file: (path) => ({
      getSignedUrl: async (opts) => {
        // Upload URLs require the generation-match header; download URLs don't
        if (opts.action === 'write' && !opts.extensionHeaders?.['x-goog-if-generation-match']) {
          throw new Error('Missing x-goog-if-generation-match header');
        }
        return [`https://mock-signed-url/${path}?action=${opts.action}`];
      },
      exists: async () => [mockFiles.has(path)],
      getMetadata: async () => {
        const f = mockFiles.get(path);
        if (!f) throw new Error('Not found');
        return [{ size: String(f.size), generation: f.generation }];
      },
      createReadStream: () => {
        const f = mockFiles.get(path);
        const stream = new Readable();
        if (f) stream.push(f.buffer);
        stream.push(null);
        return stream;
      },
      delete: async (opts) => {
        if (!mockFiles.has(path)) {
          if (opts?.ignoreNotFound) return;
          throw new Error('Not found');
        }
        mockFiles.delete(path);
      },
    }),
  }),
};

function createMockDb() {
  const docs = new Map();
  const db = {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          const docRef = {
            async get() {
              const data = docs.get(key);
              return {
                exists: !!data,
                data: () => data,
                id,
                ref: docRef,
              };
            },
            async set(data) { docs.set(key, data); },
            async update(updates) {
              const existing = docs.get(key);
              if (!existing) throw new Error('Not found');
              docs.set(key, { ...existing, ...updates });
            },
          };
          return docRef;
        },
        where(field, op, value) {
          const query = {
            _filters: [{ field, op, value }],
            where(f, o, v) {
              query._filters.push({ field: f, op: o, value: v });
              return query;
            },
            async get() {
              const results = [];
              for (const [k, v] of docs) {
                if (!k.startsWith(`${name}/`)) continue;
                let match = true;
                for (const f of query._filters) {
                  if (f.op === '==' && v[f.field] !== f.value) match = false;
                  if (f.op === 'in' && !f.value.includes(v[f.field])) match = false;
                  if (f.op === '<' && !(v[f.field] < f.value)) match = false;
                  if (f.op === '!=' && v[f.field] === f.value) match = false;
                }
                if (match) {
                  const id = k.split('/')[1];
                  results.push({
                    id,
                    data: () => v,
                    ref: {
                      update: async (u) => {
                        const existing = docs.get(k);
                        docs.set(k, { ...existing, ...u });
                      },
                    },
                  });
                }
              }
              return { docs: results };
            },
          };
          return query;
        },
      };
    },
    async runTransaction(fn) {
      // Simple mock: run directly
      const tx = {
        get: async (ref) => ref.get(),
        update: (ref, updates) => ref.update(updates),
      };
      return fn(tx);
    },
    _docs: docs,
  };
  return db;
}

export default {
  name: 'Stage 3A: Real lifecycle functions (mocked Storage)',
  whatItProves: 'createIntent, validateUpload, commitMedia, sweepOrphans work correctly with injected Storage.',

  async run() {
    setTestStorage(mockStorage);
    mockFiles.clear();
    const db = createMockDb();

    try {
      // 1. Create intent — verifies signed URL has generation-match header
      const intent = await createIntent(db, {
        agencyId: 'agency-hkc',
        uploadedBy: 'user-1',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
      });
      if (!intent.uploadUrl.includes('action=write')) {
        throw new Error('Signed URL should be for write action');
      }
      console.log('  ✓ createIntent with generation-match header');

      // 2. Simulate upload with correct file
      const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const fileBuffer = Buffer.concat([jpegHeader, Buffer.alloc(1024 - jpegHeader.length)]);
      const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const snap1 = await db.collection('media').doc(intent.mediaId).get();
      const storagePath = snap1.data().storagePath;
      await db.collection('media').doc(intent.mediaId).update({
        sha256: actualHash,
        sizeBytes: fileBuffer.length,
      });
      mockFiles.set(storagePath, { buffer: fileBuffer, size: fileBuffer.length, generation: '123' });

      // 3. Mark uploaded
      await markUploaded(db, intent.mediaId);
      const snap2 = await db.collection('media').doc(intent.mediaId).get();
      if (snap2.data().state !== 'UPLOADED') throw new Error('Should be UPLOADED');
      console.log('  ✓ markUploaded');

      // 4. Validate — should succeed with correct file
      const validated = await validateUpload(db, intent.mediaId);
      if (validated.state !== 'VALIDATED') throw new Error('Should be VALIDATED');
      if (validated.generation !== '123') throw new Error('Should record generation');
      console.log('  ✓ validateUpload (success)');

      // 5. Commit — should succeed
      const committed = await commitMedia(db, intent.mediaId, 'task', 'task-1');
      if (committed.state !== 'COMMITTED') throw new Error('Should be COMMITTED');
      console.log('  ✓ commitMedia');

      // 6. Download URL — should work for committed
      const url = await getDownloadUrl(db, intent.mediaId);
      if (!url.includes('mock-signed-url')) throw new Error('Invalid download URL');
      console.log('  ✓ getDownloadUrl');

      // 7. Validation failure: wrong checksum
      const intent2 = await createIntent(db, {
        agencyId: 'agency-hkc',
        uploadedBy: 'user-1',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'b'.repeat(64), // Wrong hash
      });
      const snap3 = await db.collection('media').doc(intent2.mediaId).get();
      mockFiles.set(snap3.data().storagePath, { buffer: fileBuffer, size: fileBuffer.length, generation: '456' });
      await markUploaded(db, intent2.mediaId);
      try {
        await validateUpload(db, intent2.mediaId);
        throw new Error('Should have failed validation');
      } catch (e) {
        if (!(e instanceof MediaError) || e.code !== 'CHECKSUM_MISMATCH') {
          throw new Error(`Wrong error: ${e.message}`);
        }
      }
      const snap4 = await db.collection('media').doc(intent2.mediaId).get();
      if (snap4.data().state !== 'ABANDONED') throw new Error('Should be ABANDONED');
      if (!snap4.data().deleteError) throw new Error('Should have deleteError for retry');
      console.log('  ✓ validateUpload (checksum failure → ABANDONED with deleteError)');

      // 8. Sweeper: should clean up ABANDONED with deleteError
      const sweepResult = await sweepOrphans(db);
      if (sweepResult.deleted < 1) throw new Error('Sweeper should delete files');
      console.log(`  ✓ sweepOrphans (deleted: ${sweepResult.deleted})`);

    } finally {
      setTestStorage(null);
    }

    console.log('  ✓ All real-function tests passed');
  },
};
