/**
 * Test 2: Two simultaneous updates to DIFFERENT tasks with the same version.
 *
 * Under the strict version contract, the client's version must match the
 * server's current version exactly. Two concurrent writes race: the first
 * commits, the second finds the version moved and gets 409 VERSION_CONFLICT
 * (not a silent overwrite, not a silent drop — a clear, retryable error).
 * The loser refreshes, retries with the fresh version, and its change lands.
 * Nothing is lost; nothing is silently overwritten.
 */
export default {
  name: 'Test 2: Concurrent writes to different tasks — one wins, loser retries cleanly',
  whatItProves:
    'The strict version gate turns a concurrent race into a clear 409 (never a silent overwrite). The loser refreshes and retries with the fresh version; both changes land, no data loss.',

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

    // Fire two updates simultaneously, both with the version they saw (v0).
    // Exactly one must win; the other must get 409 (strict gate).
    const [rA, rB] = await Promise.all([
      ctx.api('PUT', `/api/tasks/${idA}`, {
        title: 'Stage2 Test2 Task A — updated',
        createdByEmail: 'kenan@hartfordkashrut.org',
        expectedVersion: v0,
      }),
      ctx.api('PUT', `/api/tasks/${idB}`, {
        title: 'Stage2 Test2 Task B — updated',
        createdByEmail: 'kenan@hartfordkashrut.org',
        expectedVersion: v0,
      }),
    ]);

    const statuses = [rA.status, rB.status].sort();
    if (!(statuses[0] === 200 && statuses[1] === 409)) {
      throw new Error(
        `expected one 200 and one 409, got ${rA.status} and ${rB.status}: ` +
        JSON.stringify([rA.json, rB.json])
      );
    }
    const loser = rA.status === 409 ? { id: idA, title: 'Stage2 Test2 Task A — updated' } : { id: idB, title: 'Stage2 Test2 Task B — updated' };
    const loserRes = rA.status === 409 ? rA : rB;
    if (loserRes.json.code !== 'VERSION_CONFLICT') {
      throw new Error(`loser should get VERSION_CONFLICT, got ${JSON.stringify(loserRes.json)}`);
    }

    // The loser refreshes (reads the new version) and retries — its change lands.
    const v1 = await ctx.getVersion();
    if (v1 !== v0 + 1) throw new Error(`expected version ${v0 + 1} after one commit, got ${v1}`);
    const retry = await ctx.api('PUT', `/api/tasks/${loser.id}`, {
      title: loser.title,
      createdByEmail: 'kenan@hartfordkashrut.org',
      expectedVersion: v1,
    });
    if (retry.status !== 200) throw new Error(`retry failed: ${retry.status} ${JSON.stringify(retry.json)}`);

    // Both changes must be present in Firestore.
    const doc = await ctx.getDoc();
    const tA = doc.tasks.find((t) => t.id === idA);
    const tB = doc.tasks.find((t) => t.id === idB);
    if (tA.title !== 'Stage2 Test2 Task A — updated') throw new Error('task A update lost');
    if (tB.title !== 'Stage2 Test2 Task B — updated') throw new Error('task B update lost');

    // Version advanced by exactly 2 (two commits, no lost writes).
    const v2 = await ctx.getVersion();
    if (v2 !== v0 + 2) throw new Error(`expected version ${v0 + 2}, got ${v2}`);

    const vDel1 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${idA}`, { expectedVersion: vDel1 });
    const vDel2 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${idB}`, { expectedVersion: vDel2 });

    return `race → one 200 + one 409 VERSION_CONFLICT; loser retried at v${v1} → 200; both changes present, version ${v0} → ${v2}`;
  },
};
