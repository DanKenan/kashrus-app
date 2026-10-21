/**
 * Test 52 (item 8x, Don Oct 21): Clean Slate is REMOVED, and test-only hooks
 * stay gated.
 *
 * Proves on the real server and emulator (and the mock harness):
 *  1 POST /api/admin/clean-slate is 404 for an agency admin and a
 *    coordinator; nothing is written (doc version unchanged), the agency's
 *    venue and task are still there, no CLEAN_SLATE_RESET reaches anyone
 *  2 the READ side of the old flags is kept (stored data may carry them):
 *    GET /api/venues isDemoCleared is per agency from agencies[].cleanSlateAt
 *    (A stored → true, B none → false)
 *  3 restart with STAGE2_TEST_MODE=false AND CLEAN_SLATE_ENABLED=true: the
 *    admin session is valid, Clean Slate is still 404, and /api/__test__/doc-merge is 404 (mock harness:
 *    exactly FIRESTORE_MOCK=true + STAGE2_TEST_MODE=false; doc-merge is
 *    registered under isTestMode() only)
 */
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 52: Clean Slate removed; test hooks gated (8x)',
  whatItProves:
    'POST /api/admin/clean-slate no longer exists (404 for admin and coordinator, nothing written, no broadcast), the stored per-agency cleared flag is still read, and test-only hooks are 404 outside test mode with a valid admin session.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t52a-${ts}`, B = `agency-t52b-${ts}`;
    const VA = `venue-t52a-${ts}`, VB = `venue-t52b-${ts}`;
    const U = (k) => `user-t52-${k}-${ts}`;
    const E = (k) => `t52-${k}-${ts}@test.local`;
    const PW = 'stage2-t52-password';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body) => {
      const r = await ctx.api('POST', `/api/__test__/${path}`, body);
      assert(r.status === 200, `${path} ${r.status} ${J(r.json)}`);
      return r.json;
    };
    const login = async (k) => {
      const r = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E(k), password: PW });
      assert(r.status === 200 && r.json?.token, `login ${k} ${r.status}`);
      return r.json.token;
    };

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T52 A ${ts}`, shortCode: 'T52A', adminEmail: E('adminA'), cleanSlateAt: '2026-10-21T00:00:00.000Z' },
        { id: B, name: `T52 B ${ts}`, shortCode: 'T52B', adminEmail: E('adminB') },
      ],
      venues: [{ id: VA, name: 'T52 A', agencyId: A }, { id: VB, name: 'T52 B', agencyId: B }],
      tasks: [{ id: `task-t52a-${ts}`, agencyId: A, venueId: VA, title: 'T52 task A', isCompleted: false }],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T52 Admin A', role: 'admin', agencyId: A },
        { id: U('coordA'), email: E('coordA'), name: 'T52 Coord A', role: 'coordinator', agencyId: A, venueId: VA },
        { id: U('adminB'), email: E('adminB'), name: 'T52 Admin B', role: 'admin', agencyId: B },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'coordA', 'adminB']) await hook('set-password', { userId: U(k), password: PW });
    const tAdminA = await login('adminA'), tCoordA = await login('coordA'), tAdminB = await login('adminB');

    // ---- 1. the route is gone ----
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${tAdminA}`;
    const ws = new WebSocket(wsUrl);
    const seen = [];
    ws.onmessage = (ev) => { try { seen.push(JSON.parse(String(ev.data)).type); } catch {} };
    await new Promise((res) => setTimeout(res, 1500));
    try {
      const v0 = await ctx.getVersion();
      for (const [label, tok] of [['admin', tAdminA], ['coordinator', tCoordA]]) {
        const g = await call('POST', '/api/admin/clean-slate', auth(tok), {});
        assert(g.status === 404, `clean-slate must be 404 for ${label} (removed in 8x), got ${g.status} ${g.text.slice(0, 120)}`);
      }
      await new Promise((res) => setTimeout(res, 1000));
      assert((await ctx.getVersion()) === v0, 'clean-slate (removed) must not write');
      assert(!seen.includes('CLEAN_SLATE_RESET'), 'no CLEAN_SLATE_RESET broadcast');
      const doc = await ctx.getDoc();
      assert((doc.venues || []).some((v) => v.id === VA) && (doc.tasks || []).some((t) => t.id === `task-t52a-${ts}`), 'A data must be untouched');
    } finally {
      try { ws.close(); } catch {}
    }

    // ---- 2. the read side of the stored per-agency flag is kept ----
    const venuesFlag = async (t) => (await call('GET', '/api/venues', auth(t))).json?.isDemoCleared;
    assert((await venuesFlag(tAdminA)) === true && (await venuesFlag(tAdminB)) === false, `per-agency flag: A ${await venuesFlag(tAdminA)}, B ${await venuesFlag(tAdminB)}`);

    // ---- 3. outside test mode: still 404; test hook 404 ----
    if (typeof ctx.restartServer === 'function') {
      const mockHarness = process.env.FIRESTORE_MOCK === 'true' || !process.env.FIRESTORE_EMULATOR_HOST;
      const mode = mockHarness ? 'FIRESTORE_MOCK=true + STAGE2_TEST_MODE=false' : 'real emulator, STAGE2_TEST_MODE=false';
      // CLEAN_SLATE_ENABLED=true too: the old operator switch must open nothing.
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false', CLEAN_SLATE_ENABLED: 'true' });
      try {
        // the admin session is valid in this mode, so a 404 below is route
        // registration, not an auth failure
        const who = await call('GET', '/api/venues', auth(tAdminB));
        assert(who.status === 200, `admin session must be valid with test mode off (${mode}), got ${who.status}`);
        const g = await call('POST', '/api/admin/clean-slate', auth(tAdminB), {});
        assert(g.status === 404, `clean-slate must be 404 (${mode}, CLEAN_SLATE_ENABLED=true), got ${g.status}`);
        const m = await call('POST', '/api/__test__/doc-merge', auth(tAdminB), { fields: { isDemoCleared: true } });
        assert(m.status === 404, `doc-merge must be 404 (${mode}), got ${m.status}`);
      } finally {
        await ctx.restartServer();
      }
      const vb = await call('GET', '/api/venues', auth(tAdminB));
      assert((vb.json?.venues || []).some((v) => v.id === VB) && vb.json?.isDemoCleared === false, 'B changed by the test-mode-off requests');
    }
    return 'clean-slate route gone (admin + coordinator 404, no write, no broadcast, data untouched); stored per-agency cleared flag still read (A true, B false); outside test mode clean-slate 404 and doc-merge 404 with a valid admin session';
  },
};
