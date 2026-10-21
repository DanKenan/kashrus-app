/**
 * Test 53 (item 9a, "9a plan v2"): one person, several venues of ONE agency.
 *
 * Proves on the real server and emulator:
 *  1 before any grant a coordinator sees only the home venue; login payload
 *    myVenueIds = [home]; a stored home venue that belongs to ANOTHER agency
 *    grants nothing (no tasks, no shared-venue PIN authority)
 *  2 PUT /api/users/:id/venues (admin, fresh caller + target, audited) grants
 *    V2: login myVenueIds = [V1, V2]; GET /api/tasks?venueId=V2 returns V2's
 *    tasks; no venue → home; V3 and another agency's venue → nothing;
 *    GET /api/venues = V1+V2; GET /api/users?venueId=V2 = V2's people
 *  3 roster records never carry myVenueIds or venueAccess
 *  4 coordinator PIN/phone only through a SHARED venue (V2 person ok, V3 403);
 *    a kiosk tablet stays its own venue for a multi-venue person (PIN login
 *    only once granted; tasks/venues = the tablet's venue; revoke refuses)
 *  5 refusals: another agency's venue 400, another agency's admin 404, a
 *    coordinator 403, an admin target 400, a stale expectedVenueIds 409,
 *    a raw venueAccess body field changes nothing
 *  6 an unrelated commit + a restart keep the grant (identity invariant)
 *  7 deleting V2 prunes the grant in the same commit; a home-venue change
 *    without a list resets access to the new home (never expands)
 *  8 (9a2) team records carry `venueIds` (the sanitized scope) ONLY for an
 *    admin of the same agency (roster + PUT response); admin targets get
 *    none; coordinator, mashgiach, kiosk and another agency's admin never
 *    see it (REST + WS INITIAL_STATE/USERS_UPDATED);
 *    after deletion / home change the admin view follows the stored scope
 */
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 53: multi-venue access within one agency (9a)',
  whatItProves:
    'An admin can grant a person extra venues of the same agency through one audited, freshly re-authorized server path; the grant drives task, venue and roster reads, survives unrelated commits and restarts, never crosses agencies, never leaks to other people, and is pruned when a venue is deleted.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t53a-${ts}`, B = `agency-t53b-${ts}`;
    const V1 = `venue-t53-1-${ts}`, V2 = `venue-t53-2-${ts}`, V3 = `venue-t53-3-${ts}`, VB = `venue-t53-b-${ts}`;
    const U = (k) => `user-t53-${k}-${ts}`;
    const E = (k) => `t53-${k}-${ts}@test.local`;
    const PW = 'stage2-t53-password';
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
    const loginFull = async (k) => {
      const r = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E(k), password: PW });
      assert(r.status === 200 && r.json?.token, `login ${k} ${r.status} ${r.text.slice(0, 160)}`);
      return r.json;
    };
    const write = async (method, path, token, body) => call(method, path, auth(token), { ...body, expectedVersion: await ctx.getVersion() });
    const docUser = async (id) => ((await ctx.getDoc()).users || []).find((u) => u.id === id);
    const task = (id, ag, v) => ({ id, agencyId: ag, venueId: v, title: `T53 ${id}`, isCompleted: false, inputType: 'toggle', category: 'General', createdAt: new Date().toISOString() });

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T53 A ${ts}`, shortCode: 'T53A', adminEmail: E('adminA') },
        { id: B, name: `T53 B ${ts}`, shortCode: 'T53B', adminEmail: E('adminB') },
      ],
      venues: [
        { id: V1, name: 'T53 V1', agencyId: A }, { id: V2, name: 'T53 V2', agencyId: A },
        { id: V3, name: 'T53 V3', agencyId: A }, { id: VB, name: 'T53 VB', agencyId: B },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T53 Admin A', role: 'admin', agencyId: A },
        { id: U('coord'), email: E('coord'), name: 'T53 Coord', role: 'coordinator', agencyId: A, venueId: V1 },
        { id: U('mash2'), email: E('mash2'), name: 'T53 Mash V2', role: 'mashgiach', agencyId: A, venueId: V2 },
        { id: U('mash3'), email: E('mash3'), name: 'T53 Mash V3', role: 'mashgiach', agencyId: A, venueId: V3 },
        { id: U('adminB'), email: E('adminB'), name: 'T53 Admin B', role: 'admin', agencyId: B },
        // malformed: agency-A people whose stored home venue is agency B's
        { id: U('coordX'), email: E('coordX'), name: 'T53 Coord X', role: 'coordinator', agencyId: A, venueId: VB },
        { id: U('mashX'), email: E('mashX'), name: 'T53 Mash X', role: 'mashgiach', agencyId: A, venueId: VB },
      ],
      tasks: [task(`task-t53-1-${ts}`, A, V1), task(`task-t53-2-${ts}`, A, V2), task(`task-t53-3-${ts}`, A, V3), task(`task-t53-b-${ts}`, B, VB)],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'coord', 'mash2', 'mash3', 'adminB', 'coordX']) await hook('set-password', { userId: U(k), password: PW });
    const tAdminA = (await loginFull('adminA')).token, tAdminB = (await loginFull('adminB')).token;
    let coordLogin = await loginFull('coord');
    let tCoord = coordLogin.token;
    const tasksAt = async (token, v) => call('GET', `/api/tasks${v ? `?venueId=${encodeURIComponent(v)}` : ''}`, auth(token));
    const taskIds = (res) => (res.json?.tasks || []).map((t) => t.id);

    // 1 before: home only
    assert(J(coordLogin.user?.myVenueIds) === J([V1]), `myVenueIds before ${J(coordLogin.user?.myVenueIds)}`);
    r = await tasksAt(tCoord, V2);
    assert(r.status === 200 && taskIds(r).length === 0 && r.json.venueId === null, `V2 before grant ${r.status} ${J(r.json).slice(0, 160)}`);
    assert((await docUser(U('coord')))?.personId === U('coord'), 'fixture rows are migrated (personId)');

    // 1b a home venue that exists in ANOTHER agency grants nothing
    {
      const lx = await loginFull('coordX');
      assert(J(lx.user?.myVenueIds) === J([]), `foreign home myVenueIds ${J(lx.user?.myVenueIds)}`);
      let x = await tasksAt(lx.token, VB);
      assert(taskIds(x).length === 0, `foreign home tasks ${J(x.json).slice(0, 160)}`);
      x = await tasksAt(lx.token, null);
      assert(!taskIds(x).includes(`task-t53-b-${ts}`), `foreign home default tasks ${J(x.json).slice(0, 160)}`);
      x = await write('PUT', `/api/users/${U('mashX')}`, lx.token, { kioskPin: '5359' });
      assert(x.status === 403, `two A users on B's venue share nothing: PIN ${x.status}`);
    }

    // 5 refusals first (nothing written)
    const coordBefore = J((await docUser(U('coord'))).venueAccess);
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminA, { venueIds: [VB] });
    assert(r.status === 400 && r.json?.code === 'VENUE_NOT_IN_AGENCY', `foreign venue ${r.status} ${r.text.slice(0, 160)}`);
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminB, { venueIds: [VB] });
    assert(r.status === 404, `other agency admin ${r.status}`);
    r = await write('PUT', `/api/users/${U('mash2')}/venues`, tCoord, { venueIds: [V1] });
    assert(r.status === 403, `coordinator grant ${r.status}`);
    r = await write('PUT', `/api/users/${U('adminA')}/venues`, tAdminA, { venueIds: [V2] });
    assert(r.status === 400 && r.json?.code === 'TARGET_IS_ADMIN', `admin target ${r.status} ${r.text.slice(0, 160)}`);
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminA, { venueIds: 'all' });
    assert(r.status === 400, `malformed venueIds ${r.status}`);
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminA, { venueIds: [V2], expectedVenueIds: [V1, V3] });
    assert(r.status === 409 && r.json?.code === 'VENUES_CHANGED', `stale expected ${r.status} ${r.text.slice(0, 160)}`);
    assert(J((await docUser(U('coord'))).venueAccess) === coordBefore, 'refusals wrote nothing');

    // 2 grant V2
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminA, { venueIds: [V2], expectedVenueIds: [V1] });
    assert(r.status === 200 && J(r.json?.venueIds) === J([V1, V2]), `grant ${r.status} ${r.text.slice(0, 200)}`);
    assert(J((await docUser(U('coord'))).venueAccess) === J([V1, V2]), `stored ${J((await docUser(U('coord'))).venueAccess)}`);
    coordLogin = await loginFull('coord'); tCoord = coordLogin.token;
    assert(J(coordLogin.user?.myVenueIds) === J([V1, V2]), `myVenueIds after ${J(coordLogin.user?.myVenueIds)}`);
    assert(coordLogin.user?.venueAccess === undefined && coordLogin.user?.personId === undefined, 'own payload carries no server-only field');
    const checkReads = async (label) => {
      let x = await tasksAt(tCoord, V2);
      assert(x.status === 200 && x.json.venueId === V2 && J(taskIds(x)) === J([`task-t53-2-${ts}`]), `${label}: V2 tasks ${J(x.json).slice(0, 200)}`);
      x = await tasksAt(tCoord, null);
      assert(x.json.venueId === V1 && J(taskIds(x)) === J([`task-t53-1-${ts}`]), `${label}: default = home ${J(x.json).slice(0, 200)}`);
      x = await tasksAt(tCoord, V3);
      assert(taskIds(x).length === 0 && x.json.venueId === null, `${label}: V3 nothing`);
      x = await tasksAt(tCoord, VB);
      assert(taskIds(x).length === 0 && x.json.venueId === null, `${label}: other agency nothing`);
      x = await call('GET', '/api/venues', auth(tCoord));
      const vids = (x.json?.venues || x.json || []).map((v) => v.id).sort();
      assert(J(vids) === J([V1, V2].sort()), `${label}: venues ${J(vids)}`);
    };
    await checkReads('after grant');
    r = await call('GET', `/api/users?venueId=${V2}`, auth(tCoord));
    const rosterIds = (r.json?.users || []).map((u) => u.id);
    assert(rosterIds.includes(U('mash2')) && !rosterIds.includes(U('mash3')), `roster V2 ${J(rosterIds)}`);
    // 3 roster never carries the lists
    for (const tok of [tCoord, tAdminA]) {
      const rr = await call('GET', '/api/users', auth(tok));
      for (const u of rr.json?.users || []) assert(u.myVenueIds === undefined && u.venueAccess === undefined && u.personId === undefined, `roster leak ${J(u).slice(0, 160)}`);
    }

    // 8 (9a2) venueIds: ONLY a same-agency admin sees each person's sanitized scope
    const rosterOf = async (tok) => {
      const rr = await call('GET', '/api/users', auth(tok));
      assert(rr.status === 200, `roster ${rr.status}`);
      return rr.json?.users || [];
    };
    const venueIdsSeenBy = async (tok) => Object.fromEntries((await rosterOf(tok)).map((u) => [u.id, u.venueIds]));
    {
      const seen = await venueIdsSeenBy(tAdminA);
      assert(J(seen[U('coord')]) === J([V1, V2]), `9a2 admin sees coord ${J(seen[U('coord')])}`);
      assert(J(seen[U('mash2')]) === J([V2]), `9a2 admin sees mash2 ${J(seen[U('mash2')])}`);
      assert(J(seen[U('mash3')]) === J([V3]), `9a2 admin sees mash3 ${J(seen[U('mash3')])}`);
      assert(J(seen[U('coordX')]) === J([]) && J(seen[U('mashX')]) === J([]), `9a2 foreign home = no venues ${J(seen[U('coordX')])} ${J(seen[U('mashX')])}`);
      assert(U('adminA') in seen && seen[U('adminA')] === undefined, `9a2 admin target has no venueIds ${J(seen[U('adminA')])}`);
      const tMash2 = (await loginFull('mash2')).token;
      for (const [label, tok] of [['coordinator', tCoord], ['mashgiach', tMash2]]) {
        const users = await rosterOf(tok);
        assert(users.length > 0, `9a2 ${label} roster not empty`);
        for (const u of users) assert(u.venueIds === undefined, `9a2 ${label} must not see venueIds ${J(u).slice(0, 160)}`);
      }
      const bUsers = await rosterOf(tAdminB);
      for (const u of bUsers) {
        assert(!String(u.id).startsWith('user-t53-') || u.id === U('adminB'), `9a2 other-agency admin sees agency A person ${u.id}`);
        assert(!(u.venueIds || []).some((v) => [V1, V2, V3].includes(v)), `9a2 other-agency admin sees A venues ${J(u).slice(0, 160)}`);
      }
      // WS: a recipient-filtered USERS_UPDATED carries venueIds to the same-agency admin only
      {
        const connectWs = (tok) => new Promise((resolve, reject) => {
          const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${tok}`);
          const conn = { ws, messages: [] };
          const timer = setTimeout(() => reject(new Error('9a2 WS connect timeout')), 10000);
          ws.onmessage = (ev) => { try { conn.messages.push(JSON.parse(String(ev.data))); } catch {} if (conn.messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); } };
          ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`9a2 WS error ${e?.message || ''}`)); };
        });
        const waitType = async (conn, type, ms = 15000) => {
          const t0 = Date.now();
          for (;;) { const hit = conn.messages.find((m) => m.type === type); if (hit) return hit; if (Date.now() - t0 > ms) return null; await new Promise((res) => setTimeout(res, 200)); }
        };
        const conns = { admin: await connectWs(tAdminA), coord: await connectWs(tCoord), mash: await connectWs(tMash2), adminB: await connectWs(tAdminB) };
        try {
          const init = conns.admin.messages.find((m) => m.type === 'INITIAL_STATE');
          const initMash2 = (init?.payload?.users || []).find((u) => u.id === U('mash2'));
          assert(initMash2 && J(initMash2.venueIds) === J([V2]), `9a2 admin INITIAL_STATE venueIds ${J(initMash2).slice(0, 160)}`);
          for (const k of ['coord', 'mash']) {
            const i = conns[k].messages.find((m) => m.type === 'INITIAL_STATE');
            for (const u of i?.payload?.users || []) assert(u.venueIds === undefined, `9a2 ${k} INITIAL_STATE must not carry venueIds ${J(u).slice(0, 160)}`);
          }
          for (const c of Object.values(conns)) c.messages.length = 0;
          const ru = await write('PUT', `/api/users/${U('mash2')}`, tAdminA, { name: 'T53 Mash2 (9a2)' });
          assert(ru.status === 200, `9a2 rename mash2 ${ru.status} ${ru.text.slice(0, 160)}`);
          const ua = await waitType(conns.admin, 'USERS_UPDATED');
          assert(ua, '9a2 admin got no USERS_UPDATED');
          const am = (ua.payload?.users || []).find((u) => u.id === U('mash2'));
          assert(am && J(am.venueIds) === J([V2]) && J((ua.payload.users.find((u) => u.id === U('coord')) || {}).venueIds) === J([V1, V2]), `9a2 admin USERS_UPDATED venueIds ${J(am).slice(0, 160)}`);
          assert((ua.payload.users.find((u) => u.id === U('adminA')) || {}).venueIds === undefined, '9a2 admin target in WS has no venueIds');
          for (const k of ['coord', 'mash']) {
            const uu = await waitType(conns[k], 'USERS_UPDATED');
            assert(uu, `9a2 ${k} got no USERS_UPDATED`);
            for (const u of uu.payload?.users || []) assert(u.venueIds === undefined, `9a2 ${k} USERS_UPDATED must not carry venueIds ${J(u).slice(0, 160)}`);
          }
          await new Promise((res) => setTimeout(res, 1000));
          for (const m of conns.adminB.messages) assert(!J(m).includes(V1) && !J(m).includes(V2) && !J(m).includes(U('mash2')), `9a2 other-agency admin WS saw agency A data ${J(m).slice(0, 160)}`);
        } finally {
          for (const c of Object.values(conns)) { try { c.ws.close(); } catch {} }
        }
      }
    }

    // 4 coordinator PIN/phone through a shared venue only
    r = await write('PUT', `/api/users/${U('mash2')}`, tCoord, { kioskPin: '5353' });
    assert(r.status === 200, `PIN at shared V2 ${r.status} ${r.text.slice(0, 160)}`);
    assert(r.json?.user && r.json.user.venueIds === undefined, `9a2 coordinator PUT response has no venueIds ${J(r.json?.user).slice(0, 160)}`);
    r = await write('PUT', `/api/users/${U('mash3')}`, tCoord, { kioskPin: '5354' });
    assert(r.status === 403, `PIN at V3 ${r.status}`);
    r = await write('PUT', `/api/users/${U('mash2')}`, tCoord, { kioskPin: '5355', role: 'coordinator' });
    assert(r.status === 403, `coordinator role change ${r.status}`);

    // 4b kiosk: a tablet is its venue only, even for a multi-venue person
    {
      const start = await call('POST', '/api/kiosk/pairing/start', { 'Content-Type': 'application/json' }, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const p = await call('POST', '/api/kiosk/devices/pair', auth(tAdminA), { code: start.json.code, venueId: V2 });
      assert(p.status === 201, `devices/pair ${p.status} ${p.text.slice(0, 120)}`);
      const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } }).then((x) => x.json());
      assert(st.status === 'approved', `claim ${J(st).slice(0, 120)}`);
      const dev = `${st.device.id}.${start.json.deviceSecret}`;
      r = await write('PUT', `/api/users/${U('mash3')}`, tAdminA, { kioskPin: '5357' });
      assert(r.status === 200, `admin PIN mash3 ${r.status} ${r.text.slice(0, 120)}`);
      const kLogin = async () => call('POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev }, { userId: U('mash3'), pin: '5357' });
      r = await kLogin();
      assert(r.status !== 200, `V3 person at V2 tablet before grant must fail, got ${r.status}`);
      r = await write('PUT', `/api/users/${U('mash3')}/venues`, tAdminA, { venueIds: [V2] });
      assert(r.status === 200 && J(r.json?.venueIds) === J([V3, V2]), `grant mash3 V2 ${r.status} ${r.text.slice(0, 160)}`);
      r = await kLogin();
      assert(r.status === 200 && r.json?.token, `V2 tablet after grant ${r.status} ${r.text.slice(0, 160)}`);
      assert(r.json.user?.venueId === V2 && r.json.user?.myVenueIds === undefined && r.json.user?.venueAccess === undefined, `kiosk payload ${J(r.json.user).slice(0, 200)}`);
      const kh = { ...auth(r.json.token), 'X-Kiosk-Device': dev };
      {
        const kr = await call('GET', '/api/users', kh);
        assert(kr.status === 200 && (kr.json?.users || []).length > 0 && (kr.json.users).every((u) => u.venueIds === undefined), `9a2 kiosk roster must not carry venueIds ${kr.status} ${J(kr.json).slice(0, 160)}`);
      }
      let x = await call('GET', '/api/tasks', kh);
      assert(x.status === 200 && x.json.venueId === V2 && J(taskIds(x)) === J([`task-t53-2-${ts}`]), `kiosk tasks ${x.status} ${J(x.json).slice(0, 200)}`);
      x = await call('GET', `/api/tasks?venueId=${V3}`, kh);
      assert(taskIds(x).length === 0, `kiosk V3 tasks must be empty ${J(x.json).slice(0, 160)}`);
      x = await call('GET', '/api/venues', kh);
      const kv = (x.json?.venues || x.json || []).map((v) => v.id);
      assert(J(kv) === J([V2]), `kiosk venues ${J(kv)}`);
      r = await write('PUT', `/api/users/${U('mash3')}/venues`, tAdminA, { venueIds: [] });
      assert(r.status === 200 && J(r.json?.venueIds) === J([V3]), `revoke mash3 ${r.status} ${r.text.slice(0, 160)}`);
      r = await kLogin();
      assert(r.status !== 200, `after revoke the V2 tablet refuses the V3 person, got ${r.status}`);
    }

    // 5 raw venueAccess in an ordinary edit changes nothing; 6 unrelated commit keeps the grant
    r = await write('PUT', `/api/users/${U('coord')}`, tAdminA, { name: 'T53 Coord renamed', venueAccess: [V1, V2, V3, VB] });
    assert(r.status === 200, `rename ${r.status} ${r.text.slice(0, 160)}`);
    assert(J(r.json?.user?.venueIds) === J([V1, V2]), `9a2 admin PUT response venueIds ${J(r.json?.user?.venueIds)}`);
    assert(J((await docUser(U('coord'))).venueAccess) === J([V1, V2]), `after rename ${J((await docUser(U('coord'))).venueAccess)}`);
    await ctx.restartServer();
    coordLogin = await loginFull('coord'); tCoord = coordLogin.token;
    assert(J(coordLogin.user?.myVenueIds) === J([V1, V2]), `myVenueIds after restart ${J(coordLogin.user?.myVenueIds)}`);
    await checkReads('after restart');

    // 7 venue deletion prunes; home change without a list resets
    r = await write('DELETE', `/api/venues/${V2}`, tAdminA, {});
    assert(r.status === 200, `delete V2 ${r.status} ${r.text.slice(0, 160)}`);
    assert(J((await docUser(U('coord'))).venueAccess) === J([V1]), `pruned ${J((await docUser(U('coord'))).venueAccess)}`);
    r = await write('PUT', `/api/users/${U('coord')}/venues`, tAdminA, { venueIds: [V3] });
    assert(r.status === 200 && J(r.json?.venueIds) === J([V1, V3]), `grant V3 ${r.status} ${r.text.slice(0, 160)}`);
    r = await write('PUT', `/api/users/${U('coord')}`, tAdminA, { venueId: V3 });
    assert(r.status === 200, `move home ${r.status} ${r.text.slice(0, 160)}`);
    assert(J((await docUser(U('coord'))).venueAccess) === J([V3]), `home change resets ${J((await docUser(U('coord'))).venueAccess)}`);
    {
      const seen = await venueIdsSeenBy(tAdminA);
      assert(J(seen[U('coord')]) === J([V3]), `9a2 admin view after home change ${J(seen[U('coord')])}`);
      // a deleted venue is never an EXTRA venue for anyone (9a keeps a removed
      // HOME id as that person's own scope, so mash2 alone may still show it)
      assert(Object.entries(seen).every(([id, v]) => id === U('mash2') || !(v || []).includes(V2)), `9a2 deleted V2 only as mash2's own home ${J(seen)}`);
      assert(J(seen[U('mash2')]) === J([V2]), `9a2 removed home stays the person's own scope (9a rule) ${J(seen[U('mash2')])}`);
    }
    // B untouched throughout
    const bAdmin = await docUser(U('adminB'));
    assert(bAdmin && bAdmin.agencyId === B, 'agency B intact');
  },
};
