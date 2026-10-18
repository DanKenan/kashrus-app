/**
 * Test 15: Frontend smoke — drive the API the way the PWA does.
 *
 * Simulates the PWA client's core resilience flows with raw fetch (no ctx
 * helpers, like the real frontend):
 *  1. Login → bearer token.
 *  2. Create a task with a client-generated operationId.
 *  3. Lost response: retry the SAME operationId → the server returns the
 *     cached result (200, same task id), no duplicate is created, and the
 *     version does not move.
 *  4. Stale edit: client A reads the doc version; client B updates the task;
 *     client A then PUTs with the old expectedVersion → 409 with code
 *     VERSION_CONFLICT and the current version (the client must refresh).
 *  5. 503 simulation: not triggerable on demand through the public API —
 *     documented as a manual test (see below).
 *  6. Optimistic rollback: documents the expected frontend behavior on 409.
 *
 * MANUAL TESTS:
 *  - 503 path: with the server pointed at an unreachable Firestore (or by
 *    killing the DB mid-request), POST /api/tasks must return 503 with code
 *    SAVE_FAILED; the PWA must keep the optimistic entry marked unsaved and
 *    offer retry — never silently drop it.
 *  - Optimistic rollback: in the PWA, apply the edit locally, send the PUT;
 *    on 409 (VERSION_CONFLICT) roll the UI back to the server state and
 *    surface "changed elsewhere — refresh"; on 200 with the cached result
 *    (duplicate operationId) treat it as success without duplicating the
 *    row.
 */
const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';
const ADMIN_PASSWORD = 'stage2-test-password';

export default {
  name: 'Test 15: Frontend smoke (PWA flows)',
  whatItProves:
    'The API supports the PWA resilience contract: login → create with operationId → lost-response retry returns the cached result; stale edits get 409 VERSION_CONFLICT.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueId = 'venue-crown-market';

    // --- 1. Login like the PWA ---
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) throw new Error(`PWA-style login failed: ${loginRes.status}`);
    const authed = async (method, path, body) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${loginJson.token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };

    // --- 2. Create with a client-generated operationId ---
    const operationId = `pwa-smoke-${ts}`;
    const title = `Stage2 Test15 PWA Task ${ts}`;
    const createBody = {
      venueId,
      title,
      createdByEmail: ADMIN_EMAIL,
      operationId,
    };
    const r1 = await authed('POST', '/api/tasks', createBody);
    if (r1.status !== 201 && r1.status !== 200) {
      throw new Error(`create failed: ${r1.status} ${JSON.stringify(r1.json)}`);
    }
    const task1 = r1.json.task || r1.json;
    if (!task1.id) throw new Error('create response has no task id');
    const v1 = await ctx.getVersion();

    // --- 3. Lost response: retry with the SAME operationId ---
    const r2 = await authed('POST', '/api/tasks', createBody);
    if (r2.status !== 200) {
      throw new Error(`idempotent retry should return 200 cached, got ${r2.status}: ${JSON.stringify(r2.json)}`);
    }
    const task2 = r2.json.task || r2.json;
    if (task2.id !== task1.id) {
      throw new Error(`retry returned a different task (duplicate!): ${task1.id} vs ${task2.id}`);
    }
    const docAfter = await ctx.getDoc();
    const dupes = docAfter.tasks.filter((t) => t.title === title);
    if (dupes.length !== 1) throw new Error(`duplicate tasks created: ${dupes.length}`);
    const v2 = await ctx.getVersion();
    if (v2 !== v1) throw new Error(`version moved on idempotent retry: ${v1} -> ${v2}`);

    // --- 4. Stale edit: A reads version, B updates, A writes with old version → 409 ---
    const vA = await ctx.getVersion();
    const bUpdate = await ctx.api('PUT', `/api/tasks/${task1.id}`, {
      title: `${title} — client B edit`,
      createdByEmail: ADMIN_EMAIL,
      userEmail: ADMIN_EMAIL,
    });
    if (bUpdate.status !== 200) throw new Error(`client B update failed: ${bUpdate.status}`);
    const stale = await authed('PUT', `/api/tasks/${task1.id}`, {
      title: `${title} — stale client A edit`,
      expectedVersion: vA,
      createdByEmail: ADMIN_EMAIL,
      userEmail: ADMIN_EMAIL,
    });
    if (stale.status !== 409) {
      throw new Error(`stale edit should be 409, got ${stale.status}: ${JSON.stringify(stale.json)}`);
    }
    if (stale.json.code !== 'VERSION_CONFLICT') {
      throw new Error(`expected code VERSION_CONFLICT, got ${JSON.stringify(stale.json)}`);
    }
    if (typeof stale.json.currentVersion !== 'number') {
      throw new Error('409 response missing numeric currentVersion');
    }
    // Client B's write must be intact (stale write applied nothing).
    const durable = (await ctx.getDoc()).tasks.find((t) => t.id === task1.id);
    if (durable.title !== `${title} — client B edit`) {
      throw new Error('stale write corrupted the task');
    }

    await authed('DELETE', `/api/tasks/${task1.id}`, {});

    return (
      `PWA flows verified: login ok; operationId retry → cached task ${task1.id} (no dupe, version ${v1}); ` +
      `stale edit → 409 VERSION_CONFLICT (currentVersion ${stale.json.currentVersion}). ` +
      `503-simulation and optimistic-rollback UI behavior documented as manual tests (see file header).`
    );
  },
};
