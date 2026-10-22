/**
 * Test 76 (10M part 2, "Agreed — 10M part 2"): merge two accounts.
 * POST /api/account/bring-in (signed in as A, types B's login) and
 * POST /api/account/merge-into (signed in as B, types A's login + B's own
 * password). A survives; B's memberships move under A; B's login stops.
 * Design: files/shutfey-10M-design.txt v4 (+ v5/v6 M6c').
 *  A  no session 401; body checks 400 — nothing written.
 *  B  wrong / unknown typed login: one 403 body; wrong currentPassword 403;
 *     same account 409; per-email failure limit and per-person budget 429.
 *  C  refusals with nothing written: not linkable (either side), paused,
 *     shared agency; fresh-only re-checks (hash changed / shared membership
 *     planted in the STORED doc only) -> 409.
 *  D  bring-in success (single -> single): B's row now A's person + email, no
 *     credential fields; A's credential row becomes owner; every old token of
 *     A and B dies; the fresh token works; A's login lists both agencies, B's
 *     login fails; every schema email field in B's agency now A's, text fields
 *     and other agencies untouched; primary admin follows; B's invite revoked,
 *     reset request removed, legacy push subscription removed.
 *  E  merge-into success (single B in agency-hkc -> multi A): legacy records
 *     (no agencyId; no venue / an HKC venue) rewritten; B's kiosk revision +1;
 *     the device stays signed in as the moved row; A's login lists 3 agencies.
 *  F  ambiguous legacy record holding B's email (venue of another agency /
 *     missing venue) -> 409 MERGE_NEEDS_CHECK, nothing written; one holding
 *     another email is untouched by a merge (checked in D).
 *  G  same operationId sent twice at once -> one merge; a later retry is
 *     refused and changes nothing.
 */
const J = (o) => JSON.stringify(o);
async function req(baseUrl, method, path, { token, ip, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function assert(c, m) { if (!c) throw new Error(m); }
const CRED_FIELDS = ['password', 'credentialOwner', 'credentialOrigin', 'credentialPending', 'recoveryCodeHashes', 'recoveryFailures'];

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    let closeCode = null; let gotInitial = false;
    const waiters = [];
    const conn = { waitClose: (ms = 5000) => new Promise((res) => { if (closeCode !== null) return res(closeCode); const t = setTimeout(() => res(closeCode), ms); waiters.push((c) => { clearTimeout(t); res(c); }); }) };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => { let m = null; try { m = JSON.parse(String(ev.data)); } catch {} if (m && m.type === 'INITIAL_STATE' && !gotInitial) { gotInitial = true; clearTimeout(timer); resolve(conn); } };
    ws.onerror = () => { if (!gotInitial) { clearTimeout(timer); reject(new Error('WS error')); } };
    ws.onclose = (ev) => { closeCode = ev.code; waiters.splice(0).forEach((w) => w(ev.code)); if (!gotInitial) { clearTimeout(timer); reject(new Error(`WS closed before INITIAL_STATE (${ev.code})`)); } };
  });
}

