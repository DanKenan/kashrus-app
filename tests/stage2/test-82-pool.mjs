/**
 * Test 82 (item 12, 12b-s, plan v6 5.3-5.7; Don Oct 22 + Oct 23): the Pool.
 *  A roles: GET /api/pool admin = members + invites + contacts; owner and
 *    coordinator = members as name + last venue only; mashgiach 403; another
 *    agency sees nothing of A
 *  B contacts: create, email hard duplicate (row / contact), phone soft
 *    (confirmSharedPhone), cross-agency allowed with no hint, cap 100,
 *    revision check, invite needs an email, expectedEmail, edit email kills
 *    the link, delete kills the link, accept removes the contact, a Team
 *    invite of a contact's email links it, "pool": true invites, POOL_UPDATED
 *    to admins only, contacts never in /api/users, the agency export only
 *  C move-to-pool: admin only, dry run lists open work and writes nothing,
 *    venueRev check, history, empty scope, already in Pool, the old sheet
 *    save 400, a coordinator can tick a Pool member into their own venue
 *  D make-main: from the Pool, keep / drop the old main, refusals
 *  E borrow list: name + main venue only, other venues only, mandatory end
 *    date for the loan, mashgiach 403
 *  F venue history keeps 2 weeks: the sweep drops older entries (venueRev
 *    and access unchanged), a second sweep writes nothing
 */
import { inviteMember, acceptNew } from './invite-helpers.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const keys = (o) => Object.keys(o || {}).sort().join(',');

