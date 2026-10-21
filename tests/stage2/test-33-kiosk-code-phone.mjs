/**
 * Test 33 (K1): kiosk-code marker + optional phone number, privacy and rule T.
 *
 * - hasKioskPin is a BOOLEAN added only in the manager view; the hash, the
 *   digits and kioskPinSetAt never appear anywhere.
 * - phoneNumber (E.164) is personal data: visible to the agency admin, and to
 *   a coordinator only for mashgiach/worker users at the coordinator's own
 *   venue; never to a mashgiach, never on a kiosk, never in a WS roster of a
 *   non-manager.
 * - Writes: admin anyone in the agency (POST + PUT); coordinator only
 *   { kioskPin, phoneNumber } for own-venue mashgiach/worker.
 * - Validation: bad → 400, 10 digits → +1…, "" clears.
 * - A code reset bumps the PIN revision: the old kiosk token is dead.
 *
 * Every refusal has a positive twin (rule G).
 */

const AGENCY = 'agency-test33';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      messages,
      waitFor: async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); }
        return null;
      },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

export default {
  name: 'Test 33: kiosk code marker + phone number privacy (K1)',
  whatItProves:
    'hasKioskPin is a manager-only boolean (never the hash/digits); phoneNumber is validated, writable by the admin and by a coordinator for own-venue staff only, and visible only to those managers — never to a mashgiach, a kiosk, or a non-manager socket.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA = `venue-t33a-${ts}`;
    const vB = `venue-t33b-${ts}`;
    const adminId = `user-t33-admin-${ts}`;
    const coordA = `user-t33-coorda-${ts}`;
    const mashA = `user-t33-masha-${ts}`;
    const mashA2 = `user-t33-masha2-${ts}`;
    const mashB = `user-t33-mashb-${ts}`;
    const PHONE_A = '+18605550101';
    const PHONE_B = '+18605550102';
    const PHONE_ADMIN = '+18605550103';

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test33 Agency' }],
      venues: [{ id: vA, name: `T33 A ${ts}`, agencyId: AGENCY }, { id: vB, name: `T33 B ${ts}`, agencyId: AGENCY }],
      users: [
        { id: adminId, email: `admin33-${ts}@test.local`, name: 'T33 Admin', role: 'admin', agencyId: AGENCY, phoneNumber: PHONE_ADMIN },
        { id: coordA, email: `coorda33-${ts}@test.local`, name: 'T33 Coord A', role: 'coordinator', agencyId: AGENCY, venueId: vA },
        { id: mashA, email: `masha33-${ts}@test.local`, name: 'T33 Mash A', role: 'mashgiach', agencyId: AGENCY, venueId: vA, kioskPin: '3141', phoneNumber: PHONE_A },
        { id: mashA2, email: `masha233-${ts}@test.local`, name: 'T33 Mash A2', role: 'mashgiach', agencyId: AGENCY, venueId: vA },
        { id: mashB, email: `mashb33-${ts}@test.local`, name: 'T33 Mash B', role: 'mashgiach', agencyId: AGENCY, venueId: vB, phoneNumber: PHONE_B },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, adminId);
    const tCoord = await mintToken(baseUrl, coordA);
    const tMash = await mintToken(baseUrl, mashA2);
    const v = async () => ctx.getVersion();
    const SECRET_KEYS = ['kioskPin', 'kioskPinHash', 'kioskPinSetAt', 'password', 'passwordHash'];
    const noSecrets = (u, where) => {
      for (const k of SECRET_KEYS) if (k in u) throw new Error(`${where}: user ${u.id} carries ${k}`);
    };
    const roster = async (token) => {
      const r = await fetch(`${baseUrl}/api/users`, { headers: auth(token) });
      if (r.status !== 200) throw new Error(`GET /users: ${r.status}`);
      return (await r.json()).users || [];
    };
    const byId = (list, id) => list.find((u) => u.id === id);

    // --- 1. admin view: marker + phones, never secrets ---
    const ra = await roster(tAdmin);
    ra.forEach((u) => noSecrets(u, 'admin roster'));
    if (byId(ra, mashA)?.hasKioskPin !== true) throw new Error('admin roster: hasKioskPin should be true for the PIN user');
    if (byId(ra, mashA2)?.hasKioskPin !== false) throw new Error('admin roster: hasKioskPin should be false (not missing) for a user without a PIN');
    if (byId(ra, mashA)?.phoneNumber !== PHONE_A || byId(ra, mashB)?.phoneNumber !== PHONE_B) throw new Error('admin roster: phone numbers missing');

    // --- 2. coordinator view: own-venue mashgiach only ---
    const rc = await roster(tCoord);
    rc.forEach((u) => noSecrets(u, 'coordinator roster'));
    if (byId(rc, mashA)?.phoneNumber !== PHONE_A || byId(rc, mashA)?.hasKioskPin !== true) throw new Error('coordinator roster: own-venue mashgiach phone/marker missing');
    if (byId(rc, mashB)) throw new Error('coordinator roster lists a venue-B mashgiach');
    const adminInCoord = byId(rc, adminId);
    if (adminInCoord && ('phoneNumber' in adminInCoord || 'hasKioskPin' in adminInCoord)) throw new Error("coordinator sees the admin's phone/marker");

    // --- 3. mashgiach view: no phones, no markers ---
    const rm = await roster(tMash);
    for (const u of rm) {
      noSecrets(u, 'mashgiach roster');
      if ('phoneNumber' in u || 'hasKioskPin' in u) throw new Error(`mashgiach roster leaks ${u.id}: ${Object.keys(u).join(',')}`);
    }
    if (!byId(rm, mashA)) throw new Error('mashgiach roster should still list a venue colleague (twin)');

    // --- 4. WS rosters follow the same rule ---
    const wsM = await connectWs(baseUrl, tMash);
    const wsA = await connectWs(baseUrl, tAdmin);
    try {
      const initM = wsM.messages.find((x) => x.type === 'INITIAL_STATE').payload;
      for (const u of initM.users || []) if ('phoneNumber' in u || 'hasKioskPin' in u) throw new Error('mashgiach WS INITIAL_STATE leaks phone/marker');
      const initA = wsA.messages.find((x) => x.type === 'INITIAL_STATE').payload;
      if (byId(initA.users || [], mashA)?.phoneNumber !== PHONE_A) throw new Error('admin WS INITIAL_STATE missing the phone (twin)');
      wsM.messages.length = 0; wsA.messages.length = 0;

      // --- 5. coordinator writes: own-venue mashgiach phone OK ---
      const put = async (token, id, body) => {
        const r = await fetch(`${baseUrl}/api/users/${id}`, {
          method: 'PUT', headers: auth(token),
          body: JSON.stringify({ ...body, adminEmail: 'x@test.local', expectedVersion: await v(), operationId: crypto.randomUUID() }),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      const c1 = await put(tCoord, mashA2, { phoneNumber: '(860) 555-0177' });
      if (c1.status !== 200 || c1.body.user?.phoneNumber !== '+18605550177') throw new Error(`coordinator sets own-venue phone: ${c1.status} ${JSON.stringify(c1.body)}`);
      noSecrets(c1.body.user, 'PUT response');
      const c1b = await put(tCoord, mashA2, { kioskPin: '2718', phoneNumber: '8605550178' });
      if (c1b.status !== 200 || c1b.body.user?.hasKioskPin !== true || c1b.body.user?.phoneNumber !== '+18605550178') throw new Error(`coordinator sets code + phone: ${c1b.status} ${JSON.stringify(c1b.body)}`);
      const updM = await wsM.waitFor((x) => x.type === 'USERS_UPDATED', 4000);
      if (!updM) throw new Error('mashgiach socket got no USERS_UPDATED');
      for (const u of updM.payload?.users || []) if ('phoneNumber' in u || 'hasKioskPin' in u) throw new Error('USERS_UPDATED to a mashgiach socket leaks phone/marker');
      const updA = await wsA.waitFor((x) => x.type === 'USERS_UPDATED' && byId(x.payload?.users || [], mashA2)?.phoneNumber === '+18605550178', 4000);
      if (!updA) throw new Error('admin socket USERS_UPDATED missing the new phone (twin)');

      // refusals
      for (const [id, body, what] of [
        [mashB, { phoneNumber: '+18605550111' }, 'other-venue mashgiach'],
        [adminId, { phoneNumber: '+18605550112' }, 'admin target'],
        [coordA, { phoneNumber: '+18605550113' }, 'coordinator target (self)'],
        [mashA2, { phoneNumber: '+18605550114', name: 'Renamed' }, 'phone + name'],
        [mashA2, { phoneNumber: '+18605550115', role: 'coordinator' }, 'phone + role'],
      ]) {
        const r = await put(tCoord, id, body);
        if (r.status !== 403 && r.status !== 409) throw new Error(`coordinator ${what}: expected 403, got ${r.status}`);
      }
      const m = await put(tMash, mashA, { phoneNumber: '+18605550116' });
      if (m.status !== 403) throw new Error(`mashgiach PUT phone: ${m.status}`);
      const doc = await ctx.getDoc();
      if (doc.users.find((u) => u.id === mashB)?.phoneNumber !== PHONE_B) throw new Error("a refused write changed the venue-B phone");
      if (doc.users.find((u) => u.id === mashA2)?.name !== 'T33 Mash A2') throw new Error('a refused write renamed the user');
      if (doc.users.find((u) => u.id === mashA)?.phoneNumber !== PHONE_A) throw new Error('mashgiach changed a phone');
      if (doc.users.find((u) => u.id === mashA2)?.phoneNumber !== '+18605550178') throw new Error('stored phone is not E.164');

      // --- 6. validation + clear (admin) ---
      for (const bad of ['12', 'abc', '+0123456', '555-CALL-NOW', '1'.repeat(40)]) {
        const r = await put(tAdmin, mashA2, { phoneNumber: bad });
        if (r.status !== 400) throw new Error(`bad phone "${bad}" should be 400, got ${r.status}`);
      }
      const intl = await put(tAdmin, mashA2, { phoneNumber: '00972 50 123 4567' });
      if (intl.status !== 200 || intl.body.user?.phoneNumber !== '+972501234567') throw new Error(`international phone: ${intl.status} ${intl.body.user?.phoneNumber}`);
      const clr = await put(tAdmin, mashA2, { phoneNumber: '' });
      if (clr.status !== 200 || 'phoneNumber' in (clr.body.user || {})) throw new Error(`clear phone: ${clr.status} ${JSON.stringify(clr.body.user)}`);
      const docAfterClr = await ctx.getDoc();
      if (docAfterClr.users.find((u) => u.id === mashA2)?.phoneNumber) throw new Error('cleared phone still stored');
      const adm = await put(tAdmin, adminId, { phoneNumber: '+18605550120' });
      if (adm.status !== 200 || adm.body.user?.phoneNumber !== '+18605550120') throw new Error(`admin sets own phone: ${adm.status}`);
    } finally {
      wsM.close(); wsA.close();
    }

    // --- 7. POST /users with a phone (admin), bad phone refused ---
    const mk = async (phoneNumber, n) => {
      const r = await fetch(`${baseUrl}/api/users`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ email: `new33-${n}-${ts}@test.local`, name: `New ${n}`, role: 'mashgiach', password: 'secret12', venueId: vA, phoneNumber, expectedVersion: await v(), operationId: crypto.randomUUID() }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const nb = await mk('not a phone', 'bad');
    if (nb.status !== 400) throw new Error(`POST bad phone: ${nb.status}`);
    const doc2 = await ctx.getDoc();
    if (doc2.users.some((u) => u.email === `new33-bad-${ts}@test.local`)) throw new Error('user created despite a bad phone');
    const ng = await mk('860.555.0199', 'good');
    if (ng.status !== 201 || ng.body.user?.phoneNumber !== '+18605550199' || ng.body.user?.hasKioskPin !== false) throw new Error(`POST with phone: ${ng.status} ${JSON.stringify(ng.body.user)}`);
    noSecrets(ng.body.user, 'POST response');

    // --- 8. kiosk never shows phones; a code reset kills the old kiosk token ---
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { pairingId, code, deviceSecret } = await start.json();
    const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, { method: 'POST', headers: auth(tAdmin), body: JSON.stringify({ code, venueId: vA }) });
    if (pair.status !== 201) throw new Error(`pair: ${pair.status}`);
    const claim = await (await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } })).json();
    const dev = `${claim.device.id}.${deviceSecret}`;
    const kr = await (await fetch(`${baseUrl}/api/kiosk/device`, { headers: { 'X-Kiosk-Device': dev } })).json();
    for (const u of kr.users || []) if ('phoneNumber' in u || 'hasKioskPin' in u || 'email' in u) throw new Error('tablet roster leaks phone/marker/email');
    const lg = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev }, body: JSON.stringify({ userId: mashA, pin: '3141' }) });
    const lgb = await lg.json().catch(() => ({}));
    if (lg.status !== 200) throw new Error(`kiosk login: ${lg.status}`);
    if ('phoneNumber' in lgb.user) throw new Error('kiosk login response carries the phone');
    const K = { ...auth(lgb.token), 'X-Kiosk-Device': dev };
    const ok1 = await fetch(`${baseUrl}/api/tasks`, { headers: K });
    if (ok1.status !== 200) throw new Error(`kiosk session before reset: ${ok1.status}`);
    const reset = await fetch(`${baseUrl}/api/users/${mashA}`, {
      method: 'PUT', headers: auth(tAdmin),
      body: JSON.stringify({ kioskPin: '1618', expectedVersion: await v(), operationId: crypto.randomUUID() }),
    });
    const rb = await reset.json().catch(() => ({}));
    if (reset.status !== 200 || rb.user?.hasKioskPin !== true) throw new Error(`reset code: ${reset.status}`);
    noSecrets(rb.user, 'reset response');
    if (JSON.stringify(rb).includes('1618')) throw new Error('the new code digits came back in the response');
    const dead = await fetch(`${baseUrl}/api/tasks`, { headers: K });
    if (dead.status !== 401) throw new Error(`old kiosk token after a code reset should be 401, got ${dead.status}`);
    const rmv = await fetch(`${baseUrl}/api/users/${mashA}`, {
      method: 'PUT', headers: auth(tAdmin),
      body: JSON.stringify({ kioskPin: '', expectedVersion: await v(), operationId: crypto.randomUUID() }),
    });
    const rmb = await rmv.json().catch(() => ({}));
    if (rmv.status !== 200 || rmb.user?.hasKioskPin !== false) throw new Error(`remove code: ${rmv.status} hasKioskPin=${rmb.user?.hasKioskPin}`);

    return 'marker manager-only and never secret; phone visible/writable per rule T only, validated to E.164, never on a kiosk; reset revokes old kiosk tokens';
  },
};
