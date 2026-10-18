/**
 * Test 6: Idempotency — send the same operationId twice →
 * second returns the cached result, no duplicate applied.
 */
export default {
  name: 'Test 6: Idempotent operationId replay',
  whatItProves:
    'Client retries after a timeout do not create duplicates. The same operationId returns the original result.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';
    const operationId = `test6-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const body = {
      venueId,
      title: 'Stage2 Test6 Idempotent Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
      operationId,
    };

    // First attempt.
    const r1 = await ctx.api('POST', '/api/tasks', body);
    if (r1.status !== 201 && r1.status !== 200) {
      throw new Error(`first attempt failed: ${r1.status} ${JSON.stringify(r1.json)}`);
    }
    const task1 = r1.json.task || r1.json;
    const v1 = await ctx.getVersion();

    // Count tasks with this title in Firestore before the retry.
    const docBefore = await ctx.getDoc();
    const countBefore = docBefore.tasks.filter((t) => t.title === 'Stage2 Test6 Idempotent Task').length;

    // Retry with the SAME operationId (simulating client retry after timeout).
    const r2 = await ctx.api('POST', '/api/tasks', body);
    if (r2.status !== 200) {
      throw new Error(`retry expected 200 (cached), got ${r2.status}: ${JSON.stringify(r2.json)}`);
    }
    const task2 = r2.json.task || r2.json;

    // Must return the SAME task, not a new one.
    if (task2.id !== task1.id) {
      throw new Error(`retry created a different task: ${task1.id} vs ${task2.id}`);
    }

    // No duplicate in Firestore.
    const docAfter = await ctx.getDoc();
    const countAfter = docAfter.tasks.filter((t) => t.title === 'Stage2 Test6 Idempotent Task').length;
    if (countAfter !== countBefore) {
      throw new Error(`duplicate created: count ${countBefore} -> ${countAfter}`);
    }
    if (countAfter !== 1) {
      throw new Error(`expected exactly 1 task, found ${countAfter}`);
    }

    // Version must NOT have incremented on the replay.
    const v2 = await ctx.getVersion();
    if (v2 !== v1) {
      throw new Error(`version incremented on idempotent replay: ${v1} -> ${v2}`);
    }

    await ctx.api('DELETE', `/api/tasks/${task1.id}`, {});

    return `retry returned same task ${task1.id}, no duplicate, version stayed at ${v2}`;
  },
};
