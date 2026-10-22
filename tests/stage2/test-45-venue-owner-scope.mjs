/**
 * Test 45 (item 8v): POST /api/venues with ownerEmail may reuse an EXISTING
 * user only if that user is already an owner in the caller's agency.
 *
 * Before 8v, any existing user with that email (any agency, any role, even the
 * platform admin) was silently rewritten to { role: 'owner', venueId: <new>,
 * agencyId: <caller's> } — a cross-agency demotion/move of an identity.
 * Proves (invites always on, Don 2026-10-22: every agency uses invites, so
 * 10i V2/W1 applies everywhere — an email that is not a row of the caller's
 * agency gets an owner INVITE, the same answer as an unknown email):
 *  1 other-agency admin → 201 owner invite, NO row written or moved, victim
 *    record byte-for-byte unchanged, victim's existing session still works as admin
 *  2 platform admin usr_admin (another agency) → owner invite, unchanged, session intact
 *  3 same-agency non-owner (coordinator) → 409, unchanged
 *  4 other-agency owner → owner invite, unchanged
 *  5 same-agency owner → 201 (allowed, as today)
 *  6 a brand-new email → 201 owner invite (no row until accepted), same answer shape as 1/2/4
 *  7 case / whitespace variants of a refused email → same 409
 *  8 fresh-data re-check: the same-agency owner is demoted in the committed
 *    doc only (cache still says owner) → 409, nothing written
 * All refusals carry the identical body.
 */
