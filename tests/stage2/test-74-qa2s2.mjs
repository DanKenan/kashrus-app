/**
 * Test 74 (QA2S2, Don 2026-10-22, "Agreed" DS2): server batch 2.
 *  A  #15 changing your password signs out your OTHER sessions: a single-row
 *     person (two phone tokens, an open socket, a kiosk session) and a legacy
 *     row with no personId and a plain kiosk PIN — the other token 401, the
 *     socket closed 4401, the kiosk token 401 + kiosk socket closed, the
 *     response token works, the SAME PIN signs in again at the tablet; a wrong
 *     current password bumps nothing.
 *  B  #9 who may create / copy / edit the definition of / delete events: admin
 *     (own agency), coordinator (own venues), owner (own venue); mashgiach,
 *     unknown role, out-of-scope callers and kiosk 403 EVENT_FORBIDDEN, nothing
 *     written; a task-only save by the venue's mashgiach still works; a caller
 *     demoted in the STORED doc only is refused (fresh re-check). #26: tasks: []
 *     creates no starter tasks; tasks missing adds the starters.
 *  C  #27 PUT /api/agency/settings: admin own agency (name, phone, time zone),
 *     validation 400s, unknown field 400, non-admin / kiosk 403, fresh re-check,
 *     another agency untouched, broadcast to the agency only.
 *  D  #31 POST /api/events/:id/notify: who (403/404), no assignee 409, push to
 *     the assignee only (attempted 0 without a device, 1 with one), two
 *     concurrent calls -> exactly one 200 + one 429, again after 61 s -> 200.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
async function call(baseUrl, method, path, token, body, extra = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...(token ? auth(token) : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function openWs(url) {
  const ws = new WebSocket(url);
  const conn = { ws, raw: [], closeCode: null, open: false };
  ws.onopen = () => { conn.open = true; };
  ws.onmessage = (ev) => { conn.raw.push(String(ev.data)); };
  ws.onclose = (ev) => { conn.closeCode = ev.code; };
  ws.onerror = () => {};
  conn.close = () => { try { ws.close(); } catch {} };
  conn.types = () => conn.raw.map((r) => { try { return JSON.parse(r).type; } catch { return null; } });
  return conn;
}
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  return pred();
}

export default {
  name: 'Test 74: QA2S2 — password change signs out other sessions; event permissions; agency settings; notify again',
  whatItProves:
    'Changing a password ends every other phone and kiosk session of the person (the changing device keeps a fresh token; the same PIN works again); only admins, coordinators (own venues) and owners (own venue) create, copy, edit or delete events, re-checked on fresh data; tasks: [] creates no starter tasks; the agency settings route is admin-only, validated and agency-scoped; notify-again reaches only the assignee, at most once a minute.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t74a-${ts}`, B = `agency-t74b-${ts}`;
    const vA1 = `venue-t74a1-${ts}`, vA2 = `venue-t74a2-${ts}`, vB = `venue-t74b-${ts}`;
    const U = (k) => `user-t74-${k}-${ts}`;
    const E = (k) => `t74-${k}-${ts}@test.local`;
    const row = (k, role, agencyId, venueId, extra = {}) => ({ id: U(k), email: E(k), name: `T74 ${k}`, role, agencyId, ...(venueId ? { venueId } : {}), avatarColor: 'bg-gold', ...extra });
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: 'T74 A', timeZone: 'America/New_York' }, { id: B, name: 'T74 B', timeZone: 'America/New_York' }],
      venues: [{ id: vA1, name: `T74 A1 ${ts}`, agencyId: A }, { id: vA2, name: `T74 A2 ${ts}`, agencyId: A }, { id: vB, name: `T74 B ${ts}`, agencyId: B }],
      users: [
        row('adA', 'admin', A, null, { personId: U('adA') }),
        row('adB', 'admin', B, null, { personId: U('adB') }),
        row('coA', 'coordinator', A, vA1, { personId: U('coA') }),
        row('owA', 'owner', A, vA1, { personId: U('owA') }),
        row('owA2', 'owner', A, vA2, { personId: U('owA2') }),
        row('mA', 'mashgiach', A, vA1, { personId: U('mA') }),
        row('xA', 'viewer', A, vA1, { personId: U('xA') }),
        row('pS', 'mashgiach', A, vA1, { personId: U('pS'), password: 'OldPass-74s' }),
      ],
    });
    if (inj.status !== 200) throw new Error(`inject: ${inj.status} ${JSON.stringify(inj.json)}`);
    // N4: the assignee's own membership in ANOTHER agency (same person, same
    // email), stored FIRST, so an email-only lookup would find the wrong row.
    // Planted store-only (inject refuses to create a group), then one commit
    // hydrates the cache (same pattern as A2).
    {
      const us0 = (await ctx.getDoc()).users;
      const mArow = us0.find((u) => u.id === U('mA'));
      if (!mArow) throw new Error('N4: mA row missing');
      const mB = { ...mArow, id: U('mB'), name: 'T74 mB', agencyId: B, venueId: vB };
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: [mB, ...us0] })).status !== 200) throw new Error('N4 plant');
      if ((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t74-n4-${ts}`, name: 'T74 n4', agencyId: B }] })).status !== 200) throw new Error('N4 rehydrate');
    }
    const doc = () => ctx.getDoc();
    const ver = () => ctx.getVersion();
    const tok = {};
    for (const k of ['adA', 'adB', 'coA', 'owA', 'owA2', 'mA', 'xA']) tok[k] = await mintToken(baseUrl, U(k));
    const details = [];
    const unchanged = async (v0, label) => { const v1 = await ver(); if (v1 !== v0) throw new Error(`${label}: version moved ${v0} -> ${v1}`); };
    const op = () => crypto.randomUUID();

    // Kiosk tablet at vA1 (used for A and for the kiosk refusals of B/C/D).
    const setPin = async (userId, pin) => {
      const r = await call(baseUrl, 'PUT', `/api/users/${userId}`, tok.adA, { kioskPin: pin, expectedVersion: await ver(), operationId: op() });
      if (r.status !== 200) throw new Error(`set PIN ${userId}: ${r.status} ${JSON.stringify(r.json)}`);
    };
    await setPin(U('mA'), '5151');
    await setPin(U('pS'), '4321');
    const clear = await call(baseUrl, 'POST', '/api/__test__/kiosk-clear-lockouts', tok.adA);
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const start = await (await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const pair = await call(baseUrl, 'POST', '/api/kiosk/devices/pair', tok.adA, { code: start.code, venueId: vA1 });
    if (pair.status !== 201) throw new Error(`pair: ${pair.status} ${JSON.stringify(pair.json)}`);
    const claim = await (await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.pairingId}.${start.deviceSecret}` } })).json();
    const dev = `${claim.device.id}.${start.deviceSecret}`;
    const kioskLogin = async (userId, pin) => {
      const r = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev }, body: JSON.stringify({ userId, pin }) });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, token: j.token };
    };
    const kGet = (token) => fetch(`${baseUrl}/api/tasks`, { headers: { ...auth(token), 'X-Kiosk-Device': dev } }).then((r) => r.status);
    const kCall = (token, method, path, body) => call(baseUrl, method, path, token, body, { 'X-Kiosk-Device': dev });
    const kmA = await kioskLogin(U('mA'), '5151');
    if (kmA.status !== 200) throw new Error(`kiosk login mA: ${kmA.status}`);

    // ---------------- A: #15 change-password ----------------
    {
      const stored = (id) => doc().then((d) => d.users.find((u) => u.id === id));
      // A1 single-row person: two phone tokens, a socket, a kiosk session.
      const t1 = await mintToken(baseUrl, U('pS'));
      const t2 = await mintToken(baseUrl, U('pS'));
      const ws1 = openWs(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(t1)}`);
      const k1 = await kioskLogin(U('pS'), '4321');
      if (k1.status !== 200) throw new Error(`A1 kiosk login: ${k1.status}`);
      const kws = openWs(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(k1.token)}&device=${encodeURIComponent(dev)}`);
      await waitFor(() => ws1.open);
      await waitFor(() => kws.open || kws.closeCode !== null, 1500);
      const kwsWasOpen = kws.open;
      if (!kwsWasOpen) throw new Error(`A1 the kiosk socket did not open (close ${kws.closeCode})`);
      if ((await kGet(k1.token)) !== 200) throw new Error('A1 kiosk session before');
      // wrong current password: nothing bumped
      const before = await stored(U('pS'));
      const v0 = await ver();
      const wrong = await call(baseUrl, 'POST', '/api/auth/change-password', t2, { currentPassword: 'nope-nope', newPassword: 'NewPass-74s!!' });
      if (wrong.status !== 401 || wrong.json?.code !== 'CURRENT_PASSWORD_WRONG') throw new Error(`A1 wrong current: ${wrong.status} ${JSON.stringify(wrong.json)}`);
      await unchanged(v0, 'A1 wrong current');
      if ((await call(baseUrl, 'GET', '/api/tasks', t1)).status !== 200) throw new Error('A1 t1 died on a wrong current password');
      const ch = await call(baseUrl, 'POST', '/api/auth/change-password', t2, { currentPassword: 'OldPass-74s', newPassword: 'NewPass-74s!!' });
      if (ch.status !== 200 || typeof ch.json?.token !== 'string' || !ch.json.token) throw new Error(`A1 change: ${ch.status} ${JSON.stringify(ch.json)}`);
      const after = await stored(U('pS'));
      if ((after.tokenEpoch || 0) !== (before.tokenEpoch || 0) + 1) throw new Error(`A1 tokenEpoch ${before.tokenEpoch} -> ${after.tokenEpoch}`);
      if ((after.kioskPinRev || 0) !== (before.kioskPinRev || 0) + 1 || after.kioskPinHash !== before.kioskPinHash) throw new Error(`A1 kiosk rev ${before.kioskPinRev} -> ${after.kioskPinRev}, hash kept ${after.kioskPinHash === before.kioskPinHash}`);
      if ((await call(baseUrl, 'GET', '/api/tasks', t1)).status !== 401) throw new Error('A1 the other phone token still works');
      if ((await call(baseUrl, 'GET', '/api/tasks', t2)).status !== 401) throw new Error('A1 the changing token (old) still works');
      if ((await call(baseUrl, 'GET', '/api/tasks', ch.json.token)).status !== 200) throw new Error('A1 the response token does not work');
      if (!(await waitFor(() => ws1.closeCode !== null))) throw new Error('A1 the phone socket stayed open');
      if (ws1.closeCode !== 4401) throw new Error(`A1 phone socket close ${ws1.closeCode}`);
      if ((await kGet(k1.token)) !== 401) throw new Error('A1 the kiosk token still works');
      if (kwsWasOpen) {
        if (!(await waitFor(() => kws.closeCode !== null))) throw new Error('A1 the kiosk socket stayed open');
        if (kws.closeCode !== 4401) throw new Error(`A1 kiosk socket close ${kws.closeCode}`);
      }
      const k2 = await kioskLogin(U('pS'), '4321');
      if (k2.status !== 200 || (await kGet(k2.token)) !== 200) throw new Error(`A1 same PIN again: ${k2.status}`);
      ws1.close(); kws.close();
      details.push(`A1 single-row: other token 401, socket 4401, kiosk 401${kwsWasOpen ? ' + kiosk socket 4401' : ''}, response token works, same PIN signs in again; wrong current bumps nothing`);

      // A2 legacy row (no personId, plain kiosk PIN, v1 tokens), written
      // directly (pre-8b data, as Test 49 does), then one commit hydrates the cache.
      {
        const us = [...(await doc()).users, row('pL', 'mashgiach', A, vA1, { password: 'OldPass-74l', kioskPin: '2718' })];
        if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: us })).status !== 200) throw new Error('A2 plant legacy');
        if ((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t74-sync-${ts}`, name: 'T74 sync', agencyId: B }] })).status !== 200) throw new Error('A2 rehydrate');
      }
      const l1 = await mintToken(baseUrl, U('pL'));
      const l2 = await mintToken(baseUrl, U('pL'));
      const kl = await kioskLogin(U('pL'), '2718');
      if (kl.status !== 200) throw new Error(`A2 kiosk login legacy PIN: ${kl.status}`);
      const lb = await stored(U('pL'));
      if (lb.personId) throw new Error('A2 fixture already migrated');
      const chl = await call(baseUrl, 'POST', '/api/auth/change-password', l2, { currentPassword: 'OldPass-74l', newPassword: 'NewPass-74l!!' });
      if (chl.status !== 200 || !chl.json?.token) throw new Error(`A2 change: ${chl.status} ${JSON.stringify(chl.json)}`);
      const la = await stored(U('pL'));
      if (la.personId !== U('pL')) throw new Error(`A2 not migrated: ${la.personId}`);
      if ((la.tokenEpoch || 0) !== 1) throw new Error(`A2 tokenEpoch ${la.tokenEpoch}`);
      if ((la.kioskPinRev || 0) !== (lb.kioskPinRev || 0) + 1) throw new Error(`A2 kiosk rev ${lb.kioskPinRev} -> ${la.kioskPinRev}`);
      if ((await call(baseUrl, 'GET', '/api/tasks', l1)).status !== 401) throw new Error('A2 the other (v1) token still works');
      if ((await call(baseUrl, 'GET', '/api/tasks', chl.json.token)).status !== 200) throw new Error('A2 the response token does not work');
      if ((await kGet(kl.token)) !== 401) throw new Error('A2 the kiosk token still works');
      const kl2 = await kioskLogin(U('pL'), '2718');
      if (kl2.status !== 200) throw new Error(`A2 same PIN again: ${kl2.status}`);
      details.push('A2 legacy row: migrated + bumped in the same commit, v1 token 401, kiosk 401, same PIN works');
    }

    // ---------------- B: #9 event permissions + #26 ----------------
    const evBody = (venueId, extra = {}) => ({ title: `T74 event ${Math.random().toString(36).slice(2, 7)}`, location: 'Hall', date: '2031-05-01', venueId, ...extra });
    const create = (k, body) => call(baseUrl, 'POST', '/api/events', tok[k], { ...body, operationId: op() });
    const forbidden = (r, label) => {
      // MANAGER RV1: xA's stored role 'viewer' is unknown to the server, so it
      // now gets no session at all (401) — stronger than the old 403.
      if (/\bxA\b/.test(label) && r.status === 401) return;
      if (r.status !== 403) throw new Error(`${label}: expected 403, got ${r.status} ${JSON.stringify(r.json)}`);
      if (r.json?.code !== undefined && r.json.code !== 'EVENT_FORBIDDEN' && r.json.code !== 'KIOSK_SCOPE') throw new Error(`${label}: code ${r.json.code}`);
    };
    {
      for (const [k, v] of [['adA', vA1], ['adA', vA2], ['coA', vA1], ['owA', vA1], ['owA2', vA2]]) {
        const r = await create(k, evBody(v));
        if (r.status !== 201) throw new Error(`B create ${k}@${v}: ${r.status} ${JSON.stringify(r.json)}`);
      }
      let v0 = await ver();
      for (const [k, v] of [['mA', vA1], ['xA', vA1], ['coA', vA2], ['owA', vA2], ['owA2', vA1], ['adB', vA1]]) {
        const r = await create(k, evBody(v));
        forbidden(r, `B create ${k}@${v}`);
        if (r.json?.code !== 'EVENT_FORBIDDEN' && k !== 'adB' && !(k === 'xA' && r.status === 401)) throw new Error(`B create ${k}: code ${r.json?.code}`);
      }
      forbidden(await kCall(kmA.token, 'POST', '/api/events', { ...evBody(vA1), operationId: op() }), 'B create kiosk');
      await unchanged(v0, 'B create refusals');
      // #26
      const empty = await create('adA', evBody(vA1, { tasks: [] }));
      if (empty.status !== 201 || !Array.isArray(empty.json?.event?.tasks) || empty.json.event.tasks.length !== 0) throw new Error(`B #26 tasks: [] -> ${empty.status} ${JSON.stringify(empty.json?.event?.tasks)}`);
      const dflt = await create('adA', evBody(vA1));
      if (!(dflt.json?.event?.tasks?.length >= 1)) throw new Error('B #26 tasks missing -> no starters');
      // RV1 N1: a supplied tasks value that is not a list is refused, nothing written
      v0 = await ver();
      for (const bad of [null, {}, 'x']) {
        const r = await create('adA', evBody(vA1, { tasks: bad }));
        if (r.status !== 400 || r.json?.code !== 'EVENT_TASKS_INVALID') throw new Error(`B #26 tasks: ${JSON.stringify(bad)} -> ${r.status} ${JSON.stringify(r.json)}`);
      }
      await unchanged(v0, 'B #26 invalid tasks');
      details.push(`B create: admin/coordinator(own)/owner(own) 201; mashgiach, unknown role, out-of-scope, other agency, kiosk 403, nothing written; #26 tasks: [] -> 0 tasks, missing -> ${dflt.json.event.tasks.length} starters, null/{}/'x' -> 400 nothing written`);

      // an event at vA1 assigned to mA
      const base = await create('adA', evBody(vA1, { mashgiachType: 'assigned_user', assignedMashgiachEmail: E('mA') }));
      if (base.status !== 201) throw new Error(`B base: ${base.status}`);
      const ev = base.json.event;
      // copy
      const cp = (k) => call(baseUrl, 'POST', `/api/events/${ev.id}/copy`, tok[k], { date: '2031-06-01', operationId: op() });
      for (const k of ['owA', 'coA', 'adA']) { const r = await cp(k); if (r.status !== 201) throw new Error(`B copy ${k}: ${r.status} ${JSON.stringify(r.json)}`); }
      v0 = await ver();
      for (const k of ['mA', 'xA', 'owA2']) { const r = await cp(k); forbidden(r, `B copy ${k}`); }
      await unchanged(v0, 'B copy refusals');
      // edit definition
      const cur = async () => (await doc()).events.find((e) => e.id === ev.id);
      const put = async (k, patch, kiosk = false) => {
        const e = await cur();
        const body = { ...e, ...patch, expectedVersion: await ver(), operationId: op() };
        return kiosk ? kCall(kmA.token, 'PUT', `/api/events/${ev.id}`, body) : call(baseUrl, 'PUT', `/api/events/${ev.id}`, tok[k], body);
      };
      const ro = await put('owA', { title: 'T74 renamed by owner' });
      if (ro.status !== 200) throw new Error(`B edit owner: ${ro.status} ${JSON.stringify(ro.json)}`);
      v0 = await ver();
      for (const k of ['mA', 'xA', 'owA2']) forbidden(await put(k, { title: `nope ${k}` }), `B edit ${k}`);
      forbidden(await put(null, { title: 'nope kiosk' }, true), 'B edit kiosk');
      await unchanged(v0, 'B edit refusals');
      // tasks-only save by the venue's mashgiach still works
      const e0 = await cur();
      const tasksFlipped = e0.tasks.map((t, i) => (i === 0 ? { ...t, isCompleted: !t.isCompleted } : t));
      const rt = await put('mA', { tasks: tasksFlipped });
      if (rt.status !== 200) throw new Error(`B tasks-only mashgiach: ${rt.status} ${JSON.stringify(rt.json)}`);
      details.push('B copy: owner/coordinator/admin 201, mashgiach/unknown/other-venue owner 403; edit definition: owner 200, mashgiach/unknown/other owner/kiosk 403; tasks-only save by the mashgiach 200');

      // fresh re-check: coordinator demoted in the STORED doc only
      const users0 = (await doc()).users;
      const demoted = users0.map((u) => (u.id === U('coA') ? { ...u, role: 'mashgiach' } : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: demoted })).status !== 200) throw new Error('B plant demotion');
      v0 = await ver();
      const snap0 = JSON.stringify((await doc()).events);
      const fc = await create('coA', evBody(vA1));
      forbidden(fc, 'B fresh create (coordinator demoted in store)');
      const fp = await call(baseUrl, 'PUT', `/api/events/${ev.id}`, tok.coA, { ...(await cur()), title: 'stale coord', expectedVersion: await ver(), operationId: op() });
      forbidden(fp, 'B fresh edit');
      const fd = await call(baseUrl, 'DELETE', `/api/events/${ev.id}`, tok.coA, { expectedVersion: await ver(), operationId: op() });
      forbidden(fd, 'B fresh delete');
      const fcp = await cp('coA');
      forbidden(fcp, 'B fresh copy');
      await unchanged(v0, 'B fresh refusals');
      if (JSON.stringify((await doc()).events) !== snap0) throw new Error('B fresh: events changed');
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: users0 })).status !== 200) throw new Error('B restore');
      details.push('B fresh re-check: a coordinator demoted in the stored doc only gets 403 on create/edit/delete/copy, nothing written');

      // RV1 B1: the event moved to ANOTHER agency in the stored doc only (the
      // cache still has agency A): a definition edit by the admin and a
      // tasks-only save by the assigned mashgiach both get 403, nothing written.
      const evs0 = (await doc()).events;
      const seen = evs0.find((e) => e.id === ev.id);
      const moved = evs0.map((e) => (e.id === ev.id ? { ...e, agencyId: B } : e));
      if ((await ctx.api('POST', '/api/__test__/doc-set-events', { events: moved })).status !== 200) throw new Error('B plant foreign agency');
      v0 = await ver();
      const snapMoved = JSON.stringify((await doc()).events);
      const fa1 = await call(baseUrl, 'PUT', `/api/events/${ev.id}`, tok.adA, { ...seen, title: 'stale agency admin', expectedVersion: await ver(), operationId: op() });
      if (fa1.status !== 403 || fa1.json?.code !== 'EVENT_FORBIDDEN') throw new Error(`B foreign-agency definition edit: ${fa1.status} ${JSON.stringify(fa1.json)}`);
      const flip2 = seen.tasks.map((t, i) => (i === 0 ? { ...t, isCompleted: !t.isCompleted } : t));
      const fa2 = await call(baseUrl, 'PUT', `/api/events/${ev.id}`, tok.mA, { ...seen, tasks: flip2, expectedVersion: await ver(), operationId: op() });
      if (fa2.status !== 403 || fa2.json?.code !== 'EVENT_FORBIDDEN') throw new Error(`B foreign-agency tasks-only save: ${fa2.status} ${JSON.stringify(fa2.json)}`);
      await unchanged(v0, 'B foreign-agency refusals');
      if (JSON.stringify((await doc()).events) !== snapMoved) throw new Error('B foreign-agency: events changed');
      if ((await ctx.api('POST', '/api/__test__/doc-set-events', { events: evs0 })).status !== 200) throw new Error('B restore events');
      details.push('B fresh agency: an event moved to another agency in the stored doc only -> definition edit and tasks-only save 403 EVENT_FORBIDDEN, nothing written');

      // delete
      const del = async (k, id) => call(baseUrl, 'DELETE', `/api/events/${id}`, tok[k], { expectedVersion: await ver(), operationId: op() });
      v0 = await ver();
      for (const k of ['mA', 'xA', 'owA2']) forbidden(await del(k, ev.id), `B delete ${k}`);
      forbidden(await kCall(kmA.token, 'DELETE', `/api/events/${ev.id}`, { expectedVersion: await ver(), operationId: op() }), 'B delete kiosk');
      await unchanged(v0, 'B delete refusals');
      const d2 = await create('owA', evBody(vA1));
      const dd = await del('owA', d2.json.event.id);
      if (dd.status !== 200 || (await doc()).events.some((e) => e.id === d2.json.event.id)) throw new Error(`B delete owner: ${dd.status}`);
      details.push('B delete: mashgiach/unknown/other owner/kiosk 403; owner 200 at own venue');

      // ---------------- D: #31 notify ----------------
      const notify = (k) => call(baseUrl, 'POST', `/api/events/${ev.id}/notify`, tok[k], {});
      await call(baseUrl, 'POST', '/api/__test__/push-log/clear', tok.adA);
      for (const k of ['mA', 'xA', 'owA2']) forbidden(await notify(k), `D notify ${k}`);
      forbidden(await kCall(kmA.token, 'POST', `/api/events/${ev.id}/notify`, {}), 'D notify kiosk');
      const nb = await notify('adB');
      if (nb.status !== 404) throw new Error(`D notify other agency: ${nb.status}`);
      const noAssignee = await create('adA', evBody(vA1));
      const na = await call(baseUrl, 'POST', `/api/events/${noAssignee.json.event.id}/notify`, tok.adA, {});
      if (na.status !== 409 || na.json?.code !== 'EVENT_NO_ASSIGNEE') throw new Error(`D no assignee: ${na.status} ${JSON.stringify(na.json)}`);
      // a refused notify does not use up the minute: assign, then notify -> 200
      const ne = (await doc()).events.find((e) => e.id === noAssignee.json.event.id);
      const asg = await call(baseUrl, 'PUT', `/api/events/${ne.id}`, tok.adA, { ...ne, mashgiachType: 'assigned_user', assignedMashgiachEmail: E('mA'), expectedVersion: await ver(), operationId: op() });
      if (asg.status !== 200) throw new Error(`D assign: ${asg.status} ${JSON.stringify(asg.json)}`);
      const na2 = await call(baseUrl, 'POST', `/api/events/${ne.id}/notify`, tok.adA, {});
      if (na2.status !== 200) throw new Error(`D notify after a refused one: ${na2.status} ${JSON.stringify(na2.json)}`);
      const n0 = await notify('owA');
      if (n0.status !== 200 || n0.json?.notified !== true || n0.json?.attempted !== 0) throw new Error(`D owner no device: ${n0.status} ${JSON.stringify(n0.json)}`);
      const soon = await notify('adA');
      if (soon.status !== 429 || soon.json?.code !== 'NOTIFY_TOO_SOON' || !(soon.json?.retryAfterSeconds >= 1)) throw new Error(`D second within 60 s: ${soon.status} ${JSON.stringify(soon.json)}`);
      // the assignee subscribes a device
      const sub = await call(baseUrl, 'POST', '/api/push/subscribe', tok.mA, { subscription: { endpoint: `https://push.test/t74-${ts}`, keys: { p256dh: 'x', auth: 'y' } } });
      if (sub.status !== 200) throw new Error(`D subscribe: ${sub.status}`);
      const clock = async (iso) => { const r = await ctx.api('POST', '/api/__test__/clock', { iso }); if (r.status !== 200) throw new Error('clock'); };
      try {
        await clock(new Date(Date.now() + 61_000).toISOString());
        await call(baseUrl, 'POST', '/api/__test__/push-log/clear', tok.adA);
        const [r1, r2] = await Promise.all([notify('coA'), notify('adA')]);
        const sts = [r1.status, r2.status].sort();
        if (sts[0] !== 200 || sts[1] !== 429) throw new Error(`D concurrent: ${r1.status} ${r2.status}`);
        const ok = r1.status === 200 ? r1 : r2;
        if (ok.json?.attempted !== 1) throw new Error(`D attempted: ${JSON.stringify(ok.json)}`);
        const log = (await call(baseUrl, 'GET', '/api/__test__/push-log', tok.adA)).json?.log || [];
        if (log.length !== 1 || log[0].recipientUserId !== U('mA')) throw new Error(`D push log: ${JSON.stringify(log)}`);
        await clock(new Date(Date.now() + 125_000).toISOString());
        const again = await notify('adA');
        if (again.status !== 200) throw new Error(`D after 61 s: ${again.status}`);
      } finally {
        await clock(null);
      }
      details.push('D notify: mashgiach/unknown/other owner/kiosk 403, other agency 404, no assignee 409, owner 200 attempted 0, again within 60 s 429, concurrent -> one 200 + one 429 with one push to the assignee only, after 61 s 200');
    }

    // ---------------- C: #27 agency settings ----------------
    {
      const S = (k, body) => call(baseUrl, 'PUT', '/api/agency/settings', tok[k], body);
      const wsA = openWs(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(tok.adA)}`);
      const wsB = openWs(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(tok.adB)}`);
      await waitFor(() => wsA.open && wsB.open);
      const agency = async (id) => (await doc()).agencies.find((a) => a.id === id);
      const bBefore = JSON.stringify(await agency(B));
      const r1 = await S('adA', { name: '  T74 Renamed  ', expectedVersion: await ver(), operationId: op() });
      if (r1.status !== 200 || r1.json?.agency?.name !== 'T74 Renamed') throw new Error(`C name: ${r1.status} ${JSON.stringify(r1.json)}`);
      const r2 = await S('adA', { contactPhone: '(860) 555-0100', timeZone: 'America/Chicago', expectedVersion: await ver(), operationId: op() });
      if (r2.status !== 200) throw new Error(`C phone+tz: ${r2.status} ${JSON.stringify(r2.json)}`);
      const a2 = await agency(A);
      if (a2.contactPhone !== '+18605550100' || a2.timeZone !== 'America/Chicago' || a2.name !== 'T74 Renamed') throw new Error(`C stored: ${JSON.stringify({ p: a2.contactPhone, tz: a2.timeZone, n: a2.name })}`);
      const r3 = await S('adA', { contactPhone: '', timeZone: null, expectedVersion: await ver(), operationId: op() });
      const a3 = await agency(A);
      if (r3.status !== 200 || a3.contactPhone !== '' || a3.timeZone !== undefined) throw new Error(`C clear: ${r3.status} ${JSON.stringify({ p: a3.contactPhone, tz: a3.timeZone })}`);
      if (!(await waitFor(() => wsA.types().includes('AGENCY_UPDATED')))) throw new Error('C no AGENCY_UPDATED to the agency');
      await sleep(200);
      if (wsB.types().includes('AGENCY_UPDATED')) throw new Error('C AGENCY_UPDATED reached another agency');
      const v0 = await ver();
      for (const [body, code, label] of [
        [{ timeZone: 'Mars/Olympus' }, 'SETTINGS_INVALID', 'bad zone'],
        [{ name: '   ' }, 'SETTINGS_INVALID', 'empty name'],
        [{ name: 'x'.repeat(101) }, 'SETTINGS_INVALID', 'long name'],
        [{ name: 'bad\u0007name' }, 'SETTINGS_INVALID', 'control char'],
        [{ name: 42 }, 'SETTINGS_INVALID', 'non-string name'],
        [{ contactPhone: 'call me' }, 'SETTINGS_INVALID', 'bad phone'],
        [{}, 'SETTINGS_INVALID', 'nothing'],
        [{ name: 'ok', slug: 'evil' }, 'SETTINGS_FIELD_UNKNOWN', 'unknown field'],
        [{ name: 'ok', agencyId: B }, 'SETTINGS_FIELD_UNKNOWN', 'agencyId in body'],
      ]) {
        const r = await S('adA', { ...body, expectedVersion: await ver(), operationId: op() });
        if (r.status !== 400 || r.json?.code !== code) throw new Error(`C ${label}: ${r.status} ${JSON.stringify(r.json)}`);
      }
      for (const k of ['coA', 'owA', 'mA']) {
        const r = await S(k, { name: `nope ${k}`, expectedVersion: await ver(), operationId: op() });
        if (r.status !== 403) throw new Error(`C ${k}: ${r.status}`);
      }
      const rk = await kCall(kmA.token, 'PUT', '/api/agency/settings', { name: 'kiosk', expectedVersion: await ver(), operationId: op() });
      if (rk.status !== 403) throw new Error(`C kiosk: ${rk.status}`);
      await unchanged(v0, 'C refusals');
      // fresh re-check: admin demoted in the stored doc only
      const users0 = (await doc()).users;
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: users0.map((u) => (u.id === U('adA') ? { ...u, role: 'coordinator', venueId: vA1 } : u)) })).status !== 200) throw new Error('C plant');
      const v1 = await ver();
      const rf = await S('adA', { name: 'stale admin', expectedVersion: await ver(), operationId: op() });
      if (rf.status !== 403) throw new Error(`C fresh: ${rf.status} ${JSON.stringify(rf.json)}`);
      await unchanged(v1, 'C fresh');
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: users0 })).status !== 200) throw new Error('C restore');
      if (JSON.stringify(await agency(B)) !== bBefore) throw new Error('C another agency changed');
      // A5: the old route type-checks name/contactPhone
      const vOld = await ver();
      const old = await call(baseUrl, 'PUT', '/api/agencies/current', tok.adA, { name: 42, expectedVersion: await ver(), operationId: op() });
      if (old.status !== 400 || old.json?.code !== 'SETTINGS_INVALID') throw new Error(`C A5 old route non-string name: ${old.status} ${JSON.stringify(old.json)}`);
      const oldP = await call(baseUrl, 'PUT', '/api/agencies/current', tok.adA, { name: 'T74 Renamed', contactPhone: 42, expectedVersion: await ver(), operationId: op() });
      if (oldP.status !== 400 || oldP.json?.code !== 'SETTINGS_INVALID') throw new Error(`C A5 old route non-string phone: ${oldP.status} ${JSON.stringify(oldP.json)}`);
      await unchanged(vOld, 'C A5 old route refusals');
      wsA.close(); wsB.close();
      details.push('C settings: admin 200 (name trimmed, phone normalized, zone canonical, clear), validation/unknown field 400, coordinator/owner/mashgiach/kiosk 403, fresh demotion 403, other agency untouched, broadcast to the agency only; old route 400 on a non-string name');
    }
    return details.join('; ');
  },
};
