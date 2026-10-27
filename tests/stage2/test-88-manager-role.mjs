/**
 * Test 88 (MANAGER, Don 2026-10-27 "same style as the owner"): the new role
 * 'manager'. A manager is scoped exactly like a venue owner (own home venue
 * only) and may do what an owner does there, but never touches the owner:
 *  A  an agency ADMIN adds a manager (POST /api/users invite -> accepted row
 *     role 'manager'); /api/agency/invites takes 'manager' with exactly ONE
 *     venue (two venues: 400); an unknown role still maps to mashgiach / 400.
 *  B  the venue OWNER adds a manager for their OWN venue (pending invite,
 *     role-default rights, accepted row role 'manager'); another venue, the
 *     Pool, role owner/admin/coordinator/mashgiach: 403; an email with a
 *     pending invite: 409 INVITE_PENDING and that invite is left alone.
 *  C  the OWNER changes ONLY the role of a person at their own venue
 *     (mashgiach -> manager -> mashgiach); never another venue's person, an
 *     owner, a coordinator, never to 'owner', never with other fields.
 *  D  a MANAGER can never add a manager or owner, never change / remove /
 *     reset / move the owner (and nobody else's role either).
 *  E  scope: a manager at venue A1 sees only A1's events (not A2, not agency
 *     B) and may copy an event at A1 only.
 *  F  another agency's admin / owner cannot add or make a manager here.
 */
const A = 'agency-test88-a';
const B = 'agency-test88-b';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = JSON.stringify;

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