export default {
  name: 'Test 82: the Pool, contacts, move-to-pool, make-main, borrow list, 2-week history (12b-s)',
  whatItProves:
    'Pool data reaches only the roles Don chose (admin full; owner/coordinator name + last venue; borrow list name + main venue), contacts follow the planned lifecycle with in-agency duplicate checks, move-to-pool / make-main go through the one grant writer with revision checks, and venue history older than 14 days is dropped automatically.',

  async run(baseUrl, ctx) {
    const details = [];
    const ts = Date.now();
    const A = `agency-t82a-${ts}`, B = `agency-t82b-${ts}`;
    const V1 = `venue-t82-1-${ts}`, V2 = `venue-t82-2-${ts}`, V3 = `venue-t82-3-${ts}`, VB = `venue-t82-b-${ts}`;
    const U = (k) => `user-t82-${k}-${ts}`;
    const E = (k) => `t82-${k}-${ts}@test.local`;
    const PW = 'stage2-t82-password';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body) => {
      const r = await call('POST', `/api/__test__/${path}`, ctx.authHeaders, body);
      assert(r.status === 200, `${path} ${r.status} ${r.text.slice(0, 200)}`);
      return r.json;
    };
    const mint = async (userId) => {
      const r = await call('POST', '/api/__test__/mint-token', { 'Content-Type': 'application/json' }, { userId });
      assert(r.status === 200 && r.json?.token, `mint ${userId} ${r.status}`);
      return r.json.token;
    };
    let reloadN = 0;
    const reloadCommit = async () => assert((await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: `agency-t82-reload-${ts}-${reloadN++}`, name: 'T82 reload' }] })).status === 200, 'reload commit');
    const rec = async (id) => (await call('GET', `/api/__test__/grant-record/${id}`, ctx.authHeaders)).json;
    const V = async () => ctx.getVersion();
    const pool = async (t) => call('GET', '/api/pool', auth(t));
    const createC = async (t, body) => call('POST', '/api/pool/contacts', auth(t), { ...body, expectedVersion: await V() });
    const patchC = async (t, id, body) => call('PATCH', `/api/pool/contacts/${id}`, auth(t), { ...body, expectedVersion: await V() });
    const delC = async (t, id, body) => call('DELETE', `/api/pool/contacts/${id}`, auth(t), { ...body, expectedVersion: await V() });
    const inviteC = async (t, id, body) => call('POST', `/api/pool/contacts/${id}/invite`, auth(t), { ...body, expectedVersion: await V() });
    const tokenOf = (r) => /#t=([A-Za-z0-9_-]+)/.exec(r.json?.link || '')?.[1] || null;
    const preview = async (tok) => (await call('GET', '/api/invites/preview', { 'x-invite-token': tok })).status;
    const contactIn = async (t, id) => ((await pool(t)).json?.contacts || []).find((c) => c.id === id);
    const revOf = async (id) => ((await rec(id)).venueRev ?? 0);
    const move = async (t, id, body) => call('POST', `/api/users/${id}/move-to-pool`, auth(t), { ...body, expectedVersion: await V() });
    const main = async (t, id, body) => call('POST', `/api/users/${id}/make-main`, auth(t), { ...body, expectedVersion: await V() });
    const ops = async (t, id, list, rev) => call('POST', `/api/users/${id}/venue-ops`, auth(t), { ops: list, expectedVenueRev: rev, expectedVersion: await V() });
    const openWs = (token) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
      const conn = { ws, msgs: [] };
      ws.onmessage = (ev) => { try { conn.msgs.push(JSON.parse(String(ev.data))); } catch {} };
      ws.onerror = () => {};
      conn.until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return pred(); };
      conn.count = (type) => conn.msgs.filter((m) => m.type === type).length;
      conn.close = () => { try { ws.close(); } catch {} };
      return conn;
    };
    const ymd = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T82 A ${ts}`, shortCode: 'T82A', adminEmail: E('adminA'), timeZone: 'America/New_York' },
        { id: B, name: `T82 B ${ts}`, shortCode: 'T82B', adminEmail: E('adminB') },
      ],
      venues: [
        { id: V1, name: 'T82 V1', agencyId: A }, { id: V2, name: 'T82 V2', agencyId: A },
        { id: V3, name: 'T82 V3', agencyId: A }, { id: VB, name: 'T82 VB', agencyId: B },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T82 Admin A', role: 'admin', agencyId: A },
        { id: U('adminB'), email: E('adminB'), name: 'T82 Admin B', role: 'admin', agencyId: B },
        { id: U('coord'), email: E('coord'), name: 'T82 Coord V1', role: 'coordinator', agencyId: A, venueId: V1 },
        { id: U('owner'), email: E('owner'), name: 'T82 Owner V3', role: 'owner', agencyId: A, venueId: V3 },
        { id: U('mash'), email: E('mash'), name: 'T82 Mash V1', role: 'mashgiach', agencyId: A, venueId: V1, phoneNumber: '+18605550111' },
        { id: U('mash2'), email: E('mash2'), name: 'T82 Mash V2', role: 'mashgiach', agencyId: A, venueId: V2 },
        { id: U('mash3'), email: E('mash3'), name: 'T82 Mash Three', role: 'mashgiach', agencyId: A, venueId: V1 },
        { id: U('mashB'), email: E('mashB'), name: 'T82 Mash B', role: 'mashgiach', agencyId: B, venueId: VB },
      ],
      tasks: [{ id: `task-t82-1-${ts}`, agencyId: A, venueId: V1, title: 'T82 open task', isCompleted: false, inputType: 'toggle', category: 'General', assignedTo: [E('mash3')], createdAt: new Date().toISOString() }],
      events: [{ id: `event-t82-1-${ts}`, agencyId: A, venueId: V1, title: 'T82 event at V1', date: ymd(3), assignedMashgiachEmail: E('mash3'), tasks: [] }],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    const tAdmin = await mint(U('adminA')), tAdminB = await mint(U('adminB')), tCoord = await mint(U('coord'));
    const tOwner = await mint(U('owner')), tMash = await mint(U('mash'));
    let x;

    // ===== A: roles =====
    x = await pool(tAdmin);
    assert(x.status === 200 && keys(x.json) === 'contacts,invites,members' && x.json.members.length === 0, `admin pool ${x.status} ${x.text.slice(0, 200)}`);
    assert(/no-store/.test((await fetch(`${baseUrl}/api/pool`, { headers: auth(tAdmin) })).headers.get('cache-control') || ''), 'no-store');
    for (const [t, who] of [[tCoord, 'coordinator'], [tOwner, 'owner']]) {
      x = await pool(t);
      assert(x.status === 200 && keys(x.json) === 'members', `${who} pool: members only ${x.status} ${x.text.slice(0, 200)}`);
    }
    x = await pool(tMash);
    assert(x.status === 403 && !/members|contacts/.test(x.text), `mashgiach 403, zero Pool bytes ${x.status} ${x.text}`);
    details.push('A roles: admin full; owner/coordinator members only; mashgiach 403 with zero Pool bytes');

    // ===== B: contacts =====
    const wsAdmin = openWs(tAdmin), wsMash = openWs(tMash), wsCoord = openWs(tCoord);
    await sleep(500);
    const pu0 = wsAdmin.count('POOL_UPDATED'), pm0 = wsMash.count('POOL_UPDATED');
    x = await createC(tAdmin, { name: 'T82 Yossi', email: E('yossi').toUpperCase(), phone: '(860) 555-0101', note: 'nights only' });
    assert(x.status === 201 && x.json.contact.status === 'details' && x.json.contact.email === E('yossi') && x.json.contact.phone === '+18605550101', `create ${x.status} ${x.text.slice(0, 200)}`);
    assert(keys(x.json.contact) === 'createdAt,email,id,name,note,phone,status,updatedAt', `view allowlist ${keys(x.json.contact)}`);
    let c1 = x.json.contact;
    assert(await wsAdmin.until(() => wsAdmin.count('POOL_UPDATED') > pu0, 4000), 'admin socket got POOL_UPDATED');
    const pu = wsAdmin.msgs.filter((m) => m.type === 'POOL_UPDATED').pop();
    assert(keys(pu.payload) === 'count' && pu.payload.count >= 1, `POOL_UPDATED carries only a count ${J(pu.payload)}`);
    await sleep(300);
    assert(wsMash.count('POOL_UPDATED') === pm0, 'a mashgiach socket gets no POOL_UPDATED');
    assert(!wsMash.msgs.some((m) => JSON.stringify(m).includes('T82 Yossi')) && !wsCoord.msgs.some((m) => JSON.stringify(m).includes('T82 Yossi')), 'no contact bytes on mashgiach/coordinator sockets');
    x = await createC(tAdmin, { name: 'Dup', email: E('mash') });
    assert(x.status === 409 && x.json.code === 'POOL_DUPLICATE' && x.json.kind === 'member' && x.json.displayName === 'T82 Mash V1', `email of a member: hard ${x.status} ${x.text}`);
    x = await createC(tAdmin, { name: 'Dup', email: E('yossi') });
    assert(x.status === 409 && x.json.code === 'POOL_DUPLICATE' && x.json.kind === 'contact', `email of a contact: hard ${x.status} ${x.text}`);
    x = await createC(tAdmin, { name: 'T82 Dov', email: E('dov'), phone: '+18605550101' });
    assert(x.status === 409 && x.json.code === 'POOL_PHONE_SHARED' && x.json.kind === 'contact' && x.json.displayName === 'T82 Yossi', `phone: soft ${x.status} ${x.text}`);
    x = await createC(tAdmin, { name: 'T82 Dov', email: E('dov'), phone: '+18605550101', confirmSharedPhone: true });
    assert(x.status === 201, `confirmed shared phone ${x.status} ${x.text}`);
    const c2 = x.json.contact;
    x = await createC(tAdmin, { name: 'T82 Fam', phone: '+18605550111' });
    assert(x.status === 409 && x.json.code === 'POOL_PHONE_SHARED' && x.json.kind === 'member', `phone of a member: soft ${x.status}`);
    x = await createC(tAdminB, { name: 'T82 B copy', email: E('mash'), phone: '+18605550111' });
    assert(x.status === 201 && !/T82 Mash|member/.test(x.text), `another agency: allowed, no hint ${x.status} ${x.text}`);
    const cB = x.json.contact;
    x = await pool(tAdminB);
    assert(J(x.json.contacts.map((c) => c.id)) === J([cB.id]) && x.json.members.length === 0, `B sees only its own ${x.text.slice(0, 200)}`);
    x = await pool(tAdmin);
    assert(J(x.json.contacts.map((c) => c.id).sort()) === J([c1.id, c2.id].sort()), `A sees its two ${x.text.slice(0, 300)}`);
    for (const t of [tMash, tCoord, tOwner]) {
      x = await createC(t, { name: 'Nope' });
      assert(x.status === 403, `non-admin create 403 ${x.status}`);
    }
    x = await call('GET', '/api/users', auth(tAdmin));
    assert(x.status === 200 && !x.text.includes('T82 Yossi') && !x.text.includes(c1.id), 'contacts never in /api/users');
    x = await pool(tCoord);
    assert(!x.text.includes('Yossi') && !x.text.includes('@'), `coordinator pool: no contacts, no emails ${x.text}`);
    x = await call('GET', '/api/admin/export', auth(tAdmin));
    assert(x.status === 200 && J((x.json.poolContacts || []).map((c) => c.id).sort()) === J([c1.id, c2.id].sort()), `agency export carries its own contacts only ${J(x.json?.poolContacts)}`);
    // revision check + edit
    x = await patchC(tAdmin, c1.id, { note: 'days', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    assert(x.status === 409 && x.json.code === 'CONTACT_CHANGED', `stale edit ${x.status}`);
    await sleep(5);
    x = await patchC(tAdmin, c1.id, { note: 'days', expectedUpdatedAt: c1.updatedAt });
    assert(x.status === 200 && x.json.contact.note === 'days' && x.json.contact.updatedAt !== c1.updatedAt, `edit ${x.status} ${x.text}`);
    c1 = x.json.contact;
    x = await patchC(tAdmin, c1.id, { email: E('dov'), expectedUpdatedAt: c1.updatedAt });
    assert(x.status === 409 && x.json.code === 'POOL_DUPLICATE', `edit to another contact's email ${x.status}`);
    // invite lifecycle
    x = await createC(tAdmin, { name: 'T82 NoMail' });
    const c3 = x.json.contact;
    x = await inviteC(tAdmin, c3.id, { expectedUpdatedAt: c3.updatedAt, expectedEmail: '' });
    assert(x.status === 400 && x.json.code === 'POOL_INVITE_NEEDS_EMAIL', `invite without email ${x.status} ${x.text}`);
    x = await inviteC(tAdmin, c1.id, { expectedUpdatedAt: c1.updatedAt, expectedEmail: E('other') });
    assert(x.status === 409 && x.json.code === 'CONTACT_CHANGED', `expectedEmail mismatch ${x.status}`);
    for (const t of [tCoord, tOwner, tMash]) assert((await inviteC(t, c1.id, { expectedUpdatedAt: c1.updatedAt, expectedEmail: E('yossi') })).status === 403, 'non-admin invite 403');
    x = await inviteC(tAdmin, c1.id, { expectedUpdatedAt: c1.updatedAt, expectedEmail: E('yossi') });
    assert(x.status === 201 && J(x.json.invite.venueIds) === J([]) && tokenOf(x), `invite from contact ${x.status} ${x.text.slice(0, 200)}`);
    const tok1 = tokenOf(x);
    assert(await preview(tok1) === 200, 'invite link works');
    c1 = await contactIn(tAdmin, c1.id);
    assert(c1.status === 'invited' && !c1.inviteExpired, `contact invited ${J(c1)}`);
    x = await pool(tAdmin);
    assert(x.json.invites.some((i) => i.email === E('yossi') && J(i.venueIds) === J([])), 'live Pool invite listed');
    x = await patchC(tAdmin, c1.id, { email: E('yossi2'), expectedUpdatedAt: c1.updatedAt });
    assert(x.status === 200 && x.json.contact.status === 'details', `edit email while invited ${x.status} ${x.text}`);
    c1 = x.json.contact;
    assert(await preview(tok1) === 404, 'old link dead after the email edit');
    x = await inviteC(tAdmin, c1.id, { expectedUpdatedAt: c1.updatedAt, expectedEmail: E('yossi2') });
    const tok2 = tokenOf(x);
    assert(x.status === 201 && tok2, `invite again ${x.status}`);
    c1 = await contactIn(tAdmin, c1.id);
    x = await inviteC(tAdmin, c1.id, { expectedUpdatedAt: c1.updatedAt, expectedEmail: E('yossi2') });
    const tok2b = tokenOf(x);
    assert(x.status === 201 && tok2b && await preview(tok2) === 404 && await preview(tok2b) === 200, '"send again": the old token stays dead');
    c1 = await contactIn(tAdmin, c1.id);
    x = await delC(tAdmin, c1.id, { expectedUpdatedAt: 'wrong' });
    assert(x.status === 409 && x.json.code === 'CONTACT_CHANGED', 'stale delete');
    x = await delC(tAdmin, c1.id, { expectedUpdatedAt: c1.updatedAt });
    assert(x.status === 200 && !(await contactIn(tAdmin, c1.id)), `delete ${x.status}`);
    assert(await preview(tok2b) === 404, 'delete revokes the live invite');
    x = await acceptNew(baseUrl, tok2b, PW);
    assert(x.status !== 200, `accept after delete fails ${x.status}`);
    // accept removes the contact; the person is a Pool member
    const c2f = await contactIn(tAdmin, c2.id);
    x = await inviteC(tAdmin, c2.id, { expectedUpdatedAt: c2f.updatedAt, expectedEmail: E('dov') });
    const tok3 = tokenOf(x);
    assert(x.status === 201 && tok3, `invite c2 ${x.status} ${x.text}`);
    x = await acceptNew(baseUrl, tok3, PW);
    assert(x.status === 200, `accept ${x.status} ${x.text.slice(0, 200)}`);
    x = await pool(tAdmin);
    const dov = x.json.members.find((m) => m.email === E('dov'));
    assert(!x.json.contacts.some((c) => c.id === c2.id) && dov && !x.json.invites.some((i) => i.email === E('dov')), `accepted: contact gone, member listed ${x.text.slice(0, 400)}`);
    const dr = await rec(dov.id);
    assert(dr.noHomeVenue === true && dr.venueId === '' && J(dr.venueAccess) === J([]), `Pool row ${J(dr)}`);
    x = await pool(tCoord);
    const dovC = x.json.members.find((m) => m.id === dov.id);
    assert(dovC && keys(dovC) === 'id,name,role,venueRevision', `coordinator sees name only (no last venue yet) ${J(dovC)}`);
    // a Team invite of a contact's email links the contact
    x = await createC(tAdmin, { name: 'T82 Link', email: E('link') });
    const c4 = x.json.contact;
    x = await inviteMember(baseUrl, auth(tAdmin), { email: E('link'), name: 'T82 Link', role: 'mashgiach', venueId: V1 });
    assert(x.status === 201, `team invite ${x.status}`);
    const c4b = await contactIn(tAdmin, c4.id);
    assert(c4b.status === 'invited', `contact linked, not duplicated ${J(c4b)}`);
    // "pool": true on the Team route
    x = await call('POST', '/api/users', auth(tAdmin), { email: E('poolinv'), name: 'T82 Pool Invite', role: 'mashgiach', pool: true });
    assert(x.status === 201 && J(x.json.invite.venueIds) === J([]), `pool:true invite ${x.status} ${x.text.slice(0, 200)}`);
    x = await call('POST', '/api/users', auth(tAdmin), { email: E('poolinv2'), name: 'T82 X', role: 'coordinator', pool: true });
    assert(x.status === 400 && x.json.code === 'POOL_ROLE_INVALID', `pool coordinator refused ${x.status} ${x.text}`);
    x = await call('POST', '/api/users', auth(tAdmin), { email: E('poolinv3'), name: 'T82 Y', role: 'mashgiach', venueId: V2 });
    assert(x.status === 201 && J(x.json.invite.venueIds) === J([V2]), 'without the flag: today\'s shape');
    // cap 100
    let d = await ctx.getDoc();
    const keep = d.poolContacts || [];
    const mine = keep.filter((c) => c.agencyId === A).length;
    const fill = Array.from({ length: 100 - mine }, (_, i) => ({ id: `pc-fill-${ts}-${i}`, agencyId: A, name: `Fill ${i}`, status: 'details', createdBy: U('adminA'), createdAt: 'x', updatedAt: 'x' }));
    await call('POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: d.users, poolContacts: [...keep, ...fill] });
    await reloadCommit();
    x = await createC(tAdmin, { name: 'T82 101' });
    assert(x.status === 409 && x.json.code === 'POOL_FULL', `cap 100 ${x.status} ${x.text}`);
    x = await createC(tAdminB, { name: 'T82 B ok' });
    assert(x.status === 201, 'the cap is per agency');
    d = await ctx.getDoc();
    await call('POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: d.users, poolContacts: (d.poolContacts || []).filter((c) => !String(c.id).startsWith(`pc-fill-${ts}`)) });
    await reloadCommit();
    // the 5.9 freeze also stops new contacts
    d = await ctx.getDoc();
    await call('POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: d.users, poolFrozen: true });
    await reloadCommit();
    x = await createC(tAdmin, { name: 'T82 frozen' });
    assert(x.status === 409 && x.json.code === 'POOL_FROZEN', `frozen ${x.status}`);
    x = await call('POST', '/api/users', auth(tAdmin), { email: E('frozeninv'), name: 'T82 F', role: 'mashgiach', pool: true });
    assert(x.status === 409 && x.json.code === 'POOL_FROZEN', `frozen pool invite ${x.status}`);
    x = await move(tAdmin, U('mash2'), { expectedVenueRev: await revOf(U('mash2')) });
    assert(x.status === 409 && x.json.code === 'POOL_FROZEN', `frozen move ${x.status}`);
    await hook('grant-sweep', { unfreeze: true });
    wsAdmin.close(); wsMash.close(); wsCoord.close();
    details.push('B contacts: duplicates (email hard, phone soft, self-excluded, in-agency only), revision checks, invite/edit/delete/resend lifecycle, accept removes the contact, Team invite links, pool:true, cap 100 per agency, freeze, POOL_UPDATED admins only, no contact bytes elsewhere, agency export');

    // ===== C: move-to-pool =====
    const r3 = await revOf(U('mash3'));
    for (const t of [tCoord, tOwner, tMash]) assert((await move(t, U('mash3'), { expectedVenueRev: r3 })).status === 403, 'non-admin move 403');
    x = await move(tAdminB, U('mash3'), { expectedVenueRev: r3 });
    assert(x.status === 404, `another agency admin 404 ${x.status}`);
    x = await move(tAdmin, U('mash3'), { expectedVenueRev: r3, dryRun: true });
    assert(x.status === 200 && x.json.dryRun === true && x.json.openWork.tasks.length === 1 && x.json.openWork.events.length === 1 && J(x.json.venueIds) === J([]), `dry run lists open work ${x.status} ${x.text.slice(0, 300)}`);
    assert((await rec(U('mash3'))).venueId === V1 && (await revOf(U('mash3'))) === r3, 'dry run writes nothing');
    x = await move(tAdmin, U('mash3'), { expectedVenueRev: r3 + 7 });
    assert(x.status === 409 && x.json.code === 'VENUES_CHANGED', `venueRev check ${x.status}`);
    x = await move(tAdmin, U('mash3'), { expectedVenueRev: r3 });
    assert(x.status === 200, `move ${x.status} ${x.text.slice(0, 200)}`);
    let m3 = await rec(U('mash3'));
    assert(m3.noHomeVenue === true && m3.venueId === '' && J(m3.venueAccess) === J([]) && m3.venueHistory[0].why === 'moved_to_pool' && m3.venueHistory[0].venueId === V1 && m3.venueRev === r3 + 1, `moved ${J(m3)}`);
    const tM3 = await mint(U('mash3'));
    x = await call('GET', `/api/tasks`, auth(tM3));
    assert(x.status !== 200 || !(x.json?.tasks || []).length, `Pool member: no tasks ${x.status} ${x.text.slice(0, 160)}`);
    x = await pool(tCoord);
    const m3c = x.json.members.find((m) => m.id === U('mash3'));
    assert(m3c && m3c.lastVenueName === 'T82 V1' && keys(m3c) === 'id,lastVenueId,lastVenueName,lastVenueTo,name,role,venueRevision', `coordinator sees name + last venue ${J(m3c)}`);
    x = await pool(tAdmin);
    const m3a = x.json.members.find((m) => m.id === U('mash3'));
    assert(m3a && m3a.email === E('mash3') && m3a.lastVenueName === 'T82 V1', 'admin sees the manager view + last venue');
    x = await move(tAdmin, U('mash3'), { expectedVenueRev: r3 + 1 });
    assert(x.status === 409 && x.json.code === 'ALREADY_IN_POOL', `already in Pool ${x.status}`);
    x = await call('PUT', `/api/users/${U('mash3')}/venues`, auth(tAdmin), { venueIds: [V1], expectedVersion: await V() });
    assert(x.status === 400 && x.json.code === 'POOL_MEMBER_NEEDS_REFRESH', `old sheet save on a Pool member ${x.status} ${x.text}`);
    x = await move(tAdmin, U('adminA'), { expectedVenueRev: 0 });
    assert(x.status === 400 && x.json.code === 'TARGET_IS_ADMIN', 'admins never move to the Pool');
    x = await ops(tOwner, U('mash3'), [{ op: 'add', venueId: V1, until: null }], r3 + 1);
    assert(x.status === 403 && x.json.code === 'VENUE_NOT_IN_SCOPE', `owner of V3 cannot tick into V1 ${x.status}`);
    x = await ops(tCoord, U('mash3'), [{ op: 'add', venueId: V1, until: null }], r3 + 1);
    assert(x.status === 200, `coordinator ticks a Pool member into their own venue ${x.status} ${x.text}`);
    details.push('C move-to-pool: admin only, dry run lists open work and writes nothing, venueRev check, history, empty scope, last venue for owners/coordinators, already in Pool, old sheet 400, coordinator tick into own venue');

    // ===== D: make-main =====
    let rv = await revOf(U('mash3'));
    for (const t of [tCoord, tOwner]) assert((await main(t, U('mash3'), { venueId: V2, keepOldMainAsExtra: false, expectedVenueRev: rv })).status === 403, 'non-admin make-main 403');
    x = await main(tAdmin, U('mash3'), { venueId: V2, expectedVenueRev: rv });
    assert(x.status === 400, 'keepOldMainAsExtra is required');
    x = await main(tAdmin, U('mash3'), { venueId: VB, keepOldMainAsExtra: false, expectedVenueRev: rv });
    assert(x.status === 400 && x.json.code === 'VENUE_NOT_IN_AGENCY', `another agency venue ${x.status}`);
    x = await main(tAdmin, U('mash3'), { venueId: V2, keepOldMainAsExtra: false, expectedVenueRev: rv, dryRun: true });
    assert(x.status === 200 && J(x.json.venueIds) === J([V2, V1]) && x.json.mainVenueId === V2 && (await revOf(U('mash3'))) === rv, `dry run ${x.text.slice(0, 200)}`);
    x = await main(tAdmin, U('mash3'), { venueId: V2, keepOldMainAsExtra: false, expectedVenueRev: rv });
    assert(x.status === 200, `make-main from the Pool ${x.status} ${x.text}`);
    m3 = await rec(U('mash3'));
    assert(m3.venueId === V2 && J(m3.venueAccess) === J([V2, V1]) && m3.noHomeVenue === undefined && m3.venueRev === rv + 1, `main V2, tick V1 kept ${J(m3)}`);
    x = await main(tAdmin, U('mash3'), { venueId: V2, keepOldMainAsExtra: true, expectedVenueRev: rv + 1 });
    assert(x.status === 409 && x.json.code === 'ALREADY_MAIN', 'already main');
    x = await main(tAdmin, U('mash3'), { venueId: V3, keepOldMainAsExtra: true, expectedVenueRev: rv + 1 });
    m3 = await rec(U('mash3'));
    assert(x.status === 200 && m3.venueId === V3 && J([...m3.venueAccess].sort()) === J([V1, V2, V3].sort()) && !(m3.venueGrants || {})[V2], `keep old main as an undated extra ${J(m3)}`);
    x = await main(tAdmin, U('mash3'), { venueId: V1, keepOldMainAsExtra: false, expectedVenueRev: rv + 2 });
    m3 = await rec(U('mash3'));
    assert(x.status === 200 && m3.venueId === V1 && !m3.venueAccess.includes(V3) && m3.venueHistory.some((h) => h.venueId === V3 && h.why === 'main_replaced') && m3.venueHistory[0].why === 'made_main', `drop old main into history ${J(m3)}`);
    details.push('D make-main: from the Pool, keep/drop the old main, ticks kept, refusals, dry run');

    // ===== E: borrow list =====
    x = await call('GET', '/api/pool/borrow', auth(tCoord));
    assert(x.status === 200, `coord borrow list ${x.status}`);
    let ids = x.json.people.map((p) => p.id);
    assert(ids.includes(U('mash2')) && !ids.includes(U('mash')) && !ids.includes(U('mash3')) && !ids.includes(U('mashB')) && !ids.includes(U('owner')), `coordinator V1: other venues only ${J(ids)}`);
    assert(x.json.people.every((p) => keys(p) === 'homeVenueId,homeVenueName,id,name,venueRevision') && !x.text.includes('@') && !x.text.includes('+1860'), `name + main venue only ${x.text.slice(0, 300)}`);
    assert(x.json.people.find((p) => p.id === U('mash2')).homeVenueName === 'T82 V2', 'home venue name');
    x = await call('GET', '/api/pool/borrow', auth(tOwner));
    ids = x.json.people.map((p) => p.id);
    assert(x.status === 200 && ids.includes(U('mash')) && ids.includes(U('mash2')) && ids.includes(U('mash3')), `owner V3 sees V1/V2 people ${J(ids)}`);
    x = await call('GET', '/api/pool/borrow', auth(tMash));
    assert(x.status === 403 && !x.text.includes('T82'), 'mashgiach 403');
    const r2 = await revOf(U('mash2'));
    x = await ops(tCoord, U('mash2'), [{ op: 'add', venueId: V1, until: null }], r2);
    assert(x.status === 400 && x.json.code === 'UNTIL_REQUIRED', `borrow needs an end date ${x.status} ${x.text}`);
    x = await ops(tCoord, U('mash2'), [{ op: 'add', venueId: V1, until: ymd(5) }], r2);
    assert(x.status === 200, `borrow with an end date ${x.status} ${x.text}`);
    const b2 = await rec(U('mash2'));
    assert(b2.venueId === V2 && b2.venueAccess.includes(V1) && typeof b2.venueGrants?.[V1]?.until === 'string', `loan recorded, main venue untouched ${J(b2)}`);
    details.push('E borrow list: name + main venue only, other venues only, end date required, mashgiach 403');

    // ===== F: venue history keeps 2 weeks =====
    d = await ctx.getDoc();
    const now = Date.now();
    const H = (v, ago, why) => ({ venueId: v, from: null, to: new Date(now - ago * 86400000).toISOString(), why, by: null });
    const hist = [H(V2, 3, 'unticked'), H(V3, 13.9, 'ended'), H(V2, 14.1, 'unticked'), H(V3, 40, 'ended')];
    const mrow = d.users.find((u) => u.id === U('mash'));
    await call('POST', '/api/__test__/doc-set-users', ctx.authHeaders, { users: d.users.map((u) => (u.id === U('mash') ? { ...u, venueRev: 4, venueHistory: hist } : u)) });
    await reloadCommit();
    const before = await rec(U('mash'));
    assert(before.venueHistory.length === 4 && before.venueRev === 4, `seeded ${J(before)}`);
    let sw = await hook('grant-sweep', { runNow: true });
    const after = await rec(U('mash'));
    assert(sw.run?.committed === true && after.venueHistory.length === 2 && after.venueHistory.every((h) => Date.parse(h.to) > now - 14 * 86400000), `sweep dropped entries older than 14 days ${J(after.venueHistory)}`);
    assert(after.venueRev === 4 && J(after.venueAccess) === J(mrow.venueAccess ?? before.venueAccess) && after.venueId === V1, `venueRev and access unchanged ${J(after)}`);
    const v1 = await V();
    sw = await hook('grant-sweep', { runNow: true });
    assert(sw.run?.committed === false && (await V()) === v1, `second sweep writes nothing ${J(sw)}`);
    details.push('F venue history: entries 14+ days old dropped by the sweep, newer kept, venueRev/access unchanged, second sweep writes nothing');
    console.log('  ' + details.join('\n  '));
  },
};
