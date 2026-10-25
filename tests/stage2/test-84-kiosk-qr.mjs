/**
 * Test 84 (kiosk QR sign-in, server; addendum v2 AGREED Oct 24 2026 on plan
 * v8 9.7; Don's final word Oct 24 7:58 PM ET: "Just the mashgiach logged in
 * to his account, can scan QR code. That's it."): a signed-in phone opens the
 * scanned link, its page POSTs the approval, and the tablet opens on that
 * person. No passkey, no number, no separate confirm.
 *  A  approval / sessions: a phone with a cookie session and NO passkey
 *     approves, the tablet's poll claims (cookie tablet: K + D, never a token
 *     in JSON; header tablet: token in JSON); a 'kiosk-qr' session record (3 h);
 *     info never consumes or changes anything; no session / Bearer-only / a
 *     revoked or expired session / a K -> refused; a passkey-backed approving
 *     session whose passkey is gone (no cached copy) -> nothing opens; no PIN, or a PIN only at
 *     another venue of the same agency -> refused; two phones on one code ->
 *     one approval, the same person again -> "Already approved"; the phone
 *     session revoked or expired between approval and claim -> nothing opens;
 *     a person at the live-tablet cap -> nothing opens, no live entry dropped.
 *  C  CSRF / consent: approve without / with a foreign / null Origin, without
 *     X-Shutfey-Auth, or by GET -> refused, nothing approved; /k and /k/<code>
 *     are never framed, cached or referred; signing in approves nothing.
 *  R  clocks and races: approve at 59 s and claim after the code's 60 s;
 *     claim at 29.8 s ok and at exactly 30 s refused; reload, Cancel, a PIN
 *     sign-in, unpair and a PIN removal between approval and claim kill the
 *     approval; competing polls create one session; a lost claim answer is
 *     restored with the SAME session only while it is live and the tablet's
 *     latest (not after phone sign-out, a PIN sign-in, a new credential or
 *     3 h); tablet A never claims tablet B's code; extra codes at most 1/20 s.
 *  B  abuse: refused approvals limited per person (across sessions) and per
 *     IP (429); refusals and passive expiry never lock the tablet.
 *  P  phone status / sign-out: another person's U, a K and an unknown id get
 *     the same "not found"; "Sign out" ends only that tablet session (HTTP 401,
 *     socket 4401); an ordinary phone sign-out leaves the tablet running.
 *  H  addresses (APP_SITES set): QR link from server config only (agency
 *     address / shared address; Host and X-Forwarded-Host never pick it);
 *     duplicate Host, unknown Host and another agency's site Host get no
 *     link; approve on the shared host for an agency-address tablet works, on
 *     another agency's site is WRONG_SITE, on an unknown host refused, with a
 *     wrong Origin on a site 403 CSRF_ORIGIN; approval status on a foreign
 *     agency's site is "not found"; /api/site appOrigins; the menu flag.
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const J = (o) => JSON.stringify(o);
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = 'shutfey_s', K = 'shutfey_ks', D = 'shutfey_kd'; // test-mode cookie names
const SHARED_ORIGIN_CFG = 'https://workers-collaborative-dashboard-1080260390009.us-east1.run.app';
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;

export default {
  name: 'Test 84: kiosk QR sign-in (server) — a signed-in phone scans, the tablet opens',
  whatItProves:
    'A signed-in phone (no passkey, no number) approves one live tablet code with one POST from the right site; only the tablet that owns the code claims it, once, inside 30 s, while the approving session, the person\'s PIN at that venue and the tablet record are unchanged; links come from server config only; refusals are rate-limited without ever locking a tablet; the PIN pad is unchanged.',

  async run(baseUrl, ctx) {
    if (typeof ctx.restartServer !== 'function') throw new Error('Test 84 needs the harness restartServer hook');
    const port = Number(new URL(baseUrl).port);
    const ts = Date.now();
    const SHARED = `127.0.0.1:${port}`;
    const SHARED_O = `http://127.0.0.1:${port}`;
    const SA = `kqr-a.test:${port}`, SA_O = `http://${SA}`;
    const SDA = `kqr-da.test:${port}`, SDA_O = `http://${SDA}`;
    const SDB = `kqr-db.test:${port}`, SDB_O = `http://${SDB}`;
    const UNK = `kqr-unmapped.test:${port}`;
    let ipN = 1;
    const ip = () => `10.84.${ts % 200}.${(ipN++ % 250) + 1}`;

    const call = (method, path, { host = SHARED, bearer, cookies, origin, optIn, device, body, headers: extra, fromIp } = {}) => new Promise((resolve, reject) => {
      const headers = { Host: host, 'X-Forwarded-For': fromIp || ip(), ...(extra || {}) };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (cookies && cookies.length) headers.Cookie = cookies.join('; ');
      if (origin !== undefined) headers.Origin = origin;
      if (optIn) headers['X-Shutfey-Auth'] = 'cookie';
      if (device !== undefined) headers['X-Kiosk-Device'] = device;
      let data;
      if (body !== undefined) { data = Buffer.from(J(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch {}
          const sc = res.headers['set-cookie'] || [];
          const set = {};
          for (const line of sc) {
            const nv = line.split(';')[0];
            const name = nv.slice(0, nv.indexOf('='));
            set[name] = { value: nv.slice(nv.indexOf('=') + 1), cleared: /max-age=0/i.test(line) };
          }
          resolve({ status: res.statusCode, json, text, set, names: Object.keys(set), headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
    const hook = async (body) => { const r = await call('POST', '/api/__test__/kqr-hooks', { body }); assert(r.status === 200, `kqr hook ${body.action}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
    const sessionHook = async (body) => { const r = await call('POST', '/api/__test__/session-hooks', { body }); assert(r.status === 200, `session hook ${body.action}: ${r.status}`); return r.json; };
    const version = () => ctx.getVersion();
    const E = (k) => `t84-${k}-${ts}@test.local`;
    const PW = (k) => `t84-pass-${k}-${ts}`;
    const register = async (k) => {
      const r = await call('POST', '/api/agencies/register', { origin: SHARED_O, body: { agencyName: `T84 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T84 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      return { id: r.json.user.id, email: E(k), pw: PW(k), agencyId: r.json.user.agencyId, token: r.json.token };
    };

    // ---- phones: a cookie session U on a host (opt-in + that host's Origin) ----
    const phoneLogin = async (email, pw, host = SHARED) => {
      const origin = host === SHARED ? SHARED_O : `http://${host}`;
      const r = await call('POST', '/api/auth/login', { host, origin, optIn: true, body: { email, password: pw } });
      assert(r.status === 200 && r.set[U] && r.set[U].value && !r.set[U].cleared, `phone sign-in ${email} on ${host}: ${r.status} ${J(r.json && (r.json.error || Object.keys(r.json)))}`);
      const sid = JSON.parse(Buffer.from(r.json.token.split('.')[1], 'base64url').toString('utf8')).sid;
      return { host, origin, cookie: `${U}=${r.set[U].value}`, token: r.json.token, sid };
    };
    const ph = (p, method, path, body, o = {}) => call(method, path, { host: p.host, cookies: [p.cookie], origin: p.origin, optIn: true, body, ...o });
    const approve = (p, code, o = {}) => ph(p, 'POST', '/api/kiosk/qr/approve', { code }, o);
    const status = (p, id, o = {}) => ph(p, 'GET', `/api/kiosk/qr/approval/${id}`, undefined, o);

    // ---- tablets ----
    const pairTablet = async (adminToken, venueId, name) => {
      const start = await call('POST', '/api/kiosk/pairing/start', { body: {} });
      assert(start.status === 200, `pairing/start: ${start.status}`);
      const { pairingId, code, deviceSecret } = start.json;
      const pair = await call('POST', '/api/kiosk/devices/pair', { bearer: adminToken, origin: SHARED_O, body: { code, venueId, name } });
      assert(pair.status === 201, `devices/pair: ${pair.status} ${J(pair.json)}`);
      const claim = await call('GET', '/api/kiosk/pairing/status', { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
      assert(claim.status === 200 && claim.json?.status === 'approved', `pairing claim: ${claim.status}`);
      return { id: claim.json.device.id, cred: `${claim.json.device.id}.${deviceSecret}` };
    };
    /** via 'cookie' = a cookie tablet (D + opt-in + Origin); 'header' = X-Kiosk-Device (the transition path). */
    const tab = (t, path, { via = 'cookie', host = SHARED, origin, k, body = {}, fromIp } = {}) => via === 'cookie'
      ? call('POST', path, { host, cookies: [`${D}=${t.cred}`, ...(k ? [`${K}=${k}`] : [])], origin: origin ?? (host === SHARED ? SHARED_O : `http://${host}`), optIn: true, body, fromIp })
      : call('POST', path, { host, device: t.cred, origin: origin ?? (host === SHARED ? SHARED_O : `http://${host}`), body, fromIp });
    const start = (t, o) => tab(t, '/api/kiosk/qr/start', o);
    const poll = (t, o) => tab(t, '/api/kiosk/qr/poll', o);
    const cancel = (t, o) => tab(t, '/api/kiosk/qr/cancel', o);
    const codeOf = (r) => { const l = r.json?.link || ''; const c = l.slice(l.lastIndexOf('/') + 1); assert(CODE_RE.test(c), `a 22-char code in ${l}`); return c; };
    /** A fresh live code on this tablet (start; waits out the extra-code gap by moving its clock back). */
    const freshCode = async (t, o = {}) => {
      let r = await start(t, o);
      if (r.status === 200 && !r.json?.link) { await hook({ action: 'backdate', deviceId: t.id, ms: 61000, extraToo: true }); r = await start(t, o); }
      assert(r.status === 200 && r.json?.state === 'waiting' && r.json.link, `start ${t.id}: ${r.status} ${J(r.json)}`);
      return { code: codeOf(r), link: r.json.link, r };
    };
    const codeState = async (t) => (await hook({ action: 'get', deviceId: t.id })).code?.state;
    const board = (t, k) => call('GET', '/api/tasks', { cookies: [`${D}=${t.cred}`, `${K}=${k}`], optIn: true });
    const tabletsOf = async (p) => { const r = await ph(p, 'GET', '/api/kiosk/qr/tablets'); assert(r.status === 200, `tablets list: ${r.status}`); return r.json.tablets; };
    const signedIn = (r) => r.status === 200 && r.json?.state === 'signed-in';

    // ---- fixture: agencies A, B; venues; people ----
    const a = await register('a');
    const b = await register('b');
    const A = a.agencyId, B = b.agencyId;
    const vA1 = `venue-t84-a1-${ts}`, vA2 = `venue-t84-a2-${ts}`, vB = `venue-t84-b-${ts}`;
    const person = (k, agencyId, venueId) => ({ id: `usr-t84-${k}-${ts}`, personId: `usr-t84-${k}-${ts}`, email: E(k), name: `${k[0].toUpperCase()}${k.slice(1)} T84`, role: 'mashgiach', agencyId, venueId, password: PW(k) });
    const ppl = { yossi: person('yossi', A, vA1), chaim: person('chaim', A, vA1), nopin: person('nopin', A, vA1), other: person('other', A, vA2), bob: person('bob', B, vB) };
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      venues: [{ id: vA1, name: `Hill Bakery ${ts}`, agencyId: A }, { id: vA2, name: `Park Deli ${ts}`, agencyId: A }, { id: vB, name: `River Cafe ${ts}`, agencyId: B }],
      users: Object.values(ppl),
      tasks: [{ id: `task-t84-${ts}`, agencyId: A, venueId: vA1, title: `Task 84 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 }],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const setPin = async (adminToken, userId, pin) => {
      const r = await call('PUT', `/api/users/${userId}`, { bearer: adminToken, origin: SHARED_O, body: { kioskPin: pin, expectedVersion: await version() } });
      assert(r.status === 200, `set PIN ${userId}: ${r.status} ${J(r.json)}`);
    };
    await setPin(a.token, ppl.yossi.id, '2468');
    await setPin(a.token, ppl.chaim.id, '1357');
    await setPin(a.token, ppl.other.id, '9753');
    await setPin(b.token, ppl.bob.id, '8642');
    await call('POST', '/api/__test__/kiosk-clear-lockouts', { bearer: a.token, origin: SHARED_O });
    await hook({ action: 'reset-limits' });

    const T1 = await pairTablet(a.token, vA1, 'Front tablet');   // cookie tablet
    const T2 = await pairTablet(a.token, vA1, 'Back tablet');    // header tablet
    const T3 = await pairTablet(a.token, vA1, 'Side tablet');    // a second tablet at the same venue
    const TB = await pairTablet(b.token, vB, 'Cafe tablet');

    const yossi = await phoneLogin(ppl.yossi.email, ppl.yossi.password);
    const chaim = await phoneLogin(ppl.chaim.email, ppl.chaim.password);
    const nopin = await phoneLogin(ppl.nopin.email, ppl.nopin.password);
    const other = await phoneLogin(ppl.other.email, ppl.other.password);

    // =========================== A: approval / sessions ===========================
    {
      const s0 = await freshCode(T1);
      assert(s0.link === `${SHARED_ORIGIN_CFG}/k/${s0.code}`, `A agency without its own address: shared address link ${s0.link}`);
      assert(s0.r.names.length === 0 && !('token' in s0.r.json) && typeof s0.r.json.expiresAtMs === 'number', `A start sets nothing ${J(s0.r.names)}`);
      assert(/no-store/.test(String(s0.r.headers['cache-control'])), 'A tablet answers are no-store');
      const before = await hook({ action: 'get', deviceId: T1.id });
      const info = await call('GET', `/api/kiosk/qr/info/${s0.code}`);
      assert(info.status === 200 && info.json?.tablet?.name === 'Front tablet' && info.json.venue?.name === `Hill Bakery ${ts}` && info.json.agency?.name === `T84 a ${ts}`, `A info names: ${info.status} ${J(info.json)}`);
      assert(!info.text.includes(T1.id) && !info.text.includes(A) && !info.text.includes(before.code.hash) && !/sid|personId|deviceId|hash/.test(info.text), `A info carries no ids or hashes: ${info.text}`);
      for (let i = 0; i < 3; i++) await call('GET', `/api/kiosk/qr/info/${s0.code}`);
      const after = await hook({ action: 'get', deviceId: T1.id });
      assert(J(before) === J(after), 'A GET info consumes, starts and changes nothing');
      assert((await call('GET', `/api/kiosk/qr/info/${'x'.repeat(22)}`)).status === 404, 'A info of an unknown code 404');

      // Menu flag (D1): a person with a PIN at a venue sees "Sign in to a tablet"; without, not.
      const meY = await ph(yossi, 'GET', '/api/auth/me');
      assert(meY.status === 200 && meY.json?.canUseTabletSignIn === true, `A menu flag for a PIN holder: ${J(meY.json && meY.json.canUseTabletSignIn)}`);
      const meN = await ph(nopin, 'GET', '/api/auth/me');
      assert(meN.status === 200 && meN.json?.canUseTabletSignIn === false, 'A no menu flag without a PIN');
      const meBearer = await call('GET', '/api/auth/me', { bearer: yossi.token });
      assert(meBearer.status === 200 && meBearer.json?.canUseTabletSignIn === false, 'A no menu flag on a Bearer-only session');

      // Refused callers (nothing approved).
      assert((await call('POST', '/api/kiosk/qr/approve', { origin: SHARED_O, optIn: true, body: { code: s0.code } })).status === 401, 'A no session -> 401');
      const rb = await call('POST', '/api/kiosk/qr/approve', { bearer: yossi.token, origin: SHARED_O, body: { code: s0.code } });
      assert(rb.status === 401 && rb.json?.code === 'SIGN_IN_FIRST', `A Bearer-only -> Sign in first: ${rb.status} ${J(rb.json)}`);
      const rnp = await approve(nopin, s0.code);
      assert(rnp.status === 403 && rnp.json?.code === 'KIOSK_QR_NOT_HERE' && rnp.json.error === `You can't sign in on this tablet. Ask your administrator for a code at Hill Bakery ${ts}.`, `A no PIN -> refused: ${rnp.status} ${J(rnp.json)}`);
      const rov = await approve(other, s0.code);
      assert(rov.status === 403 && rov.json?.code === 'KIOSK_QR_NOT_HERE', `A PIN only at another venue of the agency -> refused: ${rov.status}`);
      assert((await codeState(T1)) === 'live', 'A refused approvals approve nothing');

      // The approval (scan = approve; no passkey on this person, no number).
      const ok = await approve(yossi, s0.code);
      assert(ok.status === 200 && typeof ok.json?.approvalId === 'string' && ok.json.tablet?.name === 'Front tablet' && ok.json.tablet.venueName === `Hill Bakery ${ts}` && !ok.json.already, `A approve: ${ok.status} ${J(ok.json)}`);
      assert(!/sid|hash|token|deviceId/.test(ok.text), `A approve answer carries no session data: ${ok.text}`);
      const again = await approve(yossi, s0.code);
      assert(again.status === 200 && again.json?.already === true && again.json.approvalId === ok.json.approvalId, `A same person again -> Already approved: ${J(again.json)}`);
      const rival = await approve(chaim, s0.code);
      assert(rival.status === 404 && rival.json?.code === 'KIOSK_QR_UNUSABLE', `A a second phone on one code -> can't be used: ${rival.status}`);
      const st1 = await status(yossi, ok.json.approvalId);
      assert(st1.status === 200 && st1.json?.state === 'waiting', `A phone sees "Waiting for the tablet": ${J(st1.json)}`);

      const c1 = await poll(T1);
      assert(signedIn(c1) && c1.json.user?.id === ppl.yossi.id && c1.json.greeting?.firstName === 'Yossi' && c1.json.greeting.venueName === `Hill Bakery ${ts}`, `A tablet opens: ${c1.status} ${J(c1.json)}`);
      assert(!('token' in c1.json) && !c1.text.includes('.eyJ') && c1.set[K] && !c1.set[K].cleared && c1.set[D] && !c1.set[D].cleared && c1.set[U]?.cleared, `A cookie tablet: K + D, U deleted, never a token in JSON ${J(c1.names)} ${c1.text.slice(0, 120)}`);
      const kc = JSON.parse(Buffer.from(c1.set[K].value.split('.')[1], 'base64url').toString('utf8'));
      const rec = (await sessionHook({ action: 'get', sid: kc.sid })).doc;
      assert(rec && rec.kind === 'kiosk' && rec.via === 'kiosk-qr' && rec.rowId === ppl.yossi.id && rec.kioskDeviceId === T1.id && rec.venueId === vA1 && rec.absoluteExpMs === rec.createdAtMs + 3 * 3600 * 1000 && rec.revokedAt === null, `A kiosk-qr session record ${J(rec && { kind: rec.kind, via: rec.via })}`);
      assert(kc.dev === T1.id && kc.exp - kc.iat === 3 * 3600, 'A K bound to this tablet, 3 h');
      const bd = await board(T1, c1.set[K].value);
      assert(bd.status === 200, `A the tablet works on D + K: ${bd.status}`);
      const st2 = await status(yossi, ok.json.approvalId);
      assert(st2.status === 200 && st2.json?.state === 'done' && typeof st2.json.ref === 'string' && st2.json.endsAtMs === rec.absoluteExpMs, `A phone sees "Done": ${J(st2.json)}`);
      const tl = await tabletsOf(yossi);
      assert(tl.length === 1 && tl[0].ref === st2.json.ref && tl[0].tabletName === 'Front tablet' && tl[0].venueName === `Hill Bakery ${ts}`, `A "Tablets you're signed in on": ${J(tl)}`);
      assert((await approve(chaim, s0.code)).status === 404, 'A a claimed code cannot be approved again');

      // Header tablet (transition path): the token in JSON, no cookies.
      const s2 = await freshCode(T2, { via: 'header' });
      assert((await approve(chaim, s2.code)).status === 200, 'A approve on the header tablet');
      const c2 = await poll(T2, { via: 'header' });
      assert(signedIn(c2) && typeof c2.json.token === 'string' && c2.names.length === 0, `A header tablet: token in JSON, no cookie ${J(c2.names)}`);
      const bd2 = await call('GET', '/api/tasks', { bearer: c2.json.token, device: T2.cred });
      assert(bd2.status === 200, `A header tablet board: ${bd2.status}`);

      // K authorizes none of the phone routes.
      const kAppr = await call('POST', '/api/kiosk/qr/approve', { cookies: [`${D}=${T1.cred}`, `${K}=${c1.set[K].value}`], origin: SHARED_O, optIn: true, body: { code: s2.code } });
      assert(kAppr.status === 403 || kAppr.status === 401, `A a K cannot approve: ${kAppr.status}`);

      // Approving session revoked / expired between approval and claim -> nothing opens.
      const tmp = await phoneLogin(ppl.chaim.email, ppl.chaim.password);
      const s3 = await freshCode(T3);
      const a3 = await approve(tmp, s3.code);
      assert(a3.status === 200, 'A approve before sign-out');
      const lo = await ph(tmp, 'POST', '/api/auth/logout');
      assert(lo.status === 200, `A phone sign-out: ${lo.status}`);
      const c3 = await poll(T3);
      assert(c3.status === 200 && c3.json?.state === 'waiting' && c3.json.notFinished === true && c3.json.message === "Signing you in didn't finish. Scan again." && !c3.set[K] && c3.json.link, `A revoked approver -> tablet does not open, fresh code: ${J(c3.json)} ${J(c3.names)}`);
      const s4 = await freshCode(T3);
      const tmp2 = await phoneLogin(ppl.chaim.email, ppl.chaim.password);
      assert((await approve(tmp2, s4.code)).status === 200, 'A approve before expiry');
      await sessionHook({ action: 'expire', sid: tmp2.sid });
      const c4 = await poll(T3);
      assert(c4.status === 200 && c4.json?.notFinished === true && !c4.set[K], `A expired approver -> nothing opens: ${J(c4.json)}`);
      const s5 = await freshCode(T3);
      assert((await approve(tmp, s5.code)).status === 401, 'A a revoked session cannot approve');
      assert((await approve(tmp2, s5.code)).status === 401, 'A an expired session cannot approve');
      // [KQRS-RV1] 1: a passkey-backed approving session whose passkey is gone (no cached copy) -> nothing opens.
      const pkPhone = await phoneLogin(ppl.chaim.email, ppl.chaim.password);
      const s6 = await freshCode(T3);
      assert((await approve(pkPhone, s6.code)).status === 200, 'A approve (passkey session)');
      assert((await hook({ action: 'session-passkey', sid: pkPhone.sid, credentialId: 'removed-passkey-t84' })).ok === true, 'A mark the approving session passkey-backed');
      const c6 = await poll(T3);
      assert(!signedIn(c6) && c6.json?.notFinished === true && !c6.set[K], `A approving passkey removed (cache missing) -> nothing opens: ${J(c6.json)}`);
      // [KQRS-RV1] 2: at the live-tablet cap the claim is refused and no live entry is dropped.
      const listBefore = await tabletsOf(yossi);
      assert((await hook({ action: 'person-pad', personId: ppl.yossi.id, n: 50 })).ok === true, 'A pad the tablet list');
      const s7 = await freshCode(T3);
      assert((await approve(yossi, s7.code)).status === 200, 'A approve (cap)');
      const c7 = await poll(T3);
      assert(!signedIn(c7) && c7.json?.notFinished === true && !c7.set[K], `A at the cap -> nothing opens: ${J(c7.json)}`);
      const idx = (await hook({ action: 'person', personId: ppl.yossi.id })).doc;
      assert(idx.items.length === 50 + listBefore.length && listBefore.every((x) => idx.items.some((i) => i.ref === x.ref)), `A no live entry dropped: ${idx.items.length}`);
      assert(J((await tabletsOf(yossi)).map((x) => x.ref)) === J(listBefore.map((x) => x.ref)), 'A the real tablets stay listed (and can be signed out)');
      await hook({ action: 'person-pad', personId: ppl.yossi.id, n: 0 });
    }

    // =========================== C: CSRF / consent ===========================
    {
      const s = await freshCode(T3);
      for (const [label, o] of [['no Origin', { origin: undefined }], ['foreign Origin', { origin: 'https://evil.example' }], ['null Origin', { origin: 'null' }]]) {
        const r = await call('POST', '/api/kiosk/qr/approve', { cookies: [yossi.cookie], optIn: true, body: { code: s.code }, ...(o.origin === undefined ? {} : { origin: o.origin }) });
        assert(r.status === 403 && r.json?.code === 'CSRF_ORIGIN', `C ${label} -> 403 CSRF_ORIGIN: ${r.status} ${J(r.json)}`);
      }
      const noHdr = await call('POST', '/api/kiosk/qr/approve', { cookies: [yossi.cookie], origin: SHARED_O, body: { code: s.code } });
      assert(noHdr.status === 401, `C a cookie without X-Shutfey-Auth (cross-site form) proves nothing: ${noHdr.status}`);
      const getA = await call('GET', `/api/kiosk/qr/approve?code=${s.code}`, { cookies: [yossi.cookie], optIn: true, origin: SHARED_O });
      assert(getA.status !== 200 || !getA.json?.approvalId, `C GET never approves: ${getA.status}`);
      // Signing in (the "Sign in first" round trip) approves nothing by itself.
      await phoneLogin(ppl.yossi.email, ppl.yossi.password);
      assert((await codeState(T3)) === 'live', 'C nothing approved by refused tries or a sign-in');
      for (const p of [`/k/${s.code}`, '/k', '/k/']) {
        const page = await call('GET', p);
        const h = page.headers;
        assert(h['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(String(h['content-security-policy'])) && /no-store/.test(String(h['cache-control'])) && h['referrer-policy'] === 'no-referrer',
          `C ${p} is never framed / cached / referred: ${page.status} ${J({ xfo: h['x-frame-options'], csp: h['content-security-policy'], cc: h['cache-control'], rp: h['referrer-policy'] })}`);
      }
      assert((await codeState(T3)) === 'live', 'C loading /k/<code> changes nothing');
    }

    // =========================== R: clocks and races ===========================
    {
      // Approve at 59 s, claim after the code's own 60 s: ok (the claim window rules).
      let s = await freshCode(T1);
      // (57 s back leaves headroom for a slow mock store; the code still expires before the claim.)
      await hook({ action: 'backdate', deviceId: T1.id, ms: 57000 });
      const a59 = await approve(yossi, s.code);
      assert(a59.status === 200, `R approve near the end of the code's life: ${a59.status} ${J(a59.json)}`);
      await hook({ action: 'backdate', deviceId: T1.id, ms: 4500 });
      const p61 = await poll(T1);
      assert(signedIn(p61), `R claim after the code's 60 s -> ok: ${J(p61.json)}`);
      // Approve after 60 s: expired.
      s = await freshCode(T1);
      await hook({ action: 'backdate', deviceId: T1.id, ms: 60000 });
      const exp = await approve(yossi, s.code);
      assert(exp.status === 410 && exp.json?.code === 'KIOSK_QR_EXPIRED' && exp.json.error === 'This code has expired. Scan the new code on the tablet.', `R approve after 60 s -> expired: ${exp.status} ${J(exp.json)}`);
      const expInfo = await call('GET', `/api/kiosk/qr/info/${s.code}`);
      assert(expInfo.status === 410, `R info of an expired code -> 410: ${expInfo.status}`);
      // Claim window: 29.8 s ok, exactly 30 s refused.
      s = await freshCode(T1);
      assert((await approve(yossi, s.code)).status === 200, 'R approve (window ok)');
      await hook({ action: 'backdate', deviceId: T1.id, ms: 29800 });
      assert(signedIn(await poll(T1)), 'R claim at 29.8 s -> ok');
      s = await freshCode(T1);
      const late = await approve(yossi, s.code);
      assert(late.status === 200, 'R approve (window closed)');
      await hook({ action: 'backdate', deviceId: T1.id, ms: 30000 });
      const lp = await poll(T1);
      assert(lp.status === 200 && lp.json?.state === 'waiting' && !lp.set[K] && lp.json.link, `R claim at exactly 30 s -> refused, fresh code: ${J(lp.json)}`);
      const lst = await status(yossi, late.json.approvalId);
      assert(lst.json?.state === 'failed' && lst.json.message === "The tablet didn't open. Scan again.", `R phone: the tablet didn't open: ${J(lst.json)}`);

      // Reload / Cancel between approval and claim kill the approval.
      for (const [label, kill] of [['reload', (t) => start(t)], ['Cancel', (t) => cancel(t)]]) {
        s = await freshCode(T1);
        const ap = await approve(yossi, s.code);
        assert(ap.status === 200, `R approve before ${label}`);
        await hook({ action: 'backdate', deviceId: T1.id, ms: 0, extraToo: false });
        const k = await kill(T1);
        assert(k.status === 200 && k.json?.state === 'waiting' && !k.set[K], `R ${label}: ${k.status}`);
        const p = await poll(T1);
        assert(!signedIn(p) && !p.set[K], `R ${label} between approval and claim -> nothing opens: ${J(p.json)}`);
        assert((await status(yossi, ap.json.approvalId)).json?.state === 'failed', `R ${label}: phone sees failed`);
      }
      // A PIN sign-in on the tablet between approval and claim.
      s = await freshCode(T1);
      assert((await approve(yossi, s.code)).status === 200, 'R approve before PIN sign-in');
      const pin = await call('POST', '/api/kiosk/login', { cookies: [`${D}=${T1.cred}`], optIn: true, origin: SHARED_O, body: { userId: ppl.chaim.id, pin: '1357' } });
      assert(pin.status === 200 && pin.set[K], `R PIN sign-in on the tablet (unchanged): ${pin.status} ${J(pin.json && pin.json.error)}`);
      const pinK = pin.set[K].value;
      const pp = await poll(T1);
      assert(!signedIn(pp) && !pp.set[K], `R a PIN sign-in kills the pending QR approval: ${J(pp.json)}`);
      assert((await board(T1, pinK)).status === 200, 'R the PIN session is untouched');
      // A PIN removal (entitlement revocation) between approval and claim.
      s = await freshCode(T3);
      assert((await approve(chaim, s.code)).status === 200, 'R approve before PIN removal');
      await setPin(a.token, ppl.chaim.id, '');
      const pr = await poll(T3);
      assert(!signedIn(pr) && pr.json?.notFinished === true, `R PIN removed between approval and claim -> nothing opens: ${J(pr.json)}`);
      await setPin(a.token, ppl.chaim.id, '1357');
      chaim.pinBack = true;
      // Unpair between approval and claim.
      const TU = await pairTablet(a.token, vA1, 'Temp tablet');
      s = await freshCode(TU);
      assert((await approve(chaim, s.code)).status === 200, 'R approve before unpair');
      const del = await call('DELETE', `/api/kiosk/devices/${TU.id}`, { bearer: a.token, origin: SHARED_O, body: { expectedVersion: await version() } });
      assert(del.status === 200, `R unpair: ${del.status} ${J(del.json)}`);
      const up = await poll(TU);
      assert(up.status === 401 && !up.set[K], `R unpaired tablet: 401, nothing opens: ${up.status}`);
      assert((await tabletsOf(chaim)).every((x) => x.tabletName !== 'Temp tablet'), 'R no tablet session for the approver on the unpaired tablet');

      // Competing polls: exactly one session.
      s = await freshCode(T3);
      assert((await approve(yossi, s.code)).status === 200, 'R approve (competing polls)');
      const ps = await Promise.all([poll(T3), poll(T3), poll(T3)]);
      const sids = new Set(ps.filter(signedIn).map((r) => JSON.parse(Buffer.from(r.set[K].value.split('.')[1], 'base64url').toString('utf8')).sid));
      assert(ps.some(signedIn) && sids.size === 1, `R competing polls -> one session: ${J(ps.map((r) => r.json?.state))} sids=${sids.size}`);
      const theSid = [...sids][0];
      // A lost claim answer: the same session again, same end, only while live and the tablet's latest.
      const re = await poll(T3);
      const reSid = signedIn(re) ? JSON.parse(Buffer.from(re.set[K].value.split('.')[1], 'base64url').toString('utf8')) : null;
      const theRec = (await sessionHook({ action: 'get', sid: theSid })).doc;
      assert(reSid && reSid.sid === theSid && re.json.restored === true && re.json.endsAtMs === theRec.absoluteExpMs, `R retry restores the SAME session, same end: ${J(re.json)}`);
      // after the phone's "Sign out" of that tablet: no K.
      const myTabs = await tabletsOf(yossi);
      const row = myTabs.find((x) => x.tabletName === 'Side tablet');
      assert(row, `R the Side tablet is listed: ${J(myTabs)}`);
      const so = await ph(yossi, 'POST', '/api/kiosk/qr/tablets/signout', { ref: row.ref });
      assert(so.status === 200, `R phone signs the tablet out: ${so.status}`);
      const re2 = await poll(T3);
      assert(!signedIn(re2) && !re2.set[K], `R retry after remote sign-out -> no K: ${J(re2.json)}`);
      // after a PIN sign-in on that tablet: no K.
      s = await freshCode(T3);
      assert((await approve(yossi, s.code)).status === 200, 'R approve (retry vs PIN)');
      assert(signedIn(await poll(T3)), 'R claim (retry vs PIN)');
      const pin3 = await call('POST', '/api/kiosk/login', { device: T3.cred, origin: SHARED_O, body: { userId: ppl.chaim.id, pin: '1357' } });
      assert(pin3.status === 200, `R PIN sign-in on T3: ${pin3.status}`);
      const re3 = await poll(T3);
      assert(!signedIn(re3) && !re3.set[K], `R retry after a PIN sign-in -> no K: ${J(re3.json)}`);
      // after 3 h: no K.
      s = await freshCode(T3);
      assert((await approve(yossi, s.code)).status === 200, 'R approve (retry vs 3 h)');
      const c3h = await poll(T3);
      assert(signedIn(c3h), 'R claim (retry vs 3 h)');
      const sid3h = JSON.parse(Buffer.from(c3h.set[K].value.split('.')[1], 'base64url').toString('utf8')).sid;
      await sessionHook({ action: 'expire', sid: sid3h });
      const re4 = await poll(T3);
      assert(!signedIn(re4) && !re4.set[K], `R retry after 3 h -> no K: ${J(re4.json)}`);
      // after the device credential is replaced (re-paired = a new credential): the old one proves nothing.
      const TR = await pairTablet(a.token, vA1, 'Swap tablet');
      s = await freshCode(TR);
      assert((await approve(yossi, s.code)).status === 200, 'R approve (credential swap)');
      assert(signedIn(await poll(TR)), 'R claim (credential swap)');
      assert((await call('DELETE', `/api/kiosk/devices/${TR.id}`, { bearer: a.token, origin: SHARED_O, body: { expectedVersion: await version() } })).status === 200, 'R unpair the old credential');
      const re5 = await poll(TR);
      assert(re5.status === 401 && !re5.set[K], `R retry with a replaced credential -> 401, no K: ${re5.status}`);

      // Tablet A never claims tablet B's code (same venue).
      const sB = await freshCode(T3);
      const sA = await freshCode(T1);
      assert((await approve(yossi, sB.code)).status === 200, 'R approve T3\'s code');
      const wrong = await poll(T1);
      assert(!signedIn(wrong) && !wrong.set[K], `R T1 does not open on T3's approval: ${J(wrong.json)}`);
      const right = await poll(T3);
      assert(signedIn(right), 'R T3 opens on its own code');
      assert(sA.code !== sB.code, 'R distinct codes');

      // Extra codes (Cancel / reload): at most one per 20 s; a dead code cannot be polled around the gap.
      await hook({ action: 'backdate', deviceId: T1.id, ms: 61000, extraToo: true });
      const e0 = await start(T1);
      assert(e0.json?.link, 'R a new code after the old one expired is ordinary rotation');
      const e1 = await start(T1);
      assert(e1.json?.link, 'R first extra code (the current one was still live)');
      const e2 = await start(T1);
      assert(e2.status === 200 && e2.json?.link === null && e2.json.retryInMs > 0 && e2.json.retryInMs <= 20000, `R second extra code within 20 s -> none yet: ${J(e2.json)}`);
      const e3 = await poll(T1);
      assert(e3.json?.link === null && e3.json.retryInMs > 0, `R polling does not get around the 20 s: ${J(e3.json)}`);
      await hook({ action: 'backdate', deviceId: T1.id, ms: 61000, extraToo: true });
      const e4 = await poll(T1);
      assert(e4.json?.link, `R after the gap a new code: ${J(e4.json)}`);
      // Ordinary rotation: an expired live code is replaced on the next poll.
      await hook({ action: 'backdate', deviceId: T1.id, ms: 60000 });
      const rot = await poll(T1);
      assert(rot.json?.link && codeOf(rot) !== codeOf(e4), 'R rotation every 60 s');
    }

    // =========================== B: abuse ===========================
    {
      await hook({ action: 'reset-limits' });
      const yossi2 = await phoneLogin(ppl.yossi.email, ppl.yossi.password);
      const bad = () => crypto.randomBytes(16).toString('base64url');
      const fixedIp = `10.84.250.${ts % 200}`;
      const otherIp = `10.84.251.${ts % 200}`;
      for (let i = 0; i < 5; i++) assert((await approve(yossi, bad(), { fromIp: `10.84.252.${i}` })).status === 404, 'B refused (session 1)');
      for (let i = 0; i < 5; i++) assert((await approve(yossi2, bad(), { fromIp: `10.84.253.${i}` })).status === 404, 'B refused (session 2)');
      const lim = await approve(yossi2, bad(), { fromIp: otherIp });
      assert(lim.status === 429 && lim.json?.code === 'RATE_LIMITED' && lim.json.error === 'Too many tries. Wait a minute and scan again.', `B per person across sessions -> 429: ${lim.status} ${J(lim.json)}`);
      // The tablet is never locked: another person approves its live code at once.
      const s = await freshCode(T1);
      assert((await approve(chaim, s.code, { fromIp: otherIp })).status === 200, 'B refusals never lock the tablet');
      assert(signedIn(await poll(T1)), 'B the tablet opens for someone else');
      // Per IP across people.
      await hook({ action: 'reset-limits' });
      const people = [chaim, nopin, other];
      let n = 0;
      for (const p of people) for (let i = 0; i < 10; i++) { const r = await approve(p, bad(), { fromIp: fixedIp }); if (r.status === 404 || r.status === 403) n++; }
      assert(n === 30, `B 30 refusals from one IP counted: ${n}`);
      const ipLim = await approve(yossi, bad(), { fromIp: fixedIp });
      assert(ipLim.status === 429, `B per IP -> 429: ${ipLim.status}`);
      // Passive expiry never locks a device.
      await freshCode(T1);
      for (let i = 0; i < 3; i++) { await hook({ action: 'backdate', deviceId: T1.id, ms: 61000, extraToo: true }); const r = await poll(T1); assert(r.status === 200 && r.json?.link, `B passive expiry ${i} -> a new code`); }
      await hook({ action: 'reset-limits' });
    }

    // =========================== P: phone status / sign-out ===========================
    {
      const s = await freshCode(T1);
      const ap = await approve(yossi, s.code);
      assert(ap.status === 200, 'P approve');
      const c = await poll(T1);
      assert(signedIn(c), 'P claim');
      const kVal = c.set[K].value;
      const nf = [await status(chaim, ap.json.approvalId), await status(yossi, crypto.randomBytes(16).toString('base64url')),
        await call('GET', `/api/kiosk/qr/approval/${ap.json.approvalId}`, { cookies: [`${D}=${T1.cred}`, `${K}=${kVal}`], optIn: true })];
      assert(nf.every((r) => r.status === 404 && r.text === nf[0].text), `P another person, an unknown id and a K -> the same not found: ${J(nf.map((r) => [r.status, r.text]))}`);
      // An open tablet socket on K.
      const ws = await new Promise((resolve) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}/ws?auth=cookie`, { headers: { Cookie: `${D}=${T1.cred}; ${K}=${kVal}`, Origin: SHARED_O } });
        const o = { code: null, initial: false };
        const t = setTimeout(() => resolve(o), 7000);
        w.on('message', (d) => { try { if (JSON.parse(String(d)).type === 'INITIAL_STATE' && !o.initial) { o.initial = true; clearTimeout(t); resolve(o); } } catch {} });
        w.on('close', (code) => { o.code = code; clearTimeout(t); resolve(o); });
        w.on('error', () => {});
        o.ws = w;
      });
      assert(ws.initial, 'P the tablet socket opens on K');
      // Ordinary phone sign-out leaves the tablet session running.
      const yossi3 = await phoneLogin(ppl.yossi.email, ppl.yossi.password);
      assert((await ph(yossi3, 'POST', '/api/auth/logout')).status === 200, 'P phone sign-out');
      assert((await board(T1, kVal)).status === 200, 'P ordinary phone sign-out leaves the tablet running');
      // "Sign out" on the tablet row ends only that session.
      const st = await status(yossi, ap.json.approvalId);
      const otherTab = (await tabletsOf(yossi)).filter((x) => x.ref !== st.json.ref);
      const closed = new Promise((resolve) => { if (ws.code !== null) resolve(ws.code); ws.ws.on('close', (code) => resolve(code)); setTimeout(() => resolve(ws.code), 6000); });
      const so = await ph(yossi, 'POST', '/api/kiosk/qr/tablets/signout', { ref: st.json.ref });
      assert(so.status === 200, `P sign out the tablet: ${so.status}`);
      assert((await board(T1, kVal)).status === 401, 'P the tablet\'s next request is refused at once');
      assert((await closed) === 4401, `P the tablet socket closes 4401: ${ws.code}`);
      const left = await tabletsOf(yossi);
      assert(J(left.map((x) => x.ref).sort()) === J(otherTab.map((x) => x.ref).sort()), 'P only that tablet session ended');
      assert((await ph(chaim, 'POST', '/api/kiosk/qr/tablets/signout', { ref: otherTab[0]?.ref || 'x'.repeat(22) })).status === 404, 'P another person cannot sign out my tablet');
      assert((await status(yossi, ap.json.approvalId)).json?.state === 'ended', 'P status after sign-out: ended');
    }

    // =========================== H: addresses (APP_SITES) ===========================
    const m = await register('m');
    const rx = await call('POST', '/api/agencies/register-existing', { origin: SHARED_O, body: { agencyName: `T84 m2 ${ts}`, email: m.email, password: m.pw, operationId: `op-${crypto.randomUUID()}` } });
    assert(rx.status === 201 || rx.status === 200, `register-existing m: ${rx.status} ${J(rx.json)}`);
    const DA = m.agencyId, DB = rx.json?.agency?.id || rx.json?.user?.agencyId;
    assert(DB && DB !== DA, 'm has two agencies');
    const vD = `venue-t84-d-${ts}`;
    assert((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: vD, name: `Dana Diner ${ts}`, agencyId: DA }] })).status === 200, 'inject vD');
    const mMint = await call('POST', '/api/__test__/mint-token', { body: { userId: m.id } });
    assert(mMint.status === 200 && mMint.json?.token, `mint m (DA row): ${mMint.status}`);
    await setPin(mMint.json.token, m.id, '4826');
    const TD = await pairTablet(mMint.json.token, vD, 'Diner tablet');

    await ctx.restartServer({ APP_SITES: [`${SA}=${A}`, `${SDA}=${DA}`, `${SDB}=${DB}`].join(';') });
    try {
      await hook({ action: 'reset-limits' });
      // B1: the link comes from server config only.
      const l1 = await start(T2, { via: 'header' });
      assert(l1.status === 200 && l1.json.link.startsWith(`${SA_O}/k/`), `H tablet of an agency with its own address, on the shared host -> agency address: ${l1.json?.link}`);
      const l2 = await start(T2, { via: 'header', host: SA });
      assert(l2.status === 200 && (l2.json.link === null || l2.json.link.startsWith(`${SA_O}/k/`)), `H tablet on its agency address -> agency address: ${J(l2.json)}`);
      await hook({ action: 'backdate', deviceId: T2.id, ms: 61000, extraToo: true });
      const l3 = await start(T2, { via: 'header', headers: undefined, host: SHARED, origin: SHARED_O });
      const l3x = await call('POST', '/api/kiosk/qr/poll', { host: SHARED, device: T2.cred, origin: SHARED_O, body: {}, headers: { 'X-Forwarded-Host': SDB } });
      assert(l3.json.link.startsWith(`${SA_O}/k/`) && l3x.status === 200, 'H X-Forwarded-Host ignored');
      const lb = await call('POST', '/api/kiosk/qr/start', { host: SHARED, device: TB.cred, origin: SHARED_O, body: {}, headers: { 'X-Forwarded-Host': SA } });
      assert(lb.status === 200 && lb.json.link.startsWith(`${SHARED_ORIGIN_CFG}/k/`), `H agency without an address -> shared address even with a spoofed X-Forwarded-Host: ${lb.json?.link}`);
      const wrongSite = await start(T2, { via: 'header', host: SDB });
      assert(wrongSite.status === 403 && wrongSite.json?.code === 'WRONG_SITE' && !wrongSite.json.link, `H another agency's site host -> no link: ${wrongSite.status}`);
      const unk = await start(T2, { via: 'header', host: UNK });
      assert(unk.status === 403 && !unk.json?.link, `H unknown host -> no link: ${unk.status}`);
      const dup = await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(`POST /api/kiosk/qr/start HTTP/1.1\r\nHost: ${SHARED}\r\nHost: ${SHARED}\r\nX-Kiosk-Device: ${T2.cred}\r\nOrigin: ${SHARED_O}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
        let buf = ''; sock.on('data', (d) => { buf += d; }); sock.on('end', () => resolve(buf)); sock.on('error', () => resolve(buf));
      });
      assert(/^HTTP\/1\.1 4\d\d/.test(dup) && !dup.includes('/k/'), `H duplicate Host -> refused, no link: ${dup.slice(0, 40)}`);
      // /api/site appOrigins (B3).
      const so = await call('GET', '/api/site');
      assert(J([...so.json.appOrigins].sort()) === J([SHARED_ORIGIN_CFG, SA_O, SDA_O, SDB_O].sort()), `H shared host appOrigins: ${J(so.json)}`);
      const sa = await call('GET', '/api/site', { host: SA });
      assert(J([...sa.json.appOrigins].sort()) === J([SHARED_ORIGIN_CFG, SA_O].sort()), `H site appOrigins: ${J(sa.json.appOrigins)}`);
      // B2: approve hosts.
      const yS = await phoneLogin(ppl.yossi.email, ppl.yossi.password);           // shared host
      const yA = await phoneLogin(ppl.yossi.email, ppl.yossi.password, SA);       // own agency address
      await hook({ action: 'backdate', deviceId: T2.id, ms: 61000, extraToo: true });
      let s = await start(T2, { via: 'header', host: SA });
      assert((await approve(yS, codeOf(s))).status === 200, 'H approve on the shared host for an agency-address tablet');
      assert(signedIn(await poll(T2, { via: 'header', host: SA })), 'H the tablet on its agency address opens');
      await hook({ action: 'backdate', deviceId: T2.id, ms: 61000, extraToo: true });
      s = await start(T2, { via: 'header' });
      assert((await approve(yA, codeOf(s))).status === 200, 'H approve on the agency address');
      assert(signedIn(await poll(T2, { via: 'header' })), 'H claim');
      const meA = await ph(yA, 'GET', '/api/auth/me');
      assert(meA.json?.canUseTabletSignIn === true, 'H menu flag on the agency address');
      await hook({ action: 'backdate', deviceId: T2.id, ms: 61000, extraToo: true });
      s = await start(T2, { via: 'header' });
      const code = codeOf(s);
      const bobB = await phoneLogin(ppl.bob.email, ppl.bob.password);
      const mDB = await phoneLogin(m.email, m.pw, SDB);  // m's DB membership on DB's address
      const ws1 = await approve(mDB, code);
      assert(ws1.status === 403 && ws1.json?.code === 'WRONG_SITE', `H approve on another agency's address -> WRONG_SITE: ${ws1.status} ${J(ws1.json)}`);
      const unkA = await call('POST', '/api/kiosk/qr/approve', { host: UNK, cookies: [yA.cookie], origin: `http://${UNK}`, optIn: true, body: { code } });
      assert(unkA.status === 403 && unkA.json?.code === 'SITE_NOT_SET_UP', `H unknown host -> refused: ${unkA.status}`);
      const om = await approve(yA, code, { origin: SHARED_O });
      assert(om.status === 403 && om.json?.code === 'CSRF_ORIGIN', `H wrong Origin on the agency address -> 403 CSRF_ORIGIN: ${om.status}`);
      const bobTry = await approve(bobB, code);
      assert(bobTry.status === 403 && bobTry.json?.code === 'KIOSK_QR_NOT_HERE', `H another agency's person on the shared host -> refused: ${bobTry.status}`);
      assert((await call('GET', `/api/kiosk/qr/info/${code}`, { host: SDB })).json?.code === 'WRONG_SITE', 'H info on another agency\'s address -> WRONG_SITE');
      // Approval status on a foreign agency's address: the same "not found".
      const mDA = await phoneLogin(m.email, m.pw, SDA);
      const sd = await freshCode(TD, { via: 'header' });
      const apd = await approve(mDA, sd.code);
      assert(apd.status === 200, `H m approves the diner tablet on DA's address: ${apd.status} ${J(apd.json)}`);
      assert(sd.link.startsWith(`${SDA_O}/k/`), 'H DA tablet link = DA address');
      const stDA = await status(mDA, apd.json.approvalId);
      assert(stDA.json?.state === 'waiting', 'H status on DA address');
      const stDB = await status(mDB, apd.json.approvalId);
      const unknownDB = await status(mDB, crypto.randomBytes(16).toString('base64url'));
      assert(stDB.status === 404 && stDB.text === unknownDB.text, `H status on a foreign agency's address -> the same not found: ${stDB.status}`);
      const meDB = await ph(mDB, 'GET', '/api/auth/me');
      assert(meDB.json?.canUseTabletSignIn === false, 'H no menu flag on DB\'s address (m has a PIN only in DA)');
      assert(signedIn(await poll(TD, { via: 'header' })), 'H the diner tablet opens');
    } finally {
      await ctx.restartServer({});
    }
    return { details: ['A approval/sessions', 'C CSRF/consent', 'R clocks/races', 'B abuse', 'P status/sign-out', 'H addresses'] };
  },
};
