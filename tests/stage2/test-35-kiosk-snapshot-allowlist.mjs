/**
 * Test 35 (D3c): the kiosk INITIAL_STATE is an explicit allowlist.
 *
 * ChatGPT's #46 review: initialStateForSocket must build the kiosk snapshot
 * from listed keys, never a spread of the agency state. Proof of EXCLUSION:
 * in test mode agencyStateFor adds a top-level probe key (__stage2Probe).
 *  1 positive twin: a phone socket's INITIAL_STATE carries the probe (so the
 *    probe is live and a spread would have leaked it).
 *  2 the kiosk socket's handshake INITIAL_STATE has EXACTLY the allowlisted
 *    keys (+ activeWorkersCount from the envelope), no probe; roster entries
 *    have exactly id,name,avatarColor,role; tasks/history are venue A only;
 *    venues is just venue A; events/airtable/ingredients/factory are empty.
 *  3 the same holds for a PUSHED INITIAL_STATE (the signed-in user's role
 *    changes while the kiosk socket is open).
 */

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


const ALLOWED = ['activeWorkersCount', 'airtableConfigs', 'approvedIngredients', 'currentWorkDate', 'events', 'factoryReports', 'historyLogs', 'tasks', 'users', 'venues'];

export default {
  name: 'Test 35: kiosk INITIAL_STATE is an explicit allowlist (D3c)',
  whatItProves:
    'A key added to the agency state never reaches a kiosk tablet unless it is listed: the test-mode probe key reaches a phone socket but never a kiosk socket, on the handshake or on a pushed INITIAL_STATE; the kiosk snapshot has exactly the allowlisted keys and roster fields.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = 'agency-test35';
    const vA = `venue-t35a-${ts}`;
    const vB = `venue-t35b-${ts}`;
    const adminId = `user-t35-admin-${ts}`;
    const mashA = `user-t35-masha-${ts}`;
    const mashAEmail = `masha35-${ts}@test.local`;
    const tA = `task-t35-A-${ts}`;
    const tB = `task-t35-B-${ts}`;
    const PIN = '3916';
    const task = (id, venueId) => ({
      id, agencyId: AG, venueId, title: `T35 ${id}`, category: 'General', categories: ['General'],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: '9:30 PM', currentStatus: 'pending', isCompleted: false,
      assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0,
    });
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'Test35 Agency' }],
      venues: [
        { id: vA, name: `T35 A ${ts}`, agencyId: AG },
        { id: vB, name: `T35 B ${ts}`, agencyId: AG },
      ],
      users: [
        { id: adminId, email: `admin35-${ts}@test.local`, name: 'T35 Admin', role: 'admin', agencyId: AG },
        { id: mashA, email: mashAEmail, name: 'T35 Mash A', role: 'mashgiach', agencyId: AG, venueId: vA, kioskPin: PIN, phoneNumber: '+18605550135' },
      ],
      tasks: [task(tA, vA), task(tB, vB)],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const tAdmin = await mintToken(baseUrl, adminId);
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const dev = await pairDevice(baseUrl, tAdmin, vA);

    // --- 1. positive twin: the phone socket gets the probe ---
    const phone = await connectWs(baseUrl, tAdmin);
    const pState = phone.messages.find((m) => m.type === 'INITIAL_STATE');
    phone.close();
    if (!pState || pState.payload?.__stage2Probe !== 'not-for-kiosk') {
      throw new Error('probe key missing from the phone INITIAL_STATE — the test-mode probe is not live, so exclusion is unproven');
    }

    // --- 2. kiosk handshake ---
    const lr = await fetch(`${baseUrl}/api/kiosk/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header },
      body: JSON.stringify({ userId: mashA, pin: PIN }),
    });
    const lb = await lr.json().catch(() => ({}));
    if (lr.status !== 200 || !lb.token) throw new Error(`kiosk login: ${lr.status}`);

    const check = (p, label) => {
      if (!p) throw new Error(`${label}: no payload`);
      if ('__stage2Probe' in p) throw new Error(`${label}: the probe key reached the kiosk (allowlist not applied)`);
      const keys = Object.keys(p).sort();
      const extra = keys.filter((k) => !ALLOWED.includes(k));
      const missing = ALLOWED.filter((k) => k !== 'activeWorkersCount' && !keys.includes(k));
      if (extra.length) throw new Error(`${label}: keys outside the allowlist: ${extra.join(',')}`);
      if (missing.length) throw new Error(`${label}: allowlisted keys missing (the client would silently lose them): ${missing.join(',')}`);
      for (const u of p.users || []) {
        const ks = Object.keys(u).sort().join(',');
        if (ks !== 'avatarColor,id,name,role' && ks !== 'id,name,role') throw new Error(`${label}: roster entry fields ${ks}`);
      }
      const tids = (p.tasks || []).map((t) => t.id);
      if (!tids.includes(tA)) throw new Error(`${label}: venue-A task missing`);
      if (tids.includes(tB) || (p.tasks || []).some((t) => t.venueId !== vA)) throw new Error(`${label}: a task from another venue`);
      if ((p.historyLogs || []).some((h) => h.venueId !== vA)) throw new Error(`${label}: history from another venue`);
      if ((p.venues || []).length !== 1 || p.venues[0].id !== vA) throw new Error(`${label}: venues ${JSON.stringify((p.venues || []).map((v) => v.id))}`);
      for (const k of ['events', 'airtableConfigs', 'approvedIngredients', 'factoryReports']) {
        if (!Array.isArray(p[k]) || p[k].length) throw new Error(`${label}: ${k} must be an empty array`);
      }
      if (typeof p.currentWorkDate !== 'string' || !p.currentWorkDate) throw new Error(`${label}: currentWorkDate missing`);
    };

    const ks = await connectWs(baseUrl, lb.token, dev.header);
    try {
      const hs = ks.messages.find((m) => m.type === 'INITIAL_STATE');
      check(hs?.payload, 'kiosk handshake INITIAL_STATE');

      // --- 3. pushed INITIAL_STATE (role change of the signed-in user) ---
      ks.messages.length = 0;
      const pr = await fetch(`${baseUrl}/api/users/${mashA}`, {
        method: 'PUT', headers: auth(tAdmin),
        body: JSON.stringify({ role: 'admin', expectedVersion: await ctx.getVersion(), operationId: crypto.randomUUID() }),
      });
      if (pr.status !== 200) throw new Error(`role change: ${pr.status}`);
      const pushed = await ks.waitFor((m) => m.type === 'INITIAL_STATE', 5000);
      if (!pushed) throw new Error('no pushed INITIAL_STATE reached the kiosk socket after the role change');
      check(pushed.payload, 'kiosk pushed INITIAL_STATE');
    } finally {
      ks.close();
    }
    return 'phone socket carries the probe; kiosk handshake + pushed INITIAL_STATE carry exactly the allowlisted keys, no probe, venue A only, roster id/name/avatarColor/role';
  },
};
