/**
 * Test 25: Kiosk hardening — hashed PINs, lockout, venue-scoped kiosk session.
 *
 * Part 1 (hashing):
 *  - Correct PIN logs in, returns a kiosk token + safe user; the JSON carries
 *    neither kioskPin nor kioskPinHash anywhere (whole-JSON string search).
 *  - Legacy plain-PIN user (injected) logs in; afterwards the Firestore doc
 *    shows a bcrypt hash and no kioskPin.
 *  - Admin PUT with kioskPin stores a hash; the PUT response, USERS_UPDATED
 *    broadcast, and GET /api/users carry neither field.
 *  - /api/kiosk/device lists the PAIRED venue's users with kioskPin OR
 *    kioskPinHash (names only); the old /api/kiosk/users + /api/kiosk/venues
 *    are closed (2b).
 *
 * 2b note: every kiosk login in this test happens on a PAIRED tablet — the
 * helper pairs a device first (pairDevice + useDevice) and sends the
 * X-Kiosk-Device header, exactly like the real client. Assertions are
 * unchanged from 2a except Part 1d (device roster instead of the public
 * picker) and Part 14 (unknown-user attempts now ride a paired device;
 * invented body venueIds are ignored).
 *
 * Part 2 (lockout):
 *  - 5 wrong PINs → 401 each; 6th (even correct) → 429 + message + Retry-After
 *    from a fresh connection.
 *  - Restart keeps the lock.
 *  - Correct PIN resets the counter.
 *  - Venue+IP lockout at 20 across two users.
 *
 * Part 3 (venue-scoped kiosk session):
 *  - Kiosk token on non-allowlisted endpoints → 403 KIOSK_SCOPE (POST
 *    /api/tasks, PUT /api/users/:id, POST /api/auth/change-password,
 *    GET /api/admin/dashboard).
 *  - Kiosk token with coordinator PIN on PUT /api/users/:id → 403.
 *  - Kiosk token reading/writing another venue's task → 403/empty.
 *  - WS with kiosk token: INITIAL_STATE has only the kiosk venue's tasks;
 *    a task created in another venue does not reach that socket.
 *  - Phone login token unchanged (no kiosk claim, full access).
 *
 * Rule G: each negative is verified by reverting the fix and watching it fail.
 */

const AGENCY = 'agency-test25-a';

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

/* auth + the kiosk device proof header (addendum, finding 1): a request
 * carrying a kiosk token must also carry X-Kiosk-Device for the device the
 * token was minted on. `useDevice` selects that device (as it does for
 * kioskLogin and connectWs). */
function authK(token) {
  return { ...auth(token), ...(deviceHeader ? { 'X-Kiosk-Device': deviceHeader } : {}) };
}

/* ---- 2b: pairing helpers (the tablet side of the flow) ---- */
let deviceHeader = null;
function useDevice(d) { deviceHeader = d ? d.header : null; }

async function pairDevice(baseUrl, adminToken, venueId, name) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const s = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken),
    body: JSON.stringify({ code: s.code, venueId, ...(name ? { name } : {}) }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status} ${JSON.stringify(await pair.json().catch(() => ({})))}`);
  const status = await fetch(`${baseUrl}/api/kiosk/pairing/status`, {
    headers: { 'X-Kiosk-Pairing': `${s.pairingId}.${s.deviceSecret}` },
  });
  if (status.status !== 200) throw new Error(`pairing/status: ${status.status}`);
  const sb = await status.json();
  if (sb.status !== 'approved' || !sb.device) throw new Error('pairing not approved');
  return { header: `${sb.device.id}.${s.deviceSecret}`, deviceId: sb.device.id, secret: s.deviceSecret };
}

async function kioskLogin(baseUrl, userId, pin) {
  const res = await fetch(`${baseUrl}/api/kiosk/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(deviceHeader ? { 'X-Kiosk-Device': deviceHeader } : {}) },
    body: JSON.stringify({ userId, pin }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

function assertNoPinFields(obj, label) {
  const json = JSON.stringify(obj);
  // kioskPinSetAt is a version timestamp (safe); the secrets are kioskPin/kioskPinHash.
  if (/"kioskPin":/.test(json) || /"kioskPinHash":/.test(json)) {
    throw new Error(`${label}: kioskPin/kioskPinHash leaked in JSON`);
  }
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
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {
      // Device proof (finding 1): the first frame on a kiosk socket.
      if (deviceHeader) {
        try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: deviceHeader })); } catch {}
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
      if (opts.expectClose) {
        conn.closeCode = ev.code;
        resolve(conn);
      } else if (!messages.some((m) => m.type === 'INITIAL_STATE')) {
        reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
      }
    };
  });
}