const A = 'agency-test45-a';
const B = 'agency-test45-b';
const REFUSAL = "This email can't be used for a new owner.";
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
  name: 'Test 45: venue-create ownerEmail cannot take over a user outside the caller\'s agency owners (8v)',
  whatItProves:
    'An existing user becomes a new venue\'s owner only if already an owner in the caller\'s agency; a same-agency non-owner gets one generic 409 with nothing written (also on fresh data); an email of another agency (admin, owner, platform admin) gets an owner invite exactly like an unknown email, with no row written or moved and the victim untouched (invites always on).',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t45-a1-${ts}`, vA2 = `venue-t45-a2-${ts}`, vB1 = `venue-t45-b1-${ts}`;
    const id = (k) => `user-t45-${k}-${ts}`;
    const em = (k) => `t45-${k}-${ts}@test.local`;
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T45 Admin A', role: 'admin', agencyId: A },
      { id: id('coorda'), email: em('coorda'), name: 'T45 Coord A', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('ownera'), email: em('ownera'), name: 'T45 Owner A', role: 'owner', agencyId: A, venueId: vA1 },
      { id: id('ownera2'), email: em('ownera2'), name: 'T45 Owner A2', role: 'owner', agencyId: A, venueId: vA2 },
      { id: id('adminb'), email: em('adminb'), name: 'T45 Admin B', role: 'admin', agencyId: B },
      { id: id('ownerb'), email: em('ownerb'), name: 'T45 Owner B', role: 'owner', agencyId: B, venueId: vB1 },
    ];
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T45 A ${ts}` }, { id: B, name: `T45 B ${ts}` }],
      venues: [
        { id: vA1, name: `T45 A1 ${ts}`, agencyId: A },
        { id: vA2, name: `T45 A2 ${ts}`, agencyId: A },
        { id: vB1, name: `T45 B1 ${ts}`, agencyId: B },
      ],
      users: people,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tokA = auth(await mintToken(baseUrl, id('admina')));
    const tokB = auth(await mintToken(baseUrl, id('adminb')));

    const createVenue = async (ownerEmail, label) => {
      const r = await fetch(`${baseUrl}/api/venues`, {
        method: 'POST', headers: tokA,
        body: JSON.stringify({ name: `T45 ${label} ${ts}`, ownerEmail, ownerName: 'Whoever', operationId: `op-t45-${Math.random().toString(36).slice(2)}` }),
      });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const userRec = async (uid) => JSON.stringify(((await ctx.getDoc()).users || []).find((u) => u.id === uid));
    const venueCount = async () => ((await ctx.getDoc()).venues || []).length;
    const userCount = async () => ((await ctx.getDoc()).users || []).length;

    const refusals = [];
    const expectRefused = async (email, victimId, label) => {
      const before = await userRec(victimId);
      // Not the doc version: a scheduled-reset rollover can bump it during the
      // check (flake). What this refusal could write is a venue or a user row.
      const n0 = await venueCount();
      const u0 = await userCount();
      const r = await createVenue(email, label);
      assert(r.status === 409, `${label}: must be 409, got ${r.status} ${r.text.slice(0, 120)}`);
      assert(r.json && r.json.error === REFUSAL && r.json.code === 'OWNER_EMAIL_UNAVAILABLE', `${label}: generic body, got ${r.text.slice(0, 120)}`);
      assert((await venueCount()) === n0 && (await userCount()) === u0, `${label}: nothing written (no venue, no user row)`);
      assert((await userRec(victimId)) === before, `${label}: victim record byte-for-byte unchanged`);
      refusals.push(r.text);
    };
    // Invites always on (10i V2/W1 for every agency): an email that is NOT a
    // row of the caller's agency gets an owner INVITE, the same answer as an
    // unknown email. It never takes over the other agency's row: no user row
    // is written or moved, the victim's record is byte-for-byte unchanged, the
    // new venue has no owner, and the answer names nothing of the victim.
    const inviteShapes = [];
    const shape = (j) => JSON.stringify(Object.keys(j || {}).sort()) + JSON.stringify(Object.keys((j && j.ownerInvite) || {}).sort());
    const expectInvited = async (email, victimId, label) => {
      const before = victimId ? await userRec(victimId) : null;
      const u0 = await userCount();
      const r = await createVenue(email, label);
      assert(r.status === 201, `${label}: must be 201 with an owner invite, got ${r.status} ${r.text.slice(0, 120)}`);
      assert(r.json.owner === null && r.json.ownerInvite && /^\/invite#t=/.test(r.json.ownerInviteLink || ''), `${label}: owner invite, no owner row, got ${r.text.slice(0, 160)}`);
      assert((await userCount()) === u0, `${label}: no user row written`);
      if (victimId) {
        assert((await userRec(victimId)) === before, `${label}: victim record byte-for-byte unchanged`);
        assert(!r.text.includes(victimId), `${label}: the answer names nothing of the victim`);
      }
      const v = ((await ctx.getDoc()).venues || []).find((x) => x.id === r.json.venue?.id);
      assert(v && v.agencyId === A && !v.ownerId, `${label}: venue in A with no owner yet`);
      inviteShapes.push(shape(r.json));
      return r;
    };

    // 1. other-agency admin -> owner invite (no takeover); their session keeps working as admin.
    const dashB0 = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: tokB });
    assert(dashB0.status === 200, `B admin session before: ${dashB0.status}`);
    await expectInvited(em('adminb'), id('adminb'), 'other-agency admin');
    const dashB1 = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: tokB });
    assert(dashB1.status === 200, `B admin session (admin-only route) after the invite must still work, got ${dashB1.status}`);

    // 2. platform admin usr_admin (agency-hkc, not A) -> owner invite, untouched.
    await expectInvited('kenan@hartfordkashrut.org', 'usr_admin', 'platform admin');
    const plat = await ctx.api('GET', '/api/admin/dashboard');
    assert(plat.status === 200, `platform admin session still works: ${plat.status}`);

    // 3. same-agency non-owner -> refused (unchanged); 4. other-agency owner -> owner invite.
    await expectRefused(em('coorda'), id('coorda'), 'same-agency coordinator');
    await expectInvited(em('ownerb'), id('ownerb'), 'other-agency owner');
    // 7. case / whitespace variants of a refused email -> the same 409.
    await expectRefused(`  ${em('coorda').toUpperCase()}  `, id('coorda'), 'case/space variant');
    assert(refusals.every((t) => t === refusals[0]), 'all refusals carry the identical body');

    // 5. same-agency owner → allowed (as today).
    const ok5 = await createVenue(em('ownera'), 'same-agency owner');
    assert(ok5.status === 200 || ok5.status === 201, `same-agency owner must be allowed, got ${ok5.status} ${ok5.text.slice(0, 120)}`);
    const owner5 = JSON.parse(await userRec(id('ownera')));
    assert(owner5.role === 'owner' && owner5.agencyId === A, 'owner stays an A owner');

    // 6. brand-new email → an owner invite (no row), the same answer shape as the other-agency emails.
    const fresh = em('brandnew');
    await expectInvited(fresh, null, 'new email');
    assert(!((await ctx.getDoc()).users || []).some((u) => u.email === fresh), 'no owner row before the invite is accepted');
    assert(inviteShapes.every((x) => x === inviteShapes[0]), `other-agency and unknown emails get the same answer shape: ${J(inviteShapes)}`);

    // 8. fresh-data re-check: demote A2's owner in the committed doc only.
    const doc8 = await ctx.getDoc();
    const demoted = (doc8.users || []).map((u) => (u.id === id('ownera2') ? { ...u, role: 'coordinator' } : u));
    const ds = await ctx.api('POST', '/api/__test__/doc-set-users', { users: demoted });
    assert(ds.status === 200, `doc-set-users: ${ds.status}`);
    const n8 = await venueCount();
    const r8 = await createVenue(em('ownera2'), 'fresh re-check');
    assert(r8.status === 409 && r8.json && r8.json.error === REFUSAL, `fresh re-check must refuse, got ${r8.status} ${r8.text.slice(0, 120)}`);
    assert((await venueCount()) === n8, 'fresh refusal wrote nothing');
    const after8 = JSON.parse(await userRec(id('ownera2')));
    assert(after8.role === 'coordinator' && after8.venueId === vA2, 'fresh-refused user not moved');
    const resync = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t45-sync-${ts}`, name: 'sync', agencyId: A }] });
    assert(resync.status === 200, `resync: ${resync.status}`);

    return 'venue owner reuse: same-agency coordinator / case variant → identical 409, nothing written; other-agency admin / platform admin / other-agency owner → owner invite like an unknown email, no row written or moved, victims unchanged, sessions intact; same-agency owner reused; fresh re-check 409';
  },
};
