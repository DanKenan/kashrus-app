/**
 * Test 2: Two simultaneous updates to DIFFERENT tasks → both succeed, no data loss.
 * Mergeable writes must both commit (via transaction retry on version conflict).
 */
export default {
  name: 'Test 2: Concurrent writes to different tasks both succeed',
  whatItProves:
    'Mergeable concurrent writes (different tasks) both succeed. Transaction retry re-applies on fresh data; nothing is lost.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';

    // Create two tasks.
    const mk = async (title) => {
      const r = await ctx.api('POST', '/api/tasks', {
        venueId,
        title,
        createdByEmail: 'kenan@hartfordkashrut.org',
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`create failed: ${r.status}`);
      return (r.json.task || r.json).id;
    };
    const idA = await mk('Stage2 Test2 Task A');
    const idB = await mk('Stage2 Test2 Task B');
    const v0 = await ctx.getVersion();

    // Fire two updates simultaneously (no expectedVersion → server uses fresh read).
    const [rA, rB] = await Promise.all([
      ctx.api('PUT', `/api/tasks/${idA}`, {
        title: 'Stage2 Test2 Task A — updated',
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
      ctx.api('PUT', `/api/tasks/${idB}`, {
        title: 'Stage2 Test2 Task B — updated',
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
    ]);

    if (rA.status !== 200) throw new Error(`update A failed: ${rA.status} ${JSON.stringify(rA.json)}`);
    if (rB.status !== 200) throw new Error(`update B failed: ${rB.status} ${JSON.stringify(rB.json)}`);

    // Both changes must be present in Firestore.
    const doc = await ctx.getDoc();
    const tA = doc.tasks.find((t) => t.id === idA);
    const tB = doc.tasks.find((t) => t.id === idB);
    if (tA.title !== 'Stage2 Test2 Task A — updated') throw new Error('task A update lost');
    if (tB.title !== 'Stage2 Test2 Task B — updated') throw new Error('task B update lost');

    // Version must have incremented by at least 2 (no lost writes).
    const v1 = await ctx.getVersion();
    if (v1 < v0 + 2) throw new Error(`expected version >= ${v0 + 2}, got ${v1}`);

    await ctx.api('DELETE', `/api/tasks/${idA}`, {});
    await ctx.api('DELETE', `/api/tasks/${idB}`, {});

    return `both updates committed, version ${v0} → ${v1}, no data loss`;
  },
};
