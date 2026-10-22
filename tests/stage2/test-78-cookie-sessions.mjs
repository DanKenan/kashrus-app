/**
 * Test 78 (item 11, PR 11a-s2, plan v8 9.2 / 9.3 / 10.6 / 11a-s): the user
 * session cookie U, the trusted-Origin rule, adopt, /api/auth/me and the
 * cookie WebSocket - with today's clients unchanged.
 *  A  today's clients: a sign-in WITHOUT the opt-in header (X-Shutfey-Auth:
 *     cookie) gets no cookie, and a cookie is never read without it; with the
 *     opt-in but a foreign, "null" or missing Origin the sign-in still works
 *     exactly as today (token in JSON) and sets no cookie.
 *  B  fresh email+password sign-in, single agency, opted in from the trusted
 *     origin: U is set (HttpOnly, SameSite=Lax, Path=/, 30-day Max-Age, the
 *     same token as the JSON); /api/auth/me, a GET, a mutation and a WebSocket
 *     work on the cookie alone; a cookie mutation from a foreign, "null" or
 *     missing Origin is 403 CSRF_ORIGIN (a spoofed X-Forwarded-Host changes
 *     nothing); a cookie socket from a foreign or missing Origin closes 4403.
 *     Sign-out on the cookie: 403 from a foreign Origin (nothing revoked);
 *     from the trusted origin it revokes, deletes the cookie, closes the open
 *     cookie socket 4401, and the same JWT is then refused as cookie AND as
 *     Bearer.
 *  C  multi-agency: the chooser answer sets no cookie; a choose token is
 *     refused as a cookie; activate sets U to the activated session; the
 *     chooser list works on the cookie; a fresh sign-in still lists both.
 *  D  adopt: a session token moves to the cookie as it is (same sid, Max-Age
 *     no longer than its record); a pre-11 token (v2 and v1, no sid) gets a
 *     new record (via 'adopt') that ends no later than that token, and the
 *     old Bearer keeps working (no forced sign-out); idempotent; refused with
 *     no cookie without the opt-in, from a foreign Origin, for a revoked,
 *     choose or kiosk token; the token is never in the answer.
 *  E  claim types and precedence: a kiosk, choose, pre-11 or forged token in
 *     U is 401, so are two U cookies; Bearer wins over a cookie of another
 *     person during the transition, and a Bearer sign-out also ends this
 *     browser's cookie session and deletes the cookie.
 *  F  route-table walk: every authenticated mutating /api route answers a
 *     cookie request from a foreign or missing Origin with 403 CSRF_ORIGIN.
 *  G  session store outage: a cookie sign-out answers 503 and keeps the
 *     cookie (no half sign-out); after the outage the cookie still works. A
 *     Bearer sign-out that also ends the cookie's session revokes both in one
 *     transaction: an outage revokes neither, and the retry ends both.
 */
import crypto from 'crypto';
import WebSocket from 'ws';
const J = (o) => JSON.stringify(o);
function assert(c, m) { if (!c) throw new Error(m); }
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const COOKIE = 'shutfey_s'; // test mode name (production: __Host-shutfey_s + Secure, stage4)