export default {
  name: 'Test 76: 10M part 2 — merge two accounts (bring-in / merge-into)',
  whatItProves:
    'Both entry points merge B into A in one commit: B rows move to A with no credential, all old sessions of both end, the caller gets a fresh token, B\'s login stops, B\'s email references inside B\'s agencies become A\'s (schema fields only, ambiguous legacy records refused), B\'s invites/reset requests/push subscriptions end; every refusal writes nothing.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.76.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t76-${k}-${ts}@test.local`;
    const PW = (k) => `Pass-76-${k}!`;
    const doc = () => ctx.getDoc();
    const ver = () => ctx.getVersion();
    const unchanged = async (v0, label) => { const v1 = await ver(); assert(v1 === v0, `${label}: version moved ${v0} -> ${v1}`); };
    const op = () => `op-${crypto.randomUUID()}`;
    const details = [];
    const hook = async (path, body) => ctx.api('POST', `/api/__test__/${path}`, body);
    let hk = 0;
    const rehydrate = async () => assert((await hook('inject-fixture', { venues: [{ id: `venue-t76-h${hk++}-${ts}`, name: 'T76 hydrate', agencyId: 'agency-hkc' }] })).status === 200, 'rehydrate');
    const setUsers = async (fn, label, { hydrate = true } = {}) => {
      const us = (await doc()).users.map(fn).filter(Boolean);
      assert((await hook('doc-set-users', { users: us })).status === 200, `${label} plant`);
      if (hydrate) await rehydrate();
    };
    const addUsers = async (extra, label) => {
      const us = [...(await doc()).users, ...extra];
      assert((await hook('doc-set-users', { users: us })).status === 200, `${label} plant`);
      await rehydrate();
    };
    const mint = async (userId) => { const r = await hook('mint-token', { userId }); assert(r.status === 200 && r.json?.token, `mint ${userId}: ${r.status}`); return r.json.token; };
    const register = async (k) => {
      const r = await req(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), body: { agencyName: `T76 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T76 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      const row = (await doc()).users.find((u) => u.id === r.json.user.id);
      assert(row && row.personId && row.credentialOrigin === 'self-registered', `register ${k} row: ${J(row && { p: row.personId, o: row.credentialOrigin })}`);
      return { token: r.json.token, id: row.id, pid: row.personId, agencyId: row.agencyId, email: E(k), pw: PW(k) };
    };
    const bringIn = (token, email, password, extra = {}) =>
      req(baseUrl, 'POST', '/api/account/bring-in', { token, ip: ip(), body: { email, password, confirm: true, operationId: op(), ...extra } });
    const mergeInto = (token, email, password, currentPassword, extra = {}) =>
      req(baseUrl, 'POST', '/api/account/merge-into', { token, ip: ip(), body: { email, password, currentPassword, confirm: true, operationId: op(), ...extra } });
    const current = (token) => req(baseUrl, 'GET', '/api/agencies/current', { token });
    const login = (email, password) => req(baseUrl, 'POST', '/api/auth/login', { ip: ip(), body: { email, password } });
    const rowsOf = async (pid) => (await doc()).users.filter((u) => u.personId === pid);

    // ---- A: session + body checks
    {
      const a0 = await register('a0');
      const v0 = await ver();
      const noTok = await req(baseUrl, 'POST', '/api/account/bring-in', { ip: ip(), body: { email: E('x'), password: 'x', confirm: true, operationId: op() } });
      assert(noTok.status === 401, `A no session: ${noTok.status}`);
      for (const [extra, label] of [[{ confirm: undefined }, 'no confirm'], [{ confirm: 'yes' }, 'confirm not true'], [{ operationId: 'short' }, 'short operationId'], [{ operationId: 'bad op id!!' }, 'bad operationId'], [{ email: '' }, 'empty email'], [{ password: '' }, 'empty password']]) {
        const r = await bringIn(a0.token, E('x'), 'pw-x', extra);
        assert(r.status === 400 && r.json?.code === 'MERGE_INVALID', `A bring-in ${label}: ${r.status} ${J(r.json)}`);
      }
      const mi = await mergeInto(a0.token, E('x'), 'pw-x', undefined);
      assert(mi.status === 400 && mi.json?.code === 'MERGE_INVALID', `A merge-into without currentPassword: ${mi.status}`);
      await unchanged(v0, 'A');
      details.push('A: no session 401; missing/invalid confirm, operationId, email, password, currentPassword -> 400 MERGE_INVALID, nothing written');
    }

    // ---- B: proof failures and limits
    {
      const p = await register('bp');
      const q = await register('bq');
      const v0 = await ver();
      const w = await bringIn(p.token, q.email, 'wrong-76');
      const u = await bringIn(p.token, E('nobody'), q.pw);
      assert(w.status === 403 && u.status === 403 && J(w.json) === J(u.json) && w.json?.code === 'MERGE_LOGIN_FAILED' && w.json?.error === 'Email or password is incorrect.', `B wrong/unknown: ${J([w, u])}`);
      const c = await mergeInto(p.token, q.email, q.pw, 'wrong-current');
      assert(c.status === 403 && c.json?.code === 'MERGE_CURRENT_PASSWORD_WRONG', `B wrong currentPassword: ${c.status} ${J(c.json)}`);
      const same = await bringIn(p.token, p.email, p.pw);
      assert(same.status === 409 && same.json?.code === 'MERGE_SAME_ACCOUNT', `B same account: ${same.status} ${J(same.json)}`);
      await unchanged(v0, 'B refusals');
      assert((await current(p.token)).status === 200 && (await current(q.token)).status === 200, 'B: both sessions still valid after refusals');
      // per typed email: 5 failures -> 429 even with the right password (fresh caller)
      const l = await register('bl');
      const t = await register('bt');
      const v1 = await ver();
      for (let i = 0; i < 5; i++) { const r = await bringIn(l.token, t.email, `bad-${i}`); assert(r.status === 403, `B fail ${i}: ${r.status}`); }
      const locked = await bringIn(l.token, t.email, t.pw);
      assert(locked.status === 429 && locked.json?.code === 'RATE_LIMITED', `B per-email limit: ${locked.status} ${J(locked.json)}`);
      // per caller person: 10 per hour (5 bad + 1 locked so far for l)
      for (let i = 0; i < 4; i++) { const r = await bringIn(l.token, E(`nb${i}`), 'x'); assert(r.status === 403, `B budget ${i}: ${r.status}`); }
      const over = await bringIn(l.token, E('nb9'), 'x');
      assert(over.status === 429, `B per-person budget: ${over.status} ${J(over.json)}`);
      await unchanged(v1, 'B limits');
      // per IP: 10 per hour across callers (2 callers x 5 at one IP, then a third caller -> 429)
      const ipFixed = `10.77.${(ts % 200) + 1}.9`;
      const bi = (token, k) => req(baseUrl, 'POST', '/api/account/bring-in', { token, ip: ipFixed, body: { email: E(k), password: 'x', confirm: true, operationId: op() } });
      const ia = await register('bia');
      const ib = await register('bib');
      const ic = await register('bic');
      const v4 = await ver();
      for (let i = 0; i < 5; i++) { const r1 = await bi(ia.token, `ipa${i}`); const r2 = await bi(ib.token, `ipb${i}`); assert(r1.status === 403 && r2.status === 403, `B ip ${i}: ${r1.status} ${r2.status}`); }
      const ipOver = await bi(ic.token, 'ipc');
      assert(ipOver.status === 429 && ipOver.json?.code === 'RATE_LIMITED', `B per-IP limit: ${ipOver.status} ${J(ipOver.json)}`);
      await unchanged(v4, 'B per-IP limit');
      // M3: the typed-email failure budget is SHARED with 10M part 1 (register-existing), both directions
      const rxCall = (email, password) => req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { agencyName: `T76 rx ${ts} ${Math.random().toString(36).slice(2, 7)}`, email, password, operationId: op() } });
      const x1 = await register('bx1');
      const xc1 = await register('bxc1');
      const x2 = await register('bx2');
      const xc2 = await register('bxc2');
      const v3 = await ver();
      for (let i = 0; i < 5; i++) { const r = await rxCall(x1.email, `bad-rx-${i}`); assert(r.status === 401, `B rx fail ${i}: ${r.status}`); }
      const crossA = await bringIn(xc1.token, x1.email, x1.pw);
      assert(crossA.status === 429 && crossA.json?.code === 'RATE_LIMITED', `B register-existing failures lock the merge: ${crossA.status} ${J(crossA.json)}`);
      for (let i = 0; i < 5; i++) { const r = await bringIn(xc2.token, x2.email, `bad-mx-${i}`); assert(r.status === 403, `B mx fail ${i}: ${r.status}`); }
      const crossB = await rxCall(x2.email, x2.pw);
      assert(crossB.status === 429, `B merge failures lock register-existing: ${crossB.status} ${J(crossB.json)}`);
      await unchanged(v3, 'B shared limiter');
      // failed currentPassword checks per caller person: 5 -> 429 even with the right one
      const cc = await register('bc');
      const ct = await register('bct');
      const v2 = await ver();
      for (let i = 0; i < 5; i++) { const r = await mergeInto(cc.token, ct.email, ct.pw, `bad-cur-${i}`); assert(r.status === 403 && r.json?.code === 'MERGE_CURRENT_PASSWORD_WRONG', `B cur fail ${i}: ${r.status}`); }
      const curLocked = await mergeInto(cc.token, ct.email, ct.pw, cc.pw);
      assert(curLocked.status === 429, `B currentPassword limit: ${curLocked.status} ${J(curLocked.json)}`);
      await unchanged(v2, 'B currentPassword limit');
      details.push('B: wrong/unknown typed login -> identical 403 MERGE_LOGIN_FAILED; wrong currentPassword 403; same account 409; 5 failures per typed email -> 429; 10 per caller person -> 429; 10 per IP -> 429; 5 wrong currentPassword -> 429; the typed-email budget is shared with register-existing both ways; nothing written, sessions intact');
    }

    // ---- C: refusals after proof, nothing written
    {
      const p = await register('cp');
      const nl = await register('cnl');
      const ps = await register('cps');
      const sh = await register('csh');
      const st = await register('cst');
      await setUsers((x) => (x.id === nl.id ? { ...x, credentialOrigin: 'admin' } : x.id === ps.id ? { ...x, resetSuspended: { linkId: `rl-t76-${ts}`, at: new Date().toISOString(), byAgencyId: p.agencyId } } : x), 'C plant');
      let v0 = await ver();
      const r1 = await bringIn(p.token, nl.email, nl.pw);
      assert(r1.status === 403 && r1.json?.code === 'ACCOUNT_NOT_LINKABLE', `C retired not linkable: ${r1.status} ${J(r1.json)}`);
      const r1b = await mergeInto(nl.token, p.email, p.pw, nl.pw);
      assert(r1b.status === 403 && r1b.json?.code === 'ACCOUNT_NOT_LINKABLE', `C retired (caller) not linkable: ${r1b.status} ${J(r1b.json)}`);
      const r1c = await bringIn(nl.token, p.email, p.pw);
      assert(r1c.status === 403 && r1c.json?.code === 'ACCOUNT_NOT_LINKABLE', `C survivor not linkable: ${r1c.status} ${J(r1c.json)}`);
      const r2 = await bringIn(p.token, ps.email, ps.pw);
      assert(r2.status === 403 && r2.json?.code === 'RESET_CONFIRM_NEEDED', `C paused: ${r2.status} ${J(r2.json)}`);
      await unchanged(v0, 'C not linkable / paused');
      // shared agency: sh also holds a membership in p's agency
      const shRow = (await doc()).users.find((x) => x.id === sh.id);
      await setUsers((x) => (x.id === sh.id ? { ...x, credentialOwner: true } : x), 'C owner', { hydrate: false });
      await addUsers([{ id: `usr-t76-sh-${ts}`, email: shRow.email, name: 'T76 shared', role: 'mashgiach', agencyId: p.agencyId, personId: sh.pid, avatarColor: '#64748b' }], 'C shared');
      v0 = await ver();
      const r3 = await bringIn(p.token, sh.email, sh.pw);
      assert(r3.status === 409 && r3.json?.code === 'MERGE_SHARED_AGENCY', `C shared agency: ${r3.status} ${J(r3.json)}`);
      const r3b = await mergeInto(sh.token, p.email, p.pw, sh.pw);
      assert(r3b.status === 409 && r3b.json?.code === 'MERGE_SHARED_AGENCY', `C shared agency (merge-into): ${r3b.status} ${J(r3b.json)}`);
      await unchanged(v0, 'C shared');
      // fresh-only: st's hash changed in the STORED doc only -> the cached proof passes, the fresh check refuses
      await setUsers((x) => (x.id === st.id ? { ...x, password: '$2a$10$abcdefghijklmnopqrstuuS6v3sFCVqcG7mK0u8i1rCVhVnbuX4uK' } : x), 'C stale hash', { hydrate: false });
      v0 = await ver();
      const r4 = await bringIn(p.token, st.email, st.pw);
      assert(r4.status === 409 && r4.json?.code === 'MERGE_STALE', `C fresh hash: ${r4.status} ${J(r4.json)}`);
      await unchanged(v0, 'C fresh hash');
      await rehydrate();
      // fresh-only shared membership: planted in the STORED doc only
      const fs2 = await register('cfs');
      const fs2Row = (await doc()).users.find((x) => x.id === fs2.id);
      const us = (await doc()).users.map((x) => (x.id === fs2.id ? { ...x, credentialOwner: true } : x));
      us.push({ id: `usr-t76-fs-${ts}`, email: fs2Row.email, name: 'T76 fresh shared', role: 'mashgiach', agencyId: p.agencyId, personId: fs2.pid, avatarColor: '#64748b' });
      assert((await hook('doc-set-users', { users: us })).status === 200, 'C fresh shared plant');
      v0 = await ver();
      const r5 = await bringIn(p.token, fs2.email, fs2.pw);
      assert(r5.status === 409 && r5.json?.code === 'MERGE_SHARED_AGENCY', `C fresh shared: ${r5.status} ${J(r5.json)}`);
      await unchanged(v0, 'C fresh shared');
      await rehydrate();
      // fresh-only: the caller row's person changed in the STORED doc only
      const cq = await register('cq');
      const cr = await register('cr');
      const cqPid = cq.pid;
      await setUsers((x) => (x.id === cq.id ? { ...x, personId: `pid-t76-moved-${ts}` } : x), 'C caller moved', { hydrate: false });
      v0 = await ver();
      const r6 = await bringIn(cq.token, cr.email, cr.pw);
      assert(r6.status === 409 && r6.json?.code === 'MERGE_STALE', `C fresh caller: ${r6.status} ${J(r6.json)}`);
      await unchanged(v0, 'C fresh caller');
      await setUsers((x) => (x.id === cq.id ? { ...x, personId: cqPid } : x), 'C caller restored');
      // an identity group that needs a check (legacy twin row, same email) -> 409, nothing written
      const cn = await register('cn');
      const cnc = await register('cnc');
      const cnRow = (await doc()).users.find((u) => u.id === cn.id);
      const twin = { ...cnRow, id: `user-t76-twin-${ts}`, personId: `user-t76-twin-${ts}`, agencyId: 'agency-hkc', role: 'mashgiach' };
      delete twin.password; delete twin.credentialOrigin; delete twin.credentialOwner;
      await addUsers([twin], 'C twin');
      v0 = await ver();
      const rn = await bringIn(cnc.token, cn.email, cn.pw);
      assert(rn.status === 409 && rn.json?.code === 'INVITE_PERSON_NEEDS_CHECK', `C needs check: ${rn.status} ${J(rn.json)}`);
      await unchanged(v0, 'C needs check');
      await setUsers((u) => (u.id === twin.id ? null : u), 'C twin removed');
      // the platform operator account (made linkable here on purpose) is refused
      const opRow = (await doc()).users.find((u) => u.id === 'usr_admin');
      assert(opRow, 'C platform operator row missing');
      const cpo = await register('cpo');
      const cpoHash = (await doc()).users.find((u) => u.id === cpo.id).password;
      await setUsers((u) => (u.id === 'usr_admin' ? { ...u, password: cpoHash, credentialOrigin: 'self-registered', personId: u.personId || 'usr_admin' } : u), 'C op linkable');
      const cpc = await register('cpc');
      v0 = await ver();
      const ro = await bringIn(cpc.token, String(opRow.email), cpo.pw);
      assert(ro.status === 403 && ro.json?.code === 'ACCOUNT_NOT_LINKABLE', `C platform operator: ${ro.status} ${J(ro.json)}`);
      await unchanged(v0, 'C platform operator');
      await setUsers((u) => (u.id === 'usr_admin' ? opRow : u), 'C op restored');
      details.push('C: not linkable on either side 403; identity group needing a check 409; platform operator 403; paused 403; shared agency 409 (both routes); hash changed / shared membership / caller person changed in the stored doc only -> fresh 409; nothing written');
    }

    // ---- D: bring-in success, single -> single, with references
    {
      const a = await register('da');
      const b = await register('db');
      const c = await register('dc');
      const dd = await doc();
      const bVenue = dd.venues.find((v) => v.agencyId === b.agencyId);
      const cVenue = dd.venues.find((v) => v.agencyId === c.agencyId);
      assert(bVenue && cVenue, 'D venues');
      const B = b.email; const A = a.email; const OTHER = E('other');
      const id = (k) => `t76-d-${k}-${ts}`;
      const fx = {
        venues: [{ id: id('ven'), name: 'T76 owned', agencyId: b.agencyId, ownerEmail: B.toUpperCase() }],
        handoffNotes: [
          { id: id('note'), agencyId: b.agencyId, venueId: bVenue.id, authorEmail: B, authorName: 'B', content: `call ${B} later`, createdAt: new Date().toISOString(), readBy: [B, OTHER] },
          { id: id('note-c'), agencyId: c.agencyId, venueId: cVenue.id, authorEmail: B, authorName: 'B', content: 'other agency', createdAt: new Date().toISOString() },
          { id: id('note-amb'), venueId: cVenue.id, authorEmail: OTHER, authorName: 'O', content: 'ambiguous, not B', createdAt: new Date().toISOString() },
        ],
        announcements: [{ id: id('ann'), agencyId: b.agencyId, authorEmail: B, authorName: 'B', title: 't', body: 'b', targetRoles: ['all'], createdAt: new Date().toISOString(), readBy: [A, B] }],
        taskTemplates: [{ id: id('tpl'), agencyId: b.agencyId, title: 'T76 tpl', createdByEmail: B }],
        tasks: [{ id: id('task'), agencyId: b.agencyId, venueId: bVenue.id, title: 'T76 task', description: '', category: 'General', inputType: 'check_in', assignedTo: [B, OTHER], status: 'pending', isCompleted: false, createdByEmail: B, updatedByEmail: B, updatedByName: 'B', checkIns: [{ id: id('ci'), byEmail: B, byName: 'B', at: new Date().toISOString() }] }],
        historyLogs: [{ id: id('hist'), agencyId: b.agencyId, venueId: bVenue.id, date: '2026-10-01', totalTasks: 1, completedTasks: 1, completionRate: 100, entries: [{ id: id('he'), taskId: 'x', taskTitle: 'x', category: 'General', status: 'completed', isCompleted: true, notes: '', completedByEmail: B, completedByName: 'B', completedAt: null }], resetAt: new Date().toISOString(), resetBy: B }],
        incidents: [{ id: id('inc'), agencyId: b.agencyId, venueId: bVenue.id, title: 'T76', reporterEmail: B, reporterName: 'B', acknowledgedBy: B, resolvedBy: B, status: 'resolved', createdAt: new Date().toISOString() }],
        events: [{ id: id('ev'), agencyId: b.agencyId, venueId: bVenue.id, title: 'T76 ev', location: 'x', date: '2026-11-01', mashgiachType: 'assigned_user', assignedMashgiachEmail: B, assignedMashgiachName: 'B', externalMashgiach: { name: 'B', phone: '', email: B }, status: 'confirmed', tasks: [{ id: id('et'), title: 'x', isCompleted: true, completedByEmail: B }], createdByEmail: B, createdByName: 'B', createdAt: new Date().toISOString() }],
        approvedIngredients: [{ id: id('ing'), agencyId: b.agencyId, venueId: bVenue.id, name: 'Salt', verifiedByEmail: B }],
        factoryReports: [{ id: id('fr'), agencyId: b.agencyId, venueId: bVenue.id, mashgiachEmail: B, mashgiachName: 'B', discrepancies: [{ id: id('disc'), reportedByEmail: B }], items: [] }],
      };
      assert((await hook('inject-fixture', fx)).status === 200, 'D fixtures');
      // B's other state: a pending invite (agency C), a reset request, a legacy push subscription.
      const inv = await req(baseUrl, 'POST', '/api/users', { token: c.token, ip: ip(), body: { email: B, name: 'B in C', role: 'mashgiach', venueId: cVenue.id } });
      assert(inv.status === 201 && inv.json?.pending === true, `D invite B: ${inv.status} ${J(inv.json)}`);
      const fp = await req(baseUrl, 'POST', '/api/auth/forgot-password', { ip: ip(), body: { email: B } });
      assert(fp.status === 200, `D forgot-password: ${fp.status}`);
      assert((await hook('seed-legacy-push-sub', { subEmail: B, endpoint: `https://push.example/t76-${ts}` })).status === 200, 'D legacy push sub');
      const before = await doc();
      assert((before.passwordResets || []).some((r) => r.email === B), 'D reset request exists');
      assert((before.invites || []).some((i) => i.email === B && i.status === 'pending'), 'D invite pending');
      const snapC = J(before.handoffNotes.find((n) => n.id === id('note-c')));
      const snapAmb = J(before.handoffNotes.find((n) => n.id === id('note-amb')));
      const aEpoch = before.users.find((u) => u.id === a.id).tokenEpoch ?? 0;
      const bEpoch = before.users.find((u) => u.id === b.id).tokenEpoch ?? 0;

      const wsB = await connectWs(baseUrl, b.token);
      const r = await bringIn(a.token, B.toUpperCase(), b.pw);
      assert(r.status === 200 && r.json?.merged === true && typeof r.json?.token === 'string', `D bring-in: ${r.status} ${J(r.json)}`);
      assert((await wsB.waitClose(5000)) !== null, 'D B\'s live socket was not closed by the merge');
      assert(r.json.email === A && r.json.user?.id === a.id, `D response email/user: ${J({ e: r.json.email, u: r.json.user?.id })}`);
      const ms = (r.json.memberships || []).map((m) => m.agencyId).sort();
      assert(J(ms) === J([a.agencyId, b.agencyId].sort()), `D memberships: ${J(ms)}`);
      assert(!J(r.json).includes('password') || !/\$2[aby]\$/.test(J(r.json)), 'D no hash in response');

      const after = await doc();
      const aRow = after.users.find((u) => u.id === a.id);
      const bRow = after.users.find((u) => u.id === b.id);
      assert(bRow.personId === a.pid && bRow.email === A, `D B row moved: ${J({ p: bRow.personId, e: bRow.email })}`);
      for (const f of CRED_FIELDS) assert(bRow[f] === undefined, `D B row keeps ${f}`);
      assert(aRow.credentialOwner === true && aRow.credentialOrigin === 'self-registered' && /^\$2[aby]\$/.test(aRow.password), `D A owner: ${J({ o: aRow.credentialOwner, g: aRow.credentialOrigin })}`);
      assert(aRow.tokenEpoch === aEpoch + 1 && bRow.tokenEpoch === bEpoch + 1, `D epochs: ${J([aRow.tokenEpoch, bRow.tokenEpoch])}`);
      assert(bRow.isPrimaryAdmin === true, 'D moved row is still primary admin (adminEmail rewritten)');
      assert(after.agencies.find((x) => x.id === b.agencyId).adminEmail === A, 'D agency adminEmail');
      assert((await rowsOf(b.pid)).length === 0, 'D no row left for B\'s person');
      // sessions
      assert((await current(a.token)).status === 401, 'D A old token dead');
      assert((await current(b.token)).status === 401, 'D B old token dead');
      const cur = await current(r.json.token);
      assert(cur.status === 200, `D fresh token: ${cur.status}`);
      // logins
      const lb = await login(B, b.pw);
      assert(lb.status === 401, `D B login: ${lb.status}`);
      const la = await login(A, a.pw);
      assert(la.status === 200 && la.json?.chooseMembership === true && (la.json.memberships || []).length === 2, `D A login: ${la.status} ${J(la.json?.memberships)}`);
      // references
      const g = (c2, k) => after[c2].find((x) => x.id === id(k));
      const note = g('handoffNotes', 'note');
      assert(note.authorEmail === A && J(note.readBy) === J([A, OTHER]) && note.content === `call ${B} later`, `D note: ${J(note)}`);
      assert(J(after.handoffNotes.find((n) => n.id === id('note-c'))) === snapC, 'D other agency note untouched');
      assert(J(after.handoffNotes.find((n) => n.id === id('note-amb'))) === snapAmb, 'D ambiguous note without B untouched');
      assert(J(g('announcements', 'ann').readBy) === J([A]) && g('announcements', 'ann').authorEmail === A, `D announcement: ${J(g('announcements', 'ann'))}`);
      assert(g('venues', 'ven').ownerEmail === A, 'D venue owner');
      assert(g('taskTemplates', 'tpl').createdByEmail === A, 'D template');
      const tk = g('tasks', 'task');
      assert(J(tk.assignedTo) === J([A, OTHER]) && tk.createdByEmail === A && tk.updatedByEmail === A && tk.checkIns[0].byEmail === A && tk.updatedByName === 'B', `D task: ${J(tk)}`);
      const hl = g('historyLogs', 'hist');
      assert(hl.resetBy === A && hl.entries[0].completedByEmail === A, `D history: ${J(hl)}`);
      const ic = g('incidents', 'inc');
      assert(ic.reporterEmail === A && ic.acknowledgedBy === A && ic.resolvedBy === A, `D incident: ${J(ic)}`);
      const ev = g('events', 'ev');
      assert(ev.assignedMashgiachEmail === A && ev.createdByEmail === A && ev.externalMashgiach.email === A && ev.tasks[0].completedByEmail === A, `D event: ${J(ev)}`);
      assert(g('approvedIngredients', 'ing').verifiedByEmail === A, 'D ingredient');
      const fr = g('factoryReports', 'fr');
      assert(fr.mashgiachEmail === A && fr.discrepancies[0].reportedByEmail === A, `D factory: ${J(fr)}`);
      // other state
      assert(!(after.passwordResets || []).some((x) => x.email === B), 'D reset request removed');
      const invB = (after.invites || []).filter((i) => i.email === B);
      assert(invB.length >= 1 && invB.every((i) => i.status === 'revoked' && i.revokeReason === 'account-merged'), `D invites: ${J(invB.map((i) => [i.status, i.revokeReason]))}`);
      assert(!(after.pushSubscriptions || []).some((s) => s.userEmail === B || s.userId === b.id), 'D push subscriptions removed');
      // nothing live points at B's email any more (revoked invites are inert records)
      // (passwordResetRateLimits is limiter data keyed by the address that asked, not a reference.)
      const liveDoc = { ...after, passwordResetRateLimits: undefined, invites: (after.invites || []).filter((i) => i.status !== 'revoked'), handoffNotes: after.handoffNotes.filter((n) => n.id !== id('note-c') && n.id !== id('note')) };
      const hits = [];
      const walk = (v, path) => {
        if (hits.length > 4) return;
        if (typeof v === 'string') { if (v.toLowerCase().includes(B.toLowerCase())) hits.push(path); return; }
        if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (k.toLowerCase().includes(B.toLowerCase())) hits.push(`${path}.{key}`); walk(v[k], `${path}.${Array.isArray(v) ? (v[k]?.id || k) : k}`); }
      };
      walk(liveDoc, 'doc');
      assert(hits.length === 0, `D B email still referenced live at ${J(hits)}`);
      details.push('D: bring-in single->single: B row -> A person/email, no credential; A owner; all old tokens dead, fresh token works; A login lists 2 agencies, B login 401; every schema email field in B\'s agency -> A (lists deduped, text untouched, other agency + ambiguous-without-B untouched); primary admin follows; invite revoked, reset request + push sub removed; no live reference to B');
    }

    // ---- E: merge-into success, single B in agency-hkc -> multi A
    {
      const m = await register('em');
      const rx = await req(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), body: { agencyName: `T76 em2 ${ts}`, email: m.email, password: m.pw, operationId: op() } });
      assert(rx.status === 201, `E register-existing: ${rx.status} ${J(rx.json)}`);
      const d0 = await doc();
      const hkcVenue = d0.venues.find((v) => (v.agencyId || 'agency-hkc') === 'agency-hkc' && d0.venues.filter((w) => w.id === v.id).length === 1);
      assert(hkcVenue, 'E hkc venue');
      const hid = `usr-t76-h-${ts}`;
      const H = E('h');
      await addUsers([{ id: hid, personId: hid, email: H, name: 'T76 HKC', role: 'mashgiach', agencyId: 'agency-hkc', venueId: hkcVenue.id, avatarColor: '#64748b', kioskPin: '7614', permissions: { canFillTasks: true, canAssignTasks: false } }], 'E hkc row');
      assert((await hook('set-password', { userId: hid, password: PW('h') })).status === 200, 'E set-password');
      await setUsers((x) => (x.id === hid ? { ...x, credentialOrigin: 'self-registered' } : x), 'E origin');
      const hRow0 = (await doc()).users.find((u) => u.id === hid);
      assert(hRow0.personId === hid && hRow0.credentialOrigin === 'self-registered', `E hkc person: ${J({ p: hRow0.personId, o: hRow0.credentialOrigin })}`);
      const id = (k) => `t76-e-${k}-${ts}`;
      assert((await hook('inject-fixture', { handoffNotes: [
        { id: id('n1'), authorEmail: H, authorName: 'H', content: 'legacy no venue', createdAt: new Date().toISOString() },
        { id: id('n2'), venueId: hkcVenue.id, authorEmail: H, authorName: 'H', content: 'legacy hkc venue', createdAt: new Date().toISOString() },
      ] })).status === 200, 'E legacy fixtures');
      const mk = await ctx.api('POST', `/api/users/${hid}/reset-link`, { expectedVersion: await ver() });
      assert(mk.status === 200 || mk.status === 201, `E reset link: ${mk.status} ${J(mk.json)}`);
      const linkId = ((await doc()).resetLinks || []).filter((l) => l.memberId === hid && l.status === 'pending').map((l) => l.id)[0];
      assert(linkId, `E live reset link stored: ${J(((await doc()).resetLinks || []).filter((l) => l.memberId === hid).map((l) => l.status))}`);
      const hTok = await mint(hid);
      const mRows0 = (await rowsOf(m.pid)).length;
      const r = await mergeInto(hTok, m.email, m.pw, PW('h'));
      assert(r.status === 200 && r.json?.merged === true && r.json.user?.id === hid && r.json.email === m.email, `E merge-into: ${r.status} ${J(r.json)}`);
      assert((r.json.memberships || []).length === mRows0 + 1, `E memberships: ${J(r.json.memberships)}`);
      const after = await doc();
      const hRow = after.users.find((u) => u.id === hid);
      assert(hRow.personId === m.pid && hRow.email === m.email, 'E moved');
      for (const f of CRED_FIELDS) assert(hRow[f] === undefined, `E moved row keeps ${f}`);
      assert(hRow.kioskPinRev === (hRow0.kioskPinRev ?? 0) + 1, `E kiosk revision: ${hRow0.kioskPinRev} -> ${hRow.kioskPinRev}`);
      assert(after.users.filter((u) => u.personId === m.pid && u.credentialOwner === true).length === 1, 'E exactly one owner');
      const lk = (after.resetLinks || []).find((l) => l.id === linkId);
      assert(lk && lk.status === 'revoked' && lk.revokeReason === 'account-merged', `E reset link revoked: ${J(lk && [lk.status, lk.revokeReason])}`);
      for (const k of ['n1', 'n2']) assert(after.handoffNotes.find((n) => n.id === id(k)).authorEmail === m.email, `E legacy ${k} rewritten`);
      assert((await current(hTok)).status === 401, 'E caller old token dead');
      const cur = await current(r.json.token);
      assert(cur.status === 200, `E fresh token: ${cur.status}`);
      assert((await login(H, PW('h'))).status === 401, 'E B login fails');
      const la = await login(m.email, m.pw);
      assert(la.status === 200 && (la.json.memberships || []).length === mRows0 + 1, `E A login: ${J(la.json?.memberships)}`);
      details.push('E: merge-into (B single in agency-hkc, A multi): device stays signed in as the moved row; legacy records (no agencyId: no venue / HKC venue) rewritten; kiosk revision +1; B\'s live reset link revoked; one owner; A login lists 3 agencies; B login 401');
    }

    // ---- F: ambiguous legacy records holding B's email -> 409, nothing written
    {
      const p = await register('fp');
      const x = await register('fx');
      const y = await register('fy');
      const xVenue = (await doc()).venues.find((v) => v.agencyId === x.agencyId);
      assert((await hook('inject-fixture', { handoffNotes: [
        { id: `t76-f-1-${ts}`, venueId: xVenue.id, authorEmail: x.email, authorName: 'X', content: 'legacy other-agency venue', createdAt: new Date().toISOString() },
        { id: `t76-f-2-${ts}`, venueId: `venue-t76-missing-${ts}`, authorEmail: y.email, authorName: 'Y', content: 'legacy missing venue', createdAt: new Date().toISOString() },
      ] })).status === 200, 'F fixtures');
      const v0 = await ver();
      const r1 = await bringIn(p.token, x.email, x.pw);
      assert(r1.status === 409 && r1.json?.code === 'MERGE_NEEDS_CHECK', `F venue of another agency: ${r1.status} ${J(r1.json)}`);
      const r2 = await bringIn(p.token, y.email, y.pw);
      assert(r2.status === 409 && r2.json?.code === 'MERGE_NEEDS_CHECK', `F missing venue: ${r2.status} ${J(r2.json)}`);
      await unchanged(v0, 'F');
      assert((await current(x.token)).status === 200, 'F X session intact');
      details.push('F: legacy record (no agencyId) whose venue is in another agency / missing, holding B\'s email -> 409 MERGE_NEEDS_CHECK, nothing written');
    }

    // ---- G: idempotency
    {
      const a = await register('ga');
      const b = await register('gb');
      const opId = op();
      const body = { email: b.email, password: b.pw, confirm: true, operationId: opId };
      const [r1, r2] = await Promise.all([
        req(baseUrl, 'POST', '/api/account/bring-in', { token: a.token, ip: ip(), body }),
        req(baseUrl, 'POST', '/api/account/bring-in', { token: a.token, ip: ip(), body }),
      ]);
      const oks = [r1, r2].filter((r) => r.status === 200);
      assert(oks.length >= 1, `G one success: ${J([r1.status, r2.status, r1.json?.code, r2.json?.code])}`);
      for (const r of [r1, r2]) assert(r.status === 200 || [401, 403, 409].includes(r.status), `G other answer: ${r.status} ${J(r.json)}`);
      const rowsA = await rowsOf(a.pid);
      assert(rowsA.length === 2 && (await rowsOf(b.pid)).length === 0, `G one merge: ${rowsA.length}`);
      const v0 = await ver();
      const again = await bringIn(oks[0].json.token, b.email, b.pw);
      assert(again.status === 403, `G retry after success: ${again.status} ${J(again.json)}`);
      const again2 = await req(baseUrl, 'POST', '/api/account/bring-in', { token: oks[0].json.token, ip: ip(), body });
      assert(again2.status === 403, `G same operationId later: ${again2.status} ${J(again2.json)}`);
      await unchanged(v0, 'G retries');
      details.push(`G: same operationId twice at once -> ${J([r1.status, r2.status])}, one merge; later retries (new or same operationId) refused, nothing written`);
    }

    return details.join('; ');
  },
};
