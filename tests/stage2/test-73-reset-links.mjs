/**
 * Test 73 (10L): reset links (design v3, [10L-DS3] agreed; Don 2026-10-22:
 * no admin-to-admin links; coordinators only for their own venues' people).
 *  W  who may make a link: admin -> coordinator/mashgiach/owner 201; coordinator
 *     -> own-venue mashgiach/owner 201, out of scope / coordinator / admin 403;
 *     admin -> admin / primary admin / self 403; mashgiach / owner 403; kiosk 403;
 *     another agency's member 404; credentialPending / no password 409; nothing
 *     written on any refusal.
 *  N  making a link changes nothing (password, epoch, REST 200, WS open); a
 *     second link replaces the first (old dead at preview and accept).
 *  Q  "asked for a reset" list: admin and the in-scope coordinator see it, no
 *     code and no email; out-of-scope coordinator and mashgiach do not.
 *  A  accept: short password 400; success sets the password (old 401, new 200),
 *     origin agency-reset, recovery codes cleared, old token 401 + WS 4401, the
 *     answer's token works, reset requests gone (a verified code dies); reuse 404.
 *  E  expiry (test clock +25 h) 404 at preview and accept.
 *  M  member changed (email changed / promoted to admin) -> 404, link revoked member-changed.
 *  S  stale link: the person changed their password -> 404, revoked credential-changed, newer password works.
 *  P  multi person A+B+C (Option A): A's link pauses B and C everywhere (login
 *     lists only A, activate B 403, B phone token 401, B kiosk HTTP 401 + its open
 *     socket closed 4401, B kiosk PIN 403 / wrong PIN 401); A admin cannot
 *     confirm B (404); a body cannot clear it; a demoted B admin (store only)
 *     cannot; B admin confirms (row otherwise byte-identical) and B works again
 *     (phone + kiosk). C's admin resets the PAUSED C row -> C active, A and B
 *     paused by C; a link made before it dies by the stamp; A's admin resets the
 *     paused A row -> A active, B keeps its record (by C), C paused by A.
 *  F  fresh re-checks: coordinator demoted in the store only -> 403; member moved
 *     to another agency in the store only -> 404; nothing written.
 *  L  no raw token, hash, stamp or resetSuspended in GET payloads, the admin
 *     export or WS frames; preview carries only firstName, agencyName, expiresAt.
 *  C  capacity: 1000 live links -> 503, nothing dropped; a used record is dropped first.
 *  V  Send invite (10k) revokes a live reset link (member-changed); the member then gets 409.
 *  G  a legacy row (no personId): its v1 tokens die; migrated + bumped in the accept commit.
 *  R  public routes: one 404 body; per-IP 429 on preview.
 *  X  source pins: one eligibility rule; resetSuspended writers.
 */
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
function openWs(baseUrl, token, credential) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const conn = { ws, initial: false, closeCode: null, raw: [] };
  ws.onopen = () => { if (credential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential })); } catch {} } };
  ws.onmessage = (ev) => { conn.raw.push(String(ev.data)); if (String(ev.data).includes('"INITIAL_STATE"')) conn.initial = true; };
  ws.onclose = (ev) => { conn.closeCode = ev.code; };
  ws.onerror = () => {};
  conn.until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return pred(); };
  conn.close = () => { try { ws.close(); } catch {} };
  return conn;
}
async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }) });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return { id: claimed.device.id, header: `${claimed.device.id}.${deviceSecret}` };
}

