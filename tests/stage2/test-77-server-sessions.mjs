/**
 * Test 77 (item 11, PR 11a-s1, plan v8 9.1 / 10.1 / 10.2 / 15.1): server-side
 * sessions behind every new sign-in, with the old-token path unchanged.
 *  A  fresh email+password sign-in (single agency): the token carries sid, the
 *     record exists (row, person, via 'login', 30-day end, not revoked); GET,
 *     a mutating request and a WebSocket all work. Register also issues one.
 *  B  sign-out: POST /api/auth/logout revokes THIS session (record revokedAt,
 *     reason 'logout'); the same token is then 401 on GET and POST, a new WS
 *     is closed 4401, an open WS is closed 4401 at once; a second session of
 *     the same person keeps working; signing in again works (new sid).
 *  C  multi-agency: login -> choose token (no sid, refused by logout);
 *     activate -> sid token (via 'activate') that works for that agency;
 *     a fresh sign-in after it still lists both agencies.
 *  D  old tokens (before this release: v2 and v1 with no sid) keep working on
 *     GET, POST and WS; logout answers revoked:false and changes nothing.
 *  E  another instance's revocation (record revoked in the store only):
 *     a mutating request is 401 at once; a GET is served from the map only
 *     while the entry is fresher than 15 s, then 401; an open WS is closed
 *     4401 at its next delivery after the entry is older than 15 s; a new WS
 *     on an aged entry reads the store; a late store read never undoes a
 *     logout that landed on this instance meanwhile.
 *  F  end of life: a record past absoluteExp -> 401 on GET and POST and its
 *     open WS closes 4401 at the next delivery; a
 *     record never backs a token whose row epoch moved (epoch bump -> 401
 *     though the record is not revoked); a signed token with a malformed sid,
 *     or sid on a kiosk/choose shape, is 401.
 *  G  store outage: sign-in answers 503 SESSION_STORE_UNAVAILABLE with no
 *     token (also when the row's epoch moves while the record is written); a
 *     new WS is closed 1013 even when this instance's map holds a valid entry; a sid token gets 503 (never 401) on a mutating request; old
 *     tokens are unaffected; when the store is back the same sid token works
 *     (nobody was signed out).
 *  W  WebSocket deliveries ([11AS1-RV1] B1/B2): an entry older than 15 s holds
 *     the delivery until the record is re-read (ok -> a fresh INITIAL_STATE
 *     first; revoked -> 4401 with nothing escaping, even under a burst while the
 *     read is slow; store down -> 1013); a sid socket whose connect read is slow
 *     is not closed by a broadcast meanwhile.
 *  E6 two app instances on the same Firestore (real emulator; skipped in mock
 *     mode): after a logout on A, B refuses a write at once, a GET within 15 s,
 *     and closes its open WS with no data frame reaching it.
 *  H  restart (a deploy): sid tokens and old tokens still work after it; the
 *     test hook is 404 outside test mode.
 */
import crypto from 'crypto';
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
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectWs(baseUrl, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
    let closeCode = null; let gotInitial = false; let settled = false;
    const waiters = [];
    const messages = []; // every frame's type, in order
    const times = []; // Date.now() of each frame
    const conn = {
      ws,
      messages,
      times,
      get initial() { return gotInitial; },
      get closeCode() { return closeCode; },
      waitClose: (ms = 5000) => new Promise((res) => { if (closeCode !== null) return res(closeCode); const t = setTimeout(() => res(closeCode), ms); waiters.push((c) => { clearTimeout(t); res(c); }); }),
      close: () => { try { ws.close(); } catch {} },
    };
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(conn); } };
    const timer = setTimeout(done, 8000);
    ws.onmessage = (ev) => { let m = null; try { m = JSON.parse(String(ev.data)); } catch {} messages.push(m && m.type); times.push(Date.now()); if (m && m.type === 'INITIAL_STATE' && !gotInitial) { gotInitial = true; done(); } };
    ws.onerror = () => {};
    ws.onclose = (ev) => { closeCode = ev.code; waiters.splice(0).forEach((w) => w(ev.code)); done(); };
  });
}

