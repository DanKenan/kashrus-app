/**
 * Test 47 (item 8b): identity projections (people/emails), no login change.
 *
 * Proves, end to end on the real server:
 *  1 rows created through the API are born migrated: personId = id,
 *    venueAccess from venueId, isPrimaryAdmin only for the agency's
 *    adminEmail admin; people/emails docs exactly as specified (emails:
 *    verified false, source admin-entered)
 *  2 body-sent personId / venueAccess / isPrimaryAdmin / tokenEpoch are
 *    ignored on create-user, update-user, register and venue-owner create
 *  3 none of the four fields leaves the server (create/update/register/
 *    venue responses, GET /api/users roster, idempotent replay)
 *  4 an idempotent replay creates no second identity
 *  5 venue move via PUT → venueAccess follows; personId unchanged
 *  6 email change (internal test hook; no public API) → old key retired,
 *    new key active, people.primaryEmail follows
 *  7 delete → people retired (record kept), emails retired; re-creating a
 *    user with that email reassigns the mapping with previousPersonIds +
 *    reassignedAt, verified false
 *  8 an ACTIVE mapping owned by another person → create refused, nothing
 *    written (monolith version unchanged, no row, mapping unchanged)
 *  9 remove X + create Y with X's email in ONE commit → reassigned in one
 *    step; forged personId on Y discarded
 * 10 a legacy (pre-8b) row stays unmigrated when edited (no projections)
 * 11 per-entity status carries identity counts; none of this test's users
 *    is reported, and the orphan active mapping from 8 is flagged (when the
 *    mismatch list is not capped)
 */
const A = 'agency-test47-a';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const FORGED = { personId: 'forged-person', venueAccess: ['venue-evil'], isPrimaryAdmin: true, tokenEpoch: 42 };
const SERVER_ONLY = ['personId', 'venueAccess', 'isPrimaryAdmin', 'tokenEpoch'];

function noServerOnly(obj, where) {
  const s = JSON.stringify(obj || {});
  for (const f of SERVER_ONLY) assert(!s.includes(`"${f}"`), `${where}: server-only field ${f} sent to a client`);
}

import { inviteAndAccept, inviteMember, acceptNew } from './invite-helpers.mjs';

