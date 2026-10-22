/**
 * Test 71 (QA2 server batch, Oct 22 2026):
 *  A change-password: a wrong current password -> 401 with code CURRENT_PASSWORD_WRONG
 *    (words unchanged); a 7-character new password -> 400 PASSWORD_TOO_SHORT; 8 -> 200.
 *  B GET /api/tasks?venueId=<another agency's venue> as admin -> 403 VENUE_NOT_IN_AGENCY
 *    (not the home venue's tasks); own venue and no venue still 200.
 *  C kiosk login: a venue owner without the fill permission -> 403 KIOSK_ROLE_CANNOT_FILL
 *    after a correct PIN (a wrong PIN stays the generic 401); an owner granted
 *    canFillTasks and a mashgiach -> 200.
 *  D a new Yes/No task has no answer: currentStatus 'pending' (create).
 *  E deleting a venue: its owner (no other venue) loses the session (401) and sign-in
 *    answers 403 VENUE_REMOVED; a mashgiach homed there who also has another venue
 *    keeps signing in; the admin is untouched.
 *  G a real 'No' answer keeps who answered and when across a server restart; un-answering clears it
 *    (the daily reset clearing it is Test 10).
 *  F a venue owner may file the official factory report for their own venue (rule T), not another.
 *  [QA2S-RV1] B2 (in C): a mashgiach whose fill permission is revoked in the STORED doc only
 *    (cache still allows) -> 403 KIOSK_ROLE_CANNOT_FILL from the fresh in-transaction re-check, no token.
 *  [QA2S-RV1] B1 (in E): after the delete, no route hands the removed owner a session:
 *    a token minted for the row anyway -> 401 (the shared session resolver); password reset
 *    and recovery codes change the password but answer 403 VENUE_REMOVED with no token;
 *    a two-membership person whose agency-A venue was deleted is offered only the agency-B
 *    membership, activating A answers 403 VENUE_REMOVED, B gives a session.
 *  S source pin: in server.ts only issueSessionToken (async since 11a-s1: writes the
 *    session record, then signs) and the test-mode mint hook call
 *    signSessionToken, and only liveSessionRow calls resolveSessionRow.
 */
import fs from 'node:fs';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
async function call(baseUrl, method, path, token, body, extra = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { ...(token ? auth(token) : { 'Content-Type': 'application/json' }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }) });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return `${claimed.device.id}.${deviceSecret}`;
}

