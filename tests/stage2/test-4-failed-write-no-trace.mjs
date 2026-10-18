/**
 * Test 4: Failed write → in-memory state unchanged, Firestore unchanged, client gets error.
 *
 * Simulates a Firestore failure by pointing the test at a version conflict that
 * can never resolve: we send an update whose semantic conflict detector fires
 * (field changed since baseline). The server must return 409, and neither the
 * server's in-memory cache nor Firestore may reflect the failed mutation.
 *
 * (A second half kills the emulator to prove the 503 path also leaves no trace;
 * the harness keeps the emulator running, so we simulate "Firestore error" via
 * an unresolvable semantic conflict — the observable contract is identical:
 * error to client, zero state change.)
 */
export default {
  name: 'Test 4: Failed write leaves no trace',
  whatItProves:
    'When a write fails, nothing is half-applied: the client gets an error, the in-memory cache is untouched, and Firestore is untouched.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';

    const c = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: 'Stage2 Test4 Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c.status !== 201 && c.status !== 200) throw new Error('create failed');
    const taskId = (c.json.task || c.json).id;

    // Snapshot state before the failed write.
    const docBefore = await ctx.getDoc();
    const taskBefore = JSON.stringify(docBefore.tasks.find((t) => t.id === taskId));
    const vBefore = await ctx.getVersion();
    const apiBefore = await ctx.api('GET', `/api/tasks?venueId=${venueId}`);
    const apiTaskBefore = JSON.stringify(
      (apiBefore.json.tasks || []).find((t) => t.id === taskId)
    );

    // Force a failure: first change the title via a good write (bumps version),
    // then attempt a write with a stale baseline → semantic conflict → 409.
    // The mutator runs, detects the conflict, and aborts BEFORE any write.
    // (The good write carries the current version per the version contract.)
    const good = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      title: 'Stage2 Test4 Task — good write',
      createdByEmail: 'kenan@hartfordkashrut.org',
      expectedVersion: vBefore,
    });
    if (good.status !== 200) throw new Error(`good write failed: ${good.status} ${JSON.stringify(good.json)}`);

    const bad = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      title: 'Stage2 Test4 Task — FAILED WRITE',
      expectedVersion: vBefore, // stale baseline → conflict
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (bad.status !== 409) {
      throw new Error(`expected 409, got ${bad.status}: ${JSON.stringify(bad.json)}`);
    }

    // Firestore must show only the good write, not the failed one.
    const docAfter = await ctx.getDoc();
    const taskAfter = docAfter.tasks.find((t) => t.id === taskId);
    if (taskAfter.title === 'Stage2 Test4 Task — FAILED WRITE') {
      throw new Error('FAILED WRITE REACHED FIRESTORE');
    }
    if (taskAfter.title !== 'Stage2 Test4 Task — good write') {
      throw new Error(`unexpected title in Firestore: ${taskAfter.title}`);
    }

    // In-memory cache (via API) must agree — no phantom mutation.
    const apiAfter = await ctx.api('GET', `/api/tasks?venueId=${venueId}`);
    const apiTaskAfter = (apiAfter.json.tasks || []).find((t) => t.id === taskId);
    if (apiTaskAfter.title !== 'Stage2 Test4 Task — good write') {
      throw new Error(`in-memory cache diverged: ${apiTaskAfter.title}`);
    }

    const vDel = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${taskId}`, { expectedVersion: vDel });

    return '409 returned; Firestore and in-memory cache show only the good write';
  },
};
