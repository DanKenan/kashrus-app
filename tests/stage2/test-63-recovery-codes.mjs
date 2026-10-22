/**
 * Test 63 (10f, "recovery codes", design agreed as [10F-DS1]).
 * X = single-row person in agency A, origin 'self-registered' (planted; 10b's
 * register is the production writer). L = legacy (no origin), M = origin
 * 'admin'.
 *
 *  A  issue: wrong password 401 nothing written; 10 codes, no-store; stored
 *     as salted hashes only — no plaintext in the stored doc, and neither
 *     hashes nor salt in GET /api/users, WS INITIAL_STATE or the admin export;
 *     legacy / 'admin' origin -> 403 nothing written
 *  B  recover: right code -> new password + token; origin kept; code burned
 *     (reuse 401); every old token 401 + open socket 4401; pending reset for
 *     the email cleared
 *  C  lockout per PERSON: 5 wrong codes from 5 IPs -> locked; the right code
 *     401 while locked and nothing counted; epochs untouched by failures;
 *     after 1 h (test clock) the right code works and the record is cleared
 *  D  regenerate replaces every old code
 *  E  multi P: codes issued from Y's session land on the owner X; recover ->
 *     X's session, every row of P bumped; after the owner transfer (X
 *     deleted) the same codes recover Y
 *  F  per-IP bucket: the 21st attempt from one IP -> 429
 *  G  unknown email / no set / ineligible origin: the same 401 body as a
 *     wrong code
 */
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
function openWs(baseUrl, token) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const c = { ws, state: 'connecting', code: null, messages: [] };
  ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); c.messages.push(m); if (m.type === 'INITIAL_STATE') c.state = 'open'; } catch {} };
  ws.onclose = (ev) => { c.state = 'closed'; c.code = ev.code; };
  ws.onerror = () => {};
  c.waitOpen = async (ms = 8000) => { const s = Date.now(); while (c.state === 'connecting' && Date.now() - s < ms) await sleep(50); return c.state; };
  c.waitClose = async (ms = 5000) => { const s = Date.now(); while (c.state !== 'closed' && Date.now() - s < ms) await sleep(50); return c.state === 'closed' ? c.code : null; };
  c.close = () => { try { ws.close(); } catch {} };
  return c;
}

