/**
 * Test 27: Kiosk pairing & devices (PR 2b).
 *
 * A tablet must be PAIRED to one venue by an admin (any venue in the agency)
 * or that venue's coordinator. After pairing, kiosk sign-in works only on a
 * paired tablet and only for that tablet's venue. The old public pickers
 * (GET /api/kiosk/venues, GET /api/kiosk/users) are closed in the same PR.
 *
 * Fixture: agency P with venues P1, P2; agency Q with venue Q1.
 * Users: adminP, coordinator P1, mashgiach P1 (PIN), mashgiach P2 (PIN),
 * adminQ, mashgiach Q1 (PIN).
 *
 * Parts:
 *  1 happy path: start → pair → idempotent claim → roster → login → WS.
 *  6b finding 2: pair/unpair re-gate on the FRESH caller (doc-set staging).
 * 10 (cont.): device PROOF — a valid token without its own tablet's
 *    credential fails on REST and WS (addendum, finding 1).
 *  2 wrong/expired/reused codes; 5 wrong by one caller → 429 for right code.
 *  3 pairing roles (rule T) + start rate limit.
 *  4 unpaired requests refuse before any lockout counting.
 *  5 venue binding: another venue's user is just a wrong code (and counted).
 *  6 unpair kills REST + WS immediately; self-unpair; re-pairing works.
 *  7 device lists are agency/venue scoped and carry no secret material.
 *  8 secrets: the doc/export/WS carry hashes, never the plain code/secret.
 *  9 PIN revision revokes kiosk tokens; stale lockout keys are pruned.
 * 10 spoofed body fields are ignored; forged or dev-less tokens fail closed.
 *
 * Request bodies/headers are built from what the CLIENT sends (rule AA):
 * pairing start is a bare POST {}, status/device travel in X-Kiosk-* headers,
 * and phone writes carry expectedVersion + operationId like apiWrite.
 * Every negative has a positive twin (rule G).
 *
 * Note on F8's log check: the harness test process cannot read the harness's
 * own stdout, so the "secret appears in no server log line" assertion is
 * verified outside this file by grepping the harness output for the exact
 * code/secret values this test obtains (the new routes log only static text
 * and error messages — never request values).
 */

import { createHash } from 'node:crypto';

const PAGENCY = 'agency-test27-p';
const QAGENCY = 'agency-test27-q';
const sha256Hex = (v) => createHash('sha256').update(v).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function connectWs(baseUrl, token, opts = {}) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    let closeCode = null;
    const conn = {
      ws, messages,
      waitClose: (ms = 5000) => new Promise((res) => {
        if (closeCode !== null) return res(closeCode);
        const t = setTimeout(() => res(closeCode), ms);
        const prev = ws.onclose;
        ws.onclose = (ev) => { closeCode = ev.code; clearTimeout(t); if (prev) prev(ev); res(ev.code); };
      }),
      waitFor: async (type, ms = 4000) => {
        const start = Date.now();
        while (Date.now() - start < ms) {
          const hit = messages.find((m) => m.type === type);
          if (hit) return hit;
          await sleep(100);
        }
        return null;
      },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {
      // Device proof (addendum, finding 1): the first frame on a kiosk
      // socket. opts.credential is the tablet's '<deviceId>.<secret>'.
      if (opts.credential) {
        try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: opts.credential })); } catch {}
      }
    };
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve(conn);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      closeCode = ev.code;
      conn.closeCode = ev.code;
      if (opts.expectClose) {
        resolve(conn);
      } else if (!messages.some((m) => m.type === 'INITIAL_STATE')) {
        reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
      }
    };
  });
}

