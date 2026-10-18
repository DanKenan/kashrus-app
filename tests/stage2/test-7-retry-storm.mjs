/**
 * Test 7: Retry storm — 10 concurrent writes to different entities →
 * all succeed, versions increment correctly.
 */
export default {
  name: 'Test 7: Retry storm (10 concurrent writes)',
  whatItProves:
    'Under contention, all mergeable writes succeed via transaction retry. The version increments by exactly the number of commits — no lost writes.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';
    const N = 10;
    const v0 = await ctx.getVersion();

    // 10 concurrent task creates (different entities → all mergeable).
    const creates = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx.api('POST', '/api/tasks', {
          venueId,
          title: `Stage2 Test7 Storm Task ${i}`,
          createdByEmail: 'kenan@hartfordkashrut.org',
          operationId: `test7-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
        })
      )
    );

    const failures = creates.filter((r) => r.status !== 201 && r.status !== 200);
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${N} writes failed: ` +
        failures.map((f) => `${f.status} ${JSON.stringify(f.json)}`).join('; ')
      );
    }

    const ids = creates.map((r) => (r.json.task || r.json).id);
    if (new Set(ids).size !== N) {
      throw new Error(`duplicate IDs in storm: ${ids.join(',')}`);
    }

    // All 10 must be present in Firestore.
    const doc = await ctx.getDoc();
    const missing = ids.filter((id) => !doc.tasks.some((t) => t.id === id));
    if (missing.length > 0) {
      throw new Error(`${missing.length} storm tasks missing from Firestore: ${missing.join(',')}`);
    }

    // Version must have incremented by exactly N.
    const v1 = await ctx.getVersion();
    if (v1 !== v0 + N) {
      throw new Error(`expected version ${v0 + N}, got ${v1} (lost ${v0 + N - v1} writes?)`);
    }

    // Cleanup.
    await Promise.all(ids.map((id) => ctx.api('DELETE', `/api/tasks/${id}`, {})));

    return `all ${N} writes committed, version ${v0} → ${v1}, no lost writes`;
  },
};
