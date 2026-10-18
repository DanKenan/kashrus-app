/**
 * Test 11: FORCE_LOCAL_MODE maintenance middleware.
 *
 * WHAT THIS TEST DOES:
 *  The Stage 2 harness always boots the server in normal mode (there is no
 *  harness support for FORCE_LOCAL_MODE=true), so a live maintenance-mode
 *  run cannot be automated here. This test verifies the normal-mode side of
 *  the contract — maintenance mode is OFF and writes are NOT blocked:
 *   1. GET /api/health reports firestore 'connected' (maintenance mode off;
 *      with FORCE_LOCAL_MODE=true Firestore init is skipped entirely).
 *   2. A write (create + delete a task) succeeds — the middleware lets
 *      mutating requests through when the flag is unset.
 *
 * MANUAL VERIFICATION STEPS (required before release — cannot run in harness):
 *  The middleware lives in server.ts, `app.use('/api', ...)` ("BLOCKER 2
 *  fix: FORCE_LOCAL_MODE is a READ-ONLY maintenance mode"):
 *    if (process.env.FORCE_LOCAL_MODE === 'true' &&
 *        req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
 *      return res.status(503).json({
 *        error: 'Maintenance mode — writes are temporarily disabled. ...',
 *        code: 'MAINTENANCE',
 *      });
 *    }
 *  To verify by hand:
 *   1. Stop the server. Restart with FORCE_LOCAL_MODE=true in the env
 *      (e.g. `FORCE_LOCAL_MODE=true npx tsx server.ts`). Firestore init is
 *      skipped — /api/health should report status 'degraded' and a
 *      non-'connected' firestore value.
 *   2. GET /api/health (or any GET) → 200. Reads keep working.
 *   3. POST /api/tasks → 503 with body code 'MAINTENANCE'.
 *   4. PUT /api/tasks/<id> → 503 with body code 'MAINTENANCE'.
 *   5. DELETE /api/tasks/<id> → 503 with body code 'MAINTENANCE'.
 *   6. POST /api/reset-daily → 503 with body code 'MAINTENANCE'.
 *   7. Unset FORCE_LOCAL_MODE and restart — writes work again, no data lost
 *      (writes were rejected, never half-applied).
 */
export default {
  name: 'Test 11: Maintenance mode (normal-mode sanity + manual steps)',
  whatItProves:
    'In normal mode (FORCE_LOCAL_MODE unset) the maintenance middleware does not block writes; the full maintenance-mode matrix is documented for manual verification.',

  async run(baseUrl, ctx) {
    // 1. Health: maintenance mode must be OFF in the harness.
    const health = await ctx.api('GET', '/api/health');
    if (health.status !== 200) throw new Error(`health check failed: ${health.status}`);
    if (health.json.firestore !== 'connected') {
      throw new Error(
        `expected firestore 'connected' (maintenance off), got '${health.json.firestore}' — ` +
          'the harness may be running with FORCE_LOCAL_MODE=true'
      );
    }

    // 2. A mutating request must succeed (middleware passes it through).
    const venueId = 'venue-crown-market';
    const c = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: `Stage2 Test11 Maintenance Sanity ${Date.now()}`,
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (c.status !== 201 && c.status !== 200) {
      throw new Error(`write blocked in normal mode: ${c.status} ${JSON.stringify(c.json)}`);
    }
    const taskId = (c.json.task || c.json).id;
    const d = await ctx.api('DELETE', `/api/tasks/${taskId}`, {});
    if (d.status !== 200) throw new Error(`delete blocked in normal mode: ${d.status}`);

    return (
      'maintenance mode OFF (firestore connected); writes pass through. ' +
      'Full FORCE_LOCAL_MODE=true matrix (503/MAINTENANCE on POST/PUT/DELETE, GET still 200) requires manual verification — steps in file header.'
    );
  },
};
