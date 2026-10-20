/**
 * Test 31: Kiosk roster load must not bump the version behind the tablet's
 * back (the "data changed, refresh" bounce right after a PIN sign-in).
 *
 * Bug on main (found by the D3a browser test, reproduced through the API):
 * GET /api/kiosk/device touches the device's lastSeenAt (once per 10 min)
 * with a fire-and-forget commit. That commit bumps the document version
 * AFTER the response — the X-State-Version header already went out with
 * the old version, the touch is not broadcast, and it retries behind the
 * sign-in and the first task writes, so it can land seconds later. The
 * tablet keeps sending the version it last saw → 409 VERSION_CONFLICT
 * ("data changed, refresh") on a tap right after sign-in.
 *
 * Fix: the touch is awaited, so the roster response's header carries the
 * bumped version. The conflict check itself is unchanged.
 *
 * Request shapes are the CLIENT's (rule AA): the roster/login travel with
 * X-Kiosk-Device, task writes carry expectedVersion + operationId like
 * apiWrite, and the client's version is the highest X-State-Version it has
 * seen (observeVersion). Every negative has a positive twin (rule G).
 *
 * Parts:
 *  1 roster load: the version the server settles on after the response
 *    equals the version the response header carried (main: header N,
 *    server N+1 a moment later → FAIL). The touch itself still lands
 *    (lastSeenAt set on the device).
 *  2 the user's flow: roster → PIN sign-in → GET tasks → two task writes
 *    with the tracked version → 200, 200 (the tablet's own taps never
 *    bounce). The version moves exactly as the headers say.
 *  3 twin: a write that really is stale (the version from BEFORE sign-in)
 *    still answers 409 VERSION_CONFLICT — the guard is intact.
 *  4 a second roster load inside the 10-minute window does not bump the
 *    version at all (header unchanged, settled version unchanged).
 */

const AGENCY = 'agency-test31';
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

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const versionOf = (res) => Number(res.headers.get('x-state-version'));

