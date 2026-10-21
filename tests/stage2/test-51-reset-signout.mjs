/**
 * Test 51 (sign-out-on-reset, "sign-out-on-reset plan v2"):
 * a password reset signs the account out everywhere else.
 *
 * Proves on the real server and emulator:
 *  1 a failed reset (wrong token) bumps nothing; old tokens keep working
 *  2 a successful reset is ONE commit that sets the password, consumes the
 *    request and bumps tokenEpoch by 1 (migrated row): both older tokens →
 *    401, the open socket is closed 4401, the reset response token (ep+1)
 *    works on HTTP and WS
 *  3 race: 10 WS handshakes with an old token fired around the reset request
 *    all end closed 4401 (refused or swept); none is left open
 *  4 another user's socket and the same user's kiosk session are untouched
 *  5 broadcast guard: a socket whose epoch was bumped WITHOUT the sweep (test
 *    hook) is closed 4401 at the next broadcast and receives nothing
 *  6 kiosk registration gap: a kiosk socket whose session is revoked between
 *    the handshake and its KIOSK_DEVICE frame is closed 4401, never registered
 *  7 a legacy (unmigrated) row's reset bumps nothing: no lock-out, its new v1
 *    works (sign-out applies once the row is migrated)
 */
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8'));
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

function openWs(baseUrl, token, opts = {}) {
  // Never rejects: { ws, messages, state: 'open'|'closed', code, ready (INITIAL_STATE seen) }
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const c = { ws, messages: [], state: 'connecting', code: null, ready: false };
  c.done = new Promise((resolve) => {
    ws.onopen = () => { if (opts.credential && !opts.deferCredential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: opts.credential })); } catch {} } };
    ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); m._at = Date.now(); c.messages.push(m); if (m.type === 'INITIAL_STATE') { c.ready = true; c.state = 'open'; resolve(c); } } catch {} };
    ws.onclose = (ev) => { c.state = 'closed'; c.code = ev.code; resolve(c); };
    ws.onerror = () => {};
  });
  c.waitClose = async (ms = 4000) => { const s = Date.now(); while (c.state !== 'closed' && Date.now() - s < ms) await sleep(50); return c.state === 'closed' ? c.code : null; };
  c.waitFor = async (type, ms = 3000) => { const s = Date.now(); while (Date.now() - s < ms) { const m = c.messages.find((x) => x.type === type); if (m) return m; await sleep(50); } return null; };
  return c;
}

