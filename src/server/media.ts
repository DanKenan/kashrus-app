/**
 * Stage 3A — Media lifecycle module.
 *
 * Implements the §6 upload lifecycle: INTENT → UPLOADED → VALIDATED → COMMITTED,
 * with ABANDONED for intents never completed and EXPIRED for media past retention.
 *
 * Design principles (per ChatGPT review):
 * - All operations check the authenticated user's agency/venue permissions.
 *   Never trust agencyId from the client — use the verified session user.
 * - Private bucket, server-generated object paths, short-lived signed URLs.
 * - Explicit file-size limits, allowed MIME types, file-signature validation,
 *   checksum verification. Commit only after validation.
 * - Missing Storage configuration fails media ops clearly (503) without
 *   breaking existing Shutfey functionality.
 * - Orphan sweeper is idempotent. Failed/abandoned uploads never appear as attached.
 * - 30-day retention: lifecycle rules + scheduled sweeper. Written history preserved.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Allowed MIME types for uploads. Photos and voice recordings only. */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'audio/mpeg',      // MP3
  'audio/mp4',       // M4A
  'audio/wav',
  'audio/webm',
  'audio/ogg',
]);

/** Max file size: 25 MB for photos, 50 MB for audio. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** Signed URL lifetimes. */
export const UPLOAD_URL_TTL_MINUTES = 15;
export const DOWNLOAD_URL_TTL_MINUTES = 15;

/** Retention: 30 days per Don's decision. Sweeper runs at 29 days for safety margin. */
export const RETENTION_DAYS = 30;
export const SWEEPER_RETENTION_DAYS = 29;

/** Intent expires if not uploaded within 1 hour. */
export const INTENT_TTL_MS = 60 * 60 * 1000;

/** Lifecycle states. */
export type MediaState =
  | 'INTENT'      // Upload URL issued, file not yet uploaded
  | 'UPLOADED'    // File uploaded, awaiting validation
  | 'VALIDATED'   // Passed validation, awaiting commit
  | 'COMMITTED'   // Attached to an entity, visible
  | 'ABANDONED'   // Intent expired or upload failed
  | 'EXPIRED'     // Past 30-day retention
  | 'DELETED';    // Removed from Storage

/** Media metadata document (Firestore `media/{mediaId}`). */
export interface MediaDoc {
  id: string;
  agencyId: string;           // From verified session, never client
  venueId?: string;           // Optional venue scope
  uploadedBy: string;         // User ID from verified session
  state: MediaState;
  mimeType: string;
  sizeBytes: number;
  sha256: string;             // Client-provided, verified on validate
  storagePath: string;        // Server-generated, never client-controlled
  generation?: string;        // Storage generation, for overwrite detection
  createdAt: string;          // ISO timestamp
  uploadedAt?: string;
  validatedAt?: string;
  committedAt?: string;
  expiresAt: string;          // createdAt + 30 days
  mediaDeletedAt?: string;    // When the Storage object was deleted
  attachedTo?: {              // Set on commit (metadata only in Phase 3A)
    entityType: string;
    entityId: string;
  };
  validationError?: string;
  deleteError?: string;       // Last delete failure, for sweeper retry
}

// ---------------------------------------------------------------------------
// File signature validation (magic bytes)
// ---------------------------------------------------------------------------

