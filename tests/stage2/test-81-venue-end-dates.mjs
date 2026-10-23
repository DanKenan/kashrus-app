/**
 * Test 81 (item 12, 12a-s, plan v6): per-venue end dates and the expiry core.
 *  A venue-ops refusals + role rules (Don Oct 22 9:42/9:44 PM): admin any
 *    venue; owner/coordinator only their own venues, mashgichim/workers only,
 *    an end date required for a cross-venue loan; main venue locked; venueRev
 *    precondition; malformed/past/far dates; another agency 404; kiosk 403
 *  B a dated grant at the boundary (sweep DISABLED): until-1 ms works; at
 *    until the phone API, the kiosk (HTTP 401 KIOSK_SESSION_ENDED, socket gets
 *    KIOSK_SESSION_ENDED + 4401, device still paired), kiosk login and the
 *    device list all refuse; the phone socket gets SCOPE_CHANGED once
 *  C the sweep closes the grant into history, notifies; a second sweep writes
 *    nothing (no version bump); both race serializations
 *  D legacy PUT from a stale tab: 409 on a dated row without expectedVenueIds;
 *    kept venues keep their dates; a legacy row is written exactly as before
 *  E malformed metadata denies, the sweep closes it as invalid_data and
 *    removes it from venueAccess; survives a restart
 *  F freshness: STALE after 60 s on the MONOTONIC clock denies every extra
 *    (home kept), venue-ops 503, one SCOPE_CHANGED per transition, recovery
 *    restores; a backward wall-clock jump does not postpone it; hung and
 *    failed reads never confirm; a discarded older document never renews
 *  G noHomeVenue: survives restart + hydrate, sign-in with an empty scope,
 *    no assigned-event exception, a tick fills, expiry empties; a legacy
 *    falsy home still defaults
 *  H payload privacy: dates only to same-agency admins (venueUntil); no grant
 *    record field in any payload; coordinator/mashgiach/kiosk/agency B none
 *  I 5.9 rollback helper (platform operator only): freeze, ends every dated
 *    grant, 0 remaining; venue-ops then refuses dates; a pool invite accept is
 *    refused while frozen
 *  J two processes on one emulator (real emulator only): an untick and a code
 *    reset on A reach B within one refresh, and the reverse
 */
import { inviteMember, acceptNew } from './invite-helpers.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const GRANT_FIELDS = ['venueGrants', 'venueHistory', 'noHomeVenue', '"venueRev"'];