export default {
  name: 'Test 77: item 11 (11a-s1) — server-side sessions + sign-out revoke',
  whatItProves:
    'Every new sign-in is backed by a sessions/{sid} record checked on every request (store read on writes, 15 s map on reads) and on WebSockets; sign-out revokes that session only; old tokens keep working (no forced logout); an outage is 503, never a sign-out.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.77.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t77-${k}-${ts}@test.local`;
    const PW = (k) => `Pass-77-${k}!`;
    const details = [];
    const hook = (body) => req(baseUrl, 'POST', '/api/__test__/session-hooks', { body });
    const sessionDoc = async (sid) => { const r = await hook({ action: 'get', sid }); assert(r.status === 200, `hook get: ${r.status}`); return r.json.doc; };
    const mintOld = async (userId, legacy = false) => { const r = await ctx.api('POST', '/api/__test__/mint-token', { userId, ...(legacy ? { legacy: true } : {}) }); assert(r.status === 200 && r.json?.token, `mint ${userId}: ${r.status}`); return r.json.token; };
    const login = (email, password) => req(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email, password } });
    const logout = (token) => req(baseUrl, 'POST', '/api/auth/logout', { token });
    const getProbe = (token) => req(baseUrl, 'GET', '/api/agencies/current', { token });
    // Any mutating route: the auth middleware answers before the handler.
    const postProbe = (token) => req(baseUrl, 'POST', '/api/updates/seen', { token, body: { announcementIds: [], noteIds: [], alertIds: [] } });
    const accepted = (r) => r.status !== 401 && r.status !== 503 && r.status !== 403;
    const register = async (k) => {
      const r = await req(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), body: { agencyName: `T77 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T77 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      return { token: r.json.token, id: r.json.user.id, email: E(k), pw: PW(k) };
    };
    const signIn = async (who, label) => {
      const r = await login(who.email, who.pw);
      assert(r.status === 200 && r.json?.token, `${label} login: ${r.status} ${J(r.json)}`);
      const c = claimsOf(r.json.token);
      assert(c.v === 2 && typeof c.sid === 'string' && /^[A-Za-z0-9_-]{22}$/.test(c.sid), `${label}: login token has sid ${J({ v: c.v, sid: !!c.sid })}`);
      return { token: r.json.token, sid: c.sid, claims: c };
    };

    try {
      // ---- A: fresh email+password sign-in, single agency
      const a = await register('a');
      const rc = claimsOf(a.token);
      assert(typeof rc.sid === 'string', 'A register token carries sid');
      const rd = await sessionDoc(rc.sid);
      assert(rd && rd.via === 'register' && rd.rowId === a.id && rd.revokedAt === null, `A register record: ${J(rd && { via: rd.via, row: rd.rowId === a.id })}`);
      const s1 = await signIn(a, 'A');
      const d1 = await sessionDoc(s1.sid);
      assert(d1 && d1.kind === 'user' && d1.rowId === a.id && d1.personId === s1.claims.sub && d1.via === 'login' && d1.epochAtIssue === s1.claims.ep && d1.revokedAt === null, `A record: ${J(d1 && { kind: d1.kind, via: d1.via })}`);
      assert(d1.absoluteExpMs - d1.createdAtMs === 30 * 24 * 3600 * 1000 && !('idleExpMs' in d1), 'A 30-day hard end, no idle limit');
      assert((await getProbe(s1.token)).status === 200, 'A GET with the new token');
      const pa = await postProbe(s1.token);
      assert(accepted(pa), `A POST with the new token: ${pa.status} ${J(pa.json)}`);
      const wsA = await connectWs(baseUrl, s1.token);
      assert(wsA.initial, `A WS gets INITIAL_STATE (close ${wsA.closeCode})`);
      details.push('A fresh sign-in -> sid record; GET/POST/WS ok');

      // ---- B: sign-out revokes this session only
      const s2 = await signIn(a, 'B second session');
      assert(s2.sid !== s1.sid, 'B a second sign-in gets its own sid');
      const lo = await logout(s1.token);
      assert(lo.status === 200 && lo.json?.ok === true && lo.json?.revoked === true, `B logout: ${lo.status} ${J(lo.json)}`);
      const d1b = await sessionDoc(s1.sid);
      assert(d1b.revokedAt && d1b.revokeReason === 'logout', `B record revoked: ${J({ r: d1b.revokedAt, why: d1b.revokeReason })}`);
      assert((await wsA.waitClose(3000)) === 4401, `B open WS closed 4401 at once (got ${wsA.closeCode})`);
      assert((await getProbe(s1.token)).status === 401, 'B GET after logout -> 401');
      assert((await postProbe(s1.token)).status === 401, 'B POST after logout -> 401');
      const wsA2 = await connectWs(baseUrl, s1.token);
      assert(!wsA2.initial && wsA2.closeCode === 4401, `B new WS after logout closed 4401 (got ${wsA2.closeCode}, initial ${wsA2.initial})`);
      assert((await logout(s1.token)).status === 401, 'B logout again with the revoked token -> 401');
      assert((await getProbe(s2.token)).status === 200 && accepted(await postProbe(s2.token)), 'B the other session still works');
      const s3 = await signIn(a, 'B sign in again');
      assert(s3.sid !== s1.sid && (await getProbe(s3.token)).status === 200, 'B signing in again works');
      details.push('B logout revokes only that sid (HTTP + open/new WS)');

      // ---- C: multi-agency
      const m = await register('m');
      const rx = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { agencyName: `T77 m2 ${ts}`, email: m.email, password: m.pw, operationId: `op-${crypto.randomUUID()}` } });
      assert(rx.status === 201 && rx.json?.token, `C register-existing: ${rx.status} ${J(rx.json)}`);
      assert(typeof claimsOf(rx.json.token).sid === 'string', 'C register-existing token carries sid');
      const ml = await login(m.email, m.pw);
      assert(ml.status === 200 && ml.json?.chooseMembership === true && Array.isArray(ml.json?.memberships) && ml.json.memberships.length === 2, `C login -> chooser: ${ml.status} ${J(ml.json && { c: ml.json.chooseMembership, n: ml.json.memberships?.length })}`);
      const cc = claimsOf(ml.json.token);
      assert(cc.v === 3 && !('sid' in cc), 'C choose token has no sid');
      assert((await logout(ml.json.token)).status === 401, 'C logout with a choose token -> 401');
      const pick = ml.json.memberships.find((x) => x.agencyName === `T77 m2 ${ts}`) || ml.json.memberships[1];
      const act = await req(baseUrl, 'POST', '/api/auth/activate', { token: ml.json.token, body: { membershipId: pick.membershipId } });
      assert(act.status === 200 && act.json?.token, `C activate: ${act.status} ${J(act.json)}`);
      const ac = claimsOf(act.json.token);
      assert(ac.v === 2 && ac.mem === pick.membershipId && typeof ac.sid === 'string', 'C activate token: v2 for the chosen membership with sid');
      const ad = await sessionDoc(ac.sid);
      assert(ad && ad.via === 'activate' && ad.rowId === pick.membershipId && ad.agencyId === pick.agencyId, `C activate record: ${J(ad && { via: ad.via })}`);
      const cur = await getProbe(act.json.token);
      assert(cur.status === 200 && J(cur.json).includes(pick.agencyId), `C GET in the chosen agency: ${cur.status}`);
      assert(accepted(await postProbe(act.json.token)), 'C POST with the activated token');
      const lo2 = await logout(act.json.token);
      assert(lo2.json?.revoked === true && (await getProbe(act.json.token)).status === 401, 'C logout revokes the activated session');
      const ml2 = await login(m.email, m.pw);
      assert(ml2.status === 200 && ml2.json?.chooseMembership === true && ml2.json.memberships.length === 2, 'C a fresh sign-in after it still lists both agencies');
      details.push('C multi: choose (no sid) -> activate (sid) -> logout; fresh sign-in lists both');

      // ---- D: old tokens (no sid) keep working
      const o2 = await mintOld(a.id);
      assert(!('sid' in claimsOf(o2)) && claimsOf(o2).v === 2, 'D old v2 token has no sid');
      assert((await getProbe(o2)).status === 200 && accepted(await postProbe(o2)), 'D old v2 token: GET + POST');
      const wsO = await connectWs(baseUrl, o2);
      assert(wsO.initial, `D old v2 token: WS (close ${wsO.closeCode})`);
      wsO.close();
      const lo3 = await logout(o2);
      assert(lo3.status === 200 && lo3.json?.ok === true && lo3.json?.revoked === false, `D logout with an old token: ${lo3.status} ${J(lo3.json)}`);
      assert((await getProbe(o2)).status === 200, 'D old token unchanged after logout (no record to revoke)');
      const legacyRow = `t77-legacy-${ts}`;
      const inj = await ctx.api('POST', '/api/__test__/inject-fixture', { users: [{ id: legacyRow, email: `t77-legacy-${ts}@test.local`, name: 'T77 legacy', role: 'mashgiach', agencyId: 'agency-hkc' }] });
      assert(inj.status === 200, `D inject legacy row: ${inj.status}`);
      const o1 = await mintOld(legacyRow, true);
      assert(!('v' in claimsOf(o1)) && !('sid' in claimsOf(o1)), 'D v1 token shape');
      assert((await req(baseUrl, 'GET', '/api/users', { token: o1 })).status === 200, 'D old v1 token still works');
      details.push('D old v1/v2 tokens unchanged (GET/POST/WS); logout revoked:false');

      // ---- E: another instance revoked it (store only)
      {
        const s = await signIn(a, 'E1');
        assert((await getProbe(s.token)).status === 200, 'E1 primes the map');
        assert((await hook({ action: 'revoke-silent', sid: s.sid })).json?.ok === true, 'E1 store-only revoke');
        assert((await postProbe(s.token)).status === 401, 'E1 mutating request reads the store -> 401 at once');
      }
      {
        const s = await signIn(a, 'E2');
        assert((await getProbe(s.token)).status === 200, 'E2 primes the map');
        assert((await hook({ action: 'revoke-silent', sid: s.sid })).json?.ok === true, 'E2 store-only revoke');
        const fresh = await getProbe(s.token);
        assert(fresh.status === 200, `E2 GET inside 15 s is served from this instance's map (bounded window): ${fresh.status}`);
        assert((await hook({ action: 'cache-age', sid: s.sid, ageMs: 15001 })).json?.ok === true, 'E2 age the entry');
        assert((await getProbe(s.token)).status === 401, 'E2 GET once the entry is older than 15 s -> re-read -> 401');
      }
      {
        const s = await signIn(a, 'E3');
        const w = await connectWs(baseUrl, s.token);
        assert(w.initial, 'E3 WS open');
        assert((await hook({ action: 'revoke-silent', sid: s.sid })).json?.ok === true, 'E3 store-only revoke');
        // A delivery while the entry is fresh does not close it (the map is authoritative on one instance).
        const other = await signIn(a, 'E3 other');
        const w2 = await connectWs(baseUrl, other.token); // USER_PRESENCE delivery to the agency
        await sleep(400);
        assert(w.closeCode === null, `E3 fresh entry: not closed yet (got ${w.closeCode})`);
        assert((await hook({ action: 'cache-age', sid: s.sid, ageMs: 15001 })).json?.ok === true, 'E3 age the entry');
        w2.close(); // presence delivery again -> background re-read -> refused -> 4401
        const code = await w.waitClose(5000);
        assert(code === 4401, `E3 open WS closed 4401 after the next delivery (got ${code})`);
      }
      {
        // E4: a NEW socket on an entry older than 15 s reads the store (authoritative) -> 4401.
        const s = await signIn(a, 'E4');
        assert((await getProbe(s.token)).status === 200, 'E4 primes the map');
        assert((await hook({ action: 'revoke-silent', sid: s.sid })).json?.ok === true, 'E4 store-only revoke');
        assert((await hook({ action: 'cache-age', sid: s.sid, ageMs: 15001 })).json?.ok === true, 'E4 age the entry');
        const w = await connectWs(baseUrl, s.token);
        assert(!w.initial && w.closeCode === 4401, `E4 new WS after another instance's revoke -> 4401 (got ${w.closeCode}, initial ${w.initial})`);
      }
      {
        // E5: a GET whose store read returns late (stale, not revoked) while a
        // logout lands on this instance -> the local revocation wins: 401, and
        // the map is not put back to "valid".
        const s = await signIn(a, 'E5');
        assert((await getProbe(s.token)).status === 200, 'E5 primes the map');
        assert((await hook({ action: 'cache-age', sid: s.sid, ageMs: 15001 })).json?.ok === true, 'E5 age the entry');
        assert((await hook({ action: 'read-delay-once', ms: 900 })).json?.ok === true, 'E5 delay the next read');
        const slowGet = getProbe(s.token);
        await sleep(200);
        const lo5 = await logout(s.token);
        assert(lo5.json?.revoked === true, `E5 logout during the slow read: ${lo5.status}`);
        const g5 = await slowGet;
        assert(g5.status === 401, `E5 the slow GET sees the local revocation -> 401 (got ${g5.status})`);
        assert((await getProbe(s.token)).status === 401, 'E5 the map still says revoked');
      }
      details.push('E other-instance revoke: POST 401 at once, GET 401 after 15 s, WS 4401 at next delivery / on connect; a late read never undoes a local logout');

      // ---- W: WebSocket deliveries never outrun the 15 s bound ([11AS1-RV1] B1/B2).
      // Deliveries are triggered by OLD-token sockets (no store reads of their own),
      // so the one delayed read is the watched socket's.
      {
        const oldTok = await mintOld(a.id);
        const poke = async () => { const x = await connectWs(baseUrl, oldTok); x.close(); }; // USER_PRESENCE on connect and close
        // W1: entry aged, session fine -> the delivery is held, the socket gets a fresh INITIAL_STATE first and stays open.
        const s = await signIn(a, 'W1');
        const w = await connectWs(baseUrl, s.token);
        assert(w.initial, 'W1 WS open');
        assert((await hook({ action: 'cache-age', sid: s.sid, ageMs: 15001 })).json?.ok === true, 'W1 age');
        const before = w.messages.length;
        await poke();
        await sleep(800);
        const after = w.messages.slice(before);
        assert(after.length > 0 && after[0] === 'INITIAL_STATE' && w.closeCode === null, `W1 aged entry: first frame is a fresh INITIAL_STATE, socket open (got ${J(after)}, close ${w.closeCode})`);
        w.close();
        // W2: entry aged + store revoked + the re-read answers late + a burst of deliveries -> nothing escapes, then 4401.
        const s2w = await signIn(a, 'W2');
        const w2 = await connectWs(baseUrl, s2w.token);
        assert(w2.initial, 'W2 WS open');
        assert((await hook({ action: 'revoke-silent', sid: s2w.sid })).json?.ok === true, 'W2 store-only revoke');
        assert((await hook({ action: 'cache-age', sid: s2w.sid, ageMs: 15001 })).json?.ok === true, 'W2 age');
        assert((await hook({ action: 'read-delay-once', ms: 1500 })).json?.ok === true, 'W2 delay');
        const b2 = w2.messages.length;
        await Promise.all([poke(), poke(), poke()]);
        const c2 = await w2.waitClose(6000);
        assert(c2 === 4401 && w2.messages.length === b2, `W2 burst during a slow re-read: no frame escaped (${J(w2.messages.slice(b2))}), closed ${c2}`);
        // W3: entry aged + store down -> nothing escapes, closed 1013 (try again), never 4401.
        const s3w = await signIn(a, 'W3');
        const w3 = await connectWs(baseUrl, s3w.token);
        assert(w3.initial, 'W3 WS open');
        assert((await hook({ action: 'cache-age', sid: s3w.sid, ageMs: 15001 })).json?.ok === true, 'W3 age');
        const b3 = w3.messages.length;
        try {
          assert((await hook({ action: 'fault', on: true })).json?.fault === true, 'W3 fault on');
          await poke();
          const c3 = await w3.waitClose(5000);
          assert(c3 === 1013 && w3.messages.length === b3, `W3 outage: no frame escaped (${J(w3.messages.slice(b3))}), closed ${c3} (want 1013)`);
        } finally {
          await hook({ action: 'fault', on: false });
        }
        // W4: a sid socket whose connect read is slow is neither fed nor closed by a broadcast meanwhile.
        const s4w = await signIn(a, 'W4');
        assert((await hook({ action: 'read-delay-once', ms: 1500 })).json?.ok === true, 'W4 delay');
        const pending = connectWs(baseUrl, s4w.token);
        await sleep(300);
        await poke();
        const w4 = await pending;
        assert(w4.initial && w4.closeCode === null && w4.messages[0] === 'INITIAL_STATE', `W4 slow connect + broadcast: opened normally (${J(w4.messages.slice(0, 3))}, close ${w4.closeCode})`);
        w4.close();
      }
      details.push('W WS: aged entry -> held + fresh INITIAL_STATE; slow re-read + burst -> nothing escapes, 4401; outage -> 1013; slow connect not closed by a broadcast');

      // ---- E6: two app instances on the same Firestore (plan 10.1; real emulator only)
      if (typeof ctx.startSecondServer === 'function') {
        const second = await ctx.startSecondServer();
        if (!second) {
          details.push('E6 skipped in mock mode (the mock store is per process; runs on the real emulator)');
        } else {
          try {
            const B = second.url;
            const s = await signIn(a, 'E6a');
            assert((await getProbe(s.token)).status === 200, 'E6a A GET');
            assert((await req(B, 'GET', '/api/agencies/current', { token: s.token })).status === 200, 'E6a B GET (B caches it)');
            assert((await logout(s.token)).json?.revoked === true, 'E6a logout on A');
            const pb = await req(B, 'POST', '/api/updates/seen', { token: s.token, body: { announcementIds: [], noteIds: [], alertIds: [] } });
            assert(pb.status === 401, `E6a B mutating request right after A's logout -> 401 (got ${pb.status})`);
            const s2 = await signIn(a, 'E6b');
            assert((await req(B, 'GET', '/api/agencies/current', { token: s2.token })).status === 200, 'E6b B GET (B caches it)');
            const t0 = Date.now();
            assert((await logout(s2.token)).json?.revoked === true, 'E6b logout on A');
            let gs = 200;
            while (gs === 200 && Date.now() - t0 < 17000) { await sleep(500); gs = (await req(B, 'GET', '/api/agencies/current', { token: s2.token })).status; }
            assert(gs === 401, `E6b B GET -> 401 within 15 s of A's logout (+2 s polling slack; got ${gs} after ${Date.now() - t0} ms)`);
            const s3 = await signIn(a, 'E6c');
            const wb = await connectWs(B, s3.token);
            assert(wb.initial, 'E6c WS open on B');
            const b6 = wb.messages.length;
            const t1 = Date.now();
            assert((await logout(s3.token)).json?.revoked === true, 'E6c logout on A');
            const oldTok = await mintOld(a.id);
            while (wb.closeCode === null && Date.now() - t1 < 20000) { const x = await connectWs(B, oldTok); x.close(); await sleep(1000); }
            const leaked = wb.messages.slice(b6).filter((m) => m !== 'USER_PRESENCE');
            assert(wb.closeCode === 4401, `E6c B's open WS closed 4401 after A's logout (got ${wb.closeCode} after ${Date.now() - t1} ms)`);
            assert(leaked.length === 0, `E6c no data frame reached the revoked socket on B (${J(leaked)})`);
            // B keeps broadcasting (a presence frame every second) the whole time: past the 15 s bound
            // (+1 s for the re-read) NOTHING reaches the revoked socket, whatever its type.
            const late = wb.times.slice(b6).filter((ts) => ts > t1 + 16000);
            assert(late.length === 0, `E6c no frame of any kind after 15 s (+1 s) on B (${late.length} late)`);
            details.push('E6 two instances: B refuses a write at once, a GET within 15 s, and closes the open WS after A\'s logout');
          } finally {
            await second.stop();
          }
        }
      }

      // ---- F: end of life, epoch, malformed
      {
        const s = await signIn(a, 'F1');
        assert((await hook({ action: 'expire', sid: s.sid })).json?.ok === true, 'F1 expire');
        assert((await getProbe(s.token)).status === 401 && (await postProbe(s.token)).status === 401, 'F1 past absoluteExp -> 401');
        // F4: an open socket whose map entry stops backing it (end of life) is closed at its next delivery.
        const s4 = await signIn(a, 'F4');
        const w4 = await connectWs(baseUrl, s4.token);
        assert(w4.initial, 'F4 WS open');
        assert((await hook({ action: 'expire', sid: s4.sid })).json?.ok === true, 'F4 expire');
        const o4 = await signIn(a, 'F4 other');
        const w4b = await connectWs(baseUrl, o4.token); // USER_PRESENCE delivery
        const c4 = await w4.waitClose(5000);
        assert(c4 === 4401, `F4 expired session's open WS closed 4401 at the next delivery (got ${c4})`);
        w4b.close();
        const s2b = await signIn(a, 'F2');
        const b = await ctx.api('POST', '/api/__test__/bump-token-epoch', { userId: a.id });
        assert(b.status === 200, `F2 bump: ${b.status}`);
        const d = await sessionDoc(s2b.sid);
        assert(d.revokedAt === null, 'F2 record not revoked');
        assert((await getProbe(s2b.token)).status === 401 && (await postProbe(s2b.token)).status === 401, 'F2 row epoch moved -> 401');
        const s3b = await signIn(a, 'F3 after bump');
        assert((await getProbe(s3b.token)).status === 200, 'F3 sign-in after the bump works');
        const c = s3b.claims;
        const signed = async (claims) => { const r = await ctx.api('POST', '/api/__test__/sign-claims', { claims }); assert(r.status === 200, `sign-claims ${r.status}`); return r.json.token; };
        for (const [claims, label] of [
          [{ v: 2, sub: c.sub, mem: c.mem, ep: c.ep, sid: 'short' }, 'malformed sid'],
          [{ v: 2, sub: c.sub, mem: c.mem, ep: c.ep, sid: 'ZZZZZZZZZZZZZZZZZZZZZZ' }, 'unknown sid'],
          [{ v: 2, sub: c.sub, mem: c.mem, ep: c.ep, sid: s2.sid }, 'another valid session\'s sid on this row'],
          [{ v: 3, sub: c.sub, cr: c.mem, ep: c.ep, sid: s3b.sid }, 'choose shape + sid'],
        ]) {
          const t = await signed(claims);
          assert((await getProbe(t)).status === 401, `F ${label} -> 401`);
        }
      }
      details.push('F expired / epoch-bumped / malformed or foreign sid -> 401');

      // ---- G: store outage = 503, never a sign-out
      {
        const s = await signIn(a, 'G');
        const o = await mintOld(a.id);
        try {
          assert((await hook({ action: 'fault', on: true })).json?.fault === true, 'G fault on');
          const l = await login(a.email, a.pw);
          assert(l.status === 503 && l.json?.code === 'SESSION_STORE_UNAVAILABLE' && !l.json?.token, `G login during outage: ${l.status} ${J(l.json)}`);
          const p = await postProbe(s.token);
          assert(p.status === 503 && p.json?.code === 'SESSION_STORE_UNAVAILABLE', `G sid POST during outage -> 503: ${p.status}`);
          assert((await logout(s.token)).status === 503, 'G logout during outage -> 503 (nothing revoked)');
          assert((await getProbe(o)).status === 200 && accepted(await postProbe(o)), 'G old token unaffected by the outage');
          // A new WS reads the store at connect even when this instance's map holds a valid entry: outage -> 1013, never registered.
          const wg = await connectWs(baseUrl, s.token);
          assert(!wg.initial && wg.closeCode === 1013, `G new WS during outage (map entry valid) -> 1013 (got ${wg.closeCode}, initial ${wg.initial})`);
        } finally {
          await hook({ action: 'fault', on: false });
        }
        assert((await getProbe(s.token)).status === 200 && accepted(await postProbe(s.token)), 'G the same sid token works after the outage');
      }
      {
        // G2: the row's epoch moves while the session record is being written -> no token (503, try again).
        assert((await hook({ action: 'write-delay-once', ms: 900 })).json?.ok === true, 'G2 delay the next write');
        const slowLogin = login(a.email, a.pw);
        await sleep(300);
        assert((await ctx.api('POST', '/api/__test__/bump-token-epoch', { userId: a.id })).status === 200, 'G2 bump during the write');
        const l2 = await slowLogin;
        assert(l2.status === 503 && l2.json?.code === 'SESSION_STORE_UNAVAILABLE' && !l2.json?.token, `G2 login whose row moved mid-write -> 503 no token: ${l2.status} ${J(l2.json && { code: l2.json.code, t: !!l2.json.token })}`);
        const s5 = await signIn(a, 'G2 retry');
        assert((await getProbe(s5.token)).status === 200, 'G2 the retry signs in');
      }
      details.push('G outage: login 503 no token, sid POST 503, old token fine, recovered; row moved mid-write -> 503');

      // ---- H: restart keeps every session; hook 404 outside test mode
      if (typeof ctx.restartServer === 'function') {
        const s = await signIn(a, 'H');
        const o = await mintOld(a.id);
        await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
        try {
          assert((await getProbe(s.token)).status === 200 && accepted(await postProbe(s.token)), 'H sid token works after a restart');
          assert((await getProbe(o)).status === 200, 'H old token works after a restart');
          const h = await req(baseUrl, 'POST', '/api/__test__/session-hooks', { token: s.token, body: { action: 'get', sid: s.sid } });
          assert(h.status === 404, `H session-hooks 404 outside test mode: ${h.status}`);
          const mt = await req(baseUrl, 'POST', '/api/__test__/mint-token', { token: s.token, body: { userId: a.id, session: true } });
          assert(mt.status === 404, `H mint-token 404 outside test mode: ${mt.status}`);
        } finally {
          await ctx.restartServer();
        }
        details.push('H restart keeps sid + old tokens; hooks 404 outside test mode');
      }
    } finally {
      await hook({ action: 'fault', on: false }).catch(() => {});
    }
    return details.join('; ');
  },
};
