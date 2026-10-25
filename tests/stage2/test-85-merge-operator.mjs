/**
 * Test 85 (MERGE-FIX, files/shutfey-mergefix-plan.txt v3): the owner merges
 * his OWN two accounts. The pinned platform operator row (usr_admin, absent
 * credentialOrigin as on live) may be the SURVIVOR through merge-into only
 * (its password typed in this request); it is never retired; every other
 * protection stays.
 *  R  refusals, nothing written: operator survivor via bring-in (session only)
 *     -> MERGE_USE_MERGE_INTO; operator retired (both routes, absent and
 *     linkable origin); operator origin admin / agency-reset; retired legacy /
 *     admin origin; wrong operator password; wrong own password; non-operator
 *     legacy survivor.
 *  F  fresh-only plants (stored doc changed, cache not): operator hash, role,
 *     agency, origin; retired credentialPending / resetSuspended; survivor
 *     resetSuspended -> refused, nothing written.
 *  S  Don-like success: a self-registered second-agency admin merges INTO the
 *     operator (merge-into). Moved row: operator's person + email, no
 *     credential; operator row unchanged except owner marker + epoch; old
 *     sessions die; the returned token (moved row) is NOT an operator; the
 *     chooser activates HKC -> operator, NHK -> not; recovery codes refused
 *     from both memberships; the retired login and its old codes are dead;
 *     kiosk tokens never operator.
 *  L  reset links never write the operator credential: creation refused for
 *     the moved membership; a crafted, otherwise valid live link -> preview and
 *     accept refused, nothing about the operator written; fresh-only creation
 *     (membership moved into the operator person in the stored doc only) -> 409.
 *  I  membership isolation: a second NHK admin sets a PIN on the moved
 *     membership; deleting it is refused (existing rule: a row with the
 *     operator email is never deleted); the operator row and its HKC session
 *     are untouched.
 * Demo data only.
 */
import crypto from 'node:crypto';

