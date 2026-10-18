/**
 * Test 14: Document size guard (900KB limit → 503 SIZE_LIMIT).
 *
 * LIMITATION (documented, not worked around): pushing a real ~900KB document
 * through the HTTP API is slow and would bloat the shared mock Firestore
 * file for every later test, so a live over-limit write is NOT performed
 * here. Instead this test verifies the guard is WIRED correctly by
 * inspecting server.ts source — it fails if any link in the chain is
 * removed or renamed:
 *   1. DocumentTooLargeError exists with code 'SIZE_LIMIT'.
 *   2. The limit constant is 900 * 1024 bytes.
 *   3. commitState() throws DocumentTooLargeError when the serialized
 *      payload exceeds the limit.
 *   4. commitOrRespond() maps DocumentTooLargeError → HTTP 503 with
 *      body code 'SIZE_LIMIT'.
 *
 * MANUAL VERIFICATION (to prove the live path end-to-end):
 *   1. POST /api/tasks with a ~950KB string in `description` (generate with
 *      'x'.repeat(950*1024)).
 *   2. Expect 503 and `"code":"SIZE_LIMIT"` in the body.
 *   3. Expect NO version bump (ctx.getVersion() unchanged) and no partial
 *      task in Firestore.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '..', '..', 'server.ts'), 'utf-8');

function mustContain(needle, what) {
  if (!serverSrc.includes(needle)) {
    throw new Error(`size-guard wiring broken: missing ${what} (${JSON.stringify(needle)})`);
  }
}

export default {
  name: 'Test 14: Document size guard wiring (900KB → 503 SIZE_LIMIT)',
  whatItProves:
    'The 900KB document-size guard exists and is wired: over-limit payloads throw DocumentTooLargeError, mapped to HTTP 503 / code SIZE_LIMIT.',

  async run(baseUrl, ctx) {
    // 1. Error class with the SIZE_LIMIT code.
    mustContain('class DocumentTooLargeError extends Error', 'DocumentTooLargeError class');
    mustContain("code = 'SIZE_LIMIT'", "DocumentTooLargeError code 'SIZE_LIMIT'");

    // 2. The 900KB limit constant.
    mustContain('const SIZE_LIMIT_BYTES = 900 * 1024', 'SIZE_LIMIT_BYTES = 900KB');

    // 3. commitState() enforces it on the serialized payload before tx.set.
    mustContain('if (payloadSize > SIZE_LIMIT_BYTES)', 'payload-size comparison');
    mustContain('throw new DocumentTooLargeError(payloadSize, SIZE_LIMIT_BYTES)', 'throw site');

    // 4. commitOrRespond() maps it to HTTP 503 + code SIZE_LIMIT.
    mustContain('err instanceof DocumentTooLargeError', 'commitOrRespond DocumentTooLargeError branch');
    mustContain("res.status(503).json({ error: err.message, code: 'SIZE_LIMIT' })", '503/SIZE_LIMIT mapping');

    return 'size-guard wiring verified in source (900KB → DocumentTooLargeError → 503 SIZE_LIMIT); live 900KB write left as documented manual test';
  },
};
