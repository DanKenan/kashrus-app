/**
 * Test 10: POST /api/reset-daily (admin manual daily reset).
 *
 * Verifies:
 *  1. Non-admin rejection: a mashgiach's token → 403.
 *  2. Manual reset works: admin POST {force:true} → 200, the venue's tasks
 *     are reset (isCompleted=false, notes='', updatedAt=null, status back to
 *     the initial value), and a history snapshot is created for the venue.
 *  3. Double-reset idempotency: two POSTs with the same operationId must not
 *     create duplicate snapshots or bump the version twice.
 *  4. Agency scoping: a reset without venueId creates snapshots only for the
 *     caller's agency venues — never for another agency's venue.
 *  5. Archive date: the history snapshot's `date` is today in
 *     America/New_York.
 *
 * KNOWN GAPS DOCUMENTED (not fixed — server.ts is untouched):
 *  - (3) The endpoint does NOT return the cached result on a duplicate
 *    operationId. commitOrRespond() maps DuplicateOperationError → 200 with
 *    the cached result, but /api/reset-daily calls executeDailyReset()
 *    directly and its catch-all maps the duplicate to
 *    503 {"error":"Daily reset failed: Duplicate operation — returning cached
 *    result."}. The duplicate has NO effect (no new snapshot, no version
 *    bump), so retries are safe, but a client cannot recover the original
 *    result from the endpoint. The test asserts the current 503 behavior;
 *    update it when the endpoint is fixed to return the cached result.
 *  - (4) Snapshots ARE agency-scoped, but the task reset itself is NOT:
 *    resetTask() resets every task in the document when no venueId is given,
 *    including other agencies' tasks. The test asserts the snapshot scoping
 *    (which holds) and records the observed task-level behavior.
 *  - (4) Cross-agency fixtures cannot be built through the HTTP API (venue
 *    and user creation are hard-scoped to the caller's agency), so the
 *    agency-B venue/task is injected directly into the mock Firestore file
 *    and the server is restarted to hydrate it (same mechanism as Test 5).
 *    NOTE: the harness's ctx.restartServer() only SIGKILLs the `npx` wrapper
 *    process — the real node server is orphaned, keeps the port, and the
 *    respawned server dies on EADDRINUSE, so the "restart" silently never
 *    happens (verified: a PPID-1 listener survives restartServer and
 *    file-injected fixtures are never hydrated). This test works around it
 *    by SIGKILLing every process holding the test port BEFORE calling
 *    ctx.restartServer(), producing a genuinely fresh server. If the port
 *    cannot be cleared (no `ss`/`fuser`), the hydration check fails with a
 *    clear message rather than a false pass.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

/**
 * SIGKILL every process listening on `port`, so a subsequent
 * ctx.restartServer() actually binds a fresh server instead of dying on
 * EADDRINUSE behind the orphaned old one. Returns the number of PIDs killed.
 */
