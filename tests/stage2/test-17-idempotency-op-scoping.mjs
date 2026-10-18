/**
 * Test 17: Idempotency records are scoped by operation type, method, and target.
 *
 * The operation ID alone is not enough: reusing the same operationId for a
 * DIFFERENT action must not return an unrelated cached result. The server
 * stores opType (label), HTTP method, and target (entity type + id) on the
 * idempotency record and rejects mismatches with 409 PAYLOAD_MISMATCH.
 *
 * Cases:
 *  1. Same operationId for create-task then update-task → 409 (type differs).
 *  2. Same operationId + identical payload for task A then task B → 409
 *     (target differs) — must not return task A's cached result.
 *  3. Same operationId + identical payload + same target → 200 cached
 *     (true retry still works).
 */
export default {
  name: 'Test 17: Idempotency operation type/method/target scoping',
  whatItProves:
    'Reusing an operationId for a different action (type/target) is rejected with 409 instead of returning an unrelated cached result; genuine retries still hit the cache.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueId = 'venue-crown-market';
    const mk = async (title, operationId) => {
      const r = await ctx.api('POST', '/api/tasks', {
        venueId,
        title,
        createdByEmail: 'kenan@hartfordkashrut.org',
        operationId,
      });
      if (r.status !== 201 && r.status !== 200) {
        throw new Error(`create failed: ${r.status} ${JSON.stringify(r.json)}`);
      }
      return (r.json.task || r.json).id;
    };

    // --- 1. Type scoping: create then update with the same operationId ---
    const opType = `idem-scope-type-${ts}`;
    const taskType = await mk(`Test17 Type ${ts}`, opType);
    const v1 = await ctx.getVersion();
    const updType = await ctx.api('PUT', `/api/tasks/${taskType}`, {
      title: `Test17 Type ${ts} — updated`,
      createdByEmail: 'kenan@hartfordkashrut.org',
      expectedVersion: v1,
      operationId: opType, // reused!
    });
    if (updType.status !== 409) {
      throw new Error(`type reuse should be 409, got ${updType.status}: ${JSON.stringify(updType.json)}`);
    }
    if (updType.json.code !== 'PAYLOAD_MISMATCH') {
      throw new Error(`expected PAYLOAD_MISMATCH, got ${JSON.stringify(updType.json)}`);
    }
    // The update must NOT have applied.
    const docType = await ctx.getDoc();
    if (docType.tasks.find((t) => t.id === taskType).title !== `Test17 Type ${ts}`) {
      throw new Error('type-scoped retry incorrectly applied the update');
    }

    // --- 2. Target scoping: same operationId + identical payload, different task ---
    const taskA = await mk(`Test17 Target A ${ts}`, `idem-scope-a-${ts}`);
    const taskB = await mk(`Test17 Target B ${ts}`, `idem-scope-b-${ts}`);
    const opTarget = `idem-scope-target-${ts}`;
    const vA = await ctx.getVersion();
    const putBody = (v) => ({
      title: `Test17 Identical Title ${ts}`,
      createdByEmail: 'kenan@hartfordkashrut.org',
      expectedVersion: v,
      operationId: opTarget,
    });
    const rA = await ctx.api('PUT', `/api/tasks/${taskA}`, putBody(vA));
    if (rA.status !== 200) throw new Error(`first targeted update failed: ${rA.status}`);
    const vB = await ctx.getVersion();
    // Identical payload (after stripping versioning fields), different target.
    const rB = await ctx.api('PUT', `/api/tasks/${taskB}`, putBody(vB));
    if (rB.status !== 409) {
      throw new Error(`target reuse should be 409, got ${rB.status}: ${JSON.stringify(rB.json)}`);
    }
    if (rB.json.code !== 'PAYLOAD_MISMATCH') {
      throw new Error(`expected PAYLOAD_MISMATCH, got ${JSON.stringify(rB.json)}`);
    }
    // Task B must be untouched (no silent cross-apply).
    const docT = await ctx.getDoc();
    if (docT.tasks.find((t) => t.id === taskB).title !== `Test17 Target B ${ts}`) {
      throw new Error('target-scoped retry incorrectly updated task B');
    }

    // --- 3. Genuine retry: same op, same target, same payload → cached 200 ---
    const retry = await ctx.api('PUT', `/api/tasks/${taskA}`, putBody(vA));
    if (retry.status !== 200) {
      throw new Error(`genuine retry should be 200 cached, got ${retry.status}: ${JSON.stringify(retry.json)}`);
    }
    if ((retry.json.id || (retry.json.task || {}).id) !== taskA && retry.json.title !== `Test17 Identical Title ${ts}`) {
      throw new Error(`retry returned wrong cached result: ${JSON.stringify(retry.json).slice(0, 200)}`);
    }

    // Cleanup.
    for (const id of [taskType, taskA, taskB]) {
      const v = await ctx.getVersion();
      await ctx.api('DELETE', `/api/tasks/${id}`, { expectedVersion: v });
    }

    return 'type reuse → 409; target reuse → 409 (no cross-apply); genuine retry → 200 cached';
  },
};