async function call(baseUrl, method, path, { bearer, cookie, cookies, origin, optIn, ip, body, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const jar = cookies || (cookie ? [`${COOKIE}=${cookie}`] : []);
  if (jar.length) headers.Cookie = jar.join('; ');
  if (origin !== undefined) headers.Origin = origin;
  if (optIn) headers['X-Shutfey-Auth'] = 'cookie';
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const mine = setCookies.filter((c) => c.startsWith(`${COOKIE}=`));
  return { status: res.status, json, setCookies: mine };
}
function parseSet(line) {
  const [nv, ...attrs] = line.split(';').map((s) => s.trim());
  const value = nv.slice(nv.indexOf('=') + 1);
  const a = {};
  for (const x of attrs) { const i = x.indexOf('='); a[(i < 0 ? x : x.slice(0, i)).toLowerCase()] = i < 0 ? true : x.slice(i + 1); }
  return { value, a };
}

function connectWs(baseUrl, { query = '', cookie, origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.Cookie = `${COOKIE}=${cookie}`;
    if (origin) headers.Origin = origin;
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws${query}`, { headers });
    let closeCode = null; let gotInitial = false; let settled = false; const waiters = [];
    const conn = {
      get initial() { return gotInitial; },
      get closeCode() { return closeCode; },
      waitClose: (ms = 5000) => new Promise((res) => { if (closeCode !== null) return res(closeCode); const t = setTimeout(() => res(closeCode), ms); waiters.push((c) => { clearTimeout(t); res(c); }); }),
      close: () => { try { ws.close(); } catch {} },
    };
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(conn); } };
    const timer = setTimeout(done, 8000);
    ws.on('message', (d) => { let m = null; try { m = JSON.parse(String(d)); } catch {} if (m && m.type === 'INITIAL_STATE' && !gotInitial) { gotInitial = true; done(); } });
    ws.on('error', () => {});
    ws.on('close', (code) => { closeCode = code; waiters.splice(0).forEach((w) => w(code)); done(); });
  });
}

export default {
  name: 'Test 78: item 11 (11a-s2) — user session cookie, trusted Origin, adopt, /me, cookie WebSocket',
  whatItProves:
    'The user cookie is set and read only for clients that opt in, only with a trusted Origin; cookie mutations and sockets from other origins are refused; adopt moves a Bearer token to the cookie without signing anyone out; sign-out ends the cookie session everywhere it is used.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.78.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t78-${k}-${ts}@test.local`;
    const PW = (k) => `Pass-78-${k}!`;
    const ORIGIN = baseUrl.replace(/\/$/, '');
    const EVIL = 'https://evil.example';
    const details = [];
    const hook = (body) => call(baseUrl, 'POST', '/api/__test__/session-hooks', { body });
    const sessionDoc = async (sid) => { const r = await hook({ action: 'get', sid }); assert(r.status === 200, `hook get: ${r.status}`); return r.json.doc; };
    const login = (email, password, o = {}) => call(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email, password }, ...o });
    const me = (o) => call(baseUrl, 'GET', '/api/auth/me', o);
    const getProbe = (o) => call(baseUrl, 'GET', '/api/agencies/current', o);
    const postProbe = (o) => call(baseUrl, 'POST', '/api/updates/seen', { body: { announcementIds: [], noteIds: [], alertIds: [] }, ...o });
    const accepted = (r) => r.status !== 401 && r.status !== 503 && r.status !== 403;
    const register = async (k) => {
      const r = await call(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), body: { agencyName: `T78 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T78 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      assert(r.setCookies.length === 0, `register ${k} without opt-in sets no cookie`);
      return { token: r.json.token, id: r.json.user.id, email: E(k), pw: PW(k) };
    };
    const cookieSignIn = async (who, label) => {
      const r = await login(who.email, who.pw, { optIn: true, origin: ORIGIN });
      assert(r.status === 200 && r.json?.token, `${label} login: ${r.status} ${J(r.json)}`);
      assert(r.setCookies.length === 1, `${label}: one cookie set (got ${r.setCookies.length})`);
      const { value, a } = parseSet(r.setCookies[0]);
      assert(value === r.json.token, `${label}: the cookie is the token handed out`);
      assert(a.httponly === true && String(a.samesite).toLowerCase() === 'lax' && a.path === '/' && !('domain' in a), `${label}: HttpOnly, SameSite=Lax, Path=/, host-only ${J(a)}`);
      const age = Number(a['max-age']);
      assert(age > 30 * 24 * 3600 - 120 && age <= 30 * 24 * 3600, `${label}: Max-Age is the 30-day record (got ${age})`);
      return { cookie: value, sid: claimsOf(value).sid, token: r.json.token };
    };
    const C = (cookie, o = {}) => ({ cookie, optIn: true, origin: ORIGIN, ...o });

    try {
      // ---- A: today's clients see no change
      const a = await register('a');
      const plain = await login(a.email, a.pw, { origin: ORIGIN });
      assert(plain.status === 200 && plain.json?.token && plain.setCookies.length === 0, `A sign-in without opt-in: token, no cookie (${plain.status}, ${plain.setCookies.length})`);
      for (const [label, origin] of [['foreign', EVIL], ['null', 'null'], ['missing', undefined], ['trailing slash', `${ORIGIN}/`]]) {
        const r = await login(a.email, a.pw, { optIn: true, origin });
        assert(r.status === 200 && typeof r.json?.token === 'string' && r.setCookies.length === 0, `A opted-in sign-in from a ${label} Origin works as today with no cookie (${r.status}, ${r.setCookies.length})`);
      }
      const reg = await call(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), optIn: true, origin: EVIL, body: { agencyName: `T78 r ${ts}`, adminEmail: E('r'), adminPassword: PW('r'), adminName: 'T78 r' } });
      assert(reg.status === 201 && reg.json?.token && reg.setCookies.length === 0, `A register from a foreign Origin: as today, no cookie (${reg.status})`);
      details.push('A no opt-in or untrusted Origin -> sign-in as today, no cookie');

      // ---- B: cookie sign-in, single agency
      const b = await cookieSignIn(a, 'B');
      const d = await sessionDoc(b.sid);
      assert(d && d.via === 'login' && d.revokedAt === null, 'B the cookie session is a server record');
      const m1 = await me(C(b.cookie));
      assert(m1.status === 200 && m1.json?.auth === 'cookie' && m1.json?.user?.email === a.email && m1.setCookies.length === 0, `B /api/auth/me on the cookie: ${m1.status} ${J(m1.json && { auth: m1.json.auth })}`);
      assert(!J(m1.json).includes(b.cookie), 'B /me never returns the token');
      const mb = await me({ bearer: a.token });
      assert(mb.status === 200 && mb.json?.auth === 'bearer', `B /api/auth/me on Bearer: ${mb.status}`);
      assert((await me({ cookie: b.cookie, origin: ORIGIN })).status === 401, 'B a cookie without the opt-in header is not read (401)');
      assert((await getProbe(C(b.cookie))).status === 200, 'B GET on the cookie');
      assert((await getProbe(C(b.cookie, { origin: EVIL }))).status === 200, 'B a GET needs no Origin check');
      assert(accepted(await postProbe(C(b.cookie))), 'B mutation on the cookie from the trusted origin');
      for (const [label, o] of [['foreign', { origin: EVIL }], ['null', { origin: 'null' }], ['missing', { origin: undefined }], ['spoofed forwarded host', { origin: EVIL, headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } }]]) {
        const r = await postProbe(C(b.cookie, o));
        assert(r.status === 403 && r.json?.code === 'CSRF_ORIGIN', `B cookie mutation from a ${label} Origin -> 403 CSRF_ORIGIN (got ${r.status} ${J(r.json)})`);
      }
      const ws1 = await connectWs(baseUrl, { query: '?auth=cookie', cookie: b.cookie, origin: ORIGIN });
      assert(ws1.initial, `B cookie WS gets INITIAL_STATE (close ${ws1.closeCode})`);
      const wsEvil = await connectWs(baseUrl, { query: '?auth=cookie', cookie: b.cookie, origin: EVIL });
      assert(!wsEvil.initial && wsEvil.closeCode === 4403, `B cookie WS from a foreign Origin closes 4403 (got ${wsEvil.closeCode})`);
      const wsNoOrigin = await connectWs(baseUrl, { query: '?auth=cookie', cookie: b.cookie });
      assert(!wsNoOrigin.initial && wsNoOrigin.closeCode === 4403, `B cookie WS with no Origin closes 4403 (got ${wsNoOrigin.closeCode})`);
      const wsNoOpt = await connectWs(baseUrl, { cookie: b.cookie, origin: ORIGIN });
      assert(!wsNoOpt.initial && wsNoOpt.closeCode === 4401, `B a socket without auth=cookie does not read the cookie (got ${wsNoOpt.closeCode})`);
      const wsNoCookie = await connectWs(baseUrl, { query: '?auth=cookie', origin: ORIGIN });
      assert(!wsNoCookie.initial && wsNoCookie.closeCode === 4401, `B auth=cookie with no cookie closes 4401 (got ${wsNoCookie.closeCode})`);
      const loEvil = await call(baseUrl, 'POST', '/api/auth/logout', C(b.cookie, { origin: EVIL }));
      assert(loEvil.status === 403 && loEvil.json?.code === 'CSRF_ORIGIN' && loEvil.setCookies.length === 0, `B cookie sign-out from a foreign Origin -> 403 (got ${loEvil.status})`);
      assert((await sessionDoc(b.sid)).revokedAt === null && (await me(C(b.cookie))).status === 200, 'B nothing revoked by the refused sign-out');
      const lo = await call(baseUrl, 'POST', '/api/auth/logout', C(b.cookie));
      assert(lo.status === 200 && lo.json?.ok === true && lo.json?.revoked === true, `B cookie sign-out: ${lo.status} ${J(lo.json)}`);
      assert(lo.setCookies.length === 1 && parseSet(lo.setCookies[0]).value === '' && parseSet(lo.setCookies[0]).a['max-age'] === '0', `B sign-out deletes the cookie ${J(lo.setCookies)}`);
      assert((await ws1.waitClose(3000)) === 4401, `B the open cookie socket closes 4401 (got ${ws1.closeCode})`);
      assert((await sessionDoc(b.sid)).revokeReason === 'logout', 'B record revoked (logout)');
      assert((await me(C(b.cookie))).status === 401 && (await getProbe(C(b.cookie))).status === 401, 'B the old cookie is refused');
      assert((await getProbe({ bearer: b.cookie })).status === 401 && (await postProbe({ bearer: b.cookie })).status === 401, 'B the same JWT as Bearer is refused');
      assert((await getProbe({ bearer: a.token })).status === 200, 'B the separate register session is untouched');
      const b2 = await cookieSignIn(a, 'B again');
      assert(b2.sid !== b.sid && (await me(C(b2.cookie))).status === 200, 'B signing in again works (fresh sid)');
      const rcodes = await call(baseUrl, 'POST', '/api/auth/recovery-codes', C(b2.cookie, { body: { currentPassword: a.pw } }));
      assert(rcodes.status === 200 && Array.isArray(rcodes.json?.codes) && rcodes.json.codes.length > 0, `B recovery codes work on the cookie: ${rcodes.status} ${J(rcodes.json && { e: rcodes.json.error })}`);
      details.push('B cookie sign-in: /me, GET, POST, WS; foreign/null/missing Origin 403/4403; sign-out revokes + deletes');

      // ---- C: multi-agency
      const mu = await register('m');
      const rx = await call(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), optIn: true, origin: ORIGIN, body: { agencyName: `T78 m2 ${ts}`, email: mu.email, password: mu.pw, operationId: `op-${crypto.randomUUID()}` } });
      assert(rx.status === 201 && rx.json?.token && rx.setCookies.length === 1 && parseSet(rx.setCookies[0]).value === rx.json.token, `C register-existing sets the cookie (${rx.status}, ${rx.setCookies.length})`);
      const ml = await login(mu.email, mu.pw, { optIn: true, origin: ORIGIN });
      assert(ml.status === 200 && ml.json?.chooseMembership === true && ml.json.memberships?.length === 2, `C login -> chooser: ${ml.status}`);
      assert(ml.setCookies.length === 0, 'C the chooser answer sets no cookie');
      assert((await call(baseUrl, 'GET', '/api/auth/memberships', C(ml.json.token))).status === 401, 'C a choose token is refused as a cookie');
      const pick = ml.json.memberships.find((x) => x.agencyName === `T78 m2 ${ts}`) || ml.json.memberships[1];
      const act = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: ml.json.token, optIn: true, origin: ORIGIN, body: { membershipId: pick.membershipId } });
      assert(act.status === 200 && act.json?.token && act.setCookies.length === 1, `C activate sets the cookie: ${act.status} ${act.setCookies.length}`);
      const actCookie = parseSet(act.setCookies[0]).value;
      assert(actCookie === act.json.token && claimsOf(actCookie).mem === pick.membershipId, 'C the cookie is the activated session');
      const mm = await me(C(actCookie));
      assert(mm.status === 200 && mm.json?.user?.agencyId === pick.agencyId, `C /me on the cookie is the chosen agency: ${mm.status}`);
      const list = await call(baseUrl, 'GET', '/api/auth/memberships', C(actCookie));
      assert(list.status === 200 && list.json?.memberships?.length === 2 && list.json.memberships.some((x) => x.isCurrent && x.membershipId === pick.membershipId), `C the chooser list works on the cookie: ${list.status}`);
      const other = ml.json.memberships.find((x) => x.membershipId !== pick.membershipId);
      const sw = await call(baseUrl, 'POST', '/api/auth/activate', C(actCookie, { body: { membershipId: other.membershipId } }));
      assert(sw.status === 200 && sw.setCookies.length === 1 && claimsOf(parseSet(sw.setCookies[0]).value).mem === other.membershipId, `C switching on the cookie replaces the cookie: ${sw.status}`);
      const swEvil = await call(baseUrl, 'POST', '/api/auth/activate', C(actCookie, { origin: EVIL, body: { membershipId: other.membershipId } }));
      assert(swEvil.status === 403 && swEvil.setCookies.length === 0, `C switching on the cookie from a foreign Origin -> 403 (got ${swEvil.status})`);
      const ml2 = await login(mu.email, mu.pw, { optIn: true, origin: ORIGIN });
      assert(ml2.status === 200 && ml2.json?.chooseMembership === true && ml2.json.memberships.length === 2, 'C a fresh sign-in still lists both agencies');
      details.push('C multi: chooser no cookie; choose cookie refused; activate sets U; switch replaces U');

      // ---- D: adopt
      const adopt = (o) => call(baseUrl, 'POST', '/api/auth/session/adopt', o);
      const s = await login(a.email, a.pw, { origin: ORIGIN });
      const sClaims = claimsOf(s.json.token);
      const ad1 = await adopt({ bearer: s.json.token, optIn: true, origin: ORIGIN });
      assert(ad1.status === 200 && ad1.json?.adopted === true && ad1.setCookies.length === 1, `D adopt a session token: ${ad1.status} ${J(ad1.json)}`);
      assert(!J(ad1.json).includes('.'), 'D the token is never in the adopt answer');
      const ad1v = parseSet(ad1.setCookies[0]);
      assert(ad1v.value === s.json.token, 'D a session token becomes the cookie as it is (same sid)');
      const rec = await sessionDoc(sClaims.sid);
      assert(Number(ad1v.a['max-age']) <= Math.ceil((rec.absoluteExpMs - Date.now()) / 1000) + 1, 'D Max-Age no longer than the record');
      const proof = await me({ cookie: ad1v.value, optIn: true, origin: ORIGIN });
      assert(proof.status === 200 && proof.json?.auth === 'cookie', 'D a second request on the cookie alone proves it (adopt rule)');
      const ad1b = await adopt({ bearer: s.json.token, optIn: true, origin: ORIGIN });
      assert(ad1b.status === 200 && ad1b.json?.adopted === true, 'D adopt again: idempotent');
      const adCookie = await adopt(C(ad1v.value));
      assert(adCookie.status === 200 && adCookie.json?.adopted === true && adCookie.setCookies.length === 0, 'D adopt on the cookie: adopted, nothing set');
      for (const [label, o] of [['no opt-in', { origin: ORIGIN }], ['foreign Origin', { optIn: true, origin: EVIL }], ['missing Origin', { optIn: true }]]) {
        const r = await adopt({ bearer: s.json.token, ...o });
        assert(r.status === 403 && r.json?.code === 'CSRF_ORIGIN' && r.setCookies.length === 0, `D adopt with ${label} -> 403, no cookie (got ${r.status})`);
      }
      for (const legacy of [false, true]) {
        const mt = await ctx.api('POST', '/api/__test__/mint-token', { userId: a.id, ...(legacy ? { legacy: true } : {}) });
        assert(mt.status === 200 && mt.json?.token, `D mint old token: ${mt.status}`);
        const old = mt.json.token;
        const oc = claimsOf(old);
        assert(!('sid' in oc), 'D the old token has no sid');
        const r = await adopt({ bearer: old, optIn: true, origin: ORIGIN });
        assert(r.status === 200 && r.json?.adopted === true && r.setCookies.length === 1, `D adopt a pre-11 ${legacy ? 'v1' : 'v2'} token: ${r.status} ${J(r.json)}`);
        const nv = parseSet(r.setCookies[0]);
        const nc = claimsOf(nv.value);
        assert(nv.value !== old && typeof nc.sid === 'string', 'D a pre-11 token gets a new session cookie');
        const nd = await sessionDoc(nc.sid);
        assert(nd && nd.via === 'adopt' && nd.rowId === a.id && nd.absoluteExpMs <= oc.exp * 1000, `D the record ends no later than the old token ${J(nd && { via: nd.via })}`);
        assert(Number(nv.a['max-age']) <= oc.exp - Math.floor(Date.now() / 1000) + 1, 'D Max-Age no longer than the old token');
        assert((await me({ cookie: nv.value, optIn: true, origin: ORIGIN })).status === 200, 'D the adopted cookie works');
        assert((await getProbe({ bearer: old })).status === 200 && accepted(await postProbe({ bearer: old })), 'D the old Bearer token keeps working (no forced sign-out)');
      }
      const revoked = await login(a.email, a.pw, { origin: ORIGIN });
      await call(baseUrl, 'POST', '/api/auth/logout', { bearer: revoked.json.token });
      const adR = await adopt({ bearer: revoked.json.token, optIn: true, origin: ORIGIN });
      assert(adR.status === 401 && adR.setCookies.length === 0, `D adopt a revoked token -> 401, no cookie (got ${adR.status})`);
      const adC = await adopt({ bearer: ml2.json.token, optIn: true, origin: ORIGIN });
      assert(adC.status === 401 && adC.setCookies.length === 0, `D adopt a choose token -> 401 (got ${adC.status})`);
      const venues = await ctx.api('GET', '/api/venues');
      const venueId = (venues.json?.venues || venues.json || [])[0]?.id || 'venue-x';
      const kt = await ctx.api('POST', '/api/__test__/mint-kiosk-token', { userId: a.id, agencyId: 'agency-x', venueId, pv: '1', dev: 'dev-x' });
      assert(kt.status === 200 && kt.json?.token, `D a kiosk token was minted for the check (got ${kt.status})`);
      const adK = await adopt({ bearer: kt.json.token, optIn: true, origin: ORIGIN });
      assert((adK.status === 401 || adK.status === 403) && adK.setCookies.length === 0, `D adopt a kiosk token -> refused, no cookie (got ${adK.status})`);
      details.push('D adopt: sid token as is; pre-11 v1/v2 -> capped record; idempotent; refusals set nothing');

      // ---- E: claim types in U, precedence
      const old = (await ctx.api('POST', '/api/__test__/mint-token', { userId: a.id })).json.token;
      for (const [label, tok] of [['pre-11', old], ['choose', ml2.json.token], ['kiosk', kt.json?.token], ['forged', `${old.split('.')[0]}.${old.split('.')[1]}.AAAA`], ['junk', 'abc']]) {
        if (!tok) continue;
        const r = await me(C(tok));
        assert(r.status === 401, `E a ${label} token in U -> 401 (got ${r.status})`);
      }
      const wsOld = await connectWs(baseUrl, { query: '?auth=cookie', cookie: old, origin: ORIGIN });
      assert(!wsOld.initial && wsOld.closeCode === 4401, `E a pre-11 token in U on the socket -> 4401 (got ${wsOld.closeCode})`);
      const e1 = await cookieSignIn(a, 'E');
      const wsTwo = await new Promise((resolve) => {
        const w = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws?auth=cookie', { headers: { Cookie: `${COOKIE}=${e1.cookie}; ${COOKIE}=${e1.cookie}`, Origin: ORIGIN } });
        let init = false;
        w.on('message', (d) => { try { if (JSON.parse(String(d)).type === 'INITIAL_STATE') init = true; } catch {} });
        w.on('error', () => {});
        w.on('close', (code) => resolve({ code, init }));
        setTimeout(() => { try { w.close(); } catch {} resolve({ code: null, init }); }, 6000);
      });
      assert(!wsTwo.init && wsTwo.code === 4401, `E two U cookies on the socket -> 4401 (got ${wsTwo.code})`);
      const basic = await me({ cookie: e1.cookie, optIn: true, origin: ORIGIN, headers: { Authorization: 'Basic eDp5' } });
      assert(basic.status === 401, `E any Authorization header means the cookie is not read (got ${basic.status})`);
      const empty = await me({ cookie: e1.cookie, optIn: true, origin: ORIGIN, headers: { Authorization: '' } });
      assert(empty.status === 401, `E an empty Authorization header also means the cookie is not read (got ${empty.status})`);
      const twoJar = await me({ cookies: [`${COOKIE}=${e1.cookie}`, `${COOKIE}=${e1.cookie}`], optIn: true, origin: ORIGIN });
      assert(twoJar.status === 401, `E two U cookies -> 401 (got ${twoJar.status})`);
      const other2 = await register('o');
      const both = await me({ bearer: other2.token, cookie: e1.cookie, optIn: true, origin: ORIGIN });
      assert(both.status === 200 && both.json?.auth === 'bearer' && both.json?.user?.email === other2.email, `E Bearer wins over another person's cookie during the transition: ${both.status} ${J(both.json && { auth: both.json.auth })}`);
      const bothPost = await postProbe({ bearer: other2.token, cookie: e1.cookie, optIn: true, origin: EVIL });
      assert(accepted(bothPost), `E a Bearer request is not cookie-authenticated, so no Origin rule (got ${bothPost.status})`);
      const lob = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: other2.token, cookie: e1.cookie, optIn: true, origin: ORIGIN });
      assert(lob.status === 200 && lob.json?.revoked === true && lob.setCookies.length === 1 && parseSet(lob.setCookies[0]).a['max-age'] === '0', `E Bearer sign-out deletes the cookie: ${lob.status}`);
      assert((await sessionDoc(e1.sid)).revokedAt && (await me(C(e1.cookie))).status === 401, "E and ends this browser's cookie session too");
      assert((await getProbe({ bearer: other2.token })).status === 401, 'E and the Bearer session itself');
      details.push('E kiosk/choose/pre-11/forged/duplicate in U -> 401; Bearer precedence; Bearer sign-out ends the cookie session');

      // ---- F: route-table walk
      const f = await cookieSignIn(a, 'F');
      const rt = await call(baseUrl, 'GET', '/api/__test__/route-table');
      assert(rt.status === 200 && Array.isArray(rt.json?.routes || rt.json), `F route table: ${rt.status}`);
      const routes = (rt.json.routes || rt.json).filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'OPTIONS' && !r.public && typeof r.path === 'string' && r.path.startsWith('/api/'));
      assert(routes.length > 40, `F walks the mutating routes (${routes.length})`);
      const bad = [];
      for (const r of routes) {
        const path = r.path.replace(/:([A-Za-z_]+)/g, 'x-$1');
        for (const o of [{ origin: EVIL }, { origin: undefined }]) {
          const x = await call(baseUrl, r.method, path, C(f.cookie, { ...o, body: {} }));
          if (!(x.status === 403 && x.json?.code === 'CSRF_ORIGIN')) bad.push(`${r.method} ${r.path} ${o.origin ? 'foreign' : 'missing'} -> ${x.status}`);
        }
      }
      assert(bad.length === 0, `F every mutating route refuses a cookie from a foreign/missing Origin: ${bad.slice(0, 8).join('; ')}`);
      assert((await sessionDoc(f.sid)).revokedAt === null && (await me(C(f.cookie))).status === 200, 'F the walk changed nothing (the session is intact)');
      details.push(`F route walk: ${routes.length} mutating routes x foreign/missing Origin -> 403 CSRF_ORIGIN`);

      // ---- G: store outage on a cookie sign-out
      const g = await cookieSignIn(a, 'G');
      await hook({ action: 'fault', on: true });
      let lg;
      try {
        lg = await call(baseUrl, 'POST', '/api/auth/logout', C(g.cookie));
      } finally {
        await hook({ action: 'fault', on: false });
      }
      assert(lg.status === 503 && lg.json?.code === 'SESSION_STORE_UNAVAILABLE' && lg.setCookies.length === 0, `G sign-out during an outage -> 503, cookie kept (got ${lg.status}, ${lg.setCookies.length})`);
      assert((await me(C(g.cookie))).status === 200, 'G after the outage the cookie still works (nobody signed out)');
      // The revoke write itself fails (the request already passed the auth check):
      // a cookie sign-out answers 503, keeps the cookie, and the session stays live.
      const hk = await hook({ action: 'revokeFault', on: true });
      assert(hk.json?.revokeFault === true, 'G the revoke-fault hook is on');
      let lr;
      try {
        lr = await call(baseUrl, 'POST', '/api/auth/logout', C(g.cookie));
      } finally {
        await hook({ action: 'revokeFault', on: false });
      }
      assert(lr.status === 503 && lr.json?.code === 'SESSION_STORE_UNAVAILABLE' && lr.setCookies.length === 0, `G revoke write fails on a cookie sign-out -> 503, cookie kept (got ${lr.status}, ${lr.setCookies.length})`);
      assert((await sessionDoc(g.sid)).revokedAt === null && (await me(C(g.cookie))).status === 200, 'G the cookie session is not revoked and still works');
      // A Bearer sign-out that also ends another session in the cookie: one store
      // transaction, so a failed revoke write revokes neither and the same request can be retried.
      const gb = await register('g2');
      await hook({ action: 'revokeFault', on: true });
      let lg2;
      try {
        lg2 = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: gb.token, cookie: g.cookie, optIn: true, origin: ORIGIN });
      } finally {
        await hook({ action: 'revokeFault', on: false });
      }
      assert(lg2.status === 503 && lg2.json?.code === 'SESSION_STORE_UNAVAILABLE' && lg2.setCookies.length === 0, `G Bearer+cookie sign-out, revoke write fails -> 503, cookie kept (got ${lg2.status})`);
      assert((await sessionDoc(claimsOf(gb.token).sid)).revokedAt === null && (await sessionDoc(g.sid)).revokedAt === null, 'G neither session was revoked (all or none)');
      assert((await getProbe({ bearer: gb.token })).status === 200 && (await me(C(g.cookie))).status === 200, 'G both still work');
      const lg3 = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: gb.token, cookie: g.cookie, optIn: true, origin: ORIGIN });
      assert(lg3.status === 200 && lg3.json?.revoked === true && lg3.setCookies.length === 1, `G the same sign-out retried succeeds: ${lg3.status}`);
      assert((await sessionDoc(claimsOf(gb.token).sid)).revokeReason === 'logout' && (await sessionDoc(g.sid)).revokeReason === 'logout', 'G and ends both sessions');
      assert((await getProbe({ bearer: gb.token })).status === 401 && (await me(C(g.cookie))).status === 401, 'G after it neither works');
      details.push('G outage: 503, cookie kept, still signed in after');

    } catch (err) {
      throw new Error(`${err.message} || done: ${details.join(' | ')}`);
    } finally {
      await hook({ action: 'fault', on: false }).catch(() => {});
    }
    return details.join(' | ');
  },
};
