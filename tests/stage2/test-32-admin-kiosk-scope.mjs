/**
 * Test 32 (K1): an admin's KIOSK token is a mashgiach — never admin powers.
 *
 * Don, Oct 20 7:29 PM: "admin should be able. But when [he] is in the kiosk
 * as a kiosk, it should function for him just as Mashgiach to tap tasks."
 * Design: kioskActingUser() turns an admin into a mashgiach at the TABLET's
 * venue at the identity boundary (HTTP middleware, WS handshake,
 * recipientForMeta, kiosk login response); kioskUserFitsVenue() lets an
 * admin sign in on any paired tablet of the OWN agency. Full admin powers
 * need a phone session (email + password).
 *
 * Every refusal has a positive twin (rule G): the same calls with the
 * admin's PHONE token succeed, so a 403 is the downgrade, not a broken route.
 *
 * Parts:
 *  1 the tablet lists admins with a code; an admin (and the PRIMARY admin)
 *    signs in on tablet A → 200, response user.role 'mashgiach', venue A,
 *    no hash / digits / phone in the response.
 *  2 admin powers refused on the admin's kiosk token (REST): team, venues,
 *    agency settings, tasks create/delete/definition edits, other venue's
 *    tasks, private task of someone else, announcements, dashboard, kiosk
 *    pairing/devices, alerts/incidents, updates, export.
 *  3 what a mashgiach may do still works: GET /tasks (A only, no private
 *    task of another), PUT /tasks/:id status on an A task → 200.
 *  4 GET /announcements: an admin-only announcement is NOT shown; an 'all'
 *    one is. GET /users (kiosk) has no emails/phones.
 *  5 WebSocket: INITIAL_STATE carries only venue A and no private task of
 *    another; a TASK_UPDATED of that private task is not delivered.
 *  6 an admin of ANOTHER agency → generic 401 'Wrong code'.
 *  7 the admin is demoted to mashgiach at venue B → next kiosk request on
 *    tablet A → 401 (the venue rule re-reads the role every request).
 *  8 twin: the same admin's PHONE token still has its admin powers.
 *  9 a mashgiach PROMOTED to admin with an open kiosk socket: the pushed
 *    INITIAL_STATE is kiosk-filtered, no private task of another arrives,
 *    the kiosk token still cannot do admin actions.
 * 10 PIN removed with an open kiosk socket → socket 4401, token 401.
 * 11 tablet unpaired → socket 4401, token 401.
 * Also (ChatGPT plan review): the direct INITIAL_STATE pushed after a change
 * to the admin's own record is checked field by field on the kiosk socket.
 */

const AGENCY = 'agency-test32';
const OTHER_AGENCY = 'agency-test32-other';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return { id: claimed.device.id, header: `${claimed.device.id}.${deviceSecret}` };
}

function connectWs(baseUrl, token, credential) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      ws, messages, closeCode: null,
      waitClose: async (ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (conn.closeCode !== null) return conn.closeCode; await sleep(100); }
        return conn.closeCode;
      },
      waitFor: async (pred, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); }
        return null;
      },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => { if (credential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential })); } catch {} } };
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
    ws.onclose = (ev) => { clearTimeout(timer); conn.closeCode = ev.code; if (!messages.some((m) => m.type === 'INITIAL_STATE')) reject(new Error(`WS closed before INITIAL_STATE (${ev.code})`)); };
  });
}