export default {
  name: 'Test 51: password reset signs out other devices',
  whatItProves:
    'A successful reset atomically bumps tokenEpoch (migrated rows) and closes the account\'s open phone sockets before responding; older tokens and racing handshakes are refused; the resetting device gets a fresh token; other users and kiosk sessions are untouched; a stale-epoch socket gets no broadcast; a kiosk socket revoked before its device proof is never registered; failed resets and legacy rows bump nothing.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t51-${ts}`, G1 = `venue-t51-g1-${ts}`;
    const U = (k) => `user-t51-${k}-${ts}`;
    const E = (k) => `t51-${k}-${ts}@test.local`;
    const PW = 'stage2-t51-password', PIN = '5151';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body) => {
      const r = await ctx.api('POST', `/api/__test__/${path}`, body);
      assert(r.status === 200, `${path} ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const login = async (k, pw = PW) => {
      const r = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E(k), password: pw });
      assert(r.status === 200 && r.json?.token, `login ${k} ${r.status} ${r.text.slice(0, 160)}`);
      return r.json.token;
    };
    const httpOk = async (t) => (await call('GET', '/api/users', auth(t))).status;
    let ipN = 1;
    const getResetToken = async (k) => {
      const ip = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.51.${ts % 200}.${ipN++}` };
      let r = await call('POST', '/api/auth/forgot-password', ip, { email: E(k) });
      assert(r.status === 200, `forgot ${k} ${r.status}`);
      const code = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(E(k))}`)).json()).code;
      r = await call('POST', '/api/auth/verify-reset-code', ip, { email: E(k), code });
      assert(r.status === 200 && r.json?.resetToken, `verify ${k} ${r.status}`);
      return r.json.resetToken;
    };
    const reset = (k, resetToken, newPassword) =>
      call('POST', '/api/auth/reset-password', { 'Content-Type': 'application/json' }, { email: E(k), resetToken, newPassword });
    const epochOf = async (id) => ((await ctx.getDoc()).users || []).find((u) => u.id === id)?.tokenEpoch ?? 0;

    // ---- fixture ----
    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: `T51 ${ts}`, shortCode: 'T51', adminEmail: E('admin') }],
      venues: [{ id: G1, name: 'T51 G1', agencyId: AG }],
      users: [
        { id: U('admin'), email: E('admin'), name: 'T51 Admin', role: 'admin', agencyId: AG },
        { id: U('x'), email: E('x'), name: 'T51 X', role: 'coordinator', agencyId: AG, venueId: G1, kioskPin: PIN },
        { id: U('y'), email: E('y'), name: 'T51 Y', role: 'coordinator', agencyId: AG, venueId: G1 },
        { id: U('w'), email: E('w'), name: 'T51 W', role: 'mashgiach', agencyId: AG, venueId: G1, kioskPin: '6161' },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status}`);
    {
      const cur = await ctx.getDoc();
      r = await ctx.api('POST', '/api/__test__/doc-set-users', {
        users: [...(cur.users || []), { id: U('legacy'), email: E('legacy'), name: 'T51 Legacy', role: 'mashgiach', agencyId: AG, venueId: G1, avatarColor: '#fff', password: '' }],
      });
      assert(r.status === 200, 'doc-set-users legacy');
    }
    for (const k of ['admin', 'x', 'y', 'legacy']) await hook('set-password', { userId: U(k), password: PW });
    const tAdmin = await login('admin');

    // kiosk tablet at G1 (paired by the admin), X logged in on it
    const pairTablet = async () => {
      const start = await call('POST', '/api/kiosk/pairing/start', { 'Content-Type': 'application/json' }, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const { pairingId, code, deviceSecret } = start.json;
      const pair = await call('POST', '/api/kiosk/devices/pair', auth(tAdmin), { code, venueId: G1 });
      assert(pair.status === 201, `devices/pair ${pair.status} ${pair.text.slice(0, 160)}`);
      const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } }).then((x) => x.json());
      assert(st.status === 'approved', `claim ${JSON.stringify(st).slice(0, 160)}`);
      return `${st.device.id}.${deviceSecret}`;
    };
    const kioskLogin = async (header, userId, pin) => {
      const k = await call('POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': header }, { userId, pin });
      assert(k.status === 200 && k.json?.token, `kiosk login ${userId} ${k.status} ${k.text.slice(0, 160)}`);
      return k.json.token;
    };
    const dev = await pairTablet();
    const tKiosk = await kioskLogin(dev, U('x'), PIN);
    const kioskHttp = async () => (await call('GET', '/api/tasks', { ...auth(tKiosk), 'X-Kiosk-Device': dev })).status;
    assert((await kioskHttp()) === 200, 'kiosk HTTP before');
    const wsKiosk = openWs(baseUrl, tKiosk, { credential: dev });
    await wsKiosk.done; assert(wsKiosk.ready, `kiosk WS before: ${wsKiosk.code}`);

    // ---- 1. failed reset bumps nothing ----
    const tA = await login('x');
    const tB = await login('x');
    assert(decode(tA).v === 2 && decode(tA).ep === 0, 'X has a v2 token at ep 0');
    {
      await getResetToken('x');
      const bad = await reset('x', 'not-the-token', 'stage2-t51-nope-123');
      assert(bad.status === 400, `bad reset ${bad.status}`);
      assert((await epochOf(U('x'))) === 0 && (await httpOk(tA)) === 200, 'failed reset changed the epoch or killed a token');
    }

    // ---- 2 + 3. reset with a live socket and racing handshakes ----
    const wsA = openWs(baseUrl, tA); await wsA.done; assert(wsA.ready, 'wsA open');
    const tY = await login('y');
    const wsY = openWs(baseUrl, tY); await wsY.done; assert(wsY.ready, 'wsY open');
    const rt = await getResetToken('x');
    const v0 = await ctx.getVersion();
    const racers = [];
    const resetP = reset('x', rt, 'stage2-t51-newpass-1');
    for (let i = 0; i < 10; i++) { racers.push(openWs(baseUrl, tB)); await sleep(5); }
    const ok = await resetP;
    assert(ok.status === 200 && ok.json?.token, `reset ${ok.status} ${ok.text.slice(0, 160)}`);
    assert((await ctx.getVersion()) === v0 + 1, 'reset must be exactly one commit');
    assert((await epochOf(U('x'))) === 1, 'epoch not bumped to 1');
    const cNew = decode(ok.json.token);
    assert(cNew.v === 2 && cNew.ep === 1 && cNew.mem === U('x'), `reset token ${JSON.stringify(cNew)}`);
    assert((await httpOk(tA)) === 401 && (await httpOk(tB)) === 401, 'older tokens still accepted');
    assert((await wsA.waitClose()) === 4401, `wsA not closed 4401 (${wsA.code})`);
    await Promise.all(racers.map((c) => c.done));
    for (const [i, c] of racers.entries()) {
      const code = await c.waitClose(4000);
      assert(code === 4401, `racer ${i}: ${c.ready ? 'registered and' : ''} not closed 4401 (state ${c.state}, code ${c.code})`);
    }
    assert((await httpOk(ok.json.token)) === 200, 'reset token HTTP');
    const wsNew = openWs(baseUrl, ok.json.token); await wsNew.done; assert(wsNew.ready, 'reset token WS');
    const wsOld = openWs(baseUrl, tA); await wsOld.done; assert(!wsOld.ready && wsOld.code === 4401, 'old token WS handshake');

    // ---- 4. others untouched ----
    assert(wsY.state === 'open' && (await httpOk(tY)) === 200, 'Y affected by X\'s reset');
    assert(wsKiosk.state === 'open' && (await kioskHttp()) === 200, 'X\'s kiosk session affected by the reset');
    {
      // a real broadcast still reaches Y (coordinator of G1)
      wsY.messages.length = 0;
      await pairTablet();
      assert(await wsY.waitFor('KIOSK_DEVICES_UPDATED', 4000), 'Y got no broadcast after X\'s reset');
    }

    // ---- 5. broadcast guard: epoch bumped WITHOUT the sweep ----
    {
      const tY2 = await login('y');
      const wsY2 = openWs(baseUrl, tY2); await wsY2.done; assert(wsY2.ready, 'wsY2 open');
      await hook('bump-token-epoch', { userId: U('y') }); // test hook: no socket sweep
      assert(wsY2.state === 'open', 'precondition: the hook does not close sockets');
      wsY2.messages.length = 0;
      await pairTablet(); // broadcasts KIOSK_DEVICES_UPDATED to G1 coordinators
      assert((await wsY2.waitClose(4000)) === 4401, `stale-epoch socket not closed at broadcast (${wsY2.code})`);
      assert(!wsY2.messages.some((m) => m.type === 'KIOSK_DEVICES_UPDATED'), 'stale-epoch socket received a broadcast');
    }

    // ---- 6. kiosk registration gap ----
    {
      const tKW = await kioskLogin(dev, U('w'), '6161');
      const wsW = openWs(baseUrl, tKW, { credential: dev, deferCredential: true });
      await sleep(300); // handshake done, waiting for the device proof
      assert(wsW.state !== 'closed', `kiosk W closed early (${wsW.code})`);
      const d = await ctx.getDoc();
      const users = (d.users || []).map((u) => (u.id === U('w') ? (({ kioskPinHash, kioskPin, ...rest }) => rest)(u) : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users })).status === 200, 'doc-set-users (revoke W kiosk)');
      await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t51-h-${ts}`, name: 'T51 hydrate', agencyId: AG }] });
      wsW.ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: dev }));
      await wsW.done;
      assert(!wsW.ready && wsW.code === 4401, `revoked kiosk socket registered (ready ${wsW.ready}, code ${wsW.code})`);
    }

    // ---- 7. legacy row: no bump, no lock-out ----
    {
      const tL = await login('legacy');
      assert(!('v' in decode(tL)), 'legacy token is v1');
      const lrt = await getResetToken('legacy');
      const lr = await reset('legacy', lrt, 'stage2-t51-legacy-2');
      assert(lr.status === 200 && lr.json?.token && !('v' in decode(lr.json.token)), `legacy reset ${lr.status}`);
      assert((await epochOf(U('legacy'))) === 0, 'legacy row epoch bumped');
      assert((await httpOk(lr.json.token)) === 200, 'legacy locked out after reset');
    }

    for (const c of [wsKiosk, wsY, wsNew]) { try { c.ws.close(); } catch {} }
    return 'reset = one commit (password + request + epoch+1); older tokens 401, open socket 4401, 10 racing handshakes all 4401; new token works; other user + kiosk untouched; stale-epoch socket closed at broadcast with no data; kiosk socket revoked before proof never registered; failed reset and legacy rows bump nothing';
  },
};
