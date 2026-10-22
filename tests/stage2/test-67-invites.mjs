/**
 * Test 67 (10h): invites — create / list / revoke (design v2, [10H-DS2]).
 *  A flag OFF: POST/GET/DELETE 404, nothing written.
 *  B flag ON: 201 + relative link '/invite#t=<43-char token>'; only sha256 stored;
 *    raw token and hash never in the doc text (raw), WS, GET, admin export; no-store.
 *  C same-agency email (case/space) 409 ALREADY_ON_TEAM, nothing written;
 *    another agency's member email -> 201 with the same keys.
 *  D re-invite replaces the old one (revoked/replaced); GET shows the new one.
 *  E validation 400s, nothing written.
 *  F coordinator / mashgiach / kiosk 403; agency B's admin never sees or revokes A's.
 *  G revoke 200 + idempotent (no version bump); an expired invite is not listed.
 *  H flag OFF again -> 404; records untouched.
 *  I (B1) stored-doc-only role/agency change -> 403, flag OFF -> 404, nothing written
 *    (the cached pre-check passed: proven by the 403/404 coming from the commit).
 *  J (N3) a venue moved away in the stored doc only -> 400, nothing written.
 *  K (N4) A and B invite the same email; A re-invites -> only A's old one replaced.
 */
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const raw = [];
    const conn = { ws, raw, close: () => { try { ws.close(); } catch {} } };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => { raw.push(String(ev.data)); if (raw.some((m) => m.includes('"INITIAL_STATE"'))) { clearTimeout(timer); resolve(conn); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

export default {
  name: 'Test 67: invites create / list / revoke (10h)',
  whatItProves:
    'Invite routes exist only for a Phase C agency (404 otherwise); an admin creates (hash-only, relative one-time link), lists and revokes invites of their own agency; same-team emails 409, other agencies\' emails look like any other; authority, flag and venues are re-checked on fresh data; tokens never leak to the doc, sockets, lists or exports.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t67a-${ts}`, B = `agency-t67b-${ts}`;
    const A1 = `venue-t67-a1-${ts}`, A2 = `venue-t67-a2-${ts}`, B1 = `venue-t67-b1-${ts}`;
    const U = (k) => `user-t67-${k}-${ts}`;
    const E = (k) => `t67-${k}-${ts}@test.local`;
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const doc = () => ctx.getDoc();
    const invitesOf = async () => ((await doc()).invites || []);
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t67-h${k}-${Date.now()}`, name: 'T67 hydrate', agencyId: B }] })).status === 200, `rehydrate ${k}`);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const create = async (t, body) => call('POST', '/api/agency/invites', auth(t), { ...body, expectedVersion: await ctx.getVersion() });
    const list = (t) => call('GET', '/api/agency/invites', auth(t));
    const revoke = async (t, id) => call('DELETE', `/api/agency/invites/${id}`, auth(t), { expectedVersion: await ctx.getVersion() });
    const flag = async (agencyId, enabled) => assert((await hook('phase-c', { agencyId, enabled })).status === 200, `phase-c ${agencyId} ${enabled}`);

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T67 A ${ts}`, timeZone: 'America/New_York' }, { id: B, name: `T67 B ${ts}`, timeZone: 'America/New_York' }],
      venues: [{ id: A1, name: `T67 A1 ${ts}`, agencyId: A }, { id: A2, name: `T67 A2 ${ts}`, agencyId: A }, { id: B1, name: `T67 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T67 Admin A', role: 'admin', agencyId: A },
        { id: U('adA2'), email: E('ada2'), name: 'T67 Admin A2', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T67 Admin B', role: 'admin', agencyId: B },
        { id: U('coA'), email: E('coa'), name: 'T67 Coord A', role: 'coordinator', agencyId: A, venueId: A1 },
        { id: U('maA'), email: E('maa'), name: 'T67 Mash A', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('mbB'), email: E('mbb'), name: 'T67 Mash B', role: 'mashgiach', agencyId: B, venueId: B1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tA = await mintToken(baseUrl, U('adA'));
    const tB = await mintToken(baseUrl, U('adB'));

    // ---- A: flag OFF -> 404 everywhere, nothing written ----
    {
      const v0 = await ctx.getVersion();
      const r1 = await create(tA, { email: E('new1'), role: 'mashgiach', venueIds: [A1] });
      const r2 = await list(tA);
      const r3 = await revoke(tA, 'inv_whatever');
      assert([r1, r2, r3].every((r) => r.status === 404), `A flag OFF 404: ${r1.status} ${r2.status} ${r3.status}`);
      assert(r1.text === r2.text && r2.text === r3.text, 'A one 404 body');
      await unchanged(v0, 'A flag OFF');
      console.log('  ✓ A flag OFF: POST/GET/DELETE 404, one body, nothing written');
    }

    await flag(A, true);
    await flag(B, true);
    assert(!J(await call('GET', '/api/agencies/current', auth(tA))).includes('phaseC'), 'phaseC never in an agency payload');

    // ---- B: create, hash-only, relative link, no leaks ----
    const ws = await connectWs(baseUrl, await mintToken(baseUrl, U('adA2')));
    let inv1, raw1;
    try {
      const r = await create(tA, { email: `  ${E('new1').toUpperCase()} `, role: 'mashgiach', venueIds: [A1, A2, A1] });
      assert(r.status === 201, `B create 201: ${r.status} ${r.text.slice(0, 160)}`);
      assert(/no-store/.test(r.headers.get('cache-control') || ''), 'B no-store');
      const m = /^\/invite#t=([A-Za-z0-9_-]{43})$/.exec(r.json.link || '');
      assert(m, `B relative link with a 43-char token: ${r.json.link}`);
      raw1 = m[1];
      inv1 = r.json.invite;
      assert(J(Object.keys(inv1).sort()) === J(['email', 'expiresAt', 'id', 'role', 'venueIds']) && inv1.email === E('new1') && J(inv1.venueIds) === J([A1, A2]), `B invite view ${J(inv1)}`);
      const exp = Date.parse(inv1.expiresAt) - Date.now();
      assert(exp > 6.9 * 864e5 && exp <= 7 * 864e5, `B 7-day expiry (${exp})`);
      const stored = (await invitesOf()).find((i) => i.id === inv1.id);
      assert(stored && stored.inviteTokenHash === sha(raw1) && stored.status === 'pending' && stored.agencyId === A && stored.invitedBy === U('adA'), `B stored ${J(stored && { s: stored.status })}`);
      const docText = J(await doc());
      assert(!docText.includes(raw1), 'B the raw token is nowhere in the stored doc');
      const g = await list(tA);
      assert(g.status === 200 && g.json.invites.length === 1 && g.json.invites[0].id === inv1.id && !g.text.includes(stored.inviteTokenHash) && !g.text.includes('inviteTokenHash') && !g.text.includes(raw1), `B GET lists it without the hash ${g.text.slice(0, 200)}`);
      assert(/no-store/.test(g.headers.get('cache-control') || ''), 'B GET no-store');
      const ex = await call('GET', '/api/admin/export', auth(tA));
      assert(ex.status === 200 && !ex.text.includes(stored.inviteTokenHash) && !ex.text.includes(raw1) && !ex.text.includes('inviteTokenHash'), `B admin export carries no invite secrets (${ex.status})`);
      await sleep(600);
      const wsText = ws.raw.join('\n');
      assert(!wsText.includes(raw1) && !wsText.includes(stored.inviteTokenHash) && !wsText.includes('inviteTokenHash'), 'B no token or hash on the admin socket');
      // reconnect: INITIAL_STATE carries no invites either
      const ws2 = await connectWs(baseUrl, tA);
      assert(!ws2.raw.join('\n').includes(stored.inviteTokenHash) && !ws2.raw.join('\n').includes('"invites"'), 'B INITIAL_STATE has no invites');
      ws2.close();
      console.log('  ✓ B 201 with a relative one-time link; sha256 only; no raw/hash in doc text, GET, export or sockets; no-store');
    } finally { ws.close(); }

    // ---- C: same team 409; another agency's member looks like anyone ----
    {
      const v0 = await ctx.getVersion();
      for (const e of [E('maa'), `  ${E('maa').toUpperCase()}`]) {
        const r = await create(tA, { email: e, role: 'mashgiach', venueIds: [A1] });
        assert(r.status === 409 && r.json?.code === 'ALREADY_ON_TEAM' && !r.text.includes('#t='), `C same team 409 (${e}): ${r.status}`);
      }
      await unchanged(v0, 'C same team');
      const other = await create(tA, { email: E('mbb'), role: 'mashgiach', venueIds: [A1] });
      const fresh = await create(tA, { email: E('nobody'), role: 'mashgiach', venueIds: [A1] });
      assert(other.status === 201 && fresh.status === 201, `C other-agency / unknown emails 201: ${other.status} ${fresh.status}`);
      const shape = (r) => J({ k: Object.keys(r.json).sort(), i: Object.keys(r.json.invite).sort(), l: r.json.link.replace(/#t=.*/, '') });
      assert(shape(other) === shape(fresh), 'C same response shape for an email in another agency and a fresh one');
      console.log('  ✓ C same-agency email 409 (case/space), nothing written; another agency\'s member gets the same answer as a stranger');
    }

    // ---- D: re-invite replaces ----
    {
      const r = await create(tA, { email: E('new1'), role: 'coordinator', venueIds: [A2] });
      assert(r.status === 201, `D re-invite ${r.status}`);
      const old = (await invitesOf()).find((i) => i.id === inv1.id);
      assert(old.status === 'revoked' && old.revokeReason === 'replaced' && old.revokedBy === U('adA'), `D old replaced ${J({ s: old.status, r: old.revokeReason })}`);
      const g = await list(tA);
      const mine = g.json.invites.filter((i) => i.email === E('new1'));
      assert(mine.length === 1 && mine[0].id === r.json.invite.id && mine[0].role === 'coordinator', `D GET shows only the new one ${J(mine)}`);
      inv1 = r.json.invite;
      console.log('  ✓ D a re-invite revokes the old one (replaced); GET lists only the new one');
    }

    // ---- E: validation ----
    {
      const v0 = await ctx.getVersion();
      const bad = [
        [{ email: 'not-an-email', role: 'mashgiach', venueIds: [A1] }, 'INVITE_EMAIL_INVALID'],
        [{ email: E('e1'), role: 'owner', venueIds: [A1] }, 'INVITE_ROLE_INVALID'],
        [{ email: E('e1'), role: 'worker', venueIds: [A1] }, 'INVITE_ROLE_INVALID'],
        [{ email: E('e1'), role: 'superuser', venueIds: [A1] }, 'INVITE_ROLE_INVALID'],
        [{ email: E('e1'), role: 'admin', venueIds: [A1] }, 'INVITE_VENUES_INVALID'],
        [{ email: E('e1'), role: 'coordinator' }, 'INVITE_VENUES_INVALID'],
        [{ email: E('e1'), role: 'mashgiach', venueIds: [B1] }, 'INVITE_VENUES_INVALID'],
        [{ email: E('e1'), role: 'mashgiach', venueIds: ['venue-nope'] }, 'INVITE_VENUES_INVALID'],
        [{ email: E('e1'), role: 'mashgiach', venueIds: Array.from({ length: 51 }, () => A1) }, 'INVITE_VENUES_INVALID'],
      ];
      for (const [body, code] of bad) {
        const r = await create(tA, body);
        assert(r.status === 400 && r.json?.code === code, `E ${J(body).slice(0, 60)} -> ${r.status} ${r.json?.code}`);
      }
      const otherVenue = await create(tA, { email: E('e1'), role: 'mashgiach', venueIds: [B1] });
      const noVenue = await create(tA, { email: E('e1'), role: 'mashgiach', venueIds: ['venue-nope'] });
      assert(otherVenue.text === noVenue.text, 'E another agency\'s venue = unknown venue (same body)');
      await unchanged(v0, 'E validation');
      const adm = await create(tA, { email: E('admin-new'), role: 'admin' });
      assert(adm.status === 201 && J(adm.json.invite.venueIds) === '[]', `E admin invite with no venues 201 (${adm.status})`);
      console.log('  ✓ E bad email / role / venues 400 (another agency\'s venue = unknown), nothing written; admin invite needs no venue');
    }

    // ---- F: who may ----
    {
      const v0 = await ctx.getVersion();
      for (const who of ['coA', 'maA']) {
        const t = await mintToken(baseUrl, U(who));
        const rs = [await create(t, { email: E('f1'), role: 'mashgiach', venueIds: [A1] }), await list(t), await revoke(t, inv1.id)];
        assert(rs.every((r) => r.status === 403), `F ${who} 403: ${rs.map((r) => r.status)}`);
      }
      const kt = (await hook('mint-kiosk-token', { userId: U('adA'), agencyId: A, venueId: A1 })).json?.token;
      if (kt) {
        const rs = [await create(kt, { email: E('f1'), role: 'mashgiach', venueIds: [A1] }), await list(kt), await revoke(kt, inv1.id)];
        assert(rs.every((r) => r.status === 403 || r.status === 401), `F kiosk refused: ${rs.map((r) => r.status)}`);
      }
      const gB = await list(tB);
      assert(gB.status === 200 && !gB.text.includes(inv1.id) && !gB.text.includes(E('new1')), 'F B does not see A\'s invites');
      const dB = await revoke(tB, inv1.id);
      assert(dB.status === 404, `F B revoking A's invite 404 (${dB.status})`);
      await unchanged(v0, 'F refusals');
      assert((await invitesOf()).find((i) => i.id === inv1.id).status === 'pending', 'F A\'s invite untouched');
      console.log(`  ✓ F coordinator / mashgiach 403${kt ? ' / kiosk refused' : ''}; B never sees or revokes A's invite`);
    }

    // ---- G: revoke, idempotent, expired not listed ----
    {
      let r = await revoke(tA, inv1.id);
      assert(r.status === 200 && r.json?.success === true, `G revoke ${r.status}`);
      assert(!(await list(tA)).json.invites.some((i) => i.id === inv1.id), 'G revoked not listed');
      const v0 = await ctx.getVersion();
      r = await revoke(tA, inv1.id);
      assert(r.status === 200 && r.json?.success === true, `G revoke again ${r.status}`);
      await unchanged(v0, 'G idempotent revoke');
      // expire one (stored doc + rehydrate)
      const c = await create(tA, { email: E('expire'), role: 'mashgiach', venueIds: [A1] });
      assert(c.status === 201, 'G create to expire');
      const past = new Date(Date.now() - 1000).toISOString();
      const invs = (await invitesOf()).map((i) => (i.id === c.json.invite.id ? { ...i, expiresAt: past } : i));
      assert((await hook('doc-set-users', { users: (await doc()).users, invites: invs })).status === 200, 'G backdate');
      await rehydrate('g');
      assert(!(await list(tA)).json.invites.some((i) => i.id === c.json.invite.id), 'G expired not listed');
      const v1 = await ctx.getVersion();
      r = await revoke(tA, c.json.invite.id);
      assert(r.status === 200, `G revoke expired 200 (${r.status})`);
      await unchanged(v1, 'G revoke expired');
      console.log('  ✓ G revoke 200, again 200 with no write; an expired invite is not listed and revoking it writes nothing');
    }

    // ---- I (B1): fresh authority ----
    {
      const users0 = (await doc()).users;
      const agencies0 = (await doc()).agencies;
      const live = await create(tA, { email: E('i-live'), role: 'mashgiach', venueIds: [A1] });
      assert(live.status === 201, 'I setup');
      // cached pre-check passes (cache says admin of A, flag ON); the stored doc says otherwise
      const cases = [
        ['coordinator', users0.map((u) => (u.id === U('adA') ? { ...u, role: 'coordinator', venueId: A1 } : u)), undefined, 403],
        ['moved to B', users0.map((u) => (u.id === U('adA') ? { ...u, agencyId: B } : u)), undefined, 403],
        ['flag OFF', users0, agencies0.map((a) => (a.id === A ? { ...a, phaseC: { enabled: false } } : a)), 404],
      ];
      for (const [label, users, agencies, want] of cases) {
        assert((await list(tA)).status === 200, `I ${label}: the cached gate still passes`);
        assert((await hook('doc-set-users', { users, ...(agencies ? { agencies } : {}) })).status === 200, `I plant ${label}`);
        const v0 = await ctx.getVersion();
        const before = J(await invitesOf());
        const c = await create(tA, { email: E('i-new'), role: 'mashgiach', venueIds: [A1] });
        const d = await revoke(tA, live.json.invite.id);
        assert(c.status === want && d.status === want, `I ${label}: POST ${c.status} DELETE ${d.status} (want ${want})`);
        assert(!c.text.includes('#t='), `I ${label}: no link`);
        await unchanged(v0, `I ${label}`);
        assert(J(await invitesOf()) === before, `I ${label}: invites unchanged`);
        assert((await hook('doc-set-users', { users: users0, agencies: agencies0 })).status === 200, `I restore ${label}`);
      }
      await rehydrate('i');
      console.log('  ✓ I (B1) role lost / moved agency -> 403, flag OFF -> 404 from the commit (cached gate passed); nothing written');

      // ---- J (N3): venue moved away between validation and commit ----
      const venues0 = (await doc()).venues;
      assert((await hook('doc-set-users', { users: users0, venues: venues0.map((v) => (v.id === A2 ? { ...v, agencyId: B } : v)) })).status === 200, 'J plant');
      const v0 = await ctx.getVersion();
      const j = await create(tA, { email: E('j-new'), role: 'mashgiach', venueIds: [A2] });
      assert(j.status === 400 && j.json?.code === 'INVITE_VENUES_INVALID', `J moved venue 400: ${j.status} ${j.text.slice(0, 120)}`);
      await unchanged(v0, 'J');
      assert((await hook('doc-set-users', { users: users0, venues: venues0 })).status === 200, 'J restore');
      await rehydrate('j');
      console.log('  ✓ J (N3) a venue moved to another agency after the cached check -> 400 from the commit, nothing written');
    }

    // ---- K (N4): same email in A and B ----
    {
      const e = E('both');
      const a1 = await create(tA, { email: e, role: 'mashgiach', venueIds: [A1] });
      const b1 = await create(tB, { email: e, role: 'mashgiach', venueIds: [B1] });
      assert(a1.status === 201 && b1.status === 201, 'K setup');
      const a2 = await create(tA, { email: e, role: 'coordinator', venueIds: [A1] });
      assert(a2.status === 201, 'K A re-invite');
      const all = await invitesOf();
      assert(all.find((i) => i.id === a1.json.invite.id).status === 'revoked' && all.find((i) => i.id === b1.json.invite.id).status === 'pending', 'K only A\'s old invite replaced');
      console.log('  ✓ K (N4) replacement is per agency: B\'s invite for the same email stays live');
    }

    // ---- H: flag OFF again ----
    {
      const before = J(await invitesOf());
      await flag(A, false);
      const v0 = await ctx.getVersion();
      const rs = [await create(tA, { email: E('h1'), role: 'mashgiach', venueIds: [A1] }), await list(tA), await revoke(tA, inv1.id)];
      assert(rs.every((r) => r.status === 404), `H flag OFF again 404: ${rs.map((r) => r.status)}`);
      await unchanged(v0, 'H');
      assert(J(await invitesOf()) === before, 'H records untouched');
      await flag(B, false);
      console.log('  ✓ H flag OFF again: 404, records untouched');
    }
    return 'Phase C agency only (404 otherwise); create (hash-only, relative one-time link, no-store), list, revoke (idempotent); same team 409; other agencies indistinguishable; fresh authority/flag/venue re-checks; per-agency replacement; no token or hash in doc text, GET, export or sockets';
  },
};
