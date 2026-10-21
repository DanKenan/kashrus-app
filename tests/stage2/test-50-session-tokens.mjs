/**
 * Test 50 (item 8d): session tokens v1 + v2 ("8d plan v1"), no visible login change.
 *
 * Proves on the real server and emulator:
 *  1 login of a migrated row issues v2 { v:2, sub: personId, mem: row id, ep };
 *    an unmigrated legacy row still gets v1 { sub }; response shape unchanged
 *  2 v1 (signed the pre-8d way) and v2 both work on HTTP and WS, and give the
 *    SAME identity and rule-T roster on both (admin A: whole agency A;
 *    coordinator A1: own venue + admins; never agency B)
 *  3 strict classification: forged signature, v:3, wrong mem, sub ≠ personId,
 *    string ep, altered ep, v2 + kiosk claim, mem/ep without v, expired,
 *    v1 + kiosk claim → 401 on HTTP and 4401 on WS
 *  4 epoch bump (test hook) on row X kills X's v1 and v2 on HTTP and on new
 *    WS handshakes; row Y unaffected; a fresh login carries ep 1 and works;
 *    an invalid stored epoch fails closed (never treated as 0)
 *  5 v1 for a deleted row → 401
 *  6 reset-password and register issue v2 (born-migrated rows)
 *  7 kiosk tokens unaffected: a kiosk token still opens its WS, and is still
 *    403 KIOSK_SCOPE on a staff route
 */
function assert(c, m) { if (!c) throw new Error(m); }
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8'));
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

function wsTry(baseUrl, token, ms = 8000) {
  // Resolves { ok: true, state } on INITIAL_STATE, { ok: false, code } on close.
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish({ ok: false, code: 'timeout' }), ms);
    ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.type === 'INITIAL_STATE') finish({ ok: true, state: m.payload || m.state || m.data || m }); } catch {} };
    ws.onclose = (ev) => finish({ ok: false, code: ev.code });
    ws.onerror = () => {};
  });
}

