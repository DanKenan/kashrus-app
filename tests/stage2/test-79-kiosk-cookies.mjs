/**
 * Test 79 (item 11, PR 11a-s3, plan v8 9.1 / 9.2 / 15.1): kiosk session
 * records, the kiosk cookie K, the device cookie D and kiosk adopt - with
 * today's tablets unchanged.
 *  A  today's tablet (no opt-in): pairing, PIN sign-in and the board set no
 *     cookie; the kiosk token now carries a sid backed by a kiosk session
 *     record (via 'kiosk-login', 3 h, never moved); a kiosk token from before
 *     this release (no sid) keeps working (running kiosks stay signed in);
 *     sign-out on the tablet revokes its record (same token then 401) and
 *     closes its open socket 4401.
 *  B  cookie tablet (opted in, trusted Origin): the approved pairing sets D;
 *     the roster, PIN sign-in, the board, /api/auth/me and a socket work on
 *     D + K alone; K is set to the token handed out (3 h Max-Age) and the
 *     sign-in deletes U; D from a foreign Origin proves nothing on a POST;
 *     K mutations from a foreign Origin are 403 CSRF_ORIGIN; K without D,
 *     K with another tablet's D, two K, U + K, a user token in K and a
 *     pre-11a-s3 kiosk token in K are refused (HTTP 401, socket 4401/4403);
 *     an ordinary sign-in on the tablet sets U and deletes K but never D;
 *     sign-out deletes K (not D) and ends the record; unpair deletes D + K.
 *  C  kiosk adopt: a sid kiosk token becomes K as it is; a pre-11a-s3 kiosk
 *     token gets a new record (via 'kiosk-adopt') and a token with its own
 *     iat and no later end; D is set from the header; the old Bearer keeps
 *     working; refused without the opt-in, from a foreign Origin, for a user
 *     token and a revoked kiosk token; neither token nor secret in the answer.
 *  D  record end: an expired kiosk record is refused on HTTP and on a new
 *     socket (the record and the token both end 3 h after sign-in).
 *  E  store outage: kiosk sign-in answers 503 SESSION_STORE_UNAVAILABLE with
 *     no token and no cookie; a kiosk mutation answers 503 (never 401); after
 *     the outage the same token works.
 *  F  a fresh email+password sign-in afterwards (opted in and not) works.
 */
import WebSocket from 'ws';
const J = (o) => JSON.stringify(o);
function assert(c, m) { if (!c) throw new Error(m); }
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const U = 'shutfey_s', K = 'shutfey_ks', D = 'shutfey_kd'; // test-mode names (production: __Host-… + Secure, stage4)
const AGENCY = 'agency-test79';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(baseUrl, method, path, { bearer, cookies, origin, optIn, device, ip, body, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (cookies && cookies.length) headers.Cookie = cookies.join('; ');
  if (origin !== undefined) headers.Origin = origin;
  if (optIn) headers['X-Shutfey-Auth'] = 'cookie';
  if (device !== undefined) headers['X-Kiosk-Device'] = device;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const set = {};
  for (const line of all) {
    const [nv, ...attrs] = line.split(';').map((s) => s.trim());
    const name = nv.slice(0, nv.indexOf('='));
    const a = {};
    for (const x of attrs) { const i = x.indexOf('='); a[(i < 0 ? x : x.slice(0, i)).toLowerCase()] = i < 0 ? true : x.slice(i + 1); }
    set[name] = { value: nv.slice(nv.indexOf('=') + 1), a, cleared: a['max-age'] === '0' };
  }
  return { status: res.status, json, text, set, names: Object.keys(set) };
}

function connectWs(baseUrl, { query = '', cookies, origin, frame } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookies && cookies.length) headers.Cookie = cookies.join('; ');
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
    const timer = setTimeout(done, 7000);
    ws.on('open', () => { if (frame) ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: frame })); });
    ws.on('message', (d) => { let m = null; try { m = JSON.parse(String(d)); } catch {} if (m && m.type === 'INITIAL_STATE' && !gotInitial) { gotInitial = true; done(); } });
    ws.on('error', () => {});
    ws.on('close', (code) => { closeCode = code; waiters.splice(0).forEach((w) => w(code)); done(); });
  });
}

