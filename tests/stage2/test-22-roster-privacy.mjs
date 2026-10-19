/**
 * Test 22: Roster privacy — per-recipient agency filtering (PR 1).
 *
 * Every roster payload the server sends must be scoped to the recipient's own
 * agency, with role-appropriate fields:
 *   - USERS_UPDATED / CLEAN_SLATE_RESET / DEMO_RESTORED broadcasts: each socket
 *     gets only its own agency's users (previously the whole platform roster).
 *   - Only admin/coordinator see contact emails; other roles get names/roles/
 *     venues (no emails) — assignment pickers are privileged-only flows.
 *   - GET /api/agencies: caller's own agency only, public fields (no adminEmail,
 *     no counts, no cross-agency listing).
 *   - GET /api/users: scoped from the verified session token, never from a
 *     client-supplied userEmail query param.
 *
 * Method: real WebSocket clients (native Node WebSocket) for an agency-hkc
 * admin, an agency-B admin and an agency-B mashgiach; trigger USERS_UPDATED
 * by creating a user in agency B; assert per-recipient scoping of every
 * roster payload, plus the HTTP endpoints.
 */
import { createHmac } from 'node:crypto';

const AGENCY_B = 'agency-test22-b';

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

function connectWs(baseUrl, token, label) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
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
    ws.onclose = (ev) => {
      clearTimeout(timer);
      reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
    };
  });
}

function waitForType(messages, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const hit = messages.find((m) => m.type === type);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${type}`));
      setTimeout(check, 200);
    };
    check();
  });
}

/** Assert a roster payload: only the expected agency, no secrets, role-trimmed emails. */
function assertRoster(users, agencyId, expectEmails, label) {
  if (!Array.isArray(users)) throw new Error(`${label}: users is not an array`);
  for (const u of users) {
    if ((u.agencyId || 'agency-hkc') !== agencyId) {
      throw new Error(`${label}: roster leaked another agency's user: ${u.id} (${u.agencyId})`);
    }
    if ('password' in u || 'kioskPin' in u) {
      throw new Error(`${label}: roster leaked a secret field for ${u.id}`);
    }
    const hasEmail = 'email' in u && u.email;
    if (expectEmails && !hasEmail) {
      throw new Error(`${label}: privileged role should see emails (${u.id})`);
    }
    if (!expectEmails && hasEmail) {
      throw new Error(`${label}: non-privileged role should NOT see emails (${u.id})`);
    }
  }
}

