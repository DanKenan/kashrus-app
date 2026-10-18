/**
 * Stage 3A Test: Media validation logic.
 * Tests file signature validation, MIME type checks, size limits,
 * and path generation — all without requiring Storage.
 */
import {
  validateFileSignature,
  maxBytesForMime,
  generateStoragePath,
  generateMediaId,
  ALLOWED_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  RETENTION_DAYS,
  MediaError,
} from '../../src/server/media.ts';

export default {
  name: 'Stage 3A: Media validation logic',
  whatItProves: 'File signatures, MIME types, sizes, and paths are validated correctly.',

  async run() {
    // 1. JPEG signature
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    if (!validateFileSignature(jpeg, 'image/jpeg')) {
      throw new Error('JPEG signature not recognized');
    }
    if (validateFileSignature(jpeg, 'image/png')) {
      throw new Error('JPEG incorrectly validated as PNG');
    }

    // 2. PNG signature
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (!validateFileSignature(png, 'image/png')) {
      throw new Error('PNG signature not recognized');
    }

    // 3. Invalid MIME type rejected
    if (validateFileSignature(jpeg, 'application/pdf')) {
      throw new Error('PDF should not be allowed');
    }

    // 4. Size limits
    if (maxBytesForMime('image/jpeg') !== MAX_IMAGE_BYTES) {
      throw new Error('Image size limit wrong');
    }
    if (maxBytesForMime('audio/mpeg') !== MAX_AUDIO_BYTES) {
      throw new Error('Audio size limit wrong');
    }
    if (maxBytesForMime('application/pdf') !== 0) {
      throw new Error('PDF should have 0 max bytes');
    }

    // 5. Storage path generation (server-controlled, no client input)
    const path1 = generateStoragePath('agency-hkc', 'media-123', 'jpg');
    const path2 = generateStoragePath('agency-hkc', 'media-123', 'jpg');
    if (!path1.startsWith('media/agency-hkc/')) {
      throw new Error('Path should include agencyId');
    }
    if (path1 === path2) {
      throw new Error('Paths should be unique (random component)');
    }
    if (path1.includes('..') || path1.includes('//')) {
      throw new Error('Path should be sanitized');
    }

    // 6. Media ID generation (opaque UUID)
    const id1 = generateMediaId();
    const id2 = generateMediaId();
    if (!id1.startsWith('media-')) {
      throw new Error('Media ID should have prefix');
    }
    if (id1 === id2) {
      throw new Error('Media IDs should be unique');
    }

    // 7. Allowed MIME types (photos + audio only)
    if (!ALLOWED_MIME_TYPES.has('image/jpeg')) {
      throw new Error('JPEG should be allowed');
    }
    if (!ALLOWED_MIME_TYPES.has('audio/mpeg')) {
      throw new Error('MP3 should be allowed');
    }
    if (ALLOWED_MIME_TYPES.has('application/pdf')) {
      throw new Error('PDF should not be allowed');
    }
    if (ALLOWED_MIME_TYPES.has('video/mp4')) {
      throw new Error('Video should not be allowed');
    }

    // 8. Retention period
    if (RETENTION_DAYS !== 30) {
      throw new Error('Retention should be 30 days per Don\'s decision');
    }

    // 9. MediaError has code and status
    const err = new MediaError('Test', 'TEST_CODE', 400);
    if (err.code !== 'TEST_CODE' || err.status !== 400) {
      throw new Error('MediaError should carry code and status');
    }

    console.log('  ✓ All media validation checks passed');
  },
};
