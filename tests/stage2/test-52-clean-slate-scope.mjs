/**
 * Test 52 (item 8k, "8k plan v2"): Clean Slate wipes ONE agency, completely,
 * and is gated off outside test mode unless the operator enables it.
 *
 * Proves on the real server and emulator:
 *  1 every A-owned record goes (venues, tasks, history, events, notes,
 *    templates, incidents, announcements, event templates, kiosk devices and
 *    pairings, PIN lockouts, pairing limits, push subscriptions incl. legacy
 *    email-keyed, password resets + email rate buckets, rollover markers);
 *    A's admin is kept; an unattributable pending pairing is kept + counted
 *  2 every B-owned record is byte-identical; B identity projections unchanged
 *  3 A's removed migrated user: people + emails projections retired
 *  4 one commit; a coordinator gets 403; the removed user's token → 401;
 *    A's tablet is unpaired, B's tablet still works
 *  5 GET /api/venues isDemoCleared is per agency (A true, B false) under the
 *    legacy global flag true AND false; the stored global is never written
 *  6 restart: A stays cleared, B boots with its data
 *  7 gate: with STAGE2_TEST_MODE=false and no CLEAN_SLATE_ENABLED, Clean Slate
 *    is 403 CLEAN_SLATE_DISABLED (nothing written) and doc-merge is 404
 */
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 52: Clean Slate is agency-scoped and gated (8k)',
  whatItProves:
    'Clean Slate removes exactly the caller agency (ownership decided on the fresh doc, unattributable records kept and counted), retires removed users identity projections, leaves every other agency byte-identical, reports the cleared state per agency without ever writing the legacy global flag, and is off outside test mode unless the operator enables it.',

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
    const hydrate = async (tag) => hook('inject-fixture', { venues: [{ id: `venue-t52-h${tag}-${ts}`, name: `T52 h${tag}`, agencyId: `agency-t52-scratch-${ts}` }] });
    const ids = (k) => `${k}-t52-${ts}`;

    // ---- fixture: A and B fully seeded ----
    const mk = (ag, v, x) => ({
      venues: [{ id: v, name: `T52 ${x}`, agencyId: ag }],
      tasks: [{ id: ids(`task${x}`), agencyId: ag, venueId: v, title: `T52 task ${x}`, isCompleted: false }],
      historyLogs: [{ id: ids(`hist${x}`), agencyId: ag, venueId: v, date: '2026-10-20', snapshot: [] }],
      events: [{ id: ids(`evt${x}`), agencyId: ag, venueId: v, title: `T52 event ${x}`, location: 'Hall', date: '2026-11-02', tasks: [] }],
      handoffNotes: [{ id: ids(`note${x}`), agencyId: ag, venueId: v, text: 'n', createdAt: new Date().toISOString() }],
      taskTemplates: [{ id: ids(`tpl${x}`), agencyId: ag, title: `T52 tpl ${x}` }],
      incidents: [{ id: ids(`inc${x}`), agencyId: ag, venueId: v, title: 'i', createdAt: new Date().toISOString() }],
      announcements: [{ id: ids(`ann${x}`), agencyId: ag, title: 'a', body: 'b', createdAt: new Date().toISOString() }],
      eventTaskTemplates: [{ id: ids(`etpl${x}`), agencyId: ag, title: `T52 etpl ${x}`, sortOrder: 0 }],
    });
    const fa = mk(A, VA, 'A'), fb = mk(B, VB, 'B');
    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T52 A ${ts}`, shortCode: 'T52A', adminEmail: E('adminA') },
        { id: B, name: `T52 B ${ts}`, shortCode: 'T52B', adminEmail: E('adminB') },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T52 Admin A', role: 'admin', agencyId: A },
        { id: U('coordA'), email: E('coordA'), name: 'T52 Coord A', role: 'coordinator', agencyId: A, venueId: VA },
        { id: U('mashA'), email: E('mashA'), name: 'T52 Mash A', role: 'mashgiach', agencyId: A, venueId: VA, kioskPin: '5252' },
        { id: U('adminB'), email: E('adminB'), name: 'T52 Admin B', role: 'admin', agencyId: B },
        { id: U('mashB'), email: E('mashB'), name: 'T52 Mash B', role: 'mashgiach', agencyId: B, venueId: VB, kioskPin: '6262' },
      ],
      ...Object.fromEntries(Object.keys(fa).map((k) => [k, [...fa[k], ...fb[k]]])),
      venueWorkDates: { [VA]: '2026-10-20', [VB]: '2026-10-20' },
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'coordA', 'mashA', 'adminB', 'mashB']) await hook('set-password', { userId: U(k), password: PW });
    const tAdminA = await login('adminA'), tAdminB = await login('adminB'), tCoordA = await login('coordA'), tMashA = await login('mashA');

    // paired tablets (real pairing flow), one per agency
    const pair = async (token, venueId) => {
      const start = await call('POST', '/api/kiosk/pairing/start', { 'Content-Type': 'application/json' }, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const p = await call('POST', '/api/kiosk/devices/pair', auth(token), { code: start.json.code, venueId });
      assert(p.status === 201, `devices/pair ${p.status} ${p.text.slice(0, 120)}`);
      const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } }).then((x) => x.json());
      assert(st.status === 'approved', `claim ${J(st).slice(0, 120)}`);
      return { header: `${st.device.id}.${start.json.deviceSecret}`, deviceId: st.device.id };
    };
    const devA = await pair(tAdminA, VA), devB = await pair(tAdminB, VB);
    const deviceOk = async (h) => (await fetch(`${baseUrl}/api/kiosk/device`, { headers: { 'X-Kiosk-Device': h } })).status;
    assert((await deviceOk(devA.header)) === 200 && (await deviceOk(devB.header)) === 200, 'tablets paired');

    // keyed structures + push + resets, merged into whatever the doc holds
    {
      const d = await ctx.getDoc();
      const sub = (id, email, agencyId, n) => ({ userEmail: email, ...(id ? { userId: id, agencyId } : {}), endpoint: `https://push.test/${n}-${ts}`, keys: { p256dh: 'p', auth: 'a' }, createdAt: new Date().toISOString() });
      const now = Date.now();
      await hook('doc-merge', { fields: {
        kioskPairings: { ...(d.kioskPairings || {}),
          [ids('kpA')]: { pairingCodeHash: 'x', secretHash: 'y', ip: '1.1.1.1', createdAt: now, expiresAt: now + 600000, status: 'approved', venueId: VA, deviceId: devA.deviceId },
          [ids('kpB')]: { pairingCodeHash: 'x', secretHash: 'y', ip: '1.1.1.2', createdAt: now, expiresAt: now + 600000, status: 'approved', venueId: VB, deviceId: devB.deviceId },
          [ids('kpX')]: { pairingCodeHash: 'x', secretHash: 'y', ip: '1.1.1.3', createdAt: now, expiresAt: now + 600000, status: 'pending' } },
        kioskPinLockouts: { users: { ...((d.kioskPinLockouts || {}).users || {}), [U('mashA')]: { fails: ['2026-10-21T00:00:00Z'] }, [U('mashB')]: { fails: ['2026-10-21T00:00:00Z'] } },
          tablets: { ...((d.kioskPinLockouts || {}).tablets || {}), [`${VA}|9.9.9.1`]: { fails: ['x'] }, [`${VB}|9.9.9.2`]: { fails: ['x'] }, [`garbage-${ts}`]: { fails: ['x'] } } },
        kioskPairingLimits: { ...(d.kioskPairingLimits || {}), [`caller|${U('mashA')}`]: ['x'], [`caller|${U('mashB')}`]: ['x'], [`start|7.7.7.${ts % 200}`]: ['x'] },
        pushSubscriptions: [...(d.pushSubscriptions || []), sub(U('mashA'), E('mashA'), A, 'a1'), sub(null, E('mashA'), null, 'a2'), sub(U('mashB'), E('mashB'), B, 'b1'), sub(null, E('mashB'), null, 'b2')],
        passwordResets: [...(d.passwordResets || []), { email: E('mashA').toLowerCase(), codeHash: 'h', expiresAt: new Date(now + 600000).toISOString(), attempts: 0 }, { email: E('mashB').toLowerCase(), codeHash: 'h', expiresAt: new Date(now + 600000).toISOString(), attempts: 0 }],
        passwordResetRateLimits: { ...(d.passwordResetRateLimits || { emailRequests: {}, ipRequests: {}, ipVerifies: {} }),
          emailRequests: { ...((d.passwordResetRateLimits || {}).emailRequests || {}), [E('mashA').toLowerCase()]: ['x'], [E('mashB').toLowerCase()]: ['x'] } },
      } });
      await hydrate(1);
    }

    // B-owned slices (by our ids/keys) and identity docs, before
    const bSlice = (d) => J({
      venues: (d.venues || []).filter((x) => x.agencyId === B),
      ...Object.fromEntries(['tasks', 'historyLogs', 'events', 'handoffNotes', 'taskTemplates', 'incidents', 'announcements', 'eventTaskTemplates', 'kioskDevices'].map((k) => [k, (d[k] || []).filter((x) => x && x.agencyId === B)])),
      users: (d.users || []).filter((u) => u.agencyId === B),
      kp: (d.kioskPairings || {})[ids('kpB')], kpX: (d.kioskPairings || {})[ids('kpX')],
      lu: ((d.kioskPinLockouts || {}).users || {})[U('mashB')], lt: ((d.kioskPinLockouts || {}).tablets || {})[`${VB}|9.9.9.2`], lg: ((d.kioskPinLockouts || {}).tablets || {})[`garbage-${ts}`],
      lim: (d.kioskPairingLimits || {})[`caller|${U('mashB')}`], limIp: (d.kioskPairingLimits || {})[`start|7.7.7.${ts % 200}`],
      subs: (d.pushSubscriptions || []).filter((s) => (s.userEmail || '').toLowerCase() === E('mashB').toLowerCase()),
      resets: (d.passwordResets || []).filter((x) => x.email === E('mashB').toLowerCase()),
      rl: ((d.passwordResetRateLimits || {}).emailRequests || {})[E('mashB').toLowerCase()],
      wd: (d.venueWorkDates || {})[VB],
    });
    const idDocs = async (k) => (await ctx.api('GET', `/api/__test__/identity-docs?personId=${encodeURIComponent(U(k))}&email=${encodeURIComponent(E(k))}`)).json;
    const before = await ctx.getDoc();
    const bBefore = bSlice(before);
    const idB0 = J(await idDocs('mashB')), idAdminB0 = J(await idDocs('adminB')), idAdminA0 = J(await idDocs('adminA'));
    const idMashA0 = await idDocs('mashA');
    assert(idMashA0.people && idMashA0.people.status !== 'retired' && idMashA0.emails, `precondition: mash A projections active ${J(idMashA0).slice(0, 200)}`);
    const globalBefore = before.isDemoCleared;
    const venuesFlag = async (t) => (await call('GET', '/api/venues', auth(t))).json?.isDemoCleared;
    // legacy global currently as left by earlier tests; make it TRUE for the first round
    await hook('doc-merge', { fields: { isDemoCleared: true } }); await hydrate(2);
    assert((await venuesFlag(tAdminA)) === false && (await venuesFlag(tAdminB)) === false, 'legacy true must not mark any agency cleared');

    // ---- 4a. coordinator refused ----
    assert((await call('POST', '/api/admin/clean-slate', auth(tCoordA), {})).status === 403, 'coordinator must get 403');

    // ---- run ----
    const v0 = await ctx.getVersion();
    const cs = await call('POST', '/api/admin/clean-slate', auth(tAdminA), {});
    assert(cs.status === 200 && cs.json?.success, `clean-slate ${cs.status} ${cs.text.slice(0, 200)}`);
    assert((await ctx.getVersion()) === v0 + 1, 'clean-slate must be one commit');
    assert(cs.json.keptUnattributed?.kioskPairings >= 1 && cs.json.keptUnattributed?.['kioskPinLockouts.tablets'] >= 1, `keptUnattributed ${J(cs.json.keptUnattributed)}`);
    const after = await ctx.getDoc();

    // ---- 1. A gone, A admin kept ----
    const has = (k, id) => (after[k] || []).some((x) => x && x.id === id);
    for (const [k, id] of [['venues', VA], ['tasks', ids('taskA')], ['historyLogs', ids('histA')], ['events', ids('evtA')], ['handoffNotes', ids('noteA')], ['taskTemplates', ids('tplA')], ['incidents', ids('incA')], ['announcements', ids('annA')], ['eventTaskTemplates', ids('etplA')], ['kioskDevices', devA.deviceId]]) {
      assert(!has(k, id), `A ${k} ${id} survived`);
    }
    assert(!(after.users || []).some((u) => u.id === U('mashA') || u.id === U('coordA')), 'A non-admin users survived');
    assert((after.users || []).some((u) => u.id === U('adminA')), 'A admin removed');
    assert(!(after.kioskPairings || {})[ids('kpA')], 'A pairing survived');
    assert(!!(after.kioskPairings || {})[ids('kpX')], 'unattributable pending pairing must be kept');
    assert(!((after.kioskPinLockouts || {}).users || {})[U('mashA')] && !((after.kioskPinLockouts || {}).tablets || {})[`${VA}|9.9.9.1`], 'A lockouts survived');
    assert(!(after.kioskPairingLimits || {})[`caller|${U('mashA')}`], 'A pairing limit survived');
    assert(!(after.pushSubscriptions || []).some((s) => (s.userEmail || '').toLowerCase() === E('mashA').toLowerCase()), 'A push subscriptions (incl legacy) survived');
    assert(!(after.passwordResets || []).some((x) => x.email === E('mashA').toLowerCase()), 'A password reset survived');
    assert(!((after.passwordResetRateLimits || {}).emailRequests || {})[E('mashA').toLowerCase()], 'A email rate bucket survived');
    assert(!(VA in (after.venueWorkDates || {})), 'A rollover marker survived');
    assert(typeof (after.agencies || []).find((a) => a.id === A)?.cleanSlateAt === 'string', 'A cleanSlateAt not set');
    assert(!(after.agencies || []).find((a) => a.id === B)?.cleanSlateAt, 'B got cleanSlateAt');
    assert(after.isDemoCleared === true, 'stored legacy global must be untouched (true)');

    // ---- 2. B byte-identical; identity ----
    assert(bSlice(after) === bBefore, 'agency B data changed');
    assert(J(await idDocs('mashB')) === idB0 && J(await idDocs('adminB')) === idAdminB0, 'B identity projections changed');
    assert(J(await idDocs('adminA')) === idAdminA0, 'kept A admin projections changed');
    const idMashA1 = await idDocs('mashA');
    assert(idMashA1.people?.status === 'retired', `removed user people doc not retired ${J(idMashA1.people)}`);
    assert(idMashA1.emails?.status === 'retired', `removed user emails doc not retired ${J(idMashA1.emails)}`);

    // ---- 4b. sessions and tablets ----
    assert((await call('GET', '/api/users', auth(tMashA))).status === 401, 'removed user token still works');
    assert((await deviceOk(devA.header)) !== 200, 'A tablet still paired');
    assert((await deviceOk(devB.header)) === 200, 'B tablet affected');

    // ---- 5. per-agency flag under legacy true and false ----
    assert((await venuesFlag(tAdminA)) === true && (await venuesFlag(tAdminB)) === false, 'legacy true: A true, B false');
    await hook('doc-merge', { fields: { isDemoCleared: false } }); await hydrate(3);
    assert((await venuesFlag(tAdminA)) === true && (await venuesFlag(tAdminB)) === false, 'legacy false: A true, B false');
    const csB0 = (await ctx.getDoc()).isDemoCleared;
    assert(csB0 === false, 'legacy false seeded');

    // ---- 6 + 7. restart: persists; gate off outside test mode ----
    if (typeof ctx.restartServer === 'function') {
      await ctx.restartServer();
      assert((await venuesFlag(tAdminA)) === true && (await venuesFlag(tAdminB)) === false, 'after restart: A true, B false');
      const vb = await call('GET', '/api/venues', auth(tAdminB));
      assert((vb.json?.venues || []).some((v) => v.id === VB), 'B venue missing after restart');
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        const g = await call('POST', '/api/admin/clean-slate', auth(tAdminB), {});
        assert(g.status === 403 && g.json?.code === 'CLEAN_SLATE_DISABLED', `gate off: ${g.status} ${g.text.slice(0, 120)}`);
        const m = await call('POST', '/api/__test__/doc-merge', auth(tAdminB), { fields: { isDemoCleared: true } });
        assert(m.status === 404, `doc-merge outside test mode must be 404, got ${m.status}`);
      } finally {
        await ctx.restartServer();
      }
      const vb2 = await call('GET', '/api/venues', auth(tAdminB));
      assert((vb2.json?.venues || []).some((v) => v.id === VB) && vb2.json?.isDemoCleared === false, 'gate-off request wrote something');
      assert((await ctx.getDoc()).isDemoCleared === false, 'legacy global changed by the gated request');
    }
    void globalBefore;
    return 'A wiped completely (unattributable kept + counted), B byte-identical, removed user projections retired, one commit, coordinator 403, removed token 401, A tablet unpaired / B fine, per-agency flag under legacy true+false, survives restart, gated off outside test mode (403 + hook 404)';
  },
};
