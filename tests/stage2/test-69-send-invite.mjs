/**
 * Test 69 (10k): "Send invite" for an existing member (design v2, [10K-DS2]).
 *  R  refusals (409, nothing written): self, primary admin, a person who set
 *     their own password (self-registered / invite-new), a multi person
 *     (both agencies byte-for-byte unchanged); other agency's member 404;
 *     coordinator 403; flag OFF 404.
 *  S  success: password removed, marker set, epoch +1 (REST 401, WS 4401),
 *     reset requests for the row cleared, login = the uniform failure (even
 *     for an admin row), forgot = uniform text with no new request; admins
 *     see invitePending, others nothing; the raw marker is never in a payload.
 *  K  the marker survives an unrelated admin edit and a body cannot clear it.
 *  A  re-send: new link, old link dead, still pending; revoke -> needsInvite;
 *     accept: preview kind 'setup', short password 400, then the person's own
 *     password (origin invite-new), marker gone, login works, link dead.
 *  F  fresh re-check: caller demoted in the stored doc only -> 403, nothing written.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
function openWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const conn = { ws, closeCode: null, raw: [] };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => { conn.raw.push(String(ev.data)); if (String(ev.data).includes('"INITIAL_STATE"')) { clearTimeout(timer); resolve(conn); } };
    ws.onclose = (ev) => { conn.closeCode = ev.code; };
    ws.onerror = () => {};
  });
}

export default {
  name: 'Test 69: Send invite for an existing member (10k)',
  whatItProves:
    'An admin can, per person and only with Phase C ON, revoke an admin-set password and its sessions and hand out a setup link; never for themselves, the primary admin, someone who chose their own password, or a multi-agency person; the pending marker has one writer, survives other edits, blocks login and reset codes; the person then chooses their own password (invite-new).',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t69a-${ts}`, B = `agency-t69b-${ts}`;
    const A1 = `venue-t69-a1-${ts}`, B1 = `venue-t69-b1-${ts}`;
    const U = (k) => `user-t69-${k}-${ts}`;
    const E = (k) => `t69-${k}-${ts}@test.local`;
    const PW = 'stage2-t69-password';
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.69.${ts % 200}.${ipN++}` });
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const doc = () => ctx.getDoc();
    const rows = async () => ((await doc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t69-h${k}-${Date.now()}`, name: 'T69 hydrate', agencyId: B }] })).status === 200, `rehydrate ${k}`);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const flag = async (agencyId, enabled) => assert((await hook('phase-c', { agencyId, enabled })).status === 200, `phase-c ${agencyId} ${enabled}`);
    const send = async (t, id) => call('POST', `/api/users/${id}/invite`, auth(t), { expectedVersion: await ctx.getVersion() });
    const tokenOf = (link) => { const m = /^\/invite#t=([A-Za-z0-9_-]{43})$/.exec(link || ''); assert(m, `link shape ${link}`); return m[1]; };
    const login = (email, password) => call('POST', '/api/auth/login', jsonH, { email, password });

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T69 A ${ts}`, timeZone: 'America/New_York', adminEmail: E('prim') }, { id: B, name: `T69 B ${ts}`, timeZone: 'America/New_York' }],
      venues: [{ id: A1, name: `T69 A1 ${ts}`, agencyId: A }, { id: B1, name: `T69 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T69 Admin A', role: 'admin', agencyId: A },
        { id: U('prim'), email: E('prim'), name: 'T69 Primary', role: 'admin', agencyId: A },
        { id: U('ad2'), email: E('ad2'), name: 'T69 Admin 2', role: 'admin', agencyId: A },
        { id: U('coA'), email: E('coa'), name: 'T69 Coord A', role: 'coordinator', agencyId: A, venueId: A1 },
        { id: U('t'), email: E('t'), name: 'T69 Target', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('self'), email: E('self'), name: 'T69 Self', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('m'), email: E('m'), name: 'T69 Multi', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('bB'), email: E('bb'), name: 'T69 B member', role: 'mashgiach', agencyId: B, venueId: B1 },
        { id: U('f'), email: E('f'), name: 'T69 Fresh target', role: 'mashgiach', agencyId: A, venueId: A1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    for (const k of ['t', 'self', 'm', 'ad2', 'f']) assert((await hook('set-password', { userId: U(k), password: PW })).status === 200, `set-password ${k}`);
    {
      const users = await rows();
      const m = users.find((u) => u.id === U('m'));
      const planted = users.map((u) => (u.id === U('self') ? { ...u, credentialOrigin: 'self-registered' } : u.id === U('m') ? { ...u, credentialOwner: true, credentialOrigin: 'self-registered' } : u));
      planted.push({ id: U('m2'), email: m.email, name: 'T69 Multi in B', role: 'mashgiach', agencyId: B, venueId: B1, personId: m.personId, avatarColor: '#64748b' });
      assert((await hook('doc-set-users', { users: planted })).status === 200, 'plant origins + multi person');
      await rehydrate('0');
    }
    const tA = await mintToken(baseUrl, U('adA'));

    // ---- R: refusals ----
    {
      let v0 = await ctx.getVersion();
      assert((await send(tA, U('t'))).status === 404, 'R flag OFF 404');
      await unchanged(v0, 'R flag OFF');
      await flag(A, true);
      await flag(B, true);
      v0 = await ctx.getVersion();
      const before = J(await doc());
      for (const [k, label] of [['adA', 'self'], ['prim', 'primary admin'], ['self', 'own password (self-registered)'], ['m', 'multi person']]) {
        const r = await send(tA, U(k));
        assert(r.status === 409 && r.json?.code === 'INVITE_NOT_AVAILABLE', `R ${label} 409: ${r.status} ${r.text.slice(0, 100)}`);
      }
      const other = await send(tA, U('bB'));
      assert(other.status === 404, `R other agency's member 404 (${other.status})`);
      const co = await send(await mintToken(baseUrl, U('coA')), U('t'));
      assert(co.status === 403, `R coordinator 403 (${co.status})`);
      await unchanged(v0, 'R refusals');
      assert(J(await doc()) === before, 'R both agencies byte-for-byte unchanged (incl. the multi person)');
      console.log('  ✓ R flag OFF 404; self / primary admin / own password / multi person 409; other agency 404; coordinator 403; nothing written anywhere');
    }

    // ---- S: success ----
    let link1;
    {
      const tT = await mintToken(baseUrl, U('t'));
      const ws = await openWs(baseUrl, tT);
      const fp = await call('POST', '/api/auth/forgot-password', ipH(), { email: E('t') });
      assert(fp.status === 200, `S forgot before (${fp.status})`);
      assert(((await doc()).passwordResets || []).some((r) => r.email === E('t')), 'S a reset request exists before');
      const t0 = await rowOf(U('t'));
      const r = await send(tA, U('t'));
      assert(r.status === 201 && r.json.invite.kind === 'setup' && r.json.invite.memberId === U('t') && /no-store/.test(r.headers.get('cache-control') || ''), `S 201 ${r.status} ${r.text.slice(0, 160)}`);
      link1 = r.json.link;
      const t1 = await rowOf(U('t'));
      assert(t1.password === undefined && t1.credentialPending === 'invite' && (t1.tokenEpoch ?? 0) === (t0.tokenEpoch ?? 0) + 1, `S row ${J({ pw: !!t1.password, p: t1.credentialPending, e: [t0.tokenEpoch, t1.tokenEpoch] })}`);
      assert(!((await doc()).passwordResets || []).some((x) => x.email === E('t')), 'S reset requests cleared');
      assert((await call('GET', '/api/agencies/current', auth(tT))).status === 401, 'S old REST token 401');
      await sleep(400);
      assert(ws.closeCode === 4401, `S socket closed 4401 (${ws.closeCode})`);
      const bad = await login(E('t'), PW);
      const unknown = await login(E('nobody'), PW);
      assert(bad.status === 401 && bad.text === unknown.text, `S login uniform failure (${bad.status})`);
      const fp2 = await call('POST', '/api/auth/forgot-password', ipH(), { email: E('t') });
      assert(fp2.status === 200 && !((await doc()).passwordResets || []).some((x) => x.email === E('t')), 'S forgot: uniform text, no request');
      const ua = await call('GET', '/api/users', auth(tA));
      const tv = (ua.json.users || []).find((u) => u.id === U('t'));
      assert(tv && tv.invitePending === true && tv.needsInvite === false && !ua.text.includes('credentialPending'), `S admin sees invitePending ${J(tv && { ip: tv.invitePending, ni: tv.needsInvite })}`);
      const uc = await call('GET', '/api/users', auth(await mintToken(baseUrl, U('coA'))));
      assert(!uc.text.includes('invitePending') && !uc.text.includes('needsInvite') && !uc.text.includes('credentialPending'), 'S non-admins see no status');
      // an admin row: login gives the uniform failure, never needsSetup
      const ra = await send(tA, U('ad2'));
      assert(ra.status === 201, `S admin target 201 (${ra.status})`);
      const la = await login(E('ad2'), PW);
      assert(la.status === 401 && !la.text.includes('needsSetup'), `S pending admin: uniform 401, no setup screen (${la.status} ${la.text.slice(0, 80)})`);
      console.log('  ✓ S password + sessions revoked (REST 401, WS 4401), marker set, resets cleared, login/forgot uniform (admin row too), admin-only status');
    }

    // ---- K: marker protection ----
    {
      const pr = await call('PUT', `/api/users/${U('t')}`, auth(tA), { name: 'T69 Target Renamed', credentialPending: null, expectedVersion: await ctx.getVersion() });
      assert(pr.status === 200, `K admin edit ${pr.status} ${pr.text.slice(0, 120)}`);
      const t = await rowOf(U('t'));
      assert(t.name === 'T69 Target Renamed' && t.credentialPending === 'invite' && t.password === undefined, `K marker survives, body cannot clear ${J({ n: t.name, p: t.credentialPending })}`);
      console.log('  ✓ K the marker survives an admin edit; a body cannot clear it');
    }

    // ---- A: re-send, revoke, accept ----
    {
      const r2 = await send(tA, U('t'));
      assert(r2.status === 201, `A re-send ${r2.status}`);
      const p1 = await call('GET', '/api/invites/preview', { ...ipH(), 'X-Invite-Token': tokenOf(link1) });
      assert(p1.status === 404, `A old link dead (${p1.status})`);
      assert((await rowOf(U('t'))).credentialPending === 'invite', 'A still pending after re-send');
      const del = await call('DELETE', `/api/agency/invites/${r2.json.invite.id}`, auth(tA), { expectedVersion: await ctx.getVersion() });
      assert(del.status === 200, `A revoke ${del.status}`);
      const tv = ((await call('GET', '/api/users', auth(tA))).json.users || []).find((u) => u.id === U('t'));
      assert(tv && tv.needsInvite === true && tv.invitePending === false, 'A revoked -> needsInvite');
      const r3 = await send(tA, U('t'));
      const tok = tokenOf(r3.json.link);
      const p = await call('GET', '/api/invites/preview', { ...ipH(), 'X-Invite-Token': tok });
      assert(p.status === 200 && p.json.kind === 'setup' && p.json.name === 'T69 Target Renamed', `A preview setup ${p.text.slice(0, 120)}`);
      const sh = await call('POST', '/api/invites/accept', ipH(), { token: tok, password: 'short' });
      assert(sh.status === 400, `A short password 400 (${sh.status})`);
      const ok = await call('POST', '/api/invites/accept', ipH(), { token: tok, password: 'target-own-password' });
      assert(ok.status === 200 && ok.json.success === true && ok.json.token, `A accept ${ok.status} ${ok.text.slice(0, 120)}`);
      const t = await rowOf(U('t'));
      assert(typeof t.password === 'string' && t.credentialOrigin === 'invite-new' && t.credentialPending === undefined, `A own password, invite-new, marker gone ${J({ o: t.credentialOrigin, p: t.credentialPending })}`);
      assert((await login(E('t'), 'target-own-password')).status === 200, 'A login with the new password');
      assert((await login(E('t'), PW)).status === 401, 'A the old password never works again');
      assert((await call('POST', '/api/invites/accept', ipH(), { token: tok, password: 'target-own-password' })).status === 404, 'A link dead after use');
      const again = await send(tA, U('t'));
      assert(again.status === 409, `A now invite-new -> Send invite refused (${again.status})`);
      console.log('  ✓ A re-send kills the old link; revoke -> needsInvite; accept sets the person\'s own password (invite-new), marker gone, link dead, no second Send invite');
    }

    // ---- F: fresh re-check ----
    {
      const users0 = await rows();
      assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('adA') ? { ...u, role: 'coordinator', venueId: A1 } : u)) })).status === 200, 'F plant');
      const v0 = await ctx.getVersion();
      const before = J(await rows());
      const r = await send(tA, U('f'));
      assert(r.status === 403, `F caller demoted in the stored doc -> 403 from the commit (${r.status} ${r.text.slice(0, 100)})`);
      await unchanged(v0, 'F');
      const f = await rowOf(U('f'));
      assert(typeof f.password === 'string' && f.credentialPending === undefined, 'F target untouched');
      assert((await hook('doc-set-users', { users: users0 })).status === 200, 'F restore');
      await rehydrate('f');
      console.log('  ✓ F fresh re-check: caller demoted after the cached check -> 403, nothing written');
    }
    await flag(A, false);
    await flag(B, false);
    return 'per-person Send invite with Phase C ON only; refused for self / primary admin / own-password / multi persons with nothing written; password + sessions revoked, resets cleared, login/forgot uniform; one-writer marker survives edits; re-send / revoke / setup accept (invite-new)';
  },
};
