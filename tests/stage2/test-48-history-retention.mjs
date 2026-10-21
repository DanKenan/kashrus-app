/**
 * Test 48 (item 8r): board history kept for 7 days (Don's decision).
 *
 * Proves on the real server + emulator:
 *  1 a scoped manual reset of venue A1 prunes ONLY A1's history, in the same
 *    commit (version +1): dates >= today-7 kept (venue-local), older removed,
 *    malformed/undated snapshots kept; A2 (same agency) and B1 untouched
 *  2 the retention sweep (rides the rollover tick) prunes every venue by its
 *    own zone (A2 New York, B1 Jerusalem), keeps malformed records, and
 *    sends HISTORY_PRUNED from committed state: agency A's admin socket gets
 *    only agency A history, agency B's only agency B history
 *    (a legacy snapshot without agencyId is attributed to its venue's agency,
 *    so that agency's clients hear the prune)
 *  3 a second sweep within the hour does nothing; after the gate reopens a
 *    clean sweep is a version-neutral no-op (nothing broadcast)
 *  4 the gate hook is registered only in test mode: with STAGE2_TEST_MODE=false
 *    it is 8t's explicit 404, on the harness's own persistence. In the mock
 *    harness that run is exactly FIRESTORE_MOCK=true + STAGE2_TEST_MODE=false
 *    (the old FIRESTORE_MOCK||isTestMode block is entered, the hook is not).
 *    The persistence is kept so the suite's admin token stays valid; a
 *    swap to an empty mock store would answer 401 from the auth middleware,
 *    which proves nothing about the route.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const dayIn = (tz, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      ws, messages,
      waitFor: async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); } return null; },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

export default {
  name: 'Test 48: board history kept for 7 days (8r)',
  whatItProves:
    'History older than 7 venue-local days is removed inside the reset commit for exactly the reset venues and by an hourly sweep for every venue; malformed records are kept; broadcasts come from committed state and never cross agencies; clean sweeps write nothing.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t48-a-${ts}`, B = `agency-t48-b-${ts}`;
    const A1 = `venue-t48-a1-${ts}`, A2 = `venue-t48-a2-${ts}`, B1 = `venue-t48-b1-${ts}`;
    const C = `agency-t48-c-${ts}`, C1 = `venue-t48-c1-${ts}`;
    const NY = 'America/New_York', JER = 'Asia/Jerusalem';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const mint = async (userId) => {
      const r = await call('POST', '/api/__test__/mint-token', { 'Content-Type': 'application/json' }, { userId });
      assert(r.status === 200, `mint-token ${r.status}`);
      return r.json.token;
    };
    // Pin the clock so the background interval stays out of the way. Not "now":
    // a fresh venue's marker is the legacy NY workday, so from Jerusalem
    // midnight until NY midnight (21:00-04:00 UTC in summer) B1 would already be
    // due for a rollover, and the tick's reset would prune it before the sweep
    // (CI #92 at 21:00Z: "sweep removed 6"). Noon UTC of the NY workday is the
    // same calendar date in New York and Jerusalem, so only the sweep runs.
    const nowMs = Date.parse(`${dayIn(NY, ts)}T12:00:00.000Z`);
    let r = await ctx.api('POST', '/api/__test__/clock', { iso: new Date(nowMs).toISOString() });
    assert(r.status === 200, `clock ${r.status}`);
    let conns = [];
    try {
      const snap = (venueId, agencyId, date, k) => ({
        id: `hist-t48-${venueId}-${k}`, agencyId, venueId, date, totalTasks: 1, completedTasks: 1, completionRate: 100, entries: [],
      });
      const days = (venueId, agencyId, tz) => {
        const today = dayIn(tz, nowMs);
        return Array.from({ length: 12 }, (_, i) => snap(venueId, agencyId, addDays(today, -(i + 1)), `d${i + 1}`));
      };
      const malformed = [
        { ...snap(A1, A, '', 'm1') }, { ...snap(A1, A, '2026-13-40', 'm2') }, { ...snap(A1, A, 'yesterday', 'm3') },
        (() => { const x = snap(A1, A, 'x', 'm4'); delete x.date; return x; })(),
      ];
      r = await ctx.api('POST', '/api/__test__/inject-fixture', {
        agencies: [{ id: A, name: `T48 A ${ts}`, timeZone: NY }, { id: B, name: `T48 B ${ts}`, timeZone: JER }, { id: C, name: `T48 C ${ts}`, timeZone: NY }],
        venues: [{ id: A1, name: 'T48 A1', agencyId: A }, { id: A2, name: 'T48 A2', agencyId: A }, { id: B1, name: 'T48 B1', agencyId: B }, { id: C1, name: 'T48 C1', agencyId: C }],
        users: [
          { id: `user-t48-admina-${ts}`, email: `t48-admina-${ts}@test.local`, name: 'T48 Admin A', role: 'admin', agencyId: A },
          { id: `user-t48-adminb-${ts}`, email: `t48-adminb-${ts}@test.local`, name: 'T48 Admin B', role: 'admin', agencyId: B },
          { id: `user-t48-adminc-${ts}`, email: `t48-adminc-${ts}@test.local`, name: 'T48 Admin C', role: 'admin', agencyId: C },
        ],
        historyLogs: [
          ...days(A1, A, NY), ...days(A2, A, NY), ...days(B1, B, JER), ...malformed,
          // legacy snapshots WITHOUT agencyId at agency C's venue: one expired, one fresh
          (() => { const x = snap(C1, C, addDays(dayIn(NY, nowMs), -20), 'legacy-old'); delete x.agencyId; return x; })(),
          (() => { const x = snap(C1, C, addDays(dayIn(NY, nowMs), -1), 'legacy-new'); delete x.agencyId; return x; })(),
        ],
      });
      assert(r.status === 200, `inject ${r.status}`);
      const forVenue = (doc, v) => (doc.historyLogs || []).filter((h) => h && h.venueId === v);
      const ids = (list) => list.map((h) => h.id).sort();
      const tokA = await mint(`user-t48-admina-${ts}`), tokB = await mint(`user-t48-adminb-${ts}`), tokC = await mint(`user-t48-adminc-${ts}`);

      // ---- 1. scoped manual reset of A1 prunes only A1, same commit ----
      let doc0 = await ctx.getDoc();
      const a2Before = ids(forVenue(doc0, A2)), b1Before = ids(forVenue(doc0, B1));
      let v0 = await ctx.getVersion();
      r = await call('POST', '/api/reset-daily', auth(tokA), { venueId: A1 });
      assert(r.status === 200, `reset-daily ${r.status} ${r.text}`);
      assert((await ctx.getVersion()) === v0 + 1, 'reset + prune must be ONE commit');
      let doc = await ctx.getDoc();
      const todayNY = dayIn(NY, nowMs), cutNY = addDays(todayNY, -7);
      const a1 = forVenue(doc, A1);
      const a1Dated = a1.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date || '') && !h.id.includes('-m'));
      assert(a1Dated.every((h) => h.date >= cutNY), `A1 kept an expired snapshot: ${a1Dated.map((h) => h.date)}`);
      for (let i = 1; i <= 7; i++) assert(a1.some((h) => h.id === `hist-t48-${A1}-d${i}`), `A1 lost day -${i}`);
      for (let i = 8; i <= 12; i++) assert(!a1.some((h) => h.id === `hist-t48-${A1}-d${i}`), `A1 kept day -${i}`);
      for (const k of ['m1', 'm2', 'm3', 'm4']) assert(a1.some((h) => h.id === `hist-t48-${A1}-${k}`), `malformed ${k} removed`);
      assert(a1.some((h) => !h.id.startsWith('hist-t48-')), 'the reset snapshot itself must be there');
      assert(JSON.stringify(ids(forVenue(doc, A2))) === JSON.stringify(a2Before), 'A2 touched by a scoped reset');
      assert(JSON.stringify(ids(forVenue(doc, B1))) === JSON.stringify(b1Before), 'B1 touched by agency A reset');

      // ---- 2. the sweep prunes every venue by its own zone; broadcasts are agency-scoped ----
      const wsA = await connectWs(baseUrl, tokA), wsB = await connectWs(baseUrl, tokB), wsC = await connectWs(baseUrl, tokC);
      conns = [wsA, wsB, wsC];
      await ctx.api('POST', '/api/__test__/history-retention-gate', {});
      r = await ctx.api('POST', '/api/__test__/rollover-tick', {});
      assert(r.status === 200, `tick ${r.status} ${JSON.stringify(r.json)}`);
      assert((r.json.historyRemoved || 0) >= 10, `sweep removed ${r.json.historyRemoved}`);
      doc = await ctx.getDoc();
      const todayJ = dayIn(JER, nowMs), cutJ = addDays(todayJ, -7);
      const a2 = forVenue(doc, A2), b1 = forVenue(doc, B1);
      assert(a2.length === 7 && a2.every((h) => h.date >= cutNY), `A2 after sweep ${a2.map((h) => h.date)}`);
      assert(b1.length === 7 && b1.every((h) => h.date >= cutJ), `B1 after sweep (Jerusalem) ${b1.map((h) => h.date)}`);
      for (const k of ['m1', 'm2', 'm3', 'm4']) assert(forVenue(doc, A1).some((h) => h.id === `hist-t48-${A1}-${k}`), `sweep removed malformed ${k}`);
      const pa = await wsA.waitFor((m) => m.type === 'HISTORY_PRUNED');
      const pb = await wsB.waitFor((m) => m.type === 'HISTORY_PRUNED');
      assert(pa && Array.isArray(pa.payload?.historyLogs), 'agency A admin got no HISTORY_PRUNED');
      assert(pb && Array.isArray(pb.payload?.historyLogs), 'agency B admin got no HISTORY_PRUNED');
      assert(pa.payload.historyLogs.every((h) => (h.agencyId || 'agency-hkc') === A), 'cross-agency history in A broadcast');
      assert(pb.payload.historyLogs.every((h) => (h.agencyId || 'agency-hkc') === B), 'cross-agency history in B broadcast');
      assert(pa.payload.historyLogs.filter((h) => h.venueId === A2).length === 7, 'A broadcast is not the committed list');
      // a legacy snapshot without agencyId is attributed to its VENUE's agency (C)
      const c1 = forVenue(await ctx.getDoc(), C1).map((h) => h.id);
      assert(!c1.includes(`hist-t48-${C1}-legacy-old`) && c1.includes(`hist-t48-${C1}-legacy-new`), `C1 legacy prune ${c1}`);
      const pc = await wsC.waitFor((m) => m.type === 'HISTORY_PRUNED');
      assert(pc && Array.isArray(pc.payload?.historyLogs), 'agency C admin got no HISTORY_PRUNED for its legacy (agencyId-less) snapshot');
      assert(!pc.payload.historyLogs.some((h) => h.id === `hist-t48-${C1}-legacy-old`), 'C broadcast still lists the removed snapshot');
      assert(Object.keys(pa.payload).join() === 'historyLogs', `HISTORY_PRUNED carries extra keys: ${Object.keys(pa.payload)}`);

      // ---- 3. within the hour: nothing; after the gate: clean no-op ----
      v0 = await ctx.getVersion();
      r = await ctx.api('POST', '/api/__test__/rollover-tick', {});
      assert(r.status === 200 && !r.json.historyRemoved, `second sweep within the hour ran: ${JSON.stringify(r.json)}`);
      await ctx.api('POST', '/api/__test__/history-retention-gate', {});
      const before = wsA.messages.length;
      r = await ctx.api('POST', '/api/__test__/rollover-tick', {});
      assert(r.status === 200 && r.json.historyRemoved === 0, `clean sweep ${JSON.stringify(r.json)}`);
      assert((await ctx.getVersion()) === v0, 'a clean sweep must not bump the version');
      await sleep(500);
      assert(!wsA.messages.slice(before).some((m) => m.type === 'HISTORY_PRUNED'), 'a clean sweep broadcast HISTORY_PRUNED');
    } finally {
      for (const c of conns) c.close();
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
    }

    // ---- 4. the gate hook exists ONLY in test mode: 404 outside it ----
    // Same persistence as the rest of the suite (mock harness: FIRESTORE_MOCK=true
    // already, so this is the mock-alone case; real emulator: test mode off).
    if (typeof ctx.restartServer === 'function') {
      const mockHarness = process.env.FIRESTORE_MOCK === 'true' || !process.env.FIRESTORE_EMULATOR_HOST;
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        const g = await fetch(`${baseUrl}/api/__test__/history-retention-gate`, { method: 'POST', headers: ctx.authHeaders, body: '{}' });
        assert(g.status === 404, `history-retention-gate must be 404 with STAGE2_TEST_MODE=false (${mockHarness ? 'FIRESTORE_MOCK=true' : 'real emulator'}), got ${g.status}`);
      } finally {
        await ctx.restartServer();
      }
      const back = await ctx.api('POST', '/api/__test__/history-retention-gate', {});
      assert(back.status === 200, `gate hook back in test mode: ${back.status}`);
    }
  },
};
