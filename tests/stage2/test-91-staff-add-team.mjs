/**
 * Test 91 (TEAM ADDS, Don 2026-10-27 11:30 PM: "make the owner and
 * coordinators able to add a [role], but that it will send a notification to
 * the administrator and an announcement in the announcement box"):
 *  A  a venue OWNER adds a MASHGIACH or a MANAGER at their OWN venue (pending
 *     invite, role-default rights, one venue). Each add posts exactly ONE
 *     announcement ("Team change", "<Owner> added <Name> as <Role> at
 *     <Venue>", that venue) and pushes the same sentence to each ADMIN of the
 *     agency (one per admin; never the owner, a coordinator, another agency).
 *  B  owner refusals (403, nothing stored, no announcement, no push): another
 *     venue, two venues, the Pool, role owner/admin/coordinator/worker/none.
 *  C  a COORDINATOR adds at a venue in their scope (home, or an extra venue
 *     an admin granted); outside their scope, another agency's venue, or a
 *     role other than mashgiach/manager: 403.
 *  D  another agency's owner / coordinator: 403.
 *  E  an ADMIN's add and an ADMIN's role change post NO announcement and NO
 *     team-change push.
 *  F  the OWNER's role change (PUT /api/users/:id {role}) posts one
 *     announcement + admin pushes ("<Owner> changed <Name> to Manager at
 *     <Venue>"); a refused change posts nothing.
 *  G  fresh data: a coordinator demoted in the committed doc only -> 403.
 *  H  the announcement is in the announcement box of that venue's team and
 *     the agency's admins, not another venue's mashgiach, not another agency.
 */