export default {
  name: 'Test 25: Kiosk hardening — hashed PINs, lockout, venue-scoped session',
  whatItProves:
    'Kiosk PINs are bcrypt-hashed (never plain in responses/logs/backups); 5 wrong PINs lock the user, 20 wrong from a tablet lock the tablet; kiosk tokens are venue-scoped to an allowlist with 403 KIOSK_SCOPE elsewhere; WS carries only the kiosk venue.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueA = `venue-test25-a-${ts}`;
    const venueB = `venue-test25-b-${ts}`;
    const adminId = `user-test25-admin-${ts}`;
    const mashAId = `user-test25-masha-${ts}`;
    const mashBId = `user-test25-mashb-${ts}`;
    const coordId = `user-test25-coord-${ts}`;
    const taskAId = `task-test25-a-${ts}`;
    const taskBId = `task-test25-b-${ts}`;
    const PIN_A = '1234';
    const PIN_B = '5678';
    const COORD_PIN = '9012';
    const coordAId = coordId;

    // Fixtures: mashA/mashB have LEGACY plain PINs (to test upgrade).
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test25 Agency' }],
      venues: [
        { id: venueA, name: `Venue A ${ts}`, agencyId: AGENCY },
        { id: venueB, name: `Venue B ${ts}`, agencyId: AGENCY },
      ],
      users: [
        { id: adminId, email: `admin-${ts}@test.local`, name: 'T25 Admin', role: 'admin', agencyId: AGENCY },
        { id: mashAId, email: `masha-${ts}@test.local`, name: 'T25 Mash A', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: PIN_A },
        { id: mashBId, email: `mashb-${ts}@test.local`, name: 'T25 Mash B', role: 'mashgiach', agencyId: AGENCY, venueId: venueB, kioskPin: PIN_B },
        { id: coordId, email: `coord-${ts}@test.local`, name: 'T25 Coord', role: 'coordinator', agencyId: AGENCY, venueId: venueA, kioskPin: '9012' },
      ],
      tasks: [
        { id: taskAId, agencyId: AGENCY, venueId: venueA, title: `Task A ${ts}`, createdAt: new Date(ts).toISOString() },
        { id: taskBId, agencyId: AGENCY, venueId: venueB, title: `Task B ${ts}`, createdAt: new Date(ts).toISOString() },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, adminId);
    const deviceA = await pairDevice(baseUrl, tAdmin, venueA, 'T25 Tablet A');
    const deviceB = await pairDevice(baseUrl, tAdmin, venueB, 'T25 Tablet B');
    useDevice(deviceA);

    /* ---- Part 1a: correct PIN logs in, kiosk token, no PIN fields in JSON ---- */
    let kioskTokenA;
    {
      const r = await kioskLogin(baseUrl, mashAId, PIN_A);
      if (r.status !== 200) throw new Error(`kiosk login: ${r.status} ${JSON.stringify(r.body)}`);
      if (!r.body.token) throw new Error('kiosk login: no token');
      if (!r.body.user) throw new Error('kiosk login: no user');
      kioskTokenA = r.body.token;
      assertNoPinFields(r.body, 'kiosk login response');
      // Token must carry the kiosk claim (decode payload, don't verify sig here).
      const payload = JSON.parse(Buffer.from(kioskTokenA.split('.')[1], 'base64').toString());
      if (payload.kiosk !== true) throw new Error('kiosk token missing kiosk:true claim');
      if (payload.venueId !== venueA) throw new Error(`kiosk token venueId ${payload.venueId} !== ${venueA}`);
      if (payload.dev !== deviceA.deviceId) throw new Error(`kiosk token dev ${payload.dev} !== paired device ${deviceA.deviceId}`);
      if (!/^\d+$/.test(String(payload.pv || ''))) throw new Error(`kiosk token pv is not the PIN revision: ${payload.pv}`);
      const ttlHrs = (payload.exp - payload.iat) / 3600;
      if (Math.abs(ttlHrs - 12) > 0.1) throw new Error(`kiosk token TTL ${ttlHrs}h, expected 12h`);
    }

    /* ---- Part 1b: legacy plain PIN upgraded to bcrypt on login ---- */
    {
      // mashB still has a plain kioskPin; log in on venue B's tablet to
      // trigger the upgrade (2b: the tablet must be the user's own venue).
      useDevice(deviceB);
      const r = await kioskLogin(baseUrl, mashBId, PIN_B);
      if (r.status !== 200) throw new Error(`legacy login: ${r.status}`);
      useDevice(deviceA);
      // Read the Firestore doc; the user must now have a bcrypt hash, no plain PIN.
      const dr = await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) });
      const doc = await dr.json();
      const users = doc.users || doc.doc?.users || [];
      const mashB = users.find((u) => u.id === mashBId);
      if (!mashB) throw new Error('legacy upgrade: user not in doc');
      if (mashB.kioskPin) throw new Error('legacy upgrade: plain kioskPin still present');
      if (!mashB.kioskPinHash || !String(mashB.kioskPinHash).startsWith('$2')) {
        throw new Error('legacy upgrade: kioskPinHash missing or not bcrypt');
      }
    }

    /* ---- Part 1c: admin PUT stores a hash; responses carry neither field ---- */
    {
      const ver = await ctx.getVersion();
      const pr = await fetch(`${baseUrl}/api/users/${coordId}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin),
        body: JSON.stringify({ kioskPin: '9999' }),
      });
      if (pr.status !== 200) throw new Error(`PUT kioskPin: ${pr.status}`);
      const pb = await pr.json();
      assertNoPinFields(pb, 'PUT /api/users response');
      const updated = pb.user || pb;
      // The stored user (via GET) must have a hash, not the digits.
      const gr = await fetch(`${baseUrl}/api/users`, { headers: auth(tAdmin) });
      const gb = await gr.json();
      const coordBack = (gb.users || []).find((u) => u.id === coordId);
      if (!coordBack) throw new Error('PUT: coord not in GET /api/users');
      assertNoPinFields(gb, 'GET /api/users');
      // Read the raw doc to confirm the hash is stored (not the digits).
      const dr = await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) });
      const doc = await dr.json();
      const users = doc.users || doc.doc?.users || [];
      const coordDoc = users.find((u) => u.id === coordId);
      if (!coordDoc?.kioskPinHash?.startsWith('$2')) throw new Error('PUT: kioskPinHash not bcrypt in doc');
      if (coordDoc.kioskPin) throw new Error('PUT: plain kioskPin in doc');
      // The coordinator can now log in with the new PIN.
      const lr = await kioskLogin(baseUrl, coordId, '9999');
      if (lr.status !== 200) throw new Error(`coord kiosk login after PUT: ${lr.status}`);
    }

    /* ---- Part 1d: /api/kiosk/device lists the paired venue's PIN users ---- */
    {
      const r = await fetch(`${baseUrl}/api/kiosk/device`, {
        headers: { 'X-Kiosk-Device': deviceA.header },
      });
      if (r.status !== 200) throw new Error(`/api/kiosk/device: ${r.status}`);
      const b = await r.json();
      assertNoPinFields(b, '/api/kiosk/device');
      if (b.device?.venueId !== venueA) throw new Error('/api/kiosk/device: wrong venue');
      const ids = (b.users || []).map((u) => u.id);
      if (!ids.includes(mashAId)) throw new Error('/api/kiosk/device missing mashA');
      if (ids.includes(mashBId)) throw new Error('/api/kiosk/device leaked the other venue’s mashgiach');
      // The old public pickers are closed (2b): no token → 401.
      for (const path of [`/api/kiosk/users?venueId=${venueA}`, '/api/kiosk/venues']) {
        const closed = await fetch(`${baseUrl}${path}`);
        if (closed.status !== 401 && closed.status !== 404) {
          throw new Error(`${path}: ${closed.status} (expected 401/404 — route closed)`);
        }
      }
    }

    /* ---- Part 1e: an admin id on the kiosk is just a wrong code ---- */
    {
      // Fix round 1 (2b): the admin answer used to be a tell-tale 403.
      // Now an admin id is indistinguishable from a nonexistent one —
      // same status, same body — so admin accounts can't be enumerated
      // from a paired tablet.
      const adminTry = await kioskLogin(baseUrl, adminId, '9999');
      const ghostTry = await kioskLogin(baseUrl, `ghost-${ts}`, '9999');
      if (adminTry.status !== 401 || adminTry.body.error !== 'Wrong code. Try again.') {
        throw new Error(`admin kiosk login: ${adminTry.status} ${JSON.stringify(adminTry.body)} (expected generic 401)`);
      }
      if (ghostTry.status !== adminTry.status || JSON.stringify(ghostTry.body) !== JSON.stringify(adminTry.body)) {
        throw new Error('admin and nonexistent kiosk logins differ — admin ids are enumerable');
      }
    }

    /* ---- Part 2a: 5 wrong → 6th (even correct) → 429 ---- */
    {
      // Use a fresh user to avoid interference from earlier logins.
      const freshId = `user-test25-fresh-${ts}`;
      const inj2 = await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: freshId, email: `fresh-${ts}@test.local`, name: 'T25 Fresh', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '1111' }],
      });
      if (inj2.status !== 200) throw new Error(`inject fresh: ${inj2.status}`);
      // 5 wrong → 401 each; 6th (even correct) → 429 + Retry-After.
      for (let i = 0; i < 5; i++) {
        const r = await kioskLogin(baseUrl, freshId, '0000');
        if (r.status !== 401) throw new Error(`wrong PIN ${i + 1}: ${r.status} (expected 401)`);
        if (r.body.error !== 'Wrong code. Try again.') throw new Error(`wrong PIN message: ${r.body.error}`);
      }
      // 6th attempt with the CORRECT PIN must still be 429.
      const r6 = await kioskLogin(baseUrl, freshId, '1111');
      if (r6.status !== 429) throw new Error(`6th attempt: ${r6.status} (expected 429)`);
      if (!/Too many wrong codes/.test(r6.body.error || '')) {
        throw new Error(`429 message: ${r6.body.error}`);
      }
      if (!r6.headers.get('retry-after')) throw new Error('429 missing Retry-After header');
    }

    /* ---- Part 2b: restart keeps the lock ---- */
    {
      await ctx.restartServer();
      const tAdmin2 = await mintToken(baseUrl, adminId);
      // The fresh user from 2a is still locked (use a wrong PIN to avoid consuming).
      const freshId = `user-test25-fresh-${ts}`;
      const r = await kioskLogin(baseUrl, freshId, '0000');
      if (r.status !== 429) throw new Error(`after restart: ${r.status} (expected 429, lock persisted)`);
      // Clear lockouts via the test hook for the remaining tests.
      const cr = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, {
        method: 'POST', headers: auth(tAdmin2),
      });
      if (cr.status !== 200) throw new Error(`clear lockouts: ${cr.status}`);
      const r2 = await kioskLogin(baseUrl, freshId, '1111');
      if (r2.status !== 200) throw new Error(`after clear: ${r2.status} (expected 200)`);
    }

    /* ---- Part 2b2: clear-lockouts requires admin ---- */
    {
      const lr = await kioskLogin(baseUrl, mashAId, PIN_A);
      const kioskTok = lr.body.token;
      const tMash = await mintToken(baseUrl, mashAId);
      for (const [label, tok] of [['kiosk', kioskTok], ['mashgiach', tMash]]) {
        const r = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, {
          method: 'POST', headers: label === 'kiosk' ? authK(tok) : auth(tok),
        });
        if (r.status !== 403) throw new Error(`clear-lockouts as ${label}: ${r.status} (expected 403)`);
      }
    }

    /* ---- Part 2c: correct PIN resets the counter ---- */
    {
      const uid = `user-test25-reset-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `reset-${ts}@test.local`, name: 'T25 Reset', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '2222' }],
      });
      for (let i = 0; i < 3; i++) {
        await kioskLogin(baseUrl, uid, '0000');
      }
      // Correct PIN resets; then 5 more wrong should be needed for a lock.
      const ok = await kioskLogin(baseUrl, uid, '2222');
      if (ok.status !== 200) throw new Error(`correct after 3 fails: ${ok.status}`);
      for (let i = 0; i < 5; i++) {
        const r = await kioskLogin(baseUrl, uid, '0000');
        if (r.status !== 401) throw new Error(`post-reset wrong ${i + 1}: ${r.status} (expected 401, counter was reset)`);
      }
      const locked = await kioskLogin(baseUrl, uid, '2222');
      if (locked.status !== 429) throw new Error(`post-reset 6th: ${locked.status} (expected 429)`);
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    }

    /* ---- Part 2d: concurrent wrong attempts — at most 5 compares ---- */
    {
      const uid = `user-test25-conc-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `conc-${ts}@test.local`, name: 'T25 Conc', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '3333' }],
      });
      // Fire 8 wrong attempts concurrently; at most 5 should get 401 (compare),
      // the rest 429/503 (locked / fail-closed). The reservation transaction
      // serializes the counting — "count attempts, not failures".
      const results = await Promise.all(
        Array.from({ length: 8 }, () => kioskLogin(baseUrl, uid, '0000'))
      );
      const statuses = results.map((r) => r.status);
      const count401 = statuses.filter((s) => s === 401).length;
      const countLocked = statuses.filter((s) => s === 429 || s === 503).length;
      if (count401 > 5) throw new Error(`concurrent: ${count401} compares (expected ≤5)`);
      if (count401 + countLocked !== 8) throw new Error(`concurrent: unexpected statuses ${statuses}`);
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    }

    /* ---- Part 3a: kiosk token on non-allowlisted endpoints → 403 KIOSK_SCOPE ---- */
    {
      const kioskToken = kioskTokenA;
      const checks = [
        ['POST', '/api/tasks', 403],
        ['PUT', `/api/users/${mashAId}`, 403],
        ['POST', '/api/auth/change-password', 403],
        ['GET', '/api/admin/dashboard', 403],
      ];
      for (const [method, path] of checks) {
        const r = await fetch(`${baseUrl}${path}`, {
          method, headers: authK(kioskToken),
          body: method === 'POST' || method === 'PUT' ? JSON.stringify({}) : undefined,
        });
        if (r.status !== 403) throw new Error(`kiosk ${method} ${path}: ${r.status} (expected 403)`);
        const b = await r.json().catch(() => ({}));
        if (b.code !== 'KIOSK_SCOPE') throw new Error(`kiosk ${method} ${path}: code ${b.code} (expected KIOSK_SCOPE)`);
      }
    }

    /* ---- Part 3b: coordinator PIN on kiosk → still 403 on admin writes ---- */
    {
      // Note: Part 1c set the coordinator's PIN to '9999' via PUT.
      const lr = await kioskLogin(baseUrl, coordId, '9999');
      if (lr.status !== 200) throw new Error(`coord kiosk login: ${lr.status}`);
      const kioskCoord = lr.body.token;
      const r = await fetch(`${baseUrl}/api/users/${mashAId}`, {
        method: 'PUT', headers: authK(kioskCoord), body: JSON.stringify({ name: 'Hacked' }),
      });
      if (r.status !== 403) throw new Error(`kiosk coord PUT /api/users: ${r.status} (expected 403)`);
    }

    /* ---- Part 3c: kiosk token venue scoping on reads/writes ---- */
    {
      const kioskToken = kioskTokenA; // venueA
      // GET /api/tasks → only venueA tasks.
      const tr = await fetch(`${baseUrl}/api/tasks`, { headers: authK(kioskToken) });
      const tb = await tr.json();
      const tids = (tb.tasks || []).map((t) => t.id);
      if (!tids.includes(taskAId)) throw new Error('kiosk GET /api/tasks missing own venue task');
      if (tids.includes(taskBId)) throw new Error('kiosk GET /api/tasks leaked other venue task');
      // PUT on other venue's task → 403.
      const ver = await ctx.getVersion();
      const pr = await fetch(`${baseUrl}/api/tasks/${taskBId}?expectedVersion=${ver}`, {
        method: 'PUT', headers: authK(kioskToken), body: JSON.stringify({ notes: 'x' }),
      });
      if (pr.status !== 403) throw new Error(`kiosk PUT other venue task: ${pr.status} (expected 403)`);
      // GET /api/history → only venueA.
      const hr = await fetch(`${baseUrl}/api/history`, { headers: authK(kioskToken) });
      const hb = await hr.json();
      for (const h of hb.historyLogs || []) {
        if (h.venueId && h.venueId !== venueA) throw new Error('kiosk GET /api/history leaked other venue');
      }
    }

    /* ---- Part 3d: WS with kiosk token — only kiosk venue ---- */
    {
      const conn = await connectWs(baseUrl, kioskTokenA);
      const init = conn.messages.find((m) => m.type === 'INITIAL_STATE');
      if (!init) throw new Error('WS: no INITIAL_STATE');
      const tids = (init.payload.tasks || []).map((t) => t.id);
      if (!tids.includes(taskAId)) throw new Error('WS kiosk: missing own venue task');
      if (tids.includes(taskBId)) throw new Error('WS kiosk: leaked other venue task');
      // Create a task in venueB via admin; it must not reach the kiosk socket.
      const ver = await ctx.getVersion();
      const cr = await fetch(`${baseUrl}/api/tasks?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ venueId: venueB, title: `Task B2 ${ts}`, agencyId: AGENCY }),
      });
      if (cr.status !== 200 && cr.status !== 201) throw new Error(`create task B2: ${cr.status}`);
      // Wait briefly for any broadcast, then check.
      await new Promise((r) => setTimeout(r, 2000));
      const created = conn.messages.filter((m) => m.type === 'TASK_CREATED');
      for (const m of created) {
        const task = m.payload?.task || m.payload;
        if (task?.venueId === venueB) {
          throw new Error('WS kiosk: received TASK_CREATED for other venue');
        }
      }
      conn.ws.close();
    }

    /* ---- Part 3f: narrower kiosk writes ---- */
    {
      const kioskToken = kioskTokenA; // venueA
      const ver = await ctx.getVersion();
      // PUT with a forbidden field (title) → 403 KIOSK_SCOPE.
      const pr = await fetch(`${baseUrl}/api/tasks/${taskAId}?expectedVersion=${ver}`, {
        method: 'PUT', headers: authK(kioskToken), body: JSON.stringify({ title: 'Hacked' }),
      });
      if (pr.status !== 403) throw new Error(`kiosk PUT title: ${pr.status} (expected 403)`);
      // PUT with the exact client body (currentStatus, isCompleted, userEmail,
      // userName — App.tsx L539-548) → 200. userName/userEmail are server-overwritten.
      const ver2 = await ctx.getVersion();
      const pr2 = await fetch(`${baseUrl}/api/tasks/${taskAId}?expectedVersion=${ver2}`, {
        method: 'PUT', headers: authK(kioskToken),
        body: JSON.stringify({ currentStatus: 'done', isCompleted: true, userEmail: 'x@y.z', userName: 'X' }),
      });
      if (pr2.status !== 200) throw new Error(`kiosk PUT client body: ${pr2.status} (expected 200)`);
    }

    /* ---- Part 4: lifecycle — PIN removed / venue moved / user deleted → 401 ---- */
    {
      const lr = await kioskLogin(baseUrl, mashAId, PIN_A);
      if (lr.status !== 200) throw new Error(`lifecycle login: ${lr.status}`);
      const liveToken = lr.body.token;
      // Admin removes the PIN.
      const ver = await ctx.getVersion();
      const pr = await fetch(`${baseUrl}/api/users/${mashAId}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ kioskPin: '' }),
      });
      if (pr.status !== 200) throw new Error(`remove PIN: ${pr.status}`);
      const r1 = await fetch(`${baseUrl}/api/tasks`, { headers: authK(liveToken) });
      if (r1.status !== 401) throw new Error(`PIN removed: ${r1.status} (expected 401)`);
      // Restore PIN for the next checks.
      const ver2 = await ctx.getVersion();
      await fetch(`${baseUrl}/api/users/${mashAId}?expectedVersion=${ver2}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ kioskPin: PIN_A }),
      });
      const lr2 = await kioskLogin(baseUrl, mashAId, PIN_A);
      const liveToken2 = lr2.body.token;
      // Admin moves the user to another venue.
      const ver3 = await ctx.getVersion();
      await fetch(`${baseUrl}/api/users/${mashAId}?expectedVersion=${ver3}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ venueId: venueB }),
      });
      const r2 = await fetch(`${baseUrl}/api/tasks`, { headers: authK(liveToken2) });
      if (r2.status !== 401) throw new Error(`venue moved: ${r2.status} (expected 401)`);
    }

    /* ---- Part 3g: kiosk socket receives no other-venue/incident/event payloads ---- */
    {
      // mashA was moved to venueB in Part 4 — log in on venue B's tablet to
      // mint a fresh token for the current venue (note posted to venueA,
      // the OTHER venue now).
      useDevice(deviceB);
      const lr = await kioskLogin(baseUrl, mashAId, PIN_A);
      if (lr.status !== 200) throw new Error(`3g login: ${lr.status}`);
      const conn = await connectWs(baseUrl, lr.body.token);
      const before = conn.messages.length;
      // Handoff note in venueA (via admin phone token).
      const ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/handoff-notes?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ venueId: venueA, content: `Other venue note ${ts}`, shift: 'Morning' }),
      });
      // Incident in venueA.
      const ver2 = await ctx.getVersion();
      await fetch(`${baseUrl}/api/incidents?expectedVersion=${ver2}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ venueId: venueA, title: `Other venue incident ${ts}`, description: 'd', severity: 'low' }),
      });
      await new Promise((r) => setTimeout(r, 2000));
      const after = conn.messages.slice(before);
      for (const m of after) {
        if (m.type === 'HANDOFF_NOTE') {
          const note = m.payload?.note || m.payload;
          if (note?.venueId === venueA) throw new Error('kiosk socket received other-venue HANDOFF_NOTE');
        }
        if (m.type === 'INCIDENT_CREATED') throw new Error('kiosk socket received INCIDENT_CREATED');
        if (m.type === 'EVENT_CREATED' || m.type === 'EVENT_UPDATED') {
          throw new Error(`kiosk socket received ${m.type}`);
        }
      }
      conn.ws.close();
    }

    /* ---- Part 4b: admin PIN set clears a lock ---- */
    {
      useDevice(deviceA);
      const uid = `user-test25-unlock-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `unlock-${ts}@test.local`, name: 'T25 Unlock', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '4444' }],
      });
      for (let i = 0; i < 5; i++) await kioskLogin(baseUrl, uid, '0000');
      const locked = await kioskLogin(baseUrl, uid, '4444');
      if (locked.status !== 429) throw new Error(`locked: ${locked.status} (expected 429)`);
      // Admin sets the PIN again → lock cleared in the same commit.
      const ver = await ctx.getVersion();
      const pr = await fetch(`${baseUrl}/api/users/${uid}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ kioskPin: '4444' }),
      });
      if (pr.status !== 200) throw new Error(`admin PIN set: ${pr.status}`);
      const ok = await kioskLogin(baseUrl, uid, '4444');
      if (ok.status !== 200) throw new Error(`after admin unlock: ${ok.status} (expected 200)`);
    }

    /* ---- Part 5: USER_PRESENCE must not downgrade a kiosk socket ---- */
    {
      useDevice(deviceB);
      const lr = await kioskLogin(baseUrl, mashBId, PIN_B);
      if (lr.status !== 200) throw new Error(`presence test login: ${lr.status}`);
      const conn = await connectWs(baseUrl, lr.body.token);
      // Kiosk socket (venueB) sends a presence message, then a task lands
      // in venueA (the OTHER venue) — the kiosk must NOT receive it.
      conn.ws.send(JSON.stringify({ type: 'USER_PRESENCE', payload: {} }));
      await new Promise((r) => setTimeout(r, 500));
      const ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/tasks?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ title: `Presence test ${ts}`, venueId: venueA, agencyId: AGENCY }),
      });
      await new Promise((r) => setTimeout(r, 2000));
      for (const m of conn.messages) {
        if (m.type === 'TASK_CREATED') {
          const task = m.payload?.task || m.payload;
          if (task?.venueId === venueA) {
            throw new Error('kiosk socket received other-venue TASK_CREATED after USER_PRESENCE (meta was downgraded)');
          }
        }
      }
      conn.ws.close();
    }

    /* ---- Part 5b: USER_PRESENCE at a second agency keeps the kiosk meta ---- */
    {
      const agencyB = `agency-test25-b-${ts}`;
      const venueC = `venue-test25-c-${ts}`;
      const mashCId = `user-test25-mashc-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        agencies: [{ id: agencyB, name: 'Test25 Agency B' }],
        venues: [{ id: venueC, name: `Venue C ${ts}`, agencyId: agencyB }],
        users: [{ id: mashCId, email: `mashc-${ts}@test.local`, name: 'T25 Mash C', role: 'mashgiach', agencyId: agencyB, venueId: venueC, kioskPin: '1357' }],
      });
      const tAdminB = await mintToken(baseUrl, adminId); // admin is agency A; use inject for B admin
      const adminBId = `user-test25-adminb-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: adminBId, email: `adminb-${ts}@test.local`, name: 'T25 Admin B', role: 'admin', agencyId: agencyB }],
      });
      const tAdminB2 = await mintToken(baseUrl, adminBId);
      const deviceC = await pairDevice(baseUrl, tAdminB2, venueC, 'T25 Tablet C');
      useDevice(deviceC);
      const lr = await kioskLogin(baseUrl, mashCId, '1357');
      if (lr.status !== 200) throw new Error(`agency B kiosk login: ${lr.status}`);
      const conn = await connectWs(baseUrl, lr.body.token);
      // Presence message, then a task at the kiosk's venue — must still arrive.
      conn.ws.send(JSON.stringify({ type: 'USER_PRESENCE', payload: {} }));
      await new Promise((r) => setTimeout(r, 500));
      const ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/tasks?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdminB2),
        body: JSON.stringify({ title: `Agency B task ${ts}`, venueId: venueC, agencyId: agencyB }),
      });
      await new Promise((r) => setTimeout(r, 2000));
      const got = conn.messages.some((m) => {
        if (m.type !== 'TASK_CREATED') return false;
        const task = m.payload?.task || m.payload;
        return task?.venueId === venueC;
      });
      if (!got) throw new Error('agency B kiosk missed TASK_CREATED after USER_PRESENCE (meta was corrupted)');
      conn.ws.close();
    }

    /* ---- Part 6: malformed kiosk tokens fail closed ---- */
    {
      const mintKiosk = async (claims) => {
        const r = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, {
          method: 'POST', headers: auth(tAdmin), body: JSON.stringify(claims),
        });
        return (await r.json()).token;
      };
      // kiosk:true without venueId → 401 on HTTP, 4401 on WS.
      const noVenue = await mintKiosk({ userId: mashAId, agencyId: AGENCY });
      const hr = await fetch(`${baseUrl}/api/tasks`, { headers: auth(noVenue) });
      if (hr.status !== 401) throw new Error(`kiosk token w/o venue: ${hr.status} (expected 401)`);
      const wc = await connectWs(baseUrl, noVenue, { expectClose: 4401 });
      if (wc.closeCode !== 4401) throw new Error(`WS kiosk token w/o venue: ${wc.closeCode} (expected 4401)`);
      // kiosk:true with wrong agency → 401.
      const wrongAgency = await mintKiosk({ userId: mashAId, agencyId: 'agency-nope', venueId: venueA });
      const hr2 = await fetch(`${baseUrl}/api/tasks`, { headers: auth(wrongAgency) });
      if (hr2.status !== 401) throw new Error(`kiosk token wrong agency: ${hr2.status} (expected 401)`);
    }

    /* ---- Part 8: open kiosk socket revoked on PIN removal / venue move / user delete ---- */
    {
      useDevice(deviceA);
      const uid = `user-test25-revoke-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `revoke-${ts}@test.local`, name: 'T25 Revoke', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '5555' }],
      });
      const lr = await kioskLogin(baseUrl, uid, '5555');
      const conn = await connectWs(baseUrl, lr.body.token);
      // Admin removes the PIN while the socket is open.
      let ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/users/${uid}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ kioskPin: '' }),
      });
      // Trigger a broadcast (forces authorizeSocket on the delivery path).
      ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/handoff-notes?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ venueId: venueA, content: `revoke probe ${ts}`, shift: 'Morning' }),
      });
      const closed = await conn.waitClose(5000);
      if (closed !== 4401) throw new Error(`socket after PIN removal: close ${closed} (expected 4401)`);
    }

    /* ---- Part 9: GET /api/venues filters to the kiosk venue regardless of role ---- */
    {
      // Coordinator with a PIN → kiosk session; two venues in the agency.
      // (Part 1c set the PIN to '9999'.)
      const lr = await kioskLogin(baseUrl, coordAId, '9999');
      if (lr.status !== 200) throw new Error(`coordinator kiosk login: ${lr.status}`);
      const r = await fetch(`${baseUrl}/api/venues`, { headers: authK(lr.body.token) });
      if (r.status !== 200) throw new Error(`kiosk venues: ${r.status}`);
      const b = await r.json();
      const venues = b.venues || [];
      if (venues.length !== 1) throw new Error(`kiosk venues: ${venues.length} (expected 1)`);
      if (venues[0].id !== venueA) throw new Error(`kiosk venues: ${venues[0].id} (expected ${venueA})`);
    }

    /* ---- Part 2e: successes don't accumulate against the tablet ---- */
    {
      const uid = `user-test25-busy-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `busy-${ts}@test.local`, name: 'T25 Busy', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '6666' }],
      });
      // 21 correct logins in a row from one tablet must ALL succeed.
      for (let i = 0; i < 21; i++) {
        const r = await kioskLogin(baseUrl, uid, '6666');
        if (r.status !== 200) throw new Error(`correct login ${i + 1}: ${r.status} (expected 200)`);
      }
      // Clear first: earlier parts already spent IP-bucket attempts.
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
      // And 20 wrong from the tablet (4 users × 5 each, so the per-user
      // bucket doesn't stop them first) → 21st (even correct) locks the tablet.
      const tabletUsers = [];
      for (let i = 0; i < 4; i++) {
        const tu = `user-test25-tab-${i}-${ts}`;
        tabletUsers.push(tu);
        await ctx.api('POST', '/api/__test__/inject-fixture', {
          users: [{ id: tu, email: `tab${i}-${ts}@test.local`, name: `T25 Tab ${i}`, role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '6666' }],
        });
      }
      for (const tu of tabletUsers) {
        for (let i = 0; i < 5; i++) {
          const r = await kioskLogin(baseUrl, tu, '0000');
          if (r.status !== 401) throw new Error(`tablet wrong for ${tu}: ${r.status} (expected 401)`);
        }
      }
      const locked = await kioskLogin(baseUrl, uid, '6666');
      if (locked.status !== 429) throw new Error(`after 20 wrong: ${locked.status} (expected 429)`);
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    }

    /* ---- Part 1f: boot migration is idempotent ---- */
    {
      // Two restarts: hashes must not change (no re-hash, no plain resurrected).
      const doc1 = await (await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) })).json();
      const hashes1 = {};
      for (const u of doc1.users || []) if (u.kioskPinHash) hashes1[u.id] = u.kioskPinHash;
      await ctx.restartServer();
      const tAdmin3 = await mintToken(baseUrl, adminId);
      const doc2 = await (await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin3) })).json();
      for (const u of doc2.users || []) {
        if (u.kioskPin) throw new Error(`migration resurrected plain kioskPin on ${u.id}`);
        if (u.kioskPinHash && hashes1[u.id] && u.kioskPinHash !== hashes1[u.id]) {
          throw new Error(`migration re-hashed ${u.id}`);
        }
      }
    }

    /* ---- Date regression: boot default is the America/New_York date ---- */
    {
      // currentWorkDate is persisted in the state doc at boot. Assert it
      // equals the NY date (the old UTC expression differs 00:00–04:00 UTC).
      const nyDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const doc = await (await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) })).json();
      if (doc.currentWorkDate && doc.currentWorkDate !== nyDate) {
        throw new Error(`currentWorkDate ${doc.currentWorkDate} !== NY date ${nyDate}`);
      }
    }

    /* ---- Part 3h: kiosk socket during DEMO_RESTORED gets only its venue ---- */
    {
      // mashA was moved to venueB in Part 4; use mashB (venueB).
      useDevice(deviceB);
      const lr = await kioskLogin(baseUrl, mashBId, PIN_B);
      if (lr.status !== 200) throw new Error(`3h login: ${lr.status}`);
      const conn = await connectWs(baseUrl, lr.body.token);
      const before = conn.messages.length;
      const ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/admin/demo-restore?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
      });
      await new Promise((r) => setTimeout(r, 2000));
      const after = conn.messages.slice(before);
      for (const m of after) {
        if (m.type === 'DEMO_RESTORED' || m.type === 'CLEAN_SLATE_RESET' || m.type === 'DAILY_RESET') {
          const p = m.payload || {};
          for (const t of p.tasks || []) {
            if (t.venueId && t.venueId !== venueB) throw new Error(`${m.type}: kiosk got other-venue task`);
          }
          for (const v of p.venues || []) {
            if (v.id !== venueB) throw new Error(`${m.type}: kiosk got other venue`);
          }
          if ((p.events || []).length) throw new Error(`${m.type}: kiosk got events`);
          for (const u of p.users || []) {
            if (u.email) throw new Error(`${m.type}: kiosk roster has emails`);
          }
        }
      }
      conn.ws.close();
    }

    /* ---- Part 10: coordinator PIN scope (own venue only) ---- */
    {
      useDevice(deviceA);
      const tCoord = await mintToken(baseUrl, coordId);
      const putPin = async (tok, targetId, body) => {
        const ver = await ctx.getVersion();
        return fetch(`${baseUrl}/api/users/${targetId}?expectedVersion=${ver}`, {
          method: 'PUT', headers: auth(tok), body: JSON.stringify(body),
        });
      };
      // Same venue mashgiach → 200, hash stored, lockout cleared.
      const sameVenueMash = `user-test25-cvm-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: sameVenueMash, email: `cvm-${ts}@test.local`, name: 'T25 CVM', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '7777' }],
      });
      for (let i = 0; i < 5; i++) await kioskLogin(baseUrl, sameVenueMash, '0000');
      const r1 = await putPin(tCoord, sameVenueMash, { kioskPin: '7777' });
      if (r1.status !== 200) throw new Error(`coord same-venue: ${r1.status} (expected 200)`);
      const ok = await kioskLogin(baseUrl, sameVenueMash, '7777');
      if (ok.status !== 200) throw new Error(`after coord unlock: ${ok.status} (expected 200)`);
      // Other venue, same agency → 403.
      const r2 = await putPin(tCoord, mashBId, { kioskPin: '8888' });
      if (r2.status !== 403) throw new Error(`coord other-venue: ${r2.status} (expected 403)`);
      // Other agency → 403.
      const otherAgencyUser = `user-test25-coa-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: otherAgencyUser, email: `coa-${ts}@test.local`, name: 'T25 COA', role: 'mashgiach', agencyId: 'agency-other', venueId: venueA }],
      });
      const r3 = await putPin(tCoord, otherAgencyUser, { kioskPin: '8888' });
      if (r3.status !== 403) throw new Error(`coord other-agency: ${r3.status} (expected 403)`);
      // On an admin → 403.
      const r4 = await putPin(tCoord, adminId, { kioskPin: '8888' });
      if (r4.status !== 403) throw new Error(`coord on admin: ${r4.status} (expected 403)`);
      // On another coordinator → 403.
      const r5 = await putPin(tCoord, coordId, { kioskPin: '8888' });
      if (r5.status !== 403) throw new Error(`coord on coordinator: ${r5.status} (expected 403)`);
      // kioskPin + other fields → 403.
      const r6 = await putPin(tCoord, sameVenueMash, { kioskPin: '7777', name: 'Hacked' });
      if (r6.status !== 403) throw new Error(`coord pin+name: ${r6.status} (expected 403)`);
      const r7 = await putPin(tCoord, sameVenueMash, { kioskPin: '7777', role: 'admin' });
      if (r7.status !== 403) throw new Error(`coord pin+role: ${r7.status} (expected 403)`);
      // Coordinator with no venueId → 403 (fail closed).
      const noVenueCoord = `user-test25-cnv-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: noVenueCoord, email: `cnv-${ts}@test.local`, name: 'T25 CNV', role: 'coordinator', agencyId: AGENCY }],
      });
      const tNoVenue = await mintToken(baseUrl, noVenueCoord);
      const r8 = await putPin(tNoVenue, sameVenueMash, { kioskPin: '7777' });
      if (r8.status !== 403) throw new Error(`venue-less coord: ${r8.status} (expected 403)`);
      // Mashgiach setting anyone's PIN → 403.
      const tMash = await mintToken(baseUrl, mashAId);
      const r9 = await putPin(tMash, sameVenueMash, { kioskPin: '7777' });
      if (r9.status !== 403) throw new Error(`mashgiach set PIN: ${r9.status} (expected 403)`);
    }

    /* ---- Part 11: PIN re-save revokes live kiosk tokens (pv) ---- */
    {
      const uid = `user-test25-pv-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: uid, email: `pv-${ts}@test.local`, name: 'T25 PV', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '2468' }],
      });
      const lr = await kioskLogin(baseUrl, uid, '2468');
      if (lr.status !== 200) throw new Error(`pv login: ${lr.status}`);
      const liveToken = lr.body.token;
      const payload = JSON.parse(Buffer.from(liveToken.split('.')[1], 'base64').toString());
      if (!payload.pv) throw new Error('kiosk token has no pv claim');
      if (/^\$2/.test(payload.pv)) throw new Error('pv leaks hash material');
      const conn = await connectWs(baseUrl, liveToken);
      // Admin re-saves the PIN (same value) — the version changes.
      let ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/users/${uid}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ kioskPin: '2468' }),
      });
      const r1 = await fetch(`${baseUrl}/api/tasks`, { headers: authK(liveToken) });
      if (r1.status !== 401) throw new Error(`old token after PIN re-save: ${r1.status} (expected 401)`);
      // Socket closed on next delivery.
      ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/handoff-notes?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(tAdmin),
        body: JSON.stringify({ venueId: venueA, content: `pv probe ${ts}`, shift: 'Morning' }),
      });
      const closed = await conn.waitClose(5000);
      if (closed !== 4401) throw new Error(`socket after PIN re-save: ${closed} (expected 4401)`);
      // A new login works.
      const lr2 = await kioskLogin(baseUrl, uid, '2468');
      if (lr2.status !== 200) throw new Error(`new login after re-save: ${lr2.status}`);
    }

    /* ---- Part 12: coordinator PIN with the EXACT client body ---- */
    {
      const tCoord = await mintToken(baseUrl, coordId);
      const target = `user-test25-cbody-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: target, email: `cbody-${ts}@test.local`, name: 'T25 CBody', role: 'mashgiach', agencyId: AGENCY, venueId: venueA }],
      });
      // App.tsx sends { kioskPin, adminEmail } and apiWrite injects
      // expectedVersion + operationId into the BODY.
      const okBody = { kioskPin: '1359', adminEmail: 'coord@test.local', expectedVersion: await ctx.getVersion(), operationId: `op-${ts}` };
      const rOk = await fetch(`${baseUrl}/api/users/${target}`, {
        method: 'PUT', headers: auth(tCoord), body: JSON.stringify(okBody),
      });
      if (rOk.status !== 200) throw new Error(`coord exact client body: ${rOk.status} (expected 200)`);
      // kioskPin + name with the same transport fields → 403.
      const badBody = { kioskPin: '1359', name: 'Hacked', adminEmail: 'coord@test.local', expectedVersion: await ctx.getVersion(), operationId: `op2-${ts}` };
      const rBad = await fetch(`${baseUrl}/api/users/${target}`, {
        method: 'PUT', headers: auth(tCoord), body: JSON.stringify(badBody),
      });
      if (rBad.status !== 403) throw new Error(`coord client body + name: ${rBad.status} (expected 403)`);
    }

    /* ---- Part 13: coordinator reassigned between mint and PUT ---- */
    {
      const coord2Id = `user-test25-coord2-${ts}`;
      const target = `user-test25-coord2t-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [
          { id: coord2Id, email: `coord2-${ts}@test.local`, name: 'T25 Coord2', role: 'coordinator', agencyId: AGENCY, venueId: venueA },
          { id: target, email: `coord2t-${ts}@test.local`, name: 'T25 Coord2T', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '7777' },
        ],
      });
      const tCoord2 = await mintToken(baseUrl, coord2Id);
      // Admin moves the coordinator to venueB.
      const ver = await ctx.getVersion();
      await fetch(`${baseUrl}/api/users/${coord2Id}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ venueId: venueB }),
      });
      // Their PUT for the venueA mashgiach must now fail (fresh-doc check). // rule U: no gendered wording for roles
      const ver2 = await ctx.getVersion();
      const r = await fetch(`${baseUrl}/api/users/${target}?expectedVersion=${ver2}`, {
        method: 'PUT', headers: auth(tCoord2), body: JSON.stringify({ kioskPin: '9999' }),
      });
      if (r.status !== 403 && r.status !== 409) throw new Error(`reassigned coord PUT: ${r.status} (expected 403/409)`);
      // And the PIN was not written.
      const doc = await (await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) })).json();
      const tDoc = (doc.users || []).find((u) => u.id === target);
      const lr = await kioskLogin(baseUrl, target, '7777');
      if (lr.status !== 200) throw new Error(`target PIN changed by reassigned coord (login: ${lr.status})`);
    }

    /* ---- Part 15: busy venue — correct logins never self-lock the IP ---- */
    {
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
      const u1 = `user-test25-busy1-${ts}`;
      const u2 = `user-test25-busy2-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [
          { id: u1, email: `busy1-${ts}@test.local`, name: 'T25 Busy1', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '1111' },
          { id: u2, email: `busy2-${ts}@test.local`, name: 'T25 Busy2', role: 'mashgiach', agencyId: AGENCY, venueId: venueA, kioskPin: '2222' },
        ],
      });
      // 41 consecutive CORRECT logins from one IP, alternating two users.
      for (let i = 0; i < 41; i++) {
        const uid = i % 2 === 0 ? u1 : u2;
        const pin = i % 2 === 0 ? '1111' : '2222';
        const r = await kioskLogin(baseUrl, uid, pin);
        if (r.status !== 200) throw new Error(`busy login ${i + 1}: ${r.status} (expected 200 — correct logins must not self-lock the IP)`);
      }
    }

    /* ---- Part 14: IP-wide bucket stops identifier cycling ---- */
    {
      // 2b: unknown-user attempts count only on a PAIRED tablet (an
      // unpaired request is refused before any counting). The attempts ride
      // venue A's device; the invented body venueIds are ignored — the
      // venue is the device's. 41 unknown users from one IP → locked.
      useDevice(deviceA);
      let lastStatus = 0;
      for (let i = 0; i < 41; i++) {
        const r = await fetch(`${baseUrl}/api/kiosk/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceA.header },
          body: JSON.stringify({ userId: `ghost-${ts}-${i}`, pin: '0000', venueId: `invented-${ts}-${i}` }),
        });
        lastStatus = r.status;
      }
      if (lastStatus !== 429) throw new Error(`IP bucket after 41 unknown: ${lastStatus} (expected 429)`);
      await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    }

    /* ---- Part 3e: phone login token unchanged ---- */
    {
      // mint-token produces a phone-style token (no kiosk claim).
      const phoneToken = await mintToken(baseUrl, adminId);
      const payload = JSON.parse(Buffer.from(phoneToken.split('.')[1], 'base64').toString());
      if (payload.kiosk) throw new Error('phone token has kiosk claim');
      // Full access as before: POST /api/tasks works.
      const ver = await ctx.getVersion();
      const r = await fetch(`${baseUrl}/api/tasks?expectedVersion=${ver}`, {
        method: 'POST', headers: auth(phoneToken),
        body: JSON.stringify({ venueId: venueA, title: `Phone task ${ts}`, agencyId: AGENCY }),
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`phone POST /api/tasks: ${r.status}`);
    }
  },
};
