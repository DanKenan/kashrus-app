/**
 * Test 68 (10i): invite-only adds, venue-owner invites, public preview/accept
 * (design v3 [10I-DS3]; v3.1: NO recovery codes anywhere).
 *  U  POST /api/users: flag OFF = a row as today; flag ON = an invite (no row,
 *     password ignored), the same 201 for an unknown and another agency's
 *     email, own team 409, role 'owner' 400.
 *  V  POST /api/venues flag ON: venue + owner invite in ONE commit (the invite
 *     names the new venue); an email of another agency gets the same shape;
 *     a fresh refusal (caller demoted in the stored doc) writes neither.
 *  P  preview: header only, 404 for unknown / revoked / flag OFF; never a
 *     hint whether the email has an account.
 *  N  accept 'new': row with origin invite-new, login works; email taken ->
 *     generic 401 that writes only the counter; used link 404.
 *  X  accept 'existing': wrong password generic 401 (counter only); a
 *     non-linkable credential with the right password 403 (nothing written,
 *     not counted); a linkable one -> credential-free membership, owner marked,
 *     E1 (old tokens 401), choose response, no recovery codes; retry 404.
 *  F  5 failed accepts revoke the invite.
 *  H  an invite made through POST /api/agency/invites is accepted end to end;
 *     flag OFF (fresh) -> 404, nothing created; after a link, flag OFF keeps
 *     the person's writes working (N2).
 *  S  no token or hash in the stored doc (raw), GET lists, admin export, WS.
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

export default {
  name: 'Test 68: invite-only adds + preview/accept (10i)',
  whatItProves:
    'With Phase C ON an admin adds people and venue owners only through invites (no admin-set password, one answer for unknown and other-agency emails); the public invite page never reveals whether an email has an account; accepting creates an invite-new person or, with the existing password of a linkable credential, a credential-free membership with E1; failures write only the counter; consumed links are dead; no recovery codes.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t68a-${ts}`, B = `agency-t68b-${ts}`;
    const A1 = `venue-t68-a1-${ts}`, A2 = `venue-t68-a2-${ts}`, B1 = `venue-t68-b1-${ts}`;
    const U = (k) => `user-t68-${k}-${ts}`;
    const E = (k) => `t68-${k}-${ts}@test.local`;
    const PW = 'stage2-t68-password';
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.68.${ts % 200}.${ipN++}` });
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const doc = () => ctx.getDoc();
    const rows = async () => ((await doc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const invitesOf = async () => ((await doc()).invites || []);
    const rehydrate = async (k) => assert((await hook('inject-fixture', { venues: [{ id: `venue-t68-h${k}-${Date.now()}`, name: 'T68 hydrate', agencyId: B }] })).status === 200, `rehydrate ${k}`);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const flag = async (agencyId, enabled) => assert((await hook('phase-c', { agencyId, enabled })).status === 200, `phase-c ${agencyId} ${enabled}`);
    const addMember = (t, body) => call('POST', '/api/users', auth(t), body);
    const preview = (token, extra = {}) => call('GET', '/api/invites/preview', { ...ipH(), ...(token === undefined ? {} : { 'X-Invite-Token': token }), ...extra });
    const accept = (token, mode, password) => call('POST', '/api/invites/accept', ipH(), { token, mode, password });
    const tokenOf = (link) => { const m = /^\/invite#t=([A-Za-z0-9_-]{43})$/.exec(link || ''); assert(m, `link shape ${link}`); return m[1]; };
    const withoutInvite = (d, id) => J({ ...d, invites: (d.invites || []).filter((i) => i.id !== id), _v: 0, savedAt: 0 }); // version stamp fields excluded

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T68 A ${ts}`, timeZone: 'America/New_York' }, { id: B, name: `T68 B ${ts}`, timeZone: 'America/New_York' }],
      venues: [{ id: A1, name: `T68 A1 ${ts}`, agencyId: A }, { id: A2, name: `T68 A2 ${ts}`, agencyId: A }, { id: B1, name: `T68 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T68 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T68 Admin B', role: 'admin', agencyId: B },
        { id: U('maA'), email: E('maa'), name: 'T68 Mash A', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('xB'), email: E('xb'), name: 'T68 X (B, linkable)', role: 'mashgiach', agencyId: B, venueId: B1 },
        { id: U('lB'), email: E('lb'), name: 'T68 L (B, legacy)', role: 'mashgiach', agencyId: B, venueId: B1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    for (const id of [U('xB'), U('lB')]) assert((await hook('set-password', { userId: id, password: PW })).status === 200, `set-password ${id}`);
    {
      const users = (await rows()).map((u) => (u.id === U('xB') ? { ...u, credentialOrigin: 'self-registered' } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'plant origin');
      await rehydrate('0');
    }
    const tA = await mintToken(baseUrl, U('adA'));
    const tB = await mintToken(baseUrl, U('adB'));

    // ---- U: POST /api/users ----
    {
      const off = await addMember(tA, { email: E('off1'), name: 'Off One', role: 'mashgiach', venueId: A1, password: 'stage2-t68-off' });
      assert((off.status === 200 || off.status === 201) && off.json?.id || off.json?.user, `U flag OFF creates a row as today: ${off.status} ${off.text.slice(0, 120)}`);
      assert((await rows()).some((u) => u.email === E('off1')), 'U flag OFF row exists');
      await flag(A, true);
      await flag(B, true);
      const n0 = (await rows()).length;
      const unknown = await addMember(tA, { email: E('new1'), name: 'New One', role: 'mashgiach', venueId: A1, phoneNumber: '+12025550123', password: 'admin-chosen-secret' });
      const other = await addMember(tA, { email: E('xb'), name: 'X Again', role: 'coordinator', venueId: A2 });
      assert(unknown.status === 201 && other.status === 201, `U flag ON 201s: ${unknown.status} ${other.status} ${other.text.slice(0, 120)}`);
      assert(unknown.json.pending === true && /no-store/.test(unknown.headers.get('cache-control') || ''), 'U pending + no-store');
      const shape = (r) => J({ k: Object.keys(r.json).sort(), i: Object.keys(r.json.invite).sort() });
      assert(shape(unknown) === shape(other), 'U same shape for unknown and another agency\'s email');
      assert((await rows()).length === n0, 'U flag ON: no row created');
      const rec = (await invitesOf()).find((i) => i.id === unknown.json.invite.id);
      assert(rec && rec.kind === 'member' && rec.name === 'New One' && rec.phoneNumber === '+12025550123' && J(rec.venueIds) === J([A1]) && rec.permissions?.canFillTasks === true && rec.permissions?.canAssignTasks === false, `U profile captured ${J(rec && { n: rec.name, p: rec.phoneNumber, v: rec.venueIds, pm: rec.permissions })}`);
      assert(!J(await doc()).includes('admin-chosen-secret'), 'U the body password is never stored');
      const v0 = await ctx.getVersion();
      const own = await addMember(tA, { email: ` ${E('maa').toUpperCase()}`, name: 'Dup', role: 'mashgiach' });
      assert(own.status === 409 && own.json?.error === 'A team member with this email already exists', `U own team 409: ${own.status} ${own.text.slice(0, 120)}`);
      const owner = await addMember(tA, { email: E('own1'), name: 'Owner Body', role: 'owner' });
      assert(owner.status === 400 && owner.json?.code === 'INVITE_ROLE_INVALID', `U role owner 400: ${owner.status}`);
      const ownerInv = await call('POST', '/api/agency/invites', auth(tA), { email: E('own2'), name: 'Owner Body', role: 'owner', venueIds: [A1], expectedVersion: await ctx.getVersion() });
      assert(ownerInv.status === 400 && ownerInv.json?.code === 'INVITE_ROLE_INVALID', `U invites route role owner 400: ${ownerInv.status}`);
      await unchanged(v0, 'U refusals');
      console.log('  ✓ U flag OFF creates a row; flag ON: invite only (no row, password ignored), same 201 for unknown/other-agency email, own team 409, owner role 400');
    }

    // ---- V: venue + owner invite atomically ----
    {
      const v0 = await ctx.getVersion();
      const r = await call('POST', '/api/venues', auth(tA), { name: `T68 New Venue ${ts}`, ownerEmail: E('owner-new'), ownerName: 'Olive Owner', ownerPassword: 'admin-owner-secret' });
      assert(r.status === 201 && r.json.owner === null && r.json.ownerInvite && /^\/invite#t=/.test(r.json.ownerInviteLink || ''), `V 201 with owner invite: ${r.status} ${r.text.slice(0, 160)}`);
      assert((await ctx.getVersion()) === v0 + 1, 'V one commit');
      const d = await doc();
      const venue = (d.venues || []).find((v) => v.id === r.json.venue.id);
      const inv = (d.invites || []).find((i) => i.id === r.json.ownerInvite.id);
      assert(venue && venue.agencyId === A, 'V venue in the caller\'s agency');
      assert(inv && inv.role === 'owner' && J(inv.venueIds) === J([venue.id]) && inv.name === 'Olive Owner', `V invite names the new venue ${J(inv && { r: inv.role, v: inv.venueIds })}`);
      assert(!(d.users || []).some((u) => u.email === E('owner-new')) && !J(d).includes('admin-owner-secret'), 'V no owner row, no password');
      const r2 = await call('POST', '/api/venues', auth(tA), { name: `T68 Venue X ${ts}`, ownerEmail: E('adb') });
      assert(r2.status === 201 && J(Object.keys(r2.json).sort()) === J(Object.keys(r.json).sort()), `V another agency's email -> same shape (${r2.status} ${r2.text.slice(0, 120)})`);
      // fresh refusal: caller demoted in the stored doc only (cached gate passes)
      const users0 = await rows();
      assert((await hook('doc-set-users', { users: users0.map((u) => (u.id === U('adA') ? { ...u, role: 'coordinator', venueId: A1 } : u)) })).status === 200, 'V plant');
      const v1 = await ctx.getVersion();
      const venuesBefore = J((await doc()).venues), invitesBefore = J(await invitesOf());
      const r3 = await call('POST', '/api/venues', auth(tA), { name: `T68 Venue R ${ts}`, ownerEmail: E('owner-r') });
      assert(r3.status === 403, `V fresh refusal 403: ${r3.status} ${r3.text.slice(0, 120)}`);
      await unchanged(v1, 'V rollback');
      assert(J((await doc()).venues) === venuesBefore && J(await invitesOf()) === invitesBefore, 'V neither venue nor invite written');
      assert((await hook('doc-set-users', { users: users0 })).status === 200, 'V restore');
      await rehydrate('v');
      console.log('  ✓ V venue + owner invite in one commit (invite names the new venue); other-agency email same shape; fresh refusal writes neither');
    }

    // ---- P: preview ----
    let tNew;
    {
      const c = await addMember(tA, { email: E('n-new'), name: 'Nora New', role: 'mashgiach', venueId: A2 });
      tNew = tokenOf(c.json.link);
      const p = await preview(tNew);
      assert(p.status === 200 && J(Object.keys(p.json).sort()) === J(['agencyName', 'kind', 'name', 'role']) && p.json.name === 'Nora New' && p.json.agencyName === `T68 A ${ts}`, `P preview ${p.status} ${p.text.slice(0, 160)}`);
      assert(/no-store/.test(p.headers.get('cache-control') || ''), 'P no-store');
      const pq = await call('GET', `/api/invites/preview?token=${tNew}`, ipH());
      assert(pq.status === 404, `P token in the query is not read (${pq.status})`);
      const px = await addMember(tA, { email: E('xb'), name: 'X Again', role: 'mashgiach', venueId: A1 });
      const pX = await preview(tokenOf(px.json.link));
      assert(pX.status === 200 && J(Object.keys(pX.json).sort()) === J(Object.keys(p.json).sort()), 'P an email with an account previews identically');
      const bad = await preview('A'.repeat(43));
      assert(bad.status === 404 && bad.json?.error === 'This invite link is not valid anymore.', `P unknown 404 (${bad.status})`);
      console.log('  ✓ P preview by header only, same keys whether or not the email has an account, unknown 404, no-store');
    }

    // ---- N: accept new ----
    {
      const short = await accept(tNew, 'new', 'short');
      assert(short.status === 400 && short.json?.code === 'PASSWORD_TOO_SHORT', `N short password 400 (${short.status})`);
      const r = await accept(tNew, 'new', 'nora-own-password');
      assert(r.status === 200 && r.json.success === true && typeof r.json.token === 'string' && r.json.user?.email === E('n-new') && !('recoveryCodes' in r.json), `N accept new: ${r.status} ${r.text.slice(0, 160)}`);
      const nora = (await rows()).find((u) => u.email === E('n-new'));
      assert(nora && nora.agencyId === A && nora.role === 'mashgiach' && nora.venueId === A2 && nora.credentialOrigin === 'invite-new' && nora.name === 'Nora New', `N row ${J(nora && { a: nora.agencyId, v: nora.venueId, o: nora.credentialOrigin })}`);
      const login = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E('n-new'), password: 'nora-own-password' });
      assert(login.status === 200 && login.json.token, `N login works (${login.status})`);
      const again = await accept(tNew, 'new', 'nora-own-password');
      assert(again.status === 404, `N used link 404 (${again.status})`);
      assert((await preview(tNew)).status === 404, 'N used link preview 404');
      // email taken -> generic 401, only the counter is written
      const c = await addMember(tA, { email: E('lb'), name: 'L Again', role: 'mashgiach', venueId: A1 });
      const tL = tokenOf(c.json.link);
      const before = await doc();
      const f = await accept(tL, 'new', 'some-new-password');
      assert(f.status === 401 && f.json?.code === 'INVITE_ACCEPT_FAILED', `N taken email generic 401 (${f.status})`);
      const after = await doc();
      const diffKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => k !== 'invites' && J(before[k]) !== J(after[k]));
      assert(withoutInvite(after, c.json.invite.id) === withoutInvite(before, c.json.invite.id), `N failure writes nothing but the invite (differs: ${diffKeys.join(',')})`);
      assert((after.invites || []).find((i) => i.id === c.json.invite.id).failedAttempts === 1, 'N counter +1');
      console.log('  ✓ N new person: invite-new row, login works, used link 404; taken email -> generic 401 writing only the counter');

      // ---- X: existing ----
      const wrong = await accept(tL, 'existing', 'not-the-password');
      assert(wrong.status === 401 && wrong.text === f.text, `X wrong password = same generic 401 (${wrong.status})`);
      const v0 = await ctx.getVersion();
      const nl = await accept(tL, 'existing', PW);
      assert(nl.status === 403 && nl.json?.code === 'INVITE_ACCOUNT_NOT_LINKABLE', `X legacy credential + right password 403 (${nl.status} ${nl.text.slice(0, 120)})`);
      await unchanged(v0, 'X not linkable');
      assert((await invitesOf()).find((i) => i.id === c.json.invite.id).failedAttempts === 2 && (await invitesOf()).find((i) => i.id === c.json.invite.id).status === 'pending', 'X 403 not counted, invite not consumed');
    }
    {
      const c = await addMember(tA, { email: ` ${E('xb').toUpperCase()}`, name: 'X in A', role: 'coordinator', venueId: A1 });
      const tX = tokenOf(c.json.link);
      const oldTok = await mintToken(baseUrl, U('xB'));
      assert((await call('GET', '/api/agencies/current', auth(oldTok))).status === 200, 'X old token valid before');
      const r = await accept(tX, 'existing', PW);
      assert(r.status === 200 && r.json.chooseMembership === true && Array.isArray(r.json.memberships) && r.json.memberships.length === 2 && typeof r.json.token === 'string' && !('recoveryCodes' in r.json), `X joined -> choose response: ${r.status} ${r.text.slice(0, 200)}`);
      assert(!J(r.json).toLowerCase().includes('recovery'), 'X no recovery codes in the response');
      const all = await rows();
      const xB = all.find((u) => u.id === U('xB'));
      const xA = all.find((u) => u.email === xB.email && u.agencyId === A);
      assert(xA && xA.personId === xB.personId && xA.password === undefined && xA.credentialOwner === undefined && xA.role === 'coordinator' && xA.venueId === A1, `X membership row credential-free ${J(xA && { p: xA.personId === xB.personId, pw: !!xA.password, o: xA.credentialOwner })}`);
      assert(xB.credentialOwner === true && typeof xB.password === 'string' && xB.credentialOrigin === 'self-registered' && xB.recoveryCodeHashes === undefined, `X owner marked, no codes ${J({ o: xB.credentialOwner, c: !!xB.recoveryCodeHashes })}`);
      assert((await call('GET', '/api/agencies/current', auth(oldTok))).status === 401, 'X E1: old token 401');
      const login = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E('xb'), password: PW });
      assert(login.status === 200 && login.json.chooseMembership === true, `X login now chooses (${login.status})`);
      assert((await accept(tX, 'existing', PW)).status === 404, 'X retry of a consumed link 404');
      console.log('  ✓ X existing: wrong password generic 401; legacy credential 403 (not counted, not consumed); linkable -> credential-free membership, owner marked, E1, choose response, no codes; retry 404');
    }

    // ---- F: 5 failures revoke ----
    {
      const c = await addMember(tA, { email: E('f5'), name: 'Five', role: 'mashgiach', venueId: A1 });
      const t5 = tokenOf(c.json.link);
      for (let k = 0; k < 5; k++) assert((await accept(t5, 'existing', `wrong-${k}-password`)).status === 401, `F failure ${k}`);
      const inv = (await invitesOf()).find((i) => i.id === c.json.invite.id);
      assert(inv.status === 'revoked' && inv.revokeReason === 'too-many-attempts', `F revoked after 5 (${inv.status})`);
      assert((await accept(t5, 'new', 'a-valid-password')).status === 404, 'F revoked link 404');
      console.log('  ✓ F 5 failed accepts revoke the invite');
    }

    // ---- H: 10h route invite accepted; flag OFF fresh -> 404; N2 ----
    {
      const c = await call('POST', '/api/agency/invites', auth(tA), { email: E('h1'), name: 'Hana', role: 'mashgiach', venueIds: [A1, A2], expectedVersion: await ctx.getVersion() });
      assert(c.status === 201, `H 10h route create ${c.status} ${c.text.slice(0, 120)}`);
      const r = await accept(tokenOf(c.json.link), 'new', 'hana-own-password');
      assert(r.status === 200, `H 10h-route invite accepted (${r.status} ${r.text.slice(0, 120)})`);
      const hana = (await rows()).find((u) => u.email === E('h1'));
      assert(hana && hana.venueId === A1 && J(hana.venueAccess || []) === J([A1, A2]), `H venues carried ${J(hana && hana.venueAccess)}`);
      // flag OFF in the stored doc only: cached preview passes, the commit refuses
      const c2 = await addMember(tA, { email: E('h2'), name: 'Hal', role: 'mashgiach', venueId: A1 });
      const t2 = tokenOf(c2.json.link);
      const users0 = await rows(); const agencies0 = (await doc()).agencies;
      assert((await preview(t2)).status === 200, 'H cached preview still 200');
      assert((await hook('doc-set-users', { users: users0, agencies: agencies0.map((a) => (a.id === A ? { ...a, phaseC: { enabled: false } } : a)) })).status === 200, 'H plant flag OFF');
      const v0 = await ctx.getVersion();
      const off = await accept(t2, 'new', 'hal-own-password');
      assert(off.status === 404, `H fresh flag OFF -> 404 (${off.status})`);
      await unchanged(v0, 'H flag OFF');
      assert(!(await rows()).some((u) => u.email === E('h2')), 'H nothing created');
      assert((await hook('doc-set-users', { users: users0, agencies: agencies0 })).status === 200, 'H restore');
      await rehydrate('h');
      // N2: flag OFF after a link; the multi person's writes still succeed
      await flag(A, false);
      const tXA = await (async () => { const all = await rows(); const xa = all.find((u) => u.email === E('xb') && u.agencyId === A); return mintToken(baseUrl, xa.id); })();
      const w2 = await call('POST', '/api/auth/change-password', auth(tXA), { currentPassword: PW, newPassword: 'stage2-t68-pw2' });
      assert(w2.status === 200, `H N2: a write by the multi person after flag OFF succeeds (${w2.status} ${w2.text.slice(0, 120)})`);
      await flag(A, true);
      console.log('  ✓ H 10h-route invite accepted with both venues; fresh flag OFF -> 404, nothing created; flag OFF after a link keeps writes working (N2)');
    }

    // ---- S: no secrets anywhere ----
    {
      const c = await addMember(tA, { email: E('s1'), name: 'Sam', role: 'mashgiach', venueId: A1 });
      const raw = tokenOf(c.json.link);
      const stored = (await invitesOf()).find((i) => i.id === c.json.invite.id);
      assert(stored.inviteTokenHash === sha(raw), 'S sha256 stored');
      const docText = J(await doc());
      assert(!docText.includes(raw), 'S raw token not in the stored doc');
      const g = await call('GET', '/api/agency/invites', auth(tA));
      const ex = await call('GET', '/api/admin/export', auth(tA));
      const us = await call('GET', '/api/users', auth(tA));
      for (const [label, t] of [['GET invites', g.text], ['export', ex.text], ['users', us.text]]) {
        assert(!t.includes(stored.inviteTokenHash) && !t.includes('inviteTokenHash') && !t.includes(raw), `S ${label} has no token/hash`);
      }
      console.log('  ✓ S no raw token or hash in the stored doc text, GET lists, users or the admin export');
    }
    await flag(A, false);
    await flag(B, false);
    return 'invite-only adds and venue-owner invites (atomic, no admin-set password, one answer for other-agency emails); header-only preview without account hints; accept new (invite-new) / existing (password + linkable, credential-free membership, owner marked, E1, choose response, no recovery codes); failures write only the counter, 5 revoke; consumed / revoked / flag-OFF links 404; no secrets leak';
  },
};
