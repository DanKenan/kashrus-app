/**
 * Test 62 (10e, "credential owner in auth + R7 boundary", design v2 answering
 * [10E-DS1]). P = X (mashgiach in agency A, credential owner, origin
 * 'self-registered') + Y (coordinator in agency B, same email + personId, no
 * credential), built by the test-only hook identity-build-person. Z is a
 * single-row (migrated) person in A.
 *
 *  A  single-row Z: change-password works, origin kept, NO epoch bump, old
 *     token still valid, response byte-identical (no token)
 *  B  multi P: login with P's email -> X's session, never Y's
 *  C  forgot for P: same 200 body as an unknown email; no reset record, no
 *     cached code, no reset-code push to any endpoint
 *  D1 an unverified request made while X was single: after Y joins, verify
 *     -> today's no-request answer, the record is removed, no reset token
 *  D2 a verified reset token made while X was single: after Y joins,
 *     reset-password -> 400, nothing written
 *  D3 Z's request re-bound to another row -> reset 400, Z unchanged
 *  D4 Z's request unbound (pre-10e shape) -> reset works exactly as today
 *     (origin 'agency-reset', epoch +1)
 *  E  change-password from Y's session, wrong current password -> 401,
 *     nothing written
 *  F  change-password from Y's session -> X's credential changes, Y gets no
 *     password, origin kept, X and Y epochs +1 in one commit, old X/Y tokens
 *     401 (REST) and 4401 (WS), returned token is Y's and current
 *  G  invalid group (second credentialOwner planted on Y): change-password
 *     409 nothing written; login uniform 401; forgot generic, no record
 *  R  the email's credential row changes between pre-check and commit (stored
 *     doc only): forgot creates nothing and pushes nothing
 *  H  the reset-rebind hook is 404 outside test mode
 */
import { createHash } from 'node:crypto';

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function openWs(baseUrl, token) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const c = { ws, state: 'connecting', code: null };
  ws.onmessage = (ev) => { try { if (JSON.parse(String(ev.data)).type === 'INITIAL_STATE') c.state = 'open'; } catch {} };
  ws.onclose = (ev) => { c.state = 'closed'; c.code = ev.code; };
  ws.onerror = () => {};
  c.waitOpen = async (ms = 8000) => { const s = Date.now(); while (c.state === 'connecting' && Date.now() - s < ms) await sleep(50); return c.state; };
  c.waitClose = async (ms = 5000) => { const s = Date.now(); while (c.state !== 'closed' && Date.now() - s < ms) await sleep(50); return c.state === 'closed' ? c.code : null; };
  c.close = () => { try { ws.close(); } catch {} };
  return c;
}