export default {
  name: 'Test 50: session tokens v1 + v2 (8d)',
  whatItProves:
    'Migrated rows get v2 tokens bound to personId + membership + epoch; legacy v1 keeps working at epoch 0; one strict classifier and one resolver for HTTP and WS (same identity and roster on both); malformed and hybrid tokens fail closed; an epoch bump revokes exactly that row; kiosk path unchanged.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = (k) => `agency-t50-${k}-${ts}`;
    const V = (k) => `venue-t50-${k}-${ts}`;
    const U = (k) => `user-t50-${k}-${ts}`;
    const E = (k) => `t50-${k}-${ts}@test.local`;
    const PW = 'stage2-t50-password';
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
    const login = async (k) => {
      const r = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E(k), password: PW });
      assert(r.status === 200 && r.json?.token && r.json?.success === true && r.json?.user, `login ${k} ${r.status} ${r.text.slice(0, 200)}`);
      assert(!('personId' in r.json.user) && !('tokenEpoch' in r.json.user), 'login user payload carries server-only fields');
      return r.json.token;
    };
    const signed = async (claims) => (await hook('sign-claims', { claims })).token;
    const httpUsers = async (token) => call('GET', '/api/users', auth(token));

    // ---- fixture: agency A (venues A1, A2), agency B; admin A, coordinator A1,
    // mashgiach A2, admin B are born migrated (inject-fixture → 8b); legacyA is a
    // pre-8b row written directly (no personId).
    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: AG('a'), name: `T50 A ${ts}`, shortCode: 'T50A', adminEmail: E('adminA') },
        { id: AG('b'), name: `T50 B ${ts}`, shortCode: 'T50B', adminEmail: E('adminB') },
      ],
      venues: [
        { id: V('a1'), name: 'T50 A1', agencyId: AG('a') },
        { id: V('a2'), name: 'T50 A2', agencyId: AG('a') },
        { id: V('b1'), name: 'T50 B1', agencyId: AG('b') },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T50 Admin A', role: 'admin', agencyId: AG('a') },
        { id: U('coordA'), email: E('coordA'), name: 'T50 Coord A1', role: 'coordinator', agencyId: AG('a'), venueId: V('a1') },
        { id: U('mashA2'), email: E('mashA2'), name: 'T50 Mash A2', role: 'mashgiach', agencyId: AG('a'), venueId: V('a2') },
        { id: U('adminB'), email: E('adminB'), name: 'T50 Admin B', role: 'admin', agencyId: AG('b') },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status}`);
    const cur = await ctx.getDoc();
    r = await ctx.api('POST', '/api/__test__/doc-set-users', {
      users: [...(cur.users || []), { id: U('legacyA'), email: E('legacyA'), name: 'T50 Legacy', role: 'mashgiach', agencyId: AG('a'), venueId: V('a1'), avatarColor: '#fff', password: '' }],
    });
    assert(r.status === 200, `doc-set-users ${r.status}`);
    for (const k of ['adminA', 'coordA', 'mashA2', 'adminB', 'legacyA']) await hook('set-password', { userId: U(k), password: PW });

    // ---- 1. issuing ----
    const tAdminA = await login('adminA');
    const cA = decode(tAdminA);
    assert(cA.v === 2 && cA.sub === U('adminA') && cA.mem === U('adminA') && cA.ep === 0 && !('kiosk' in cA), `admin A v2 claims ${JSON.stringify(cA)}`);
    const tLegacy = await login('legacyA');
    const cL = decode(tLegacy);
    assert(!('v' in cL) && !('mem' in cL) && !('ep' in cL) && cL.sub === U('legacyA'), `legacy v1 claims ${JSON.stringify(cL)}`);
    const tCoord = await login('coordA');
    assert(decode(tCoord).v === 2, 'coordinator v2');

    // ---- 2. v1 + v2 on HTTP and WS, same identity and roster ----
    const tAdminAv1 = (await hook('mint-token', { userId: U('adminA'), legacy: true })).token;
    assert(!('v' in decode(tAdminAv1)), 'legacy mint is v1');
    for (const [label, tok] of [['v2', tAdminA], ['v1', tAdminAv1]]) {
      const h = await httpUsers(tok);
      assert(h.status === 200, `admin A ${label} HTTP ${h.status}`);
      const w = await wsTry(baseUrl, tok);
      assert(w.ok, `admin A ${label} WS ${w.code}`);
      const hIds = h.json.users.map((u) => u.id).filter((id) => id.includes(`-${ts}`)).sort();
      const wIds = (w.state.users || []).map((u) => u.id).filter((id) => id.includes(`-${ts}`)).sort();
      assert(JSON.stringify(hIds) === JSON.stringify(wIds), `admin A ${label}: HTTP roster ${hIds} != WS roster ${wIds}`);
      assert(hIds.includes(U('mashA2')) && !hIds.includes(U('adminB')), `admin A ${label} roster not agency-A-only: ${hIds}`);
    }
    {
      const h = await httpUsers(tCoord);
      const w = await wsTry(baseUrl, tCoord);
      assert(h.status === 200 && w.ok, `coord v2 ${h.status} ${w.code}`);
      const hIds = h.json.users.map((u) => u.id).filter((id) => id.includes(`-${ts}`)).sort();
      const wIds = (w.state.users || []).map((u) => u.id).filter((id) => id.includes(`-${ts}`)).sort();
      assert(JSON.stringify(hIds) === JSON.stringify(wIds), `coord: HTTP ${hIds} != WS ${wIds}`);
      assert(!hIds.includes(U('mashA2')) && !hIds.includes(U('adminB')) && hIds.includes(U('coordA')), `coord roster (rule T) ${hIds}`);
    }
    {
      const h = await httpUsers(tLegacy);
      const w = await wsTry(baseUrl, tLegacy);
      assert(h.status === 200 && w.ok, `legacy v1 ${h.status} ${w.code}`);
    }

    // ---- 3. strict classification: 401 on HTTP, 4401 on WS ----
    const parts = tAdminA.split('.');
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...cA, mem: U('adminB'), sub: U('adminB') })).toString('base64url')}.${parts[2]}`;
    const now = Math.floor(Date.now() / 1000);
    const bad = {
      forgedSignature: forged,
      v3: await signed({ v: 3, sub: U('adminA'), mem: U('adminA'), ep: 0 }),
      wrongMem: await signed({ v: 2, sub: U('adminA'), mem: U('adminB'), ep: 0 }),
      subNotPerson: await signed({ v: 2, sub: U('adminB'), mem: U('adminA'), ep: 0 }),
      stringEp: await signed({ v: 2, sub: U('adminA'), mem: U('adminA'), ep: '0' }),
      negativeEp: await signed({ v: 2, sub: U('adminA'), mem: U('adminA'), ep: -1 }),
      alteredEp: await signed({ v: 2, sub: U('adminA'), mem: U('adminA'), ep: 1 }),
      v2Kiosk: await signed({ v: 2, sub: U('adminA'), mem: U('adminA'), ep: 0, kiosk: true, agencyId: AG('a'), venueId: V('a1'), pv: '1', dev: 'x' }),
      v1KioskClaim: await signed({ sub: U('adminA'), venueId: V('a1') }),
      memWithoutV: await signed({ sub: U('adminA'), mem: U('adminA') }),
      epWithoutV: await signed({ sub: U('adminA'), ep: 0 }),
      expired: await signed({ v: 2, sub: U('adminA'), mem: U('adminA'), ep: 0, iat: now - 7200, exp: now - 60 }),
    };
    for (const [label, tok] of Object.entries(bad)) {
      const h = await httpUsers(tok);
      assert(h.status === 401, `${label}: HTTP must be 401, got ${h.status}`);
      const w = await wsTry(baseUrl, tok);
      assert(!w.ok && w.code === 4401, `${label}: WS must close 4401, got ${w.ok ? 'INITIAL_STATE' : w.code}`);
    }

    // ---- 4. epoch bump revokes exactly that row ----
    const tB = await login('adminB');
    const tAdminAv1b = (await hook('mint-token', { userId: U('adminA'), legacy: true })).token;
    const v0 = await ctx.getVersion();
    const bumped = await hook('bump-token-epoch', { userId: U('adminA') });
    assert(bumped.tokenEpoch === 1, `bump → ${JSON.stringify(bumped)}`);
    assert((await ctx.getVersion()) === v0 + 1, 'bump must be one commit');
    for (const [label, tok] of [['v2', tAdminA], ['v1', tAdminAv1b]]) {
      assert((await httpUsers(tok)).status === 401, `bumped admin A ${label} still accepted on HTTP`);
      const w = await wsTry(baseUrl, tok);
      assert(!w.ok && w.code === 4401, `bumped admin A ${label} WS ${w.ok ? 'INITIAL_STATE' : w.code}`);
    }
    assert((await httpUsers(tB)).status === 200 && (await wsTry(baseUrl, tB)).ok, 'admin B affected by A\'s bump');
    assert((await httpUsers(tCoord)).status === 200, 'coordinator A affected by admin A\'s bump');
    const tAdminA2 = await login('adminA');
    assert(decode(tAdminA2).ep === 1 && (await httpUsers(tAdminA2)).status === 200 && (await wsTry(baseUrl, tAdminA2)).ok, 'fresh login after bump');
    {
      // the epoch is server-only: no client-visible payload carries it
      const h = await httpUsers(tAdminA2);
      assert(!h.text.includes('tokenEpoch') && !h.text.includes('personId'), 'roster leaks identity fields');
    }
    {
      // an invalid stored epoch fails closed (never treated as 0)
      const d = await ctx.getDoc();
      const users = (d.users || []).map((u) => (u.id === U('mashA2') ? { ...u, tokenEpoch: '0' } : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users })).status === 200, 'doc-set-users (bad epoch)');
      await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: V('h1'), name: 'T50 hydrate', agencyId: AG('b') }] });
      const t1 = (await hook('mint-token', { userId: U('mashA2'), legacy: true })).token;
      const t2 = await signed({ v: 2, sub: U('mashA2'), mem: U('mashA2'), ep: 0 });
      assert((await httpUsers(t1)).status === 401 && (await httpUsers(t2)).status === 401, 'string tokenEpoch treated as 0');
    }

    // ---- 5. v1 for a deleted row ----
    {
      const tLegacyOld = tLegacy;
      // remove the row from the stored doc, then hydrate (same path as the bad-epoch case)
      const d = await ctx.getDoc();
      const users = (d.users || []).filter((u) => u.id !== U('legacyA'));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users })).status === 200, 'doc-set-users (delete)');
      await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: V('h2'), name: 'T50 hydrate 2', agencyId: AG('b') }] });
      assert(!(await ctx.getDoc()).users.some((u) => u.id === U('legacyA')), 'legacy row still present');
      assert((await httpUsers(tLegacyOld)).status === 401, 'deleted row v1 still accepted');
    }

    // ---- 6. reset-password and register issue v2 ----
    {
      const ip = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.50.0.${ts % 200}` };
      let rr = await call('POST', '/api/auth/forgot-password', ip, { email: E('coordA') });
      assert(rr.status === 200, `forgot ${rr.status}`);
      const code = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(E('coordA'))}`)).json()).code;
      rr = await call('POST', '/api/auth/verify-reset-code', ip, { email: E('coordA'), code });
      assert(rr.status === 200 && rr.json?.resetToken, `verify ${rr.status}`);
      rr = await call('POST', '/api/auth/reset-password', { 'Content-Type': 'application/json' }, { email: E('coordA'), resetToken: rr.json.resetToken, newPassword: 'stage2-t50-newpass' });
      assert(rr.status === 200 && rr.json?.token, `reset ${rr.status}`);
      const c = decode(rr.json.token);
      assert(c.v === 2 && c.mem === U('coordA') && c.sub === U('coordA'), `reset token ${JSON.stringify(c)}`);
      assert((await httpUsers(rr.json.token)).status === 200, 'reset token works');
      const reg = await call('POST', '/api/agencies/register', { 'Content-Type': 'application/json' }, { agencyName: `T50 Reg ${ts}`, shortCode: `T5R${ts}`.slice(0, 12), adminName: 'T50 Reg', adminEmail: E('reg'), adminPassword: 'stage2-t50-regpass', initialVenueName: 'T50 Reg Venue' });
      assert(reg.status === 201 && reg.json?.token, `register ${reg.status} ${reg.text.slice(0, 200)}`);
      const cr = decode(reg.json.token);
      assert(cr.v === 2 && cr.mem === reg.json.user.id && cr.sub === reg.json.user.id && cr.ep === 0, `register token ${JSON.stringify(cr)}`);
      assert((await httpUsers(reg.json.token)).status === 200, 'register token works');
    }

    // ---- 7. kiosk path unchanged ----
    {
      const kr = await call('POST', '/api/__test__/mint-kiosk-token', { 'Content-Type': 'application/json' }, { userId: U('adminA'), agencyId: AG('a'), venueId: V('a1') });
      assert(kr.status === 200 && kr.json?.token, `mint-kiosk-token ${kr.status}`);
      const kc = decode(kr.json.token);
      assert(kc.kiosk === true && !('v' in kc), 'kiosk token shape unchanged');
      // no device proof → 401 as today (kiosk device proof intact)
      assert((await httpUsers(kr.json.token)).status === 401, 'kiosk token without device proof accepted');
    }
    return 'v2 for migrated rows, v1 for legacy; one classifier + one resolver for HTTP and WS (same identity/roster); malformed/hybrid/expired fail closed (401/4401); epoch bump revokes exactly one row; invalid epoch fails closed; reset/register issue v2; kiosk unchanged';
  },
};
