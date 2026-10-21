/**
 * Test 22: Roster privacy — per-recipient agency filtering (PR 1).
 *
 * Every roster payload the server sends must be scoped to the recipient's own
 * agency, with recipient-appropriate fields:
 *   - INITIAL_STATE / USERS_UPDATED (create/update/delete) / CLEAN_SLATE_RESET /
 *     DEMO_RESTORED broadcasts: each socket gets only its own agency's users
 *     (previously the whole platform roster).
 *   - Contact emails are visible only to recipients who can assign tasks
 *     (admin, coordinator unless explicitly revoked, or granted canAssignTasks —
 *     mirroring the client's canUserAssignTasks); everyone else gets
 *     names/roles/venues. Unknown/deleted recipients fail closed (no emails).
 *   - No socket of another agency — and no unregistered (agency-less) socket —
 *     receives another agency's payload at all.
 *   - GET /api/agencies: caller's own agency only, public fields (no adminEmail,
 *     no counts, no cross-agency listing).
 *   - GET /api/users: scoped from the verified session token, never from a
 *     client-supplied userEmail query param.
 *   - POST /api/admin/clean-slate HTTP (restore-demo is retired since 8i: 410)
 *     responses: scoped to the caller's agency.
 *
 * Method: real WebSocket clients (native Node WebSocket) for an agency-hkc
 * admin, an agency-B admin, an agency-B mashgiach, an agency-B mashgiach with
 * canAssignTasks, and an agency-less user; trigger each broadcast and assert
 * per-recipient scoping.
 */

const AGENCY_B = 'agency-test22-b';

/** Mint a session JWT server-side (test-only endpoint). Never reads the
 * signing secret from the doc — Test 18's restore cycle strips jwtSecret
 * by design, so the doc has none from Test 18 onward. */
async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) {
    throw new Error(`mint-token failed for ${userId}: ${res.status}`);
  }
  const { token } = await res.json();
  if (!token) throw new Error(`mint-token returned no token for ${userId}`);
  return token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const conn = { ws, messages, closeCode: null, closed: false };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {}
      // Resolve on INITIAL_STATE (proves auth + agency scoping worked).
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve(conn);
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WS error: ${e?.message || 'unknown'}`));
    };
    ws.onclose = (ev) => {
      conn.closed = true;
      conn.closeCode = ev.code;
      clearTimeout(timer);
      // Only reject if we never got INITIAL_STATE (auth failure path).
      if (!messages.some((m) => m.type === 'INITIAL_STATE')) {
        reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
      }
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

/** Assert a roster payload: only the expected agency, no secrets, recipient-trimmed emails. */
function assertRoster(users, agencyId, expectEmails, label) {
  if (!Array.isArray(users)) throw new Error(`${label}: users is not an array`);
  for (const u of users) {
    if ((u.agencyId || 'agency-hkc') !== agencyId) {
      throw new Error(`${label}: roster leaked another agency's user: ${u.id} (${u.agencyId})`);
    }
    if ('password' in u || 'kioskPin' in u || 'passwordHash' in u || 'kioskPinHash' in u) {
      throw new Error(`${label}: roster leaked a secret field for ${u.id}`);
    }
    const hasEmail = 'email' in u && !!u.email;
    if (expectEmails && !hasEmail) {
      throw new Error(`${label}: recipient who can assign should see emails (${u.id})`);
    }
    if (!expectEmails && hasEmail) {
      throw new Error(`${label}: recipient who cannot assign should NOT see emails (${u.id})`);
    }
  }
}

/** Assert a broadcast's venues/tasks/events arrays are agency-scoped. */
function assertAgencyScopedArrays(payload, agencyId, label) {
  for (const [key, arr] of [['venues', payload.venues], ['tasks', payload.tasks], ['events', payload.events]]) {
    if (!Array.isArray(arr)) throw new Error(`${label}: ${key} is not an array`);
    for (const item of arr) {
      if ((item.agencyId || 'agency-hkc') !== agencyId) {
        throw new Error(`${label}: ${key} leaked another agency's record: ${item.id}`);
      }
    }
  }
}