export default {
  name: 'Test 32: an admin kiosk session is mashgiach-only (K1)',
  whatItProves:
    "An admin (incl. the primary admin) can sign in on a paired tablet of their own agency, but the kiosk token acts as a mashgiach at that tablet's venue: every admin action is refused over REST, private/other-venue data never reaches the tablet over REST or WebSocket, and the same admin's phone token keeps its powers.",

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA = `venue-t32a-${ts}`;
    const vB = `venue-t32b-${ts}`;
    const vO = `venue-t32o-${ts}`;
    const adminId = `user-t32-admin-${ts}`;
    const primaryId = `user-t32-primary-${ts}`;
    const otherAdminId = `user-t32-oadmin-${ts}`;
    const mashA = `user-t32-masha-${ts}`;
    const mashAEmail = `masha32-${ts}@test.local`;
    const tPublicA = `task-t32-pubA-${ts}`;
    const tPrivA = `task-t32-privA-${ts}`;
    const tB = `task-t32-B-${ts}`;
    const tPrivX = `task-t32-privX-${ts}`;
    const ADMIN_PIN = '5813';
    const PRIMARY_PIN = '7392';
    const task = (id, venueId, extra = {}) => ({
      id, agencyId: AGENCY, venueId, title: `T32 ${id}`, category: 'General', categories: ['General'],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false,
      assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0, ...extra,
    });
    const nowIso = new Date().toISOString();
    const annAdmin = `ann-t32-admin-${ts}`;
    const annAll = `ann-t32-all-${ts}`;

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test32 Agency' }, { id: OTHER_AGENCY, name: 'Test32 Other' }],
      venues: [
        { id: vA, name: `T32 A ${ts}`, agencyId: AGENCY },
        { id: vB, name: `T32 B ${ts}`, agencyId: AGENCY },
        { id: vO, name: `T32 O ${ts}`, agencyId: OTHER_AGENCY },
      ],
      users: [
        { id: adminId, email: `admin32-${ts}@test.local`, name: 'T32 Admin', role: 'admin', agencyId: AGENCY, kioskPin: ADMIN_PIN, phoneNumber: '+18605550132' },
        { id: primaryId, email: `primary32-${ts}@test.local`, name: 'T32 Primary', role: 'admin', agencyId: AGENCY, kioskPin: PRIMARY_PIN },
        { id: otherAdminId, email: `oadmin32-${ts}@test.local`, name: 'T32 Other Admin', role: 'admin', agencyId: OTHER_AGENCY, kioskPin: '2580' },
        { id: mashA, email: mashAEmail, name: 'T32 Mash A', role: 'mashgiach', agencyId: AGENCY, venueId: vA, kioskPin: '1470', phoneNumber: '+18605550133' },
      ],
      tasks: [
        task(tPublicA, vA),
        task(tPrivA, vA, { isPrivate: true, assignedTo: [mashAEmail] }),
        task(tPrivX, vA, { isPrivate: true, assignedTo: [`someone32-${ts}@test.local`] }),
        task(tB, vB),
      ],
      announcements: [
        { id: annAdmin, agencyId: AGENCY, title: 'T32 admins only', body: 'admins', targetRoles: ['admin'], createdAt: nowIso, authorEmail: 'x@test.local' },
        { id: annAll, agencyId: AGENCY, title: 'T32 everyone', body: 'all', targetRoles: ['all'], createdAt: nowIso, authorEmail: 'x@test.local' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const tAdminPhone = await mintToken(baseUrl, adminId);
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdminPhone) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const devA = await pairDevice(baseUrl, tAdminPhone, vA);

    // --- 1. roster lists admins; admin + primary admin sign in as mashgiach ---
    const roster = await fetch(`${baseUrl}/api/kiosk/device`, { headers: { 'X-Kiosk-Device': devA.header } });
    const rosterBody = await roster.json().catch(() => ({}));
    const ids = (rosterBody.users || []).map((u) => u.id);
    if (!ids.includes(adminId) || !ids.includes(primaryId) || !ids.includes(mashA)) {
      throw new Error(`tablet roster should list both admins and the mashgiach: ${JSON.stringify(ids)}`);
    }
    if (ids.includes(otherAdminId)) throw new Error('tablet roster lists an admin of ANOTHER agency');
    for (const u of rosterBody.users) {
      const extra = Object.keys(u).filter((k) => !['avatarColor', 'id', 'name', 'role'].includes(k));
      if (extra.length) throw new Error(`tablet roster entry has extra fields: ${extra.join(',')}`);
    }

    const login = async (userId, pin, header = devA.header) => {
      const r = await fetch(`${baseUrl}/api/kiosk/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': header },
        body: JSON.stringify({ userId, pin }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const la = await login(adminId, ADMIN_PIN);
    if (la.status !== 200 || !la.body.token) throw new Error(`admin kiosk login: ${la.status} ${JSON.stringify(la.body)}`);
    if (la.body.user?.role !== 'mashgiach' || la.body.user?.venueId !== vA) {
      throw new Error(`admin kiosk login must return the acting mashgiach at venue A, got role=${la.body.user?.role} venue=${la.body.user?.venueId}`);
    }
    for (const k of ['kioskPin', 'kioskPinHash', 'kioskPinSetAt', 'password', 'phoneNumber', 'hasKioskPin']) {
      if (k in la.body.user) throw new Error(`kiosk login response carries ${k}`);
    }
    const lp = await login(primaryId, PRIMARY_PIN);
    if (lp.status !== 200 || lp.body.user?.role !== 'mashgiach') throw new Error(`primary admin kiosk login: ${lp.status} role=${lp.body.user?.role}`);

    const K = { ...auth(la.body.token), 'X-Kiosk-Device': devA.header };
    const KP = { ...auth(lp.body.token), 'X-Kiosk-Device': devA.header };

    // --- 2. admin powers refused on the kiosk token ---
    const v = async () => ctx.getVersion();
    const attempts = [
      ['GET', '/api/users?venueId=' + vB, null, 'kiosk roster only'],
      ['POST', '/api/users', { email: `new32-${ts}@test.local`, name: 'X', role: 'admin', password: 'secret12' }],
      ['PUT', `/api/users/${mashA}`, { role: 'admin' }],
      ['PUT', `/api/users/${mashA}`, { kioskPin: '9999' }],
      ['PUT', `/api/users/${adminId}`, { phoneNumber: '+18605550199' }],
      ['DELETE', `/api/users/${mashA}`, null],
      ['POST', '/api/venues', { name: 'Evil venue' }],
      ['PUT', `/api/venues/${vA}`, { name: 'Renamed' }],
      ['DELETE', `/api/venues/${vB}`, null],
      ['PUT', '/api/agencies/current', { name: 'Hacked agency' }],
      ['GET', '/api/agencies/current', null],
      ['POST', '/api/tasks', { title: 'evil', venueId: vA, category: 'General', assignedTo: ['all'] }],
      ['DELETE', `/api/tasks/${tPublicA}`, null],
      ['PUT', `/api/tasks/${tPublicA}`, { title: 'renamed' }],
      ['PUT', `/api/tasks/${tPublicA}`, { assignedTo: ['x@test.local'] }],
      ['PUT', `/api/tasks/${tPublicA}`, { notes: 'note' }],
      ['PUT', `/api/tasks/${tB}`, { currentStatus: 'completed', isCompleted: true }],
      ['PUT', `/api/tasks/${tPrivA}`, { currentStatus: 'completed', isCompleted: true }],
      ['POST', `/api/tasks/${tPrivA}/check-in`, {}],
      ['POST', `/api/tasks/${tB}/check-in`, {}],
      ['POST', '/api/announcements', { title: 'evil', body: 'x', targetRoles: ['all'] }],
      ['DELETE', `/api/announcements/${annAll}`, null],
      ['POST', '/api/handoff-notes', { content: 'x', venueId: vA }],
      ['GET', '/api/admin/dashboard', null],
      ['GET', '/api/admin/export', null],
      ['GET', '/api/kiosk/devices', null],
      ['POST', '/api/kiosk/devices/pair', { code: '123456', venueId: vA }],
      ['DELETE', `/api/kiosk/devices/${devA.id}`, null],
      ['GET', '/api/incidents', null],
      ['POST', '/api/incidents', { venueId: vA, title: 'x', description: 'x', severity: 'low' }],
      ['GET', '/api/updates/alert-mute', null],
      ['PUT', '/api/updates/alert-mute', { muted: true }],
      ['POST', '/api/updates/seen', { kind: 'alerts', ids: [] }],
      ['GET', '/api/events', null],
      ['GET', '/api/airtable/config', null],
    ];
    const leaks = [];
    for (const [token, label] of [[K, 'admin'], [KP, 'primary admin']]) {
      for (const [method, path, body] of attempts) {
        if (method === 'GET' && path.startsWith('/api/users?')) continue; // checked in part 4
        const r = await fetch(`${baseUrl}${path}`, {
          method, headers: token,
          body: body === null ? undefined : JSON.stringify({ ...body, expectedVersion: await v(), operationId: crypto.randomUUID() }),
        });
        if (r.status !== 403 && r.status !== 401) leaks.push(`${label}: ${method} ${path} → ${r.status}`);
        if (r.status === 401) leaks.push(`${label}: ${method} ${path} → 401 (session dropped — expected 403)`);
      }
    }
    if (leaks.length) throw new Error(`admin kiosk token reached admin actions:\n  ${leaks.join('\n  ')}`);
    // nothing changed
    const doc = await ctx.getDoc();
    const venA = doc.venues.find((x) => x.id === vA);
    if (!venA || venA.name !== `T32 A ${ts}`) throw new Error('venue A was changed by a kiosk token');
    if (!doc.venues.find((x) => x.id === vB)) throw new Error('venue B was deleted by a kiosk token');
    const m = doc.users.find((x) => x.id === mashA);
    if (!m || m.role !== 'mashgiach') throw new Error('mashgiach was changed by a kiosk token');
    if (doc.users.some((x) => x.email === `new32-${ts}@test.local`)) throw new Error('a user was created by a kiosk token');
    const pubA = doc.tasks.find((x) => x.id === tPublicA);
    if (!pubA || pubA.title !== `T32 ${tPublicA}`) throw new Error('task definition changed by a kiosk token');
    if (doc.tasks.find((x) => x.id === tPrivA)?.isCompleted) throw new Error('private task of another was completed by an admin kiosk token');
    if (doc.tasks.find((x) => x.id === tB)?.isCompleted) throw new Error('venue-B task was completed by a tablet-A token');
    if ((doc.tasks.find((x) => x.id === tPrivA)?.checkIns || []).length) throw new Error('check-in logged on a private task of another from a kiosk');

    // --- 3. mashgiach things still work ---
    // Rule T (unchanged): a non-admin asking for another venue gets an empty
    // list; without ?venueId the tablet's venue is served.
    const trB = await fetch(`${baseUrl}/api/tasks?venueId=${vB}`, { headers: K });
    const trBBody = await trB.json().catch(() => ({}));
    const listB = (Array.isArray(trBBody) ? trBBody : trBBody.tasks || []).map((x) => x.id);
    if (trB.status !== 200) throw new Error(`kiosk GET /tasks?venueId=B: ${trB.status}`);
    if (listB.length) throw new Error(`kiosk GET /tasks?venueId=B returned tasks: ${listB.join(',')}`);
    const tr = await fetch(`${baseUrl}/api/tasks`, { headers: K });
    const trBody = await tr.json().catch(() => ({}));
    const list = Array.isArray(trBody) ? trBody : trBody.tasks || [];
    const tids = list.map((x) => x.id);
    if (tr.status !== 200) throw new Error(`kiosk GET /tasks: ${tr.status}`);
    if (!tids.includes(tPublicA)) throw new Error('kiosk GET /tasks is missing the public venue-A task');
    if (tids.includes(tB)) throw new Error('kiosk GET /tasks returned a venue-B task');
    if (tids.includes(tPrivA)) throw new Error("admin kiosk GET /tasks returned another person's PRIVATE task");
    const tap = await fetch(`${baseUrl}/api/tasks/${tPublicA}`, {
      method: 'PUT', headers: K,
      body: JSON.stringify({ currentStatus: 'completed', isCompleted: true, expectedVersion: await v(), operationId: crypto.randomUUID() }),
    });
    if (tap.status !== 200) throw new Error(`admin kiosk status tap on own-venue task: ${tap.status}`);

    // --- 4. announcements targeting + kiosk roster ---
    const an = await fetch(`${baseUrl}/api/announcements`, { headers: K });
    const anBody = await an.json().catch(() => ({}));
    const anList = Array.isArray(anBody) ? anBody : anBody.announcements || [];
    const anIds = anList.map((x) => x.id);
    if (an.status !== 200) throw new Error(`kiosk announcements: ${an.status}`);
    if (anIds.includes(annAdmin)) throw new Error('admin-only announcement shown on an admin kiosk session');
    if (!anIds.includes(annAll)) throw new Error("'all' announcement missing on the admin kiosk session");
    const ur = await fetch(`${baseUrl}/api/users`, { headers: K });
    const urBody = await ur.json().catch(() => ({}));
    for (const u of urBody.users || []) {
      if ('email' in u || 'phoneNumber' in u || 'hasKioskPin' in u) throw new Error(`kiosk GET /users leaks ${Object.keys(u).join(',')}`);
    }

    // A kiosk snapshot is checked field by field: only venue A, no private
    // task of another, a 4-field roster, no events/configs.
    const checkKioskSnapshot = (p, where) => {
      const tids = (p.tasks || []).map((x) => x.id);
      if (tids.includes(tPrivX)) throw new Error(`${where}: carries another person's private task`);
      if (tids.includes(tB)) throw new Error(`${where}: carries a venue-B task`);
      if ((p.venues || []).some((x) => x.id !== vA)) throw new Error(`${where}: carries another venue`);
      if ((p.historyLogs || []).some((h) => h.venueId && h.venueId !== vA)) throw new Error(`${where}: carries another venue's history`);
      for (const u of p.users || []) {
        const extra = Object.keys(u).filter((k) => !['avatarColor', 'id', 'name', 'role'].includes(k));
        if (extra.length) throw new Error(`${where}: roster entry has ${extra.join(',')}`);
      }
      for (const k of ['events', 'airtableConfigs', 'approvedIngredients', 'factoryReports']) {
        if (Array.isArray(p[k]) && p[k].length) throw new Error(`${where}: carries ${k}`);
      }
    };

    // --- 5. WebSocket ---
    const conn = await connectWs(baseUrl, la.body.token, devA.header);
    try {
      const init = conn.messages.find((x) => x.type === 'INITIAL_STATE').payload;
      checkKioskSnapshot(init, 'WS INITIAL_STATE');
      const wsTaskIds = (init.tasks || []).map((x) => x.id);
      if (wsTaskIds.includes(tPrivA)) throw new Error("WS INITIAL_STATE on an admin kiosk socket carries another person's private task");
      if (wsTaskIds.includes(tB)) throw new Error('WS INITIAL_STATE carries a venue-B task');
      if (!wsTaskIds.includes(tPublicA)) throw new Error('WS INITIAL_STATE missing the public venue-A task');
      if ((init.venues || []).some((x) => x.id !== vA)) throw new Error('WS INITIAL_STATE carries another venue');
      for (const u of init.users || []) {
        if ('email' in u || 'phoneNumber' in u) throw new Error('WS INITIAL_STATE roster leaks email/phone');
      }
      // The admin's phone session edits the private task → a TASK_UPDATED
      // must not reach the kiosk socket (the mashgiach-of-record would see it).
      conn.messages.length = 0;
      const ed = await fetch(`${baseUrl}/api/tasks/${tPrivA}`, {
        method: 'PUT', headers: auth(tAdminPhone),
        body: JSON.stringify({ currentStatus: 'completed', isCompleted: true, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (ed.status !== 200) throw new Error(`phone edit of the private task: ${ed.status}`);
      const leaked = await conn.waitFor((x) => (x.type === 'TASK_UPDATED' || x.type === 'TASK_CREATED') && (x.payload?.task?.id || x.payload?.id) === tPrivA, 2500);
      if (leaked) throw new Error('private task update was delivered to the admin kiosk socket');
      // twin: a public task update IS delivered
      const ed2 = await fetch(`${baseUrl}/api/tasks/${tPublicA}`, {
        method: 'PUT', headers: auth(tAdminPhone),
        body: JSON.stringify({ currentStatus: 'pending', isCompleted: false, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (ed2.status !== 200) throw new Error(`phone edit of the public task: ${ed2.status}`);
      const got = await conn.waitFor((x) => x.type === 'TASK_UPDATED' && (x.payload?.task?.id || x.payload?.id) === tPublicA, 4000);
      if (!got) throw new Error('public task update did not reach the kiosk socket (twin)');

      // Direct INITIAL_STATE path (ChatGPT plan review, blocker 1): a change
      // to the admin's OWN record (venue assignment) makes the server push a
      // fresh INITIAL_STATE to that user's sockets — the kiosk socket must
      // get the kiosk-filtered, mashgiach snapshot, never the admin's.
      conn.messages.length = 0;
      const tPrimaryPhone0 = await mintToken(baseUrl, primaryId);
      const re = await fetch(`${baseUrl}/api/users/${adminId}`, {
        method: 'PUT', headers: auth(tPrimaryPhone0),
        body: JSON.stringify({ venueId: vA, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (re.status !== 200) throw new Error(`assign the admin a venue: ${re.status}`);
      const fresh = await conn.waitFor((x) => x.type === 'INITIAL_STATE', 4000);
      if (!fresh) throw new Error('no fresh INITIAL_STATE after the admin record changed (the direct-send path was not exercised)');
      checkKioskSnapshot(fresh.payload, 'direct INITIAL_STATE after an admin record change');
    } finally {
      conn.close();
    }

    // --- 6. admin of another agency: generic wrong code ---
    const lo = await login(otherAdminId, '2580');
    if (lo.status !== 401 || lo.body.error !== 'Wrong code. Try again.') throw new Error(`other-agency admin on tablet A: ${lo.status} ${JSON.stringify(lo.body)}`);

    // --- 8 (before 7). twin: the admin's PHONE token keeps admin powers ---
    const ph = await fetch(`${baseUrl}/api/kiosk/devices`, { headers: auth(tAdminPhone) });
    if (ph.status !== 200) throw new Error(`phone admin GET /kiosk/devices: ${ph.status}`);
    const ph2 = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: auth(tAdminPhone) });
    if (ph2.status !== 200) throw new Error(`phone admin dashboard: ${ph2.status}`);

    // Open sockets for the lifecycle checks below.
    const tPrimaryPhone = await mintToken(baseUrl, primaryId);
    const SA = await connectWs(baseUrl, la.body.token, devA.header);
    const SP = await connectWs(baseUrl, lp.body.token, devA.header);
    const lm = await login(mashA, '1470');
    if (lm.status !== 200) throw new Error(`mashgiach kiosk login: ${lm.status}`);
    const KM = { ...auth(lm.body.token), 'X-Kiosk-Device': devA.header };
    const SM = await connectWs(baseUrl, lm.body.token, devA.header);
    // Something on venue A that every valid kiosk socket gets → forces a
    // delivery (and so a re-validation) on each socket.
    let flip = false;
    const nudge = async () => {
      flip = !flip;
      const r = await fetch(`${baseUrl}/api/tasks/${tPublicA}`, {
        method: 'PUT', headers: auth(tPrimaryPhone),
        body: JSON.stringify({ currentStatus: flip ? 'completed' : 'pending', isCompleted: flip, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (r.status !== 200) throw new Error(`nudge: ${r.status}`);
    };
    try {
      // --- 9. a mashgiach PROMOTED to admin while their kiosk socket is open
      // never inherits admin authority on that socket or token.
      SM.messages.length = 0;
      const pr = await fetch(`${baseUrl}/api/users/${mashA}`, {
        method: 'PUT', headers: auth(tPrimaryPhone),
        body: JSON.stringify({ role: 'admin', expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (pr.status !== 200) throw new Error(`promote mashgiach: ${pr.status}`);
      const prState = await SM.waitFor((x) => x.type === 'INITIAL_STATE', 4000);
      if (prState) checkKioskSnapshot(prState.payload, 'INITIAL_STATE after promotion to admin');
      SM.messages.length = 0;
      const edX = await fetch(`${baseUrl}/api/tasks/${tPrivX}`, {
        method: 'PUT', headers: auth(tPrimaryPhone),
        body: JSON.stringify({ currentStatus: 'completed', isCompleted: true, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (edX.status !== 200) throw new Error(`phone edit of private task X: ${edX.status}`);
      const leakX = await SM.waitFor((x) => (x.payload?.task?.id || x.payload?.id) === tPrivX, 2500);
      if (leakX) throw new Error('promoted-admin kiosk socket received another person\'s private task');
      for (const [method, path] of [['GET', '/api/kiosk/devices'], ['GET', '/api/admin/dashboard'], ['POST', '/api/users']]) {
        const r = await fetch(`${baseUrl}${path}`, { method, headers: KM, body: method === 'POST' ? JSON.stringify({ email: `p32-${ts}@test.local`, name: 'P' }) : undefined });
        if (r.status !== 403) throw new Error(`promoted-admin kiosk token: ${method} ${path} → ${r.status} (expected 403)`);
      }
      const tl = await fetch(`${baseUrl}/api/tasks`, { headers: KM });
      const tlb = await tl.json().catch(() => ({}));
      const tlIds = (Array.isArray(tlb) ? tlb : tlb.tasks || []).map((x) => x.id);
      if (tl.status !== 200 || tlIds.includes(tPrivX) || tlIds.includes(tB)) throw new Error(`promoted-admin kiosk GET /tasks: ${tl.status} ${tlIds.join(',')}`);

      // --- 10. PIN removed while the primary admin's kiosk socket is open → 4401
      const rp = await fetch(`${baseUrl}/api/users/${primaryId}`, {
        method: 'PUT', headers: auth(tAdminPhone),
        body: JSON.stringify({ kioskPin: '', expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (rp.status !== 200) throw new Error(`remove primary's PIN: ${rp.status}`);
      await nudge();
      const spCode = await SP.waitClose(4000);
      if (spCode !== 4401) throw new Error(`primary admin kiosk socket after PIN removal: close ${spCode} (expected 4401)`);
      const kpAfter = await fetch(`${baseUrl}/api/tasks`, { headers: KP });
      if (kpAfter.status !== 401) throw new Error(`primary admin kiosk token after PIN removal: ${kpAfter.status}`);

      // --- 7. the admin is demoted to a mashgiach at venue B → tablet-A
      // session and socket die (the venue rule re-reads the role each time).
      const dem = await fetch(`${baseUrl}/api/users/${adminId}`, {
        method: 'PUT', headers: auth(tPrimaryPhone),
        body: JSON.stringify({ role: 'mashgiach', venueId: vB, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (dem.status !== 200) throw new Error(`demote admin: ${dem.status}`);
      const after = await fetch(`${baseUrl}/api/tasks`, { headers: K });
      if (after.status !== 401) throw new Error(`demoted admin's tablet-A kiosk session should be 401, got ${after.status}`);
      await nudge();
      const saCode = await SA.waitClose(4000);
      if (saCode !== 4401) throw new Error(`demoted admin's kiosk socket: close ${saCode} (expected 4401)`);
      // twin: the promoted (now admin) mashgiach's session on the same tablet still works
      if (SM.closeCode !== null) throw new Error(`promoted-admin kiosk socket closed unexpectedly (${SM.closeCode})`);
      const stillM = await fetch(`${baseUrl}/api/tasks`, { headers: KM });
      if (stillM.status !== 200) throw new Error(`promoted-admin kiosk session should still work: ${stillM.status}`);

      // --- 11. the tablet is unpaired → its last session and socket die
      const un = await fetch(`${baseUrl}/api/kiosk/devices/${devA.id}`, {
        method: 'DELETE', headers: auth(tPrimaryPhone), // the other admin was demoted above
        body: JSON.stringify({ expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      if (un.status !== 200 && un.status !== 204) throw new Error(`unpair: ${un.status}`);
      const kmAfter = await fetch(`${baseUrl}/api/tasks`, { headers: KM });
      if (kmAfter.status !== 401) throw new Error(`kiosk token after unpair: ${kmAfter.status}`);
      await nudge();
      const smCode = await SM.waitClose(4000);
      if (smCode !== 4401) throw new Error(`kiosk socket after unpair: close ${smCode} (expected 4401)`);
    } finally {
      SA.close(); SP.close(); SM.close();
    }

    return `admin + primary admin sign in as mashgiach; ${attempts.length - 1} admin actions refused on both kiosk tokens; private/other-venue data withheld over REST and WS; promotion never grants admin on a kiosk; PIN removal, demotion and unpair kill open sessions/sockets; phone token keeps admin powers`;
  },
};