export default {
  name: 'Test 22: Roster privacy — per-recipient agency filtering',
  whatItProves:
    'Roster payloads (USERS_UPDATED/INITIAL_STATE broadcasts, /api/agencies, /api/users) are scoped to the recipient\'s own agency with role-appropriate fields. No cross-agency roster, no admin emails, no secret fields, and the userEmail query param no longer scopes the roster.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const adminBId = `user-test22-adminb-${ts}`;
    const staffBId = `user-test22-staffb-${ts}`;
    const adminBEmail = `test22-adminb-${ts}@test.local`;
    const staffBEmail = `test22-staffb-${ts}@test.local`;

    // --- 1. Fixtures: agency B with an admin and a mashgiach ---
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY_B, name: 'Test Agency B 22' }],
      venues: [{ id: `venue-test22-b-${ts}`, name: `Test22 Venue B ${ts}`, agencyId: AGENCY_B }],
      users: [
        { id: adminBId, email: adminBEmail, name: 'Test22 Admin B', role: 'admin', agencyId: AGENCY_B },
        { id: staffBId, email: staffBEmail, name: 'Test22 Staff B', role: 'mashgiach', agencyId: AGENCY_B },
      ],
    });
    if (inj.status !== 200) throw new Error(`fixture inject failed: ${inj.status} ${JSON.stringify(inj.json)}`);

    const doc = await ctx.getDoc();
    const jwtSecret = doc.jwtSecret || process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('no jwtSecret available to mint tokens');
    const tokenAdminB = mintToken(adminBId, jwtSecret);
    const tokenStaffB = mintToken(staffBId, jwtSecret);
    const authB = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // --- 2. WS clients: hkc admin (ctx token), agency-B admin, agency-B mashgiach ---
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'kenan@hartfordkashrut.org', password: 'stage2-test-password' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) throw new Error('hkc admin login failed');

    const connHkc = await connectWs(baseUrl, loginJson.token);
    const connAdminB = await connectWs(baseUrl, tokenAdminB);
    const connStaffB = await connectWs(baseUrl, tokenStaffB);

    // --- 3. INITIAL_STATE rosters are agency-scoped + role-trimmed ---
    const initB = connStaffB.messages.find((m) => m.type === 'INITIAL_STATE');
    assertRoster(initB.payload.users, AGENCY_B, false, 'INITIAL_STATE (agency-B mashgiach)');
    const initAdminB = connAdminB.messages.find((m) => m.type === 'INITIAL_STATE');
    assertRoster(initAdminB.payload.users, AGENCY_B, true, 'INITIAL_STATE (agency-B admin)');
    const initHkc = connHkc.messages.find((m) => m.type === 'INITIAL_STATE');
    for (const u of initHkc.payload.users) {
      if ((u.agencyId || 'agency-hkc') === AGENCY_B) {
        throw new Error('INITIAL_STATE (hkc admin): leaked agency-B user');
      }
    }

    // Clear buffers — from here we only care about the triggered broadcast.
    connHkc.messages.length = 0;
    connAdminB.messages.length = 0;
    connStaffB.messages.length = 0;

    // --- 4. Trigger USERS_UPDATED in agency B (create user as agency-B admin) ---
    const cr = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: authB(tokenAdminB),
      body: JSON.stringify({
        email: `test22-new-${ts}@test.local`,
        name: 'Test22 New B',
        role: 'mashgiach',
        password: 'test-password-123',
      }),
    });
    if (cr.status !== 200 && cr.status !== 201) {
      throw new Error(`agency-B user create failed: ${cr.status} ${JSON.stringify(await cr.json())}`);
    }

    const msgAdminB = await waitForType(connAdminB.messages, 'USERS_UPDATED');
    const msgStaffB = await waitForType(connStaffB.messages, 'USERS_UPDATED');
    assertRoster(msgAdminB.payload.users, AGENCY_B, true, 'USERS_UPDATED (agency-B admin)');
    assertRoster(msgStaffB.payload.users, AGENCY_B, false, 'USERS_UPDATED (agency-B mashgiach)');
    if (!msgAdminB.payload.users.some((u) => u.email === `test22-new-${ts}@test.local`)) {
      throw new Error('USERS_UPDATED (agency-B admin): new user missing from roster');
    }

    // hkc admin must NOT receive agency B's USERS_UPDATED at all.
    await new Promise((r) => setTimeout(r, 1500));
    if (connHkc.messages.some((m) => m.type === 'USERS_UPDATED')) {
      throw new Error('hkc admin received USERS_UPDATED for agency B');
    }

    // --- 5. GET /api/agencies: own agency only, no adminEmail, no counts ---
    const ag = await fetch(`${baseUrl}/api/agencies`, { headers: authB(tokenAdminB) });
    const agJson = await ag.json();
    if (ag.status !== 200) throw new Error(`GET /api/agencies failed: ${ag.status}`);
    if (!Array.isArray(agJson.agencies) || agJson.agencies.length !== 1) {
      throw new Error(`GET /api/agencies: expected exactly 1 agency, got ${JSON.stringify(agJson).slice(0, 200)}`);
    }
    const only = agJson.agencies[0];
    if (only.id !== AGENCY_B) throw new Error('GET /api/agencies: returned the wrong agency');
    for (const banned of ['adminEmail', 'venuesCount', 'workersCount']) {
      if (banned in only) throw new Error(`GET /api/agencies: leaked ${banned}`);
    }

    // --- 6. GET /api/users: token-scoped, role-trimmed; userEmail param ignored ---
    const us = await fetch(`${baseUrl}/api/users`, { headers: authB(tokenStaffB) });
    const usJson = await us.json();
    assertRoster(usJson.users, AGENCY_B, false, 'GET /api/users (agency-B mashgiach)');

    const usSpoof = await fetch(
      `${baseUrl}/api/users?userEmail=kenan@hartfordkashrut.org`,
      { headers: authB(tokenStaffB) }
    );
    const usSpoofJson = await usSpoof.json();
    for (const u of usSpoofJson.users || []) {
      if ((u.agencyId || 'agency-hkc') !== AGENCY_B) {
        throw new Error('GET /api/users: userEmail query param leaked another agency\'s roster');
      }
    }

    connHkc.ws.close();
    connAdminB.ws.close();
    connStaffB.ws.close();

    return 'roster payloads agency-scoped per recipient; emails admin/coordinator-only; /api/agencies stripped+scoped; userEmail param ignored';
  },
};
