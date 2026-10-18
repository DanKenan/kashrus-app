/**
 * Test 1: Stale write blocked.
 * A transaction commits; a subsequent write using a STALE expectedVersion
 * (simulating the old fire-and-forget path that never checked versions)
 * must be rejected with 409 and must NOT overwrite the committed data.
 */
export default {
  name: 'Test 1: Stale write blocked (version check)',
  whatItProves:
    'A write with a stale expectedVersion cannot overwrite a committed transaction. The version check blocks it.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';

    // Create a task (commits at some version V).
    const c1 = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: 'Stage2 Test1 Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c1.status !== 201 && c1.status !== 200) throw new Error(`create failed: ${c1.status} ${JSON.stringify(c1.json)}`);
    const task = c1.json.task || c1.json;
    const taskId = task.id;
    const vAfterCreate = await ctx.getVersion();

    // Another write bumps the version (simulating a concurrent commit).
    const c2 = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: 'Stage2 Test1 Other Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c2.status !== 201 && c2.status !== 200) throw new Error('second create failed');
    const vAfterSecond = await ctx.getVersion();
    if (vAfterSecond !== vAfterCreate + 1) {
      throw new Error(`version did not increment by 1: ${vAfterCreate} -> ${vAfterSecond}`);
    }

    // Now attempt a STALE write: update the first task with the old version.
    const stale = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      title: 'HACKED BY STALE WRITE',
      expectedVersion: vAfterCreate, // stale!
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (stale.status !== 409) {
      throw new Error(`expected 409 for stale write, got ${stale.status}: ${JSON.stringify(stale.json)}`);
    }

    // Verify the task was NOT modified.
    const doc = await ctx.getDoc();
    const freshTask = doc.tasks.find((t) => t.id === taskId);
    if (!freshTask) throw new Error('task disappeared from Firestore');
    if (freshTask.title === 'HACKED BY STALE WRITE' || freshTask.name === 'HACKED BY STALE WRITE') {
      throw new Error('STALE WRITE OVERWROTE COMMITTED DATA');
    }

    // Version must be unchanged by the rejected write.
    const vAfterStale = await ctx.getVersion();
    if (vAfterStale !== vAfterSecond) {
      throw new Error(`version changed on rejected write: ${vAfterSecond} -> ${vAfterStale}`);
    }

    // Cleanup.
    await ctx.api('DELETE', `/api/tasks/${taskId}`, {});

    return `stale write got 409, committed data intact, version stayed at ${vAfterStale}`;
  },
};
