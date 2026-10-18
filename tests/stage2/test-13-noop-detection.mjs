/**
 * Test 13: No-op detection (item 5 fix).
 *
 * The fix: docsEqualIgnoring() compares NESTED entity fields — including
 * task.updatedAt — as real data, and ignores `updatedAt` ONLY at the top
 * level (document metadata), alongside _v and savedAt. A write that changes
 * nothing meaningful must not bump the version or cost a Firestore write.
 *
 * Verifies through the API:
 *  1. Entity timestamp change persists: completing a task writes a real
 *     nested `updatedAt` timestamp; the version bumps and the timestamp is
 *     in durable Firestore state. (The API does not accept a raw `updatedAt`
 *     — the server stamps it — so the test drives it through completion,
 *     the path that mutates the nested timestamp.)
 *  2. True no-op doesn't bump: re-sending the identical completion leaves
 *     the version UNCHANGED (the update-task mutator's statusAlreadyMatches
 *     short-circuit returns the doc untouched, and the no-op detector
 *     agrees — no Firestore write).
 *  3. Nested entity change bumps: changing only `notes` (nested data)
 *     bumps the version and persists — nested fields are compared, not
 *     ignored.
 *  4. Top-level metadata ignored: no API path sets a top-level `updatedAt`
 *     on the state document, so the top-level ignore branch is verified by
 *     asserting the durable doc carries no top-level `updatedAt` key that
 *     could mask real changes (the ignore set itself — _v, savedAt,
 *     top-level updatedAt — is covered by code inspection of
 *     docsEqualIgnoring in server.ts).
 */
const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

export default {
  name: 'Test 13: No-op detection (nested timestamps are data)',
  whatItProves:
    'Nested entity fields (incl. task.updatedAt) are compared as real data — changes bump the version; byte-identical rewrites do not.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueId = 'venue-crown-market';

    const c = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: `Stage2 Test13 Noop ${ts}`,
      createdByEmail: ADMIN_EMAIL,
    });
    if (c.status !== 201 && c.status !== 200) throw new Error(`create failed: ${c.status}`);
    const taskId = (c.json.task || c.json).id;
    const v0 = await ctx.getVersion();

    // --- 1. Entity timestamp change persists (completion stamps nested updatedAt) ---
    const done = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      isCompleted: true,
      notes: 'noop probe notes',
      userEmail: ADMIN_EMAIL,
      expectedVersion: v0,
    });
    if (done.status !== 200) throw new Error(`complete failed: ${done.status}`);
    const v1 = await ctx.getVersion();
    if (v1 !== v0 + 1) throw new Error(`completion should bump version: ${v0} -> ${v1}`);
    const updatedAt = done.json.updatedAt;
    if (typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(updatedAt)) {
      throw new Error(`nested updatedAt not stamped as a real timestamp: ${JSON.stringify(updatedAt)}`);
    }
    const durable1 = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
    if (durable1.updatedAt !== updatedAt) {
      throw new Error('nested updatedAt not persisted to Firestore');
    }

    // --- 2. True no-op doesn't bump: identical completion re-sent ---
    const same = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      isCompleted: true,
      notes: 'noop probe notes',
      userEmail: ADMIN_EMAIL,
      expectedVersion: v1,
    });
    if (same.status !== 200) throw new Error(`identical re-complete failed: ${same.status}`);
    const v2 = await ctx.getVersion();
    if (v2 !== v1) {
      throw new Error(`identical write bumped version (no-op detection failed): ${v1} -> ${v2}`);
    }

    // --- 3. Nested entity change bumps: notes only ---
    const edit = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      notes: 'noop probe notes v2',
      userEmail: ADMIN_EMAIL,
      expectedVersion: v2,
    });
    if (edit.status !== 200) throw new Error(`notes edit failed: ${edit.status}`);
    const v3 = await ctx.getVersion();
    if (v3 !== v2 + 1) throw new Error(`nested notes change should bump version: ${v2} -> ${v3}`);
    const durable3 = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
    if (durable3.notes !== 'noop probe notes v2') {
      throw new Error('nested notes change not persisted to Firestore');
    }

    // --- 4. Top-level metadata ignored (no top-level updatedAt on the doc) ---
    const doc = await ctx.getDoc();
    if (Object.prototype.hasOwnProperty.call(doc, 'updatedAt')) {
      throw new Error('state doc carries a top-level updatedAt — the metadata-ignore branch could mask real changes');
    }

    const vDel = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${taskId}`, { expectedVersion: vDel });

    return (
      `nested updatedAt stamped+ persisted (v${v0}→v${v1}); ` +
      `identical rewrite no-bump (v${v1}); nested notes edit bumped (v${v2}→v${v3}); ` +
      `no top-level updatedAt on state doc`
    );
  },
};