export default {
  name: 'Test 47: identity projections (people/emails), born-migrated rows, server-only fields (8b)',
  whatItProves:
    'New rows are born migrated with server-derived fields that no body can set and no client sees; people/emails projections are written, retired and reassigned exactly per the 8b contract inside the commit; an active mapping of another person fails closed; legacy rows stay unmigrated; consistency counts identity.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t47-a1-${ts}`, vA2 = `venue-t47-a2-${ts}`;
    const id = (k) => `user-t47-${k}-${ts}`;
    const em = (k) => `t47-${k}-${ts}@test.local`;
    const mint = async (userId) => {
      const r = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      assert(r.status === 200, `mint-token ${r.status}`);
      return (await r.json()).token;
    };
    const docs = async (q) => {
      const r = await ctx.api('GET', `/api/__test__/identity-docs?${new URLSearchParams(q).toString()}`);
      assert(r.status === 200, `identity-docs ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };

    // ---- 1. born migrated via fixture (new rows in a commit) ----
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T47 A ${ts}`, adminEmail: em('admina').toUpperCase() }],
      venues: [{ id: vA1, name: `T47 A1 ${ts}`, agencyId: A }, { id: vA2, name: `T47 A2 ${ts}`, agencyId: A }],
      users: [
        { id: id('admina'), email: em('admina'), name: 'T47 Admin A', role: 'admin', agencyId: A, ...FORGED },
        { id: id('admin2'), email: em('admin2'), name: 'T47 Admin 2', role: 'admin', agencyId: A },
        { id: id('coord'), email: em('coord'), name: 'T47 Coord', role: 'coordinator', agencyId: A, venueId: vA1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture ${inj.status}`);
    let d = await docs({ userId: id('admina'), email: em('admina') });
    assert(d.row.personId === id('admina'), `fixture admin personId ${d.row.personId}`);
    assert(d.row.isPrimaryAdmin === true && JSON.stringify(d.row.venueAccess) === '[]' && d.row.tokenEpoch === null, `fixture admin derived ${JSON.stringify(d.row)}`);
    assert(d.people && d.people.id === id('admina') && d.people.name === 'T47 Admin A' && d.people.primaryEmail === em('admina') && d.people.status === 'active' && d.people.createdAt, `people doc ${JSON.stringify(d.people)}`);
    assert(d.emails && d.emails.personId === id('admina') && d.emails.status === 'active' && d.emails.verified === false && d.emails.source === 'admin-entered' && d.emails.addedAt, `emails doc ${JSON.stringify(d.emails)}`);
    for (const k of Object.keys(d.people)) assert(['id', 'name', 'primaryEmail', 'status', 'createdAt', '_v'].includes(k), `unexpected people field ${k}`);
    d = await docs({ userId: id('admin2') });
    assert(d.row.isPrimaryAdmin === false, 'a second admin is not the primary admin');
    d = await docs({ userId: id('coord') });
    assert(JSON.stringify(d.row.venueAccess) === `["${vA1}"]` && d.row.isPrimaryAdmin === false, `coord derived ${JSON.stringify(d.row)}`);

    const tokA = auth(await mint(id('admina')));

    // ---- 2/3/4. create via API with forged fields; replay ----
    const opId = `op-t47-create-${ts}`;
    const createBody = { email: em('m1'), name: 'T47 M1', role: 'mashgiach', venueId: vA1, operationId: opId, ...FORGED };
    // Invites always on: "Add team member" is a pending invite; the row is
    // born when the invitee accepts. Forged fields ride the invite body and
    // must not reach the row.
    const c1 = await inviteMember(baseUrl, tokA, createBody);
    assert(c1.status === 201 && c1.token, `create (invite) ${c1.status} ${c1.text}`);
    noServerOnly(c1.json, 'create-user (invite) response');
    const a1 = await acceptNew(baseUrl, c1.token, 'stage2-t47-m1-pw');
    assert(a1.status === 200, `accept ${a1.status} ${a1.text}`);
    noServerOnly(a1.json, 'invite accept response');
    const m1 = (((await ctx.getDoc()).users || []).find((u) => (u.email || '').toLowerCase() === em('m1')) || {}).id;
    assert(m1, 'accepted row exists');
    d = await docs({ userId: m1, email: em('m1') });
    assert(d.row.personId === m1 && d.row.isPrimaryAdmin === false && JSON.stringify(d.row.venueAccess) === `["${vA1}"]` && d.row.tokenEpoch === null, `forged fields not discarded: ${JSON.stringify(d.row)}`);
    assert(d.people?.status === 'active' && d.emails?.personId === m1, 'm1 projections');
    const peopleV = d.people._v;
    const usersBefore = ((await ctx.getDoc()).users || []).length;
    const c2 = await inviteMember(baseUrl, tokA, createBody);
    assert(c2.status === 200 || c2.status === 201, `replay ${c2.status} ${c2.text}`);
    noServerOnly(c2.json, 'idempotent replay response');
    assert(((await ctx.getDoc()).users || []).length === usersBefore, 'replay created a second row');
    d = await docs({ userId: m1, email: em('m1') });
    assert(d.people._v === peopleV && d.emails.personId === m1 && !d.emails.previousPersonIds, 'replay touched the projections');

    // ---- 5. venue move via PUT; forged fields ignored ----
    let v = await ctx.getVersion();
    const u1 = await call('PUT', `/api/users/${m1}`, tokA, { venueId: vA2, expectedVersion: v, ...FORGED });
    assert(u1.status === 200, `update ${u1.status} ${u1.text}`);
    noServerOnly(u1.json, 'update-user response');
    d = await docs({ userId: m1 });
    assert(d.row.personId === m1 && JSON.stringify(d.row.venueAccess) === `["${vA2}"]` && d.row.isPrimaryAdmin === false && d.row.tokenEpoch === null, `after move ${JSON.stringify(d.row)}`);

    // roster egress
    const roster = await call('GET', '/api/users', tokA);
    assert(roster.status === 200 && Array.isArray(roster.json.users) && roster.json.users.some((u) => u.id === m1), `roster ${roster.status}`);
    noServerOnly(roster.json, 'GET /api/users');

    // ---- 6. email change through the internal hook ----
    const sc = await ctx.api('POST', '/api/__test__/identity-set-email', { userId: m1, email: em('m1b') });
    assert(sc.status === 200, `set-email ${sc.status} ${JSON.stringify(sc.json)}`);
    const old1 = await docs({ email: em('m1') });
    const new1 = await docs({ userId: m1, email: em('m1b') });
    assert(old1.emails.status === 'retired' && old1.emails.retiredAt && old1.emails.personId === m1, `old key ${JSON.stringify(old1.emails)}`);
    assert(new1.emails.status === 'active' && new1.emails.personId === m1 && new1.emails.verified === false, `new key ${JSON.stringify(new1.emails)}`);
    assert(new1.people.primaryEmail === em('m1b'), 'people.primaryEmail follows');

    // ---- 7. delete → retired; re-create with the same email → reassigned ----
    v = await ctx.getVersion();
    const del = await call('DELETE', `/api/users/${m1}?expectedVersion=${v}`, tokA);
    assert(del.status === 200, `delete ${del.status} ${del.text}`);
    d = await docs({ personId: m1, email: em('m1b') });
    assert(d.people.status === 'retired' && d.people.retiredAt && d.people.name === 'T47 M1' && d.people.primaryEmail === em('m1b'), `retired people ${JSON.stringify(d.people)}`);
    assert(d.emails.status === 'retired' && d.emails.personId === m1, `retired emails ${JSON.stringify(d.emails)}`);
    const c3 = await inviteAndAccept(baseUrl, tokA, { email: em('m1b'), name: 'T47 M1 again', role: 'mashgiach', venueId: vA1, operationId: `op-t47-recreate-${ts}` });
    assert(c3.status === 201, `re-create ${c3.status} ${c3.text}`);
    const m1b = c3.json.user.id;
    assert(m1b !== m1, 'new person id');
    d = await docs({ userId: m1b, email: em('m1b') });
    assert(d.emails.personId === m1b && d.emails.status === 'active' && d.emails.verified === false && d.emails.source === 'admin-entered', `reassigned ${JSON.stringify(d.emails)}`);
    assert(JSON.stringify(d.emails.previousPersonIds) === `["${m1}"]` && d.emails.reassignedAt && !d.emails.retiredAt, `history ${JSON.stringify(d.emails)}`);
    assert((await docs({ personId: m1 })).people.status === 'retired', 'old person stays retired');

    // ---- 8. active mapping owned by another person → fail closed ----
    const ghost = `ghost-t47-${ts}`;
    const seeded = await ctx.api('POST', '/api/__test__/identity-seed-email', { email: em('taken'), personId: ghost });
    assert(seeded.status === 200, `seed ${seeded.status}`);
    // The invite itself writes no row; the accept is where a row would be
    // born, and it must fail closed over a mapping owned by another person.
    const i4 = await inviteMember(baseUrl, tokA, { email: em('taken'), name: 'T47 Taken', role: 'mashgiach', venueId: vA1, operationId: `op-t47-taken-${ts}` });
    const v0 = await ctx.getVersion();
    const c4 = i4.token ? await acceptNew(baseUrl, i4.token, 'stage2-t47-taken-pw') : i4;
    assert(c4.status >= 400, `create over an owned mapping must fail, got ${c4.status}`);
    assert((await ctx.getVersion()) === v0, 'monolith version changed on a refused create');
    assert(!((await ctx.getDoc()).users || []).some((u) => (u.email || '').toLowerCase() === em('taken')), 'row written despite refusal');
    d = await docs({ email: em('taken') });
    assert(d.emails.personId === ghost && d.emails.status === 'active', 'owned mapping changed');

    // ---- 9. one commit: remove X, add Y with X's email (forged personId) ----
    const sw = await ctx.api('POST', '/api/__test__/identity-swap', {
      removeUserId: id('coord'),
      newUser: { id: id('coord2'), email: em('coord'), name: 'T47 Coord 2', role: 'coordinator', agencyId: A, venueId: vA2, avatarColor: '#fff', ...FORGED },
    });
    assert(sw.status === 200, `swap ${sw.status} ${JSON.stringify(sw.json)}`);
    d = await docs({ userId: id('coord2'), email: em('coord') });
    assert(d.row.personId === id('coord2') && d.row.isPrimaryAdmin === false && JSON.stringify(d.row.venueAccess) === `["${vA2}"]` && d.row.tokenEpoch === null, `swap row ${JSON.stringify(d.row)}`);
    assert(d.emails.personId === id('coord2') && JSON.stringify(d.emails.previousPersonIds) === `["${id('coord')}"]` && d.emails.verified === false, `swap mapping ${JSON.stringify(d.emails)}`);
    assert((await docs({ personId: id('coord') })).people.status === 'retired', 'X retired in the same commit');

    // ---- 10. legacy row stays unmigrated ----
    const cur = await ctx.getDoc();
    const legacyId = id('legacy');
    const setU = await ctx.api('POST', '/api/__test__/doc-set-users', {
      users: [...(cur.users || []), { id: legacyId, email: em('legacy'), name: 'T47 Legacy', role: 'mashgiach', agencyId: A, venueId: vA1, avatarColor: '#fff', password: '' }],
    });
    assert(setU.status === 200, `doc-set-users ${setU.status}`);
    // a commit hydrates the cache from the stored doc
    const hyd = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t47-h-${ts}`, name: 'T47 hydrate', agencyId: A }] });
    assert(hyd.status === 200, `hydrate ${hyd.status}`);
    d = await docs({ userId: legacyId, email: em('legacy') });
    assert(d.row.exists && d.row.personId === null && d.row.venueAccess === null && d.people === null && d.emails === null, `legacy before edit ${JSON.stringify(d)}`);
    v = await ctx.getVersion();
    const ul = await call('PUT', `/api/users/${legacyId}`, tokA, { name: 'T47 Legacy Edited', expectedVersion: v, ...FORGED });
    assert(ul.status === 200, `legacy update ${ul.status} ${ul.text}`);
    d = await docs({ userId: legacyId, personId: legacyId, email: em('legacy') });
    assert(d.row.personId === null && d.row.venueAccess === null && d.row.isPrimaryAdmin === null && d.row.tokenEpoch === null, `legacy migrated by an edit: ${JSON.stringify(d.row)}`);
    assert(d.people === null && d.emails === null, 'legacy row got projections');

    // ---- 2/3 (cont). register + venue owner ----
    const reg = await call('POST', '/api/agencies/register', { 'Content-Type': 'application/json' }, {
      agencyName: `T47 Reg ${ts}`, adminName: 'T47 Reg Admin', adminEmail: em('reg'), adminPassword: 'reg-password-123', initialVenueName: 'T47 Reg Venue', ...FORGED,
    });
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`);
    noServerOnly(reg.json.user, 'register response user');
    d = await docs({ userId: reg.json.user.id, email: em('reg') });
    assert(d.row.personId === reg.json.user.id && d.row.isPrimaryAdmin === true && d.row.tokenEpoch === null, `register row ${JSON.stringify(d.row)}`);
    assert(d.people?.status === 'active' && d.emails?.personId === reg.json.user.id, 'register projections');
    const ven = await call('POST', '/api/venues', tokA, { name: `T47 Owner Venue ${ts}`, ownerEmail: em('owner'), ownerName: 'T47 Owner', operationId: `op-t47-venue-${ts}`, ...FORGED });
    assert(ven.status === 201, `venue create ${ven.status} ${ven.text}`);
    noServerOnly(ven.json, 'venue owner (invite) response');
    // Invites always on: the owner row is born when the owner invite is accepted.
    assert(ven.json.owner === null && ven.json.ownerInvite, `owner invite ${ven.text.slice(0, 160)}`);
    const oacc = await acceptNew(baseUrl, /#t=([A-Za-z0-9_-]+)/.exec(ven.json.ownerInviteLink || '')?.[1], 'stage2-t47-owner-pw');
    assert(oacc.status === 200, `owner invite accept ${oacc.status} ${oacc.text.slice(0, 160)}`);
    noServerOnly(oacc.json, 'owner invite accept response');
    const ownerRow = ((await ctx.getDoc()).users || []).find((u) => (u.email || '').toLowerCase() === em('owner'));
    assert(ownerRow, 'owner row created');
    d = await docs({ userId: ownerRow.id, email: em('owner') });
    assert(d.row.personId === ownerRow.id && JSON.stringify(d.row.venueAccess) === `["${ven.json.venue.id}"]` && d.row.isPrimaryAdmin === false, `owner row ${JSON.stringify(d.row)}`);

    // ---- 11. consistency counts ----
    const pes = await ctx.api('GET', '/api/admin/per-entity-status');
    assert(pes.status === 200 && pes.json, `per-entity-status ${pes.status}`);
    const status = pes.json.status || pes.json;
    assert(status.identity && typeof status.identity.migratedRows === 'number' && typeof status.identity.unmigratedRows === 'number', `identity counts missing: ${JSON.stringify(Object.keys(status))}`);
    assert(status.identity.unmigratedRows >= 1 && status.identity.peopleRetired >= 2, `counts ${JSON.stringify(status.identity)}`);
    const mine = new Set([id('admina'), id('admin2'), id('coord2'), m1b, legacyId, reg.json.user.id, ownerRow.id]);
    const mm = status.mismatches || [];
    const bad = mm.filter((x) => mine.has(x.id) && (x.collection === 'people' || x.collection === 'emails'));
    assert(bad.length === 0, `this test's users reported: ${JSON.stringify(bad)}`);
    let ghostNote = 'mismatch list capped; orphan check skipped';
    if (mm.length < 20) {
      assert(mm.some((x) => x.collection === 'emails' && x.id === ghost && x.reason === 'active projection without row'), `orphan active mapping not flagged: ${JSON.stringify(mm)}`);
      ghostNote = 'orphan flagged';
    }
    return `born migrated (fixture, create, register, venue owner), forged fields ignored x4, no egress, replay safe, move/email change/delete/reassign/fail-closed/one-commit swap, legacy untouched, consistency counts (${ghostNote})`;
  },
};