export default {
  name: 'Test 31: Kiosk roster load does not bump the version behind the tablet',
  whatItProves:
    'GET /api/kiosk/device reports the version its lastSeenAt touch produced, so the first task writes after a kiosk PIN sign-in never answer a false 409; a truly stale write still answers 409.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueId = `venue-test31-${ts}`;
    const adminId = `user-test31-admin-${ts}`;
    const mashId = `user-test31-mash-${ts}`;
    const taskId = `task-test31-${ts}`;
    const PIN = '2468';

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test31 Agency' }],
      venues: [{ id: venueId, name: `T31 Venue ${ts}`, agencyId: AGENCY }],
      users: [
        { id: adminId, email: `admin31-${ts}@test.local`, name: 'T31 Admin', role: 'admin', agencyId: AGENCY },
        { id: mashId, email: `mash31-${ts}@test.local`, name: 'T31 Mash', role: 'mashgiach', agencyId: AGENCY, venueId, kioskPin: PIN },
      ],
      tasks: [
        { id: taskId, agencyId: AGENCY, venueId, title: `Task 31 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const tAdmin = await mintToken(baseUrl, adminId);
    // Earlier tests (and earlier runs) spend the pairing-start limit; start clean (as test-27 does).
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);

    // Pair a tablet the way the tablet + phone do (start → pair → claim).
    const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
    const { pairingId, code, deviceSecret } = await start.json();
    const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
      method: 'POST', headers: auth(tAdmin), body: JSON.stringify({ code, venueId }),
    });
    if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
    const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, {
      headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` },
    });
    const claimed = await claim.json().catch(() => ({}));
    if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
    const deviceId = claimed.device.id;
    const deviceHeader = `${deviceId}.${deviceSecret}`;

    // The server's version once nothing is in flight: poll until it holds
    // still for a full second (a fire-and-forget commit lands within that).
    const settledVersion = async () => {
      let last = await ctx.getVersion();
      let stableSince = Date.now();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(100);
        const v = await ctx.getVersion();
        if (v !== last) { last = v; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 1000) break;
      }
      return last;
    };

    // --- 1. Roster load: the header must carry the version the touch produced ---
    const before = await settledVersion();
    const roster = await fetch(`${baseUrl}/api/kiosk/device`, { headers: { 'X-Kiosk-Device': deviceHeader } });
    if (roster.status !== 200) throw new Error(`kiosk/device: ${roster.status}`);
    const rosterBody = await roster.json();
    if (!Array.isArray(rosterBody.users) || !rosterBody.users.some((u) => u.id === mashId)) {
      throw new Error('roster does not list the PIN user');
    }
    const rosterVersion = versionOf(roster);
    const after = await settledVersion();
    if (after !== rosterVersion) {
      throw new Error(
        `roster response said version ${rosterVersion} but the server settled on ${after} afterwards ` +
        `(a version bump landed behind the tablet's back; before the load: ${before})`
      );
    }
    if (after !== before + 1) {
      throw new Error(`expected exactly one version bump for the lastSeenAt touch (${before} → ${before + 1}), got ${after}`);
    }
    const devices = await fetch(`${baseUrl}/api/kiosk/devices`, { headers: auth(tAdmin) });
    const devList = (await devices.json().catch(() => ({}))).devices || [];
    const mine = devList.find((d) => d.id === deviceId);
    if (!mine || !mine.lastSeenAt) throw new Error('lastSeenAt was not recorded by the roster load');

    // --- 2. The user's flow: the tablet's own taps never bounce ---
    let known = rosterVersion;
    const observe = (res) => { const v = versionOf(res); if (Number.isFinite(v) && v > known) known = v; return v; };
    const login = await fetch(`${baseUrl}/api/kiosk/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader },
      body: JSON.stringify({ userId: mashId, pin: PIN }),
    });
    const loginBody = await login.json().catch(() => ({}));
    if (login.status !== 200 || !loginBody.token) throw new Error(`kiosk login: ${login.status}`);
    observe(login);
    const kioskAuth = { ...auth(loginBody.token), 'X-Kiosk-Device': deviceHeader };
    const tasksRes = await fetch(`${baseUrl}/api/tasks`, { headers: kioskAuth });
    if (tasksRes.status !== 200) throw new Error(`tasks: ${tasksRes.status}`);
    observe(tasksRes);
    const staleVersion = before; // what a screen rendered before the sign-in would send

    const tap = async (isCompleted) => {
      const sent = known;
      const r = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: 'PUT', headers: kioskAuth,
        body: JSON.stringify({
          currentStatus: isCompleted ? 'completed' : 'pending', isCompleted,
          userEmail: `mash31-${ts}@test.local`, userName: 'T31 Mash',
          expectedVersion: sent, operationId: crypto.randomUUID(),
        }),
      });
      const body = await r.json().catch(() => ({}));
      observe(r);
      return { status: r.status, body, sent };
    };
    const tap1 = await tap(true);
    if (tap1.status !== 200) {
      throw new Error(`first tap after sign-in bounced: ${tap1.status} ${tap1.body?.code || ''} (sent ${tap1.sent}, server ${tap1.body?.currentVersion})`);
    }
    const tap2 = await tap(false);
    if (tap2.status !== 200) {
      throw new Error(`second tap after sign-in bounced: ${tap2.status} ${tap2.body?.code || ''} (sent ${tap2.sent}, server ${tap2.body?.currentVersion})`);
    }
    const afterTaps = await settledVersion();
    if (afterTaps !== known) throw new Error(`server settled on ${afterTaps} but the tablet last heard ${known}`);

    // --- 3. Twin: a genuinely stale write still answers 409 ---
    const stale = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PUT', headers: kioskAuth,
      body: JSON.stringify({
        currentStatus: 'completed', isCompleted: true,
        userEmail: `mash31-${ts}@test.local`, userName: 'T31 Mash',
        expectedVersion: staleVersion, operationId: crypto.randomUUID(),
      }),
    });
    const staleBody = await stale.json().catch(() => ({}));
    if (stale.status !== 409 || staleBody.code !== 'VERSION_CONFLICT') {
      throw new Error(`stale write (version ${staleVersion}) should answer 409 VERSION_CONFLICT, got ${stale.status} ${staleBody.code || ''}`);
    }
    const durable = (await ctx.getDoc()).tasks.find((t) => t.id === taskId);
    if (!durable || durable.isCompleted !== false) throw new Error('the stale write changed the task');

    // --- 4. A second roster load inside the 10-minute window writes nothing ---
    const v4 = await settledVersion();
    const roster2 = await fetch(`${baseUrl}/api/kiosk/device`, { headers: { 'X-Kiosk-Device': deviceHeader } });
    if (roster2.status !== 200) throw new Error(`kiosk/device (2nd): ${roster2.status}`);
    const v4h = versionOf(roster2);
    const v4after = await settledVersion();
    if (v4h !== v4 || v4after !== v4) throw new Error(`second roster load moved the version (${v4} → header ${v4h}, settled ${v4after})`);

    // cleanup
    await fetch(`${baseUrl}/api/kiosk/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', headers: auth(tAdmin) }).catch(() => {});
    const vDel = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${taskId}`, { expectedVersion: vDel });

    return (
      `roster load v${before}→v${after} reported in its header; sign-in + 2 taps 200/200 (v${rosterVersion}→v${known}); ` +
      `stale v${staleVersion} → 409 VERSION_CONFLICT; repeat roster load no bump (v${v4})`
    );
  },
};
