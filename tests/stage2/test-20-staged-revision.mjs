/**
 * Test 20: Staged-revision guard (round 5).
 *
 * A revision deployed with STAGED_REVISION=true is staged for cutover
 * verification: it must serve reads and health checks but REFUSE all writes
 * (503 NOT_YET_LIVE), so it can never write to production before the
 * operator flips it live. This guarantees old and new writers are never
 * live simultaneously, even if the staged revision's direct URL is hit
 * early.
 *
 * Method: toggle the guard at runtime via the test-only /api/__test__/staged
 * endpoint (production uses the STAGED_REVISION env var; the test suite
 * cannot restart the server child process with different env).
 *   1. Normal mode: writes work, health shows staged:false.
 *   2. Enable staged: POST/PUT/DELETE → 503 NOT_YET_LIVE; GETs still 200;
 *      /api/health shows staged:true.
 *   3. Disable staged: writes work again.
 */
export default {
  name: 'Test 20: Staged-revision guard',
  whatItProves:
    'A staged revision serves reads/health but refuses every mutation with 503 NOT_YET_LIVE — it cannot write to production before cutover.',

  async run(baseUrl, ctx) {
    const ts = Date.now();

    async function setStaged(enabled) {
      const r = await fetch(`${baseUrl}/api/__test__/staged`, {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ enabled }),
      });
      if (r.status !== 200) throw new Error(`staged toggle failed: ${r.status}`);
      return r.json();
    }

    // --- 1. Normal mode baseline ---
    let health = await ctx.api('GET', '/api/health');
    if (health.status !== 200) throw new Error(`health failed: ${health.status}`);
    if (health.json.staged) throw new Error('expected staged=false in normal mode');

    // --- 2. Enable staged mode ---
    const on = await setStaged(true);
    if (!on.staged) throw new Error('staged toggle did not enable');

    health = await ctx.api('GET', '/api/health');
    if (health.json.staged !== true) throw new Error('health does not report staged:true');
    if (health.json.status !== 'ok' && health.json.status !== 'degraded') {
      throw new Error(`unexpected health status in staged mode: ${health.json.status}`);
    }

    // Reads still work.
    const getRes = await ctx.api('GET', '/api/tasks');
    if (getRes.status !== 200) throw new Error(`GET blocked in staged mode: ${getRes.status}`);

    // Every mutation is refused with 503 NOT_YET_LIVE — never silently applied.
    const v = await ctx.getVersion();
    const mutations = [
      ['POST', '/api/tasks', { venueId: 'venue-crown-market', title: `Test20 Staged ${ts}` }],
      ['PUT', '/api/tasks/nonexistent', { notes: 'x', expectedVersion: v }],
      ['DELETE', '/api/tasks/nonexistent', { expectedVersion: v }],
    ];
    for (const [method, path, body] of mutations) {
      const r = await ctx.api(method, path, body);
      if (r.status !== 503) {
        throw new Error(`staged ${method} ${path}: got ${r.status}, expected 503 NOT_YET_LIVE`);
      }
      if (r.json.code !== 'NOT_YET_LIVE') {
        throw new Error(`staged ${method} ${path}: wrong code ${r.json.code}`);
      }
    }
    // No write leaked through: version unchanged.
    const vAfter = await ctx.getVersion();
    if (vAfter !== v) throw new Error(`staged mode leaked a write: v${v} -> v${vAfter}`);

    // --- 3. Disable staged mode: writes work again ---
    const off = await setStaged(false);
    if (off.staged) throw new Error('staged toggle did not disable');
    const w = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test20 Live ${ts}`,
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (w.status !== 201 && w.status !== 200) throw new Error(`write after unstaging failed: ${w.status}`);
    const liveId = (w.json.task || w.json).id;
    const vd = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${liveId}`, { expectedVersion: vd });

    return 'staged mode: reads OK + health staged:true, all mutations → 503 NOT_YET_LIVE with zero version movement; unstaged → writes work';
  },
};
