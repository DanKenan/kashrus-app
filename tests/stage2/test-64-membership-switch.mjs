/**
 * Test 64 (10g, "sign-in with several memberships + switch", design agreed
 * as [10G-DS1]). P = X (owner, agency A) + Y (agency B); S = single-row
 * person in A; Z = a third person in B.
 *
 *  A  login: multi -> {success, chooseMembership, memberships, token} only
 *     (no user, a choose token); memberships = X(A), Y(B) with exactly
 *     membershipId/agencyId/agencyName/role; single-row login unchanged
 *  B  choose token: memberships 200 (+isCurrent false); activate(Y) -> v2
 *     for Y: agencies/current is B, Y's socket INITIAL_STATE carries no A
 *     venue/user; activate(X) works; Z's row / unknown id / missing body ->
 *     one 403; activation writes nothing
 *  C  the choose token on EVERY non-public route except the two -> 401
 *     (Express route table walk), and on the WS handshake -> 4401
 *  D  v2 path: memberships from Y's v2 token marks Y current; activate(X)
 *     from Y's token; Y's token still works afterwards; kiosk token -> 403
 *     on both; a legacy v1 row -> 403
 *  E  invalidation: expired choose -> 401; choose after change-password
 *     (E1) -> 401 on both routes; choose after the owner transfer (X
 *     deleted) -> 401; Y's v2 token of a deleted membership cannot activate
 *  F  v2 agency check: a v2 token whose agency is gone -> 401 (REST) and
 *     4401 (WS handshake)
 */
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
  name: 'Test 64: sign-in with several memberships + switch (10g)',
  whatItProves:
    'A multi person logs in to a choose token that only lists and activates their OWN memberships (never a session, refused on every other route and the socket); activation gives a v2 token for exactly that membership and writes nothing; v2 can switch too; E1 / owner transfer / expiry kill choose tokens; single-row login is unchanged; a v2 token whose agency is gone is refused.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t64a-${ts}`, B = `agency-t64b-${ts}`, G = `agency-t64g-${ts}`;
    const A1 = `venue-t64-a1-${ts}`, B1 = `venue-t64-b1-${ts}`, G1 = `venue-t64-g1-${ts}`;
    const U = (k) => `user-t64-${k}-${ts}`;
    const E = (k) => `t64-${k}-${ts}@test.local`;
    const X = U('x'), S = U('s'), Z = U('z'), L = U('l'), Q = U('q');
    const PE = E('p'), PW = 'stage2-t64-password';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const jsonH = { 'Content-Type': 'application/json' };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const rows = async () => ((await ctx.getDoc()).users || []);
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t64-h${k}-${Date.now()}`, name: 'T64 hydrate', agencyId: A }] })).status === 200, `rehydrate ${k}`);
    const login = (email, password) => call('POST', '/api/auth/login', jsonH, { email, password });
    const mems = (t) => call('GET', '/api/auth/memberships', auth(t));
    const act = (t, membershipId) => call('POST', '/api/auth/activate', auth(t), membershipId === undefined ? {} : { membershipId });
    const current = (t) => call('GET', '/api/agencies/current', auth(t));

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T64 Alpha ${ts}` }, { id: B, name: `T64 Beta ${ts}` }, { id: G, name: `T64 Gamma ${ts}` }],
      venues: [{ id: A1, name: `T64 A1 ${ts}`, agencyId: A }, { id: B1, name: `T64 B1 ${ts}`, agencyId: B }, { id: G1, name: `T64 G1 ${ts}`, agencyId: G }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T64 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T64 Admin B', role: 'admin', agencyId: B },
        { id: X, email: PE, name: 'T64 X', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: S, email: E('s'), name: 'T64 S', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: Z, email: E('z'), name: 'T64 Z', role: 'mashgiach', agencyId: B, venueId: B1 },
        { id: Q, email: E('q'), name: 'T64 Q', role: 'mashgiach', agencyId: G, venueId: G1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);
    for (const id of [X, S]) assert((await hook('set-password', { userId: id, password: PW })).status === 200, `set-password ${id}`);
    {
      const users = (await rows()).map((u) => (u.id === X ? { ...u, credentialOwner: true } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'plant owner');
      await rehydrate('0');
    }
    const built = await hook('identity-build-person', { ownerUserId: X, agencyId: B, role: 'coordinator', venueId: B1, name: 'T64 Y' });
    assert(built.status === 200, `build Y ${built.status} ${J(built.json)}`);
    const Y = built.json.id;

    // ---- A: login ----
    let choose;
    {
      const lg = await login(PE, PW);
      assert(lg.status === 200, `A login ${lg.status} ${lg.text.slice(0, 120)}`);
      assert(J(Object.keys(lg.json).sort()) === J(['chooseMembership', 'memberships', 'success', 'token']) && lg.json.chooseMembership === true, `A exact keys ${J(Object.keys(lg.json))}`);
      const ms = lg.json.memberships;
      assert(ms.length === 2 && ms.every((m) => J(Object.keys(m).sort()) === J(['agencyId', 'agencyName', 'membershipId', 'role'])), `A membership fields ${J(ms)}`);
      assert(J(ms.map((m) => [m.membershipId, m.agencyId, m.agencyName, m.role]).sort()) === J([[X, A, `T64 Alpha ${ts}`, 'mashgiach'], [Y, B, `T64 Beta ${ts}`, 'coordinator']].sort()), `A memberships ${J(ms)}`);
      const c = decode(lg.json.token);
      assert(c.v === 3 && c.cr === X && c.mem === undefined && c.exp - c.iat === 600, `A choose claims ${J(c)}`);
      choose = lg.json.token;
      const ls = await login(E('s'), PW);
      assert(ls.status === 200 && J(Object.keys(ls.json).sort()) === J(['success', 'token', 'user']) && ls.json.user.id === S && decode(ls.json.token).v === 2, `A single-row login unchanged ${J(Object.keys(ls.json || {}))}`);
      console.log('  ✓ A multi login -> chooser (no user, choose token, 2 memberships with 4 fields); single-row login unchanged');
    }

    // ---- B: choose token ----
    let tY, tX;
    {
      let r = await mems(choose);
      assert(r.status === 200 && r.json.memberships.length === 2 && r.json.memberships.every((m) => m.isCurrent === false), `B memberships ${r.status} ${r.text.slice(0, 160)}`);
      const v0 = await ctx.getVersion();
      r = await act(choose, Y);
      assert(r.status === 200 && r.json.user?.id === Y && decode(r.json.token).mem === Y && decode(r.json.token).v === 2, `B activate Y ${r.status} ${r.text.slice(0, 160)}`);
      tY = r.json.token;
      const cur = await current(tY);
      assert(cur.status === 200 && (cur.json?.agency?.id ?? cur.json?.id) === B, `B Y's session is agency B: ${cur.status} ${cur.text.slice(0, 120)}`);
      const ws = openWs(baseUrl, tY);
      assert((await ws.waitOpen()) === 'open', 'B Y socket opens');
      const init = J(ws.messages.find((m) => m.type === 'INITIAL_STATE'));
      assert(!init.includes(A1) && !init.includes(X) && init.includes(B1), 'B Y INITIAL_STATE is B only');
      ws.close();
      r = await act(choose, X);
      assert(r.status === 200 && r.json.user?.id === X, `B activate X ${r.status}`);
      tX = r.json.token;
      const refusals = [await act(choose, Z), await act(choose, 'no-such-row'), await act(choose)];
      assert(refusals.every((x) => x.status === 403 && x.text === refusals[0].text), `B refusals ${J(refusals.map((x) => x.status))}`);
      assert((await ctx.getVersion()) === v0, 'B activation writes nothing');
      assert((await mems(choose)).status === 200, 'B choose token still valid after activations');
      console.log('  ✓ B choose lists + activates only P\'s rows (v2 for that row, agency B only on the socket); others one 403; nothing written');
    }

    // ---- C: route table walk ----
    {
      const rt = await call('GET', '/api/__test__/route-table', jsonH);
      assert(rt.status === 200 && Array.isArray(rt.json?.routes) && rt.json.routes.length > 50, `C route table ${rt.status}`);
      const allowed = new Set(['GET /api/auth/memberships', 'POST /api/auth/activate']);
      let walked = 0;
      const leaks = [];
      for (const r of rt.json.routes) {
        if (r.public || !r.path.startsWith('/api/')) continue;
        if (allowed.has(`${r.method} ${r.path}`)) continue;
        const path = r.path.replace(/:[A-Za-z_]+/g, 't64x');
        const res = await call(r.method, path, auth(choose), r.method === 'GET' || r.method === 'HEAD' ? undefined : {});
        walked++;
        if (res.status !== 401) leaks.push(`${r.method} ${r.path} -> ${res.status}`);
      }
      assert(walked > 50 && leaks.length === 0, `C choose token must be 401 on every other route (${walked} walked): ${leaks.slice(0, 10).join('; ')}`);
      const ws = openWs(baseUrl, choose);
      assert((await ws.waitClose()) === 4401, `C WS with a choose token 4401 (${ws.code})`);
      console.log(`  ✓ C choose token 401 on all ${walked} other non-public routes, 4401 on the socket`);
    }

    // ---- D: v2 path ----
    {
      let r = await mems(tY);
      const cur = r.json?.memberships?.find((m) => m.isCurrent);
      assert(r.status === 200 && cur?.membershipId === Y && r.json.memberships.length === 2, `D memberships from Y ${r.status} ${r.text.slice(0, 120)}`);
      r = await act(tY, X);
      assert(r.status === 200 && r.json.user.id === X, `D activate X from Y's v2 ${r.status}`);
      assert((await current(tY)).status === 200, 'D Y token not revoked by activating X');
      assert((await act(tY, Z)).status === 403, 'D Z refused from a v2 token');
      const kt = await call('POST', '/api/__test__/mint-kiosk-token', jsonH, { userId: S, agencyId: A, venueId: A1 });
      assert(kt.status === 200, 'D mint kiosk');
      const km = await mems(kt.json.token), ka = await act(kt.json.token, X);
      assert([401, 403].includes(km.status) && [401, 403].includes(ka.status), `D kiosk refused (${km.status}/${ka.status})`);
      const tS = await mintToken(baseUrl, S);
      assert((await mems(tS)).status === 200 && (await act(tS, X)).status === 403, 'D single-row v2 sees itself only, cannot activate X');
      console.log('  ✓ D v2 switch works and keeps the old token; kiosk refused; another person refused');
    }

    // ---- F: v2 agency check ----
    {
      const tQ = await mintToken(baseUrl, Q);
      assert((await current(tQ)).status === 200, 'F Q token works before');
      const doc = await ctx.getDoc();
      const users = doc.users;
      // remove agency G from the doc (test hook keeps users; the row now points at a missing agency)
      const r = await hook('doc-set-users', { users, agencies: (doc.agencies || []).filter((a) => a.id !== G) });
      if (r.status === 200 && !((await ctx.getDoc()).agencies || []).some((a) => a.id === G)) {
        await rehydrate('f');
        assert((await current(tQ)).status === 401, 'F v2 with its agency gone -> 401');
        const ws = openWs(baseUrl, tQ);
        assert((await ws.waitClose()) === 4401, `F WS 4401 (${ws.code})`);
        console.log('  ✓ F v2 token whose agency is gone: 401 / 4401');
      } else {
        throw new Error(`F could not remove the agency through the test hook (${r.status})`);
      }
    }

    // ---- E: invalidation ----
    {
      const exp = await ctx.api('POST', '/api/__test__/sign-claims', { claims: { ...decode(choose), exp: Math.floor(Date.now() / 1000) - 5 } });
      assert(exp.status === 200, `E sign-claims ${exp.status}`);
      assert((await mems(exp.json.token)).status === 401, 'E expired choose 401');
      // E1: change-password from X bumps every row of P
      const cp = await call('POST', '/api/auth/change-password', auth(tX), { currentPassword: PW, newPassword: 'stage2-t64-new1' });
      assert(cp.status === 200, `E change-password ${cp.status} ${cp.text.slice(0, 120)}`);
      assert((await mems(choose)).status === 401 && (await act(choose, X)).status === 401, 'E choose dead after E1');
      const lg = await login(PE, 'stage2-t64-new1');
      assert(lg.status === 200 && lg.json.chooseMembership, 'E fresh chooser after E1');
      const choose2 = lg.json.token;
      const tY2 = (await act(choose2, Y)).json.token;
      // owner transfer: delete X (admin A)
      const tAd = await mintToken(baseUrl, U('adA'));
      const d = await call('DELETE', `/api/users/${X}`, auth(tAd), { expectedVersion: await ctx.getVersion() });
      assert(d.status === 200, `E delete owner X ${d.status} ${d.text.slice(0, 120)}`);
      assert((await mems(choose2)).status === 401 && (await act(choose2, Y)).status === 401, 'E choose dead after the owner transfer');
      assert((await current(tY2)).status === 200, 'E Y v2 survives the transfer (E3 bumps nothing)');
      // removed membership: delete Y (admin B) -> its v2 cannot activate anything
      const tAdB = await mintToken(baseUrl, U('adB'));
      const d2 = await call('DELETE', `/api/users/${Y}`, auth(tAdB), { expectedVersion: await ctx.getVersion() });
      assert(d2.status === 200, `E delete Y ${d2.status} ${d2.text.slice(0, 120)}`);
      assert((await act(tY2, Y)).status === 401, 'E a deleted membership\'s token cannot activate');
      console.log('  ✓ E expired / E1 / owner transfer kill choose tokens; a removed membership cannot activate');
    }
    return 'chooser login (no session), choose token only on memberships/activate (401 on every other route, 4401 WS), activate = v2 for own rows only and writes nothing, v2 switch, kiosk refused, E1/transfer/expiry kill choose, v2 agency check, single-row login unchanged';
  },
};