export default {
  name: 'Test 88: MANAGER role — owner-style, own venue only, never touches the owner',
  whatItProves:
    'Role manager is stored and kept; admin and the venue owner can add one (owner: own venue only); the owner can make a person at their venue a manager; a manager sees only their own venue and can never add managers/owners or change, remove or reset the owner; other agencies are refused.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t88-a1-${ts}`, vA2 = `venue-t88-a2-${ts}`, vB1 = `venue-t88-b1-${ts}`;
    const id = (k) => `user-t88-${k}-${ts}`;
    const em = (k) => `t88-${k}-${ts}@test.local`;
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T88 Admin A', role: 'admin', agencyId: A },
      { id: id('ownera'), email: em('ownera'), name: 'T88 Owner A1', role: 'owner', agencyId: A, venueId: vA1, permissions: { canFillTasks: false, canAssignTasks: false } },
      { id: id('ownera2'), email: em('ownera2'), name: 'T88 Owner A2', role: 'owner', agencyId: A, venueId: vA2 },
      { id: id('mgra'), email: em('mgra'), name: 'T88 Manager A1', role: 'manager', agencyId: A, venueId: vA1, permissions: { canFillTasks: false, canAssignTasks: false } },
      { id: id('mgra2'), email: em('mgra2'), name: 'T88 Manager A2', role: 'manager', agencyId: A, venueId: vA2 },
      { id: id('masha'), email: em('masha'), name: 'T88 Mash A1', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('worka'), email: em('worka'), name: 'T88 Worker A1', role: 'worker', agencyId: A, venueId: vA1 },
      { id: id('masha2'), email: em('masha2'), name: 'T88 Mash A2', role: 'mashgiach', agencyId: A, venueId: vA2 },
      { id: id('coorda'), email: em('coorda'), name: 'T88 Coord A1', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('adminb'), email: em('adminb'), name: 'T88 Admin B', role: 'admin', agencyId: B },
      { id: id('ownerb'), email: em('ownerb'), name: 'T88 Owner B1', role: 'owner', agencyId: B, venueId: vB1 },
    ];
    const ev = (k, agencyId, venueId) => ({ id: `ev-t88-${k}-${ts}`, agencyId, venueId, title: `T88 ${k} ${ts}`, location: 'Hall', date: '2026-10-01', mashgiachType: 'unassigned', status: 'confirmed', tasks: [] });
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T88 A ${ts}` }, { id: B, name: `T88 B ${ts}` }],
      venues: [
        { id: vA1, name: `T88 A1 ${ts}`, agencyId: A },
        { id: vA2, name: `T88 A2 ${ts}`, agencyId: A },
        { id: vB1, name: `T88 B1 ${ts}`, agencyId: B },
      ],
      users: people,
      events: [ev('a1', A, vA1), ev('a2', A, vA2), ev('b1', B, vB1)],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);
    const tok = {};
    for (const k of ['admina', 'ownera', 'ownera2', 'mgra', 'masha', 'adminb', 'ownerb']) tok[k] = auth(await mintToken(baseUrl, id(k)));

    const call = async (who, method, path, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers: tok[who] || who, body: body !== undefined ? J(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const doc = () => ctx.getDoc();
    const row = async (uid) => ((await doc()).users || []).find((u) => u && u.id === uid);
    const rowJ = async (uid) => J(await row(uid));
    const invitesFor = async (email) => ((await doc()).invites || []).filter((i) => i && i.email === email);
    const putRole = async (who, uid, body) => call(who, 'PUT', `/api/users/${uid}`, { ...body, expectedVersion: await ctx.getVersion(), operationId: `op88-${Math.random().toString(36).slice(2, 10)}` });
    const futureDate = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    const copy = (who, eventId) => call(who, 'POST', `/api/events/${eventId}/copy`, { date: futureDate, operationId: `op88c-${Math.random().toString(36).slice(2, 10)}` });
    const eventIds = (r) => (Array.isArray(r.json) ? r.json : (r.json?.events || [])).map((e) => e.id);

    // ---- A: admin adds a manager ----
    {
      const r = await ctx.addMember({ email: em('newmgr1'), name: 'T88 New Manager', role: 'manager', venueId: vA1, password: 'Stage2-t88-pass!' }, tok.admina);
      assert(r.status === 201, `A1 admin adds manager: ${r.status} ${J(r.json)}`);
      const u = ((await doc()).users || []).find((x) => x && x.email === em('newmgr1'));
      assert(u && u.role === 'manager' && u.venueId === vA1 && u.agencyId === A, `A1 stored row: ${J(u)}`);
      // the accepted manager signs in and keeps role 'manager' (normalizeStoredUser keeps it)
      const t = auth(await mintToken(baseUrl, u.id));
      const me = await call(t, 'GET', '/api/events');
      assert(me.status === 200, `A1 manager GET /api/events: ${me.status}`);
      const ids = eventIds(me);
      assert(ids.includes(`ev-t88-a1-${ts}`) && !ids.includes(`ev-t88-a2-${ts}`) && !ids.includes(`ev-t88-b1-${ts}`), `A1 new manager event scope: ${J(ids)}`);

      const two = await call('admina', 'POST', '/api/agency/invites', { email: em('twovenues'), name: 'Two', role: 'manager', venueIds: [vA1, vA2], expectedVersion: await ctx.getVersion() });
      assert(two.status === 400 && two.json?.code === 'INVITE_VENUES_INVALID', `A2 manager with two venues: ${two.status} ${two.text}`);
      assert((await invitesFor(em('twovenues'))).length === 0, 'A2 nothing stored');
      const one = await call('admina', 'POST', '/api/agency/invites', { email: em('onevenue'), name: 'One', role: 'manager', venueIds: [vA2], expectedVersion: await ctx.getVersion() });
      assert(one.status === 201 && one.json?.invite?.role === 'manager', `A3 manager with one venue: ${one.status} ${one.text}`);

      const unk = await call('admina', 'POST', '/api/agency/invites', { email: em('unk1'), name: 'Unk', role: 'supervisor', venueIds: [vA1], expectedVersion: await ctx.getVersion() });
      assert(unk.status === 400 && unk.json?.code === 'INVITE_ROLE_INVALID', `A4 unknown role invite: ${unk.status} ${unk.text}`);
      const unk2 = await call('admina', 'POST', '/api/users', { email: em('unk2'), name: 'Unk2', role: 'supervisor', venueId: vA1 });
      assert(unk2.status === 201 && unk2.json?.invite?.role === 'mashgiach', `A5 unknown role on POST /api/users maps to mashgiach: ${unk2.status} ${unk2.text}`);
    }

    // ---- B: the owner adds a manager for their own venue ----
    {
      const r = await call('ownera', 'POST', '/api/users', { email: em('ownmgr'), name: 'T88 Owner-added Manager', role: 'manager', permissions: { canFillTasks: true, canAssignTasks: true } });
      assert(r.status === 201 && r.json?.pending === true, `B1 owner adds manager: ${r.status} ${r.text}`);
      const inv = (await invitesFor(em('ownmgr')))[0];
      assert(inv && inv.role === 'manager' && J(inv.venueIds) === J([vA1]) && inv.invitedBy === id('ownera') && inv.agencyId === A && inv.status === 'pending',
        `B1 stored invite: ${J(inv && { role: inv.role, venueIds: inv.venueIds, invitedBy: inv.invitedBy, status: inv.status })}`);
      assert(inv.permissions && inv.permissions.canFillTasks === false && inv.permissions.canAssignTasks === false, `B1 owner cannot grant rights through the body: ${J(inv.permissions)}`);
      assert(!J(r.json).includes('inviteTokenHash'), 'B1 no token hash in the answer');

      const viaHelper = await ctx.addMember({ email: em('ownmgr2'), name: 'T88 Owner Manager 2', role: 'manager', venueId: vA1, password: 'Stage2-t88-pass!' }, tok.ownera);
      // (the helper's final lookup is the inviter's GET /api/users, which an
      // owner may not read; the accepted row is checked in the doc instead)
      assert(viaHelper.status === 201 || (viaHelper.status === 500 && viaHelper.json && viaHelper.json.user === null), `B2 owner-added manager accepts: ${viaHelper.status} ${J(viaHelper.json)}`);
      const u2 = ((await doc()).users || []).find((x) => x && x.email === em('ownmgr2'));
      assert(u2 && u2.role === 'manager' && u2.venueId === vA1 && u2.agencyId === A, `B2 accepted row: ${J(u2)}`);

      const refusals = [
        ['other venue', { email: em('b3a'), name: 'x', role: 'manager', venueId: vA2 }],
        ['other venue list', { email: em('b3b'), name: 'x', role: 'manager', venueIds: [vA1, vA2] }],
        ['pool', { email: em('b3c'), name: 'x', role: 'manager', pool: true }],
        ['owner', { email: em('b3d'), name: 'x', role: 'owner', venueId: vA1 }],
        ['admin', { email: em('b3e'), name: 'x', role: 'admin' }],
        ['coordinator', { email: em('b3f'), name: 'x', role: 'coordinator', venueId: vA1 }],
        ['mashgiach', { email: em('b3g'), name: 'x', role: 'mashgiach', venueId: vA1 }],
        ['no role', { email: em('b3h'), name: 'x', venueId: vA1 }],
      ];
      for (const [label, body] of refusals) {
        const x = await call('ownera', 'POST', '/api/users', body);
        assert(x.status === 403, `B3 owner ${label}: expected 403, got ${x.status} ${x.text}`);
        assert((await invitesFor(body.email)).length === 0, `B3 owner ${label}: nothing stored`);
      }
      const mine = await call('ownera', 'POST', '/api/agency/invites', { email: em('b3i'), name: 'x', role: 'manager', venueIds: [vA1], expectedVersion: await ctx.getVersion() });
      assert(mine.status === 403, `B4 owner on the admin invite route: ${mine.status}`);

      // a pending invite made by someone else is never replaced by an owner
      const adminInv = await call('admina', 'POST', '/api/users', { email: em('pend'), name: 'Pending', role: 'coordinator', venueId: vA2 });
      assert(adminInv.status === 201, `B5 admin invite: ${adminInv.status}`);
      const before = J(await invitesFor(em('pend')));
      const over = await call('ownera', 'POST', '/api/users', { email: em('pend'), name: 'Pending', role: 'manager' });
      assert(over.status === 409 && over.json?.code === 'INVITE_PENDING', `B5 owner over a pending invite: ${over.status} ${over.text}`);
      assert(J(await invitesFor(em('pend'))) === before, 'B5 the admin invite is untouched');
      const team = await call('ownera', 'POST', '/api/users', { email: em('masha'), name: 'x', role: 'manager' });
      assert(team.status === 409, `B6 owner invites someone already on the team: ${team.status}`);

      // fresh data: the owner is demoted in the committed doc only (cache says owner) -> 403
      const d0 = await doc();
      const demoted = (d0.users || []).map((u) => (u.id === id('ownera2') ? { ...u, role: 'mashgiach' } : u));
      const s1 = await ctx.api('POST', '/api/__test__/doc-set-users', { users: demoted });
      if (s1.status === 200) {
        const fresh = await call('ownera2', 'POST', '/api/users', { email: em('fresh'), name: 'x', role: 'manager' });
        assert(fresh.status === 403, `B7 demoted owner (fresh data): ${fresh.status} ${fresh.text}`);
        assert((await invitesFor(em('fresh'))).length === 0, 'B7 nothing stored');
        const s2 = await ctx.api('POST', '/api/__test__/doc-set-users', { users: d0.users });
        assert(s2.status === 200, `B7 restore: ${s2.status}`);
      }
    }

    // ---- C: the owner changes only the role of a person at their own venue ----
    {
      const up = await putRole('ownera', id('masha'), { role: 'manager' });
      assert(up.status === 200, `C1 owner mashgiach -> manager: ${up.status} ${up.text}`);
      assert((await row(id('masha'))).role === 'manager', 'C1 stored manager');
      const down = await putRole('ownera', id('masha'), { role: 'mashgiach' });
      assert(down.status === 200 && (await row(id('masha'))).role === 'mashgiach', `C2 owner manager -> mashgiach: ${down.status} ${down.text}`);
      const refusals = [
        ['other venue person', id('masha2'), { role: 'manager' }],
        ['other venue manager', id('mgra2'), { role: 'mashgiach' }],
        ['another owner', id('ownera2'), { role: 'manager' }],
        ['self', id('ownera'), { role: 'manager' }],
        ['coordinator', id('coorda'), { role: 'manager' }],
        ['admin', id('admina'), { role: 'manager' }],
        ['to owner', id('masha'), { role: 'owner' }],
        ['to coordinator', id('masha'), { role: 'coordinator' }],
        ['to admin', id('masha'), { role: 'admin' }],
        ['role + venue', id('masha'), { role: 'manager', venueId: vA1 }],
        ['role + rights', id('masha'), { role: 'manager', permissions: { canAssignTasks: true } }],
        ['name only', id('masha'), { name: 'Renamed' }],
        ['pin', id('masha'), { kioskPin: '1234' }],
      ];
      for (const [label, uid, body] of refusals) {
        const before = await rowJ(uid);
        const x = await putRole('ownera', uid, body);
        assert(x.status === 403, `C4 owner ${label}: expected 403, got ${x.status} ${x.text}`);
        assert((await rowJ(uid)) === before, `C4 owner ${label}: row unchanged`);
      }
    }

    // ---- D: a manager never touches the owner and cannot add managers/owners ----
    {
      const ownerBefore = await rowJ(id('ownera'));
      for (const role of ['manager', 'owner', 'mashgiach', 'admin']) {
        const x = await call('mgra', 'POST', '/api/users', { email: em(`d1${role}`), name: 'x', role, venueId: vA1 });
        assert(x.status === 403, `D1 manager adds ${role}: ${x.status} ${x.text}`);
        assert((await invitesFor(em(`d1${role}`))).length === 0, `D1 ${role}: nothing stored`);
      }
      const inv = await call('mgra', 'POST', '/api/agency/invites', { email: em('d1inv'), name: 'x', role: 'manager', venueIds: [vA1], expectedVersion: await ctx.getVersion() });
      assert(inv.status === 403, `D1 manager on the invite route: ${inv.status}`);
      for (const [label, body] of [['demote', { role: 'mashgiach' }], ['to manager', { role: 'manager' }], ['rename', { name: 'Gone' }], ['move', { venueId: vA2 }]]) {
        const x = await putRole('mgra', id('ownera'), body);
        assert(x.status === 403, `D2 manager ${label} owner: ${x.status} ${x.text}`);
      }
      const prom = await putRole('mgra', id('masha'), { role: 'manager' });
      assert(prom.status === 403, `D3 manager makes a manager: ${prom.status}`);
      const del = await call('mgra', 'DELETE', `/api/users/${id('ownera')}`);
      assert(del.status === 403, `D4 manager removes owner: ${del.status} ${del.text}`);
      const rl = await call('mgra', 'POST', `/api/users/${id('ownera')}/reset-link`, {});
      assert(rl.status === 403 || rl.status === 404, `D5 manager reset-link for owner: ${rl.status} ${rl.text}`);
      const vo = await call('mgra', 'POST', `/api/users/${id('ownera')}/venue-ops`, { ops: [{ op: 'remove', venueId: vA1 }], expectedVenueRev: 0, expectedVersion: await ctx.getVersion(), operationId: `op88o-${ts}` });
      assert(vo.status === 403, `D6 manager venue-ops on owner: ${vo.status} ${vo.text}`);
      const nv = await call('mgra', 'POST', '/api/venues', { name: `T88 new ${ts}`, ownerEmail: em('mgra'), ownerName: 'x', operationId: `op88v-${ts}` });
      assert(nv.status === 403, `D7 manager creates a venue / makes an owner: ${nv.status} ${nv.text}`);
      assert((await rowJ(id('ownera'))) === ownerBefore, 'D the owner row is byte-for-byte unchanged');
    }

    // ---- E: scope ----
    {
      const me = await call('mgra', 'GET', '/api/events');
      assert(me.status === 200, `E1 manager GET /api/events: ${me.status}`);
      const ids = eventIds(me);
      assert(ids.includes(`ev-t88-a1-${ts}`), `E1 own venue event visible: ${J(ids)}`);
      assert(!ids.includes(`ev-t88-a2-${ts}`), 'E1 venue A2 event hidden');
      assert(!ids.includes(`ev-t88-b1-${ts}`), 'E1 agency B event hidden');
      assert(!me.text.includes(`T88 a2 ${ts}`) && !me.text.includes(`T88 b1 ${ts}`), 'E1 zero bytes of other venues');
      const ok = await copy('mgra', `ev-t88-a1-${ts}`);
      assert(ok.status === 201, `E2 manager copies own venue event: ${ok.status} ${ok.text}`);
      const no = await copy('mgra', `ev-t88-a2-${ts}`);
      assert(no.status === 403 || no.status === 404, `E3 manager copies venue A2 event: ${no.status} ${no.text}`);
      const nb = await copy('mgra', `ev-t88-b1-${ts}`);
      assert(nb.status === 403 || nb.status === 404, `E4 manager copies agency B event: ${nb.status}`);
    }

    // ---- F: other agencies ----
    {
      const x = await call('adminb', 'POST', '/api/users', { email: em('f1'), name: 'x', role: 'manager', venueId: vA1 });
      assert(x.status >= 400 && x.status < 500, `F1 agency B admin adds manager at A1: ${x.status} ${x.text}`);
      assert((await invitesFor(em('f1'))).filter((i) => J(i.venueIds || []).includes(vA1)).length === 0, 'F1 no invite for venue A1');
      const before = await rowJ(id('masha2'));
      const y = await putRole('adminb', id('masha2'), { role: 'manager' });
      assert(y.status === 403 && (await rowJ(id('masha2'))) === before, `F2 agency B admin makes A's person a manager: ${y.status}`);
      const z = await putRole('ownerb', id('masha'), { role: 'manager' });
      assert(z.status === 403, `F3 agency B owner: ${z.status}`);
      const o = await call('ownerb', 'POST', '/api/users', { email: em('f4'), name: 'x', role: 'manager', venueId: vA1 });
      assert(o.status === 403 && (await invitesFor(em('f4'))).length === 0, `F4 agency B owner invites manager at A1: ${o.status}`);
    }
    return 'admin + owner add managers (owner: own venue only, role-default rights, never replaces a pending invite); owner role-only change at own venue; manager never touches the owner; manager scoped to own venue; other agency refused';
  },
};