export default {
  name: 'Test 79: item 11 (11a-s3) — kiosk session records, kiosk cookie K, device cookie D, kiosk adopt',
  whatItProves:
    'Kiosk sign-ins are server session records (3 h, revocable); the kiosk and device cookies are set and read only for tablets that opt in, only with a trusted Origin, never alongside the user cookie; adopt moves a tablet to cookies without signing it out; today\'s tablets and running kiosks see no change.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.79.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const ORIGIN = baseUrl.replace(/\/$/, '');
    const EVIL = 'https://evil.example';
    const details = [];
    const venueId = `venue-t79-${ts}`;
    const adminId = `user-t79-admin-${ts}`;
    const mashId = `user-t79-mash-${ts}`;
    const taskId = `task-t79-${ts}`;
    const PIN = '3579';
    const hook = (body) => call(baseUrl, 'POST', '/api/__test__/session-hooks', { body });
    const sessionDoc = async (sid) => { const r = await hook({ action: 'get', sid }); assert(r.status === 200, `hook get: ${r.status}`); return r.json.doc; };
    const opened = [];
    let tAdmin = null;
    const devices = [];

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test79 Agency' }],
      venues: [{ id: venueId, name: `T79 Venue ${ts}`, agencyId: AGENCY }],
      users: [
        { id: adminId, email: `admin79-${ts}@test.local`, name: 'T79 Admin', role: 'admin', agencyId: AGENCY },
        { id: mashId, email: `mash79-${ts}@test.local`, name: 'T79 Mash', role: 'mashgiach', agencyId: AGENCY, venueId, kioskPin: PIN },
      ],
      tasks: [
        { id: taskId, agencyId: AGENCY, venueId, title: `Task 79 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const mint = await call(baseUrl, 'POST', '/api/__test__/mint-token', { body: { userId: adminId } });
    assert(mint.status === 200, `mint admin: ${mint.status}`);
    tAdmin = mint.json.token;
    const clear = await call(baseUrl, 'POST', '/api/__test__/kiosk-clear-lockouts', { bearer: tAdmin });
    assert(clear.status === 200, `clear lockouts: ${clear.status}`);

    const pairTablet = async (claimOpts = {}) => {
      const start = await call(baseUrl, 'POST', '/api/kiosk/pairing/start', { ip: ip(), body: {} });
      assert(start.status === 200 && start.names.length === 0, `pairing/start: ${start.status} ${J(start.names)}`);
      const { pairingId, code, deviceSecret } = start.json;
      const pair = await call(baseUrl, 'POST', '/api/kiosk/devices/pair', { bearer: tAdmin, body: { code, venueId } });
      assert(pair.status === 201, `devices/pair: ${pair.status}`);
      const claim = await call(baseUrl, 'GET', '/api/kiosk/pairing/status', { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` }, ...claimOpts });
      assert(claim.status === 200 && claim.json?.status === 'approved', `pairing claim: ${claim.status}`);
      const cred = `${claim.json.device.id}.${deviceSecret}`;
      devices.push(claim.json.device.id);
      return { id: claim.json.device.id, cred, claim, pairing: `${pairingId}.${deviceSecret}` };
    };
    const kioskLogin = (o) => call(baseUrl, 'POST', '/api/kiosk/login', { ip: ip(), body: { userId: mashId, pin: PIN }, ...o });
    const board = (o) => call(baseUrl, 'GET', '/api/tasks', o);
    const okStatus = (r) => r.status === 200;

    try {
      // ---- A: today's tablet, no opt-in
      const t1 = await pairTablet();
      assert(t1.claim.names.length === 0, `A pairing without opt-in sets no cookie ${J(t1.claim.names)}`);
      const roster = await call(baseUrl, 'GET', '/api/kiosk/device', { device: t1.cred });
      assert(roster.status === 200 && roster.names.length === 0, `A roster: ${roster.status}`);
      const l1 = await kioskLogin({ device: t1.cred, origin: ORIGIN });
      assert(l1.status === 200 && typeof l1.json?.token === 'string' && l1.names.length === 0, `A kiosk sign-in without opt-in: token, no cookie (${l1.status} ${J(l1.names)})`);
      const c1 = claimsOf(l1.json.token);
      assert(c1.kiosk === true && typeof c1.sid === 'string' && c1.sid.length === 22 && c1.dev === t1.id && c1.exp - c1.iat === 3 * 3600, `A kiosk token carries sid, 3 h ${J({ sid: !!c1.sid, d: c1.exp - c1.iat })}`);
      const r1 = await sessionDoc(c1.sid);
      assert(r1 && r1.kind === 'kiosk' && r1.via === 'kiosk-login' && r1.rowId === mashId && r1.agencyId === AGENCY && r1.venueId === venueId && r1.kioskDeviceId === t1.id && r1.pvAtIssue === c1.pv && r1.revokedAt === null, `A kiosk session record ${J(r1 && { kind: r1.kind, via: r1.via })}`);
      assert(r1.absoluteExpMs === r1.createdAtMs + 3 * 3600 * 1000 && !('idleExpMs' in r1), 'A record ends 3 h after sign-in, no idle limit');
      assert(Math.abs(r1.absoluteExpMs - (c1.iat + 3 * 3600) * 1000) < 2000, 'A record and token end together');
      const b1 = await board({ bearer: l1.json.token, device: t1.cred });
      assert(okStatus(b1) && b1.names.length === 0, `A board on Bearer + header: ${b1.status}`);
      const nod = await board({ bearer: l1.json.token });
      assert(nod.status === 401, `A kiosk token without device proof: ${nod.status}`);
      const meK = await call(baseUrl, 'GET', '/api/auth/me', { bearer: l1.json.token, device: t1.cred });
      assert(meK.status === 200 && meK.json?.auth === 'bearer' && meK.json?.user?.id === mashId && meK.json?.kiosk?.venueId === venueId && meK.json?.kiosk?.deviceId === t1.id, `A /me on a kiosk session: ${meK.status} ${J(meK.json && meK.json.kiosk)}`);
      assert(!meK.text.includes(l1.json.token) && !('kioskPin' in (meK.json.user || {})) && !('password' in (meK.json.user || {})), 'A /me leaks no token or secret');
      const scope = await call(baseUrl, 'GET', '/api/agencies/current', { bearer: l1.json.token, device: t1.cred });
      assert(scope.status === 403 && scope.json?.code === 'KIOSK_SCOPE', `A other routes still KIOSK_SCOPE: ${scope.status}`);
      // a kiosk token from before this release (no sid) keeps working
      const legacy = await call(baseUrl, 'POST', '/api/__test__/mint-kiosk-token', { body: { userId: mashId, agencyId: AGENCY, venueId, pv: c1.pv, dev: t1.id } });
      assert(legacy.status === 200 && !claimsOf(legacy.json.token).sid, 'A legacy kiosk token minted');
      const lb = await board({ bearer: legacy.json.token, device: t1.cred });
      assert(okStatus(lb), `A pre-11a-s3 kiosk token keeps working: ${lb.status}`);
      const lws = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(legacy.json.token)}`, frame: t1.cred });
      opened.push(lws);
      assert(lws.initial, 'A pre-11a-s3 kiosk socket works (frame proof)');
      // today's socket (?token= + frame) on the sid token, then sign-out closes it
      const ws1 = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(l1.json.token)}`, frame: t1.cred });
      opened.push(ws1);
      assert(ws1.initial, `A kiosk sid socket works (close ${ws1.closeCode})`);
      const noFrame = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(l1.json.token)}` });
      opened.push(noFrame);
      assert(!noFrame.initial && (await noFrame.waitClose(7000)) === 4401, 'A kiosk socket without device proof closes 4401');
      const out1 = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: l1.json.token, device: t1.cred });
      assert(out1.status === 200 && out1.json?.revoked === true, `A kiosk sign-out revokes: ${out1.status} ${J(out1.json)}`);
      assert((await ws1.waitClose()) === 4401, 'A sign-out closes the kiosk socket 4401');
      const r1r = await sessionDoc(c1.sid);
      assert(r1r && r1r.revokedAt && r1r.revokeReason === 'logout', `A record revoked (logout) ${J(r1r && { at: !!r1r.revokedAt, why: r1r.revokeReason })}`);
      const after1 = await board({ bearer: l1.json.token, device: t1.cred });
      assert(after1.status === 401, `A the same kiosk token after sign-out: ${after1.status}`);
      const lout = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: legacy.json.token, device: t1.cred });
      assert(lout.status === 200 && lout.json?.revoked === false, `A pre-11a-s3 kiosk sign-out: nothing to revoke (${lout.status})`);
      details.push('A today\'s tablet: no cookies, sid-backed 3 h record, legacy kiosk token works, sign-out revokes + 4401');

      // ---- B: cookie tablet
      const evilPair = await pairTablet({ optIn: true, origin: EVIL });
      assert(evilPair.claim.names.length === 0, `B approved pairing from a foreign Origin sets no D ${J(evilPair.claim.names)}`);
      const t2 = await pairTablet({ optIn: true, origin: ORIGIN });
      const dset = t2.claim.set[D];
      assert(dset && dset.value === t2.cred, 'B approved pairing (opt-in, trusted Origin) sets D = the device credential');
      assert(dset.a.httponly === true && String(dset.a.samesite).toLowerCase() === 'lax' && dset.a.path === '/' && !('domain' in dset.a) && Number(dset.a['max-age']) === 400 * 24 * 3600, `B D attributes ${J(dset.a)}`);
      assert(!t2.claim.text.includes(t2.cred.split('.')[1]), 'B the secret is never in the JSON');
      const DC = `${D}=${t2.cred}`;
      const ros = await call(baseUrl, 'GET', '/api/kiosk/device', { cookies: [DC], optIn: true, origin: ORIGIN });
      assert(ros.status === 200 && Array.isArray(ros.json?.users), `B roster on D: ${ros.status}`);
      const rosNo = await call(baseUrl, 'GET', '/api/kiosk/device', { cookies: [DC], origin: ORIGIN });
      assert(rosNo.status === 401 && rosNo.json?.code === 'KIOSK_UNPAIRED', `B D is not read without the opt-in: ${rosNo.status}`);
      const rosBad = await call(baseUrl, 'GET', '/api/kiosk/device', { cookies: [DC], optIn: true, origin: ORIGIN, device: 'bogus.header' });
      assert(rosBad.status === 401, `B a bad X-Kiosk-Device header never falls back to D: ${rosBad.status}`);
      const rosTwo = await call(baseUrl, 'GET', '/api/kiosk/device', { cookies: [DC, `${D}=${t1.cred}`], optIn: true, origin: ORIGIN });
      assert(rosTwo.status === 401, `B two D cookies prove nothing: ${rosTwo.status}`);
      const lEvil = await kioskLogin({ cookies: [DC], optIn: true, origin: EVIL });
      assert(lEvil.status === 401 && lEvil.json?.code === 'KIOSK_UNPAIRED' && lEvil.names.length === 0, `B D on a cross-site POST proves nothing: ${lEvil.status}`);
      const lNoOrigin = await kioskLogin({ cookies: [DC], optIn: true });
      assert(lNoOrigin.status === 401 && lNoOrigin.names.length === 0, `B D on a POST without Origin proves nothing: ${lNoOrigin.status}`);
      const l2 = await kioskLogin({ cookies: [DC, `${U}=stale.user.cookie`], optIn: true, origin: ORIGIN });
      assert(l2.status === 200 && typeof l2.json?.token === 'string', `B kiosk sign-in on D: ${l2.status} ${J(l2.json)}`);
      const kset = l2.set[K];
      assert(kset && kset.value === l2.json.token, 'B K = the kiosk token handed out');
      const kAge = Number(kset.a['max-age']);
      assert(kset.a.httponly === true && String(kset.a.samesite).toLowerCase() === 'lax' && kset.a.path === '/' && kAge > 3 * 3600 - 60 && kAge <= 3 * 3600, `B K attributes / 3 h Max-Age ${J(kset.a)}`);
      assert(l2.set[U] && l2.set[U].cleared, 'B kiosk sign-in deletes U on the tablet');
      assert(l2.set[D] && l2.set[D].value === t2.cred && !l2.set[D].cleared, 'B kiosk sign-in sets D again');
      const KC = `${K}=${l2.json.token}`;
      const c2 = claimsOf(l2.json.token);
      const hdrLogin = await kioskLogin({ device: t2.cred, optIn: true, origin: ORIGIN });
      assert(hdrLogin.status === 200 && hdrLogin.set[K] && hdrLogin.set[D] && hdrLogin.set[D].value === t2.cred, 'B header-proved sign-in (opted in) also sets K and D');
      const b2 = await board({ cookies: [KC, DC], optIn: true, origin: ORIGIN });
      assert(okStatus(b2), `B board on K + D alone: ${b2.status}`);
      const me2 = await call(baseUrl, 'GET', '/api/auth/me', { cookies: [KC, DC], optIn: true, origin: ORIGIN });
      assert(me2.status === 200 && me2.json?.auth === 'cookie' && me2.json?.user?.id === mashId && me2.json?.kiosk?.deviceId === t2.id, `B /me on K: ${me2.status} ${J(me2.json && { auth: me2.json.auth })}`);
      const kNoOpt = await board({ cookies: [KC, DC], origin: ORIGIN });
      assert(kNoOpt.status === 401, `B K is not read without the opt-in: ${kNoOpt.status}`);
      const kNoD = await board({ cookies: [KC], optIn: true, origin: ORIGIN });
      assert(kNoD.status === 401, `B K without device proof: ${kNoD.status}`);
      const t3 = await pairTablet();
      const kOtherD = await board({ cookies: [KC, `${D}=${t3.cred}`], optIn: true, origin: ORIGIN });
      assert(kOtherD.status === 401, `B K with another tablet's D: ${kOtherD.status}`);
      const kHdrOther = await board({ cookies: [KC, DC], optIn: true, origin: ORIGIN, device: t3.cred });
      assert(kHdrOther.status === 401, `B the header wins over D (another tablet's header refused): ${kHdrOther.status}`);
      const csrf = await call(baseUrl, 'PUT', `/api/tasks/${taskId}`, { cookies: [KC, DC], optIn: true, origin: EVIL, body: { isCompleted: true } });
      assert(csrf.status === 403 && csrf.json?.code === 'CSRF_ORIGIN', `B K mutation from a foreign Origin: ${csrf.status}`);
      const csrf2 = await call(baseUrl, 'POST', '/api/auth/logout', { cookies: [KC, DC], optIn: true });
      assert(csrf2.status === 403 && csrf2.json?.code === 'CSRF_ORIGIN', `B K sign-out without Origin: ${csrf2.status}`);
      assert((await sessionDoc(c2.sid)).revokedAt === null, 'B nothing revoked by the refused sign-out');
      const twoK = await board({ cookies: [KC, `${K}=${l2.json.token}`, DC], optIn: true, origin: ORIGIN });
      assert(twoK.status === 401, `B two K cookies: ${twoK.status}`);
      const uTok = await call(baseUrl, 'POST', '/api/__test__/mint-token', { body: { userId: adminId, session: true } });
      const bothUK = await board({ cookies: [`${U}=${uTok.json.token}`, KC, DC], optIn: true, origin: ORIGIN });
      assert(bothUK.status === 401, `B U + K together: ${bothUK.status}`);
      const userInK = await board({ cookies: [`${K}=${uTok.json.token}`, DC], optIn: true, origin: ORIGIN });
      assert(userInK.status === 401, `B a user token in K: ${userInK.status}`);
      const legacy2 = await call(baseUrl, 'POST', '/api/__test__/mint-kiosk-token', { body: { userId: mashId, agencyId: AGENCY, venueId, pv: c2.pv, dev: t2.id } });
      const legacyInK = await board({ cookies: [`${K}=${legacy2.json.token}`, DC], optIn: true, origin: ORIGIN });
      assert(legacyInK.status === 401, `B a pre-11a-s3 kiosk token in K: ${legacyInK.status}`);
      const bearerWins = await board({ bearer: legacy2.json.token, cookies: [KC, DC], optIn: true, origin: ORIGIN, device: t2.cred });
      assert(okStatus(bearerWins), `B Bearer still wins over K: ${bearerWins.status}`);
      // sockets
      const wsK = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [KC, DC], origin: ORIGIN });
      opened.push(wsK);
      assert(wsK.initial, `B socket on K + D (no frame needed): close ${wsK.closeCode}`);
      const wsKf = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [KC], origin: ORIGIN, frame: t2.cred });
      opened.push(wsKf);
      assert(wsKf.initial, `B socket on K without D proves with the frame: close ${wsKf.closeCode}`);
      const wsKnone = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [KC], origin: ORIGIN });
      opened.push(wsKnone);
      assert(!wsKnone.initial && (await wsKnone.waitClose(7000)) === 4401, 'B socket on K with no device proof closes 4401');
      const wsKother = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [KC, `${D}=${t3.cred}`], origin: ORIGIN });
      opened.push(wsKother);
      assert(!wsKother.initial && (await wsKother.waitClose(7000)) === 4401, 'B socket on K with another tablet\'s D closes 4401');
      const wsEvil = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [KC, DC], origin: EVIL });
      opened.push(wsEvil);
      assert(!wsEvil.initial && wsEvil.closeCode === 4403, `B socket on K from a foreign Origin: ${wsEvil.closeCode}`);
      const wsBoth = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [`${U}=${uTok.json.token}`, KC, DC], origin: ORIGIN });
      opened.push(wsBoth);
      assert(!wsBoth.initial && wsBoth.closeCode === 4401, `B socket on U + K: ${wsBoth.closeCode}`);
      const wsUinK = await connectWs(baseUrl, { query: '?auth=cookie', cookies: [`${K}=${uTok.json.token}`, DC], origin: ORIGIN });
      opened.push(wsUinK);
      assert(!wsUinK.initial && wsUinK.closeCode === 4401, `B socket with a user token in K: ${wsUinK.closeCode}`);
      // an ordinary sign-in on the tablet sets U and deletes K, never D
      const adminEmail = `admin79-${ts}@test.local`;
      const setPw = await call(baseUrl, 'POST', '/api/__test__/set-password', { body: { userId: adminId, password: 'Pass-79-admin!' } });
      if (setPw.status === 200) {
        const ul = await call(baseUrl, 'POST', '/api/auth/login', { ip: ip(), cookies: [KC, DC], optIn: true, origin: ORIGIN, body: { email: adminEmail, password: 'Pass-79-admin!' } });
        assert(ul.status === 200 && ul.set[U] && !ul.set[U].cleared && ul.set[K] && ul.set[K].cleared && !ul.set[D], `B ordinary sign-in on the tablet: U set, K deleted, D untouched (${ul.status} ${J(ul.names)})`);
        details.push('B ordinary sign-in sets U, deletes K, keeps D');
      } else {
        throw new Error(`set-password hook: ${setPw.status}`);
      }
      // sign-out on K
      const out2 = await call(baseUrl, 'POST', '/api/auth/logout', { cookies: [KC, DC], optIn: true, origin: ORIGIN });
      assert(out2.status === 200 && out2.json?.revoked === true, `B sign-out on K: ${out2.status} ${J(out2.json)}`);
      assert(out2.set[K] && out2.set[K].cleared && out2.set[U] && out2.set[U].cleared && !out2.set[D], `B sign-out deletes K (and U), keeps D ${J(out2.names)}`);
      assert((await wsK.waitClose()) === 4401 && (await wsKf.waitClose()) === 4401, 'B sign-out closes the K sockets 4401');
      const kAfter = await board({ cookies: [KC, DC], optIn: true, origin: ORIGIN });
      const kAfterB = await board({ bearer: l2.json.token, device: t2.cred });
      assert(kAfter.status === 401 && kAfterB.status === 401, `B the same kiosk token after sign-out: cookie ${kAfter.status}, Bearer ${kAfterB.status}`);
      // the tablet stays paired: sign in again on D, then unpair on D
      const l3 = await kioskLogin({ cookies: [DC], optIn: true, origin: ORIGIN });
      assert(l3.status === 200 && l3.set[K], `B sign-in again on D after sign-out: ${l3.status}`);
      const unEvil = await call(baseUrl, 'POST', '/api/kiosk/device/unpair', { cookies: [DC], optIn: true, origin: EVIL });
      assert(unEvil.status === 401, `B cross-site unpair on D: ${unEvil.status}`);
      const stillPaired = await call(baseUrl, 'GET', '/api/kiosk/device', { device: t2.cred });
      assert(stillPaired.status === 200, 'B the cross-site unpair changed nothing');
      const un = await call(baseUrl, 'POST', '/api/kiosk/device/unpair', { cookies: [DC, `${K}=${l3.json.token}`], optIn: true, origin: ORIGIN });
      assert(un.status === 200 && un.set[D] && un.set[D].cleared && un.set[K] && un.set[K].cleared, `B unpair on D deletes D and K (${un.status} ${J(un.names)})`);
      const gone = await call(baseUrl, 'GET', '/api/kiosk/device', { device: t2.cred });
      assert(gone.status === 401, 'B unpaired');
      details.push('B cookie tablet: D on approval, roster/sign-in/board/me/socket on D+K, CSRF + every bad combination refused, sign-out keeps D, unpair clears D+K');

      // ---- C: kiosk adopt (t1 is still paired; today's tablet moves to cookies)
      const l4 = await kioskLogin({ device: t1.cred });
      assert(l4.status === 200, `C sign-in: ${l4.status}`);
      const c4 = claimsOf(l4.json.token);
      const adoptNo = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: l4.json.token, device: t1.cred, origin: ORIGIN });
      assert(adoptNo.status === 403 && adoptNo.json?.code === 'CSRF_ORIGIN' && adoptNo.names.length === 0, `C adopt without opt-in: ${adoptNo.status}`);
      const adoptEvil = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: l4.json.token, device: t1.cred, optIn: true, origin: EVIL });
      assert(adoptEvil.status === 403 && adoptEvil.names.length === 0, `C adopt from a foreign Origin: ${adoptEvil.status}`);
      const adoptUser = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: uTok.json.token, optIn: true, origin: ORIGIN });
      assert(adoptUser.status === 401 && adoptUser.names.length === 0, `C adopt with a user token: ${adoptUser.status}`);
      const ad = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: l4.json.token, device: t1.cred, optIn: true, origin: ORIGIN });
      assert(ad.status === 200 && ad.json?.ok === true && ad.json?.adopted === true, `C adopt: ${ad.status} ${J(ad.json)}`);
      assert(ad.set[K] && ad.set[K].value === l4.json.token && ad.set[D] && ad.set[D].value === t1.cred && ad.set[U] && ad.set[U].cleared, `C adopt sets K (same token), D (from the header), deletes U ${J(ad.names)}`);
      assert(!ad.text.includes(l4.json.token) && !ad.text.includes(t1.cred.split('.')[1]), 'C adopt answer carries neither token nor secret');
      const adAge = Number(ad.set[K].a['max-age']);
      const r4 = await sessionDoc(c4.sid);
      assert(adAge <= Math.ceil((r4.absoluteExpMs - Date.now()) / 1000) + 1 && adAge > 3 * 3600 - 120, `C K Max-Age no longer than the record (${adAge})`);
      const K4 = `${K}=${l4.json.token}`, D1 = `${D}=${t1.cred}`;
      const again = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { cookies: [K4, D1], optIn: true, origin: ORIGIN });
      assert(again.status === 200 && again.json?.adopted === true && again.names.length === 0, `C adopt on the cookie: idempotent, nothing set (${again.status} ${J(again.names)})`);
      const b4 = await board({ cookies: [K4, D1], optIn: true, origin: ORIGIN });
      const b4b = await board({ bearer: l4.json.token, device: t1.cred });
      assert(okStatus(b4) && okStatus(b4b), `C after adopt: cookie ${b4.status}, old Bearer ${b4b.status}`);
      // a pre-11a-s3 kiosk token (no sid): a new record that ends no later than the token
      const legacy3 = await call(baseUrl, 'POST', '/api/__test__/mint-kiosk-token', { body: { userId: mashId, agencyId: AGENCY, venueId, pv: c4.pv, dev: t1.id } });
      const lc = claimsOf(legacy3.json.token);
      await sleep(1100);
      const ad2 = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: legacy3.json.token, device: t1.cred, optIn: true, origin: ORIGIN });
      assert(ad2.status === 200 && ad2.set[K] && ad2.set[D], `C adopt a pre-11a-s3 kiosk token: ${ad2.status} ${J(ad2.names)}`);
      const nk = claimsOf(ad2.set[K].value);
      assert(nk.kiosk === true && typeof nk.sid === 'string' && nk.iat === lc.iat && nk.exp <= lc.exp && nk.dev === t1.id && nk.pv === c4.pv, `C the new kiosk token keeps the old iat and no later end ${J({ iat: nk.iat === lc.iat, exp: nk.exp - lc.exp })}`);
      const r5 = await sessionDoc(nk.sid);
      assert(r5 && r5.kind === 'kiosk' && r5.via === 'kiosk-adopt' && r5.absoluteExpMs <= lc.exp * 1000, `C new record via kiosk-adopt, ends no later ${J(r5 && { via: r5.via })}`);
      assert(Number(ad2.set[K].a['max-age']) <= lc.exp - Math.floor(Date.now() / 1000) + 1, 'C K Max-Age no later than the old token');
      const b5 = await board({ cookies: [`${K}=${ad2.set[K].value}`, D1], optIn: true, origin: ORIGIN });
      const b5old = await board({ bearer: legacy3.json.token, device: t1.cred });
      assert(okStatus(b5) && okStatus(b5old), `C adopted cookie works (${b5.status}) and the old Bearer still works (${b5old.status})`);
      // revoked kiosk token: adopt refused. A Bearer sign-out also ends this tablet's K session.
      const out4 = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: l4.json.token, device: t1.cred, cookies: [`${K}=${ad2.set[K].value}`] });
      assert(out4.status === 200 && out4.json?.revoked === true && out4.set[K] && out4.set[K].cleared, `C Bearer sign-out: ${out4.status} ${J(out4.names)}`);
      const r5r = await sessionDoc(nk.sid);
      assert(r5r && r5r.revokedAt && r5r.revokeReason === 'logout', 'C the Bearer sign-out also revoked the K cookie\'s kiosk session');
      const adRev = await call(baseUrl, 'POST', '/api/kiosk/session/adopt', { bearer: l4.json.token, device: t1.cred, optIn: true, origin: ORIGIN });
      assert(adRev.status === 401 && adRev.names.length === 0, `C adopt a revoked kiosk token: ${adRev.status}`);
      details.push('C kiosk adopt: same token as K / new record with the old iat for a pre-11a-s3 token; old Bearer works; refusals set nothing');

      // ---- D: the record's end
      const l6 = await kioskLogin({ device: t1.cred });
      const c6 = claimsOf(l6.json.token);
      assert(okStatus(await board({ bearer: l6.json.token, device: t1.cred })), 'D fresh kiosk session works');
      const ex = await hook({ action: 'expire', sid: c6.sid });
      assert(ex.status === 200 && ex.json?.ok === true, `D expire hook: ${ex.status}`);
      await hook({ action: 'cache-age', sid: c6.sid, ageMs: 60000 });
      const d6 = await board({ bearer: l6.json.token, device: t1.cred });
      assert(d6.status === 401, `D an ended kiosk record is refused on HTTP: ${d6.status}`);
      const ws6 = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(l6.json.token)}`, frame: t1.cred });
      opened.push(ws6);
      assert(!ws6.initial && ws6.closeCode === 4401, `D and on a new socket: ${ws6.closeCode}`);
      // another instance's revocation reaches an open kiosk socket at its next delivery after the 15 s window
      const l9 = await kioskLogin({ device: t1.cred });
      const c9 = claimsOf(l9.json.token);
      const ws9 = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(l9.json.token)}`, frame: t1.cred });
      opened.push(ws9);
      assert(ws9.initial, 'D kiosk socket open');
      assert((await hook({ action: 'revoke-silent', sid: c9.sid })).json?.ok === true, 'D store-only revoke');
      assert((await hook({ action: 'cache-age', sid: c9.sid, ageMs: 15001 })).json?.ok === true, 'D age the entry');
      const wsA = await connectWs(baseUrl, { query: `?token=${encodeURIComponent(tAdmin)}` }); // USER_PRESENCE delivery to the agency
      opened.push(wsA);
      wsA.close();
      assert((await ws9.waitClose(5000)) === 4401, `D the open kiosk socket closes 4401 after the next delivery (got ${ws9.closeCode})`);
      details.push('D an ended kiosk record: HTTP 401, socket 4401; a store-only revoke closes an open kiosk socket');

      // ---- E: session store outage
      const l7 = await kioskLogin({ device: t1.cred });
      assert(l7.status === 200, `E sign-in before the outage: ${l7.status}`);
      await hook({ action: 'fault', on: true });
      let l8, put7;
      try {
        l8 = await kioskLogin({ device: t1.cred, optIn: true, origin: ORIGIN });
        put7 = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: l7.json.token, device: t1.cred });
      } finally {
        await hook({ action: 'fault', on: false });
      }
      assert(l8.status === 503 && l8.json?.code === 'SESSION_STORE_UNAVAILABLE' && !l8.json?.token && l8.names.length === 0, `E kiosk sign-in during an outage: ${l8.status} ${J(l8.json)} ${J(l8.names)}`);
      assert(put7.status === 503, `E a kiosk mutation during an outage: ${put7.status} (never 401)`);
      assert(okStatus(await board({ bearer: l7.json.token, device: t1.cred })), 'E after the outage the same kiosk token works');
      details.push('E outage: kiosk sign-in 503 no token/cookie; kiosk mutation 503; recovers');

      // ---- F: a fresh email+password sign-in afterwards
      const f1 = await call(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email: adminEmail, password: 'Pass-79-admin!' } });
      assert(f1.status === 200 && typeof f1.json?.token === 'string' && f1.names.length === 0, `F fresh sign-in (today's app): ${f1.status}`);
      const f2 = await call(baseUrl, 'POST', '/api/auth/login', { ip: ip(), optIn: true, origin: ORIGIN, body: { email: adminEmail, password: 'Pass-79-admin!' } });
      assert(f2.status === 200 && f2.set[U] && !f2.set[U].cleared, `F fresh sign-in (opted in): ${f2.status}`);
      assert(okStatus(await call(baseUrl, 'GET', '/api/agencies/current', { bearer: f1.json.token })), 'F the fresh Bearer works');
      details.push('F fresh email+password sign-in works (Bearer and cookie)');
    } finally {
      for (const c of opened) c.close();
      for (const id of devices) await call(baseUrl, 'DELETE', `/api/kiosk/devices/${encodeURIComponent(id)}`, { bearer: tAdmin }).catch(() => {});
    }
    return details.join('; ');
  },
};