const A = 'agency-test91-a';
const B = 'agency-test91-b';
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
  name: 'Test 91: owners and coordinators add a mashgiach or manager; admins notified + one announcement',
  whatItProves:
    'An owner (own venue) and a coordinator (own scope) can add a mashgiach or manager and nothing else; every such add, and an owner role change, posts exactly one announcement for that venue and pushes it to each admin of the agency; admin changes post nothing; other venues, other agencies and other roles are refused with nothing stored.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t91-a1-${ts}`, vA2 = `venue-t91-a2-${ts}`, vA3 = `venue-t91-a3-${ts}`, vB1 = `venue-t91-b1-${ts}`;
    const vName = { [vA1]: `T91 A1 ${ts}`, [vA2]: `T91 A2 ${ts}`, [vA3]: `T91 A3 ${ts}`, [vB1]: `T91 B1 ${ts}` };
    const id = (k) => `user-t91-${k}-${ts}`;
    const em = (k) => `t91-${k}-${ts}@test.local`;
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T91 Admin A', role: 'admin', agencyId: A },
      { id: id('admina2'), email: em('admina2'), name: 'T91 Admin A Two', role: 'admin', agencyId: A },
      { id: id('ownera'), email: em('ownera'), name: 'T91 Owner A1', role: 'owner', agencyId: A, venueId: vA1, permissions: { canFillTasks: false, canAssignTasks: false } },
      { id: id('coorda'), email: em('coorda'), name: 'T91 Coord A1', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('coordm'), email: em('coordm'), name: 'T91 Coord A1 plus A2', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('coordd'), email: em('coordd'), name: 'T91 Coord to demote', role: 'coordinator', agencyId: A, venueId: vA2 },
      { id: id('mgra'), email: em('mgra'), name: 'T91 Manager A1', role: 'manager', agencyId: A, venueId: vA1 },
      { id: id('masha'), email: em('masha'), name: 'T91 Mash A1', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('mashb'), email: em('mashb'), name: 'T91 Mash A1 B', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('masha2'), email: em('masha2'), name: 'T91 Mash A2', role: 'mashgiach', agencyId: A, venueId: vA2 },
      { id: id('adminb'), email: em('adminb'), name: 'T91 Admin B', role: 'admin', agencyId: B },
      { id: id('ownerb'), email: em('ownerb'), name: 'T91 Owner B1', role: 'owner', agencyId: B, venueId: vB1 },
      { id: id('coordb'), email: em('coordb'), name: 'T91 Coord B1', role: 'coordinator', agencyId: B, venueId: vB1 },
    ];
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T91 A ${ts}` }, { id: B, name: `T91 B ${ts}` }],
      venues: [
        { id: vA1, name: vName[vA1], agencyId: A },
        { id: vA2, name: vName[vA2], agencyId: A },
        { id: vA3, name: vName[vA3], agencyId: A },
        { id: vB1, name: vName[vB1], agencyId: B },
      ],
      users: people,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);
    const keys = ['admina', 'admina2', 'ownera', 'coorda', 'coordm', 'coordd', 'mgra', 'masha', 'masha2', 'adminb', 'ownerb', 'coordb'];
    const tok = {};
    for (const k of keys) tok[k] = auth(await mintToken(baseUrl, id(k)));
    // Each person subscribes one device (identity-bound) so every push is visible in the test log.
    const ep = (k) => `https://push.test.local/t91-${k}-${ts}`;
    const owner = {};
    for (const k of keys) {
      const r = await fetch(`${baseUrl}/api/push/subscribe`, {
        method: 'POST', headers: tok[k],
        body: J({ userEmail: 'ignored@x', subscription: { endpoint: ep(k), keys: { p256dh: 'p', auth: 'a' } } }),
      });
      assert(r.status === 200, `subscribe ${k}: ${r.status}`);
      owner[ep(k)] = id(k);
    }

    const call = async (who, method, path, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers: tok[who] || who, body: body !== undefined ? J(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const doc = () => ctx.getDoc();
    const invitesFor = async (email) => ((await doc()).invites || []).filter((i) => i && i.email === email);
    const notices = async () => ((await doc()).announcements || []).filter((a) => a && (a.agencyId === A || a.agencyId === B) && a.title === 'Team change');
    const pushes = async () => {
      const r = await ctx.api('GET', '/api/__test__/push-log');
      assert(r.status === 200, `push-log: ${r.status}`);
      return (r.json.log || []).filter((e) => e.title === '👥 Team change' && owner[e.endpoint]);
    };
    const clearPushes = async () => { const r = await ctx.api('POST', '/api/__test__/push-log/clear', {}); assert(r.status === 200, `push-log clear: ${r.status}`); };
    const putRole = async (who, uid, body) => call(who, 'PUT', `/api/users/${uid}`, { ...body, expectedVersion: await ctx.getVersion(), operationId: `op91-${Math.random().toString(36).slice(2, 10)}` });
    const post = async (who, body) => call(who, 'POST', '/api/users', { ...body, expectedVersion: await ctx.getVersion() });

    /** Exactly one new announcement with this text, and exactly one push of it to each admin of agency A (and nobody else). */
    const expectNotice = async (label, before, text, venueId, authorEmail) => {
      const after = await notices();
      const fresh = after.filter((a) => !before.some((b) => b.id === a.id));
      assert(fresh.length === 1, `${label}: exactly one new announcement, got ${fresh.length} ${J(fresh)}`);
      const a = fresh[0];
      assert(a.agencyId === A && a.body === text && a.venueId === venueId && a.category === 'notice' && J(a.targetRoles) === J(['all']) && a.authorEmail === authorEmail,
        `${label}: announcement ${J(a)} (want body "${text}")`);
      const p = await pushes();
      const recips = p.map((e) => e.recipientUserId).sort();
      assert(J(recips) === J([id('admina'), id('admina2')].sort()), `${label}: one push per admin of the agency, got ${J(recips)}`);
      for (const e of p) {
        assert(e.body === text, `${label}: push body "${e.body}" (want "${text}")`);
        assert(owner[e.endpoint] === e.recipientUserId && e.path === 'identity', `${label}: push went to the admin's own device`);
      }
      return a;
    };
    const expectNoNotice = async (label, before) => {
      const after = await notices();
      assert(after.length === before.length, `${label}: no announcement expected, got ${after.length - before.length} new`);
      const p = await pushes();
      assert(p.length === 0, `${label}: no team-change push expected, got ${J(p.map((e) => e.recipientUserId))}`);
    };

    // ---- A: the owner adds a mashgiach and a manager at their own venue ----
    {
      await clearPushes(); let before = await notices();
      const r = await post('ownera', { email: em('newmash'), name: 'T91 New Mash', role: 'mashgiach', permissions: { canFillTasks: true, canAssignTasks: true } });
      assert(r.status === 201 && r.json?.pending === true && typeof r.json?.link === 'string', `A1 owner adds mashgiach: ${r.status} ${r.text}`);
      const inv = (await invitesFor(em('newmash')))[0];
      assert(inv && inv.role === 'mashgiach' && J(inv.venueIds) === J([vA1]) && inv.invitedBy === id('ownera') && inv.agencyId === A && inv.status === 'pending',
        `A1 stored invite: ${J(inv && { role: inv.role, venueIds: inv.venueIds, invitedBy: inv.invitedBy })}`);
      assert(inv.permissions && inv.permissions.canAssignTasks === false && inv.permissions.canFillTasks === true, `A1 role-default rights only: ${J(inv.permissions)}`);
      await expectNotice('A1', before, `T91 Owner A1 added T91 New Mash as Mashgiach at ${vName[vA1]}`, vA1, em('ownera'));

      await clearPushes(); before = await notices();
      const m = await post('ownera', { email: em('newmgr'), name: 'T91 New Manager', role: 'manager', venueId: vA1 });
      assert(m.status === 201, `A2 owner adds manager: ${m.status} ${m.text}`);
      const minv = (await invitesFor(em('newmgr')))[0];
      assert(minv && minv.role === 'manager' && J(minv.venueIds) === J([vA1]), `A2 stored invite ${J(minv)}`);
      await expectNotice('A2', before, `T91 Owner A1 added T91 New Manager as Manager at ${vName[vA1]}`, vA1, em('ownera'));
    }

    // ---- B: owner refusals ----
    {
      await clearPushes(); const before = await notices();
      const refusals = [
        ['other venue', { email: em('b1'), name: 'x', role: 'manager', venueId: vA2 }],
        ['other venue (mashgiach)', { email: em('b2'), name: 'x', role: 'mashgiach', venueId: vA2 }],
        ['two venues', { email: em('b3'), name: 'x', role: 'mashgiach', venueIds: [vA1, vA2] }],
        ['other agency venue', { email: em('b4'), name: 'x', role: 'mashgiach', venueId: vB1 }],
        ['pool', { email: em('b5'), name: 'x', role: 'mashgiach', pool: true }],
        ['owner', { email: em('b6'), name: 'x', role: 'owner', venueId: vA1 }],
        ['admin', { email: em('b7'), name: 'x', role: 'admin' }],
        ['coordinator', { email: em('b8'), name: 'x', role: 'coordinator', venueId: vA1 }],
        ['worker', { email: em('b9'), name: 'x', role: 'worker', venueId: vA1 }],
        ['no role', { email: em('b10'), name: 'x', venueId: vA1 }],
      ];
      for (const [label, body] of refusals) {
        const x = await post('ownera', body);
        assert(x.status === 403, `B owner ${label}: expected 403, got ${x.status} ${x.text}`);
        assert((await invitesFor(body.email)).length === 0, `B owner ${label}: nothing stored`);
      }
      // a manager (owner-style) still cannot add anyone
      for (const role of ['mashgiach', 'manager']) {
        const x = await post('mgra', { email: em(`bm${role}`), name: 'x', role, venueId: vA1 });
        assert(x.status === 403, `B manager adds ${role}: ${x.status} ${x.text}`);
        assert((await invitesFor(em(`bm${role}`))).length === 0, `B manager ${role}: nothing stored`);
      }
      // a mashgiach cannot either
      const xm = await post('masha', { email: em('bmash'), name: 'x', role: 'mashgiach', venueId: vA1 });
      assert(xm.status === 403, `B mashgiach adds: ${xm.status}`);
      await expectNoNotice('B refusals', before);
    }

    // ---- C: coordinators, inside and outside their scope ----
    {
      await clearPushes(); let before = await notices();
      const r = await post('coorda', { email: em('cmash'), name: 'T91 Coord Mash', role: 'mashgiach', venueId: vA1 });
      assert(r.status === 201 && r.json?.pending === true, `C1 coordinator adds mashgiach at home: ${r.status} ${r.text}`);
      const inv = (await invitesFor(em('cmash')))[0];
      assert(inv && inv.role === 'mashgiach' && J(inv.venueIds) === J([vA1]) && inv.invitedBy === id('coorda'), `C1 invite ${J(inv)}`);
      await expectNotice('C1', before, `T91 Coord A1 added T91 Coord Mash as Mashgiach at ${vName[vA1]}`, vA1, em('coorda'));

      await clearPushes(); before = await notices();
      const d = await post('coorda', { email: em('cdef'), name: 'T91 Coord Default', role: 'manager' });
      assert(d.status === 201, `C2 coordinator, no venue given -> home: ${d.status} ${d.text}`);
      assert(J((await invitesFor(em('cdef')))[0]?.venueIds) === J([vA1]), 'C2 home venue');
      await expectNotice('C2', before, `T91 Coord A1 added T91 Coord Default as Manager at ${vName[vA1]}`, vA1, em('coorda'));

      await clearPushes(); before = await notices();
      const out = [
        ['outside scope', 'coorda', { email: em('c3'), name: 'x', role: 'manager', venueId: vA2 }],
        ['other agency venue', 'coorda', { email: em('c4'), name: 'x', role: 'mashgiach', venueId: vB1 }],
        ['unknown venue', 'coorda', { email: em('c5'), name: 'x', role: 'mashgiach', venueId: `venue-none-${ts}` }],
        ['owner', 'coorda', { email: em('c6'), name: 'x', role: 'owner', venueId: vA1 }],
        ['admin', 'coorda', { email: em('c7'), name: 'x', role: 'admin', venueId: vA1 }],
        ['coordinator', 'coorda', { email: em('c8'), name: 'x', role: 'coordinator', venueId: vA1 }],
        ['pool', 'coorda', { email: em('c9'), name: 'x', role: 'mashgiach', pool: true }],
        ['two venues', 'coordm', { email: em('c10'), name: 'x', role: 'mashgiach', venueIds: [vA1, vA2] }],
        ['before the grant', 'coordm', { email: em('c11'), name: 'x', role: 'mashgiach', venueId: vA2 }],
      ];
      for (const [label, who, body] of out) {
        const x = await post(who, body);
        assert(x.status === 403, `C3 coordinator ${label}: expected 403, got ${x.status} ${x.text}`);
        assert((await invitesFor(body.email)).length === 0, `C3 coordinator ${label}: nothing stored`);
      }
      await expectNoNotice('C3 refusals', before);

      // an admin grants coordm the extra venue A2: now A2 is in scope, A3 still is not
      const g = await call('admina', 'PUT', `/api/users/${id('coordm')}/venues`, { venueIds: [vA2], expectedVenueIds: [vA1], expectedVersion: await ctx.getVersion() });
      assert(g.status === 200, `C4 admin grants A2: ${g.status} ${g.text}`);
      tok.coordm = auth(await mintToken(baseUrl, id('coordm')));
      await clearPushes(); before = await notices();
      const x2 = await post('coordm', { email: em('cmgr2'), name: 'T91 Manager at A2', role: 'manager', venueId: vA2 });
      assert(x2.status === 201, `C4 coordinator adds at a granted venue: ${x2.status} ${x2.text}`);
      assert(J((await invitesFor(em('cmgr2')))[0]?.venueIds) === J([vA2]), 'C4 the granted venue');
      await expectNotice('C4', before, `T91 Coord A1 plus A2 added T91 Manager at A2 as Manager at ${vName[vA2]}`, vA2, em('coordm'));
      await clearPushes(); before = await notices();
      const x3 = await post('coordm', { email: em('c12'), name: 'x', role: 'manager', venueId: vA3 });
      assert(x3.status === 403 && (await invitesFor(em('c12'))).length === 0, `C5 coordinator at a venue never granted: ${x3.status}`);
      await expectNoNotice('C5', before);
    }

    // ---- D: another agency's owner / coordinator ----
    {
      await clearPushes(); const before = await notices();
      for (const [who, body] of [['ownerb', { email: em('d1'), name: 'x', role: 'manager', venueId: vA1 }], ['coordb', { email: em('d2'), name: 'x', role: 'mashgiach', venueId: vA1 }]]) {
        const x = await post(who, body);
        assert(x.status === 403, `D ${who} at agency A's venue: ${x.status} ${x.text}`);
        assert((await invitesFor(body.email)).length === 0, `D ${who}: nothing stored`);
      }
      await expectNoNotice('D', before);
    }

    // ---- E: admin adds and admin role changes post nothing ----
    {
      await clearPushes(); const before = await notices();
      const r = await post('admina', { email: em('e1'), name: 'T91 Admin-added', role: 'manager', venueId: vA1 });
      assert(r.status === 201, `E1 admin adds: ${r.status} ${r.text}`);
      const r2 = await post('admina', { email: em('e2'), name: 'T91 Admin-added 2', role: 'mashgiach', venueId: vA2 });
      assert(r2.status === 201, `E2 admin adds: ${r2.status}`);
      const up = await putRole('admina', id('masha2'), { role: 'manager' });
      assert(up.status === 200, `E3 admin role change: ${up.status} ${up.text}`);
      const down = await putRole('admina', id('masha2'), { role: 'mashgiach' });
      assert(down.status === 200, `E3 admin role change back: ${down.status}`);
      await expectNoNotice('E admin', before);
    }

    // ---- F: the owner's role change ----
    {
      await clearPushes(); let before = await notices();
      const up = await putRole('ownera', id('masha'), { role: 'manager' });
      assert(up.status === 200, `F1 owner mashgiach -> manager: ${up.status} ${up.text}`);
      await expectNotice('F1', before, `T91 Owner A1 changed T91 Mash A1 to Manager at ${vName[vA1]}`, vA1, em('ownera'));
      await clearPushes(); before = await notices();
      const down = await putRole('ownera', id('masha'), { role: 'mashgiach' });
      assert(down.status === 200, `F2 owner manager -> mashgiach: ${down.status} ${down.text}`);
      await expectNotice('F2', before, `T91 Owner A1 changed T91 Mash A1 to Mashgiach at ${vName[vA1]}`, vA1, em('ownera'));
      await clearPushes(); before = await notices();
      const no = await putRole('ownera', id('masha2'), { role: 'manager' });
      assert(no.status === 403, `F3 owner, other venue person: ${no.status}`);
      const no2 = await putRole('ownera', id('coorda'), { role: 'manager' });
      assert(no2.status === 403, `F3 owner, coordinator: ${no2.status}`);
      await expectNoNotice('F3 refused', before);
    }

    // ---- G: fresh data — a coordinator demoted in the committed doc only ----
    {
      await clearPushes(); const before = await notices();
      const d0 = await doc();
      const demoted = (d0.users || []).map((u) => (u.id === id('coordd') ? { ...u, role: 'mashgiach' } : u));
      const s1 = await ctx.api('POST', '/api/__test__/doc-set-users', { users: demoted });
      assert(s1.status === 200, `G setup: ${s1.status} ${J(s1.json)}`);
      const x = await post('coordd', { email: em('g1'), name: 'x', role: 'mashgiach', venueId: vA2 });
      assert(x.status === 403, `G demoted coordinator (fresh data): ${x.status} ${x.text}`);
      assert((await invitesFor(em('g1'))).length === 0, 'G nothing stored');
      const s2 = await ctx.api('POST', '/api/__test__/doc-set-users', { users: d0.users });
      assert(s2.status === 200, `G restore: ${s2.status}`);
      await expectNoNotice('G', before);
    }

    // ---- H: who sees the announcement in the announcement box ----
    {
      const mine = (await notices()).filter((a) => a.agencyId === A && a.venueId === vA1);
      assert(mine.length >= 5, `H notices at A1: ${mine.length}`);
      const seen = async (who) => {
        const r = await call(who, 'GET', '/api/announcements');
        assert(r.status === 200, `H GET announcements ${who}: ${r.status}`);
        return new Set((r.json?.announcements || []).map((a) => a.id));
      };
      const ids = mine.map((a) => a.id);
      for (const who of ['admina', 'ownera', 'mashb', 'coorda'].filter((k) => tok[k])) {
        const s = await seen(who);
        assert(ids.every((x) => s.has(x)), `H ${who} sees the A1 team notices`);
      }
      tok.mashb = auth(await mintToken(baseUrl, id('mashb')));
      const sb = await seen('mashb');
      assert(ids.every((x) => sb.has(x)), 'H a mashgiach at A1 sees them');
      const s2 = await seen('masha2');
      assert(ids.every((x) => !s2.has(x)), 'H a mashgiach at A2 does not see A1 notices');
      const sB = await seen('adminb');
      assert(ids.every((x) => !sB.has(x)), 'H another agency admin does not see them');
      const pub = (await call('admina', 'GET', '/api/announcements')).json.announcements.find((a) => a.id === ids[0]);
      assert(pub && pub.readBy === undefined && pub.title === 'Team change', `H public shape ${J(pub)}`);
    }
  },
};
