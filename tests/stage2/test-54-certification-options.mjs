/**
 * Test 54 (item V1, "V1 plan v2"): per-agency certification options.
 *
 * Proves on the real server and emulator:
 *  1 nothing stored → the defaults (Glatt meat / Dairy / DE / Parve) on
 *    GET /api/agencies and GET /api/agencies/current (admin and mashgiach)
 *  2 an admin PUT /api/agency/certification-options replaces the list
 *    (trimmed, de-duplicated); the actual AGENCY_UPDATED payload: admin and
 *    mashgiach sockets of agency A carry exactly the new list, the
 *    mashgiach payload has no admin-only field; agency B gets nothing of A
 *  3 refusals: coordinator 403, mashgiach 403; malformed bodies 400 with the
 *    doc version unchanged; stale expectedOptions 409; agency B's admin
 *    changes only B
 *  4 PUT /api/agencies/current keeps the list; the stored seal is untouched
 *  5 a new venue without certification text gets the agency NAME; with
 *    text, the text as typed
 *  6 the list survives a restart
 */
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const J = (x) => JSON.stringify(x);
const DEFAULTS = ['Glatt meat', 'Dairy', 'DE', 'Parve'];

export default {
  name: 'Test 54: certification options per agency (V1)',
  whatItProves:
    'Each agency has its own certification options (defaults until an admin saves a list); only a freshly authorized admin of that agency can replace them, malformed or stale writes change nothing, every agency view and broadcast carries the computed list without new private fields, other agencies are never touched, and new venues default to the agency name.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t54a-${ts}`, B = `agency-t54b-${ts}`;
    const VA = `venue-t54a-${ts}`, VB = `venue-t54b-${ts}`;
    const U = (k) => `user-t54-${k}-${ts}`;
    const E = (k) => `t54-${k}-${ts}@test.local`;
    const PW = 'stage2-t54-password';
    const SEAL_A = `T54 A ${ts} - Glatt Meat & Mehadrin`;
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const write = async (method, path, token, body) => call(method, path, auth(token), { ...body, expectedVersion: await ctx.getVersion() });
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
    const agencyDoc = async (id) => ((await ctx.getDoc()).agencies || []).find((a) => a.id === id);

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T54 A ${ts}`, shortCode: 'T54A', adminEmail: E('adminA'), certificationSeal: SEAL_A, region: 'R' },
        { id: B, name: `T54 B ${ts}`, shortCode: 'T54B', adminEmail: E('adminB'), certificationSeal: 'T54 B seal', region: 'R' },
      ],
      venues: [{ id: VA, name: 'T54 VA', agencyId: A }, { id: VB, name: 'T54 VB', agencyId: B }],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T54 Admin A', role: 'admin', agencyId: A },
        { id: U('adminA2'), email: E('adminA2'), name: 'T54 Admin A2', role: 'admin', agencyId: A },
        { id: U('coordA'), email: E('coordA'), name: 'T54 Coord A', role: 'coordinator', agencyId: A, venueId: VA },
        { id: U('mashA'), email: E('mashA'), name: 'T54 Mash A', role: 'mashgiach', agencyId: A, venueId: VA },
        { id: U('adminB'), email: E('adminB'), name: 'T54 Admin B', role: 'admin', agencyId: B },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'adminA2', 'coordA', 'mashA', 'adminB']) await hook('set-password', { userId: U(k), password: PW });
    const tAdminA2 = await login('adminA2');
    const tAdminA = await login('adminA'), tCoordA = await login('coordA'), tMashA = await login('mashA'), tAdminB = await login('adminB');
    const optsVia = async (tok) => {
      const a = await call('GET', '/api/agencies', auth(tok));
      const c = await call('GET', '/api/agencies/current', auth(tok));
      assert(a.status === 200 && c.status === 200, `agency reads ${a.status} ${c.status}`);
      return { list: a.json?.agencies?.[0]?.certificationOptions, current: c.json?.agency?.certificationOptions, currentAgency: c.json?.agency };
    };

    // ---- 1. defaults ----
    for (const [label, tok] of [['admin', tAdminA], ['mashgiach', tMashA], ['agency B admin', tAdminB]]) {
      const o = await optsVia(tok);
      assert(J(o.list) === J(DEFAULTS) && J(o.current) === J(DEFAULTS), `defaults for ${label}: ${J(o)}`);
    }
    assert((await optsVia(tMashA)).currentAgency.adminEmail === undefined, 'mashgiach agency view has no adminEmail');

    // ---- 2. admin replaces the list; the actual broadcast payloads ----
    const connectWs = (tok) => new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${tok}`);
      const conn = { ws, messages: [] };
      const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
      ws.onmessage = (ev) => { try { conn.messages.push(JSON.parse(String(ev.data))); } catch {} if (conn.messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); } };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WS error ${e?.message || ''}`)); };
    });
    const waitType = async (conn, type, ms = 15000) => {
      const t0 = Date.now();
      for (;;) { const hit = conn.messages.find((m) => m.type === type); if (hit) return hit; if (Date.now() - t0 > ms) return null; await new Promise((res) => setTimeout(res, 200)); }
    };
    const NEW = ['Dairy', 'Fish', 'Yoshon bakery'];
    const conns = { admin: await connectWs(tAdminA), mash: await connectWs(tMashA), adminB: await connectWs(tAdminB) };
    try {
      for (const c of Object.values(conns)) c.messages.length = 0;
      r = await write('PUT', '/api/agency/certification-options', tAdminA, { options: ['  Dairy ', 'Fish', 'dairy', 'Yoshon   bakery'], expectedOptions: DEFAULTS });
      assert(r.status === 200 && J(r.json?.certificationOptions) === J(NEW) && J(r.json?.agency?.certificationOptions) === J(NEW), `admin PUT ${r.status} ${r.text.slice(0, 200)}`);
      const ua = await waitType(conns.admin, 'AGENCY_UPDATED');
      assert(ua && ua.payload?.agency?.id === A && J(ua.payload.agency.certificationOptions) === J(NEW), `admin AGENCY_UPDATED ${J(ua).slice(0, 200)}`);
      const um = await waitType(conns.mash, 'AGENCY_UPDATED');
      assert(um && J(um.payload?.agency?.certificationOptions) === J(NEW), `mashgiach AGENCY_UPDATED ${J(um).slice(0, 200)}`);
      for (const k of ['adminEmail', 'createdAt', 'customDomain', 'domainStatus', 'domainVerificationToken']) assert(um.payload.agency[k] === undefined, `mashgiach payload must not carry ${k}`);
      await new Promise((res) => setTimeout(res, 1000));
      assert(!conns.adminB.messages.some((m) => J(m).includes(A) || J(m).includes('Yoshon')), `agency B saw A's update ${J(conns.adminB.messages).slice(0, 200)}`);
    } finally {
      for (const c of Object.values(conns)) { try { c.ws.close(); } catch {} }
    }
    for (const tok of [tAdminA, tMashA]) {
      const o = await optsVia(tok);
      assert(J(o.list) === J(NEW) && J(o.current) === J(NEW), `reads after PUT ${J(o)}`);
    }
    assert(J((await agencyDoc(A)).certificationOptions) === J(NEW), 'stored list');
    assert(J((await optsVia(tAdminB)).list) === J(DEFAULTS), 'B still on defaults');

    // ---- 3. refusals ----
    let v0 = await ctx.getVersion();
    for (const [label, tok] of [['coordinator', tCoordA], ['mashgiach', tMashA]]) {
      r = await write('PUT', '/api/agency/certification-options', tok, { options: ['Evil'] });
      assert(r.status === 403, `${label} must be 403, got ${r.status}`);
    }
    for (const [bad, why] of [
      [{ options: 'Dairy' }, 'not a list'], [{ options: ['ok', 7] }, 'non-string'], [{ options: ['ok', ''] }, 'empty label'],
      [{ options: ['x'.repeat(61)] }, '61 chars'], [{ options: Array.from({ length: 26 }, (_, i) => `o${i}`) }, '26 items'],
      [{}, 'missing options'], [{ options: ['ok'], expectedOptions: 'x' }, 'bad expectedOptions'],
    ]) {
      r = await write('PUT', '/api/agency/certification-options', tAdminA, bad);
      assert(r.status === 400, `${why} must be 400, got ${r.status} ${r.text.slice(0, 120)}`);
    }
    assert((await ctx.getVersion()) === v0, 'refused requests must not write');
    r = await write('PUT', '/api/agency/certification-options', tAdminA, { options: ['Other'], expectedOptions: DEFAULTS });
    assert(r.status === 409, `stale expectedOptions must be 409, got ${r.status} ${r.text.slice(0, 120)}`);
    assert(J((await agencyDoc(A)).certificationOptions) === J(NEW), 'stale write changed nothing');
    r = await write('PUT', '/api/agency/certification-options', tAdminB, { options: ['B only'] });
    assert(r.status === 200, `agency B admin PUT ${r.status}`);
    assert(J((await agencyDoc(B)).certificationOptions) === J(['B only']) && J((await agencyDoc(A)).certificationOptions) === J(NEW), 'B admin changes only B');
    // fresh re-check: an admin demoted in the committed doc only (the in-memory
    // copy still says admin) is refused 403 with a still-valid session; no write.
    const doc3 = await ctx.getDoc();
    const demotedUsers = (doc3.users || []).map((u) => (u.id === U('adminA2') ? { ...u, role: 'coordinator' } : u));
    const ds = await ctx.api('POST', '/api/__test__/doc-set-users', { users: demotedUsers });
    assert(ds.status === 200, `doc-set-users ${ds.status}`);
    r = await write('PUT', '/api/agency/certification-options', tAdminA2, { options: ['Demoted'] });
    assert(r.status === 403, `demoted admin must be 403, got ${r.status} ${r.text.slice(0, 120)}`);
    assert(J((await agencyDoc(A)).certificationOptions) === J(NEW), 'demoted admin changed nothing');

    // ---- 4. the settings PUT keeps the list; the stored seal is untouched ----
    r = await write('PUT', '/api/agencies/current', tAdminA, { region: 'R2', certificationOptions: ['Smuggled'] });
    assert(r.status === 200, `agency settings PUT ${r.status} ${r.text.slice(0, 120)}`);
    const aDoc = await agencyDoc(A);
    assert(J(aDoc.certificationOptions) === J(NEW) && aDoc.region === 'R2', `settings PUT must not touch the list ${J(aDoc).slice(0, 200)}`);
    assert(aDoc.certificationSeal === SEAL_A, `stored seal must be untouched: ${aDoc.certificationSeal}`);

    // ---- 5. new venue defaults to the agency name ----
    r = await write('POST', '/api/venues', tAdminA, { name: `T54 new ${ts}` });
    assert(r.status === 201 || r.status === 200, `create venue ${r.status} ${r.text.slice(0, 160)}`);
    assert(r.json?.venue?.certification === `T54 A ${ts}`, `default certification = agency name, got ${J(r.json?.venue?.certification)}`);
    r = await write('POST', '/api/venues', tAdminA, { name: `T54 typed ${ts}`, certification: '  T54 A · Dairy  ' });
    assert(r.json?.venue?.certification === 'T54 A · Dairy', `typed certification kept, got ${J(r.json?.venue?.certification)}`);

    // ---- 6. restart ----
    if (typeof ctx.restartServer === 'function') {
      await ctx.restartServer();
      const tA2 = await login('adminA');
      assert(J((await optsVia(tA2)).list) === J(NEW), 'list survives restart');
      assert((await agencyDoc(A)).certificationSeal === SEAL_A, 'seal survives restart unchanged');
    }
    return 'defaults until saved; admin-only, agency-scoped, normalised replace; real AGENCY_UPDATED payloads (admin + mashgiach carry the list, no admin-only field to staff, nothing to agency B); 403/400/409 write nothing (incl. a demoted admin, fresh re-check); settings PUT keeps the list and the stored seal; new venue defaults to agency name; survives restart';
  },
};