const J = (o) => JSON.stringify(o);
async function req(baseUrl, method, path, { token, ip, body, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function assert(c, m) { if (!c) throw new Error(m); }
const CRED_FIELDS = ['password', 'credentialOwner', 'credentialOrigin', 'credentialPending', 'recoveryCodeHashes', 'recoveryFailures'];
const OP_ID = 'usr_admin';
const OP_EMAIL = 'kenan@hartfordkashrut.org'; // the seed operator row (harness)
const OP_PW = 'stage2-test-password'; // set by the harness (run-all.mjs adminLogin)
const OP_ROUTE = '/api/admin/per-entity-status'; // read-only, operator-only (requirePlatformOperator)
const FORBIDDEN = 'Only the platform operator can perform this action.';

export default {
  name: 'Test 85: MERGE-FIX — the platform operator may survive a merge (merge-into only), never be retired',
  whatItProves:
    'The owner can merge a self-registered account into the pinned operator account with both passwords typed in the same request; bring-in with only the session, the operator as retired, non-linkable origins, stale data and wrong passwords stay refused; operator powers stay on the operator row only; reset links and membership actions can never reach the operator credential.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.85.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t85-${k}-${ts}@demo.test`;
    const PW = (k) => `Pass-85-${k}!`;
    const doc = () => ctx.getDoc();
    const ver = () => ctx.getVersion();
    const unchanged = async (v0, label) => { const v1 = await ver(); assert(v1 === v0, `${label}: version moved ${v0} -> ${v1}`); };
    const op = () => `op-${crypto.randomUUID()}`;
    const details = [];
    const hook = async (path, body) => ctx.api('POST', `/api/__test__/${path}`, body);
    const harnessToken = () => String(ctx.authHeaders.Authorization || '').replace(/^Bearer /, '');
    let hk = 0;
    const rehydrate = async () => assert((await hook('inject-fixture', { venues: [{ id: `venue-t85-h${hk++}-${ts}`, name: 'T85 hydrate', agencyId: 'agency-hkc' }] })).status === 200, 'rehydrate');
    const setUsers = async (fn, label, { hydrate = true } = {}) => {
      const us = (await doc()).users.map(fn).filter(Boolean);
      assert((await hook('doc-set-users', { users: us })).status === 200, `${label} plant`);
      if (hydrate) await rehydrate();
    };
    const register = async (k) => {
      const r = await req(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), body: { agencyName: `T85 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T85 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      const row = (await doc()).users.find((u) => u.id === r.json.user.id);
      assert(row && row.personId && row.credentialOrigin === 'self-registered', `register ${k} row`);
      return { token: r.json.token, id: row.id, pid: row.personId, agencyId: row.agencyId, email: E(k), pw: PW(k) };
    };
    const bringIn = (token, email, password) =>
      req(baseUrl, 'POST', '/api/account/bring-in', { token, ip: ip(), body: { email, password, confirm: true, operationId: op() } });
    const mergeInto = (token, email, password, currentPassword) =>
      req(baseUrl, 'POST', '/api/account/merge-into', { token, ip: ip(), body: { email, password, currentPassword, confirm: true, operationId: op() } });
    const current = (token) => req(baseUrl, 'GET', '/api/agencies/current', { token });
    const login = (email, password) => req(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email, password } });
    const opRoute = (token) => req(baseUrl, 'GET', OP_ROUTE, { token });
    const isOperatorAnswer = (r) => r.status !== 403 && r.status !== 401 && r.json?.error !== FORBIDDEN;
    const notLinkable = (r, label) => assert(r.status === 403 && r.json?.code === 'ACCOUNT_NOT_LINKABLE', `${label}: ${r.status} ${J(r.json)}`);

    // ---- fixture: the operator row as on live after 8c (personId, bcrypt, NO credentialOrigin)
    const opRow0 = (await doc()).users.find((u) => u.id === OP_ID);
    assert(opRow0 && opRow0.agencyId === 'agency-hkc' && opRow0.role === 'admin' && /^\$2[aby]\$/.test(opRow0.password), `operator fixture: ${J(opRow0 && { a: opRow0.agencyId, r: opRow0.role })}`);
    await setUsers((u) => { if (u.id !== OP_ID) return u; const x = { ...u, personId: u.personId || OP_ID }; delete x.credentialOrigin; return x; }, 'op legacy');
    const opBase = (await doc()).users.find((u) => u.id === OP_ID);
    const OP_PID = opBase.personId;
    assert(opBase.credentialOrigin === undefined && OP_PID, 'operator row is legacy (absent origin) with a personId');
    assert(isOperatorAnswer(await opRoute(harnessToken())), 'P0: the harness operator session reaches the operator route');
    const restoreOp = async (label) => setUsers((u) => (u.id === OP_ID ? opBase : u), label);

    // ---- R: refusals, nothing written
    {
      const n1 = await register('r1');
      let v0 = await ver();
      const r1 = await bringIn(harnessToken(), n1.email, n1.pw);
      assert(r1.status === 403 && r1.json?.code === 'MERGE_USE_MERGE_INTO' && /Merge into my main account/.test(String(r1.json?.error)), `R operator survivor via bring-in: ${r1.status} ${J(r1.json)}`);
      await unchanged(v0, 'R bring-in');
      const n2 = await register('r2');
      v0 = await ver();
      notLinkable(await bringIn(n2.token, OP_EMAIL, OP_PW), 'R operator retired (bring-in, absent origin)');
      notLinkable(await mergeInto(harnessToken(), n2.email, n2.pw, OP_PW), 'R operator retired (merge-into, absent origin)');
      await unchanged(v0, 'R operator retired');
      // linkable-origin operator: still never retired (E2 is not hidden by the origin guard)
      await setUsers((u) => (u.id === OP_ID ? { ...u, credentialOrigin: 'self-registered' } : u), 'R op linkable');
      v0 = await ver();
      notLinkable(await bringIn(n2.token, OP_EMAIL, OP_PW), 'R operator retired (bring-in, linkable origin)');
      notLinkable(await mergeInto(harnessToken(), n2.email, n2.pw, OP_PW), 'R operator retired (merge-into, linkable origin)');
      const r1l = await bringIn(harnessToken(), n1.email, n1.pw);
      assert(r1l.status === 403 && r1l.json?.code === 'MERGE_USE_MERGE_INTO', `R linkable operator via bring-in: ${r1l.status} ${J(r1l.json)}`);
      await unchanged(v0, 'R linkable operator');
      // operator origin that an admin may know -> never
      const n4 = await register('r4');
      for (const origin of ['admin', 'agency-reset']) {
        await setUsers((u) => (u.id === OP_ID ? { ...u, credentialOrigin: origin } : u), `R op ${origin}`);
        v0 = await ver();
        notLinkable(await mergeInto(n4.token, OP_EMAIL, OP_PW, n4.pw), `R operator origin ${origin}`);
        await unchanged(v0, `R operator origin ${origin}`);
      }
      await restoreOp('R op restored');
      // retired legacy / admin-origin into the operator -> refused
      const n6 = await register('r6');
      const n6b = await register('r6b');
      await setUsers((u) => { if (u.id === n6.id) { const x = { ...u }; delete x.credentialOrigin; return x; } return u.id === n6b.id ? { ...u, credentialOrigin: 'admin' } : u; }, 'R retired legacy/admin');
      v0 = await ver();
      notLinkable(await mergeInto(n6.token, OP_EMAIL, OP_PW, n6.pw), 'R retired legacy into operator');
      notLinkable(await mergeInto(n6b.token, OP_EMAIL, OP_PW, n6b.pw), 'R retired admin-origin into operator');
      await unchanged(v0, 'R retired not linkable');
      // wrong passwords
      const n7 = await register('r7');
      v0 = await ver();
      const w1 = await mergeInto(n7.token, OP_EMAIL, 'wrong-85-pass', n7.pw);
      assert(w1.status === 403 && w1.json?.code === 'MERGE_LOGIN_FAILED', `R wrong operator password: ${w1.status} ${J(w1.json)}`);
      const w2 = await mergeInto(n7.token, OP_EMAIL, OP_PW, 'wrong-85-current');
      assert(w2.status === 403 && w2.json?.code === 'MERGE_CURRENT_PASSWORD_WRONG', `R wrong own password: ${w2.status} ${J(w2.json)}`);
      await unchanged(v0, 'R wrong passwords');
      // a non-operator legacy survivor stays refused
      const s8 = await register('r8s');
      const n8 = await register('r8');
      await setUsers((u) => { if (u.id !== s8.id) return u; const x = { ...u }; delete x.credentialOrigin; return x; }, 'R legacy survivor');
      v0 = await ver();
      notLinkable(await mergeInto(n8.token, s8.email, s8.pw, n8.pw), 'R non-operator legacy survivor');
      notLinkable(await bringIn(s8.token, n8.email, n8.pw), 'R non-operator legacy survivor (bring-in)');
      await unchanged(v0, 'R legacy survivor');
      assert((await current(harnessToken())).status === 200, 'R: the operator session is intact');
      details.push('R: operator survivor via bring-in 403 MERGE_USE_MERGE_INTO; operator retired 403 (both routes, absent + linkable origin); operator origin admin/agency-reset 403; retired legacy/admin 403; wrong operator / own password 403; non-operator legacy survivor 403; nothing written');
    }

    // ---- F: fresh-only plants (stored doc only; the cache keeps the valid state)
    {
      const f = await register('f');
      const other = await register('fo');
      const base = (await doc()).users;
      const otherHash = base.find((u) => u.id === other.id).password;
      const docOnly = async (fn, label) => {
        assert((await hook('doc-set-users', { users: base.map(fn) })).status === 200, `${label} plant`);
      };
      const cases = [
        [(u) => (u.id === OP_ID ? { ...u, password: otherHash } : u), 'operator hash', 409, 'MERGE_STALE'],
        [(u) => (u.id === OP_ID ? { ...u, role: 'coordinator' } : u), 'operator role', 403, 'ACCOUNT_NOT_LINKABLE'],
        [(u) => (u.id === OP_ID ? { ...u, agencyId: other.agencyId } : u), 'operator agency', 403, 'ACCOUNT_NOT_LINKABLE'],
        [(u) => (u.id === OP_ID ? { ...u, credentialOrigin: 'admin' } : u), 'operator origin admin', 403, 'ACCOUNT_NOT_LINKABLE'],
        [(u) => (u.id === OP_ID ? { ...u, credentialOrigin: 'agency-reset' } : u), 'operator origin agency-reset', 403, 'ACCOUNT_NOT_LINKABLE'],
        [(u) => (u.id === f.id ? { ...u, credentialPending: 'invite' } : u), 'retired credentialPending', 403, 'ACCOUNT_NOT_LINKABLE'],
        [(u) => (u.id === f.id ? { ...u, resetSuspended: { linkId: `rl-t85-${ts}`, at: new Date().toISOString(), byAgencyId: other.agencyId } } : u), 'retired paused', 403, 'RESET_CONFIRM_NEEDED'],
        [(u) => (u.id === OP_ID ? { ...u, resetSuspended: { linkId: `rl-t85s-${ts}`, at: new Date().toISOString(), byAgencyId: other.agencyId } } : u), 'survivor paused', 403, 'RESET_CONFIRM_NEEDED'],
      ];
      for (const [fn, label, status, code] of cases) {
        await docOnly(fn, `F ${label}`);
        const v0 = await ver();
        const r = await mergeInto(f.token, OP_EMAIL, OP_PW, f.pw);
        assert(r.status === status && r.json?.code === code, `F ${label}: ${r.status} ${J(r.json)} (want ${status} ${code})`);
        await unchanged(v0, `F ${label}`);
        await docOnly((u) => u, `F ${label} restore`);
      }
      details.push('F: stored-doc-only changes to the operator hash (409), role, agency, origin admin/agency-reset, retired credentialPending, retired/survivor pause -> refused inside the transaction, nothing written');
    }

    // ---- S: Don-like success (merge-into: both passwords typed now)
    const nhk = await register('nhk');
    const nhkHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${nhk.token}` };
    const nhkVenue = { id: `venue-t85-nhk-${ts}`, name: 'T85 NHK Bakery', agencyId: nhk.agencyId };
    assert((await hook('inject-fixture', { venues: [nhkVenue] })).status === 200, 'S NHK venue');
    const nhk2 = { email: E('nhk2'), pw: PW('nhk2') };
    const add2 = await ctx.addMember({ email: nhk2.email, name: 'T85 NHK second admin', role: 'admin', password: nhk2.pw }, nhkHeaders);
    assert(add2.status === 201 && add2.json?.user?.id, `S second NHK admin: ${add2.status} ${J(add2.json)}`);
    const nhk2Login = await login(nhk2.email, nhk2.pw);
    assert(nhk2Login.status === 200 && nhk2Login.json?.token, `S NHK2 login: ${nhk2Login.status}`);
    const nhk2Token = nhk2Login.json.token;
    const codes = await req(baseUrl, 'POST', '/api/auth/recovery-codes', { token: nhk.token, body: { currentPassword: nhk.pw } });
    assert(codes.status === 200 && Array.isArray(codes.json?.codes) && codes.json.codes.length > 0, `S NHK recovery codes before the merge: ${codes.status} ${J(codes.json)}`);
    const nhkCodes = codes.json.codes;
    const oldHarness = harnessToken();
    const before = await doc();
    const opBefore = before.users.find((u) => u.id === OP_ID);
    const nhkBefore = before.users.find((u) => u.id === nhk.id);
    let opToken = null;
    {
      const r = await mergeInto(nhk.token, OP_EMAIL, OP_PW, nhk.pw);
      assert(r.status === 200 && r.json?.merged === true && typeof r.json?.token === 'string', `S merge-into: ${r.status} ${J(r.json)}`);
      assert(r.json.email === OP_EMAIL && r.json.user?.id === nhk.id, `S response: ${J({ e: r.json.email, u: r.json.user?.id })}`);
      const ms = (r.json.memberships || []).map((m) => m.agencyId).sort();
      assert(J(ms) === J(['agency-hkc', nhk.agencyId].sort()), `S memberships: ${J(ms)}`);
      // the harness session died with the merge: sign in again through the chooser (HKC)
      assert((await current(oldHarness)).status === 401, 'S old operator session dead');
      assert((await current(nhk.token)).status === 401, 'S old NHK session dead');
      const la = await login(OP_EMAIL, OP_PW);
      assert(la.status === 200 && la.json?.chooseMembership === true && (la.json.memberships || []).length === 2 && la.json.token, `S operator login: ${la.status} ${J(la.json?.memberships)}`);
      const act = await req(baseUrl, 'POST', '/api/auth/activate', { token: la.json.token, body: { membershipId: OP_ID } });
      assert(act.status === 200 && act.json?.token, `S activate HKC: ${act.status} ${J(act.json)}`);
      opToken = act.json.token;
      ctx.authHeaders.Authorization = `Bearer ${opToken}`; // the suite's own admin session from here on
      const actN = await req(baseUrl, 'POST', '/api/auth/activate', { token: la.json.token, body: { membershipId: nhk.id } });
      assert(actN.status === 200 && actN.json?.token, `S activate NHK: ${actN.status}`);
      // stored rows
      const after = await doc();
      const opAfter = after.users.find((u) => u.id === OP_ID);
      const moved = after.users.find((u) => u.id === nhk.id);
      assert(moved.personId === OP_PID && moved.email === OP_EMAIL && moved.agencyId === nhk.agencyId, `S moved row: ${J({ p: moved.personId, e: moved.email })}`);
      for (const fld of CRED_FIELDS) assert(moved[fld] === undefined, `S moved row keeps ${fld}`);
      for (const fld of ['agencyId', 'role', 'email', 'password', 'personId', 'name']) assert(J(opAfter[fld]) === J(opBefore[fld]), `S operator ${fld} changed`);
      assert(opAfter.credentialOrigin === undefined, 'S operator origin still absent');
      assert(opAfter.credentialOwner === true, 'S operator row is the person\'s credential owner');
      assert((opAfter.tokenEpoch ?? 0) === (opBefore.tokenEpoch ?? 0) + 1 && (moved.tokenEpoch ?? 0) === (nhkBefore.tokenEpoch ?? 0) + 1, 'S epochs +1');
      // operator powers: only the operator row, never the moved row, never a kiosk
      assert(isOperatorAnswer(await opRoute(opToken)), 'S HKC membership (usr_admin) is still the operator');
      const viaMerge = await opRoute(r.json.token);
      assert(viaMerge.status === 403 && viaMerge.json?.error === FORBIDDEN, `S merge token (moved NHK row) is not the operator: ${viaMerge.status}`);
      const viaNhk = await opRoute(actN.json.token);
      assert(viaNhk.status === 403 && viaNhk.json?.error === FORBIDDEN, `S NHK membership is not the operator: ${viaNhk.status}`);
      for (const [userId, agencyId] of [[OP_ID, 'agency-hkc'], [nhk.id, nhk.agencyId]]) {
        const kt = await hook('mint-kiosk-token', { userId, agencyId });
        assert(kt.status === 200 && kt.json?.token, 'S kiosk token minted');
        const kr = await opRoute(kt.json.token);
        assert(kr.status === 401 || (kr.status === 403), `S kiosk token for ${userId} reached the operator route: ${kr.status}`);
      }
      // the retired login, its old recovery codes, and recovery codes for the operator person
      assert((await login(nhk.email, nhk.pw)).status === 401, 'S old NHK login dead');
      const rv = await req(baseUrl, 'POST', '/api/auth/recover', { ip: ip(), body: { email: nhk.email, code: nhkCodes[0], newPassword: 'Pass-85-recover!' } });
      assert(rv.status !== 200 && !rv.json?.token, `S old NHK recovery code still works: ${rv.status}`);
      const rvOp = await req(baseUrl, 'POST', '/api/auth/recover', { ip: ip(), body: { email: OP_EMAIL, code: nhkCodes[1], newPassword: 'Pass-85-recover!' } });
      assert(rvOp.status !== 200 && !rvOp.json?.token, `S NHK code works for the operator email: ${rvOp.status}`);
      for (const [tok, label] of [[opToken, 'HKC'], [actN.json.token, 'NHK']]) {
        const rc = await req(baseUrl, 'POST', '/api/auth/recovery-codes', { token: tok, body: { currentPassword: OP_PW } });
        assert(rc.status === 403 && !rc.json?.codes, `S recovery codes from the ${label} membership: ${rc.status} ${J(rc.json)}`);
      }
      const opNow = (await doc()).users.find((u) => u.id === OP_ID);
      assert(opNow.password === opBefore.password && opNow.recoveryCodeHashes === undefined, 'S operator credential untouched by the recovery attempts');
      details.push('S: merge-into (self-registered NHK admin -> operator) 200; moved row = operator person/email, no credential; operator row unchanged (+owner, +1 epoch, origin absent); old sessions dead; merge token / NHK membership / kiosk tokens not operator; HKC via chooser is operator; old NHK login + recovery codes dead; no recovery codes for the operator person');
    }

    // ---- L: reset links never write the operator credential
    const opSnap = () => doc().then((d) => d.users.find((u) => u.id === OP_ID));
    const opSame = async (label, ref) => {
      const o = await opSnap();
      for (const fld of ['password', 'personId', 'agencyId', 'role', 'email', 'credentialOwner', 'tokenEpoch', 'credentialOrigin', 'resetSuspended']) assert(J(o[fld]) === J(ref[fld]), `${label}: operator ${fld} changed`);
    };
    {
      const ref = await opSnap();
      // the moved membership demoted to a role a link may be made for
      await setUsers((u) => (u.id === nhk.id ? { ...u, role: 'mashgiach', venueId: nhkVenue.id } : u), 'L demote moved');
      let v0 = await ver();
      const mk = await req(baseUrl, 'POST', `/api/users/${nhk.id}/reset-link`, { token: nhk2Token, body: { expectedVersion: v0 } });
      assert(mk.status === 409, `L create link for the moved membership: ${mk.status} ${J(mk.json)}`);
      await unchanged(v0, 'L create refused');
      // a crafted, otherwise valid live link for the moved membership
      const raw = crypto.randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const link = {
        id: `rst_t85_${ts}`, agencyId: nhk.agencyId, memberId: nhk.id, personId: OP_PID, email: OP_EMAIL, createdBy: add2.json.user.id,
        createdAt: now, expiresAt: future, status: 'pending',
        resetTokenHash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
        credentialOwnerId: OP_ID, credentialStampHash: crypto.createHash('sha256').update(`${OP_ID}:${ref.password}`, 'utf8').digest('hex'),
      };
      const d0 = await doc();
      assert((await hook('doc-set-users', { users: d0.users, resetLinks: [...(d0.resetLinks || []), link] })).status === 200, 'L plant link');
      await rehydrate();
      const pv = await req(baseUrl, 'GET', '/api/reset-links/preview', { ip: ip(), headers: { 'x-reset-token': raw } });
      assert(pv.status === 404, `L preview of a link to the operator credential: ${pv.status} ${J(pv.json)}`);
      const ac = await req(baseUrl, 'POST', '/api/reset-links/accept', { ip: ip(), headers: { 'x-reset-token': raw }, body: { newPassword: 'Pass-85-takeover!' } });
      assert(ac.status === 404 && !ac.json?.token, `L accept of a link to the operator credential: ${ac.status} ${J(ac.json)}`);
      await opSame('L crafted link', ref);
      assert((await login(OP_EMAIL, 'Pass-85-takeover!')).status === 401, 'L the link password does not sign in');
      assert((await current(opToken)).status === 200, 'L HKC session intact');
      // fresh-only creation: a membership of an ordinary person, moved into the operator person in the STORED doc only
      const x = await register('lx');
      const mId = `usr-t85-m-${ts}`;
      await setUsers((u) => (u.id === x.id ? { ...u, credentialOwner: true } : u), 'L x owner', { hydrate: false });
      const dx = await doc();
      assert((await hook('doc-set-users', { users: [...dx.users, { id: mId, email: x.email, name: 'T85 M', role: 'mashgiach', agencyId: nhk.agencyId, venueId: nhkVenue.id, personId: x.pid, avatarColor: '#64748b' }] })).status === 200, 'L plant M');
      await rehydrate();
      const mOk = (await doc()).users.find((u) => u.id === mId);
      assert(mOk && mOk.personId === x.pid, 'L M in X');
      const base = (await doc()).users;
      assert((await hook('doc-set-users', { users: base.map((u) => (u.id === mId ? { ...u, personId: OP_PID, email: OP_EMAIL } : u)) })).status === 200, 'L doc-only move M');
      v0 = await ver();
      const mk2 = await req(baseUrl, 'POST', `/api/users/${mId}/reset-link`, { token: nhk2Token, body: { expectedVersion: v0 } });
      assert(mk2.status === 409, `L fresh-only: link for a membership the stored doc moved into the operator person: ${mk2.status} ${J(mk2.json)}`);
      await unchanged(v0, 'L fresh-only create');
      assert((await hook('doc-set-users', { users: base })).status === 200, 'L restore M');
      await opSame('L fresh-only', ref);
      details.push('L: link creation for the moved membership 409; crafted valid link -> preview 404, accept 404, operator credential/epoch/pause untouched; stored-doc-only move into the operator person -> creation 409, nothing written');
    }

    // ---- I: membership isolation (a second NHK admin acts on the moved membership)
    {
      const ref = await opSnap();
      const pin = await req(baseUrl, 'PUT', `/api/users/${nhk.id}`, { token: nhk2Token, body: { kioskPin: String(4000 + (ts % 5000)), expectedVersion: await ver() } });
      assert(pin.status === 200, `I PIN on the moved membership: ${pin.status} ${J(pin.json)}`);
      await opSame('I after PIN', ref);
      assert((await current(opToken)).status === 200 && isOperatorAnswer(await opRoute(opToken)), 'I HKC operator session intact after PIN');
      // Existing rule: a row holding the operator email is never deleted (server.ts DELETE /api/users/:id).
      const del = await req(baseUrl, 'DELETE', `/api/users/${nhk.id}`, { token: nhk2Token, body: { expectedVersion: await ver() } });
      assert(del.status === 400 && /primary administrator/.test(String(del.json?.error)), `I delete the moved membership: ${del.status} ${J(del.json)}`);
      await opSame('I after delete', ref);
      assert((await current(opToken)).status === 200 && isOperatorAnswer(await opRoute(opToken)), 'I HKC operator session intact after delete');
      details.push('I: PIN set by another NHK admin, and the refused delete (operator email is never deleted), leave the operator row (password, origin, personId, owner, epoch) and its HKC session untouched');
    }
    return { details };
  },
};