export default {
  name: 'Test 81: per-venue end dates and the expiry core (12a-s)',
  whatItProves:
    'Extra-venue grants can carry an end date set through one scoped, revision-checked route (admin any venue; owner/coordinator only their own venues, with a required end date for loans); a grant grants nothing from its end instant on every phone, socket and kiosk path with or without the sweep; the sweep closes it once; stale processes fail closed on extras; no-home rows survive; nothing leaks.',

  async run(baseUrl, ctx) {
    const details = [];
    const ts = Date.now();
    const A = `agency-t81a-${ts}`, B = `agency-t81b-${ts}`;
    const V1 = `venue-t81-1-${ts}`, V2 = `venue-t81-2-${ts}`, V3 = `venue-t81-3-${ts}`, VB = `venue-t81-b-${ts}`;
    const U = (k) => `user-t81-${k}-${ts}`;
    const E = (k) => `t81-${k}-${ts}@test.local`;
    const PW = 'stage2-t81-password';
    const PIN = '8137';
    const call = async (base, method, path, headers, body) => {
      const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body, base = baseUrl) => {
      const r = await call(base, 'POST', `/api/__test__/${path}`, ctx.authHeaders, body);
      assert(r.status === 200, `${path} ${r.status} ${r.text.slice(0, 200)}`);
      return r.json;
    };
    const mint = async (userId, base = baseUrl) => {
      const r = await call(base, 'POST', '/api/__test__/mint-token', { 'Content-Type': 'application/json' }, { userId });
      assert(r.status === 200 && r.json?.token, `mint ${userId} ${r.status}`);
      return r.json.token;
    };
    let reloadN = 0;
    let devOuter = null;
    const reloadCommit = async () => assert((await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: `agency-t81-reload-${ts}-${reloadN++}`, name: 'T81 reload' }] })).status === 200, 'reload commit');
    const rec = async (id, base = baseUrl) => (await call(base, 'GET', `/api/__test__/grant-record/${id}`, ctx.authHeaders)).json;
    const clock = async (iso, base = baseUrl) => hook('clock', { iso }, base);
    const ops = async (token, id, list, rev, base = baseUrl) => call(base, 'POST', `/api/users/${id}/venue-ops`, auth(token), { ops: list, expectedVenueRev: rev, expectedVersion: await ctx.getVersion() });
    const revOf = async (id) => ((await rec(id)).venueRev ?? 0);
    const tasksAt = async (token, v, base = baseUrl, extra = {}) => call(base, 'GET', `/api/tasks${v ? `?venueId=${encodeURIComponent(v)}` : ''}`, { ...auth(token), ...extra });
    const taskIds = (res) => (res.json?.tasks || []).map((t) => t.id);
    const task = (id, ag, v) => ({ id, agencyId: ag, venueId: v, title: `T81 ${id}`, isCompleted: false, inputType: 'toggle', category: 'General', createdAt: new Date().toISOString() });
    const openWs = (token, credential, base = baseUrl) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
      const conn = { ws, msgs: [], closeCode: null };
      ws.onopen = () => { if (credential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential })); } catch {} } };
      ws.onmessage = (ev) => { try { conn.msgs.push(JSON.parse(String(ev.data))); } catch {} };
      ws.onclose = (ev) => { conn.closeCode = ev.code; };
      ws.onerror = () => {};
      conn.until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return pred(); };
      conn.count = (type) => conn.msgs.filter((m) => m.type === type).length;
      conn.close = () => { try { ws.close(); } catch {} };
      return conn;
    };
    const pairDevice = async (adminToken, venueId) => {
      const start = await call(baseUrl, 'POST', '/api/kiosk/pairing/start', { 'Content-Type': 'application/json' }, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const { pairingId, code, deviceSecret } = start.json;
      const pair = await call(baseUrl, 'POST', '/api/kiosk/devices/pair', auth(adminToken), { code, venueId });
      assert(pair.status === 201, `devices/pair ${pair.status} ${pair.text.slice(0, 120)}`);
      const claim = await call(baseUrl, 'GET', '/api/kiosk/pairing/status', { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` });
      assert(claim.status === 200 && claim.json?.status === 'approved', `claim ${claim.status}`);
      return { id: claim.json.device.id, header: `${claim.json.device.id}.${deviceSecret}` };
    };

    // ---- fixture: agency A in New York time ----
    const T0 = '2026-10-23T16:00:00.000Z'; // noon EDT
    const UNTIL = '2026-10-24T04:00:00.000Z'; // midnight after Oct 23, New York
    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T81 A ${ts}`, shortCode: 'T81A', adminEmail: E('adminA'), timeZone: 'America/New_York' },
        { id: B, name: `T81 B ${ts}`, shortCode: 'T81B', adminEmail: E('adminB') },
      ],
      venues: [
        { id: V1, name: 'T81 V1', agencyId: A }, { id: V2, name: 'T81 V2', agencyId: A },
        { id: V3, name: 'T81 V3', agencyId: A }, { id: VB, name: 'T81 VB', agencyId: B },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T81 Admin A', role: 'admin', agencyId: A },
        { id: U('adminB'), email: E('adminB'), name: 'T81 Admin B', role: 'admin', agencyId: B },
        { id: U('coord'), email: E('coord'), name: 'T81 Coord V1', role: 'coordinator', agencyId: A, venueId: V1 },
        { id: U('owner'), email: E('owner'), name: 'T81 Owner V3', role: 'owner', agencyId: A, venueId: V3 },
        { id: U('mash'), email: E('mash'), name: 'T81 Mash V1', role: 'mashgiach', agencyId: A, venueId: V1, kioskPin: PIN },
        { id: U('mash2'), email: E('mash2'), name: 'T81 Mash V2', role: 'mashgiach', agencyId: A, venueId: V2, kioskPin: '8138' },
        { id: U('coord2'), email: E('coord2'), name: 'T81 Coord V2', role: 'coordinator', agencyId: A, venueId: V2 },
        { id: U('legacy'), email: E('legacy'), name: 'T81 Legacy', role: 'mashgiach', agencyId: A, venueId: V1 },
      ],
      tasks: [task(`task-t81-1-${ts}`, A, V1), task(`task-t81-2-${ts}`, A, V2), task(`task-t81-3-${ts}`, A, V3)],
      events: [{ id: `event-t81-2-${ts}`, agencyId: A, venueId: V2, title: 'T81 event at V2', date: '2026-10-23', assignedMashgiachEmail: E('pool'), tasks: [] }],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    const tAdmin = await mint(U('adminA')), tAdminB = await mint(U('adminB')), tCoord = await mint(U('coord'));
    const tOwner = await mint(U('owner')), tMash = await mint(U('mash')), tCoord2 = await mint(U('coord2'));
    await clock(T0);
    await hook('grant-sweep', { disable: true });
    try {
      // ===== A0 (root, on N7): the freshness read is idle unless temporary access exists =====
      let fz = await hook('freshness', { recompute: true });
      assert(fz.needed === false, `no end-dated grant anywhere -> not needed ${J(fz)}`);
      const reads0 = fz.reads;
      for (let k = 0; k < 3; k++) { fz = await hook('freshness', { tick: true }); assert(fz.tick === 'idle', `tick ${k} idle ${J(fz)}`); }
      fz = await hook('freshness', { advanceMonoMs: 61000 });
      assert(fz.reads === reads0 && fz.status === 'fresh', `0 freshness reads over 3 ticks, never stale while idle ${J(fz)}`);
      // root N7 (a): idle = one version read per 5 min, not more
      await hook('freshness', { advanceMonoMs: 300000 });
      fz = await hook('freshness', { tick: true });
      assert(String(fz.tick).startsWith('idle-read') && fz.reads === reads0 + 1, `idle read after 5 min ${J(fz)}`);
      for (let k = 0; k < 3; k++) { fz = await hook('freshness', { tick: true, advanceMonoMs: 15000 }); assert(fz.tick === 'idle', `idle cadence ${k} ${J(fz)}`); }
      assert(fz.reads === reads0 + 1, `idle reads stay at the 5-min cadence ${J(fz)}`);
      const readsA0 = fz.reads;
      details.push('A0 freshness idle: no temporary grants -> no reads for 5 min, then one version read per 5 min; never stale');

      // ===== A: refusals and role rules =====
      let rev = await revOf(U('mash'));
      assert(rev === 0, `fresh row venueRev 0, got ${rev}`);
      const refuse = async (token, id, list, status, code, label, revArg = rev) => {
        const x = await ops(token, id, list, revArg);
        assert(x.status === status && (!code || x.json?.code === code), `${label}: ${x.status} ${x.text.slice(0, 200)}`);
      };
      await refuse(tMash, U('mash2'), [{ op: 'add', venueId: V1, until: null }], 403, 'NOT_ALLOWED', 'mashgiach caller');
      await refuse(tAdminB, U('mash'), [{ op: 'add', venueId: V2, until: null }], 404, null, 'other agency admin');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V1, until: null }], 400, 'MAIN_VENUE_LOCKED', 'main venue add');
      await refuse(tAdmin, U('mash'), [{ op: 'remove', venueId: V1 }], 400, 'MAIN_VENUE_LOCKED', 'main venue remove');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: VB, until: null }], 400, 'VENUE_NOT_IN_AGENCY', 'foreign venue');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-22' }], 400, 'UNTIL_IN_PAST', 'past');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '2027-12-01' }], 400, 'UNTIL_TOO_FAR', 'too far');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '23/10/2026' }], 400, 'UNTIL_INVALID', 'malformed date');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V2 }], 400, 'UNTIL_INVALID', 'add without the until key');
      await refuse(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: null }], 409, 'VENUES_CHANGED', 'stale venueRev', 7);
      await refuse(tAdmin, U('mash'), [{ op: 'remove', venueId: V2 }], 409, 'NOT_TICKED', 'remove not ticked');
      await refuse(tAdmin, U('adminA'), [{ op: 'add', venueId: V2, until: null }], 400, 'TARGET_IS_ADMIN', 'admin target');
      // coordinator (V1) / owner (V3): only their own venues, mashgichim only, loans need an end date
      await refuse(tCoord, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], 403, 'VENUE_NOT_IN_SCOPE', 'coordinator outside scope');
      await refuse(tOwner, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], 403, 'VENUE_NOT_IN_SCOPE', 'owner outside own venue');
      await refuse(tCoord, U('coord2'), [{ op: 'add', venueId: V1, until: '2026-10-23' }], 403, 'NOT_ALLOWED', 'coordinator target');
      await refuse(tCoord, U('mash2'), [{ op: 'add', venueId: V1, until: null }], 400, 'UNTIL_REQUIRED', 'loan without end date', await revOf(U('mash2')));
      assert((await revOf(U('mash'))) === 0 && (await rec(U('mash'))).venueGrants === undefined, 'refusals wrote nothing');
      details.push('A refusals: roles, scope, main venue, dates, venueRev, foreign venue/agency');

      // coordinator loan at V1 for mash2 (home V2), owner loan at V3 for mash2; both dated
      r = await ops(tCoord, U('mash2'), [{ op: 'add', venueId: V1, until: '2026-10-24' }], await revOf(U('mash2')));
      fz = await hook('freshness', { tick: true });
      assert(fz.needed === true && fz.status === 'fresh' && fz.reads === readsA0 + 1 && !String(fz.tick).startsWith('idle'), `first temporary grant -> 15 s reads resume (born fresh) ${J(fz)}`);
      assert(r.status === 200 && J(r.json.venueIds) === J([V1]), `coordinator loan ${r.status} ${r.text.slice(0, 200)} (response limited to the caller's venues)`);
      r = await ops(tOwner, U('mash2'), [{ op: 'add', venueId: V3, until: '2026-10-25' }], await revOf(U('mash2')));
      assert(r.status === 200 && J(r.json.venueIds) === J([V3]), `owner loan ${r.status} ${r.text.slice(0, 200)}`);
      let m2 = await rec(U('mash2'));
      assert(J(m2.venueAccess) === J([V2, V1, V3]) && m2.venueGrants[V1].by === U('coord') && m2.venueGrants[V3].by === U('owner') && m2.venueRev === 2, `loan record ${J(m2)}`);
      await refuse(tCoord, U('mash2'), [{ op: 'remove', venueId: V3 }], 403, 'VENUE_NOT_IN_SCOPE', 'coordinator cannot touch another venue grant', 2);
      await refuse(tCoord, U('mash2'), [{ op: 'set_until', venueId: V1, until: null }], 400, 'UNTIL_REQUIRED', 'coordinator cannot make a loan undated', 2);
      r = await ops(tCoord, U('mash2'), [{ op: 'remove', venueId: V1 }], 2);
      assert(r.status === 200, `coordinator ends own-venue loan ${r.status}`);
      m2 = await rec(U('mash2'));
      assert(J(m2.venueAccess) === J([V2, V3]) && m2.venueHistory[0].why === 'unticked' && m2.venueHistory[0].by === U('coord'), `after coordinator untick ${J(m2)}`);
      details.push('A role rules: coordinator/owner loans only at own venue, dated, audited (by); cannot touch other venues');

      // ===== B: admin dated grant for mash at V2 until today; kiosk at V2 =====
      r = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], 0);
      assert(r.status === 200 && J(r.json.venueIds) === J([V1, V2]) && r.json.venueUntil[V2] === UNTIL && r.json.venueRev === 1, `admin grant ${r.status} ${r.text.slice(0, 200)}`);
      // admin roster carries venueUntil + venueRevision; coordinator/mashgiach rosters never carry dates
      let roster = await call(baseUrl, 'GET', '/api/users', auth(tAdmin));
      const mashRow = (roster.json?.users || []).find((u) => u.id === U('mash'));
      assert(mashRow && mashRow.venueUntil?.[V2] === UNTIL && mashRow.venueRevision === 1 && J(mashRow.venueIds) === J([V1, V2]), `admin view ${J(mashRow)}`);
      for (const [label, tok] of [['coordinator', tCoord], ['mashgiach', tMash], ['agency B admin', tAdminB]]) {
        const x = await call(baseUrl, 'GET', '/api/users', auth(tok));
        assert(!x.text.includes('venueUntil') && !GRANT_FIELDS.some((f) => x.text.includes(f)), `${label} roster carries no dates/grant record`);
      }
      const me = await call(baseUrl, 'GET', '/api/auth/me', auth(tMash));
      const self = me.json?.user || me.json || {};
      details.push(`self payload myVenueUntil=${J(self.myVenueUntil || null)}`);
      assert(!GRANT_FIELDS.some((f) => me.text.includes(f)), `self payload carries no grant record ${me.text.slice(0, 200)}`);

      const dev = await pairDevice(tAdmin, V2);
      devOuter = dev;
      await call(baseUrl, 'POST', '/api/__test__/kiosk-clear-lockouts', auth(tAdmin));
      const kl = await call(baseUrl, 'POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header }, { userId: U('mash'), pin: PIN });
      assert(kl.status === 200 && kl.json?.token, `kiosk login at V2 while ticked ${kl.status} ${kl.text.slice(0, 160)}`);
      const tK = kl.json.token;
      const authK = { ...auth(tK), 'X-Kiosk-Device': dev.header };
      const kHttp = await call(baseUrl, 'GET', '/api/tasks', authK);
      details.push(`kiosk http right after login ${kHttp.status} ${kHttp.text.slice(0, 80)}`);
      const wsK = openWs(tK, dev.header);
      // (a kiosk socket still proving its device is closed by any broadcast that lands then — pre-existing; open the phone socket after)
      await wsK.until(() => wsK.count('INITIAL_STATE') > 0, 8000);
      // a second person's kiosk session at the same tablet: its roster lists mash while ticked
      const kl2 = await call(baseUrl, 'POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header }, { userId: U('mash2'), pin: '8138' });
      assert(kl2.status === 200 && kl2.json?.token, `mash2 kiosk login ${kl2.status} ${kl2.text.slice(0, 120)}`);
      const rosterIds = (m) => (m?.payload?.users || []).map((u) => u.id);
      const wsK2 = openWs(kl2.json.token, dev.header);
      await wsK2.until(() => wsK2.count('INITIAL_STATE') > 0, 8000);
      assert(rosterIds(wsK2.msgs.find((m) => m.type === 'INITIAL_STATE')).includes(U('mash')), `kiosk roster lists mash while ticked ${J(rosterIds(wsK2.msgs.find((m) => m.type === 'INITIAL_STATE')))}`);
      wsK2.close();
      await sleep(200);
      const wsP = openWs(tMash, null);
      await wsP.until(() => wsP.count('INITIAL_STATE') > 0, 8000);
      assert(wsK.count('INITIAL_STATE') > 0 && wsP.count('INITIAL_STATE') > 0, `${details.slice(-1)} sockets got INITIAL_STATE k=${J(wsK.msgs.map((m) => m.type))} ${wsK.closeCode} p=${J(wsP.msgs.map((m) => m.type))} ${wsP.closeCode}`);
      const pInit = wsP.msgs.find((m) => m.type === 'INITIAL_STATE');
      assert(pInit.payload.myVenueUntil?.[V2] === UNTIL && typeof pInit.payload.serverNow === 'string' && pInit.payload.myVenueRev === 1 && pInit.payload.freshness === 'fresh', `phone INITIAL_STATE grant view ${J({ u: pInit.payload.myVenueUntil, n: pInit.payload.serverNow })}`);
      const kInit = wsK.msgs.find((m) => m.type === 'INITIAL_STATE');
      assert(kInit.payload.myVenueUntil === undefined && kInit.payload.serverNow === undefined && !J(kInit.payload).includes(UNTIL), 'kiosk INITIAL_STATE carries no dates');
      // until - 1 ms: everything works
      await clock(new Date(Date.parse(UNTIL) - 1).toISOString());
      assert(J(taskIds(await tasksAt(tMash, V2))) === J([`task-t81-2-${ts}`]), 'phone V2 tasks at until-1ms');
      assert((await tasksAt(tK, null, baseUrl, { 'X-Kiosk-Device': dev.header })).status === 200, 'kiosk works at until-1ms');
      // at until (sweep disabled): refused everywhere
      await clock(UNTIL);
      let x = await tasksAt(tMash, V2);
      assert(taskIds(x).length === 0 && x.json.venueId === null, `phone V2 at until ${J(x.json).slice(0, 160)}`);
      assert(J(taskIds(await tasksAt(tMash, null))) === J([`task-t81-1-${ts}`]), 'home still works');
      x = await call(baseUrl, 'GET', '/api/tasks', authK);
      assert(x.status === 401 && x.json?.code === 'KIOSK_SESSION_ENDED', `kiosk HTTP at until ${x.status} ${x.text.slice(0, 160)}`);
      x = await call(baseUrl, 'GET', '/api/kiosk/device', { 'X-Kiosk-Device': dev.header });
      assert(x.status === 200 && !(x.json?.users || x.json?.people || []).some((u) => u.id === U('mash')) && !x.text.includes(U('mash')), `device stays paired, person dropped ${x.status} ${x.text.slice(0, 200)}`);
      x = await call(baseUrl, 'POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header }, { userId: U('mash'), pin: PIN });
      assert(x.status !== 200 && !x.json?.token, `kiosk login refused at until ${x.status}`);
      await hook('freshness', { reconcileNow: true });
      await wsK.until(() => wsK.closeCode !== null, 5000);
      assert(wsK.count('KIOSK_SESSION_ENDED') === 1 && wsK.closeCode === 4401, `kiosk socket ended ${wsK.closeCode} ${J(wsK.msgs.map((m) => m.type))}`);
      await wsP.until(() => wsP.count('SCOPE_CHANGED') > 0, 5000);
      await hook('freshness', { reconcileNow: true });
      await sleep(300);
      const sc = wsP.msgs.filter((m) => m.type === 'SCOPE_CHANGED');
      assert(sc.length === 1 && J(sc[0].payload.venueIds) === J([V1]) && J(sc[0].payload.myVenueUntil) === J({}), `one SCOPE_CHANGED ${J(sc)}`);
      const afterSc = wsP.msgs.slice(wsP.msgs.indexOf(sc[0]) + 1);
      assert(afterSc.some((m) => m.type === 'INITIAL_STATE' && !(m.payload.tasks || []).some((t) => t.venueId === V2)), 'fresh INITIAL_STATE without V2 follows');
      // a fresh kiosk roster at the tablet (built from presentation copies) no longer lists mash
      const wsK3 = openWs(kl2.json.token, dev.header);
      await wsK3.until(() => wsK3.count('INITIAL_STATE') > 0 || wsK3.closeCode !== null, 8000);
      const k3 = wsK3.msgs.find((m) => m.type === 'INITIAL_STATE');
      assert(k3 && !rosterIds(k3).includes(U('mash')) && rosterIds(k3).includes(U('mash2')), `kiosk roster drops mash at until ${J(rosterIds(k3))} ${wsK3.closeCode}`);
      wsK3.close();
      assert((await rec(U('mash'))).venueGrants?.[V2]?.until === UNTIL, 'sweep disabled: the stored grant is still there (authorization alone denied it)');
      details.push('B boundary: until-1ms works; at until phone/kiosk HTTP/WS/login/device list refuse with the sweep disabled; 1 SCOPE_CHANGED');

      // ===== C: sweep =====
      const v0 = await ctx.getVersion();
      let sw = await hook('grant-sweep', { runNow: true });
      assert(sw.run?.committed === true && sw.run.rows >= 1, `sweep committed ${J(sw)}`);
      let mr = await rec(U('mash'));
      assert(J(mr.venueAccess) === J([V1]) && !mr.venueGrants && mr.venueHistory[0].why === 'ended' && mr.venueHistory[0].to === UNTIL && mr.venueRev === 2, `swept ${J(mr)}`);
      const v1 = await ctx.getVersion();
      sw = await hook('grant-sweep', { runNow: true });
      assert(sw.run?.committed === false && (await ctx.getVersion()) === v1 && v1 > v0, 'second sweep writes nothing');
      // race: extend-then-sweep (the extension wins)
      await clock(T0);
      r = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], 2);
      assert(r.status === 200, `re-tick ${r.status}`);
      r = await ops(tAdmin, U('mash'), [{ op: 'set_until', venueId: V2, until: '2026-10-24' }], 3);
      assert(r.status === 200 && r.json.venueUntil[V2] === '2026-10-25T04:00:00.000Z', `extend ${r.text.slice(0, 160)}`);
      await clock(new Date(Date.parse(UNTIL) + 1000).toISOString());
      sw = await hook('grant-sweep', { runNow: true });
      assert(sw.run?.committed === false && J((await rec(U('mash'))).venueAccess) === J([V1, V2]), 'extension committed first wins (sweep closes nothing)');
      // sweep-then-extend: after the close an extension is NOT_TICKED, a new add is a new grant
      await clock('2026-10-25T04:00:00.000Z');
      sw = await hook('grant-sweep', { runNow: true });
      assert(sw.run?.committed === true, 'sweep closes at the extended end');
      x = await ops(tAdmin, U('mash'), [{ op: 'set_until', venueId: V2, until: '2026-10-26' }], await revOf(U('mash')));
      assert(x.status === 409 && x.json?.code === 'NOT_TICKED', `extend after close ${x.status}`);
      r = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: null }], await revOf(U('mash')));
      assert(r.status === 200 && r.json.venueUntil[V2] === undefined, 'a new add after close is a new (undated) grant');
      details.push('C sweep: closes once with history, second sweep no write; extend-then-sweep and sweep-then-extend');

      // ===== D: legacy PUT =====
      r = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V3, until: '2026-10-30' }], await revOf(U('mash')));
      assert(r.status === 200, 'dated V3');
      const putV = async (token, id, body) => call(baseUrl, 'PUT', `/api/users/${id}/venues`, auth(token), { ...body, expectedVersion: await ctx.getVersion() });
      x = await putV(tAdmin, U('mash'), { venueIds: [V1, V2, V3] });
      assert(x.status === 409 && x.json?.code === 'VENUES_CHANGED', `stale old tab without expected list ${x.status}`);
      x = await putV(tAdmin, U('mash'), { venueIds: [V1, V3], expectedVenueIds: [V1, V2, V3] });
      assert(x.status === 200 && J(x.json.venueIds) === J([V1, V3]), `old sheet untick V2 ${x.status} ${x.text.slice(0, 160)}`);
      mr = await rec(U('mash'));
      assert(mr.venueGrants?.[V3]?.until === '2026-10-31T04:00:00.000Z' && mr.venueHistory[0].why === 'unticked', `kept venue keeps its date ${J(mr)}`);
      // a legacy row: written exactly as before (no grant fields appear)
      x = await putV(tAdmin, U('legacy'), { venueIds: [V3, V2] });
      assert(x.status === 200 && J(x.json.venueIds) === J([V1, V3, V2]), `legacy put ${x.text.slice(0, 160)}`);
      const lg = await rec(U('legacy'));
      assert(J(lg.venueAccess) === J([V1, V3, V2]) && lg.venueGrants === undefined && lg.venueHistory === undefined && lg.venueRev === undefined, `legacy row unchanged in shape ${J(lg)}`);
      details.push('D legacy PUT: 409 without expected list on a dated row; kept dates; legacy row exactly as before');

      // ===== E: malformed metadata =====
      await clock(T0);
      let doc = await ctx.getDoc();
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: doc.users.map((u) => (u.id === U('legacy') ? { ...u, venueGrants: [] } : u)) });
      await reloadCommit();
      const tLegacy = await mint(U('legacy'));
      x = await tasksAt(tLegacy, V2);
      assert(taskIds(x).length === 0, 'malformed container denies the extras');
      assert(J(taskIds(await tasksAt(tLegacy, null))) === J([`task-t81-1-${ts}`]), 'home keeps working');
      sw = await hook('grant-sweep', { runNow: true });
      const lg2 = await rec(U('legacy'));
      assert(sw.run?.committed && J(lg2.venueAccess) === J([V1]) && lg2.venueHistory.filter((h) => h.why === 'invalid_data').length === 2, `invalid_data closed and removed ${J(lg2)}`);
      await ctx.restartServer();
      await clock(T0);
      await hook('grant-sweep', { disable: true });
      assert(J((await rec(U('legacy'))).venueAccess) === J([V1]), 'never revived as undated after a restart');
      details.push('E malformed: denied, closed as invalid_data, removed, survives restart');

      // ===== F: freshness =====
      const tMashF = await mint(U('mash'));
      assert(J(taskIds(await tasksAt(tMashF, V3))) === J([`task-t81-3-${ts}`]), 'V3 (dated) works while fresh');
      const wsF = openWs(tMashF, null);
      await wsF.until(() => wsF.count('INITIAL_STATE') > 0, 8000);
      let fr = await hook('freshness', { refreshNow: true });
      assert(fr.status === 'fresh' && fr.enabled === true, `fresh at start ${J(fr)}`);
      await hook('freshness', { advanceMonoMs: 30000 });
      await clock('2026-10-20T16:00:00.000Z'); // wall clock jumps BACK 3 days
      fr = await hook('freshness', { advanceMonoMs: 31000 });
      assert(fr.status === 'stale', `61 s on the monotonic clock = STALE despite a backward wall-clock jump ${J(fr)}`);
      await clock(T0);
      x = await tasksAt(tMashF, V3);
      assert(taskIds(x).length === 0, 'STALE: extra denied on HTTP');
      assert(J(taskIds(await tasksAt(tMashF, null))) === J([`task-t81-1-${ts}`]), 'STALE: home kept');
      x = await ops(tAdmin, U('mash2'), [{ op: 'remove', venueId: V3 }], await revOf(U('mash2')));
      assert(x.status === 503 && x.json?.code === 'FRESHNESS_STALE', `STALE: venue-ops 503 ${x.status}`);
      await hook('freshness', { reconcileNow: true });
      await hook('freshness', { reconcileNow: true });
      await wsF.until(() => wsF.count('SCOPE_CHANGED') > 0, 5000);
      await sleep(300);
      assert(wsF.count('SCOPE_CHANGED') === 1 && wsF.msgs.find((m) => m.type === 'SCOPE_CHANGED').payload.freshness === 'stale', `one notification per transition ${wsF.count('SCOPE_CHANGED')}`);
      await hook('freshness', { pingNow: true });
      await sleep(500);
      assert(wsF.count('SCOPE_PING') === 0, 'no SCOPE_PING without the opt-in (the live client never asks)');
      wsF.ws.send(JSON.stringify({ type: 'SCOPE_PING_SUBSCRIBE' }));
      await sleep(300);
      await hook('freshness', { pingNow: true });
      await wsF.until(() => wsF.count('SCOPE_PING') > 0, 3000);
      assert(wsF.msgs.find((m) => m.type === 'SCOPE_PING').payload.freshness === 'stale', 'SCOPE_PING carries the freshness status');
      // hung read and failed read never confirm
      await hook('freshness', { hangReads: true });
      fr = await hook('freshness', { refreshNow: true });
      assert(fr.refresh?.result === 'failed' && fr.status === 'stale', `hung read (5 s deadline) does not confirm ${J(fr)}`);
      await hook('freshness', { hangReads: false, failReads: true });
      fr = await hook('freshness', { refreshNow: true });
      assert(fr.refresh?.result === 'failed' && fr.status === 'stale', `failed read does not confirm ${J(fr)}`);
      await hook('freshness', { failReads: false });
      fr = await hook('freshness', { refreshNow: true });
      assert(fr.refresh?.result === 'confirmed' && fr.status === 'fresh', `recovery ${J(fr)}`);
      assert(J(taskIds(await tasksAt(tMashF, V3))) === J([`task-t81-3-${ts}`]), 'fresh again: extra restored');
      await hook('freshness', { reconcileNow: true });
      await wsF.until(() => wsF.count('SCOPE_CHANGED') > 1, 5000);
      assert(wsF.count('SCOPE_CHANGED') === 2, 'recovery notified once');
      // a failed FULL read after a successful version read never confirms
      fr = await hook('freshness', { advanceMonoMs: 61000, failFullReads: true, simulateNewer: true, refreshNow: true });
      assert(fr.refresh?.result === 'failed' && fr.status === 'stale', `failed full read after a newer version read ${J(fr)}`);
      fr = await hook('freshness', { failFullReads: false, simulateNewer: false, refreshNow: true });
      assert(fr.status === 'fresh', 'confirmed again');
      // a discarded older document never renews freshness
      fr = await hook('freshness', { simulateNewer: true, holdNextInstall: true, refreshNow: true, wait: false });
      await sleep(500);
      assert((await hook('freshness', {})).held === true, 'refresh holding a fetched document');
      await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: `agency-t81-bump-${ts}`, name: 'T81 bump' }] }); // local commit installs a newer version
      await hook('freshness', { advanceMonoMs: 45000 });
      await hook('freshness', { releaseHeld: true, simulateNewer: false });
      await sleep(500);
      fr = await hook('freshness', {});
      assert(fr.ageMs >= 45000, `discarded older document did not renew freshness (age ${fr.ageMs})`);
      fr = await hook('freshness', { refreshNow: true });
      assert(fr.status === 'fresh', 'fresh after a real confirmation');
      wsF.close(); wsP.close();
      details.push('F freshness: monotonic 60 s STALE (backward wall jump ignored), extras denied/home kept, 503, one notification per transition, ping status, hung/failed/full-read failures never confirm, discarded older doc never renews');

      // ===== G: noHomeVenue =====
      doc = await ctx.getDoc();
      const poolRow = { id: U('pool'), email: E('pool'), name: 'T81 Pool', role: 'mashgiach', agencyId: A, venueId: '', noHomeVenue: true, personId: U('pool'), venueAccess: [], venueRev: 1, venueHistory: [{ venueId: '', from: T0, to: T0, why: 'joined_pool', by: null }] };
      const falsy = { id: U('falsy'), email: E('falsy'), name: 'T81 Falsy', role: 'mashgiach', agencyId: A, venueId: '', personId: U('falsy') };
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: [...doc.users, poolRow, falsy] });
      await reloadCommit();
      await ctx.restartServer();
      await clock(T0);
      await hook('grant-sweep', { disable: true });
      await hook('set-password', { userId: U('pool'), password: PW });
      const pl = await call(baseUrl, 'POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E('pool'), password: PW });
      assert(pl.status === 200 && pl.json?.token, `pool sign-in ${pl.status} ${pl.text.slice(0, 200)}`);
      assert(J(pl.json.user.myVenueIds) === J([]) && (pl.json.user.venueId || '') === '', `empty scope, no invented home ${J({ m: pl.json.user.myVenueIds, v: pl.json.user.venueId })}`);
      const pr = await rec(U('pool'));
      assert(pr.noHomeVenue === true && pr.venueId === '', `marker kept through restart + hydrate ${J(pr)}`);
      assert((await rec(U('falsy'))).venueId === 'venue-crown-market', 'legacy falsy home still defaults (unchanged)');
      const tPool = pl.json.token;
      x = await call(baseUrl, 'GET', '/api/events', auth(tPool));
      assert(!(x.json?.events || []).some((e) => e.id === `event-t81-2-${ts}`), `no assigned-event exception with an empty scope ${x.text.slice(0, 160)}`);
      assert(taskIds(await tasksAt(tPool, null)).length === 0 && taskIds(await tasksAt(tPool, V2)).length === 0, 'no tasks');
      const wsPool = openWs(tPool, null);
      await wsPool.until(() => wsPool.count('INITIAL_STATE') > 0, 8000);
      r = await ops(tAdmin, U('pool'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], 1);
      assert(r.status === 200 && J(r.json.venueIds) === J([V2]), `tick a no-home person ${r.text.slice(0, 160)}`);
      await wsPool.until(() => wsPool.count('SCOPE_CHANGED') > 0, 5000);
      assert(wsPool.count('SCOPE_CHANGED') === 1, 'the open socket is told at once (first tick)');
      assert(J(taskIds(await tasksAt(tPool, V2))) === J([`task-t81-2-${ts}`]), 'tick fills');
      x = await call(baseUrl, 'GET', '/api/events', auth(tPool));
      assert((x.json?.events || []).some((e) => e.id === `event-t81-2-${ts}`), 'event at the ticked venue visible');
      assert((await rec(U('pool'))).noHomeVenue === true, 'still no home');
      await clock(UNTIL);
      assert(taskIds(await tasksAt(tPool, V2)).length === 0, 'expiry empties it again');
      await hook('freshness', { reconcileNow: true });
      await wsPool.until(() => wsPool.count('SCOPE_CHANGED') > 1, 5000);
      assert(wsPool.count('SCOPE_CHANGED') === 2, 'expiry notified');
      wsPool.close();
      details.push('G noHome: marker survives restart, sign-in empty scope, no assigned-event exception, tick fills live, expiry empties; falsy legacy home still defaults');

      // ===== G2: an invite with venueIds [] (no 12a-s route makes one; planted) accepts into a noHomeVenue row =====
      await clock(null);
      const inv1 = await inviteMember(baseUrl, auth(tAdmin), { email: E('pinv'), name: 'T81 Pool Invitee', role: 'mashgiach', venueId: V1 });
      const inv2 = await inviteMember(baseUrl, auth(tAdmin), { email: E('pinv2'), name: 'T81 Pool Invitee 2', role: 'mashgiach', venueId: V1 });
      assert(inv1.token && inv2.token, `invites ${inv1.status} ${inv2.status}`);
      doc = await ctx.getDoc();
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: doc.users, invites: (doc.invites || []).map((i) => ([E('pinv'), E('pinv2')].includes(i.email) ? { ...i, venueIds: [] } : i)) });
      await reloadCommit();
      x = await acceptNew(baseUrl, inv1.token, PW);
      assert(x.status === 200, `pool invite accept ${x.status} ${x.text.slice(0, 200)}`);
      const newRow = ((await ctx.getDoc()).users || []).find((u) => u.email === E('pinv'));
      const nr = await rec(newRow.id);
      assert(nr.noHomeVenue === true && nr.venueId === '' && J(nr.venueAccess) === J([]) && nr.venueHistory?.[0]?.why === 'joined_pool', `accept -> noHomeVenue row ${J(nr)}`);
      const pl2 = await call(baseUrl, 'POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E('pinv'), password: PW });
      assert(pl2.status === 200 && J(pl2.json.user.myVenueIds) === J([]), `fresh email+password sign-in, empty scope ${pl2.status} ${pl2.text.slice(0, 160)}`);
      // the same person accepts an empty-venue invite from agency B with their EXISTING account (mode 'existing')
      const inv3 = await inviteMember(baseUrl, auth(tAdminB), { email: E('pinv'), name: 'T81 Pool Invitee', role: 'mashgiach', venueId: VB });
      assert(inv3.token, `agency B invite ${inv3.status} ${inv3.text.slice(0, 160)}`);
      doc = await ctx.getDoc();
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: doc.users, invites: (doc.invites || []).map((i) => (i.email === E('pinv') && i.agencyId === B ? { ...i, venueIds: [] } : i)) });
      await reloadCommit();
      x = await call(baseUrl, 'POST', '/api/invites/accept', { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.81.${ts % 200}.9` }, { token: inv3.token, mode: 'existing', password: PW });
      assert(x.status === 200, `existing-account accept ${x.status} ${x.text.slice(0, 200)}`);
      const rowB = ((await ctx.getDoc()).users || []).find((u) => u.email === E('pinv') && u.agencyId === B);
      const nrB = rowB && (await rec(rowB.id));
      assert(nrB && nrB.noHomeVenue === true && nrB.venueId === '' && J(nrB.venueAccess) === J([]) && nrB.venueHistory?.[0]?.why === 'joined_pool', `existing-mode accept -> noHomeVenue row ${J(nrB)}`);
      await ctx.restartServer();
      await clock(T0);
      await hook('grant-sweep', { disable: true });
      const nrB2 = await rec(rowB.id);
      assert(nrB2.noHomeVenue === true && nrB2.venueId === '' && J(nrB2.venueAccess) === J([]), `existing-mode noHome row survives a restart (no invented home) ${J(nrB2)}`);
      await clock(null);
      details.push('G2 invite with venueIds [] accepts into a noHomeVenue row (new AND existing account, through restart); fresh sign-in has an empty scope');

      // ===== I: 5.9 helper =====
      await clock(T0);
      x = await call(baseUrl, 'POST', '/api/platform/venue-grants/end-dated', auth(tAdmin), {});
      assert(x.status === 403, `agency admin is not the platform operator ${x.status}`);
      x = await ctx.api('POST', '/api/platform/venue-grants/end-dated', {});
      assert(x.status === 200 && x.json.remainingDated === 0 && x.json.datedGrantsFrozen === true && x.json.ended >= 1 && x.json.revokedPoolInvites >= 1 && x.json.livePoolInvites === 0 && x.json.noHomeVenueRows >= 2, `helper ${x.status} ${J(x.json)}`);
      await clock(null);
      x = await acceptNew(baseUrl, inv2.token, PW);
      assert(x.status !== 200, `a pool invite is dead after the freeze ${x.status}`);
      await clock(T0);
      assert((await rec(U('mash'))).venueGrants?.[V3] === undefined && J((await rec(U('mash'))).venueAccess) === J([V1]), 'dated V3 ended');
      x = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V3, until: '2026-10-30' }], await revOf(U('mash')));
      assert(x.status === 409 && x.json?.code === 'DATED_GRANTS_FROZEN', `frozen refuses dates ${x.status}`);
      x = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V3, until: null }], await revOf(U('mash')));
      assert(x.status === 200, 'undated still allowed');
      await hook('grant-sweep', { unfreeze: true });
      details.push('I 5.9 helper: operator only, ends dated, revokes pool invites, 0 remaining, freezes dates; frozen invite accept refused');

      // ===== K: size budget (4.5): growth refused above 820 KiB, reductions still commit =====
      x = await ops(tAdmin, U('mash2'), [{ op: 'add', venueId: V1, until: null }], await revOf(U('mash2')));
      assert(x.status === 200, `pre-bloat grant ${x.status} ${x.text.slice(0, 120)}`);
      const V5 = `venue-t81-5-${ts}`;
      assert((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: V5, name: 'T81 V5', agencyId: A }] })).status === 200, 'V5');
      // a row with grant state whose extra has no entry and no history: removing it GROWS the row (history entry)
      doc = await ctx.getDoc();
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: [...doc.users, { id: U('tight'), email: E('tight'), name: 'T81 Tight', role: 'mashgiach', agencyId: A, venueId: V1, personId: U('tight'), venueAccess: [V1, V3], venueGrants: {}, venueRev: 1 }, { id: U('tight2'), email: E('tight2'), name: 'T81 Tight 2', role: 'mashgiach', agencyId: A, venueId: V1, personId: U('tight2'), venueAccess: [V1, V3], venueGrants: {}, venueRev: 1 },
        { id: U('hist'), email: E('hist'), name: 'T81 Hist', role: 'mashgiach', agencyId: A, venueId: V1, personId: U('hist'), venueAccess: [V1], venueGrants: {}, venueRev: 1 },
        ...[3, 4, 5].map((k) => ({ id: U('tight' + k), email: E('tight' + k), name: 'T81 Tight ' + k, role: 'mashgiach', agencyId: A, venueId: V1, personId: U('tight' + k), venueAccess: [V1, V3], venueGrants: {}, venueRev: 1 })),
        ...[1, 2, 3].map((k) => ({ id: U('vd' + k), email: E('vd' + k), name: 'T81 VD ' + k, role: 'mashgiach', agencyId: A, venueId: V1, personId: U('vd' + k), venueAccess: [V1, V5], venueGrants: {}, venueRev: 1 })),
        ...[1, 2, 3, 4, 5, 6].map((k) => ({ id: U('hd' + k), email: E('hd' + k), name: 'T81 HD ' + k, role: 'mashgiach', agencyId: A, venueId: V1, personId: U('hd' + k), venueAccess: [V1, V2], venueGrants: { [V2]: { until: '2026-10-30T04:00:00.000Z' } }, venueRev: 1 }))] });
      await reloadCommit();
      doc = await ctx.getDoc();
      const cur = JSON.stringify(doc).length;
      const pad = Math.max(0, 850 * 1024 - cur);
      const bloatId = `agency-t81-bloat-${ts}`;
      r = await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: bloatId, name: 'T81 bloat', notes: 'x'.repeat(pad) }] });
      assert(r.status === 200, `bloat ${r.status} ${J(r.json)}`);
      const kib = Math.round(JSON.stringify(await ctx.getDoc()).length / 1024);
      assert(kib > 820 && kib < 900, `document at ${kib} KiB`);
      const revK = await revOf(U('mash'));
      x = await ops(tAdmin, U('mash'), [{ op: 'add', venueId: V2, until: '2026-10-23' }], revK);
      assert(x.status === 409 && x.json?.code === 'STATE_NEAR_FULL', `growth refused near full ${x.status} ${x.text.slice(0, 160)}`);
      x = await ops(tAdmin, U('mash2'), [{ op: 'remove', venueId: V1 }], await revOf(U('mash2')));
      assert(x.status === 200, `a reduction still commits near full ${x.status} ${x.text.slice(0, 160)}`);
      // the legacy venues PUT (today's UI) gets the same budget on a row with grant state
      x = await putV(tAdmin, U('mash'), { venueIds: [V1, V3, V2], expectedVenueIds: [V1, V3] });
      assert(x.status === 409 && x.json?.code === 'STATE_NEAR_FULL', `legacy PUT growth refused near full ${x.status} ${x.text.slice(0, 160)}`);
      // just under the hard guard: a reduction through the PUT still commits (history dropped if needed)
      // (the reload commit itself adds a small agency row; measure it, then aim)
      const setBloat = async (targetChars) => {
        const d0 = await ctx.getDoc();
        const b0 = d0.agencies.find((a) => a.id === bloatId);
        const len = JSON.stringify(d0).length - b0.notes.length;
        // a row with full venue history (shed by the size-guard fallback when a removal needs room); replenished each time
        const hist = Array.from({ length: 10 }, (_, i) => ({ venueId: V3, from: T0, to: T0, why: 'unticked', by: U('adminA') + '-' + i }));
        const users1 = d0.users.map((u) => (u.id === U('hist') ? { ...u, venueHistory: hist } : u));
        const histDelta = JSON.stringify(users1).length - JSON.stringify(d0.users).length;
        await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: users1, agencies: d0.agencies.map((a) => (a.id === bloatId ? { ...a, notes: 'x'.repeat(Math.max(0, targetChars - len - histDelta)) } : a)) });
        await reloadCommit();
        return JSON.stringify(await ctx.getDoc()).length;
      };
      let sz = await setBloat(900 * 1024 - 2000);
      const reloadCost = sz - (900 * 1024 - 2000);
      sz = await setBloat(900 * 1024 - 300 - reloadCost);
      // (the second reload adds another row of the same size)
      assert(sz <= 900 * 1024 - 250 && sz > 900 * 1024 - 400, `document just under the hard guard (${900 * 1024 - sz} chars below)`);
      x = await putV(tAdmin, U('tight'), { venueIds: [V1], expectedVenueIds: [V1, V3], operationId: `t81-k-put-${ts}` });
      assert(x.status === 200, `legacy PUT reduction just under the hard guard commits ${x.status} ${x.text.slice(0, 160)}`);
      const tr = await rec(U('tight'));
      assert(J(tr.venueAccess) === J([V1]) && tr.venueRev === 2, `reduction applied (history dropped to fit) ${J(tr)}`);
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await call(baseUrl, 'POST', `/api/users/${U('tight2')}/venue-ops`, auth(tAdmin), { ops: [{ op: 'remove', venueId: V3 }], expectedVenueRev: 1, expectedVersion: await ctx.getVersion(), operationId: `t81-k-ops-${ts}` });
      assert(x.status === 200, `venue-ops reduction just under the hard guard commits ${x.status} ${x.text.slice(0, 160)}`);
      assert(J((await rec(U('tight2'))).venueAccess) === J([V1]), 'venue-ops reduction applied');
      // venue deletion closing grants on several rows (each grows by a history entry) must not fail at the guard
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await call(baseUrl, 'DELETE', `/api/venues/${V5}`, auth(tAdmin), { expectedVersion: await ctx.getVersion(), operationId: `t81-k-del-${ts}` });
      assert(x.status === 200, `venue deletion just under the hard guard commits ${x.status} ${x.text.slice(0, 160)}`);
      for (const k of [1, 2, 3]) assert(J((await rec(U('vd' + k))).venueAccess) === J([V1]), `vd${k} closed`);
      // the 5.9 rollback helper just under the guard: ends every dated grant, sets the freeze
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await ctx.api('POST', '/api/platform/venue-grants/end-dated', { operationId: `t81-k-helper-${ts}` });
      assert(x.status === 200 && x.json.remainingDated === 0 && x.json.datedGrantsFrozen === true && x.json.ended >= 6, `helper just under the hard guard ${x.status} ${J(x.json)}`);
      fz = await hook('freshness', { recompute: true });
      const readsK = fz.reads;
      fz = await hook('freshness', { tick: true });
      assert(fz.needed === false && String(fz.tick).startsWith('idle') && fz.reads <= readsK + 1, `every temporary grant ended -> back to idle cadence ${J(fz)}`);
      fz = await hook('freshness', { tick: true });
      assert(fz.tick === 'idle' && fz.reads <= readsK + 1, `idle: no 15 s reads ${J(fz)}`);
      for (const k of [1, 2, 3, 4, 5, 6]) assert(J((await rec(U('hd' + k))).venueAccess) === J([V1]), `hd${k} ended`);
      await hook('grant-sweep', { unfreeze: true });
      // shortening an undated grant (undated -> dated adds metadata) just under the guard commits
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await call(baseUrl, 'POST', `/api/users/${U('tight3')}/venue-ops`, auth(tAdmin), { ops: [{ op: 'set_until', venueId: V3, until: '2026-10-30' }], expectedVenueRev: 1, expectedVersion: await ctx.getVersion(), operationId: `t81-k-short-${ts}` });
      assert(x.status === 200 && x.json.venueUntil?.[V3] === '2026-10-31T04:00:00.000Z', `shortening just under the hard guard commits ${x.status} ${x.text.slice(0, 160)}`);
      // a home reassignment through today's user edit (identity closes the extras) just under the guard commits
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await call(baseUrl, 'PUT', `/api/users/${U('tight4')}`, auth(tAdmin), { venueId: V2, expectedVersion: await ctx.getVersion(), operationId: `t81-k-home-${ts}` });
      assert(x.status === 200, `home reassignment just under the hard guard commits ${x.status} ${x.text.slice(0, 160)}`);
      const t4 = await rec(U('tight4'));
      assert(t4.venueId === V2 && !(t4.venueAccess || []).includes(V3), `home moved, extras closed ${J(t4)}`);
      // RV5: expiry -> history shed at the guard -> an old tab's PUT without the expected list must not revive the venue
      await clock('2026-10-31T04:00:00.000Z');
      sw = await hook('grant-sweep', { runNow: true });
      assert(sw.run?.committed === true && (await rec(U('tight3'))).venueHistory?.[0]?.why === 'ended', 'tight3 expired and swept');
      await setBloat(900 * 1024 - 300 - reloadCost);
      x = await call(baseUrl, 'POST', `/api/users/${U('tight5')}/venue-ops`, auth(tAdmin), { ops: [{ op: 'remove', venueId: V3 }], expectedVenueRev: 1, expectedVersion: await ctx.getVersion(), operationId: `t81-k-shed-${ts}` });
      assert(x.status === 200, `a reduction that sheds history ${x.status} ${x.text.slice(0, 160)}`);
      const t3 = await rec(U('tight3'));
      assert(t3.venueHistory === undefined && J(t3.venueAccess) === J([V1]) && typeof t3.venueRev === 'number', `tight3 history shed, venueRev kept ${J(t3)}`);
      doc = await ctx.getDoc();
      await call(baseUrl, 'POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: doc.users, agencies: doc.agencies.filter((a) => a.id !== bloatId) });
      await reloadCommit();
      assert(JSON.stringify(await ctx.getDoc()).length < 820 * 1024, 'bloat removed');
      x = await putV(tAdmin, U('tight3'), { venueIds: [V1, V3] });
      assert(x.status === 409 && x.json?.code === 'VENUES_CHANGED', `stale old tab cannot revive an expired venue after its history was shed ${x.status} ${x.text.slice(0, 120)}`);
      assert(J((await rec(U('tight3'))).venueAccess) === J([V1]), 'still not revived');
      await clock(T0);

      details.push(`K size: growth 409 STATE_NEAR_FULL at ${kib} KiB, reduction commits`);

      // ===== L: deleting a venue closes a dated grant at it as 'venue_deleted' (9.8) =====
      const V4 = `venue-t81-4-${ts}`;
      assert((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: V4, name: 'T81 V4', agencyId: A }] })).status === 200, 'V4');
      x = await ops(tAdmin, U('mash2'), [{ op: 'add', venueId: V4, until: '2026-10-23' }], await revOf(U('mash2')));
      assert(x.status === 200, `grant at V4 ${x.status} ${x.text.slice(0, 120)}`);
      const revBeforeDel = await revOf(U('mash2'));
      x = await call(baseUrl, 'DELETE', `/api/venues/${V4}`, auth(tAdmin), { expectedVersion: await ctx.getVersion() });
      assert(x.status === 200, `delete V4 ${x.status} ${x.text.slice(0, 160)}`);
      const m2d = await rec(U('mash2'));
      assert(!m2d.venueAccess.includes(V4) && !(m2d.venueGrants || {})[V4] && m2d.venueHistory[0].venueId === V4 && m2d.venueHistory[0].why === 'venue_deleted' && m2d.venueRev === revBeforeDel + 1, `venue deletion closes the grant ${J(m2d)}`);
      details.push('L venue deletion closes a dated grant into history (venue_deleted)');
    } finally {
      try { await hook('grant-sweep', { disable: false, unfreeze: true }); } catch {}
      try { await hook('freshness', { failReads: false, hangReads: false, failFullReads: false, simulateNewer: false, releaseHeld: true }); } catch {}
      try { await clock(null); } catch {}
    }

    // ===== J: two processes =====
    if (typeof ctx.startSecondServer === 'function') {
      const second = await ctx.startSecondServer();
      if (!second) {
        details.push('J skipped in mock mode (the mock store is per process; runs on the real emulator)');
      } else {
        try {
          const Bu = second.url;
          let x;
          const tAdminS = await mint(U('adminA'), Bu);
          const tMashB = await mint(U('mash'), Bu);
          assert(J(taskIds(await tasksAt(tMashB, V3, Bu))) === J([`task-t81-3-${ts}`]), 'B sees V3');
          // root N7 (a): idle process B learns of an end date set on A within 5 min + one tick (normal ticks, fake clocks)
          const hookB = async (path, body) => { const q = await call(Bu, 'POST', `/api/__test__/${path}`, ctx.authHeaders, body); assert(q.status === 200, `${path} on B ${q.status}`); return q.json; };
          await hookB('grant-sweep', { disable: true });
          let fbB = await hookB('freshness', { recompute: true, tick: true });
          assert(fbB.needed === false, `B idle (only undated access) ${J(fbB)}`);
          r = await ops(tAdmin, U('mash'), [{ op: 'set_until', venueId: V3, until: '2026-10-23' }], await revOf(U('mash')));
          assert(r.status === 200, `A sets an end date ${r.status} ${r.text.slice(0, 120)}`);
          fbB = await hookB('freshness', { tick: true, advanceMonoMs: 15000 });
          assert(fbB.tick === 'idle' && fbB.needed === false, `B has not read yet (idle cadence) ${J(fbB)}`);
          fbB = await hookB('freshness', { tick: true, advanceMonoMs: 300000 });
          assert(String(fbB.tick).startsWith('idle-read') && fbB.needed === true, `B reads within 5 min and installs the end date ${J(fbB)}`);
          await hookB('clock', { iso: '2026-10-24T04:00:00.000Z' });
          assert(taskIds(await tasksAt(tMashB, V3, Bu)).length === 0, 'B enforces the end date A set');
          await hookB('clock', { iso: null });
          fbB = await hookB('freshness', { tick: true });
          assert(!String(fbB.tick).startsWith('idle'), `B now at the 15 s cadence (temporary access in play) ${J(fbB)}`);
          const wsB = openWs(tMashB, null, Bu);
          await wsB.until(() => wsB.count('INITIAL_STATE') > 0, 8000);
          r = await ops(tAdmin, U('mash'), [{ op: 'remove', venueId: V3 }], await revOf(U('mash')));
          assert(r.status === 200, 'A unticks');
          let fb = await call(Bu, 'POST', '/api/__test__/freshness', ctx.authHeaders, { refreshNow: true });
          assert(fb.json?.refresh?.result === 'installed', `B installs within one refresh ${J(fb.json)}`);
          assert(taskIds(await tasksAt(tMashB, V3, Bu)).length === 0, 'B enforces the untick');
          await wsB.until(() => wsB.count('SCOPE_CHANGED') > 0, 5000);
          assert(wsB.count('SCOPE_CHANGED') === 1, 'B notifies its own socket');
          // reverse: B grants, A sees after one refresh
          const revB = (await (await fetch(`${Bu}/api/__test__/grant-record/${U('mash')}`, { headers: ctx.authHeaders })).json()).venueRev;
          r = await ops(tAdminS, U('mash'), [{ op: 'add', venueId: V3, until: null }], revB, Bu);
          assert(r.status === 200, `B grants ${r.status} ${r.text.slice(0, 160)}`);
          fb = await call(baseUrl, 'POST', '/api/__test__/freshness', ctx.authHeaders, { refreshNow: true });
          assert(fb.json?.refresh?.result === 'installed', 'A installs');
          assert(J(taskIds(await tasksAt(tMash, V3))) === J([`task-t81-3-${ts}`]), 'A enforces the grant');
          wsB.close();
          // a kiosk code reset on A reaches B within one refresh
          const PIN2 = '8264';
          x = await call(baseUrl, 'PUT', `/api/users/${U('mash2')}`, auth(tAdmin), { kioskPin: PIN2, expectedVersion: await ctx.getVersion() });
          assert(x.status === 200, `set mash2 code ${x.status} ${x.text.slice(0, 120)}`);
          await call(Bu, 'POST', '/api/__test__/freshness', ctx.authHeaders, { refreshNow: true });
          await call(Bu, 'POST', '/api/__test__/kiosk-clear-lockouts', auth(tAdminS));
          const klB = await call(Bu, 'POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': devOuter.header }, { userId: U('mash2'), pin: PIN2 });
          assert(klB.status === 200 && klB.json?.token, `kiosk login on B ${klB.status} ${klB.text.slice(0, 120)}`);
          const authKB = { ...auth(klB.json.token), 'X-Kiosk-Device': devOuter.header };
          assert((await call(Bu, 'GET', '/api/tasks', authKB)).status === 200, 'B kiosk works');
          x = await call(baseUrl, 'PUT', `/api/users/${U('mash2')}`, auth(tAdmin), { kioskPin: '8399', expectedVersion: await ctx.getVersion() });
          assert(x.status === 200, `reset code on A ${x.status}`);
          fb = await call(Bu, 'POST', '/api/__test__/freshness', ctx.authHeaders, { refreshNow: true });
          assert(fb.json?.refresh?.result === 'installed', 'B installs the reset');
          assert((await call(Bu, 'GET', '/api/tasks', authKB)).status === 401, 'B refuses the old kiosk session after the reset');
          details.push('J two processes: untick on A enforced + notified on B in one refresh; reverse direction');
        } finally {
          await second.stop();
        }
      }
    }
    console.log('  ' + details.join('\n  '));
  },
};
