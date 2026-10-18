/**
 * Test 5: Server restart → no resurrection of failed or uncommitted changes.
 * Only committed Firestore data loads. A 409-rejected write must not appear
 * after the process is killed and restarted.
 */
export default {
  name: 'Test 5: Restart resurrects nothing uncommitted',
  whatItProves:
    'The server is stateless across restarts: Firestore is the source of truth. Failed/uncommitted writes never reappear.',

  async run(baseUrl, ctx) {
    if (!ctx.restartServer) {
      throw new Error('restartServer hook not provided by harness — cannot run');
    }
    const venueId = 'venue-crown-market';

    // A committed write.
    const c = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: 'Stage2 Test5 Committed Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c.status !== 201 && c.status !== 200) throw new Error('create failed');
    const committedId = (c.json.task || c.json).id;
    const vCommitted = await ctx.getVersion();

    // A FAILED write (stale version → 409). Must leave no trace.
    const bad = await ctx.api('PUT', `/api/tasks/${committedId}`, {
      title: 'Stage2 Test5 GHOST WRITE',
      expectedVersion: vCommitted - 1,
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (bad.status !== 409) throw new Error(`expected 409, got ${bad.status}`);

    // Kill and restart the Node process.
    await ctx.restartServer();

    // After restart: the committed task must be there, the ghost must not.
    const doc = await ctx.getDoc();
    const committed = doc.tasks.find((t) => t.id === committedId);
    if (!committed) throw new Error('committed task did NOT survive restart');
    if (committed.title === 'Stage2 Test5 GHOST WRITE') {
      throw new Error('GHOST WRITE RESURRECTED AFTER RESTART');
    }
    const ghosts = doc.tasks.filter((t) => t.title === 'Stage2 Test5 GHOST WRITE');
    if (ghosts.length > 0) throw new Error('ghost write found in Firestore after restart');

    // Version must be unchanged across the restart.
    const vAfter = await ctx.getVersion();
    if (vAfter !== vCommitted) {
      throw new Error(`version changed across restart: ${vCommitted} -> ${vAfter}`);
    }

    // The API (in-memory cache, rehydrated from Firestore) must agree.
    const api = await ctx.api('GET', `/api/tasks?venueId=${venueId}`);
    const apiTask = (api.json.tasks || []).find((t) => t.id === committedId);
    if (!apiTask) throw new Error('committed task missing from API after restart');

    await ctx.api('DELETE', `/api/tasks/${committedId}`, {});

    return `committed task survived, ghost write absent, version stable at ${vAfter}`;
  },
};
