/**
 * Test 72 (10j, [10J-DS2] Agreed): an agency's own admin turns invites (Phase C) ON for their own agency.
 *  R  coordinator / mashgiach / owner / kiosk tokens -> 403, nothing written.
 *  S  admin of A with a body naming B: only A turns ON; B stays OFF; setBy = the admin id.
 *  P1 a planted invalid identity group (same person, two credential owners, two agencies) -> 409 INVITES_PRECHECK_FAILED, nothing written.
 *  P2 an unmigrated row (no personId) in A -> 409; an unmigrated row only in another agency does not block A.
 *  C  client not ready (test override) -> 409 INVITES_CLIENT_NOT_READY, nothing written.
 *  I  a second call -> 200 alreadyOn, doc version unchanged.
 *  V  GET /api/agencies/current: admin sees invitesEnabled false -> true; staff never see it; no socket message carries invitesEnabled or phaseC.
 *  G  after ON the flag-gated invite list answers for A (200) and stays 404 for B.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
async function call(baseUrl, method, path, token, body, extra = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...(token ? auth(token) : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function openWs(baseUrl, token) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const conn = { ws, raw: [] };
  ws.onmessage = (ev) => { conn.raw.push(String(ev.data)); };
  ws.onerror = () => {};
  conn.close = () => { try { ws.close(); } catch {} };
  return conn;
}

export default {
  name: 'Test 72: 10j an agency admin turns invites ON for their own agency (one-way, prechecked)',
  whatItProves:
    'Only a fresh admin of the agency can turn invites on, only for their own agency; the identity precheck (invalid group anywhere, unmigrated row in the agency) and the client-readiness check refuse with nothing written; a repeat is a no-op; invitesEnabled reaches the admin over HTTP only, never a socket.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t72a-${ts}`, B = `agency-t72b-${ts}`, C = `agency-t72c-${ts}`;
    const vA = `venue-t72a-${ts}`, vB = `venue-t72b-${ts}`, vC = `venue-t72c-${ts}`;
    const U = (k) => `user-t72-${k}-${ts}`;
    const E = (k) => `t72-${k}-${ts}@test.local`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: 'T72 A', timeZone: 'America/New_York' }, { id: B, name: 'T72 B', timeZone: 'America/New_York' }, { id: C, name: 'T72 C', timeZone: 'America/New_York' }],
      venues: [{ id: vA, name: `T72 A ${ts}`, agencyId: A }, { id: vB, name: `T72 B ${ts}`, agencyId: B }, { id: vC, name: `T72 C ${ts}`, agencyId: C }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T72 Admin A', role: 'admin', agencyId: A, avatarColor: 'bg-gold' },
        { id: U('adB'), email: E('adb'), name: 'T72 Admin B', role: 'admin', agencyId: B, avatarColor: 'bg-gold' },
        { id: U('co'), email: E('co'), name: 'T72 Coord', role: 'coordinator', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('m'), email: E('m'), name: 'T72 Mash', role: 'mashgiach', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('o'), email: E('o'), name: 'T72 Owner', role: 'owner', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('x1'), email: E('x'), name: 'T72 X in A', role: 'mashgiach', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('c1'), email: E('c1'), name: 'T72 C member', role: 'mashgiach', agencyId: C, venueId: vC, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tA = await mintToken(baseUrl, U('adA'));
    const doc = () => ctx.getDoc();
    const agencyOf = async (id) => (await doc()).agencies.find((a) => a.id === id);
    const enable = (token, body = {}) => call(baseUrl, 'POST', '/api/agency/invites/enable', token, body);
    const unchanged = async (v0, label) => { const v = await ctx.getVersion(); if (v !== v0) throw new Error(`${label}: version moved ${v0} -> ${v}`); };
    const details = [];

    // V (before): admin sees false, staff never see the key.
    {
      const ga = await call(baseUrl, 'GET', '/api/agencies/current', tA);
      if (ga.status !== 200 || ga.json?.agency?.invitesEnabled !== false || 'phaseC' in (ga.json?.agency || {})) throw new Error(`V admin before: ${ga.status} ${JSON.stringify(ga.json?.agency).slice(0, 200)}`);
      const gm = await call(baseUrl, 'GET', '/api/agencies/current', await mintToken(baseUrl, U('m')));
      if (gm.status !== 200 || 'invitesEnabled' in (gm.json?.agency || {}) || 'phaseC' in (gm.json?.agency || {})) throw new Error(`V staff: ${JSON.stringify(gm.json?.agency).slice(0, 200)}`);
    }

    // R: non-admins (and a kiosk token) are refused, nothing written.
    {
      const v0 = await ctx.getVersion();
      for (const k of ['co', 'm', 'o']) {
        const r = await enable(await mintToken(baseUrl, U(k)));
        if (r.status !== 403) throw new Error(`R ${k}: ${r.status}`);
      }
      const kt = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: U('adA'), agencyId: A, venueId: vA }) });
      if (kt.status === 200) {
        const { token } = await kt.json();
        const r = await enable(token);
        if (r.status !== 403 && r.status !== 401) throw new Error(`R kiosk token: ${r.status}`);
      }
      await unchanged(v0, 'R');
      if ((await agencyOf(A)).phaseC) throw new Error('R wrote phaseC');
      details.push('R coordinator/mashgiach/owner/kiosk refused, nothing written');
    }

    // C: client not ready.
    {
      const set = await call(baseUrl, 'POST', '/api/__test__/invites-client-ready', null, { ready: false });
      if (set.status !== 200) throw new Error(`C override: ${set.status}`);
      try {
        const v0 = await ctx.getVersion();
        const r = await enable(tA);
        if (r.status !== 409 || r.json?.code !== 'INVITES_CLIENT_NOT_READY') throw new Error(`C: ${r.status} ${JSON.stringify(r.json)}`);
        await unchanged(v0, 'C');
      } finally {
        await call(baseUrl, 'POST', '/api/__test__/invites-client-ready', null, { ready: null });
      }
      details.push('C client not ready 409, nothing written');
    }

    // P1: an invalid identity group (one person, two credential owners) anywhere in the store.
    const users0 = (await doc()).users;
    const x1 = users0.find((u) => u.id === U('x1'));
    if (!x1?.personId) throw new Error('fixture x1 has no personId');
    {
      const planted = users0.map((u) => (u.id === U('x1') ? { ...u, credentialOwner: true } : u));
      planted.push({ ...x1, id: U('x2'), agencyId: B, venueId: vB, name: 'T72 X in B', credentialOwner: true });
      const ps = await ctx.api('POST', '/api/__test__/doc-set-users', { users: planted });
      if (ps.status !== 200) throw new Error(`P1 plant: ${ps.status}`);
      const v0 = await ctx.getVersion();
      const r = await enable(tA);
      if (r.status !== 409 || r.json?.code !== 'INVITES_PRECHECK_FAILED') throw new Error(`P1: ${r.status} ${JSON.stringify(r.json)}`);
      if (JSON.stringify(r.json).includes(U('x2'))) throw new Error('P1 answer leaks row ids');
      await unchanged(v0, 'P1');
      // repair: back to the original rows
      const rs = await ctx.api('POST', '/api/__test__/doc-set-users', { users: users0 });
      if (rs.status !== 200) throw new Error(`P1 repair: ${rs.status}`);
      details.push('P1 invalid identity group 409, nothing written');
    }

    // P2: an unmigrated row in A blocks A; one only in C does not.
    {
      const planted = users0.map((u) => (u.id === U('m') ? (({ personId, ...rest }) => rest)(u) : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: planted })).status !== 200) throw new Error('P2 plant');
      const v0 = await ctx.getVersion();
      const r = await enable(tA);
      if (r.status !== 409 || r.json?.code !== 'INVITES_PRECHECK_FAILED') throw new Error(`P2 unmigrated in A: ${r.status} ${JSON.stringify(r.json)}`);
      await unchanged(v0, 'P2');
      const plantedC = users0.map((u) => (u.id === U('c1') ? (({ personId, ...rest }) => rest)(u) : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: plantedC })).status !== 200) throw new Error('P2 plant C');
      details.push('P2 unmigrated row in A 409');
    }

    // S + V(after) + sockets: admin of A naming B -> only A ON.
    const wsAdmin = openWs(baseUrl, tA);
    const wsStaff = openWs(baseUrl, await mintToken(baseUrl, U('m')));
    await sleep(500);
    {
      const r = await enable(tA, { agencyId: B });
      if (r.status !== 200 || r.json?.invitesEnabled !== true || r.json?.alreadyOn !== false) throw new Error(`S: ${r.status} ${JSON.stringify(r.json)}`);
      const a = await agencyOf(A);
      const b = await agencyOf(B);
      if (a?.phaseC?.enabled !== true || a.phaseC.setBy !== U('adA') || typeof a.phaseC.setAt !== 'string') throw new Error(`S A: ${JSON.stringify(a?.phaseC)}`);
      if (b?.phaseC) throw new Error(`S B changed: ${JSON.stringify(b.phaseC)}`);
      details.push('S only the caller\'s agency turns ON (unmigrated row in another agency does not block)');
    }
    {
      const v0 = await ctx.getVersion();
      const r = await enable(tA);
      if (r.status !== 200 || r.json?.alreadyOn !== true) throw new Error(`I: ${r.status} ${JSON.stringify(r.json)}`);
      await unchanged(v0, 'I');
      const rCo = await enable(await mintToken(baseUrl, U('co')));
      if (rCo.status !== 403) throw new Error(`I coordinator on an ON agency: ${rCo.status}`);
      details.push('I repeat alreadyOn, no write; non-admin still 403');
    }
    {
      const ga = await call(baseUrl, 'GET', '/api/agencies/current', tA);
      if (ga.json?.agency?.invitesEnabled !== true || 'phaseC' in (ga.json?.agency || {})) throw new Error(`V admin after: ${JSON.stringify(ga.json?.agency).slice(0, 200)}`);
      const gb = await call(baseUrl, 'GET', '/api/agencies/current', await mintToken(baseUrl, U('adB')));
      if (gb.json?.agency?.invitesEnabled !== false) throw new Error(`V admin B: ${gb.json?.agency?.invitesEnabled}`);
      await sleep(700);
      for (const [label, c] of [['admin', wsAdmin], ['staff', wsStaff]]) {
        if (!c.raw.length) throw new Error(`V ${label} socket got nothing`);
        if (c.raw.some((m) => m.includes('invitesEnabled') || m.includes('"phaseC"'))) throw new Error(`V ${label} socket carried invitesEnabled/phaseC`);
      }
      details.push('V invitesEnabled HTTP admin only; no socket carries it');
    }
    wsAdmin.close(); wsStaff.close();

    // G: the flag-gated invite list answers for A only.
    {
      const la = await call(baseUrl, 'GET', '/api/agency/invites', tA);
      if (la.status !== 200) throw new Error(`G A invites list: ${la.status}`);
      const lb = await call(baseUrl, 'GET', '/api/agency/invites', await mintToken(baseUrl, U('adB')));
      if (lb.status !== 404) throw new Error(`G B invites list: ${lb.status}`);
      details.push('G invites list A 200, B 404');
    }
    // restore C's row (other tests do not read it, but keep the store clean)
    await ctx.api('POST', '/api/__test__/doc-set-users', { users: (await doc()).users.map((u) => (u.id === U('c1') ? { ...u, personId: users0.find((x) => x.id === U('c1')).personId } : u)) });
    return details.join('; ');
  },
};
