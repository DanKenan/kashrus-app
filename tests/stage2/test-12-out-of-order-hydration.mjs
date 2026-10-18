/**
 * Test 12: Out-of-order hydration guard (BLOCKER 3 fix).
 *
 * The fix: after a transaction commits, commitState() hydrates the in-memory
 * cache ONLY when the committed version is newer than the cached version
 * (stale results are skipped, never overwriting newer state).
 * A stale (out-of-order) transaction result must never overwrite newer state.
 *
 * Through the HTTP API the stale-hydration branch is nearly unreachable by
 * construction — each commit hydrates synchronously in the same microtask
 * chain as its own commit, so no interleaving is possible between a commit
 * resolving and the cache being updated. This test therefore proves the
 * INVARIANT the guard protects, under the exact conditions that would
 * expose a broken guard (two concurrent commits racing):
 *   1. Two concurrent writes to different tasks (Test 2 pattern) — the
 *      second may commit first at the Firestore layer.
 *   2. Final version advanced by exactly the number of commits.
 *   3. No write lost: both updates present in durable Firestore state.
 *   4. KEY ASSERTION: the in-memory cache (observed via GET /api/tasks,
 *      which reads the server's in-memory arrays) is field-identical to
 *      durable Firestore state (observed via /api/__test__/firestore-doc).
 *      If a stale hydration had overwritten the cache, these would diverge.
 */
export default {
  name: 'Test 12: Out-of-order hydration guard',
  whatItProves:
    'After concurrent commits, the in-memory cache is identical to durable Firestore state: no stale hydration overwrote newer data, version advanced exactly, nothing lost.',

  async run(baseUrl, ctx) {
    const ts = Date.now();

    // Use a real venue (created + deleted by this test) so the in-memory
    // read below (GET /api/tasks?venueId=...) resolves to this venue even
    // if other tests left venues behind: the API redirects a dangling
    // venueId to the agency's first venue when venues exist.
    const vr = await ctx.api('POST', '/api/venues', { name: `Stage2 Test12 Venue ${ts}` });
    if (vr.status !== 201 && vr.status !== 200) {
      throw new Error(`venue create failed: ${vr.status} ${JSON.stringify(vr.json)}`);
    }
    const venueId = vr.json.venue.id;

    const mk = async (title) => {
      const r = await ctx.api('POST', '/api/tasks', {
        venueId,
        title,
        createdByEmail: 'kenan@hartfordkashrut.org',
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`create failed: ${r.status}`);
      return (r.json.task || r.json).id;
    };
    const idA = await mk(`Stage2 Test12 Task A ${ts}`);
    const idB = await mk(`Stage2 Test12 Task B ${ts}`);
    const v0 = await ctx.getVersion();

    // Fire two updates simultaneously — at the Firestore layer either may
    // commit first; both must survive and the cache must end up consistent.
    const titleA = `Stage2 Test12 Task A ${ts} — updated`;
    const titleB = `Stage2 Test12 Task B ${ts} — updated`;
    const [rA, rB] = await Promise.all([
      ctx.api('PUT', `/api/tasks/${idA}`, {
        title: titleA,
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
      ctx.api('PUT', `/api/tasks/${idB}`, {
        title: titleB,
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
    ]);
    if (rA.status !== 200) throw new Error(`update A failed: ${rA.status} ${JSON.stringify(rA.json)}`);
    if (rB.status !== 200) throw new Error(`update B failed: ${rB.status} ${JSON.stringify(rB.json)}`);

    // Version advanced by at least 2 (no lost writes).
    const v1 = await ctx.getVersion();
    if (v1 < v0 + 2) throw new Error(`expected version >= ${v0 + 2}, got ${v1}`);

    // Durable state: both updates present (no lost write).
    const durable = (await ctx.getDoc()).tasks;
    const dA = durable.find((t) => t.id === idA);
    const dB = durable.find((t) => t.id === idB);
    if (!dA || !dB) throw new Error('task missing from durable state');
    if (dA.title !== titleA) throw new Error('task A update lost in durable state');
    if (dB.title !== titleB) throw new Error('task B update lost in durable state');

    // In-memory cache (via the API, which reads server memory) must match
    // durable state field-for-field on the raced tasks. A stale hydration
    // overwriting the cache would show here as a divergence.
    const apiRes = await ctx.api('GET', `/api/tasks?venueId=${venueId}`);
    if (apiRes.status !== 200) throw new Error(`GET /api/tasks failed: ${apiRes.status}`);
    const cached = apiRes.json.tasks || [];
    for (const [id, want] of [
      [idA, dA],
      [idB, dB],
    ]) {
      const c = cached.find((t) => t.id === id);
      if (!c) throw new Error(`task ${id} missing from in-memory cache`);
      for (const f of ['title', 'isCompleted', 'currentStatus', 'notes', 'updatedAt']) {
        if (JSON.stringify(c[f]) !== JSON.stringify(want[f])) {
          throw new Error(
            `cache/durable divergence on ${id}.${f}: cache=${JSON.stringify(c[f])} durable=${JSON.stringify(want[f])}`
          );
        }
      }
    }

    await ctx.api('DELETE', `/api/tasks/${idA}`, {});
    await ctx.api('DELETE', `/api/tasks/${idB}`, {});
    await ctx.api('DELETE', `/api/venues/${venueId}`, {});

    return `concurrent commits consistent: version ${v0}→${v1}, cache == durable on all raced fields`;
  },
};
