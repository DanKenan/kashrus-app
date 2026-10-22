/**
 * Test 75 (10M part 1, "Agreed — 10M part 1"): POST /api/agencies/register-existing.
 * A person who already has an account registers a NEW agency and becomes its
 * admin under the SAME sign-in (design files/shutfey-10M-design.txt P1.1-P1.14).
 *  A  validation 400s (operationId, non-text fields), nothing written.
 *  B  wrong password / unknown email: the same 401 text, nothing written; the
 *     per-email failed-attempt limit (5) -> 429; the shared per-IP budget with
 *     /api/agencies/register.
 *  C  success: agency + starter venue + ONE credential-free admin row joined to
 *     the same person; the first multi join ends the old sessions (E1); the new
 *     token opens the new agency; login lists both agencies; createdByPersonId
 *     is stored but never sent to a client.
 *  D  retry with the same operationId -> same agency, nothing new; same
 *     operationId with another body -> refused, nothing written.
 *  E  an already-multi person adds another agency (no E1 bump); the atomic cap:
 *     two simultaneous requests at 2 -> exactly one 201 + one 429; then 429.
 *  F  refusals after a verified password: non-linkable origin 403, paused row
 *     403, password changed in the STORED doc only (fresh V6) 401 — nothing written.
 */
const J = (o) => JSON.stringify(o);
async function req(baseUrl, method, path, { token, ip, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function assert(c, m) { if (!c) throw new Error(m); }

export default {
  name: 'Test 75: 10M part 1 — add an agency to an existing account (register-existing)',
  whatItProves:
    'An existing account registers a new agency with its own password and becomes its admin under the same sign-in; wrong or unknown credentials get one 401 text and write nothing; retries are idempotent; at most 3 per person per day (atomic); non-linkable, paused and stale credentials are refused with nothing written; the hidden creator field never reaches a client.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.75.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t75-${k}-${ts}@test.local`;
    const PW = (k) => `Pass-75-${k}!`;
    const doc = () => ctx.getDoc();
    const ver = () => ctx.getVersion();
    const unchanged = async (v0, label) => { const v1 = await ver(); assert(v1 === v0, `${label}: version moved ${v0} -> ${v1}`); };
    const op = () => crypto.randomUUID();
    const details = [];
    const register = async (k) => {
      const r = await req(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), body: { agencyName: `T75 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T75 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      return r.json;
    };
    const rx = (k, extra = {}, ipv = ip()) => req(baseUrl, 'POST', '/api/agencies/register-existing', {
      ip: ipv, body: { agencyName: `T75 new ${k} ${Math.random().toString(36).slice(2, 7)}`, email: E(k), password: PW(k), operationId: op(), ...extra },
    });
    const rowsOf = async (pid) => (await doc()).users.filter((u) => u.personId === pid);
    const plantUsers = async (fn, label) => {
      const us = (await doc()).users.map(fn);
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: us })).status === 200, `${label} plant`);
      assert((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t75-sync-${label}-${ts}`, name: 'T75 sync', agencyId: 'agency-hkc' }] })).status === 200, `${label} rehydrate`);
    };

    const a = await register('a');
    const aRow0 = (await doc()).users.find((u) => u.id === a.user.id);
    const pidA = aRow0?.personId;
    assert(typeof pidA === 'string' && pidA && aRow0.credentialOrigin === 'self-registered', `A setup: ${J({ pidA, o: aRow0?.credentialOrigin })}`);

    // ---- A: validation
    {
      const v0 = await ver();
      for (const [extra, label] of [[{ operationId: undefined }, 'no operationId'], [{ operationId: 'x' }, 'short operationId'], [{ shortCode: 42 }, 'non-text shortCode'], [{ agencyName: '  ' }, 'empty name'], [{ password: '' }, 'empty password']]) {
        const r = await rx('a', extra);
        assert(r.status === 400, `A ${label}: ${r.status} ${J(r.json)}`);
      }
      await unchanged(v0, 'A validation');
      details.push('A validation: missing/short operationId, non-text field, empty name/password -> 400, nothing written');
    }

    // ---- B: proof failures, limits
    {
      const v0 = await ver();
      const w = await rx('a', { password: 'wrong-75' });
      const u = await rx('nobody');
      assert(w.status === 401 && u.status === 401 && w.json?.error === u.json?.error && w.json?.error === 'Email or password is incorrect.', `B 401s: ${J([w, u])}`);
      await unchanged(v0, 'B wrong/unknown');
      await register('lim');
      for (let i = 0; i < 5; i++) { const r = await rx('lim', { password: `bad-${i}` }); assert(r.status === 401, `B fail ${i}: ${r.status}`); }
      const locked = await rx('lim');
      assert(locked.status === 429, `B per-email limit: ${locked.status} ${J(locked.json)}`);
      const fixed = `10.75.250.${(ts % 200) + 1}`;
      for (let i = 0; i < 10; i++) { const r = await rx(`ipb${i}`, {}, fixed); assert(r.status === 401, `B ip budget ${i}: ${r.status}`); }
      const reg = await req(baseUrl, 'POST', '/api/agencies/register', { ip: fixed, body: { agencyName: `T75 ipb ${ts}`, adminEmail: E('ipb'), adminPassword: PW('ipb') } });
      assert(reg.status === 429, `B shared IP budget with /register: ${reg.status}`);
      details.push('B wrong password and unknown email: same 401 text, nothing written; 5 failures -> 429 for that email (right password too); 10 attempts from one IP use up /register too');
    }


  // collects AGENCY_REGISTERED messages a socket receives
  const listen = async (token) => {
    const s = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
    const got = { open: false, code: null, registered: [] };
    s.onopen = () => { got.open = true; }; s.onclose = (e) => { got.code = e.code; }; s.onerror = () => {};
    s.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d?.type === 'AGENCY_REGISTERED') got.registered.push(d?.payload?.agency?.id || d?.agency?.id || '?'); } catch {} };
    for (let i = 0; i < 30 && !got.open && got.code === null; i++) await new Promise((r) => setTimeout(r, 100));
    got.close = () => { try { s.close(); } catch {} };
    return got;
  };
    // ---- C: success (first multi)
    let agencyC1, tokC1, opC1, bodyC1;
    {
      // [10M-RV1] B1: another agency's admin socket must not hear the registration
      const wOther = await register('wo');
      const nAg0 = (await doc()).agencies.length;
      const other = await listen(wOther.token);
      assert(other.open, `C other agency socket did not open (${other.code})`);
      // an open phone socket of the person's old session must close 4401 (E1)
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(a.token)}`);
      const wsState = { open: false, code: null };
      ws.onopen = () => { wsState.open = true; }; ws.onclose = (e) => { wsState.code = e.code; }; ws.onerror = () => {};
      for (let i = 0; i < 30 && !wsState.open && wsState.code === null; i++) await new Promise((r) => setTimeout(r, 100));
      assert(wsState.open, `C the old session's socket did not open (${wsState.code})`);
      // a pending reset request of the single-row person is cleared by the first multi join
      const fp = await req(baseUrl, 'POST', '/api/auth/forgot-password', { ip: ip(), body: { email: E('a') } });
      assert(fp.status === 200, `C forgot-password: ${fp.status}`);
      const hasReset = async () => ((await doc()).passwordResets || []).some((x) => String(x?.email || '').toLowerCase() === E('a'));
      assert(await hasReset(), 'C setup: no reset request stored');
      opC1 = op();
      bodyC1 = { agencyName: `T75 second ${ts}`, email: E('a'), password: PW('a'), operationId: opC1, adminName: 'T75 A again' };
      const r = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: bodyC1 });
      assert(r.status === 201 && r.json?.token && r.json?.agency?.id, `C success: ${r.status} ${J(r.json)}`);
      agencyC1 = r.json.agency.id; tokC1 = r.json.token;
      assert(!('createdByPersonId' in r.json.agency), 'C response agency carries createdByPersonId');
      const d = await doc();
      assert(d.agencies.length === nAg0 + 1, `C agency count ${nAg0} -> ${d.agencies.length}`);
      const ag = d.agencies.find((x) => x.id === agencyC1);
      assert(ag && ag.createdByPersonId === pidA && ag.adminEmail === E('a'), `C stored agency: ${J({ c: ag?.createdByPersonId, e: ag?.adminEmail })}`);
      assert(d.venues.some((v) => v.agencyId === agencyC1), 'C no starter venue');
      const rows = await rowsOf(pidA);
      assert(rows.length === 2, `C person rows: ${rows.length}`);
      const nr = rows.find((x) => x.agencyId === agencyC1);
      assert(nr && nr.role === 'admin' && !nr.password && nr.email === E('a') && nr.name === 'T75 A again', `C new row: ${J({ role: nr?.role, pw: !!nr?.password, e: nr?.email })}`);
      const old = rows.find((x) => x.id === a.user.id);
      assert(old.password === aRow0.password && (old.tokenEpoch || 0) === (aRow0.tokenEpoch || 0) + 1, `C old row: pw kept ${old.password === aRow0.password}, epoch ${aRow0.tokenEpoch} -> ${old.tokenEpoch}`);
      assert((await req(baseUrl, 'GET', '/api/tasks', { token: a.token })).status === 401, 'C E1: the old session still works');
      for (let i = 0; i < 30 && wsState.code === null; i++) await new Promise((r) => setTimeout(r, 100));
      assert(wsState.code === 4401, `C E1: the old session's socket close ${wsState.code}`);
      const me = await req(baseUrl, 'GET', '/api/agencies', { token: tokC1 });
      assert(me.status === 200 && me.json?.agencies?.[0]?.id === agencyC1 && !('createdByPersonId' in me.json.agencies[0]), `C new token: ${me.status} ${J(me.json)}`);
      assert(!(await hasReset()), 'C first multi join kept the reset request');
      await new Promise((r) => setTimeout(r, 400));
      assert(other.registered.length === 0, `C another agency heard the registration: ${J(other.registered)}`);
      other.close();
      const login = await req(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email: E('a'), password: PW('a') } });
      assert(login.status === 200 && login.json?.chooseMembership === true && login.json.memberships?.length === 2, `C login: ${login.status} ${J(login.json)}`);
      assert(!JSON.stringify(r.json).includes('createdByPersonId'), 'C response leaks createdByPersonId');
      details.push('C success: new agency + starter venue + one admin row (same person, no password); old row password kept, epoch +1 (old token 401); new token opens the new agency; login lists 2 memberships; the pending reset request cleared; creator field stored, never in a response');
    }

    // ---- D: idempotency
    {
      const nAg0 = (await doc()).agencies.length;
      const v0 = await ver();
      // [10M-RV1] N1: the new agency's own socket hears no second registration on a replay
      const own = await listen(tokC1);
      assert(own.open, `D new agency socket did not open (${own.code})`);
      const again = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: bodyC1 });
      assert(again.status === 201 && again.json?.agency?.id === agencyC1, `D retry: ${again.status} ${J(again.json?.agency)}`);
      assert((await doc()).agencies.length === nAg0, 'D retry created another agency');
      await new Promise((r) => setTimeout(r, 400));
      assert(own.registered.length === 0 && own.code === null, `D replay re-broadcast or closed the session socket: ${J(own)}`);
      own.close();
      const other = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { ...bodyC1, agencyName: `T75 other ${ts}` } });
      assert(other.status === 409, `D same operationId, other body: ${other.status} ${J(other.json)}`);
      await unchanged(v0, 'D retries');
      // another person using the SAME operationId does not collide (the key is per person)
      await register('b');
      const nB0 = (await doc()).agencies.length;
      const ob = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { ...bodyC1, email: E('b'), password: PW('b') } });
      assert(ob.status === 201 && ob.json?.agency?.id && ob.json.agency.id !== agencyC1 && (await doc()).agencies.length === nB0 + 1, `D other person same operationId: ${ob.status} ${J(ob.json?.agency)}`);
      // a replay whose membership is no longer this person's: no session
      const bRow = (await doc()).users.find((u) => u.agencyId === ob.json.agency.id);
      await plantUsers((u) => (u.id === bRow.id ? { ...u, agencyId: agencyC1 } : u), 'breplay');
      const rb = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { ...bodyC1, email: E('b'), password: PW('b') } });
      assert(rb.status === 409 && !rb.json?.token && rb.json?.code === 'REGISTER_EXISTING_REPLAY_INVALID', `D replay of a moved membership: ${rb.status} ${J(rb.json)}`);
      details.push('D same operationId -> same agency + fresh session, nothing new; same operationId + other body -> 409, nothing written; another person with the same operationId -> own new agency; a replay whose membership moved -> 409, no token');
    }

    // ---- E: already multi, atomic cap
    {
      const before = (await rowsOf(pidA)).map((x) => [x.id, x.tokenEpoch || 0]);
      const r2 = await rx('a');
      assert(r2.status === 201, `E third agency: ${r2.status} ${J(r2.json)}`);
      const after = await rowsOf(pidA);
      assert(after.length === 3 && before.every(([id, e]) => (after.find((x) => x.id === id)?.tokenEpoch || 0) === e), 'E already-multi join bumped an epoch');
      assert((await req(baseUrl, 'GET', '/api/agencies', { token: tokC1 })).status === 200, 'E the previous session died');
      // count is 2 (C + E); two at once -> one 201, one 429
      const v0 = await ver();
      const [p1, p2] = await Promise.all([rx('a'), rx('a')]);
      const sts = [p1.status, p2.status].sort();
      assert(sts[0] === 201 && sts[1] === 429, `E concurrent at 2: ${sts}`);
      const loser = p1.status === 429 ? p1 : p2;
      assert(loser.json?.code === 'REGISTER_EXISTING_LIMIT', `E 429 code: ${J(loser.json)}`);
      const v1 = await ver();
      const fourth = await rx('a');
      assert(fourth.status === 429 && fourth.json?.code === 'REGISTER_EXISTING_LIMIT', `E 4th: ${fourth.status}`);
      await unchanged(v1, 'E over the cap');
      assert((await rowsOf(pidA)).length === 4 && v1 !== v0, 'E rows after the cap');
      details.push('E already-multi person adds an agency with no epoch bump; two simultaneous at 2 -> one 201 + one 429 REGISTER_EXISTING_LIMIT; a 4th within 24 h -> 429, nothing written');
    }

    // ---- F: refusals after a verified password
    {
      const n = await register('n');
      await plantUsers((u) => (u.id === n.user.id ? { ...u, credentialOrigin: 'admin' } : u), 'n');
      let v0 = await ver();
      const rn = await rx('n');
      assert(rn.status === 403 && rn.json?.code === 'ACCOUNT_NOT_LINKABLE', `F non-linkable: ${rn.status} ${J(rn.json)}`);
      await unchanged(v0, 'F non-linkable');
      const p = await register('p');
      await plantUsers((u) => (u.id === p.user.id ? { ...u, resetSuspended: { linkId: `rl-t75-${ts}`, at: new Date().toISOString(), byAgencyId: 'agency-hkc' } } : u), 'p');
      v0 = await ver();
      const rp = await rx('p');
      assert(rp.status === 403 && rp.json?.code === 'RESET_CONFIRM_NEEDED', `F paused: ${rp.status} ${J(rp.json)}`);
      await unchanged(v0, 'F paused');
      // password changed in the STORED doc only: the cached check passes, the fresh V6 check refuses
      const s = await register('s');
      const other = (await doc()).users.find((u) => u.id === a.user.id).password;
      const us = (await doc()).users.map((u) => (u.id === s.user.id ? { ...u, password: other } : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: us })).status === 200, 'F plant stale');
      v0 = await ver();
      const snap = J((await doc()).agencies.map((x) => x.id));
      const rs = await rx('s');
      assert(rs.status === 401 && rs.json?.error === 'Email or password is incorrect.', `F stale credential: ${rs.status} ${J(rs.json)}`);
      await unchanged(v0, 'F stale');
      assert(J((await doc()).agencies.map((x) => x.id)) === snap, 'F stale: agencies changed');
      // a refusal that exists only in the STORED doc (cache clean): the fresh re-check refuses
      const o2 = await register('o2');
      const usO = (await doc()).users.map((u) => (u.id === o2.user.id ? { ...u, credentialOrigin: 'admin' } : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: usO })).status === 200, 'F plant fresh-only origin');
      v0 = await ver();
      const ro2 = await rx('o2');
      assert(ro2.status === 403 && ro2.json?.code === 'ACCOUNT_NOT_LINKABLE', `F fresh-only non-linkable: ${ro2.status} ${J(ro2.json)}`);
      await unchanged(v0, 'F fresh-only non-linkable');
      // a credential still pending (invite) is not a usable sign-in: the same 401
      const cp = await register('cp');
      await plantUsers((u) => (u.id === cp.user.id ? { ...u, credentialPending: 'invite' } : u), 'cp');
      v0 = await ver();
      const rcp = await rx('cp');
      assert(rcp.status === 401 && rcp.json?.error === 'Email or password is incorrect.', `F pending credential: ${rcp.status} ${J(rcp.json)}`);
      await unchanged(v0, 'F pending credential');
      // a person whose identity group needs a check: 409, nothing written
      const q = await register('q');
      const qRow = (await doc()).users.find((u) => u.id === q.user.id);
      const twin = { ...qRow, id: `user-t75-qtwin-${ts}`, personId: `user-t75-qtwin-${ts}`, agencyId: 'agency-hkc', role: 'mashgiach' };
      delete twin.password; delete twin.credentialOrigin;
      const us2 = [...(await doc()).users, twin];
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: us2 })).status === 200, 'F plant twin');
      assert((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t75-sync-q-${ts}`, name: 'T75 sync', agencyId: 'agency-hkc' }] })).status === 200, 'F twin rehydrate');
      v0 = await ver();
      const rq = await rx('q');
      assert(rq.status === 409 && rq.json?.code === 'INVITE_PERSON_NEEDS_CHECK', `F needs check: ${rq.status} ${J(rq.json)}`);
      await unchanged(v0, 'F needs check');
      // the platform operator account (made linkable here on purpose) is refused
      const users0 = (await doc()).users;
      const opRow = users0.find((u) => u.id === 'usr_admin');
      if (opRow) {
        const aHash = users0.find((u) => u.id === a.user.id).password;
        const opEmail = String(opRow.email).toLowerCase();
        await plantUsers((u) => (u.id === 'usr_admin' ? { ...u, password: aHash, credentialOrigin: 'self-registered', personId: u.personId || 'usr_admin' } : u), 'op');
        v0 = await ver();
        const ro = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { agencyName: `T75 op ${ts}`, email: opEmail, password: PW('a'), operationId: op() } });
        assert(ro.status === 403 && ro.json?.code === 'ACCOUNT_NOT_LINKABLE', `F platform operator: ${ro.status} ${J(ro.json)}`);
        await unchanged(v0, 'F platform operator');
        assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: (await doc()).users.map((u) => (u.id === 'usr_admin' ? opRow : u)) })).status === 200, 'F restore operator');
      } else throw new Error('F: platform operator row missing');
      details.push('F non-linkable origin 403 ACCOUNT_NOT_LINKABLE, paused row 403 RESET_CONFIRM_NEEDED, password changed in the stored doc only 401, non-linkable in the stored doc only 403 (fresh re-check), pending credential 401, person needing a check 409, platform operator 403 — nothing written');
    }
    return details.join('; ');
  },
};
