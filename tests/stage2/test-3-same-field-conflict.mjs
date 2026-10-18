/**
 * Test 3: Two simultaneous updates to the SAME task field →
 * one succeeds, one gets 409 (never silent last-wins).
 */
export default {
  name: 'Test 3: Same-field conflict → one wins, one gets 409',
  whatItProves:
    'Conflicting writes to the same field are detected semantically. The loser gets 409, not a silent overwrite.',

  async run(baseUrl, ctx) {
    const venueId = 'venue-crown-market';

    const c = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: 'Stage2 Test3 Task',
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c.status !== 201 && c.status !== 200) throw new Error('create failed');
    const taskId = (c.json.task || c.json).id;
    const v0 = await ctx.getVersion();

    // Both clients read the same baseline version, then both try to rename.
    // The semantic conflict detector (baseline vs fresh) must 409 one of them.
    const [r1, r2] = await Promise.all([
      ctx.api('PUT', `/api/tasks/${taskId}`, {
        title: 'Rename by Client 1',
        expectedVersion: v0,
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
      ctx.api('PUT', `/api/tasks/${taskId}`, {
        title: 'Rename by Client 2',
        expectedVersion: v0,
        createdByEmail: 'kenan@hartfordkashrut.org',
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    if (!(statuses[0] === 200 && statuses[1] === 409)) {
      throw new Error(
        `expected one 200 and one 409, got ${r1.status} and ${r2.status}: ` +
        JSON.stringify([r1.json, r2.json])
      );
    }

    // The winner's value must be intact; the loser's must NOT have overwritten it.
    const doc = await ctx.getDoc();
    const t = doc.tasks.find((x) => x.id === taskId);
    const winnerName = r1.status === 200 ? 'Rename by Client 1' : 'Rename by Client 2';
    if (t.title !== winnerName) {
      throw new Error(`winner's value not intact: expected "${winnerName}", got "${t.title}"`);
    }

    await ctx.api('DELETE', `/api/tasks/${taskId}`, {});

    return `one 200 + one 409, winner="${winnerName}", no silent overwrite`;
  },
};