export default {
  name: 'Test 73: reset links (10L)',
  whatItProves:
    'Admins (non-admin members) and coordinators (their own venues\' mashgichim/owners) can make a one-time 24 h reset link; making it changes nothing; using it sets the password, ends every old session and dies; stale, expired, replaced or changed-member links die; a multi-agency person\'s other memberships pause everywhere (kiosk included) until that agency\'s admin confirms, and a pause is never overwritten or cleared by another agency; nothing secret leaks.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t73a-${ts}`, B = `agency-t73b-${ts}`, C = `agency-t73c-${ts}`;
    const A1 = `venue-t73-a1-${ts}`, A2 = `venue-t73-a2-${ts}`, B1 = `venue-t73-b1-${ts}`, C1 = `venue-t73-c1-${ts}`;
    const U = (k) => `user-t73-${k}-${ts}`;
    const E = (k) => `t73-${k}-${ts}@test.local`;
    const PW = 'stage2-t73-password';
    const PIN = '7314';
    let ipN = 1;
    const ip = () => `10.73.${ts % 200}.${(ipN++ % 250) + 1}`;
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const doc = () => ctx.getDoc();
    const rows = async () => ((await doc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const linksOf = async (memberId) => ((await doc()).resetLinks || []).filter((l) => l.memberId === memberId);
    let hk = 0;
    const rehydrate = async () => assert((await hook('inject-fixture', { venues: [{ id: `venue-t73-h${hk++}-${Date.now()}`, name: 'T73 hydrate', agencyId: C }] })).status === 200, 'rehydrate');
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const make = async (t, id) => call('POST', `/api/users/${id}/reset-link`, auth(t), { expectedVersion: await ctx.getVersion() });
    const tokenOf = (link) => { const m = /^\/reset#t=([A-Za-z0-9_-]{43})$/.exec(link || ''); assert(m, `link shape ${link}`); return m[1]; };
    const preview = (raw, ipAddr) => call('GET', '/api/reset-links/preview', { 'X-Reset-Token': raw, 'X-Forwarded-For': ipAddr || ip() });
    const accept = (raw, newPassword) => call('POST', '/api/reset-links/accept', { ...jsonH, 'X-Reset-Token': raw, 'X-Forwarded-For': ip() }, { newPassword });
    const login = (email, password) => call('POST', '/api/auth/login', { ...jsonH, 'X-Forwarded-For': ip() }, { email, password });
    const confirm = async (t, id) => call('POST', `/api/users/${id}/confirm-reset`, auth(t), { expectedVersion: await ctx.getVersion() });
    const agencyGet = (t) => call('GET', '/api/agencies/current', auth(t));

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T73 A ${ts}`, timeZone: 'America/New_York', adminEmail: E('prim') },
        { id: B, name: `T73 B ${ts}`, timeZone: 'America/New_York' },
        { id: C, name: `T73 C ${ts}`, timeZone: 'America/New_York' },
      ],
      venues: [{ id: A1, name: `T73 A1 ${ts}`, agencyId: A }, { id: A2, name: `T73 A2 ${ts}`, agencyId: A }, { id: B1, name: `T73 B1 ${ts}`, agencyId: B }, { id: C1, name: `T73 C1 ${ts}`, agencyId: C }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T73 Admin A', role: 'admin', agencyId: A },
        { id: U('prim'), email: E('prim'), name: 'T73 Primary', role: 'admin', agencyId: A },
        { id: U('ad2'), email: E('ad2'), name: 'T73 Admin 2', role: 'admin', agencyId: A },
        { id: U('coA'), email: E('coa'), name: 'T73 Coord A1', role: 'coordinator', agencyId: A, venueId: A1 },
        { id: U('co2'), email: E('co2'), name: 'T73 Coord A2', role: 'coordinator', agencyId: A, venueId: A2 },
        { id: U('m'), email: E('m'), name: 'Mira T73 Target', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('o'), email: E('o'), name: 'T73 Owner', role: 'owner', agencyId: A, venueId: A1 },
        { id: U('m2'), email: E('m2'), name: 'T73 Mash A2', role: 'mashgiach', agencyId: A, venueId: A2 },
        { id: U('pend'), email: E('pend'), name: 'T73 Pending', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('nopw'), email: E('nopw'), name: 'T73 No password', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('s'), email: E('s'), name: 'T73 Stale', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('f'), email: E('f'), name: 'T73 Fresh', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('ch'), email: E('ch'), name: 'T73 Changes', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('pA'), email: E('p'), name: 'Pat T73 Multi', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('adB'), email: E('adb'), name: 'T73 Admin B', role: 'admin', agencyId: B },
        { id: U('mB'), email: E('mb'), name: 'T73 B member', role: 'mashgiach', agencyId: B, venueId: B1 },
        { id: U('adC'), email: E('adc'), name: 'T73 Admin C', role: 'admin', agencyId: C },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    for (const k of ['m', 'o', 'm2', 'pend', 's', 'f', 'ch', 'pA', 'co2', 'ad2', 'mB']) assert((await hook('set-password', { userId: U(k), password: PW })).status === 200, `set-password ${k}`);
    {
      const users = await rows();
      const pA = users.find((u) => u.id === U('pA'));
      const planted = users.map((u) => {
        if (u.id === U('pend')) { const { password, ...r } = u; return { ...r, credentialPending: 'invite' }; }
        if (u.id === U('m')) return { ...u, recoveryCodeHashes: ['t73-planted-hash'], credentialOrigin: 'admin' };
        if (u.id === U('pA')) return { ...u, credentialOwner: true, credentialOrigin: 'admin' };
        return u;
      });
      planted.push({ id: U('pB'), email: pA.email, name: 'Pat T73 in B', role: 'mashgiach', agencyId: B, venueId: B1, personId: pA.personId, avatarColor: '#64748b', kioskPin: PIN, permissions: { canFillTasks: true, canAssignTasks: false } });
      planted.push({ id: U('pC'), email: pA.email, name: 'Pat T73 in C', role: 'mashgiach', agencyId: C, venueId: C1, personId: pA.personId, avatarColor: '#64748b' });
      // [10L-RV1 B1]: a genuine legacy row (no personId), as before the 8c migration.
      planted.push({ id: U('lg'), email: E('lg'), name: 'T73 Legacy', role: 'mashgiach', agencyId: A, venueId: A1, avatarColor: '#64748b', permissions: { canFillTasks: true, canAssignTasks: false } });
      assert((await hook('doc-set-users', { users: planted })).status === 200, 'plant multi person + markers');
      await rehydrate();
      assert((await hook('set-password', { userId: U('lg'), password: PW })).status === 200, 'set-password lg');
      assert(!(await rowOf(U('lg'))).personId, 'lg is a legacy row');
    }
    const tA = await mintToken(baseUrl, U('adA'));
    const tCo = await mintToken(baseUrl, U('coA'));
    const tB = await mintToken(baseUrl, U('adB'));
    const tC = await mintToken(baseUrl, U('adC'));

    // ---- W: who may make a link ----
    {
      const v0 = await ctx.getVersion();
      const before = J(await doc());
      const cases = [
        [tA, 'ad2', 403, 'admin -> admin'], [tA, 'prim', 403, 'admin -> primary admin'], [tA, 'adA', 403, 'admin -> self'],
        [await mintToken(baseUrl, U('ad2')), 'prim', 403, 'admin 2 -> primary admin'],
        [tCo, 'm2', 403, 'coordinator -> other venue'], [tCo, 'co2', 403, 'coordinator -> coordinator'], [tCo, 'adA', 403, 'coordinator -> admin'], [tCo, 'coA', 403, 'coordinator -> self'],
        [await mintToken(baseUrl, U('m')), 'o', 403, 'mashgiach caller'], [await mintToken(baseUrl, U('o')), 'm', 403, 'owner caller'],
        [tA, 'mB', 404, "another agency's member"], [tB, 'm', 404, "B admin -> A member"],
        [tA, 'pend', 409, 'credentialPending'], [tA, 'nopw', 409, 'no stored password'], [tCo, 'pend', 409, 'coordinator -> credentialPending'],
      ];
      for (const [t, k, want, label] of cases) {
        const r = await make(t, U(k));
        assert(r.status === want, `W ${label}: ${r.status} (want ${want}) ${r.text.slice(0, 120)}`);
        if (want === 409) assert(r.json?.code === 'RESET_LINK_UNAVAILABLE', `W ${label} code`);
      }
      await unchanged(v0, 'W refusals');
      assert(J(await doc()) === before, 'W refusals: doc byte-for-byte unchanged');
      console.log('  ✓ W admin->admin/primary/self, coordinator out of scope/coordinator/admin/self, mashgiach/owner callers 403; other agency 404; pending/no password 409; nothing written');
    }

    // ---- N: making a link changes nothing; a second one replaces the first ----
    let rawM;
    {
      const tM = await mintToken(baseUrl, U('m'));
      const ws = openWs(baseUrl, tM);
      await ws.until(() => ws.initial, 6000);
      assert(ws.initial, 'N phone socket open');
      const m0 = await rowOf(U('m'));
      const r1 = await make(tCo, U('m'));
      assert(r1.status === 201 && /no-store/.test(r1.headers.get('cache-control') || ''), `N coordinator -> own-venue mashgiach 201 (${r1.status} ${r1.text.slice(0, 160)})`);
      assert(J(Object.keys(r1.json.resetLink).sort()) === J(['createdAt', 'createdBy', 'expiresAt', 'id', 'memberId']) && r1.json.resetLink.memberId === U('m'), `N admin view ${J(r1.json.resetLink)}`);
      assert(Date.parse(r1.json.resetLink.expiresAt) - Date.parse(r1.json.resetLink.createdAt) === 24 * 3600 * 1000, 'N 24 h');
      const raw1 = tokenOf(r1.json.link);
      const m1 = await rowOf(U('m'));
      assert(m1.password === m0.password && (m1.tokenEpoch ?? 0) === (m0.tokenEpoch ?? 0) && J(m1) === J(m0), 'N row unchanged by making a link');
      assert((await agencyGet(tM)).status === 200, 'N REST still 200');
      await sleep(300);
      assert(ws.closeCode === null, `N socket still open (${ws.closeCode})`);
      const r2 = await make(tA, U('m'));
      assert(r2.status === 201, `N second link 201 (${r2.status})`);
      rawM = tokenOf(r2.json.link);
      assert((await preview(raw1)).status === 404 && (await accept(raw1, 'whatever-123')).status === 404, 'N replaced link dead at preview and accept');
      const pv = await preview(rawM);
      assert(pv.status === 200 && J(Object.keys(pv.json).sort()) === J(['agencyName', 'expiresAt', 'firstName']) && pv.json.firstName === 'Mira' && pv.json.agencyName === `T73 A ${ts}`, `N preview ${pv.status} ${pv.text.slice(0, 160)}`);
      const ls = await linksOf(U('m'));
      assert(ls.filter((l) => l.status === 'pending').length === 1 && ls.some((l) => l.status === 'revoked' && l.revokeReason === 'replaced'), `N one live, one replaced ${J(ls.map((l) => [l.status, l.revokeReason]))}`);
      assert((await make(tCo, U('o'))).status === 201, 'N coordinator -> own-venue owner 201');
      assert((await make(tA, U('co2'))).status === 201, 'N admin -> coordinator 201');
      ws.close();
      console.log('  ✓ N making a link changes nothing (row, REST, WS); a second link replaces the first; coordinator -> owner and admin -> coordinator 201');
    }

    // ---- Q: who asked for a reset ----
    let verifiedResetToken;
    {
      const fp = await call('POST', '/api/auth/forgot-password', { ...jsonH, 'X-Forwarded-For': ip() }, { email: E('m') });
      assert(fp.status === 200, `Q forgot ${fp.status}`);
      const code = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(E('m'))}`)).json()).code;
      assert(code, 'Q test code');
      const vr = await call('POST', '/api/auth/verify-reset-code', { ...jsonH, 'X-Forwarded-For': ip() }, { email: E('m'), code });
      assert(vr.status === 200 && vr.json?.resetToken, `Q verify ${vr.status} ${vr.text.slice(0, 100)}`);
      verifiedResetToken = vr.json.resetToken;
      const qa = await call('GET', '/api/agency/reset-requests', auth(tA));
      const mine = (qa.json?.requests || []).find((x) => x.memberId === U('m'));
      assert(qa.status === 200 && mine && mine.linkLive === true && J(Object.keys(mine).sort()) === J(['linkLive', 'memberId', 'name', 'requestedAt']), `Q admin sees ${qa.status} ${qa.text.slice(0, 200)}`);
      assert(!qa.text.includes(E('m')) && !qa.text.includes(code) && !/codeHash|resetToken/.test(qa.text), 'Q no email, code or token');
      const qc = await call('GET', '/api/agency/reset-requests', auth(tCo));
      assert(qc.status === 200 && (qc.json.requests || []).some((x) => x.memberId === U('m')), 'Q in-scope coordinator sees it');
      const q2 = await call('GET', '/api/agency/reset-requests', auth(await mintToken(baseUrl, U('co2'))));
      assert(q2.status === 200 && !(q2.json.requests || []).some((x) => x.memberId === U('m')), 'Q out-of-scope coordinator does not');
      assert((await call('GET', '/api/agency/reset-requests', auth(await mintToken(baseUrl, U('m2'))))).status === 403, 'Q mashgiach 403');
      assert(!((await call('GET', '/api/agency/reset-requests', auth(tB))).json.requests || []).some((x) => x.memberId === U('m')), "Q other agency's admin does not");
      console.log('  ✓ Q admin + in-scope coordinator see who asked (no code, no email); out-of-scope coordinator / other agency do not; mashgiach 403');
    }

    // ---- A: accept ----
    {
      const tOld = await mintToken(baseUrl, U('m'));
      const ws = openWs(baseUrl, tOld);
      await ws.until(() => ws.initial, 6000);
      const short = await accept(rawM, 'short');
      assert(short.status === 400 && short.json?.code === 'PASSWORD_TOO_SHORT', `A short ${short.status}`);
      const NEW = 'stage2-t73-new-password';
      const ok = await accept(rawM, NEW);
      assert(ok.status === 200 && ok.json?.token && ok.json?.user?.id === U('m') && /no-store/.test(ok.headers.get('cache-control') || ''), `A accept ${ok.status} ${ok.text.slice(0, 160)}`);
      assert((await agencyGet(ok.json.token)).status === 200, "A the answer's token works");
      assert((await agencyGet(tOld)).status === 401, 'A old token 401');
      await sleep(400);
      assert(ws.closeCode === 4401, `A old socket 4401 (${ws.closeCode})`);
      assert((await login(E('m'), PW)).status === 401, 'A old password 401');
      assert((await login(E('m'), NEW)).status === 200, 'A new password 200');
      const m = await rowOf(U('m'));
      assert(m.credentialOrigin === 'agency-reset' && m.recoveryCodeHashes === undefined, `A origin + codes ${J({ o: m.credentialOrigin, c: m.recoveryCodeHashes })}`);
      assert(!((await doc()).passwordResets || []).some((r) => r.email === E('m')), 'A reset requests gone');
      const rp = await call('POST', '/api/auth/reset-password', { ...jsonH, 'X-Forwarded-For': ip() }, { email: E('m'), resetToken: verifiedResetToken, newPassword: 'stage2-t73-other-pass' });
      assert(rp.status === 400, `A a verified code dies (${rp.status})`);
      assert((await accept(rawM, 'stage2-t73-again-pass')).status === 404, 'A reuse 404');
      assert((await linksOf(U('m'))).some((l) => l.status === 'used' && l.usedAt), 'A link used');
      console.log('  ✓ A short 400; accept sets the password (old 401 / new 200), agency-reset, codes cleared, old sessions 401/4401, new token works, verified code dies, reuse 404');
    }

    // ---- E: expiry ----
    {
      const r = await make(tA, U('f'));
      assert(r.status === 201, 'E make');
      const raw = tokenOf(r.json.link);
      const pin = await hook('clock', { iso: new Date(Date.now() + 25 * 3600 * 1000).toISOString() });
      assert(pin.status === 200, 'E pin clock');
      try {
        assert((await preview(raw)).status === 404, 'E preview expired 404');
        assert((await accept(raw, 'stage2-t73-late-pass')).status === 404, 'E accept expired 404');
      } finally {
        await hook('clock', { iso: null });
      }
      assert((await login(E('f'), PW)).status === 200, 'E password unchanged');
      console.log('  ✓ E an expired link (test clock +25 h) is 404 at preview and accept; nothing changed');
    }

    // ---- M: member changed ----
    {
      const r1 = await make(tA, U('ch'));
      const raw1 = tokenOf(r1.json.link);
      const users0 = await rows();
      assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('ch') ? { ...u, email: E('ch-new') } : u)) })).status === 200, 'M plant email change');
      await rehydrate();
      assert((await preview(raw1)).status === 404 && (await accept(raw1, 'stage2-t73-mc-pass')).status === 404, 'M email changed -> 404');
      assert((await linksOf(U('ch'))).some((l) => l.status === 'revoked' && l.revokeReason === 'member-changed'), 'M revoked member-changed');
      // a coordinator's link, then the row is promoted to admin -> dead
      const co2Link = (await linksOf(U('co2'))).find((l) => l.status === 'pending');
      assert(co2Link, 'M co2 link exists');
      const r2 = await make(tA, U('co2'));
      const raw2 = tokenOf(r2.json.link);
      const users1 = await rows();
      assert((await hook('doc-set-users', { users: users1.map((u) => (u.id === U('co2') ? { ...u, role: 'admin', venueId: undefined } : u)) })).status === 200, 'M plant promotion');
      await rehydrate();
      assert((await accept(raw2, 'stage2-t73-promo-pass')).status === 404, 'M promoted to admin -> 404');
      assert((await login(E('co2'), PW)).status === 200, 'M promoted admin keeps the old password');
      console.log('  ✓ M email changed / promoted to admin before use -> 404, link revoked, nothing else written');
    }

    // ---- S: stale link (credential stamp) ----
    {
      const r = await make(tA, U('s'));
      const raw = tokenOf(r.json.link);
      const tS = await mintToken(baseUrl, U('s'));
      const NEWER = 'stage2-t73-own-change';
      const cp = await call('POST', '/api/auth/change-password', auth(tS), { currentPassword: PW, newPassword: NEWER });
      assert(cp.status === 200, `S change-password ${cp.status} ${cp.text.slice(0, 100)}`);
      assert((await preview(raw)).status === 404, 'S preview 404 after the person changed their password');
      assert((await accept(raw, 'stage2-t73-stale-pass')).status === 404, 'S accept 404');
      assert((await linksOf(U('s'))).some((l) => l.status === 'revoked' && l.revokeReason === 'credential-changed'), 'S revoked credential-changed');
      assert((await login(E('s'), NEWER)).status === 200, 'S newer password still works');
      console.log('  ✓ S a link made before the person changed their password dies (credential-changed); the newer password stands');
    }

    // ---- P: multi person A + B + C ----
    {
      const PA = 'stage2-t73-multi-a1';
      const pB0 = await rowOf(U('pB'));
      assert(pB0 && pB0.personId === (await rowOf(U('pA'))).personId, 'P planted person');
      // B kiosk session + phone token before the reset
      assert((await call('POST', '/api/__test__/kiosk-clear-lockouts', auth(tB))).status === 200, 'P clear lockouts');
      const dev = await pairDevice(baseUrl, tB, B1);
      const kHeaders = { ...jsonH, 'X-Kiosk-Device': dev.header };
      const kl = await call('POST', '/api/kiosk/login', kHeaders, { userId: U('pB'), pin: PIN });
      assert(kl.status === 200 && kl.json?.token, `P kiosk login before ${kl.status} ${kl.text.slice(0, 120)}`);
      const kTok = kl.json.token;
      const kAuth = { ...auth(kTok), 'X-Kiosk-Device': dev.header };
      assert((await call('GET', '/api/tasks', kAuth)).status === 200, 'P kiosk works before');
      assert((await call('POST', `/api/users/${U('mB')}/reset-link`, kAuth, { expectedVersion: await ctx.getVersion() })).status === 403, 'W kiosk session 403');
      assert((await call('POST', `/api/users/${U('pB')}/confirm-reset`, kAuth, { expectedVersion: await ctx.getVersion() })).status === 403, 'W kiosk confirm 403');
      const kws = openWs(baseUrl, kTok, dev.header);
      await kws.until(() => kws.initial || kws.closeCode !== null, 6000);
      assert(kws.initial, `P kiosk socket open (${kws.closeCode})`);
      const tPB = await mintToken(baseUrl, U('pB'));
      assert((await agencyGet(tPB)).status === 200, 'P B phone works before');
      // a link from B made BEFORE any reset (dies later by the stamp)
      const staleB = tokenOf((await make(tB, U('pB'))).json.link);

      const rA = await make(tA, U('pA'));
      assert(rA.status === 201, `P A link ${rA.status}`);
      const okA = await accept(tokenOf(rA.json.link), PA);
      assert(okA.status === 200 && okA.json.user?.id === U('pA'), `P A accept ${okA.status} ${okA.text.slice(0, 160)}`);
      const linkA = (await linksOf(U('pA'))).find((l) => l.status === 'used');
      const pB1 = await rowOf(U('pB')), pC1 = await rowOf(U('pC'));
      assert(pB1.resetSuspended?.byAgencyId === A && pB1.resetSuspended.linkId === linkA.id && pC1.resetSuspended?.byAgencyId === A, `P B + C paused by A ${J([pB1.resetSuspended, pC1.resetSuspended])}`);
      assert((await preview(staleB)).status === 404, 'P a link made before the reset dies (stamp)');
      const lg = await login(E('p'), PA);
      assert(lg.status === 200 && lg.json.chooseMembership === true && J(lg.json.memberships.map((m) => m.agencyId)) === J([A]), `P login lists only A ${lg.status} ${lg.text.slice(0, 200)}`);
      const act = await call('POST', '/api/auth/activate', auth(lg.json.token), { membershipId: U('pB') });
      assert(act.status === 403 && act.json?.code === 'RESET_CONFIRM_NEEDED', `P activate B 403 (${act.status} ${act.text.slice(0, 100)})`);
      assert((await agencyGet(tPB)).status === 401, 'P B old phone token 401');
      assert((await call('GET', '/api/tasks', kAuth)).status === 401, 'P B kiosk HTTP 401');
      await kws.until(() => kws.closeCode !== null, 3000);
      assert(kws.closeCode === 4401, `P B kiosk socket closed 4401 (${kws.closeCode})`);
      const kp = await call('POST', '/api/kiosk/login', kHeaders, { userId: U('pB'), pin: PIN });
      assert(kp.status === 403 && kp.json?.code === 'RESET_CONFIRM_NEEDED', `P B kiosk PIN 403 (${kp.status} ${kp.text.slice(0, 100)})`);
      const kw = await call('POST', '/api/kiosk/login', kHeaders, { userId: U('pB'), pin: '0000' });
      assert(kw.status === 401, `P B wrong PIN 401 (${kw.status})`);
      assert((await call('POST', '/api/__test__/kiosk-clear-lockouts', auth(tB))).status === 200, 'P clear lockouts 2');
      // admin views
      const gB = await call('GET', '/api/users', auth(tB));
      const vB = (gB.json.users || []).find((u) => u.id === U('pB'));
      assert(vB && vB.resetConfirmNeeded === true && !gB.text.includes('resetSuspended'), `P B admin sees resetConfirmNeeded only ${J(vB)}`);
      const gBco = await call('GET', '/api/users', auth(await mintToken(baseUrl, U('mB'))));
      assert(!gBco.text.includes('resetConfirmNeeded') && !gBco.text.includes('resetSuspended'), 'P non-admin sees no flag');
      // who may clear it
      assert((await confirm(tA, U('pB'))).status === 404, "P A admin confirm on B's row 404");
      const pr = await call('PUT', `/api/users/${U('pB')}`, auth(tB), { name: 'Pat T73 in B', resetSuspended: null, expectedVersion: await ctx.getVersion() });
      assert(pr.status === 200 || pr.status === 201, `P PUT ${pr.status} ${pr.text.slice(0, 100)}`);
      assert((await rowOf(U('pB'))).resetSuspended?.byAgencyId === A, 'P a body cannot clear the pause');
      {
        const users0 = await rows();
        assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('adB') ? { ...u, role: 'mashgiach', venueId: B1 } : u)) })).status === 200, 'P demote B admin (store only)');
        const v0 = await ctx.getVersion();
        const d = await confirm(tB, U('pB'));
        assert(d.status === 403, `P demoted B admin cannot confirm (${d.status})`);
        await unchanged(v0, 'P demoted confirm');
        assert((await hook('doc-set-users', { users: users0 })).status === 200, 'P restore B admin');
        await rehydrate();
      }
      const pBbefore = await rowOf(U('pB'));
      const cf = await confirm(tB, U('pB'));
      assert(cf.status === 200 && cf.json.confirmed === true, `P B admin confirms (${cf.status} ${cf.text.slice(0, 100)})`);
      const pBafter = await rowOf(U('pB'));
      const { resetSuspended: _x, ...pBrest } = pBbefore;
      assert(pBafter.resetSuspended === undefined && J(pBafter) === J(pBrest), `P B row otherwise byte-identical ${J(pBafter).slice(0, 200)}`);
      assert((await confirm(tB, U('pB'))).json?.confirmed === false, 'P confirm again: nothing to do');
      const lg2 = await login(E('p'), PA);
      assert(J(lg2.json.memberships.map((m) => m.agencyId).sort()) === J([A, B].sort()), `P login lists A + B ${lg2.text.slice(0, 200)}`);
      assert((await call('POST', '/api/auth/activate', auth(lg2.json.token), { membershipId: U('pB') })).status === 200, 'P activate B 200');
      assert((await call('POST', '/api/kiosk/login', kHeaders, { userId: U('pB'), pin: PIN })).status === 200, 'P B kiosk works again');
      {
        // A pause written to the STORE only (the cache still says active): the
        // kiosk PIN sign-in's in-commit re-check refuses it.
        const stored = await rows();
        const pausedInStore = stored.map((u) => (u.id === U('pB') ? { ...u, resetSuspended: { ...pBbefore.resetSuspended } } : u));
        assert((await hook('doc-set-users', { users: pausedInStore })).status === 200, 'P plant store-only pause');
        const ks = await call('POST', '/api/kiosk/login', kHeaders, { userId: U('pB'), pin: PIN });
        assert(ks.status === 403 && ks.json?.code === 'RESET_CONFIRM_NEEDED', `P store-only pause -> PIN 403 from the fresh re-check (${ks.status} ${ks.text.slice(0, 100)})`);
        assert((await hook('doc-set-users', { users: stored })).status === 200, 'P restore store');
      }

      // C resets the PAUSED C row (Option A)
      const preC = tokenOf((await make(tA, U('pA'))).json.link); // made before C's reset: dies by the stamp
      const rC = await make(tC, U('pC'));
      assert(rC.status === 201, `P C admin -> paused C row 201 (${rC.status} ${rC.text.slice(0, 100)})`);
      const PC = 'stage2-t73-multi-c1';
      const okC = await accept(tokenOf(rC.json.link), PC);
      assert(okC.status === 200 && okC.json.user?.id === U('pC'), `P C accept ${okC.status} ${okC.text.slice(0, 160)}`);
      const linkC = (await linksOf(U('pC'))).find((l) => l.status === 'used');
      const a2 = await rowOf(U('pA')), b2 = await rowOf(U('pB')), c2 = await rowOf(U('pC'));
      assert(c2.resetSuspended === undefined && a2.resetSuspended?.byAgencyId === C && a2.resetSuspended.linkId === linkC.id && b2.resetSuspended?.byAgencyId === C, `P after C: C active, A + B paused by C ${J([a2.resetSuspended, b2.resetSuspended, c2.resetSuspended])}`);
      assert((await preview(preC)).status === 404, 'P a link made before C\'s reset dies (stamp)');
      // A resets the paused A row: B's record is NOT overwritten
      const rA2 = await make(tA, U('pA'));
      assert(rA2.status === 201, `P A admin -> paused A row 201 (${rA2.status})`);
      const okA2 = await accept(tokenOf(rA2.json.link), 'stage2-t73-multi-a2');
      assert(okA2.status === 200, `P A accept 2 ${okA2.status}`);
      const a3 = await rowOf(U('pA')), b3 = await rowOf(U('pB')), c3 = await rowOf(U('pC'));
      assert(a3.resetSuspended === undefined && J(b3.resetSuspended) === J(b2.resetSuspended) && c3.resetSuspended?.byAgencyId === A, `P after A2: A active, B kept (by C), C paused by A ${J([a3.resetSuspended, b3.resetSuspended, c3.resetSuspended])}`);
      kws.close();
      console.log('  ✓ P A\'s link pauses B + C everywhere (login, activate, phone 401, kiosk 401 + socket 4401, PIN 403 / wrong 401); only B\'s current admin confirms; C resets its paused row (A + B paused by C); A resets again (B keeps C\'s record, C paused by A); older links die by the stamp');
    }

    // ---- F: fresh re-checks (store only) ----
    {
      const users0 = await rows();
      assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('coA') ? { ...u, role: 'mashgiach' } : u)) })).status === 200, 'F demote coordinator (store only)');
      let v0 = await ctx.getVersion();
      const r1 = await make(tCo, U('f'));
      assert(r1.status === 403, `F demoted coordinator -> 403 from the commit (${r1.status} ${r1.text.slice(0, 100)})`);
      await unchanged(v0, 'F demoted');
      assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('f') ? { ...u, agencyId: B, venueId: B1 } : u)) })).status === 200, 'F move member (store only)');
      v0 = await ctx.getVersion();
      const r2 = await make(tA, U('f'));
      assert(r2.status === 404, `F member moved -> 404 (${r2.status})`);
      await unchanged(v0, 'F moved');
      assert((await hook('doc-set-users', { users: users0 })).status === 200, 'F restore');
      await rehydrate();
      console.log('  ✓ F coordinator demoted / member moved in the store only -> 403 / 404, nothing written');
    }

    // ---- L: leaks ----
    {
      const tAdminWs = openWs(baseUrl, tA);
      await tAdminWs.until(() => tAdminWs.initial, 6000);
      const r = await make(tA, U('o'));
      const raw = tokenOf(r.json.link);
      await sleep(500);
      const d = await doc();
      const rec = d.resetLinks.find((l) => l.id === r.json.resetLink.id);
      assert(rec && rec.resetTokenHash && rec.credentialStampHash && !J(rec).includes(raw), 'L stored: hash + stamp, never the raw token');
      const secrets = [raw, rec.resetTokenHash, rec.credentialStampHash];
      const bodies = [
        (await call('GET', '/api/users', auth(tA))).text,
        (await call('GET', '/api/admin/export', auth(tA))).text,
        (await call('GET', '/api/agencies/current', auth(tA))).text,
        tAdminWs.raw.join('\n'),
      ];
      for (const b of bodies) {
        for (const s of secrets) assert(!b.includes(s), 'L a secret leaked into a payload');
        assert(!b.includes('resetSuspended') && !b.includes('resetLinks'), 'L no resetSuspended / resetLinks in payloads');
      }
      tAdminWs.close();
      console.log('  ✓ L raw token, hash and stamp never in GET /api/users, admin export, agency payload or WS frames; resetSuspended never leaves');
    }

    // ---- C: capacity ----
    {
      const d0 = await doc();
      const users0 = d0.users;
      const links0 = d0.resetLinks || [];
      const future = new Date(Date.now() + 3600 * 1000).toISOString();
      const fill = (n, extra = []) => [...extra, ...Array.from({ length: n }, (_, i) => ({ id: `rst_t73_fill_${i}_${ts}`, agencyId: B, memberId: `user-t73-ghost-${i}`, personId: '', email: `g${i}@x`, createdBy: 'x', createdAt: future, expiresAt: future, resetTokenHash: `h${i}`, credentialOwnerId: 'x', credentialStampHash: 's', status: 'pending' }))];
      const liveOthers = links0.filter((l) => l.status === 'pending' && Date.parse(l.expiresAt) > Date.now());
      assert((await hook('doc-set-users', { users: users0, resetLinks: fill(1000 - liveOthers.length, liveOthers) })).status === 200, 'C plant 1000 live');
      await rehydrate();
      const v0 = await ctx.getVersion();
      const full = await make(tA, U('m2')); // m2 has no live link (a replaced live link would make room)
      assert(full.status === 503 && full.json?.code === 'RESET_LINKS_FULL', `C full of live links -> 503 (${full.status} ${full.text.slice(0, 100)})`);
      await unchanged(v0, 'C full');
      assert(((await doc()).resetLinks || []).length === 1000, 'C nothing dropped');
      const used = { id: `rst_t73_used_${ts}`, agencyId: B, memberId: 'x', personId: '', email: 'u@x', createdBy: 'x', createdAt: future, expiresAt: future, status: 'used', usedAt: new Date().toISOString(), resetTokenHash: 'hu', credentialOwnerId: 'x', credentialStampHash: 's' };
      assert((await hook('doc-set-users', { users: users0, resetLinks: fill(999 - liveOthers.length, [...liveOthers, used]) })).status === 200, 'C plant 999 live + 1 used');
      await rehydrate();
      const ok = await make(tA, U('m2'));
      assert(ok.status === 201, `C room made -> 201 (${ok.status} ${ok.text.slice(0, 100)})`);
      const after = (await doc()).resetLinks;
      assert(after.length === 1000 && !after.some((l) => l.id === used.id), 'C the used record was dropped first');
      assert((await hook('doc-set-users', { users: (await doc()).users, resetLinks: links0 })).status === 200, 'C restore');
      await rehydrate();
      console.log('  ✓ C 1000 live links -> 503 and nothing dropped; with a used record it is dropped first and the link is made');
    }

    // ---- V: Send invite (10k) revokes a live reset link ----
    {
      {
        const r = await make(tA, U('m2'));
        assert(r.status === 201, `V make ${r.status}`);
        const raw = tokenOf(r.json.link);
        const si = await call('POST', `/api/users/${U('m2')}/invite`, auth(tA), { expectedVersion: await ctx.getVersion() });
        assert(si.status === 201, `V send invite ${si.status} ${si.text.slice(0, 100)}`);
        assert((await preview(raw)).status === 404, 'V the reset link is dead after Send invite');
        assert((await linksOf(U('m2'))).some((l) => l.status === 'revoked' && l.revokeReason === 'member-changed'), 'V revoked member-changed');
        assert((await make(tA, U('m2'))).status === 409, 'V a pending (Send invite) member gets no new link (409)');
        // A member turned credentialPending in the STORE only (no Send invite
        // commit, link left live): the accept re-check refuses and kills it.
        const ro = await make(tA, U('o'));
        assert(ro.status === 201, `V make o ${ro.status}`);
        const stored = await rows();
        assert((await hook('doc-set-users', { users: stored.map((u) => (u.id === U('o') ? { ...u, credentialPending: 'invite' } : u)) })).status === 200, 'V plant store-only pending');
        assert((await accept(tokenOf(ro.json.link), 'v-new-password-73')).status === 404, 'V pending in the store -> accept 404');
        assert((await linksOf(U('o'))).some((l) => l.status === 'revoked' && l.revokeReason === 'member-changed'), 'V link revoked member-changed');
        const after = await rows();
        assert((await hook('doc-set-users', { users: after.map((u) => (u.id === U('o') ? stored.find((x) => x.id === U('o')) : u)) })).status === 200, 'V restore o');
      }
      console.log('  ✓ V Send invite revokes the live reset link in its own commit (member-changed); the pending member gets 409');
    }

    // ---- G: [10L-RV1 B1] a legacy row's v1 sessions die too ----
    {
      const v1 = (await hook('mint-token', { userId: U('lg'), legacy: true })).json?.token;
      assert(typeof v1 === 'string' && v1, 'G v1 token minted');
      assert((await call('GET', '/api/tasks', auth(v1))).status === 200, 'G the v1 token works before');
      const r = await make(tA, U('lg'));
      assert(r.status === 201, `G make ${r.status} ${r.text.slice(0, 120)}`);
      const acc = await accept(tokenOf(r.json.link), 'g-new-password-73');
      assert(acc.status === 200 && typeof acc.json?.token === 'string', `G accept ${acc.status} ${acc.text.slice(0, 160)}`);
      assert((await call('GET', '/api/tasks', auth(v1))).status === 401, 'G the old v1 token is 401 after the reset');
      assert((await call('GET', '/api/tasks', auth(acc.json.token))).status === 200, 'G the replacement session works');
      const lg = await rowOf(U('lg'));
      assert(lg.personId === U('lg') && lg.tokenEpoch === 1, `G migrated + bumped in the same commit (${lg.personId}, ${lg.tokenEpoch})`);
      assert((await login(E('lg'), PW)).status === 401 && (await login(E('lg'), 'g-new-password-73')).status === 200, 'G old password 401, new 200');
      console.log('  ✓ G legacy row: a pre-reset v1 token is 401 after the reset; the row is migrated + bumped in the accept commit; the replacement session works');
    }

    // ---- R: public routes ----
    {
      const unknown = await preview('A'.repeat(43));
      const bad = await preview('x');
      const usedRaw = await accept('B'.repeat(43), 'stage2-t73-unknown');
      assert(unknown.status === 404 && bad.status === 404 && usedRaw.status === 404 && unknown.text === bad.text && bad.text === usedRaw.text, 'R one 404 body');
      const fixedIp = `10.173.${ts % 200}.9`;
      let last = 0;
      for (let i = 0; i < 61; i++) last = (await preview('A'.repeat(43), fixedIp)).status;
      assert(last === 429, `R per-IP 429 on preview (${last})`);
      console.log('  ✓ R one 404 body for every failure; per-IP 429');
    }

    // ---- X: source pins ----
    {
      const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
      const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert(i >= 0, `X ${name} exists`); return src.slice(i, src.indexOf('\n}\n', i)); };
      assert(fn('issueSessionToken').includes('sessionIneligibleCode(row)') && fn('liveSessionRow').includes('sessionIneligibleCode(row)'), 'X issuer + resolver use the one rule');
      assert(fn('kioskSessionStillValid').includes('sessionIneligibleCode(user)'), 'X kiosk re-validation uses the one rule');
      assert(fn('membershipsOfPerson').includes('sessionIneligibleCode(u)'), 'X membership list uses the one rule');
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      const susp = code.filter((l) => /resetSuspension: \{/.test(l));
      const conf = code.filter((l) => /resetConfirm: \{/.test(l));
      assert(susp.length === 1 && conf.length === 1, `X one producer each (${susp.length}/${conf.length})`);
      console.log('  ✓ X one eligibility rule (issuer, resolver, kiosk, membership list); one producer per resetSuspended writer');
    }
    return 'W N Q A E M S P F L C V G R X';
  },
};
