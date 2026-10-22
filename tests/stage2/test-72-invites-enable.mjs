/**
 * Test 72 (invites always on, Don 2026-10-22, "Agreed — invites-always-on"):
 * every agency uses invites; there is no toggle and no agency-wide precheck.
 *  V  GET /api/agencies/current: an admin of an agency with NO stored phaseC sees
 *     invitesEnabled true; staff never see the key; phaseC never leaves the server.
 *  R  enable: coordinator / mashgiach / owner / kiosk -> 403, nothing written.
 *  F  enable by an admin demoted in the stored doc only (cache still admin) -> 403 (fresh re-check), nothing written.
 *  E  enable by an admin -> 200 { ok, invitesEnabled: true, alreadyOn: true } and
 *     writes NOTHING (version unchanged, stored doc byte-identical) — also with a
 *     body naming another agency and with a planted phaseC { enabled: false }.
 *  G  the invite routes answer for agencies with no / false / true stored phaseC.
 *  P1 invite create: a person whose identity group has issues AND touches the
 *     caller's agency -> 409 INVITE_PERSON_NEEDS_CHECK, nothing written; the same
 *     email from an agency the group does not touch -> 201 (other agencies' rows
 *     are not looked at, 10i V2/W1).
 *  P2 invite accept 'existing' for that person -> 409 INVITE_PERSON_NEEDS_CHECK,
 *     nothing written, not counted as a failed attempt.
 *  P3 Send invite on an unmigrated row (no personId) -> 409, nothing written.
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
  name: 'Test 72: invites always on (no toggle; enable is a no-write 200; per-person fail-closed)',
  whatItProves:
    'Every agency gets the invite routes whatever its stored phaseC; the retired enable route is admin-only and writes nothing; a person whose identity group has issues is refused per person (create in an agency the group touches, accept existing, Send invite on an unmigrated row) with a plain 409 and nothing written.',

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
        { id: U('adC'), email: E('adc'), name: 'T72 Admin C', role: 'admin', agencyId: C, avatarColor: 'bg-gold' },
        { id: U('co'), email: E('co'), name: 'T72 Coord', role: 'coordinator', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('m'), email: E('m'), name: 'T72 Mash', role: 'mashgiach', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('o'), email: E('o'), name: 'T72 Owner', role: 'owner', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
        { id: U('x1'), email: E('x'), name: 'T72 X in A', role: 'mashgiach', agencyId: A, venueId: vA, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tA = await mintToken(baseUrl, U('adA'));
    const tB = await mintToken(baseUrl, U('adB'));
    const tC = await mintToken(baseUrl, U('adC'));
    const doc = () => ctx.getDoc();
    const enable = (token, body = {}) => call(baseUrl, 'POST', '/api/agency/invites/enable', token, body);
    const unchanged = async (v0, label) => { const v = await ctx.getVersion(); if (v !== v0) throw new Error(`${label}: version moved ${v0} -> ${v}`); };
    const plantPhaseC = async (agencyId, enabled) => {
      const d = await doc();
      const r = await ctx.api('POST', '/api/__test__/doc-set-users', { users: d.users, agencies: d.agencies.map((a) => (a.id === agencyId ? { ...a, phaseC: { enabled } } : a)) });
      if (r.status !== 200) throw new Error(`plant phaseC ${agencyId}: ${r.status}`);
    };
    const addMember = async (t, email) => call(baseUrl, 'POST', '/api/users', t, { email, name: 'T72 Person', role: 'mashgiach', venueId: t === tA ? vA : (t === tB ? vB : vC), expectedVersion: await ctx.getVersion() });
    const details = [];

    // V: an agency with no stored phaseC is ON for its admin; staff never see the key.
    {
      const ga = await call(baseUrl, 'GET', '/api/agencies/current', tA);
      if (ga.status !== 200 || ga.json?.agency?.invitesEnabled !== true || 'phaseC' in (ga.json?.agency || {})) throw new Error(`V admin: ${ga.status} ${JSON.stringify(ga.json?.agency).slice(0, 200)}`);
      const gm = await call(baseUrl, 'GET', '/api/agencies/current', await mintToken(baseUrl, U('m')));
      if (gm.status !== 200 || 'invitesEnabled' in (gm.json?.agency || {}) || 'phaseC' in (gm.json?.agency || {})) throw new Error(`V staff: ${JSON.stringify(gm.json?.agency).slice(0, 200)}`);
      details.push('V invitesEnabled true for an admin with no stored phaseC; staff never see it');
    }

    // R: non-admins (and a kiosk token) are refused, nothing written.
    {
      const v0 = await ctx.getVersion();
      for (const k of ['co', 'm', 'o']) {
        const r = await enable(await mintToken(baseUrl, U(k)));
        if (r.status !== 403) throw new Error(`R ${k}: ${r.status}`);
      }
      const kt = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: U('adA'), agencyId: A, venueId: vA }) });
      if (kt.status !== 200) throw new Error(`R kiosk token mint: ${kt.status}`);
      const { token } = await kt.json();
      const rk = await enable(token);
      if (rk.status !== 403 && rk.status !== 401) throw new Error(`R kiosk token: ${rk.status}`);
      await unchanged(v0, 'R');
      details.push('R coordinator/mashgiach/owner/kiosk refused, nothing written');
    }

    // F ([IAO-RV1] B1): the fresh re-check — an admin demoted in the STORED doc
    // while the server cache still says admin -> 403, nothing written.
    {
      const stored = (await doc()).users;
      const demoted = stored.map((u) => (u.id === U('adC') ? { ...u, role: 'mashgiach', venueId: vC } : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: demoted })).status !== 200) throw new Error('F plant');
      const before = JSON.stringify(await doc());
      const v0 = await ctx.getVersion();
      const r = await enable(tC);
      if (r.status !== 403) throw new Error(`F demoted-in-store admin: ${r.status} ${JSON.stringify(r.json)}`);
      await unchanged(v0, 'F');
      if (JSON.stringify(await doc()) !== before) throw new Error('F: the stored doc changed');
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: stored })).status !== 200) throw new Error('F restore');
      details.push('F fresh re-check: an admin demoted in the store gets 403, nothing written');
    }

    // E: the retired enable route answers "already on" and writes nothing.
    {
      await plantPhaseC(B, false);
      for (const [label, t, body] of [['admin A', tA, {}], ['admin A naming B', tA, { agencyId: B }], ['admin B (planted false)', tB, {}]]) {
        const before = JSON.stringify(await doc());
        const v0 = await ctx.getVersion();
        const r = await enable(t, body);
        if (r.status !== 200 || r.json?.ok !== true || r.json?.invitesEnabled !== true || r.json?.alreadyOn !== true) throw new Error(`E ${label}: ${r.status} ${JSON.stringify(r.json)}`);
        await unchanged(v0, `E ${label}`);
        if (JSON.stringify(await doc()) !== before) throw new Error(`E ${label}: the stored doc changed`);
      }
      if ((await doc()).agencies.find((a) => a.id === A).phaseC !== undefined) throw new Error('E wrote phaseC on A');
      details.push('E enable 200 alreadyOn, no write (doc byte-identical), also naming B and with a planted false');
    }

    // G: the invite routes answer whatever the stored phaseC (A none, B false, C true).
    {
      await plantPhaseC(C, true);
      for (const [label, t] of [['A none', tA], ['B false', tB], ['C true', tC]]) {
        const r = await call(baseUrl, 'GET', '/api/agency/invites', t);
        if (r.status !== 200 || !Array.isArray(r.json?.invites)) throw new Error(`G ${label}: ${r.status}`);
      }
      details.push('G invite list 200 for no / false / true stored phaseC');
    }

    // P1/P2: one person (x) with rows in A (email x, the credential) and B
    // (same personId, ANOTHER email: email-mismatch) — an invalid identity group
    // that touches B but has no row with email x in B.
    const users0 = (await doc()).users;
    const x1 = users0.find((u) => u.id === U('x1'));
    if (!x1?.personId) throw new Error('fixture x1 has no personId');
    const PW = 'stage2-t72-x-password';
    if ((await ctx.api('POST', '/api/__test__/set-password', { userId: U('x1'), password: PW })).status !== 200) throw new Error('set-password x1');
    {
      const base = (await doc()).users;
      const x1p = base.find((u) => u.id === U('x1'));
      const planted = base.map((u) => (u.id === U('x1') ? { ...u, credentialOwner: true, credentialOrigin: 'self-registered' } : u));
      planted.push({ id: U('x2'), email: E('x-other'), personId: x1p.personId, name: 'T72 X in B', role: 'mashgiach', agencyId: B, venueId: vB, avatarColor: 'bg-gold' });
      const ps = await ctx.api('POST', '/api/__test__/doc-set-users', { users: planted });
      if (ps.status !== 200) throw new Error(`P plant: ${ps.status}`);
    }
    // A C invite for x made BEFORE anything else (C is not in the group: 201).
    const invC = await addMember(tC, E('x'));
    if (invC.status !== 201 || invC.json?.pending !== true) throw new Error(`P1 C (group does not touch C): ${invC.status} ${JSON.stringify(invC.json)}`);
    {
      for (const [label, t] of [['B', tB]]) {
        const v0 = await ctx.getVersion();
        const before = JSON.stringify((await doc()).invites || []);
        const r = await addMember(t, ` ${E('x').toUpperCase()}`);
        if (r.status !== 409 || r.json?.code !== 'INVITE_PERSON_NEEDS_CHECK' || r.json?.error !== "This person's account needs a check before they can be invited. Please contact Shutfey support.") throw new Error(`P1 ${label}: ${r.status} ${JSON.stringify(r.json)}`);
        if (JSON.stringify(r.json).includes(U('x2')) || JSON.stringify(r.json).includes(B)) throw new Error(`P1 ${label}: the answer leaks ids`);
        await unchanged(v0, `P1 ${label}`);
        if (JSON.stringify((await doc()).invites || []) !== before) throw new Error(`P1 ${label}: invites changed`);
      }
      details.push('P1 create: 409 INVITE_PERSON_NEEDS_CHECK where the group touches the agency (B, no row with that email there), nothing written; C (untouched) 201');
    }
    // P2 fixture: x stays a one-row person in A (the linkable credential); a
    // LEGACY row (no personId) with the same email sits in B. The email group
    // {x1, legacy} is invalid (person-mismatch), the credential still resolves.
    {
      const base = (await doc()).users.filter((u) => u.id !== U('x2'));
      base.push({ id: U('xl'), email: E('x'), name: 'T72 X legacy in B', role: 'mashgiach', agencyId: B, venueId: vB, avatarColor: 'bg-gold' });
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: base })).status !== 200) throw new Error('P2 plant');
      // one harmless commit so the server cache matches the planted store (the
      // P1 rows went into the cache with the C invite's commit)
      if ((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t72-sync-${ts}`, name: 'T72 sync', agencyId: C }] })).status !== 200) throw new Error('P2 rehydrate');
      if ((await doc()).users.some((u) => u.id === U('x2')) || !(await doc()).users.some((u) => u.id === U('xl'))) throw new Error('P2 plant did not hold');
    }
    {
      const raw = /#t=([A-Za-z0-9_-]+)/.exec(invC.json.link || '')?.[1];
      const v0 = await ctx.getVersion();
      const invBefore = JSON.stringify(((await doc()).invites || []).find((i) => i.id === invC.json.invite.id));
      const r = await fetch(`${baseUrl}/api/invites/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.72.${ts % 200}.9` }, body: JSON.stringify({ token: raw, mode: 'existing', password: PW }) });
      const j = await r.json().catch(() => null);
      if (r.status !== 409 || j?.code !== 'INVITE_PERSON_NEEDS_CHECK') throw new Error(`P2 accept existing: ${r.status} ${JSON.stringify(j)}`);
      await unchanged(v0, 'P2');
      if (JSON.stringify(((await doc()).invites || []).find((i) => i.id === invC.json.invite.id)) !== invBefore) throw new Error('P2: the invite changed (counted or consumed)');
      details.push('P2 accept existing: 409 INVITE_PERSON_NEEDS_CHECK, nothing written, not counted');
    }
    // repair the group
    if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: (await doc()).users.filter((u) => u.id !== U('x2') && u.id !== U('xl')) })).status !== 200) throw new Error('P repair');

    // P3: Send invite on an unmigrated row (no personId) -> 409, nothing written.
    {
      const base = (await doc()).users;
      const planted = base.map((u) => (u.id === U('m') ? (({ personId, ...rest }) => rest)(u) : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: planted })).status !== 200) throw new Error('P3 plant');
      const v0 = await ctx.getVersion();
      const r = await call(baseUrl, 'POST', `/api/users/${U('m')}/invite`, tA, { expectedVersion: v0 });
      if (r.status !== 409 || r.json?.code !== 'INVITE_NOT_AVAILABLE') throw new Error(`P3: ${r.status} ${JSON.stringify(r.json)}`);
      await unchanged(v0, 'P3');
      details.push('P3 Send invite on an unmigrated row 409, nothing written');
    }
    return details.join('; ');
  },
};