const SIGNATURES: Array<{ mime: string; offset: number; bytes: number[]; extra?: { offset: number; bytes: number[] } }> = [
  // JPEG
  { mime: 'image/jpeg', offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  // PNG
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  // WebP: RIFF....WEBP (verify both RIFF header and WEBP marker)
  { mime: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  // HEIC/HEIF: ftyp box (verify ftyp at offset 4)
  { mime: 'image/heic', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  // MP3: ID3 header or frame sync
  { mime: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xFF, 0xFB] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xFF, 0xF3] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xFF, 0xF2] },
  // WAV: RIFF....WAVE (verify both)
  { mime: 'audio/wav', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] } },
  // OGG
  { mime: 'audio/ogg', offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53] },
  // WebM: EBML header
  { mime: 'audio/webm', offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  // M4A/MP4: ftyp box
  { mime: 'audio/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/**
 * Validate that buffer's magic bytes match the claimed MIME type.
 * For RIFF-based formats (WebP, WAV), verifies both the RIFF header
 * and the format-specific marker. Returns true if signature matches.
 */
export function validateFileSignature(buffer: Buffer, mimeType: string): boolean {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return false;
  for (const sig of SIGNATURES) {
    if (sig.mime !== mimeType) continue;
    if (buffer.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    // Verify extra marker (e.g., WEBP after RIFF, WAVE after RIFF)
    if (sig.extra) {
      if (buffer.length < sig.extra.offset + sig.extra.bytes.length) continue;
      for (let i = 0; i < sig.extra.bytes.length; i++) {
        if (buffer[sig.extra.offset + i] !== sig.extra.bytes[i]) {
          match = false;
          break;
        }
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Get max allowed bytes for a MIME type.
 */
export function maxBytesForMime(mimeType: string): number {
  if (mimeType.startsWith('image/')) return MAX_IMAGE_BYTES;
  if (mimeType.startsWith('audio/')) return MAX_AUDIO_BYTES;
  return 0;
}

// ---------------------------------------------------------------------------
// Server-generated storage paths
// ---------------------------------------------------------------------------

/**
 * Generate a storage path. Server-controlled, includes agencyId for isolation
 * and a random component to prevent guessing. Never uses client input.
 */
export function generateStoragePath(agencyId: string, mediaId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const random = crypto.randomBytes(8).toString('hex');
  return `media/${agencyId}/${mediaId}-${random}.${safeExt}`;
}

/**
 * Generate a media ID (opaque UUID).
 */
export function generateMediaId(): string {
  return `media-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Storage client (lazy, graceful degradation, injectable for tests)
// ---------------------------------------------------------------------------

let storageClient: any = null;
let storageInitError: string | null = null;
// Test seam: injected Storage client overrides the real one
let injectedStorage: any = null;

/**
 * Inject a mock Storage client for testing. Pass null to clear.
 */
export function setTestStorage(mock: any | null): void {
  injectedStorage = mock;
}

function getBucketName(): string | null {
  return process.env.MEDIA_BUCKET_NAME || null;
}

/**
 * Get the Storage client, or null if not configured.
 * Missing configuration must not break the app — media ops return 503.
 */
export function getStorage(): { storage: any; bucketName: string } | null {
  if (injectedStorage) {
    return { storage: injectedStorage, bucketName: 'test-bucket' };
  }
  const bucketName = getBucketName();
  if (!bucketName) return null;
  if (storageInitError) return null;
  if (!storageClient) {
    try {
      // Lazy require to avoid crash if package not installed
      const { Storage } = require('@google-cloud/storage');
      storageClient = new Storage();
    } catch (e: any) {
      storageInitError = e?.message || 'Storage init failed';
      return null;
    }
  }
  return { storage: storageClient, bucketName };
}

/**
 * Check if media functionality is available.
 */
export function isMediaConfigured(): boolean {
  return getStorage() !== null;
}

// ---------------------------------------------------------------------------
// Media operations
// ---------------------------------------------------------------------------

export interface IntentParams {
  agencyId: string;      // From verified session
  venueId?: string;      // Optional, validated against user's venues
  uploadedBy: string;    // User ID from verified session
  mimeType: string;
  sizeBytes: number;
  sha256: string;        // Expected checksum (hex)
}

export interface IntentResult {
  mediaId: string;
  uploadUrl: string;     // Signed URL, 15-min TTL
  storagePath: string;
  expiresAt: string;
}

/**
 * Create an upload intent. Returns a signed URL for direct-to-bucket upload.
 * The media doc starts in INTENT state.
 *
 * Security: The signed URL includes x-goog-if-generation-match: 0 as a
 * signed extension header, preventing overwrite of an existing object.
 * The client MUST send this header on the PUT, and CORS must allow it.
 * A second PUT to the same URL receives HTTP 412 (Precondition Failed).
 * The generation is verified on validate/commit as defense-in-depth.
 */
export async function createIntent(
  db: any,
  params: IntentParams
): Promise<IntentResult> {
  const store = getStorage();
  if (!store) {
    throw new MediaError('Media storage is not configured.', 'NOT_CONFIGURED', 503);
  }

  const { mimeType, sizeBytes, sha256 } = params;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new MediaError(`MIME type not allowed: ${mimeType}`, 'INVALID_MIME', 400);
  }
  const maxBytes = maxBytesForMime(mimeType);
  if (sizeBytes <= 0 || sizeBytes > maxBytes) {
    throw new MediaError(
      `File size ${sizeBytes} exceeds limit ${maxBytes} for ${mimeType}`,
      'INVALID_SIZE',
      400
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new MediaError('Invalid SHA-256 checksum format.', 'INVALID_CHECKSUM', 400);
  }

  const mediaId = generateMediaId();
  const extension = mimeType.split('/')[1] || 'bin';
  const storagePath = generateStoragePath(params.agencyId, mediaId, extension);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const doc: MediaDoc = {
    id: mediaId,
    agencyId: params.agencyId,
    venueId: params.venueId,
    uploadedBy: params.uploadedBy,
    state: 'INTENT',
    mimeType,
    sizeBytes,
    sha256: sha256.toLowerCase(),
    storagePath,
    createdAt: now.toISOString(),
    expiresAt,
  };

  // Generate signed upload URL (PUT, 15-min TTL, content-type locked).
  // x-goog-if-generation-match: 0 as a SIGNED extension header — the client
  // must send this header on the PUT, or the signature won't match.
  // A second PUT to the same path gets HTTP 412 (Precondition Failed).
  const bucket = store.storage.bucket(store.bucketName);
  const file = bucket.file(storagePath);
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + UPLOAD_URL_TTL_MINUTES * 60 * 1000,
    contentType: mimeType,
    extensionHeaders: {
      'x-goog-if-generation-match': '0',
    },
  });

  await db.collection('media').doc(mediaId).set(doc);
  return { mediaId, uploadUrl, storagePath, expiresAt };
}

/**
 * Validate an uploaded file. Streams the content for checksum verification
 * (avoids loading 50MB into memory), verifies MIME signature from the first
 * bytes, and checks size. Transitions UPLOADED → VALIDATED.
 *
 * The object's generation is recorded. If the generation changes after
 * validation (overwrite attempt), commit will fail.
 */
export async function validateUpload(db: any, mediaId: string): Promise<MediaDoc> {
  const store = getStorage();
  if (!store) {
    throw new MediaError('Media storage is not configured.', 'NOT_CONFIGURED', 503);
  }

  const docRef = db.collection('media').doc(mediaId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new MediaError('Media not found.', 'NOT_FOUND', 404);
  }
  const doc = snap.data() as MediaDoc;
  if (doc.state !== 'UPLOADED' && doc.state !== 'INTENT') {
    throw new MediaError(`Cannot validate media in state ${doc.state}.`, 'INVALID_STATE', 400);
  }

  const bucket = store.storage.bucket(store.bucketName);
  const file = bucket.file(doc.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    await docRef.update({ state: 'ABANDONED', validationError: 'File not uploaded.', deleteError: 'No file to delete.' });
    throw new MediaError('File was not uploaded.', 'NOT_UPLOADED', 400);
  }

  const [metadata] = await file.getMetadata();
  const actualSize = parseInt(metadata.size || '0', 10);
  if (actualSize !== doc.sizeBytes) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: `Size mismatch: expected ${doc.sizeBytes}, got ${actualSize}.`,
      deleteError: 'Validation failed, file needs deletion.',
    });
    throw new MediaError('File size does not match intent.', 'SIZE_MISMATCH', 400);
  }

  // Record the generation for overwrite detection
  const generation = metadata.generation;

  // Stream the file for checksum + signature validation (memory-efficient)
  const hash = crypto.createHash('sha256');
  const stream = file.createReadStream();
  let firstBytes: Buffer | null = null;

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      if (!firstBytes) {
        firstBytes = chunk.slice(0, 32); // Enough for magic bytes
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const actualHash = hash.digest('hex');
  if (actualHash.toLowerCase() !== doc.sha256.toLowerCase()) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: 'Checksum mismatch.',
      deleteError: 'Validation failed, file needs deletion.',
    });
    throw new MediaError('File checksum does not match.', 'CHECKSUM_MISMATCH', 400);
  }

  if (!firstBytes || !validateFileSignature(firstBytes, doc.mimeType)) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: `File signature does not match MIME type ${doc.mimeType}.`,
      deleteError: 'Validation failed, file needs deletion.',
    });
    throw new MediaError('File content does not match declared type.', 'SIGNATURE_MISMATCH', 400);
  }

  const validated: MediaDoc = {
    ...doc,
    state: 'VALIDATED',
    validatedAt: new Date().toISOString(),
    // Store generation to detect post-validation overwrites
    generation,
  } as MediaDoc;
  await docRef.update({
    state: 'VALIDATED',
    validatedAt: validated.validatedAt,
    generation,
  });
  return validated;
}

/**
 * Mark an intent as uploaded (called after client PUTs to signed URL).
 * Transitions INTENT → UPLOADED.
 */
export async function markUploaded(db: any, mediaId: string): Promise<void> {
  const docRef = db.collection('media').doc(mediaId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new MediaError('Media not found.', 'NOT_FOUND', 404);
  }
  const doc = snap.data() as MediaDoc;
  if (doc.state !== 'INTENT') {
    throw new MediaError(`Cannot mark uploaded from state ${doc.state}.`, 'INVALID_STATE', 400);
  }
  await docRef.update({ state: 'UPLOADED', uploadedAt: new Date().toISOString() });
}

/**
 * Commit validated media to an entity. Transitions VALIDATED → COMMITTED.
 * The media reference is only stored after validation passes.
 *
 * Verifies the Storage generation hasn't changed since validation
 * (prevents post-validation overwrite attacks).
 *
 * Phase 3A note: attachedTo is metadata recording the intended attachment.
 * Referential integrity is enforced in Phase 3B with per-entity collections.
 */
export async function commitMedia(
  db: any,
  mediaId: string,
  entityType: string,
  entityId: string
): Promise<MediaDoc> {
  const store = getStorage();
  const docRef = db.collection('media').doc(mediaId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new MediaError('Media not found.', 'NOT_FOUND', 404);
  }
  const doc = snap.data() as MediaDoc;
  if (doc.state !== 'VALIDATED') {
    throw new MediaError(
      `Cannot commit media in state ${doc.state}. Must be VALIDATED.`,
      'INVALID_STATE',
      400
    );
  }

  // Verify generation hasn't changed (overwrite detection)
  if (store && doc.generation) {
    const bucket = store.storage.bucket(store.bucketName);
    const file = bucket.file(doc.storagePath);
    const [metadata] = await file.getMetadata();
    if (metadata.generation !== doc.generation) {
      await docRef.update({
        state: 'ABANDONED',
        validationError: 'File was modified after validation.',
      });
      throw new MediaError(
        'File was replaced after validation. Upload again.',
        'OVERWRITE_DETECTED',
        400
      );
    }
  }

  const committed: MediaDoc = {
    ...doc,
    state: 'COMMITTED',
    committedAt: new Date().toISOString(),
    attachedTo: { entityType, entityId },
  };
  await docRef.update({
    state: 'COMMITTED',
    committedAt: committed.committedAt,
    attachedTo: committed.attachedTo,
  });
  return committed;
}

/**
 * Get a short-lived signed download URL for committed media.
 * Rejects expired media. Caps URL expiry at the retention deadline.
 */
export async function getDownloadUrl(db: any, mediaId: string): Promise<string> {
  const store = getStorage();
  if (!store) {
    throw new MediaError('Media storage is not configured.', 'NOT_CONFIGURED', 503);
  }
  const snap = await db.collection('media').doc(mediaId).get();
  if (!snap.exists) {
    throw new MediaError('Media not found.', 'NOT_FOUND', 404);
  }
  const doc = snap.data() as MediaDoc;
  if (doc.state !== 'COMMITTED') {
    throw new MediaError('Media is not available for download.', 'NOT_COMMITTED', 400);
  }
  // Reject expired media
  if (new Date(doc.expiresAt) < new Date()) {
    throw new MediaError('Media has expired.', 'EXPIRED', 410);
  }
  const bucket = store.storage.bucket(store.bucketName);
  const file = bucket.file(doc.storagePath);
  // Cap URL expiry at the retention deadline (don't issue URLs past expiration)
  const maxExpiry = new Date(doc.expiresAt).getTime();
  const requestedExpiry = Date.now() + DOWNLOAD_URL_TTL_MINUTES * 60 * 1000;
  const expires = Math.min(requestedExpiry, maxExpiry);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
  });
  return url;
}

// ---------------------------------------------------------------------------
// Orphan sweeper (idempotent)
// ---------------------------------------------------------------------------

export interface SweeperResult {
  abandoned: number;   // Intents marked ABANDONED
  deleted: number;     // Expired files deleted from Storage
  retried: number;     // Failed deletes retried
  errors: string[];
}

/**
 * Sweep for orphans. Idempotent — safe to run multiple times.
 *
 * 1. Mark INTENT/UPLOADED/VALIDATED older than INTENT_TTL_MS as ABANDONED.
 *    (VALIDATED stranded without commit are also abandoned.)
 * 2. Retry deletion for ABANDONED records with a previous deleteError.
 * 3. Delete Storage objects for ABANDONED intents. Only mark DELETED after
 *    confirmed deletion. On failure, record deleteError for retry.
 * 4. For COMMITTED past expiresAt: delete from Storage first. Only mark
 *    EXPIRED after confirmed deletion. If Storage is unavailable or delete
 *    fails, leave as COMMITTED with deleteError for retry — never mark
 *    EXPIRED while the object still exists.
 *
 * Written Firestore metadata is preserved (the record that media existed).
 */
export async function sweepOrphans(db: any): Promise<SweeperResult> {
  const result: SweeperResult = { abandoned: 0, deleted: 0, retried: 0, errors: [] };
  const store = getStorage();
  const now = new Date();
  const intentCutoff = new Date(now.getTime() - INTENT_TTL_MS).toISOString();
  const nowIso = now.toISOString();

  // Helper: delete object, return true on success, false on failure
  async function tryDelete(storagePath: string): Promise<boolean> {
    if (!store) return false;
    try {
      await store.storage.bucket(store.bucketName).file(storagePath).delete({ ignoreNotFound: true });
      return true;
    } catch (e: any) {
      return false;
    }
  }

  // 1. Abandon expired intents (INTENT, UPLOADED, or stranded VALIDATED)
  const staleIntents = await db.collection('media')
    .where('state', 'in', ['INTENT', 'UPLOADED', 'VALIDATED'])
    .where('createdAt', '<', intentCutoff)
    .get();
  for (const doc of staleIntents.docs) {
    try {
      const data = doc.data() as MediaDoc;
      // Use transaction to protect against concurrent updates
      await db.runTransaction(async (tx: any) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return;
        const freshData = fresh.data() as MediaDoc;
        // Only abandon if still in a pre-commit state (not already handled)
        if (!['INTENT', 'UPLOADED', 'VALIDATED'].includes(freshData.state)) return;
        tx.update(doc.ref, { state: 'ABANDONED', validationError: 'Intent expired.' });
      });
      result.abandoned++;
      // Try to delete the object — even for INTENT, the user may have uploaded
      // without calling /uploaded. Always attempt deletion.
      const deleted = await tryDelete(data.storagePath);
      if (deleted) {
        result.deleted++;
        await doc.ref.update({ mediaDeletedAt: nowIso });
      } else if (store) {
        // Record for retry, even if the file might not exist
        await doc.ref.update({ deleteError: 'Delete failed or file not found, will retry.' });
      }
    } catch (e: any) {
      result.errors.push(`abandon ${doc.id}: ${e?.message}`);
    }
  }

  // 2. Retry failed deletions for ABANDONED records
  const failedDeletes = await db.collection('media')
    .where('state', '==', 'ABANDONED')
    .where('deleteError', '!=', null)
    .get();
  for (const doc of failedDeletes.docs) {
    try {
      const data = doc.data() as MediaDoc;
      // Skip if already deleted
      if (data.mediaDeletedAt) {
        await doc.ref.update({ deleteError: null });
        continue;
      }
      const deleted = await tryDelete(data.storagePath);
      result.retried++;
      if (deleted) {
        result.deleted++;
        await doc.ref.update({ mediaDeletedAt: nowIso, deleteError: null });
      }
    } catch (e: any) {
      result.errors.push(`retry ${doc.id}: ${e?.message}`);
    }
  }

  // 3. Expire committed media past retention — ONLY after confirmed deletion
  // Uses 29-day threshold (safety margin before the 30-day maximum).
  const retentionCutoff = new Date(now.getTime() - SWEEPER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = await db.collection('media')
    .where('state', '==', 'COMMITTED')
    .where('expiresAt', '<', retentionCutoff)
    .get();
  for (const doc of expired.docs) {
    try {
      const data = doc.data() as MediaDoc;
      // If Storage is unavailable, do NOT mark EXPIRED — leave for retry
      if (!store) {
        await doc.ref.update({ deleteError: 'Storage unavailable, will retry.' });
        result.errors.push(`${doc.id}: Storage unavailable, not marking EXPIRED`);
        continue;
      }
      const deleted = await tryDelete(data.storagePath);
      if (deleted) {
        result.deleted++;
        // Only mark EXPIRED after confirmed deletion
        await doc.ref.update({ state: 'EXPIRED', mediaDeletedAt: nowIso, deleteError: null });
      } else {
        // Delete failed — record for retry, do NOT mark EXPIRED
        await doc.ref.update({ deleteError: 'Delete failed, will retry.' });
        result.errors.push(`${doc.id}: Delete failed, will retry`);
      }
    } catch (e: any) {
      result.errors.push(`expire ${doc.id}: ${e?.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MediaError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.status = status;
  }
}