export default {
  name: 'Test 27: Kiosk pairing & devices',
  whatItProves:
    'Kiosk tablets are paired to exactly one venue (admin any venue in agency, coordinator own venue only); sign-in works only on a paired tablet for that venue; unpairing kills sessions immediately; pairing codes/secrets are single-use, rate-limited, and stored only as hashes; PIN revisions revoke kiosk tokens; the public venue/staff pickers are closed.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const P1 = `venue-test27-p1-${ts}`;
    const P2 = `venue-test27-p2-${ts}`;
    const Q1 = `venue-test27-q1-${ts}`;
    const adminPId = `user-test27-adminp-${ts}`;
    const coordPId = `user-test27-coordp-${ts}`;
    const mashP1Id = `user-test27-mashp1-${ts}`;
    const mashP2Id = `user-test27-mashp2-${ts}`;
    const adminQId = `user-test27-adminq-${ts}`;
    const mashQ1Id = `user-test27-mashq1-${ts}`;
    const taskP1Id = `task-test27-p1-${ts}`;
    const taskP2Id = `task-test27-p2-${ts}`;
    const PIN_P1 = '1212';
    const PIN_P2 = '3434';
    const PIN_Q1 = '5656';

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: PAGENCY, name: 'Test27 Agency P' },
        { id: QAGENCY, name: 'Test27 Agency Q' },
      ],
      venues: [
        { id: P1, name: `T27 P1 ${ts}`, agencyId: PAGENCY },
        { id: P2, name: `T27 P2 ${ts}`, agencyId: PAGENCY },
        { id: Q1, name: `T27 Q1 ${ts}`, agencyId: QAGENCY },
      ],
      users: [
        { id: adminPId, email: `adminp-${ts}@test.local`, name: 'T27 Admin P', role: 'admin', agencyId: PAGENCY },
        { id: coordPId, email: `coordp-${ts}@test.local`, name: 'T27 Coord P1', role: 'coordinator', agencyId: PAGENCY, venueId: P1 },
        { id: mashP1Id, email: `mashp1-${ts}@test.local`, name: 'T27 Mash P1', role: 'mashgiach', agencyId: PAGENCY, venueId: P1, kioskPin: PIN_P1 },
        { id: mashP2Id, email: `mashp2-${ts}@test.local`, name: 'T27 Mash P2', role: 'mashgiach', agencyId: PAGENCY, venueId: P2, kioskPin: PIN_P2 },
        { id: adminQId, email: `adminq-${ts}@test.local`, name: 'T27 Admin Q', role: 'admin', agencyId: QAGENCY },
        { id: mashQ1Id, email: `mashq1-${ts}@test.local`, name: 'T27 Mash Q1', role: 'mashgiach', agencyId: QAGENCY, venueId: Q1, kioskPin: PIN_Q1 },
      ],
      tasks: [
        { id: taskP1Id, agencyId: PAGENCY, venueId: P1, title: `Task P1 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
        { id: taskP2Id, agencyId: PAGENCY, venueId: P2, title: `Task P2 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const tAdminP = await mintToken(baseUrl, adminPId);
    const tCoordP = await mintToken(baseUrl, coordPId);
    const tMashP1 = await mintToken(baseUrl, mashP1Id);
    const tAdminQ = await mintToken(baseUrl, adminQId);

    const clearLimits = async () => {
      const r = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, {
        method: 'POST', headers: auth(tAdminP),
      });
      if (r.status !== 200) throw new Error(`clear lockouts: ${r.status}`);
    };

    const startPairing = async () => {
      const r = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body, headers: r.headers };
    };

    const pairWith = async (token, code, venueId, extra = {}) => {
      const r = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
        method: 'POST', headers: auth(token),
        body: JSON.stringify({ code, venueId, ...extra }),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body, headers: r.headers };
    };

    const pairingStatus = async (pairingId, secret) => {
      const r = await fetch(`${baseUrl}/api/kiosk/pairing/status`, {
        headers: { 'X-Kiosk-Pairing': `${pairingId}.${secret}` },
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    // Full tablet flow: start → phone pairs → tablet claims the pairing.
    const pairTablet = async (token, venueId, name) => {
      const start = await startPairing();
      if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
      const { pairingId, code, deviceSecret } = start.body;
      const pair = await pairWith(token, code, venueId, name ? { name } : {});
      if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status} ${JSON.stringify(pair.body)}`);
      const claimed = await pairingStatus(pairingId, deviceSecret);
      if (claimed.status !== 200 || claimed.body.status !== 'approved') {
        throw new Error(`pairing claim: ${claimed.status} ${JSON.stringify(claimed.body)}`);
      }
      const device = claimed.body.device;
      return {
        pairingId, code, secret: deviceSecret,
        deviceId: device.id, venueId: device.venueId, venueName: device.venueName,
        header: `${device.id}.${deviceSecret}`,
      };
    };

    const getDevice = async (header) => {
      const r = await fetch(`${baseUrl}/api/kiosk/device`, {
        headers: header ? { 'X-Kiosk-Device': header } : {},
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    const kioskLogin = async (header, userId, pin, extra = {}) => {
      const r = await fetch(`${baseUrl}/api/kiosk/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(header ? { 'X-Kiosk-Device': header } : {}) },
        body: JSON.stringify({ userId, pin, ...extra }),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body, headers: r.headers };
    };

    const getTasks = async (token, deviceHeader) => {
      const headers = deviceHeader
        ? { ...auth(token), 'X-Kiosk-Device': deviceHeader }
        : auth(token);
      const r = await fetch(`${baseUrl}/api/tasks`, { headers });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    const listDevices = async (token) => {
      const r = await fetch(`${baseUrl}/api/kiosk/devices`, { headers: auth(token) });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    const deleteDevice = async (token, deviceId) => {
      const r = await fetch(`${baseUrl}/api/kiosk/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE', headers: auth(token),
      });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    const docUser = async (userId) => {
      const doc = await ctx.getDoc();
      return (doc?.users || []).find((u) => u.id === userId);
    };

    await clearLimits();

    /* ---- Part 1: happy path ---- */
    let deviceP1;
    {
      const start = await startPairing();
      if (start.status !== 200) throw new Error(`start: ${start.status}`);
      const { pairingId, code, deviceSecret } = start.body;
      if (!/^[A-Z2-9]{6}$/.test(code || '')) throw new Error(`code shape: ${code}`);
      if (!deviceSecret) throw new Error('start: no deviceSecret');
      // Pending poll before pairing.
      const pending = await pairingStatus(pairingId, deviceSecret);
      if (pending.status !== 200 || pending.body.status !== 'pending') {
        throw new Error(`pending poll: ${pending.status} ${JSON.stringify(pending.body)}`);
      }
      // Wrong-secret poll → the one 404 message.
      const wrongSecret = await pairingStatus(pairingId, 'not-the-secret');
      if (wrongSecret.status !== 404) throw new Error(`wrong-secret poll: ${wrongSecret.status} (expected 404)`);
      const pair = await pairWith(tAdminP, code, P1, { name: 'Kitchen tablet' });
      if (pair.status !== 201) throw new Error(`pair: ${pair.status} ${JSON.stringify(pair.body)}`);
      if (pair.body.device?.name !== 'Kitchen tablet') throw new Error(`pair name: ${pair.body.device?.name}`);
      if (JSON.stringify(pair.body).includes('secretHash')) throw new Error('pair response leaked secretHash');
      const claimed = await pairingStatus(pairingId, deviceSecret);
      if (claimed.status !== 200 || claimed.body.status !== 'approved') {
        throw new Error(`claim: ${claimed.status} ${JSON.stringify(claimed.body)}`);
      }
      const dev = claimed.body.device;
      if (dev.venueId !== P1 || dev.agencyId !== PAGENCY) throw new Error(`claimed device scope: ${JSON.stringify(dev)}`);
      deviceP1 = { pairingId, code, secret: deviceSecret, deviceId: dev.id, header: `${dev.id}.${deviceSecret}` };
      // Finding 3: claiming does NOT strand the tablet — a second poll with
      // the same secret returns the SAME device (idempotent) until the
      // claim deadline; another secret never claims it.
      const second = await pairingStatus(pairingId, deviceSecret);
      if (second.status !== 200 || second.body.device?.id !== dev.id) {
        throw new Error(`idempotent re-claim: ${second.status} ${JSON.stringify(second.body)}`);
      }
      const otherSecret = await pairingStatus(pairingId, 'some-other-secret');
      if (otherSecret.status !== 404) throw new Error(`claim by another secret: ${otherSecret.status} (expected 404)`);
      // Past the claim deadline the pairing is gone.
      const kill = await fetch(`${baseUrl}/api/__test__/expire-kiosk-pairing`, {
        method: 'POST', headers: auth(tAdminP),
        body: JSON.stringify({ pairingId }),
      });
      if (kill.status !== 200) throw new Error(`expire claim hook: ${kill.status}`);
      const third = await pairingStatus(pairingId, deviceSecret);
      if (third.status !== 404) throw new Error(`poll after claim deadline: ${third.status} (expected 404)`);
      // ...and the DEVICE itself is unaffected by the pairing expiring.
      const stillThere = await getDevice(deviceP1.header);
      if (stillThere.status !== 200) throw new Error(`device after pairing expiry: ${stillThere.status}`);
      // Device roster: mashgiach P1 only, no PIN/secret fields anywhere.
      const roster = await getDevice(deviceP1.header);
      if (roster.status !== 200) throw new Error(`device roster: ${roster.status}`);
      const rosterJson = JSON.stringify(roster.body);
      if (/"kioskPin":|"kioskPinHash":|"secretHash":|"secret":/.test(rosterJson)) {
        throw new Error('device roster leaked PIN/secret fields');
      }
      const rosterIds = (roster.body.users || []).map((u) => u.id);
      if (!rosterIds.includes(mashP1Id)) throw new Error('roster missing mashgiach P1');
      if (rosterIds.includes(mashP2Id) || rosterIds.includes(mashQ1Id)) {
        throw new Error('roster leaked another venue’s staff');
      }
      if (roster.body.device?.venueId !== P1) throw new Error('roster device venue mismatch');
      // Login on the paired tablet → token bound to the device.
      const login = await kioskLogin(deviceP1.header, mashP1Id, PIN_P1);
      if (login.status !== 200) throw new Error(`kiosk login: ${login.status} ${JSON.stringify(login.body)}`);
      const payload = JSON.parse(Buffer.from(login.body.token.split('.')[1], 'base64').toString());
      if (payload.dev !== deviceP1.deviceId) throw new Error(`token dev: ${payload.dev}`);
      if (payload.venueId !== P1 || payload.agencyId !== PAGENCY) throw new Error('token scope mismatch');
      if (!/^\d+$/.test(String(payload.pv || ''))) throw new Error(`token pv is not the PIN revision: ${payload.pv}`);
      const tasks = await getTasks(login.body.token, deviceP1.header);
      if (tasks.status !== 200) throw new Error(`kiosk GET /api/tasks: ${tasks.status}`);
      const tids = (tasks.body.tasks || []).map((t) => t.id);
      if (!tids.includes(taskP1Id)) throw new Error('kiosk tasks missing P1 task');
      if (tids.includes(taskP2Id)) throw new Error('kiosk tasks leaked P2 task');
      // WS connects (with the device proof frame) and its INITIAL_STATE
      // is venue-scoped.
      const conn = await connectWs(baseUrl, login.body.token, { credential: deviceP1.header });
      const init = conn.messages.find((m) => m.type === 'INITIAL_STATE');
      const initTids = (init?.payload?.tasks || []).map((t) => t.id);
      if (!initTids.includes(taskP1Id)) throw new Error('kiosk WS missing P1 task');
      if (initTids.includes(taskP2Id)) throw new Error('kiosk WS leaked P2 task');
      conn.ws.close();
    }

    /* ---- Part 2: wrong / expired / reused codes; caller lockout ---- */
    let deviceP2;
    {
      // Wrong code → 404 with the one message. ('X' is outside the alphabet,
      // so this can never collide with a live code.)
      const wrong = await pairWith(tAdminP, 'XXXXXX', P1);
      if (wrong.status !== 404) throw new Error(`wrong code: ${wrong.status} (expected 404)`);
      if (!/isn't valid/.test(wrong.body.error || '')) throw new Error(`wrong code message: ${wrong.body.error}`);
      // Expired code → 404 on pair AND on status.
      const expStart = await startPairing();
      if (expStart.status !== 200) throw new Error(`expired start: ${expStart.status}`);
      const exp = await fetch(`${baseUrl}/api/__test__/expire-kiosk-pairing`, {
        method: 'POST', headers: auth(tAdminP),
        body: JSON.stringify({ pairingId: expStart.body.pairingId }),
      });
      if (exp.status !== 200) throw new Error(`expire hook: ${exp.status}`);
      const expPair = await pairWith(tAdminP, expStart.body.code, P1);
      if (expPair.status !== 404) throw new Error(`expired pair: ${expPair.status} (expected 404)`);
      const expStatus = await pairingStatus(expStart.body.pairingId, expStart.body.deviceSecret);
      if (expStatus.status !== 404) throw new Error(`expired status: ${expStatus.status} (expected 404)`);
      // Reused code → first pair 201, second pair 404.
      const reStart = await startPairing();
      if (reStart.status !== 200) throw new Error(`reuse start: ${reStart.status}`);
      const first = await pairWith(tAdminP, reStart.body.code, P2, { name: 'P2 tablet' });
      if (first.status !== 201) throw new Error(`reuse first pair: ${first.status}`);
      deviceP2 = {
        pairingId: reStart.body.pairingId, code: reStart.body.code,
        secret: reStart.body.deviceSecret, deviceId: first.body.device.id,
        header: `${first.body.device.id}.${reStart.body.deviceSecret}`,
      };
      const second = await pairWith(tAdminP, reStart.body.code, P2);
      if (second.status !== 404) throw new Error(`reused code: ${second.status} (expected 404)`);
      // Two more wrong codes bring this caller to 5 wrong attempts in the
      // window (wrong + expired + reused above) → the NEXT attempt is 429
      // even with a right code.
      for (const bad of ['AAAAAA', 'BBBBBB']) {
        const r = await pairWith(tAdminP, bad, P1);
        if (r.status !== 404) throw new Error(`wrong code ${bad}: ${r.status} (expected 404)`);
      }
      const fresh = await startPairing();
      if (fresh.status !== 200) throw new Error(`lockout start: ${fresh.status}`);
      const locked = await pairWith(tAdminP, fresh.body.code, P1);
      if (locked.status !== 429) throw new Error(`right code after 5 wrong: ${locked.status} (expected 429)`);
      if (!locked.headers.get('retry-after')) throw new Error('pair 429 missing Retry-After');
      await clearLimits();
      // Positive twin: after clearing, the same right code pairs.
      const after = await pairWith(tAdminP, fresh.body.code, P1, { name: 'Spare tablet' });
      if (after.status !== 201) throw new Error(`pair after clear: ${after.status} (expected 201)`);
      const spare = await deleteDevice(tAdminP, after.body.device.id);
      if (spare.status !== 200) throw new Error(`spare cleanup unpair: ${spare.status}`);
    }

    /* ---- Part 3: pairing roles (rule T) + start rate limit ---- */
    let deviceCoordP1;
    {
      await clearLimits();
      const s1 = await startPairing();
      const byCoord = await pairWith(tCoordP, s1.body.code, P1, { name: 'Coord tablet' });
      if (byCoord.status !== 201) throw new Error(`coordinator pair own venue: ${byCoord.status} (expected 201)`);
      deviceCoordP1 = { deviceId: byCoord.body.device.id, header: `${byCoord.body.device.id}.${s1.body.deviceSecret}` };
      const s2 = await startPairing();
      const coordOther = await pairWith(tCoordP, s2.body.code, P2);
      if (coordOther.status !== 403) throw new Error(`coordinator pair other venue: ${coordOther.status} (expected 403)`);
      if (!/your own venue/.test(coordOther.body.error || '')) {
        throw new Error(`coordinator 403 message: ${coordOther.body.error}`);
      }
      const adminQ = await pairWith(tAdminQ, s2.body.code, P1);
      if (adminQ.status !== 403) throw new Error(`admin Q pair to P venue: ${adminQ.status} (expected 403)`);
      const byMash = await pairWith(tMashP1, s2.body.code, P1);
      if (byMash.status !== 403) throw new Error(`mashgiach pair: ${byMash.status} (expected 403)`);
      // Start rate limit: 10 per IP per 15 min; the 11th → 429.
      await clearLimits();
      for (let i = 0; i < 10; i++) {
        const r = await startPairing();
        if (r.status !== 200) throw new Error(`start ${i + 1}: ${r.status} (expected 200)`);
      }
      const eleventh = await startPairing();
      if (eleventh.status !== 429) throw new Error(`11th start: ${eleventh.status} (expected 429)`);
      if (!eleventh.headers.get('retry-after')) throw new Error('start 429 missing Retry-After');
    }

    /* ---- Part 4: unpaired requests refuse before any counting ---- */
    {
      const before = JSON.stringify((await ctx.getDoc())?.kioskPinLockouts || {});
      const noHeader = await kioskLogin(null, mashP1Id, PIN_P1);
      if (noHeader.status !== 401 || noHeader.body.code !== 'KIOSK_UNPAIRED') {
        throw new Error(`login without device: ${noHeader.status} ${JSON.stringify(noHeader.body)}`);
      }
      const garbage = await kioskLogin('kdev-nope.not-a-secret', mashP1Id, PIN_P1);
      if (garbage.status !== 401 || garbage.body.code !== 'KIOSK_UNPAIRED') {
        throw new Error(`login with garbage device: ${garbage.status} ${JSON.stringify(garbage.body)}`);
      }
      const after = JSON.stringify((await ctx.getDoc())?.kioskPinLockouts || {});
      if (before !== after) throw new Error('unpaired login attempts were counted in the lockout doc');
      const wrongSecret = await getDevice(`${deviceP1.deviceId}.wrong-secret`);
      if (wrongSecret.status !== 401 || wrongSecret.body.code !== 'KIOSK_UNPAIRED') {
        throw new Error(`device with wrong secret: ${wrongSecret.status} ${JSON.stringify(wrongSecret.body)}`);
      }
      const unknownDevice = await getDevice('kdev-unknown.some-secret');
      if (unknownDevice.status !== 401 || unknownDevice.body.code !== 'KIOSK_UNPAIRED') {
        throw new Error(`device with unknown id: ${unknownDevice.status}`);
      }
      // The public pickers are closed: removed routes answer 401 (auth
      // middleware) or 404 — never 200.
      for (const path of [`/api/kiosk/users?venueId=${P1}`, '/api/kiosk/venues']) {
        const r = await fetch(`${baseUrl}${path}`);
        if (r.status !== 401 && r.status !== 404) {
          throw new Error(`${path}: ${r.status} (expected 401/404 — route closed)`);
        }
      }
    }

    /* ---- Part 5: venue binding — another venue's user is a wrong code ---- */
    {
      const otherVenue = await kioskLogin(deviceP1.header, mashP2Id, PIN_P2);
      if (otherVenue.status !== 401) throw new Error(`login mash P2 on P1 tablet: ${otherVenue.status} (expected 401)`);
      if (otherVenue.body.error !== 'Wrong code. Try again.') {
        throw new Error(`cross-venue message leaks: ${otherVenue.body.error}`);
      }
      const doc = await ctx.getDoc();
      const fails = doc?.kioskPinLockouts?.users?.[mashP2Id]?.fails || [];
      if (fails.length < 1) throw new Error('cross-venue attempt was not counted toward the lockout');
      const otherAgency = await kioskLogin(deviceP1.header, mashQ1Id, PIN_Q1);
      if (otherAgency.status !== 401 || otherAgency.body.error !== 'Wrong code. Try again.') {
        throw new Error(`login mash Q1 on P1 tablet: ${otherAgency.status} ${JSON.stringify(otherAgency.body)}`);
      }
      const admin = await kioskLogin(deviceP1.header, adminPId, PIN_P1);
      if (admin.status !== 403) throw new Error(`admin via kiosk: ${admin.status} (expected 403)`);
    }

    /* ---- Part 6: unpair kills REST + WS immediately; re-pairing works ---- */
    {
      await clearLimits();
      // Role matrix: coordinator of another venue → 403; admin of another
      // agency → 404 (the device is never revealed).
      const coordWrongVenue = await deleteDevice(tCoordP, deviceP2.deviceId);
      if (coordWrongVenue.status !== 403) {
        throw new Error(`coordinator unpair P2 device: ${coordWrongVenue.status} (expected 403)`);
      }
      const adminQDel = await deleteDevice(tAdminQ, deviceP1.deviceId);
      if (adminQDel.status !== 404) {
        throw new Error(`admin Q unpair P device: ${adminQDel.status} (expected 404)`);
      }
      // A dedicated tablet with a live kiosk session.
      const tmp = await pairTablet(tAdminP, P1, 'Unpair tablet');
      const login = await kioskLogin(tmp.header, mashP1Id, PIN_P1);
      if (login.status !== 200) throw new Error(`unpair-part login: ${login.status}`);
      const before = await getTasks(login.body.token, tmp.header);
      if (before.status !== 200) throw new Error(`token before unpair: ${before.status} (expected 200)`);
      const conn = await connectWs(baseUrl, login.body.token, { credential: tmp.header });
      // The venue's own coordinator unpairs it → 200.
      const del = await deleteDevice(tCoordP, tmp.deviceId);
      if (del.status !== 200) throw new Error(`coordinator unpair own venue: ${del.status} (expected 200)`);
      // The kiosk token dies on the next REST call (C1/C3)...
      const after = await getTasks(login.body.token, tmp.header);
      if (after.status !== 401) throw new Error(`token after unpair: ${after.status} (expected 401)`);
      // ...and the open socket is closed 4401.
      const closed = await conn.waitClose(6000);
      if (closed !== 4401) throw new Error(`socket after unpair: ${closed} (expected 4401)`);
      // The old device secret is dead too.
      const devGone = await getDevice(tmp.header);
      if (devGone.status !== 401 || devGone.body.code !== 'KIOSK_UNPAIRED') {
        throw new Error(`device after unpair: ${devGone.status} ${JSON.stringify(devGone.body)}`);
      }
      // A NEW pairing of the same tablet works (a fresh pairing flow).
      const re = await pairTablet(tAdminP, P1, 'Re-paired tablet');
      const login2 = await kioskLogin(re.header, mashP1Id, PIN_P1);
      if (login2.status !== 200) throw new Error(`login after re-pair: ${login2.status}`);
      const conn2 = await connectWs(baseUrl, login2.body.token, { credential: re.header });
      // B5: the tablet unpairs ITSELF ("exit kiosk mode").
      const self = await fetch(`${baseUrl}/api/kiosk/device/unpair`, {
        method: 'POST', headers: { 'X-Kiosk-Device': re.header },
      });
      if (self.status !== 200) throw new Error(`self-unpair: ${self.status} (expected 200)`);
      const after2 = await getTasks(login2.body.token, re.header);
      if (after2.status !== 401) throw new Error(`token after self-unpair: ${after2.status} (expected 401)`);
      const closed2 = await conn2.waitClose(6000);
      if (closed2 !== 4401) throw new Error(`socket after self-unpair: ${closed2} (expected 4401)`);
    }

    /* ---- Part 6b: pair/unpair re-gate on the FRESH caller (finding 2) ---- */
    {
      // Stage the race with doc-set-users: the stored doc moves coordinator
      // P to venue P2 while the in-memory cache keeps the coordinator at
      // P1. Cache pre-gates pass; the transactions must refuse (rule AB).
      const doc0 = await ctx.getDoc();
      const users0 = doc0?.users || [];
      const moved = users0.map((u) => (u.id === coordPId ? { ...u, venueId: P2 } : u));
      const setUsers = async (users) => {
        const r = await fetch(`${baseUrl}/api/__test__/doc-set-users`, {
          method: 'POST', headers: auth(tAdminP), body: JSON.stringify({ users }),
        });
        if (r.status !== 200) throw new Error(`doc-set-users: ${r.status}`);
      };
      await setUsers(moved);
      const st = await startPairing();
      if (st.status !== 200) throw new Error(`staging start: ${st.status}`);
      const staged = await pairWith(tCoordP, st.body.code, P1, { name: 'Staged tablet' });
      if (staged.status !== 409 && staged.status !== 403) {
        throw new Error(`staged pair by moved coordinator: ${staged.status} (expected 409/403)`);
      }
      const listAfterStage = await listDevices(tAdminP);
      if ((listAfterStage.body.devices || []).some((d) => d.name === 'Staged tablet')) {
        throw new Error('staged pair created a device despite the fresh-doc refusal');
      }
      // Unpair likewise: the P1 tablet the coordinator paired earlier must
      // survive an unpair attempt staged the same way.
      const stagedDel = await deleteDevice(tCoordP, deviceCoordP1.deviceId);
      if (stagedDel.status !== 409 && stagedDel.status !== 403) {
        throw new Error(`staged unpair by moved coordinator: ${stagedDel.status} (expected 409/403)`);
      }
      const listStill = await listDevices(tAdminP);
      if (!(listStill.body.devices || []).some((d) => d.id === deviceCoordP1.deviceId)) {
        throw new Error('staged unpair deleted the device despite the refusal');
      }
      // Restore the doc, then re-hydrate the cache with a real commit.
      await setUsers(users0);
      await clearLimits();
      // Positive twins: the same coordinator pairs and unpairs at P1 again.
      const st2 = await startPairing();
      const okPair = await pairWith(tCoordP, st2.body.code, P1, { name: 'Staged tablet' });
      if (okPair.status !== 201) throw new Error(`pair after restore: ${okPair.status} (expected 201)`);
      const okDel = await deleteDevice(tCoordP, okPair.body.device.id);
      if (okDel.status !== 200) throw new Error(`unpair after restore: ${okDel.status} (expected 200)`);
      // The tablet the coordinator paired earlier is unaffected by the
      // person's moves — the pairing belongs to the device and the venue.
      const devAlive = await getDevice(deviceCoordP1.header);
      if (devAlive.status !== 200) throw new Error(`coordinator's tablet after the moves: ${devAlive.status}`);
    }

    /* ---- Part 7: device lists are scoped and carry no secret material ---- */
    {
      const listP = await listDevices(tAdminP);
      if (listP.status !== 200) throw new Error(`admin list: ${listP.status}`);
      const idsP = (listP.body.devices || []).map((d) => d.id);
      for (const id of [deviceP1.deviceId, deviceP2.deviceId, deviceCoordP1.deviceId]) {
        if (!idsP.includes(id)) throw new Error(`admin P list missing ${id}`);
      }
      const listC = await listDevices(tCoordP);
      if (listC.status !== 200) throw new Error(`coordinator list: ${listC.status}`);
      const devicesC = listC.body.devices || [];
      if (devicesC.some((d) => d.venueId !== P1)) throw new Error('coordinator list leaked another venue');
      const idsC = devicesC.map((d) => d.id);
      if (!idsC.includes(deviceP1.deviceId) || !idsC.includes(deviceCoordP1.deviceId)) {
        throw new Error('coordinator list missing own-venue devices');
      }
      if (idsC.includes(deviceP2.deviceId)) throw new Error('coordinator list leaked the P2 device');
      const listQ = await listDevices(tAdminQ);
      if (listQ.status !== 200) throw new Error(`admin Q list: ${listQ.status}`);
      const idsQ = (listQ.body.devices || []).map((d) => d.id);
      if (idsQ.some((id) => idsP.includes(id))) throw new Error('admin Q list leaked agency P devices');
      const listM = await listDevices(tMashP1);
      if (listM.status !== 403) throw new Error(`mashgiach list: ${listM.status} (expected 403)`);
      for (const [label, body] of [['admin', listP.body], ['coord', listC.body], ['adminQ', listQ.body]]) {
        const json = JSON.stringify(body);
        if (/secretHash|codeHash|"secret"/.test(json)) {
          throw new Error(`${label} device list leaked secret material`);
        }
      }
    }

    /* ---- Part 8: secrets live in the doc only as hashes ---- */
    let deviceSecretsPart;
    {
      await clearLimits();
      const d8 = await pairTablet(tAdminP, P1, 'Secrets tablet');
      deviceSecretsPart = d8;
      const doc = await ctx.getDoc();
      const docJson = JSON.stringify(doc);
      if (!docJson.includes(sha256Hex(d8.secret))) throw new Error('doc is missing the device secretHash');
      if (!docJson.includes(sha256Hex(d8.code))) throw new Error('doc is missing the pairing codeHash');
      if (docJson.includes(d8.secret)) throw new Error('doc contains the PLAIN device secret');
      if (docJson.includes(d8.code)) throw new Error('doc contains the PLAIN pairing code');
      // The admin export omits pairings entirely and strips secret hashes.
      const exp = await fetch(`${baseUrl}/api/admin/export`, { headers: auth(tAdminP) });
      if (exp.status !== 200) throw new Error(`export: ${exp.status}`);
      const expJson = JSON.stringify(await exp.json());
      if (expJson.includes('kioskPairings')) throw new Error('export contains kioskPairings');
      if (expJson.includes('secretHash')) throw new Error('export contains secretHash');
      if (expJson.includes(d8.secret)) throw new Error('export contains the plain device secret');
      // KIOSK_DEVICES_UPDATED carries NO device records — just the scope.
      const connA = await connectWs(baseUrl, tAdminP);
      const connC = await connectWs(baseUrl, tCoordP);
      const connM = await connectWs(baseUrl, tMashP1);
      const d8b = await pairTablet(tAdminP, P2, 'Broadcast tablet');
      const upd = await connA.waitFor('KIOSK_DEVICES_UPDATED', 5000);
      if (!upd) throw new Error('admin socket got no KIOSK_DEVICES_UPDATED');
      const keys = Object.keys(upd.payload || {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['agencyId', 'venueId'])) {
        throw new Error(`KIOSK_DEVICES_UPDATED payload keys: ${keys} (expected agencyId+venueId only)`);
      }
      if (upd.payload.venueId !== P2 || upd.payload.agencyId !== PAGENCY) {
        throw new Error(`KIOSK_DEVICES_UPDATED scope: ${JSON.stringify(upd.payload)}`);
      }
      // A coordinator of ANOTHER venue and a mashgiach receive nothing.
      const updC = await connC.waitFor('KIOSK_DEVICES_UPDATED', 1500);
      if (updC) throw new Error('coordinator of another venue received KIOSK_DEVICES_UPDATED');
      const updM = await connM.waitFor('KIOSK_DEVICES_UPDATED', 500);
      if (updM) throw new Error('mashgiach socket received KIOSK_DEVICES_UPDATED');
      connA.ws.close(); connC.ws.close(); connM.ws.close();
      await deleteDevice(tAdminP, d8b.deviceId);
    }

    /* ---- Part 9: PIN revision revokes tokens; stale lockouts pruned ---- */
    let deviceP1c;
    {
      const revBefore = (await docUser(mashP1Id))?.kioskPinRev;
      const login = await kioskLogin(deviceP1.header, mashP1Id, PIN_P1);
      if (login.status !== 200) throw new Error(`rev-part login: ${login.status}`);
      const oldToken = login.body.token;
      // Admin re-saves the SAME PIN with the exact apiWrite body — the
      // revision still bumps and the live token dies.
      const put = await fetch(`${baseUrl}/api/users/${mashP1Id}`, {
        method: 'PUT', headers: auth(tAdminP),
        body: JSON.stringify({
          kioskPin: PIN_P1,
          expectedVersion: await ctx.getVersion(),
          operationId: `t27-pinrev-${ts}`,
        }),
      });
      if (put.status !== 200) throw new Error(`PIN re-save: ${put.status}`);
      const revAfter = (await docUser(mashP1Id))?.kioskPinRev;
      if (!Number.isInteger(revAfter) || revAfter !== (revBefore ?? 0) + 1) {
        throw new Error(`kioskPinRev ${revBefore} → ${revAfter} (expected exactly +1, integer)`);
      }
      const dead = await getTasks(oldToken, deviceP1.header);
      if (dead.status !== 401) throw new Error(`token after PIN re-save: ${dead.status} (expected 401)`);
      const fresh = await kioskLogin(deviceP1.header, mashP1Id, PIN_P1);
      if (fresh.status !== 200) throw new Error(`fresh login after re-save: ${fresh.status}`);
      deviceP1c = { header: deviceP1.header, deviceId: deviceP1.deviceId, token: fresh.body.token };
      // Lockout pruning (A4): seed stale entries (fails 20 min old,
      // lockedUntil past) straight into the doc; the next kiosk-login
      // commit must prune them — and never an ACTIVE lock.
      // Seeded in the server's own shape: fails are ISO timestamps,
      // lockedUntil is a ms-epoch number.
      const oldIso = new Date(Date.now() - 20 * 60000).toISOString();
      const pastMs = Date.now() - 60000;
      const seed = await fetch(`${baseUrl}/api/__test__/doc-set-lockouts`, {
        method: 'POST', headers: auth(tAdminP),
        body: JSON.stringify({
          kioskPinLockouts: {
            users: { 'user-stale-t27': { fails: [oldIso], lockedUntil: pastMs } },
            tablets: { [`${P1}|127.0.0.1`]: { fails: [oldIso], lockedUntil: pastMs } },
          },
        }),
      });
      if (seed.status !== 200) throw new Error(`doc-set-lockouts: ${seed.status}`);
      await ctx.restartServer();
      const pruneLogin = await kioskLogin(deviceP1.header, mashP1Id, PIN_P1);
      if (pruneLogin.status !== 200) throw new Error(`prune login: ${pruneLogin.status}`);
      const docAfter = await ctx.getDoc();
      if (docAfter?.kioskPinLockouts?.users?.['user-stale-t27']) {
        throw new Error('stale user lockout key was not pruned');
      }
      if (docAfter?.kioskPinLockouts?.tablets?.[`${P1}|127.0.0.1`]) {
        throw new Error('stale tablet lockout key was not pruned');
      }
    }

    /* ---- Part 10: spoofing + device proof (finding 1) + forged tokens ---- */
    {
      // Body venueId/agencyId on login are ignored — the venue is the
      // DEVICE's. mashgiach P2 on the P1 tablet stays a plain wrong code.
      const spoof = await kioskLogin(deviceP1.header, mashP2Id, PIN_P2, {
        venueId: P2, agencyId: QAGENCY,
      });
      if (spoof.status !== 401 || spoof.body.error !== 'Wrong code. Try again.') {
        throw new Error(`spoofed login: ${spoof.status} ${JSON.stringify(spoof.body)}`);
      }
      // Body agencyId/userId on pair are ignored — the device lands in the
      // CALLER's agency at the requested venue.
      const stp = await startPairing();
      if (stp.status !== 200) throw new Error(`spoof-pair start: ${stp.status}`);
      const sp = await pairWith(tAdminP, stp.body.code, P1, {
        name: 'Spoof tablet', agencyId: QAGENCY, userId: mashQ1Id, pairedByUserId: mashQ1Id,
      });
      if (sp.status !== 201) throw new Error(`spoofed pair: ${sp.status} ${JSON.stringify(sp.body)}`);
      if (sp.body.device?.agencyId !== PAGENCY || sp.body.device?.venueId !== P1) {
        throw new Error(`spoofed pair scope: ${JSON.stringify(sp.body.device)}`);
      }
      await deleteDevice(tAdminP, sp.body.device.id);
      // Finding 1, REST: a VALID kiosk token without its device proof →
      // 401; with ANOTHER tablet's valid credential → 401; with its own →
      // 200.
      const noProof = await fetch(`${baseUrl}/api/tasks`, { headers: auth(deviceP1c.token) });
      if (noProof.status !== 401) throw new Error(`token without device proof: ${noProof.status} (expected 401)`);
      const wrongProof = await fetch(`${baseUrl}/api/tasks`, {
        headers: { ...auth(deviceP1c.token), 'X-Kiosk-Device': deviceP2.header },
      });
      if (wrongProof.status !== 401) throw new Error(`token with another tablet's proof: ${wrongProof.status} (expected 401)`);
      const ownProof = await getTasks(deviceP1c.token, deviceP1c.header);
      if (ownProof.status !== 200) throw new Error(`token with own proof: ${ownProof.status} (expected 200)`);
      // Finding 1, WS: no proof frame → closed 4401 (the server waits out
      // the 5 s proof window); another tablet's credential → 4401; its
      // own → INITIAL_STATE.
      const wsNone = await connectWs(baseUrl, deviceP1c.token, { expectClose: 4401 });
      if (wsNone.closeCode !== 4401) throw new Error(`WS without proof: ${wsNone.closeCode} (expected 4401)`);
      const wsWrong = await connectWs(baseUrl, deviceP1c.token, { expectClose: 4401, credential: deviceP2.header });
      if (wsWrong.closeCode !== 4401) throw new Error(`WS with another tablet's proof: ${wsWrong.closeCode} (expected 4401)`);
      const wsOwn = await connectWs(baseUrl, deviceP1c.token, { credential: deviceP1c.header });
      if (!wsOwn.messages.some((m) => m.type === 'INITIAL_STATE')) throw new Error('WS with own proof: no INITIAL_STATE');
      wsOwn.ws.close();
      // A forged dev claim (real pv, non-existent device) fails closed
      // everywhere — REST and WS alike.
      const pvNow = String((await docUser(mashP1Id))?.kioskPinRev);
      const mintKiosk = async (claims) => {
        const r = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, {
          method: 'POST', headers: auth(tAdminP), body: JSON.stringify(claims),
        });
        if (r.status !== 200) throw new Error(`mint-kiosk-token: ${r.status}`);
        return (await r.json()).token;
      };
      const forged = await mintKiosk({
        userId: mashP1Id, agencyId: PAGENCY, venueId: P1, pv: pvNow, dev: 'kdev-does-not-exist',
      });
      const fr = await fetch(`${baseUrl}/api/tasks`, {
        headers: { ...auth(forged), 'X-Kiosk-Device': deviceP1.header },
      });
      if (fr.status !== 401) throw new Error(`forged dev token REST: ${fr.status} (expected 401)`);
      const fws = await connectWs(baseUrl, forged, { expectClose: 4401, credential: deviceP1.header });
      if (fws.closeCode !== 4401) throw new Error(`forged dev token WS: ${fws.closeCode} (expected 4401)`);
      // A 2a-shaped token (pv but NO dev) fails closed too.
      const noDev = await mintKiosk({ userId: mashP1Id, agencyId: PAGENCY, venueId: P1, pv: pvNow });
      const nr = await getTasks(noDev, deviceP1.header);
      if (nr.status !== 401) throw new Error(`dev-less token REST: ${nr.status} (expected 401)`);
      const nws = await connectWs(baseUrl, noDev, { expectClose: 4401, credential: deviceP1.header });
      if (nws.closeCode !== 4401) throw new Error(`dev-less token WS: ${nws.closeCode} (expected 4401)`);
    }
  },
};
