/**
 * Test 16: Scheduled daily-reset broadcast is per-agency scoped.
 *
 * The scheduled (midnight) reset is a system operation across ALL agencies.
 * Each agency's WebSocket clients must receive ONLY their own agency's
 * snapshot/tasks/history — agency B must never receive agency A's history
 * or notes (round 4 fix: the broadcast previously sent the first agency's
 * snapshot to every agency).
 *
 * Method: real WebSocket clients (native Node WebSocket) for an agency-hkc
 * admin and an agency-b user; trigger the exact scheduled code path via the
 * test-only /api/__test__/scheduled-reset endpoint; assert per-agency
 * scoping of the DAILY_RESET payloads.
 */
import { createHmac } from 'node:crypto';

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';
const AGENCY_B = 'agency-test-b';

function base64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a session JWT for a user ID using the server's JWT secret. */
function mintToken(userId, jwtSecret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + 30 * 24 * 3600 }));
  const sig = base64url(createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {}
      // Resolve on INITIAL_STATE (proves auth + agency scoping worked).
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WS error: ${e?.message || 'unknown'}`));
    };
  });
}

function waitForDailyReset(messages, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const hit = messages.find((m) => m.type === 'DAILY_RESET');
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for DAILY_RESET'));
      setTimeout(check, 200);
    };
    check();
  });
}

export default {
  name: 'Test 16: Scheduled reset broadcast per-agency scoping',
  whatItProves:
    'The scheduled (unscoped) daily reset broadcasts each agency ONLY its own snapshots/tasks/history over WebSocket. Agency B never receives agency A data.',

  async run(baseUrl, ctx) {
    const ts = Date.now();

    // --- 1. Fixtures: agency B (agency, venue, task, user) ---
    const venueBId = `venue-test16-b-${ts}`;
    const taskBId = `task-test16-b-${ts}`;
    const userBId = `user-test16-b-${ts}`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY_B, name: 'Test Agency B' }],
      venues: [{ id: venueBId, name: `Test16 Venue B ${ts}`, agencyId: AGENCY_B }],
      tasks: [{
        id: taskBId,
        venueId: venueBId,
        agencyId: AGENCY_B,
        title: `Test16 Task B ${ts}`,
        isCompleted: true,
        notes: 'agency-b secret notes — must never leak to agency-hkc',
        currentStatus: 'done',
      }],
      // The agency-B user needs a venue (rule T: non-admins with no venue get
      // nothing). The fixture's intent is agency scoping, not venue scoping.
      users: [{ id: userBId, email: `test16-b-${ts}@test.local`, name: 'Test16 B', role: 'mashgiach', agencyId: AGENCY_B, venueId: venueBId }],
    });
    if (inj.status !== 200) throw new Error(`fixture inject failed: ${inj.status} ${JSON.stringify(inj.json)}`);

    // --- 2. Agency-hkc venue + task (via the normal API as admin) ---
    const vr = await ctx.api('POST', '/api/venues', { name: `Test16 Venue HKC ${ts}` });
    if (vr.status !== 201 && vr.status !== 200) throw new Error(`venue create failed: ${vr.status}`);
    const venueHkcId = vr.json.venue.id;
    const tr = await ctx.api('POST', '/api/tasks', {
      venueId: venueHkcId,
      title: `Test16 Task HKC ${ts}`,
      createdByEmail: ADMIN_EMAIL,
    });
    if (tr.status !== 201 && tr.status !== 200) throw new Error(`task create failed: ${tr.status}`);
    const taskHkcId = (tr.json.task || tr.json).id;
    const vDone = await ctx.getVersion();
    const done = await ctx.api('PUT', `/api/tasks/${taskHkcId}`, {
      isCompleted: true,
      notes: 'agency-hkc secret notes — must never leak to agency-b',
      userEmail: ADMIN_EMAIL,
      expectedVersion: vDone,
    });
    if (done.status !== 200) throw new Error(`completing hkc task failed: ${done.status}`);

    // --- 3. WebSocket clients: admin (agency-hkc) + user B (agency-b) ---
    const doc = await ctx.getDoc();
    const jwtSecret = doc.jwtSecret || process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('no jwtSecret available to mint WS token');

    // Admin token: login to get a real one.
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'stage2-test-password' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) throw new Error('admin login failed');
    const tokenB = mintToken(userBId, jwtSecret);

    const connA = await connectWs(baseUrl, loginJson.token);
    const connB = await connectWs(baseUrl, tokenB);
    // Clear INITIAL_STATE etc. — we only care about the reset broadcast.
    connA.messages.length = 0;
    connB.messages.length = 0;

    // --- 4. Trigger the exact scheduled-midnight code path ---
    const sr = await ctx.api('POST', '/api/__test__/scheduled-reset', {});
    if (sr.status !== 200) throw new Error(`scheduled reset failed: ${sr.status} ${JSON.stringify(sr.json)}`);

    // --- 5. Both clients must receive DAILY_RESET; assert scoping ---
    const msgA = await waitForDailyReset(connA.messages);
    const msgB = await waitForDailyReset(connB.messages);

    const assertScoped = (msg, agencyId, label) => {
      const p = msg.payload || {};
      for (const s of p.snapshots || []) {
        if ((s.agencyId || 'agency-hkc') !== agencyId) {
          throw new Error(`${label}: received snapshot for wrong agency: ${JSON.stringify(s).slice(0, 200)}`);
        }
      }
      for (const t of p.tasks || []) {
        if ((t.agencyId || 'agency-hkc') !== agencyId) {
          throw new Error(`${label}: received task for wrong agency: ${t.id}`);
        }
      }
      for (const h of p.historyLogs || []) {
        if ((h.agencyId || 'agency-hkc') !== agencyId) {
          throw new Error(`${label}: received history for wrong agency: ${h.id}`);
        }
      }
      // No cross-agency notes leakage (the actual secret content).
      const blob = JSON.stringify(p);
      const otherNotes = agencyId === AGENCY_B ? 'agency-hkc secret notes' : 'agency-b secret notes';
      if (blob.includes(otherNotes)) {
        throw new Error(`${label}: leaked the other agency's notes content!`);
      }
      if ((p.snapshots || []).length === 0) {
        throw new Error(`${label}: received no snapshots (expected at least one for its agency)`);
      }
    };

    assertScoped(msgA, 'agency-hkc', 'agency-hkc client');
    assertScoped(msgB, AGENCY_B, 'agency-b client');

    connA.ws.close();
    connB.ws.close();

    // --- 6. Cleanup (hkc-side only; agency-b fixtures are namespaced) ---
    const vDel1 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${taskHkcId}`, { expectedVersion: vDel1 });
    const vDel2 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/venues/${venueHkcId}`, { expectedVersion: vDel2 });

    return 'scheduled reset broadcast scoped: hkc client got only hkc snapshots, agency-b client got only agency-b snapshots, no notes leakage';
  },
};