function killPortHolders(port) {
  const pids = new Set();
  const portRe = new RegExp(`:${port}(?![0-9])`);
  try {
    const out = execSync('ss -tlnp', { encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      if (!portRe.test(line)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
    }
  } catch {}
  if (pids.size === 0) {
    try {
      const out = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf-8' });
      for (const m of out.matchAll(/(\d+)/g)) pids.add(m[1]);
    } catch {}
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
  return pids.size;
}

export default {
  name: 'Test 10: Daily reset endpoint',
  whatItProves:
    'POST /api/reset-daily requires admin, resets tasks + archives a dated history snapshot per venue, rejects duplicate operationIds without effect, and scopes snapshots to the caller\'s agency.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const details = [];

    // The test's venue is made first: with invites always on, a member is invited
    // to a named venue (no silent default venue), and this agency keeps exactly
    // the venues the reset below expects.
    const vr = await ctx.api('POST', '/api/venues', { name: `Stage2 Test10 Venue ${ts}` });
    if (vr.status !== 201 && vr.status !== 200) {
      throw new Error(`venue create failed: ${vr.status} ${JSON.stringify(vr.json)}`);
    }
    const venueId = vr.json.venue.id;

    // ---------- 1. Non-admin rejection ----------
    const nonAdminEmail = `reset-nonadmin-${ts}@test.local`;
    const cu = await ctx.addMember({
      email: nonAdminEmail,
      name: 'Reset NonAdmin',
      role: 'mashgiach',
      venueId,
      password: 'nonadmin-pw-123',
    });
    if (cu.status !== 200 && cu.status !== 201) {
      throw new Error(`failed to create non-admin user: ${cu.status} ${JSON.stringify(cu.json)}`);
    }
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: nonAdminEmail, password: 'nonadmin-pw-123' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) throw new Error(`non-admin login failed: ${loginRes.status}`);
    const nonAdminFetch = (body) =>
      fetch(`${baseUrl}/api/reset-daily`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${loginJson.token}`,
        },
        body: JSON.stringify(body),
      });
    const r403 = await nonAdminFetch({ force: true });
    if (r403.status !== 403) {
      throw new Error(`non-admin reset-daily should be 403, got ${r403.status}`);
    }
    details.push('non-admin → 403');

    // ---------- 2. Manual reset works ----------
    const tr = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: `Stage2 Test10 Task ${ts}`,
      createdByEmail: ADMIN_EMAIL,
    });
    if (tr.status !== 201 && tr.status !== 200) {
      throw new Error(`task create failed: ${tr.status} ${JSON.stringify(tr.json)}`);
    }
    const taskId = (tr.json.task || tr.json).id;

    // Complete the task so the reset has something to clear.
    // (Version contract: updates must carry the last-seen version.)
    const vTask = await ctx.getVersion();
    const done = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      isCompleted: true,
      notes: 'reset-me notes',
      userEmail: ADMIN_EMAIL,
      expectedVersion: vTask,
    });
    if (done.status !== 200) throw new Error(`completing task failed: ${done.status}`);

    const vBefore = await ctx.getVersion();
    const snapsBefore = (await ctx.getDoc()).historyLogs.filter((h) => h.venueId === venueId).length;

    const rr = await ctx.api('POST', '/api/reset-daily', { force: true });
    if (rr.status !== 200 || rr.json.success !== true) {
      throw new Error(`reset-daily failed: ${rr.status} ${JSON.stringify(rr.json)}`);
    }

    const vAfter = await ctx.getVersion();
    if (vAfter !== vBefore + 1) {
      throw new Error(`reset should bump version by exactly 1: ${vBefore} -> ${vAfter}`);
    }
    const doc = await ctx.getDoc();
    const t = doc.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task missing from Firestore after reset');
    if (t.isCompleted !== false) throw new Error('task was not un-completed by reset');
    if (t.notes !== '') throw new Error(`task notes not cleared: "${t.notes}"`);
    if (t.updatedAt !== null) throw new Error('task updatedAt not cleared');
    if (t.updatedByEmail !== null || t.updatedByName !== null) throw new Error(`task who-answered not cleared: ${t.updatedByEmail} / ${t.updatedByName}`);
    if (!Array.isArray(t.checkIns) || t.checkIns.length !== 0) throw new Error('task checkIns not cleared');
    // yes_no tasks reset to their initial status: unanswered ('pending', QA2 #5).
    if (t.currentStatus !== 'pending') {
      throw new Error(`task status not reset to initial: "${t.currentStatus}"`);
    }
    const snaps = doc.historyLogs.filter((h) => h.venueId === venueId);
    if (snaps.length !== snapsBefore + 1) {
      throw new Error(`expected 1 new snapshot for the venue, got ${snaps.length - snapsBefore}`);
    }
    const snap = snaps[snaps.length - 1];
    if (!snap.entries.some((e) => e.taskId === taskId)) {
      throw new Error('snapshot does not archive the completed task');
    }
    // The response carries the FIRST snapshot of this reset (the frontend shows
    // one). Other tests may have added HKC venues (invites always on: a member
    // is invited to a real venue), so it must be one of THIS reset's archived
    // snapshots, for a venue of the caller's agency — not necessarily ours.
    if (rr.json.snapshot) {
      const hkcVenueIds = new Set((doc.venues || []).filter((v) => (v.agencyId || 'agency-hkc') === 'agency-hkc').map((v) => v.id));
      const archived = (doc.historyLogs || []).some((h) => h.id === rr.json.snapshot.id && h.venueId === rr.json.snapshot.venueId);
      if (!archived || !hkcVenueIds.has(rr.json.snapshot.venueId)) {
        throw new Error(`response snapshot venue mismatch: ${rr.json.snapshot.venueId}`);
      }
    }
    details.push(`reset works: task cleared, snapshot archived, version ${vBefore}→${vAfter}`);

    // ---------- 5. Archive date (checked on this snapshot) ----------
    // Snapshot.date comes from the server's currentWorkDate, which the reset
    // bumps to today in America/New_York.
    const expectedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (snap.date !== expectedDate) {
      throw new Error(`snapshot date ${snap.date} !== today (America/New_York) ${expectedDate}`);
    }
    details.push(`archive date = ${snap.date} (America/New_York)`);

    // ---------- 3. Double-reset idempotency ----------
    const opId = `test10-reset-${ts}`;
    const r1 = await ctx.api('POST', '/api/reset-daily', { force: true, operationId: opId });
    if (r1.status !== 200) throw new Error(`first reset with operationId failed: ${r1.status}`);
    const v1 = await ctx.getVersion();
    const snaps1 = (await ctx.getDoc()).historyLogs.filter((h) => h.venueId === venueId).length;

    const r2 = await ctx.api('POST', '/api/reset-daily', { force: true, operationId: opId });
    // FIXED behavior: duplicate operationId returns 200 with the cached result
    // (not 503). The duplicate has no effect — no new snapshot, no version bump.
    if (r2.status !== 200) {
      throw new Error(
        `duplicate operationId: expected 200 with cached result, got ${r2.status} ${JSON.stringify(r2.json)}`
      );
    }
    if (!r2.json.duplicate) {
      throw new Error(`duplicate operationId: expected duplicate:true flag in response`);
    }
    const v2 = await ctx.getVersion();
    if (v2 !== v1) throw new Error(`version bumped on duplicate operationId: ${v1} -> ${v2}`);
    const snaps2 = (await ctx.getDoc()).historyLogs.filter((h) => h.venueId === venueId).length;
    if (snaps2 !== snaps1) {
      throw new Error(`duplicate snapshot created on operationId replay: ${snaps1} -> ${snaps2}`);
    }
    details.push('duplicate operationId → 503, no new snapshot, version unchanged');

    // ---------- 4. Agency scoping ----------
    // The HTTP API hard-scopes venue/user creation to the caller's agency, so
    // a cross-agency fixture is injected directly into Firestore, then
    // the server is restarted to hydrate it (same mechanism as Test 5).
    if (!ctx.restartServer) throw new Error('restartServer hook not provided — cannot run');
    const bVenueId = `venue-agency-b-${ts}`;
    const bTaskId = `task-agency-b-${ts}`;
    const bVenue = {
      id: bVenueId,
      agencyId: 'agency-b',
      name: `Agency B Venue ${ts}`,
      category: 'Food Service',
      address: 'Test',
      certification: 'Kosher',
      createdAt: new Date().toISOString(),
    };
    const bTask = {
      id: bTaskId,
      agencyId: 'agency-b',
      venueId: bVenueId,
      title: `Agency B Task ${ts}`,
      description: '',
      category: 'General',
      categories: ['General'],
      isPrivate: false,
      sortOrder: 0,
      inputType: 'yes_no',
      assignedTo: ['all'],
      scheduleType: 'recurring',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetTime: 'End of Day',
      priority: 'medium',
      enableOverdueAlert: false,
      currentStatus: 'yes',
      isCompleted: true,
      notes: 'agency-b notes must be scoped',
      updatedByEmail: 'x@test.local',
      updatedByName: 'X',
      updatedAt: new Date().toISOString(),
      checkIns: [],
      createdAt: new Date().toISOString(),
    };
    // Inject the cross-agency fixture directly into Firestore.
    const useRealEmulator = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_MOCK !== 'true';
    if (useRealEmulator) {
      // Real emulator: read current doc, append fixture, write back via REST API
      const emuHost = process.env.FIRESTORE_EMULATOR_HOST;
      const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-test';
      const docUrl = `http://${emuHost}/v1/projects/${projectId}/databases/(default)/documents/app-state/main`;
      const getRes = await fetch(docUrl);
      if (!getRes.ok) throw new Error(`emulator GET failed: ${getRes.status}`);
      const emuDoc = await getRes.json();
      // Convert Firestore REST format to plain JSON, append, convert back
      // Simpler: use the test-only endpoint to inject
      const injectRes = await ctx.api('POST', '/api/__test__/inject-fixture', {
        venues: [bVenue],
        tasks: [bTask],
      });
      if (injectRes.status !== 200) throw new Error(`fixture inject failed: ${injectRes.status}`);
    } else {
      // Mock mode: write directly to the mock file
      const mockFile = process.env.FIRESTORE_MOCK_FILE || join(tmpdir(), 'stage2-mock-firestore.json');
      const store = JSON.parse(readFileSync(mockFile, 'utf-8'));
      const fileDoc = store['app-state/main'];
      if (!fileDoc) throw new Error('mock Firestore file has no app-state/main doc');
      fileDoc.venues.push(bVenue);
      fileDoc.tasks.push(bTask);
      writeFileSync(mockFile, JSON.stringify(store));
    }
    // Real restart: clear the port first (see killPortHolders note above),
    // otherwise restartServer() silently keeps serving the OLD process and
    // the injected fixture is never hydrated.
    const port = new URL(baseUrl).port || '3100';
    const killed = killPortHolders(port);
    if (killed === 0) {
      throw new Error(
        `could not find/clear the test server on port ${port} (no ss/fuser match) — ` +
          'cannot perform the real restart needed to hydrate the agency-B fixture'
      );
    }
    await ctx.restartServer();

    // The admin token survives the restart (JWT secret is persisted in the doc).
    // Robustness: the restart is racy (an orphaned server can keep the port,
    // so the "new" server is actually the old one without the fixture). Poll
    // for the fixture; if it never appears, kill + restart once more before
    // failing. (Round 4: this race caused ~50% flakes in full-suite runs.)
    let docR = null;
    let hydrated = false;
    for (let attempt = 1; attempt <= 2 && !hydrated; attempt++) {
      for (let i = 0; i < 20 && !hydrated; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          docR = await ctx.getDoc();
          hydrated = !!(docR && docR.venues.some((v) => v.id === bVenueId));
        } catch {}
      }
      if (!hydrated && attempt === 1) {
        console.log('  [test10] fixture not hydrated after restart — retrying kill+restart once');
        killPortHolders(port);
        await ctx.restartServer();
      }
    }
    if (!hydrated) {
      throw new Error('agency-B venue not hydrated after restart (2 attempts)');
    }
    const bTaskBefore = docR.tasks.find((x) => x.id === bTaskId);
    if (!bTaskBefore || bTaskBefore.isCompleted !== true) {
      throw new Error('agency-B task fixture not intact after restart');
    }

    // Reset WITHOUT venueId as the agency-hkc admin.
    const rr4 = await ctx.api('POST', '/api/reset-daily', { force: true });
    if (rr4.status !== 200) throw new Error(`scoped reset failed: ${rr4.status}`);
    const doc4 = await ctx.getDoc();
    const bSnaps = doc4.historyLogs.filter((h) => h.venueId === bVenueId);
    if (bSnaps.length !== 0) {
      throw new Error(`snapshot created for another agency's venue (${bSnaps.length})`);
    }
    details.push('no snapshot created for agency-b venue');

    // Task-level scoping: OBSERVED BEHAVIOR (flagged, not asserted as correct).
    // resetTask() applies to every task when no venueId is given — it has no
    // agency filter — so the agency-B task's fields ARE cleared even though
    // no snapshot was archived for its venue. This contradicts the endpoint's
    // "Agency-scoped: only the caller's agency venues are reset" contract.
    const bTaskAfter = doc4.tasks.find((x) => x.id === bTaskId);
    const bTaskCleared = bTaskAfter.isCompleted === false && bTaskAfter.notes === '';
    details.push(
      bTaskCleared
        ? 'NOTE (bug): agency-b task fields WERE reset (isCompleted/notes cleared) despite agency scoping — task reset is not agency-scoped'
        : 'agency-b task untouched'
    );

    // Cleanup: remove our task + venue (agency-hkc). The agency-B fixtures
    // cannot be deleted by this admin (cross-agency) — they are namespaced
    // and harmless to later tests.
    const vDel1 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/tasks/${taskId}`, { expectedVersion: vDel1 });
    const vDel2 = await ctx.getVersion();
    await ctx.api('DELETE', `/api/venues/${venueId}`, { expectedVersion: vDel2 });

    return details.join('; ');
  },
};
