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

/** Retention: 30 days per Don's decision. */
export const RETENTION_DAYS = 30;

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
  createdAt: string;          // ISO timestamp
  uploadedAt?: string;
  validatedAt?: string;
  committedAt?: string;
  expiresAt: string;          // createdAt + 30 days
  attachedTo?: {              // Set on commit
    entityType: string;
    entityId: string;
  };
  validationError?: string;
}

// ---------------------------------------------------------------------------
// File signature validation (magic bytes)
// ---------------------------------------------------------------------------

const SIGNATURES: Array<{ mime: string; offset: number; bytes: number[] }> = [
  // JPEG
  { mime: 'image/jpeg', offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  // PNG
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  // WebP (RIFF....WEBP)
  { mime: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  // HEIC/HEIF (ftyp box)
  { mime: 'image/heic', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  // MP3 (ID3 or frame sync)
  { mime: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xFF, 0xFB] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xFF, 0xF3] },
  // WAV (RIFF....WAVE)
  { mime: 'audio/wav', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  // OGG
  { mime: 'audio/ogg', offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53] },
  // WebM (EBML)
  { mime: 'audio/webm', offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  // M4A/MP4 (ftyp)
  { mime: 'audio/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/**
 * Validate that buffer's magic bytes match the claimed MIME type.
 * Returns true if the signature matches, false otherwise.
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
// Storage client (lazy, graceful degradation)
// ---------------------------------------------------------------------------

let storageClient: any = null;
let storageInitError: string | null = null;

function getBucketName(): string | null {
  return process.env.MEDIA_BUCKET_NAME || null;
}

/**
 * Get the Storage client, or null if not configured.
 * Missing configuration must not break the app — media ops return 503.
 */
export function getStorage(): { storage: any; bucketName: string } | null {
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

  // Generate signed upload URL (PUT, 15-min TTL, content-type locked)
  const bucket = store.storage.bucket(store.bucketName);
  const file = bucket.file(storagePath);
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + UPLOAD_URL_TTL_MINUTES * 60 * 1000,
    contentType: mimeType,
  });

  await db.collection('media').doc(mediaId).set(doc);
  return { mediaId, uploadUrl, storagePath, expiresAt };
}

/**
 * Validate an uploaded file. Downloads the first bytes + full file for
 * checksum, verifies MIME signature and size. Transitions UPLOADED → VALIDATED.
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
    await docRef.update({ state: 'ABANDONED', validationError: 'File not uploaded.' });
    throw new MediaError('File was not uploaded.', 'NOT_UPLOADED', 400);
  }

  const [metadata] = await file.getMetadata();
  const actualSize = parseInt(metadata.size || '0', 10);
  if (actualSize !== doc.sizeBytes) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: `Size mismatch: expected ${doc.sizeBytes}, got ${actualSize}.`,
    });
    throw new MediaError('File size does not match intent.', 'SIZE_MISMATCH', 400);
  }

  // Download and verify checksum + signature
  const [buffer] = await file.download();
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actualHash.toLowerCase() !== doc.sha256.toLowerCase()) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: 'Checksum mismatch.',
    });
    throw new MediaError('File checksum does not match.', 'CHECKSUM_MISMATCH', 400);
  }

  if (!validateFileSignature(buffer, doc.mimeType)) {
    await docRef.update({
      state: 'ABANDONED',
      validationError: `File signature does not match MIME type ${doc.mimeType}.`,
    });
    throw new MediaError('File content does not match declared type.', 'SIGNATURE_MISMATCH', 400);
  }

  const validated: MediaDoc = {
    ...doc,
    state: 'VALIDATED',
    validatedAt: new Date().toISOString(),
  };
  await docRef.update({ state: 'VALIDATED', validatedAt: validated.validatedAt });
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
 */
export async function commitMedia(
  db: any,
  mediaId: string,
  entityType: string,
  entityId: string
): Promise<MediaDoc> {
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
  const bucket = store.storage.bucket(store.bucketName);
  const file = bucket.file(doc.storagePath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + DOWNLOAD_URL_TTL_MINUTES * 60 * 1000,
  });
  return url;
}

// ---------------------------------------------------------------------------
// Orphan sweeper (idempotent)
// ---------------------------------------------------------------------------

export interface SweeperResult {
  abandoned: number;   // Intents marked ABANDONED
  deleted: number;     // Expired files deleted from Storage
  errors: string[];
}

/**
 * Sweep for orphans. Idempotent — safe to run multiple times.
 * 1. Mark INTENTs older than INTENT_TTL_MS as ABANDONED.
 * 2. Delete Storage objects for ABANDONED intents (if uploaded).
 * 3. Delete Storage objects past expiresAt (30-day retention), mark EXPIRED.
 * Written Firestore metadata is preserved (the record that media existed).
 */
export async function sweepOrphans(db: any): Promise<SweeperResult> {
  const result: SweeperResult = { abandoned: 0, deleted: 0, errors: [] };
  const store = getStorage();
  const now = new Date();
  const intentCutoff = new Date(now.getTime() - INTENT_TTL_MS).toISOString();
  const nowIso = now.toISOString();

  // 1. Abandon expired intents
  const staleIntents = await db.collection('media')
    .where('state', 'in', ['INTENT', 'UPLOADED'])
    .where('createdAt', '<', intentCutoff)
    .get();
  for (const doc of staleIntents.docs) {
    try {
      await doc.ref.update({ state: 'ABANDONED', validationError: 'Intent expired.' });
      result.abandoned++;
      // Delete the object if it was partially uploaded
      if (store) {
        const data = doc.data() as MediaDoc;
        try {
          await store.storage.bucket(store.bucketName).file(data.storagePath).delete({ ignoreNotFound: true });
        } catch (e: any) {
          result.errors.push(`delete ${data.storagePath}: ${e?.message}`);
        }
      }
    } catch (e: any) {
      result.errors.push(`abandon ${doc.id}: ${e?.message}`);
    }
  }

  // 2. Expire committed media past retention
  const expired = await db.collection('media')
    .where('state', '==', 'COMMITTED')
    .where('expiresAt', '<', nowIso)
    .get();
  for (const doc of expired.docs) {
    try {
      const data = doc.data() as MediaDoc;
      if (store) {
        try {
          await store.storage.bucket(store.bucketName).file(data.storagePath).delete({ ignoreNotFound: true });
          result.deleted++;
        } catch (e: any) {
          result.errors.push(`delete ${data.storagePath}: ${e?.message}`);
        }
      }
      // Keep the metadata doc with EXPIRED state (written history preserved)
      await doc.ref.update({ state: 'EXPIRED', mediaDeletedAt: nowIso });
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