export default {
  name: 'Test 71: QA2 server batch (change-password code + min 8, cross-agency tasks 403, owner kiosk refused, Yes/No unanswered, venue removed)',
  whatItProves:
    'Wrong current password is told apart from an expired session; one password minimum (8); an admin asking for another agency\'s venue is refused; an owner who cannot fill is refused at kiosk sign-in (after the PIN); a new Yes/No task starts unanswered; deleting a venue ends its owner\'s sessions and sign-in says so clearly, while people with another venue keep working.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t71a-${ts}`, B = `agency-t71b-${ts}`;
    const vA = `venue-t71a-${ts}`, vA2 = `venue-t71a2-${ts}`, vDel = `venue-t71del-${ts}`, vB = `venue-t71b-${ts}`;
    const U = (k) => `user-t71-${k}-${ts}`;
    const E = (k) => `t71-${k}-${ts}@test.local`;
    const PW = 'Correct-horse-71';
    const PIN = '4917';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: 'T71 A', timeZone: 'America/New_York' }, { id: B, name: 'T71 B', timeZone: 'America/New_York' }],
      venues: [{ id: vA, name: `T71 A ${ts}`, agencyId: A }, { id: vA2, name: `T71 A2 ${ts}`, agencyId: A }, { id: vDel, name: `T71 Del ${ts}`, agencyId: A }, { id: vB, name: `T71 B ${ts}`, agencyId: B }],
      users: [
        { id: U('adm'), email: E('adm'), name: 'T71 Admin', role: 'admin', agencyId: A, avatarColor: 'bg-gold' },
        { id: U('m'), email: E('m'), name: 'T71 Mash', role: 'mashgiach', agencyId: A, venueId: vA, kioskPin: PIN, avatarColor: 'bg-gold' },
        { id: U('o'), email: E('o'), name: 'T71 Owner', role: 'owner', agencyId: A, venueId: vA, kioskPin: PIN, avatarColor: 'bg-gold' },
        { id: U('of'), email: E('of'), name: 'T71 Owner Fill', role: 'owner', agencyId: A, venueId: vA, kioskPin: PIN, permissions: { canFillTasks: true, canAssignTasks: false }, avatarColor: 'bg-gold' },
        { id: U('od'), email: E('od'), name: 'T71 Owner Del', role: 'owner', agencyId: A, venueId: vDel, avatarColor: 'bg-gold' },
        { id: U('md'), email: E('md'), name: 'T71 Mash Del+A2', role: 'mashgiach', agencyId: A, venueId: vDel, avatarColor: 'bg-gold' },
        { id: U('bt'), email: E('bt'), name: 'T71 B task owner', role: 'admin', agencyId: B, avatarColor: 'bg-gold' },
        { id: U('kr'), email: E('kr'), name: 'T71 Mash Revoked', role: 'mashgiach', agencyId: A, venueId: vA, kioskPin: PIN, avatarColor: 'bg-gold' },
        { id: U('od2'), email: E('od2'), name: 'T71 Owner Del 2', role: 'owner', agencyId: A, venueId: vDel, avatarColor: 'bg-gold' },
        { id: U('px'), email: E('px'), name: 'T71 PX', role: 'mashgiach', agencyId: A, venueId: vDel, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    for (const k of ['m', 'od', 'md', 'adm', 'od2', 'px']) {
      const r = await ctx.api('POST', '/api/__test__/set-password', { userId: U(k), password: PW });
      if (r.status !== 200) throw new Error(`set-password ${k}: ${r.status}`);
    }
    const tAdm = await mintToken(baseUrl, U('adm'));
    const tM = await mintToken(baseUrl, U('m'));
    const details = [];

    // ---- A: change-password ----
    {
      const wrong = await call(baseUrl, 'POST', '/api/auth/change-password', tM, { currentPassword: 'not-the-password', newPassword: 'Another-pass-71' });
      if (wrong.status !== 401 || wrong.json?.code !== 'CURRENT_PASSWORD_WRONG' || wrong.json?.error !== 'Current password is incorrect.') {
        throw new Error(`A wrong current: ${wrong.status} ${JSON.stringify(wrong.json)}`);
      }
      const short = await call(baseUrl, 'POST', '/api/auth/change-password', tM, { currentPassword: PW, newPassword: 'abc1234' });
      if (short.status !== 400 || short.json?.code !== 'PASSWORD_TOO_SHORT') throw new Error(`A 7 chars: ${short.status} ${JSON.stringify(short.json)}`);
      const login7 = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('m'), password: PW });
      if (login7.status !== 200) throw new Error(`A old password must still work after the refusals: ${login7.status}`);
      const ok = await call(baseUrl, 'POST', '/api/auth/change-password', tM, { currentPassword: PW, newPassword: 'abcd1234' });
      if (ok.status !== 200) throw new Error(`A 8 chars: ${ok.status} ${JSON.stringify(ok.json)}`);
      details.push('A wrong current 401+code, 7 chars 400, 8 chars 200');
    }

    // ---- B: tasks venue scope ----
    {
      const other = await call(baseUrl, 'GET', `/api/tasks?venueId=${encodeURIComponent(vB)}`, tAdm);
      if (other.status !== 403 || other.json?.code !== 'VENUE_NOT_IN_AGENCY') throw new Error(`B other agency venue: ${other.status} ${JSON.stringify(other.json).slice(0, 200)}`);
      const own = await call(baseUrl, 'GET', `/api/tasks?venueId=${encodeURIComponent(vA)}`, tAdm);
      if (own.status !== 200 || own.json?.venueId !== vA) throw new Error(`B own venue: ${own.status} ${own.json?.venueId}`);
      const none = await call(baseUrl, 'GET', '/api/tasks', tAdm);
      if (none.status !== 200) throw new Error(`B no venue: ${none.status}`);
      details.push('B other-agency venue 403, own 200, none 200');
    }

    // ---- C: kiosk owner ----
    {
      const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdm) });
      if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
      const dev = await pairDevice(baseUrl, tAdm, vA);
      const kl = (userId, pin) => call(baseUrl, 'POST', '/api/kiosk/login', null, { userId, pin }, { 'X-Kiosk-Device': dev });
      const ownerWrong = await kl(U('o'), '0000');
      if (ownerWrong.status !== 401) throw new Error(`C owner wrong PIN must stay the generic 401: ${ownerWrong.status}`);
      const owner = await kl(U('o'), PIN);
      if (owner.status !== 403 || owner.json?.code !== 'KIOSK_ROLE_CANNOT_FILL' || owner.json?.token) throw new Error(`C owner: ${owner.status} ${JSON.stringify(owner.json)}`);
      const ownerFill = await kl(U('of'), PIN);
      if (ownerFill.status !== 200 || !ownerFill.json?.token) throw new Error(`C owner with canFillTasks: ${ownerFill.status}`);
      const mash = await kl(U('m'), PIN);
      if (mash.status !== 200 || !mash.json?.token) throw new Error(`C mashgiach: ${mash.status}`);
      // B2: revoke kr's fill permission in the STORED doc only; the cached check still passes.
      const stored = (await ctx.getDoc()).users;
      const revoked = stored.map((u) => (u.id === U('kr') ? { ...u, permissions: { ...(u.permissions || {}), canFillTasks: false } } : u));
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: revoked })).status !== 200) throw new Error('C plant revoke');
      const krRow = async () => { const r = (await ctx.getDoc()).users.find((u) => u.id === U('kr')) || {}; return JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])); };
      const kr0 = await krRow();
      const kr = await kl(U('kr'), PIN);
      if (kr.status !== 403 || kr.json?.code !== 'KIOSK_ROLE_CANNOT_FILL' || kr.json?.token) throw new Error(`C revoked in store only: ${kr.status} ${JSON.stringify(kr.json)}`);
      // Only the attempt reservation may have been written; the success commit (row stamps) never ran.
      if ((await krRow()) !== kr0) throw new Error(`C revoked: the refused login changed the user row: ${kr0} -> ${await krRow()}`);
      if ((await ctx.api('POST', '/api/__test__/doc-set-users', { users: stored })).status !== 200) throw new Error('C restore');
      // The attempt reservation re-hydrated the cache from the store; re-hydrate after the restore too.
      if ((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t71-hc-${ts}`, name: 'T71 hydrate C', agencyId: B }] })).status !== 200) throw new Error('C rehydrate');
      const krOk = await kl(U('kr'), PIN);
      if (krOk.status !== 200 || !krOk.json?.token) throw new Error(`C kr restored: ${krOk.status}`);
      details.push('C owner 403 after correct PIN (wrong PIN 401), owner+fill 200, mashgiach 200; fill revoked in store only 403 (fresh re-check), row unchanged');
    }

    // ---- D: Yes/No unanswered ----
    {
      const tr = await call(baseUrl, 'POST', '/api/tasks', tAdm, { venueId: vA, title: `T71 yes/no ${ts}`, inputType: 'yes_no' });
      const task = tr.json?.task || tr.json;
      if ((tr.status !== 200 && tr.status !== 201) || !task?.id) throw new Error(`D create: ${tr.status} ${JSON.stringify(tr.json).slice(0, 200)}`);
      const stored = (await ctx.getDoc()).tasks.find((t) => t.id === task.id);
      if (!stored || stored.inputType !== 'yes_no' || stored.currentStatus !== 'pending') throw new Error(`D status: ${stored?.inputType} ${stored?.currentStatus}`);
      details.push("D new Yes/No task 'pending'");
    }

    // ---- G: a real 'No' keeps who answered and when, across a server restart; un-answering clears it ----
    {
      const tr = await call(baseUrl, 'POST', '/api/tasks', tAdm, { venueId: vA, title: `T71 no-keeps ${ts}`, inputType: 'yes_no' });
      const taskId = (tr.json?.task || tr.json)?.id;
      if (!taskId) throw new Error(`G create: ${tr.status}`);
      const tMash = await mintToken(baseUrl, U('m'));
      const put = async (body) => call(baseUrl, 'PUT', `/api/tasks/${taskId}`, tMash, { ...body, expectedVersion: await ctx.getVersion() });
      const no = await put({ currentStatus: 'no', isCompleted: false });
      if (no.status !== 200) throw new Error(`G answer No: ${no.status} ${JSON.stringify(no.json).slice(0, 200)}`);
      let stored = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
      if (stored.currentStatus !== 'no' || stored.updatedByEmail !== E('m') || !stored.updatedByName || typeof stored.updatedAt !== 'string') {
        throw new Error(`G No attribution stored: ${JSON.stringify({ s: stored.currentStatus, e: stored.updatedByEmail, a: stored.updatedAt })}`);
      }
      await ctx.restartServer();
      const tAdm2 = await mintToken(baseUrl, U('adm'));
      const list = await call(baseUrl, 'GET', `/api/tasks?venueId=${encodeURIComponent(vA)}`, tAdm2);
      const seen = (list.json?.tasks || []).find((t) => t.id === taskId);
      if (!seen || seen.currentStatus !== 'no' || seen.updatedByEmail !== E('m') || typeof seen.updatedAt !== 'string') {
        throw new Error(`G No attribution after restart: ${JSON.stringify(seen && { s: seen.currentStatus, e: seen.updatedByEmail, a: seen.updatedAt })}`);
      }
      const tMash2 = await mintToken(baseUrl, U('m'));
      const un = await call(baseUrl, 'PUT', `/api/tasks/${taskId}`, tMash2, { currentStatus: 'pending', isCompleted: false, expectedVersion: await ctx.getVersion() });
      if (un.status !== 200) throw new Error(`G un-answer: ${un.status}`);
      stored = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
      if (stored.currentStatus !== 'pending' || stored.updatedByEmail !== null || stored.updatedAt !== null) throw new Error(`G un-answer clears: ${JSON.stringify({ s: stored.currentStatus, e: stored.updatedByEmail, a: stored.updatedAt })}`);
      // N1: a real 'No' from today does not survive the daily reset into the next workday.
      const tMash3 = await mintToken(baseUrl, U('m'));
      const no2 = await call(baseUrl, 'PUT', `/api/tasks/${taskId}`, tMash3, { currentStatus: 'no', isCompleted: false, expectedVersion: await ctx.getVersion() });
      if (no2.status !== 200) throw new Error(`G answer No again: ${no2.status}`);
      const rd = await call(baseUrl, 'POST', '/api/reset-daily', await mintToken(baseUrl, U('adm')), { force: true });
      if (rd.status !== 200) throw new Error(`G reset-daily: ${rd.status} ${JSON.stringify(rd.json).slice(0, 160)}`);
      stored = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
      if (stored.currentStatus !== 'pending' || stored.updatedByEmail !== null || stored.updatedByName !== null || stored.updatedAt !== null) {
        throw new Error(`G daily reset clears the No and who/when: ${JSON.stringify({ s: stored.currentStatus, e: stored.updatedByEmail, n: stored.updatedByName, a: stored.updatedAt })}`);
      }
      details.push("G a real 'No' keeps who/when across a restart; back to unanswered clears it; the daily reset clears it too");
    }
    // ---- E: venue removed ----
    {
      // md also works at vA2 (a sanctioned venueAccess write through the admin route is not needed: plant it).
      const users = (await ctx.getDoc()).users;
      const planted = users.map((u) => (u.id === U('md') ? { ...u, venueAccess: [vDel, vA2] }
        : u.id === U('od2') ? { ...u, credentialOrigin: 'self-registered' }
        : u.id === U('px') ? { ...u, credentialOwner: true } : u));
      const ps = await ctx.api('POST', '/api/__test__/doc-set-users', { users: planted });
      if (ps.status !== 200) throw new Error(`E plant venueAccess: ${ps.status}`);
      // Re-hydrate the server cache from the stored doc (a no-op fixture commit in agency B).
      const rh = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t71-h-${ts}`, name: 'T71 hydrate', agencyId: B }] });
      if (rh.status !== 200) throw new Error(`E rehydrate: ${rh.status}`);
      const md0 = (await ctx.getDoc()).users.find((u) => u.id === U('md'));
      if (!md0?.personId || !(md0.venueAccess || []).includes(vA2)) throw new Error(`E md fixture: ${JSON.stringify({ p: md0?.personId, va: md0?.venueAccess })}`);
      // px becomes a two-membership person: PX (agency A, the deleted venue) + PY (agency B).
      const built = await ctx.api('POST', '/api/__test__/identity-build-person', { ownerUserId: U('px'), agencyId: B, role: 'mashgiach', venueId: vB, name: 'T71 PY' });
      if (built.status !== 200 || !built.json?.id) throw new Error(`E build PY: ${built.status} ${JSON.stringify(built.json)}`);
      const PY = built.json.id;
      // od2 gets recovery codes while it can still sign in.
      const codes = await call(baseUrl, 'POST', '/api/auth/recovery-codes', await mintToken(baseUrl, U('od2')), { currentPassword: PW });
      if (codes.status !== 200 || !Array.isArray(codes.json?.codes) || !codes.json.codes.length) throw new Error(`E od2 recovery codes: ${codes.status} ${JSON.stringify(codes.json).slice(0, 160)}`);
      const tOd = await mintToken(baseUrl, U('od'));
      const before = await call(baseUrl, 'GET', '/api/tasks', tOd);
      if (before.status !== 200) throw new Error(`E owner session before delete: ${before.status}`);
      const pre = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('od'), password: PW });
      if (pre.status !== 200) throw new Error(`E owner login before delete: ${pre.status}`);
      const v = await ctx.getVersion();
      const del = await call(baseUrl, 'DELETE', `/api/venues/${vDel}`, tAdm, { expectedVersion: v });
      if (del.status !== 200) throw new Error(`E delete venue: ${del.status} ${JSON.stringify(del.json)}`);
      const after = await call(baseUrl, 'GET', '/api/tasks', tOd);
      if (after.status !== 401) throw new Error(`E owner's old session must end: ${after.status}`);
      const login = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('od'), password: PW });
      if (login.status !== 403 || login.json?.code !== 'VENUE_REMOVED' || login.json?.token) throw new Error(`E owner login after delete: ${login.status} ${JSON.stringify(login.json)}`);
      const wrongPw = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('od'), password: 'nope-nope-71' });
      if (wrongPw.status !== 401) throw new Error(`E wrong password stays the generic 401: ${wrongPw.status}`);
      const md = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('md'), password: PW });
      if (md.status !== 200 || !md.json?.token) throw new Error(`E mashgiach with another venue: ${md.status} ${JSON.stringify(md.json)}`);
      const adm = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('adm'), password: PW });
      if (adm.status !== 200) throw new Error(`E admin: ${adm.status}`);
      // B1: a token signed for the removed row anyway is refused by the shared resolver.
      const raw = await call(baseUrl, 'GET', '/api/tasks', await mintToken(baseUrl, U('od')));
      if (raw.status !== 401) throw new Error(`E a token minted after the delete must be refused: ${raw.status}`);
      // B1: password reset completes the credential change but hands out no session.
      const ip = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.71.${ts % 200}.9` };
      const fg = await call(baseUrl, 'POST', '/api/auth/forgot-password', null, { email: E('od') }, ip);
      if (fg.status !== 200) throw new Error(`E forgot: ${fg.status}`);
      const rc = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(E('od'))}`)).json()).code;
      const vr = await call(baseUrl, 'POST', '/api/auth/verify-reset-code', null, { email: E('od'), code: rc }, ip);
      if (vr.status !== 200 || !vr.json?.resetToken) throw new Error(`E verify reset: ${vr.status} ${JSON.stringify(vr.json)}`);
      const NEWPW = 'Reset-after-delete-71';
      const rs = await call(baseUrl, 'POST', '/api/auth/reset-password', null, { email: E('od'), resetToken: vr.json.resetToken, newPassword: NEWPW });
      if (rs.status !== 403 || rs.json?.code !== 'VENUE_REMOVED' || rs.json?.token) throw new Error(`E reset after delete: ${rs.status} ${JSON.stringify(rs.json)}`);
      const lgNew = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('od'), password: NEWPW });
      if (lgNew.status !== 403 || lgNew.json?.code !== 'VENUE_REMOVED') throw new Error(`E new password took, still VENUE_REMOVED: ${lgNew.status}`);
      // B1: recovery codes likewise.
      const RECPW = 'Recover-after-delete-71';
      const rv = await call(baseUrl, 'POST', '/api/auth/recover', null, { email: E('od2'), code: codes.json.codes[0], newPassword: RECPW }, { 'X-Forwarded-For': `10.71.${ts % 200}.10` });
      if (rv.status !== 403 || rv.json?.code !== 'VENUE_REMOVED' || rv.json?.token) throw new Error(`E recover after delete: ${rv.status} ${JSON.stringify(rv.json)}`);
      const lgRec = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('od2'), password: RECPW });
      if (lgRec.status !== 403 || lgRec.json?.code !== 'VENUE_REMOVED') throw new Error(`E recovered password took, still VENUE_REMOVED: ${lgRec.status}`);
      // B1: the two-membership person: only PY is offered; PX refused; PY works.
      const lgP = await call(baseUrl, 'POST', '/api/auth/login', null, { email: E('px'), password: PW });
      const offered = (lgP.json?.memberships || []).map((m) => m.membershipId);
      if (lgP.status !== 200 || lgP.json?.chooseMembership !== true || offered.length !== 1 || offered[0] !== PY) throw new Error(`E multi login: ${lgP.status} ${JSON.stringify(lgP.json).slice(0, 200)}`);
      const actX = await call(baseUrl, 'POST', '/api/auth/activate', lgP.json.token, { membershipId: U('px') });
      if (actX.status !== 403 || actX.json?.code !== 'VENUE_REMOVED' || actX.json?.token) throw new Error(`E activate removed PX: ${actX.status} ${JSON.stringify(actX.json)}`);
      const actY = await call(baseUrl, 'POST', '/api/auth/activate', lgP.json.token, { membershipId: PY });
      if (actY.status !== 200 || !actY.json?.token) throw new Error(`E activate PY: ${actY.status}`);
      const useY = await call(baseUrl, 'GET', '/api/tasks', actY.json.token);
      if (useY.status !== 200) throw new Error(`E PY session: ${useY.status}`);
      details.push('E owner of deleted venue: session 401, login 403 VENUE_REMOVED; mashgiach with A2 200; admin 200; a fresh token 401; reset and recover change the password but 403 VENUE_REMOVED, no token; two-membership person offered only PY, PX 403, PY 200');
    }
    // ---- F: owner files the factory report for their own venue ----
    {
      const tO = await mintToken(baseUrl, U('o'));
      const body = (venueId) => ({ venueId, auditDate: '2026-10-22', summaryNotes: 'T71 owner report', auditedIngredients: [], discrepancies: [], status: 'submitted' });
      const own = await call(baseUrl, 'POST', '/api/factory-reports', tO, body(vA));
      if (own.status !== 200 && own.status !== 201) throw new Error(`F owner own venue: ${own.status} ${JSON.stringify(own.json).slice(0, 200)}`);
      const other = await call(baseUrl, 'POST', '/api/factory-reports', tO, body(vA2));
      if (other.status !== 403) throw new Error(`F owner other venue: ${other.status}`);
      details.push('F owner report own venue 2xx, other venue 403');
    }
    // ---- S: source pin (one eligibility rule, no drift) ----
    {
      const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
      const signs = src.split('\n').filter((l) => l.includes('signSessionToken(') && !/^\s*(\/\/|\*|\/\*)/.test(l));
      const okSign = signs.every((l) => /function signSessionToken\(|return \{ token: signSessionToken\(fresh, sid\), sid \};|signToken\(userId\) : signSessionToken\(user as any\)/.test(l));
      if (signs.length !== 3 || !okSign) throw new Error(`S signSessionToken callers: ${signs.length}\n${signs.join('\n')}`);
      const resolves = src.split('\n').filter((l) => l.includes('resolveSessionRow(') && !/^\s*(\/\/|\*|\/\*)/.test(l));
      if (resolves.length !== 1 || !resolves[0].includes('const row: any = resolveSessionRow(claims')) throw new Error(`S resolveSessionRow callers: ${resolves.length}`);
      details.push('S only issueSessionToken (+ test mint) signs, only liveSessionRow resolves');
    }
    return details.join('; ');
  },
};