export default {
  name: 'Test 63: recovery codes (10f)',
  whatItProves:
    'Only a linkable credential gets codes (shown once, stored as salted hashes, never in payloads/exports); a code recovers once, keeps the origin, signs out every session of the person; 5 wrong codes lock the person for 1 h across IPs; regeneration kills old codes; codes live on the owner row and follow an owner transfer; per-IP bucket; one generic failure.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t63a-${ts}`, B = `agency-t63b-${ts}`;
    const A1 = `venue-t63-a1-${ts}`, B1 = `venue-t63-b1-${ts}`;
    const U = (k) => `user-t63-${k}-${ts}`;
    const E = (k) => `t63-${k}-${ts}@test.local`;
    const X = U('x'), L = U('l'), M = U('m');
    const XE = E('x');
    const PW = 'stage2-t63-password';
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.63.${ts % 200}.${ipN++}` });
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const rows = async () => ((await ctx.getDoc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t63-h${k}-${Date.now()}`, name: 'T63 hydrate', agencyId: A }] })).status === 200, `rehydrate ${k}`);
    const issue = (token, currentPassword) => call('POST', '/api/auth/recovery-codes', auth(token), { currentPassword });
    const recover = (email, code, newPassword, headers) => call('POST', '/api/auth/recover', headers || ipH(), { email, code, newPassword });
    const login = (email, password) => call('POST', '/api/auth/login', jsonH, { email, password });
    const alive = async (t) => (await call('GET', '/api/agencies/current', auth(t))).status;

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T63 A ${ts}`, timeZone: 'America/New_York' }, { id: B, name: `T63 B ${ts}`, timeZone: 'Asia/Jerusalem' }],
      venues: [{ id: A1, name: `T63 A1 ${ts}`, agencyId: A }, { id: B1, name: `T63 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T63 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T63 Admin B', role: 'admin', agencyId: B },
        { id: X, email: XE, name: 'T63 X', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: L, email: E('l'), name: 'T63 L', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: M, email: E('m'), name: 'T63 M', role: 'mashgiach', agencyId: A, venueId: A1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);
    for (const id of [X, L, M]) assert((await hook('set-password', { userId: id, password: PW })).status === 200, `set-password ${id}`);
    {
      const users = (await rows()).map((u) => (u.id === X ? { ...u, credentialOrigin: 'self-registered' } : u.id === M ? { ...u, credentialOrigin: 'admin' } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'plant origins');
      await rehydrate('0');
    }
    assert((await rowOf(X)).credentialOrigin === 'self-registered' && (await rowOf(L)).credentialOrigin === undefined && (await rowOf(M)).credentialOrigin === 'admin', 'origins planted');
    const wrongBody = (await recover(XE, 'ZZZZZ-ZZZZY', 'stage2-t63-nope0')).text;
    {
      // the probe above was a real wrong code for X: reset its failure count for a clean C
      const users = (await rows()).map((u) => { if (u.id !== X) return u; const { recoveryFailures, ...rest } = u; return rest; });
      assert((await hook('doc-set-users', { users })).status === 200, 'clear probe failure');
      await rehydrate('p');
    }

    // ---- A: issue ----
    let tX = await mintToken(baseUrl, X);
    let codes;
    {
      let v0 = await ctx.getVersion();
      let r = await issue(tX, 'wrong-password-t63');
      assert(r.status === 401, `A wrong password 401: ${r.status}`);
      await unchanged(v0, 'A wrong password');
      for (const id of [L, M]) {
        v0 = await ctx.getVersion();
        r = await issue(await mintToken(baseUrl, id), PW);
        assert(r.status === 403, `A ineligible origin 403 (${id}): ${r.status}`);
        await unchanged(v0, `A ineligible ${id}`);
      }
      r = await issue(tX, PW);
      assert(r.status === 200 && Array.isArray(r.json?.codes) && r.json.codes.length === 10, `A issue: ${r.status} ${r.text.slice(0, 120)}`);
      assert(/no-store/.test(r.headers.get('cache-control') || ''), 'A no-store');
      codes = r.json.codes;
      const x = await rowOf(X);
      const set = x.recoveryCodeHashes;
      assert(set && set.hashes?.length === 10 && typeof set.salt === 'string', `A stored set ${J(set && { n: set.hashes?.length })}`);
      const docText = J(await ctx.getDoc());
      for (const c of codes) assert(!docText.includes(c) && !docText.includes(c.replace('-', '')), 'A no plaintext code in the stored doc');
      const tAd = await mintToken(baseUrl, U('adA'));
      const usersResp = await call('GET', '/api/users', auth(tAd));
      assert(usersResp.status === 200 && !usersResp.text.includes('recoveryCodeHashes') && !usersResp.text.includes(set.salt) && !usersResp.text.includes(set.hashes[0]), 'A GET /api/users carries no recovery data');
      const exp = await call('GET', '/api/admin/export', auth(tAd));
      assert(!exp.text.includes(set.salt) && !exp.text.includes(set.hashes[0]) && !exp.text.includes('recoveryCodeHashes'), `A admin export carries no recovery data (${exp.status})`);
      const ws = openWs(baseUrl, tAd);
      assert((await ws.waitOpen()) === 'open', 'A admin socket');
      const wsText = J(ws.messages);
      assert(!wsText.includes(set.salt) && !wsText.includes(set.hashes[0]) && !wsText.includes('recoveryCodeHashes'), 'A WS INITIAL_STATE carries no recovery data');
      ws.close();
      console.log('  ✓ A issue: linkable only, wrong password writes nothing, 10 codes no-store, hashes only and never in payloads/exports');
    }

    // ---- B: recover ----
    {
      assert((await call('POST', '/api/auth/forgot-password', ipH(), { email: XE })).status === 200, 'B forgot (pending reset)');
      assert(((await ctx.getDoc()).passwordResets || []).some((r) => r.email === XE), 'B pending reset exists');
      const wsX = openWs(baseUrl, tX);
      assert((await wsX.waitOpen()) === 'open', 'B X socket');
      const x0 = await rowOf(X);
      const r = await recover(XE, codes[4].toLowerCase().replace('-', ' '), 'stage2-t63-new1');
      assert(r.status === 200 && r.json?.user?.id === X && typeof r.json?.token === 'string', `B recover: ${r.status} ${r.text.slice(0, 160)}`);
      assert(/no-store/.test(r.headers.get('cache-control') || ''), 'B no-store');
      const x1 = await rowOf(X);
      assert(x1.password !== x0.password && x1.credentialOrigin === 'self-registered', 'B password changed, origin kept');
      assert(x1.recoveryCodeHashes.hashes.length === 9, 'B code burned');
      assert((x1.tokenEpoch ?? 0) === (x0.tokenEpoch ?? 0) + 1, 'B epoch +1');
      assert(!((await ctx.getDoc()).passwordResets || []).some((q) => q.email === XE), 'B pending reset cleared');
      assert((await alive(tX)) === 401, 'B old token 401');
      assert((await wsX.waitClose()) === 4401, `B open socket 4401 (${wsX.code})`);
      assert((await alive(r.json.token)) === 200, 'B new token works');
      const again = await recover(XE, codes[4], 'stage2-t63-new2');
      assert(again.status === 401 && again.text === wrongBody, `B reuse refused: ${again.status}`);
      assert((await login(XE, 'stage2-t63-new1')).status === 200, 'B new password logs in');
      tX = r.json.token;
      console.log('  ✓ B recover: one-time code, origin kept, every old session revoked, pending reset cleared');
    }

    // ---- C: lockout per person ----
    {
      // the reuse in B counted 1 failure; 4 more (different IPs) lock
      const e0 = (await rowOf(X)).tokenEpoch;
      for (let i = 0; i < 4; i++) {
        const r = await recover(XE, `ZZZZZ-ZZZ${i}Y`, 'stage2-t63-nope1');
        assert(r.status === 401 && r.text === wrongBody, `C wrong ${i}: ${r.status}`);
      }
      const f = (await rowOf(X)).recoveryFailures;
      assert(f && typeof f.lockedUntil === 'string', `C locked after 5 failures ${J(f)}`);
      const v0 = await ctx.getVersion();
      let r = await recover(XE, codes[7], 'stage2-t63-new3');
      assert(r.status === 401 && r.text === wrongBody, `C right code refused while locked: ${r.status}`);
      await unchanged(v0, 'C nothing counted while locked');
      assert((await rowOf(X)).tokenEpoch === e0, 'C failures change no epoch');
      assert((await alive(tX)) === 200, 'C failures revoke nothing');
      assert((await hook('clock', { iso: new Date(Date.now() + 61 * 60 * 1000).toISOString() })).status === 200, 'C clock +61 min');
      try {
        r = await recover(XE, codes[7], 'stage2-t63-new3');
        assert(r.status === 200 && r.json?.user?.id === X, `C after the lock expired: ${r.status} ${r.text.slice(0, 120)}`);
        assert((await rowOf(X)).recoveryFailures === undefined, 'C success clears the failure record');
        tX = r.json.token;
      } finally {
        await hook('clock', { iso: null });
      }
      console.log('  ✓ C 5 wrong codes across IPs lock the person 1 h; nothing counted while locked; expiry then success clears');
    }

    // ---- D: regenerate ----
    {
      const r = await issue(tX, 'stage2-t63-new3');
      assert(r.status === 200 && r.json.codes.length === 10, `D regenerate ${r.status}`);
      const codes2 = r.json.codes;
      const old = await recover(XE, codes[2], 'stage2-t63-new4');
      assert(old.status === 401, `D old code dead: ${old.status}`);
      const ok = await recover(XE, codes2[9], 'stage2-t63-new4');
      assert(ok.status === 200, `D new code works: ${ok.status}`);
      tX = ok.json.token;
      console.log('  ✓ D a new set replaces every old code');
    }

    // ---- E: multi person, owner row, owner transfer ----
    {
      // X becomes the explicit credentialOwner first (as Test 60), then Y joins
      {
        const users = (await rows()).map((u) => (u.id === X ? { ...u, credentialOwner: true } : u));
        assert((await hook('doc-set-users', { users })).status === 200, 'E plant owner');
        await rehydrate('e');
      }
      let r = await hook('identity-build-person', { ownerUserId: X, agencyId: B, role: 'coordinator', venueId: B1, name: 'T63 Y' });
      assert(r.status === 200, `E build Y ${r.status} ${J(r.json)}`);
      const Y = r.json.id;
      const tY = await mintToken(baseUrl, Y);
      r = await issue(tY, 'stage2-t63-new4');
      assert(r.status === 200, `E issue from Y's session: ${r.status} ${r.text.slice(0, 120)}`);
      const codes3 = r.json.codes;
      assert((await rowOf(X)).recoveryCodeHashes?.hashes?.length === 10 && (await rowOf(Y)).recoveryCodeHashes === undefined, 'E codes on the owner row only');
      const x0 = await rowOf(X), y0 = await rowOf(Y);
      r = await recover(XE, codes3[5], 'stage2-t63-new5');
      assert(r.status === 200 && r.json?.user?.id === X, `E recover -> X: ${r.status}`);
      const x1 = await rowOf(X), y1 = await rowOf(Y);
      assert(x1.tokenEpoch === (x0.tokenEpoch ?? 0) + 1 && y1.tokenEpoch === (y0.tokenEpoch ?? 0) + 1, `E every row bumped ${J([x0.tokenEpoch, x1.tokenEpoch, y0.tokenEpoch, y1.tokenEpoch])}`);
      assert((await alive(tY)) === 401, 'E Y old token 401');
      const tAd = await mintToken(baseUrl, U('adA'));
      const d = await call('DELETE', `/api/users/${X}`, auth(tAd), { expectedVersion: await ctx.getVersion() });
      assert(d.status === 200, `E delete owner X: ${d.status} ${d.text.slice(0, 120)}`);
      const y2 = await rowOf(Y);
      assert(y2.credentialOwner === true && y2.recoveryCodeHashes?.hashes?.length === 9, 'E codes moved with the credential to Y');
      r = await recover(XE, codes3[2], 'stage2-t63-new6');
      assert(r.status === 200 && r.json?.user?.id === Y, `E recover after transfer -> Y: ${r.status} ${r.text.slice(0, 120)}`);
      console.log('  ✓ E codes live on the owner row, recover bumps every row, and follow an owner transfer');
    }

    // ---- G: one generic failure ----
    {
      for (const [email, label] of [[E('nobody'), 'unknown'], [E('l'), 'legacy, no set'], [E('m'), "origin 'admin'"]]) {
        const r = await recover(email, 'ABCDE-FGHJK', 'stage2-t63-nope9');
        assert(r.status === 401 && r.text === wrongBody, `G ${label}: ${r.status} ${r.text}`);
      }
      console.log('  ✓ G unknown / no set / ineligible: the same 401 as a wrong code');
    }

    // ---- F: per-IP bucket ----
    {
      const fixed = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.163.${ts % 200}.7` };
      let last = null;
      for (let i = 0; i < 20; i++) {
        last = await recover(E('nobody-f'), 'ABCDE-FGHJK', 'stage2-t63-nope8', fixed);
        assert(last.status === 401, `F attempt ${i + 1}: ${last.status}`);
      }
      const v0 = await ctx.getVersion();
      last = await recover(E('nobody-f'), 'ABCDE-FGHJK', 'stage2-t63-nope8', fixed);
      assert(last.status === 429, `F 21st attempt 429: ${last.status}`);
      await unchanged(v0, 'F');
      console.log('  ✓ F the 21st attempt from one IP is refused (429)');
    }
    return 'linkable-only issue, no-store, hashes only and never in payloads/exports; one-time recover keeps origin and revokes every session; per-person 1 h lock across IPs (test clock); regenerate kills old codes; owner-row codes follow an owner transfer; per-IP 429; one generic failure';
  },
};