export default {
  name: 'Test 62: credential owner in auth + R7 boundary (10e)',
  whatItProves:
    'Login, change-password and reset use the person\'s ONE credential on its owner row; a multi person\'s change-password bumps every membership\'s epoch in one commit (single-row unchanged); agency-assisted recovery is refused for a multi person with answers identical to an unknown email/request/token and no push; reset requests are bound to their row.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t62a-${ts}`, B = `agency-t62b-${ts}`;
    const A1 = `venue-t62-a1-${ts}`, B1 = `venue-t62-b1-${ts}`;
    const U = (k) => `user-t62-${k}-${ts}`;
    const E = (k) => `t62-${k}-${ts}@test.local`;
    const EP = (k) => `https://push.test.invalid/t62-${k}-${ts}`;
    const PE = E('p'), ZE = E('z');
    const PW = 'stage2-t62-password', ZPW = 'stage2-t62-zpass';
    const X = U('x'), Z = U('z');
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.62.${ts % 200}.${ipN++}` });
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const rows = async () => ((await ctx.getDoc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const resetsFor = async (email) => ((await ctx.getDoc()).passwordResets || []).filter((r) => r.email === email);
    const lastCode = async (email) => (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(email)}`)).json())?.code || null;
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const pushLog = async () => ((await ctx.api('GET', '/api/__test__/push-log')).json?.log || []).filter((e) => String(e.endpoint).includes(`-${ts}`));
    const clearPush = async () => { await ctx.api('POST', '/api/__test__/push-log/clear', {}); };
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t62-h${k}-${Date.now()}`, name: 'T62 hydrate', agencyId: A }] })).status === 200, `rehydrate ${k}`);
    const forgot = (email) => call('POST', '/api/auth/forgot-password', ipH(), { email });
    const verify = (email, code) => call('POST', '/api/auth/verify-reset-code', ipH(), { email, code });
    const reset = (email, resetToken, newPassword) => call('POST', '/api/auth/reset-password', jsonH, { email, resetToken, newPassword });
    const changePw = (token, currentPassword, newPassword) => call('POST', '/api/auth/change-password', auth(token), { currentPassword, newPassword });
    const login = (email, password) => call('POST', '/api/auth/login', jsonH, { email, password });

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T62 A ${ts}`, timeZone: 'America/New_York' }, { id: B, name: `T62 B ${ts}`, timeZone: 'Asia/Jerusalem' }],
      venues: [{ id: A1, name: `T62 A1 ${ts}`, agencyId: A }, { id: B1, name: `T62 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T62 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T62 Admin B', role: 'admin', agencyId: B },
        { id: X, email: PE, name: 'T62 X', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: Z, email: ZE, name: 'T62 Z', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('w'), email: E('w'), name: 'T62 W', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('v'), email: E('v'), name: 'T62 V', role: 'mashgiach', agencyId: B, venueId: B1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);
    assert((await hook('set-password', { userId: X, password: PW })).status === 200, 'set-password X');
    assert((await hook('set-password', { userId: Z, password: ZPW })).status === 200, 'set-password Z');
    {
      const users = (await rows()).map((u) => (u.id === X ? { ...u, credentialOwner: true, credentialOrigin: 'self-registered' } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'plant owner');
      await rehydrate('0');
    }
    const pid = (await rowOf(X)).personId;
    assert(pid === X, `X is its own person ${pid}`);
    assert((await rowOf(Z)).personId === Z, 'Z is a migrated single-row person');
    const unknownBody = (await forgot(E('nobody'))).text;

    // ---- A: single-row Z, today's behaviour ----
    {
      const z0 = await rowOf(Z);
      const tz = await mintToken(baseUrl, Z);
      const r = await changePw(tz, ZPW, 'stage2-t62-znew1');
      assert(r.status === 200 && J(r.json) === J({ success: true, message: 'Password updated successfully.' }), `A response byte-identical: ${r.status} ${r.text}`);
      const z1 = await rowOf(Z);
      assert(z1.password !== z0.password, 'A password changed');
      assert((z1.tokenEpoch ?? 0) === (z0.tokenEpoch ?? 0), `A no epoch bump ${z0.tokenEpoch} -> ${z1.tokenEpoch}`);
      assert((z1.credentialOrigin ?? null) === (z0.credentialOrigin ?? null), 'A origin kept');
      const me = await call('GET', '/api/agencies/current', auth(tz));
      assert(me.status === 200, `A old token still valid (as today): ${me.status}`);
      assert((await login(ZE, 'stage2-t62-znew1')).status === 200, 'A new password logs in');
      console.log('  ✓ A single-row change-password unchanged (no bump, origin kept, same response)');
    }

    // ---- D1 / D2: requests made while X was single ----
    let xCode1 = null, xToken2 = null;
    {
      // D2 setup: a VERIFIED token for X while single
      assert((await forgot(PE)).status === 200, 'D2 forgot');
      const c2 = await lastCode(PE);
      assert(c2, 'D2 code cached');
      const rq = await resetsFor(PE);
      assert(rq.length === 1 && rq[0].rowId === X, `D2 request bound to X ${J(rq.map((x) => x.rowId))}`);
      const v = await verify(PE, c2);
      assert(v.status === 200 && v.json?.resetToken, `D2 verify ${v.status}`);
      xToken2 = v.json.resetToken;
    }
    let r = await hook('identity-build-person', { ownerUserId: X, agencyId: B, role: 'coordinator', venueId: B1, name: 'T62 Y' });
    assert(r.status === 200 && typeof r.json?.id === 'string', `build Y ${r.status} ${J(r.json)}`);
    const Y = r.json.id;
    {
      const y = await rowOf(Y);
      assert(y && y.personId === pid && y.email === PE && y.password === undefined, `Y joined P without a credential ${J(y)}`);
    }
    {
      const xs = J(await rowOf(X)), ys = J(await rowOf(Y));
      const v0 = await ctx.getVersion();
      const rr = await reset(PE, xToken2, 'stage2-t62-nope1');
      assert(rr.status === 400 && rr.json?.error === 'Invalid or expired reset token.', `D2 reset refused: ${rr.status} ${rr.text.slice(0, 120)}`);
      await unchanged(v0, 'D2');
      assert(J(await rowOf(X)) === xs && J(await rowOf(Y)) === ys, 'D2 X/Y unchanged');
      const left = await resetsFor(PE);
      assert(left.length === 1 && left[0].verified === true && left[0].rowId === X, 'D2 the refused token was not consumed (it can never complete)');
      console.log('  ✓ D2 a token verified before P became multi cannot reset');
    }
    {
      // D1: an UNVERIFIED request that exists from before P became multi
      // (planted: forgot itself now refuses P). Re-use the pending request
      // by moving the X-bound request back to unverified via a fresh build:
      // remove Y, forgot while single, rebuild Y.
      const tB = await mintToken(baseUrl, U('adB'));
      let d = await call('DELETE', `/api/users/${Y}`, auth(tB), { expectedVersion: await ctx.getVersion() });
      assert(d.status === 200, `D1 remove Y ${d.status} ${d.text.slice(0, 120)}`);
      assert((await forgot(PE)).status === 200, 'D1 forgot while single');
      xCode1 = await lastCode(PE);
      assert(xCode1 && (await resetsFor(PE)).length === 1, 'D1 pending request exists');
    }
    r = await hook('identity-build-person', { ownerUserId: X, agencyId: B, role: 'coordinator', venueId: B1, name: 'T62 Y2' });
    assert(r.status === 200, `rebuild Y ${r.status}`);
    const Y2 = r.json.id;
    {
      const v = await verify(PE, xCode1);
      const vUnknown = await verify(E('nobody2'), '123456');
      assert(v.status === vUnknown.status && J(v.json) === J(vUnknown.json) && !v.json?.resetToken, `D1 verify answers like no request: ${v.status} ${v.text} vs ${vUnknown.status} ${vUnknown.text}`);
      assert((await resetsFor(PE)).length === 0, 'D1 the request was removed');
      console.log('  ✓ D1 an unverified request from before P became multi is dropped at verify');
    }

    // ---- B: login resolves X ----
    {
      // 10g: a multi person's login returns a choose token; activating the
      // owner X gives the same credential-owner session as before 10g.
      const lg = await login(PE, PW);
      assert(lg.status === 200 && lg.json?.chooseMembership === true && lg.json?.user === undefined, `B login -> chooser ${lg.status} ${lg.text.slice(0, 120)}`);
      assert(decode(lg.json.token).cr === X, 'B the choose token names the owner row X');
      const act = await call('POST', '/api/auth/activate', auth(lg.json.token), { membershipId: X });
      assert(act.status === 200 && act.json?.user?.id === X, `B activate X: ${act.status} ${act.text.slice(0, 120)}`);
      assert(!J(decode(act.json.token)).includes(Y2), 'B never a Y session');
      console.log('  ✓ B login resolves the owner row (10g: chooser, then activate X)');
    }

    // ---- C: forgot refused for P, no push ----
    {
      const tA = await mintToken(baseUrl, U('adA')), tB = await mintToken(baseUrl, U('adB'));
      for (const [t, ep] of [[tA, EP('ada')], [tB, EP('adb')]]) {
        const s = await call('POST', '/api/push/subscribe', auth(t), { subscription: { endpoint: ep, keys: { p256dh: 'p', auth: 'a' } } });
        assert(s.status === 200, `subscribe ${s.status}`);
      }
      // control: Z's forgot does push to agency A's admin
      await clearPush();
      assert((await forgot(ZE)).status === 200, 'C control forgot');
      assert((await pushLog()).some((e) => e.endpoint === EP('ada') && String(e.title).startsWith('🔑 Password reset code')), 'C control: Z reset pushes to A admin');
      await clearPush();
      const before = await lastCode(PE);
      const f = await forgot(PE);
      assert(f.status === 200 && f.text === unknownBody, `C same body as unknown email: ${f.text} vs ${unknownBody}`);
      assert((await resetsFor(PE)).length === 0, 'C no reset record');
      assert((await lastCode(PE)) === before, 'C no new code cached');
      await sleep(300);
      assert(!(await pushLog()).some((e) => String(e.title).startsWith('🔑 Password reset code')), `C no reset push anywhere ${J(await pushLog())}`);
      console.log('  ✓ C forgot for a multi person: generic answer, no record, no code, no push');
    }

    // ---- R ([10E-RV1] B1): the email's credential row changes between the
    // pre-check and the commit. doc-set-users writes the stored doc only (no
    // rehydrate), so the handler's pre-check still sees W while the
    // transaction's fresh rows give the email to V (another single-row person,
    // agency B): nothing is created, nothing is pushed, generic answer.
    {
      const WE = E('w');
      const planted = (await rows()).map((u) => (u.id === U('w') ? { ...u, email: E('w-moved') } : u.id === U('v') ? { ...u, email: WE } : u));
      assert((await hook('doc-set-users', { users: planted })).status === 200, 'R plant reassignment (stored doc only)');
      await clearPush();
      const before = await lastCode(WE);
      const f = await forgot(WE);
      assert(f.status === 200 && f.text === unknownBody, `R generic answer: ${f.status} ${f.text}`);
      assert((await resetsFor(WE)).length === 0, `R no reset record ${J(await resetsFor(WE))}`);
      assert((await lastCode(WE)) === before, 'R no code cached');
      await sleep(300);
      assert(!(await pushLog()).some((e) => String(e.title).startsWith('🔑 Password reset code')), `R no reset push anywhere ${J(await pushLog())}`);
      await rehydrate('r');
      console.log('  ✓ R credential row reassigned between pre-check and commit: no request, no push');
    }

    // ---- D3 / D4: binding on single-row Z ----
    {
      const zPw = 'stage2-t62-znew1';
      assert((await forgot(ZE)).status === 200, 'D3 forgot');
      const c = await lastCode(ZE);
      const v = await verify(ZE, c);
      assert(v.status === 200 && v.json?.resetToken, `D3 verify ${v.status}`);
      assert((await hook('reset-rebind', { email: ZE, rowId: U('adA') })).status === 200, 'D3 rebind');
      const zs = J(await rowOf(Z));
      const v0 = await ctx.getVersion();
      const rr = await reset(ZE, v.json.resetToken, 'stage2-t62-nope3');
      assert(rr.status === 400, `D3 re-bound request refused: ${rr.status} ${rr.text.slice(0, 120)}`);
      await unchanged(v0, 'D3');
      assert(J(await rowOf(Z)) === zs, 'D3 Z unchanged');
      const left3 = await resetsFor(ZE);
      assert(left3.length === 1 && left3[0].verified === true, 'D3 the refused token was not consumed');
      assert((await login(ZE, zPw)).status === 200, 'D3 old password still works');
      // D4: unbound (pre-10e shape) -> today's behaviour
      assert((await hook('reset-rebind', { email: ZE, rowId: null })).status === 200, 'D4 unbind');
      assert(!('rowId' in (await resetsFor(ZE))[0]), 'D4 request unbound');
      const z0 = await rowOf(Z);
      const rr4 = await reset(ZE, v.json.resetToken, 'stage2-t62-zreset');
      assert(rr4.status === 200 && rr4.json?.user?.id === Z && rr4.json?.token, `D4 unbound reset works: ${rr4.status} ${rr4.text.slice(0, 120)}`);
      const z1 = await rowOf(Z);
      assert(z1.credentialOrigin === 'agency-reset', `D4 origin agency-reset ${z1.credentialOrigin}`);
      assert((z1.tokenEpoch ?? 0) === (z0.tokenEpoch ?? 0) + 1, 'D4 SO bump as today');
      assert((await login(ZE, 'stage2-t62-zreset')).status === 200, 'D4 new password logs in');
      console.log('  ✓ D3/D4 reset bound to its row; an unbound request behaves as today');
    }

    // ---- E / F: change-password from Y's session ----
    {
      const tx = await mintToken(baseUrl, X), ty = await mintToken(baseUrl, Y2);
      const wsY = openWs(baseUrl, ty);
      assert((await wsY.waitOpen()) === 'open', 'F Y socket opens');
      const x0 = await rowOf(X), y0 = await rowOf(Y2);
      let v0 = await ctx.getVersion();
      const bad = await changePw(ty, 'wrong-password-t62', 'stage2-t62-nope4');
      assert(bad.status === 401, `E wrong current -> 401: ${bad.status}`);
      await unchanged(v0, 'E');
      assert((await call('GET', '/api/agencies/current', auth(ty))).status === 200, 'E Y token still valid');
      v0 = await ctx.getVersion();
      const NEW = 'stage2-t62-pnew';
      const ok = await changePw(ty, PW, NEW);
      assert(ok.status === 200 && ok.json?.success === true && typeof ok.json?.token === 'string', `F change from Y: ${ok.status} ${ok.text.slice(0, 160)}`);
      assert((await ctx.getVersion()) === v0 + 1, 'F one commit');
      const x1 = await rowOf(X), y1 = await rowOf(Y2);
      assert(x1.password && x1.password !== x0.password, 'F X credential changed');
      assert(y1.password === undefined && y1.credentialOwner === undefined, 'F Y still holds no credential');
      assert(x1.credentialOrigin === 'self-registered', `F origin kept ${x1.credentialOrigin}`);
      assert((x1.tokenEpoch ?? 0) === (x0.tokenEpoch ?? 0) + 1 && (y1.tokenEpoch ?? 0) === (y0.tokenEpoch ?? 0) + 1, `F both epochs +1 ${J([x0.tokenEpoch, x1.tokenEpoch, y0.tokenEpoch, y1.tokenEpoch])}`);
      const c = decode(ok.json.token);
      assert(c.mem === Y2 && c.sub === pid, `F returned token is Y's membership token ${J(c)}`);
      assert(c.ep === y1.tokenEpoch, `F returned token carries the new epoch ${c.ep} vs ${y1.tokenEpoch}`);
      assert((await call('GET', '/api/agencies/current', auth(ok.json.token))).status === 200, 'F returned token works');
      assert((await call('GET', '/api/agencies/current', auth(tx))).status === 401, 'F old X token 401');
      assert((await call('GET', '/api/agencies/current', auth(ty))).status === 401, 'F old Y token 401');
      assert((await wsY.waitClose()) === 4401, `F open Y socket closed 4401 (${wsY.code})`);
      const ws2 = openWs(baseUrl, ty);
      assert((await ws2.waitClose()) === 4401, `F old Y token WS handshake 4401 (${ws2.code})`);
      ws2.close(); wsY.close();
      const lg = await login(PE, NEW);
      assert(lg.status === 200 && lg.json?.chooseMembership === true && decode(lg.json.token).cr === X, `F new password logs in (chooser for owner X) ${lg.status}`);
      assert((await login(PE, PW)).status === 401, 'F old password refused');
      console.log('  ✓ E/F change-password from Y changes the one credential, kills every old session of P, hands Y a fresh token');
    }

    // ---- G: invalid group ----
    {
      const users = (await rows()).map((u) => (u.id === Y2 ? { ...u, credentialOwner: true } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'G plant second owner');
      await rehydrate('g');
      const ty = await mintToken(baseUrl, Y2);
      const v0 = await ctx.getVersion();
      const cp = await changePw(ty, 'stage2-t62-pnew', 'stage2-t62-nope5');
      assert(cp.status === 409, `G change-password 409: ${cp.status} ${cp.text.slice(0, 120)}`);
      await unchanged(v0, 'G change-password');
      const lg = await login(PE, 'stage2-t62-pnew');
      const lgUnknown = await login(E('nobody3'), 'whatever-t62');
      assert(lg.status === 401 && J(lg.json) === J(lgUnknown.json), `G login uniform 401: ${lg.status} ${lg.text}`);
      const f = await forgot(PE);
      assert(f.status === 200 && f.text === unknownBody && (await resetsFor(PE)).length === 0, 'G forgot generic, no record');
      // restore a valid group so later suites are unaffected
      const fixed = (await rows()).map((u) => { if (u.id !== Y2) return u; const { credentialOwner, ...rest } = u; return rest; });
      assert((await hook('doc-set-users', { users: fixed })).status === 200, 'G restore');
      await rehydrate('g2');
      console.log('  ✓ G invalid group: change-password 409, login uniform 401, forgot generic');
    }

    // ---- H ----
    if (typeof ctx.restartServer === 'function') {
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        const h = await fetch(`${baseUrl}/api/__test__/reset-rebind`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ email: 'x@test.local', rowId: null }) });
        assert(h.status === 404, `H: reset-rebind must be 404 outside test mode, got ${h.status}`);
      } finally {
        await ctx.restartServer();
      }
    }
    return 'single-row change-password unchanged; multi P: login -> owner, forgot generic (no record/code/push), pre-multi requests dropped/refused, reset bound to its row (unbound = today), change-password from any membership changes the one credential and bumps every epoch (old tokens 401/4401, fresh token returned), invalid group fails closed; a credential row reassigned before the commit gets no request and no push; reset-rebind 404 outside test mode';
  },
};