export default {
  name: 'Test 22: Roster privacy — per-recipient agency filtering',
  whatItProves:
    'Roster payloads (INITIAL_STATE, USERS_UPDATED create/update/delete, CLEAN_SLATE_RESET, DEMO_RESTORED) are scoped per-recipient to their own agency with emails only for task-assigners. Recipients resolve by user ID + agency (never email-alone). Authorization is enforced on BOTH broadcast paths: deleted users sockets are closed (4401) and receive no further agency data, including ordinary fast-path broadcasts. No cross-agency receipt; /api/agencies, /api/users, clean-slate and restore-demo responses scoped; userEmail param ignored.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const adminBId = `user-test22-adminb-${ts}`;
    const staffBId = `user-test22-staffb-${ts}`;
    const assignerBId = `user-test22-assignerb-${ts}`;
    const noAgencyId = `user-test22-noagency-${ts}`;
    const adminBEmail = `test22-adminb-${ts}@test.local`;
    const staffBEmail = `test22-staffb-${ts}@test.local`;
    const assignerBEmail = `test22-assignerb-${ts}@test.local`;
    const noAgencyEmail = `test22-noagency-${ts}@test.local`;
    const newBEmail = `test22-new-${ts}@test.local`;

    // --- 1. Fixtures: agency B with admin, plain mashgiach, canAssignTasks
    // mashgiach, plus an agency-less user (unregistered-socket case) ---
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY_B, name: 'Test Agency B 22' }],
      venues: [{ id: `venue-test22-b-${ts}`, name: `Test22 Venue B ${ts}`, agencyId: AGENCY_B }],
      users: [
        { id: adminBId, email: adminBEmail, name: 'Test22 Admin B', role: 'admin', agencyId: AGENCY_B },
        { id: staffBId, email: staffBEmail, name: 'Test22 Staff B', role: 'mashgiach', agencyId: AGENCY_B },
        {
          id: assignerBId, email: assignerBEmail, name: 'Test22 Assigner B',
          role: 'mashgiach', agencyId: AGENCY_B, permissions: { canAssignTasks: true },
        },
        // No agencyId: falls back to agency-hkc; must never see agency-B payloads.
        { id: noAgencyId, email: noAgencyEmail, name: 'Test22 NoAgency', role: 'mashgiach' },
      ],
    });
    if (inj.status !== 200) throw new Error(`fixture inject failed: ${inj.status} ${JSON.stringify(inj.json)}`);

    // Sessions come from the server-side mint-token endpoint — never from
    // doc.jwtSecret (stripped by Test 18's restore by design).
    const tokenAdminB = await mintToken(baseUrl, adminBId);
    const tokenStaffB = await mintToken(baseUrl, staffBId);
    const tokenAssignerB = await mintToken(baseUrl, assignerBId);
    const tokenNoAgency = await mintToken(baseUrl, noAgencyId);
    const authB = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // --- 2. WS clients ---
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
    const connAssignerB = await connectWs(baseUrl, tokenAssignerB);
    const connNoAgency = await connectWs(baseUrl, tokenNoAgency);
    const allConns = [connHkc, connAdminB, connStaffB, connAssignerB, connNoAgency];
    const clearAll = () => allConns.forEach((c) => { c.messages.length = 0; });
    const assertNoType = (conns, type, label) => {
      for (const c of conns) {
        if (c.messages.some((m) => m.type === type)) throw new Error(`${label}: unexpected ${type} received`);
      }
    };

    // --- 3. INITIAL_STATE: agency-scoped + recipient-trimmed ---
    assertRoster(
      connAdminB.messages.find((m) => m.type === 'INITIAL_STATE').payload.users,
      AGENCY_B, true, 'INITIAL_STATE (agency-B admin)'
    );
    assertRoster(
      connStaffB.messages.find((m) => m.type === 'INITIAL_STATE').payload.users,
      AGENCY_B, false, 'INITIAL_STATE (agency-B mashgiach)'
    );
    assertRoster(
      connAssignerB.messages.find((m) => m.type === 'INITIAL_STATE').payload.users,
      AGENCY_B, true, 'INITIAL_STATE (agency-B canAssignTasks mashgiach)'
    );
    for (const [conn, label] of [[connHkc, 'hkc admin'], [connNoAgency, 'agency-less user']]) {
      for (const u of conn.messages.find((m) => m.type === 'INITIAL_STATE').payload.users) {
        if ((u.agencyId || 'agency-hkc') === AGENCY_B) {
          throw new Error(`INITIAL_STATE (${label}): leaked agency-B user`);
        }
      }
    }
    clearAll();

    // --- 4. USERS_UPDATED (create): per-recipient roster, no cross-agency receipt ---
    const cr = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: authB(tokenAdminB),
      body: JSON.stringify({ email: newBEmail, name: 'Test22 New B', role: 'mashgiach', password: 'test-password-123' }),
    });
    if (cr.status !== 200 && cr.status !== 201) {
      throw new Error(`agency-B user create failed: ${cr.status} ${JSON.stringify(await cr.json())}`);
    }
    const newUserId = (await cr.json()).user?.id;
    const cuAdminB = await waitForType(connAdminB.messages, 'USERS_UPDATED');
    const cuStaffB = await waitForType(connStaffB.messages, 'USERS_UPDATED');
    const cuAssignerB = await waitForType(connAssignerB.messages, 'USERS_UPDATED');
    assertRoster(cuAdminB.payload.users, AGENCY_B, true, 'USERS_UPDATED create (agency-B admin)');
    assertRoster(cuStaffB.payload.users, AGENCY_B, false, 'USERS_UPDATED create (agency-B mashgiach)');
    assertRoster(cuAssignerB.payload.users, AGENCY_B, true, 'USERS_UPDATED create (agency-B assigner)');
    if (!cuAdminB.payload.users.some((u) => u.email === newBEmail)) {
      throw new Error('USERS_UPDATED create (agency-B admin): new user missing from roster');
    }
    await new Promise((r) => setTimeout(r, 1500));
    assertNoType([connHkc, connNoAgency], 'USERS_UPDATED', 'USERS_UPDATED create cross-agency');
    clearAll();

    // --- 5. USERS_UPDATED (update): rename staffB as agency-B admin ---
    const v1 = await ctx.getVersion();
    const up = await fetch(`${baseUrl}/api/users/${staffBId}`, {
      method: 'PUT',
      headers: authB(tokenAdminB),
      body: JSON.stringify({ name: 'Test22 Staff B Renamed', expectedVersion: v1 }),
    });
    if (up.status !== 200) throw new Error(`agency-B user update failed: ${up.status} ${JSON.stringify(await up.json())}`);
    const uuAdminB = await waitForType(connAdminB.messages, 'USERS_UPDATED');
    const uuStaffB = await waitForType(connStaffB.messages, 'USERS_UPDATED');
    const uuAssignerB = await waitForType(connAssignerB.messages, 'USERS_UPDATED');
    assertRoster(uuAdminB.payload.users, AGENCY_B, true, 'USERS_UPDATED update (agency-B admin)');
    assertRoster(uuStaffB.payload.users, AGENCY_B, false, 'USERS_UPDATED update (agency-B mashgiach)');
    assertRoster(uuAssignerB.payload.users, AGENCY_B, true, 'USERS_UPDATED update (agency-B assigner)');
    if (!uuAdminB.payload.users.some((u) => u.id === staffBId && u.name === 'Test22 Staff B Renamed')) {
      throw new Error('USERS_UPDATED update: renamed user missing from roster');
    }
    await new Promise((r) => setTimeout(r, 1500));
    assertNoType([connHkc, connNoAgency], 'USERS_UPDATED', 'USERS_UPDATED update cross-agency');
    clearAll();

    // --- 6. USERS_UPDATED (delete): remove the created user ---
    const v2 = await ctx.getVersion();
    const del = await fetch(`${baseUrl}/api/users/${newUserId}?expectedVersion=${v2}`, {
      method: 'DELETE',
      headers: authB(tokenAdminB),
    });
    if (del.status !== 200) throw new Error(`agency-B user delete failed: ${del.status} ${JSON.stringify(await del.json())}`);
    const udAdminB = await waitForType(connAdminB.messages, 'USERS_UPDATED');
    const udStaffB = await waitForType(connStaffB.messages, 'USERS_UPDATED');
    const udAssignerB = await waitForType(connAssignerB.messages, 'USERS_UPDATED');
    assertRoster(udAdminB.payload.users, AGENCY_B, true, 'USERS_UPDATED delete (agency-B admin)');
    assertRoster(udStaffB.payload.users, AGENCY_B, false, 'USERS_UPDATED delete (agency-B mashgiach)');
    assertRoster(udAssignerB.payload.users, AGENCY_B, true, 'USERS_UPDATED delete (agency-B assigner)');
    if (udAdminB.payload.deletedId !== newUserId) throw new Error('USERS_UPDATED delete: deletedId missing');
    if (udAdminB.payload.users.some((u) => u.id === newUserId)) {
      throw new Error('USERS_UPDATED delete: deleted user still in roster');
    }
    await new Promise((r) => setTimeout(r, 1500));
    assertNoType([connHkc, connNoAgency], 'USERS_UPDATED', 'USERS_UPDATED delete cross-agency');
    clearAll();

    // --- 6b. Broadcast authorization isolation (regression for round-3/5 HIGH) ---
    // Verifies authorizeSocket() independently of the revocation broadcast:
    // (a) an OPEN socket whose user was silently revoked (no roster broadcast,
    //     so the socket is still open) must be closed by a fast-path broadcast;
    // (b) an OPEN socket with no authenticated metadata must be closed too.
    // Uses test-only endpoints (revoke-user-silent, drop-socket-meta).
    {
      const mkUser = async (suffix) => {
        const email = `fp-${suffix}-${ts}@agency-b.test`;
        const res = await fetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: authB(tokenAdminB),
          body: JSON.stringify({
            email,
            name: `Fp ${suffix}`,
            role: 'mashgiach',
            agencyId: AGENCY_B,
            venueId: `venue-test22-b-${ts}`,
            password: 'Temp1234!',
          }),
        });
        if (res.status !== 200 && res.status !== 201) {
          throw new Error(`fast-path: fp user ${suffix} create failed: ${res.status}`);
        }
        const { user } = await res.json();
        const conn = await connectWs(baseUrl, await mintToken(baseUrl, user.id));
        if (!conn.messages.some((m) => m.type === 'INITIAL_STATE')) {
          throw new Error(`fast-path: fp socket ${suffix} got no INITIAL_STATE`);
        }
        conn.messages.length = 0;
        return { userId: user.id, conn };
      };

      // (a) Silently revoked user, socket still OPEN.
      const revoked = await mkUser('revoked');
      const revRes = await fetch(`${baseUrl}/api/__test__/revoke-user-silent`, {
        method: 'POST',
        headers: authB(tokenAdminB),
        body: JSON.stringify({ userId: revoked.userId }),
      });
      if (revRes.status !== 200) throw new Error(`fast-path: silent revoke failed: ${revRes.status}`);
      if (revoked.conn.closed) {
        throw new Error('fast-path: socket closed by silent revoke (it must stay open to isolate the check)');
      }

      // (b) Socket with no authenticated metadata, still OPEN.
      const noMeta = await mkUser('nometa');
      const dropRes = await fetch(`${baseUrl}/api/__test__/drop-socket-meta`, {
        method: 'POST',
        headers: authB(tokenAdminB),
        body: JSON.stringify({ userId: noMeta.userId }),
      });
      const dropJson = await dropRes.json();
      if (dropJson.dropped !== 1) throw new Error(`fast-path: expected 1 meta dropped, got ${dropJson.dropped}`);
      if (noMeta.conn.closed) {
        throw new Error('fast-path: socket closed by meta drop (it must stay open to isolate the check)');
      }

      // Trigger a normal agency-scoped broadcast with NO varyByRecipient
      // (fast path). Both unauthorized sockets must be closed, not sent data.
      clearAll();
      const probe = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: authB(tokenAdminB),
        body: JSON.stringify({ title: `Fast-path probe ${ts}`, createdByEmail: adminBEmail }),
      });
      if (probe.status !== 200 && probe.status !== 201) {
        throw new Error(`fast-path: probe task create failed: ${probe.status}`);
      }
      await new Promise((r) => setTimeout(r, 1500));

      for (const [target, label] of [[revoked, 'silently-revoked'], [noMeta, 'metadata-less']]) {
        if (target.conn.messages.some((m) => m.type === 'TASK_CREATED')) {
          throw new Error(`fast-path: ${label} socket received TASK_CREATED`);
        }
        if (!target.conn.closed || target.conn.closeCode !== 4401) {
          throw new Error(
            `fast-path: ${label} socket not closed with 4401 ` +
            `(closed=${target.conn.closed}, code=${target.conn.closeCode})`
          );
        }
      }
      // Sanity: a valid recipient DID get the fast-path broadcast (no regression)...
      if (!connAdminB.messages.some((m) => m.type === 'TASK_CREATED')) {
        throw new Error('fast-path: valid admin socket missed TASK_CREATED (fast-path regression)');
      }
      // ...and it stayed inside agency B.
      assertNoType([connHkc, connNoAgency], 'TASK_CREATED', 'TASK_CREATED cross-agency');
      clearAll();
    }

    // --- 7. GET /api/agencies: own agency only, no adminEmail, no counts ---
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

    // --- 8. GET /api/users: token-scoped, recipient-trimmed; userEmail param ignored ---
    const usAssigner = await fetch(`${baseUrl}/api/users`, { headers: authB(tokenAssignerB) });
    assertRoster((await usAssigner.json()).users, AGENCY_B, true, 'GET /api/users (agency-B assigner)');
    const usStaff = await fetch(`${baseUrl}/api/users`, { headers: authB(tokenStaffB) });
    assertRoster((await usStaff.json()).users, AGENCY_B, false, 'GET /api/users (agency-B mashgiach)');
    const usSpoof = await fetch(`${baseUrl}/api/users?userEmail=kenan@hartfordkashrut.org`, { headers: authB(tokenStaffB) });
    for (const u of (await usSpoof.json()).users || []) {
      if ((u.agencyId || 'agency-hkc') !== AGENCY_B) {
        throw new Error("GET /api/users: userEmail query param leaked another agency's roster");
      }
    }

    // --- 9. CLEAN_SLATE_RESET: broadcast + HTTP response scoped ---
    // (Destructive to agency B only; this test runs last in the suite.)
    const cs = await fetch(`${baseUrl}/api/admin/clean-slate`, {
      method: 'POST',
      headers: authB(tokenAdminB),
      body: JSON.stringify({}),
    });
    if (cs.status !== 200) throw new Error(`clean-slate failed: ${cs.status} ${JSON.stringify(await cs.json())}`);
    const csJson = await cs.json();
    assertRoster(csJson.users, AGENCY_B, true, 'clean-slate HTTP response (agency-B admin)');
    if (csJson.users.some((u) => u.id === staffBId || u.id === assignerBId)) {
      throw new Error('clean-slate HTTP response: non-admin agency-B users should be wiped');
    }
    const csAdminB = await waitForType(connAdminB.messages, 'CLEAN_SLATE_RESET');
    assertRoster(csAdminB.payload.users, AGENCY_B, true, 'CLEAN_SLATE_RESET (agency-B admin)');
    for (const key of ['venues', 'tasks', 'events']) {
      if (!Array.isArray(csAdminB.payload[key]) || csAdminB.payload[key].length !== 0) {
        throw new Error(`CLEAN_SLATE_RESET: ${key} should be empty`);
      }
    }
    // staffB/assignerB were wiped by clean-slate: the server must CLOSE their
    // sockets (4401) — a deleted user receives no further agency data at all.
    await new Promise((r) => setTimeout(r, 2000));
    for (const [conn, label] of [[connStaffB, 'wiped mashgiach'], [connAssignerB, 'wiped assigner']]) {
      if (!conn.closed || conn.closeCode !== 4401) {
        throw new Error(
          `CLEAN_SLATE_RESET: ${label} socket not closed with 4401 after wipe ` +
          `(closed=${conn.closed}, code=${conn.closeCode}, readyState=${conn.ws.readyState})`
        );
      }
      if (conn.messages.some((m) => m.type === 'CLEAN_SLATE_RESET')) {
        throw new Error(`CLEAN_SLATE_RESET: ${label} received broadcast after wipe`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    assertNoType([connHkc, connNoAgency], 'CLEAN_SLATE_RESET', 'CLEAN_SLATE_RESET cross-agency');
    clearAll();

    // --- 10. restore-demo is retired (8i): 410 for an agency admin, nothing
    // written, no DEMO_RESTORED broadcast to anyone (it used to delete the
    // caller agency's data and re-create the seed admin account).
    const vBeforeRd = await ctx.getVersion();
    const rd = await fetch(`${baseUrl}/api/admin/restore-demo`, {
      method: 'POST',
      headers: authB(tokenAdminB),
      body: JSON.stringify({}),
    });
    if (rd.status !== 410) throw new Error(`restore-demo must be 410 (8i), got ${rd.status}`);
    await new Promise((r) => setTimeout(r, 1500));
    assertNoType(allConns, 'DEMO_RESTORED', 'DEMO_RESTORED after retirement');
    if ((await ctx.getVersion()) !== vBeforeRd) throw new Error('restore-demo (retired) must not write');

    for (const c of allConns) c.ws.close();

    return 'all roster broadcasts agency-scoped per recipient (ID+agency resolution); emails only for task-assigners; authorization on both broadcast paths — deleted users sockets closed with 4401, no further agency data incl. fast-path broadcasts; no cross-agency or agency-less receipt; HTTP responses scoped; userEmail param ignored';
  },
};
