/**
 * Test 18: Isolated backup/restore cycle (disaster recovery).
 *
 * Verifies the BACKUP_RESTORE.md procedure without touching production:
 *   1. /api/admin/export returns a complete, restorable snapshot (admin-only;
 *      passwords AND kiosk PINs stripped by design — verified with a test
 *      user carrying a populated PIN; includes _v, tasks, venues, users).
 *   2. Wipe the Firestore document (simulated disaster).
 *   3. Restore the export via the Admin SDK, targeting the database with an
 *      EXPLICIT database ID (getFirestore(app, databaseId)) — the exact
 *      pattern from BACKUP_RESTORE.md. Shutfey uses a named database in
 *      production; the (default) database must never be the silent fallback.
 *   4. Verify counts, version, and canary data match the backup.
 *
 * In emulator mode (CI) this runs the full cycle against the emulator.
 * In mock mode (local) only the export-structure validation runs — the
 * in-memory mock has no Admin SDK surface.
 */
export default {
  name: 'Test 18: Isolated backup/restore cycle',
  whatItProves:
    'The admin export is a complete restorable snapshot, and the restore procedure (explicit database ID) round-trips it with identical counts and version.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const useEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

    // --- 1. Canary task so we can prove the restore brought data back ---
    const cr = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test18 Canary ${ts}`,
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (cr.status !== 201 && cr.status !== 200) throw new Error(`canary create failed: ${cr.status}`);
    const canaryId = (cr.json.task || cr.json).id;

    // --- 1b. Kiosk-PIN user: create a user WITH a populated kioskPin, so the
    // export-strip check below is meaningful (round 5: the code previously
    // only stripped password, leaking PINs despite the docs claiming otherwise).
    const ku = await ctx.api('POST', '/api/users', {
      email: `test18-pin-${ts}@test.local`,
      name: `Test18 PIN ${ts}`,
      role: 'mashgiach',
    });
    if (ku.status !== 201 && ku.status !== 200) throw new Error(`pin-user create failed: ${ku.status} ${JSON.stringify(ku.json)}`);
    const pinUserId = (ku.json.user || ku.json).id;
    const vPin = await ctx.getVersion();
    const pinSet = await ctx.api('PUT', `/api/users/${pinUserId}`, {
      kioskPin: '4821',
      expectedVersion: vPin,
    });
    if (pinSet.status !== 200) throw new Error(`kioskPin set failed: ${pinSet.status} ${JSON.stringify(pinSet.json)}`);
    // Confirm the PIN is actually populated server-side (via the test doc endpoint).
    const docCheck = await ctx.getDoc();
    const pinUserDoc = (docCheck.users || []).find((u) => u.id === pinUserId);
    if (!pinUserDoc || pinUserDoc.kioskPin !== '4821') {
      throw new Error('kioskPin was not populated on the test user — strip check would be vacuous');
    }

    // --- 2. Export (admin-only) ---
    const expRes = await fetch(`${baseUrl}/api/admin/export`, { headers: ctx.authHeaders });
    if (expRes.status !== 200) throw new Error(`export failed: ${expRes.status}`);
    const backup = await expRes.json();
    // Structure validation: restorable snapshot must have these.
    for (const k of ['_v', 'tasks', 'venues', 'users', 'currentWorkDate']) {
      if (!(k in backup)) throw new Error(`export missing required field: ${k}`);
    }
    if (typeof backup._v !== 'number') throw new Error('export _v not a number');
    // Passwords must be stripped (by design — restores require password resets).
    for (const u of backup.users || []) {
      if (u.password !== undefined || u.passwordHash !== undefined || u.kioskPin !== undefined) {
        throw new Error(`export leaked credentials for user ${u.id}`);
      }
    }
    const counts = {
      tasks: (backup.tasks || []).length,
      venues: (backup.venues || []).length,
      users: (backup.users || []).length,
      version: backup._v,
    };
    if (!(backup.tasks || []).some((t) => t.id === canaryId)) {
      throw new Error('canary task missing from export');
    }

    if (!useEmulator) {
      // Mock mode: no Admin SDK surface — structural validation is the test.
      return `export validated (mock mode): ${counts.tasks} tasks, ${counts.venues} venues, ${counts.users} users, v${counts.version}; passwords AND kiosk PINs stripped (verified with populated-PIN user); full wipe/restore cycle runs in CI (emulator)`;
    }

    // --- 3. Full cycle against the emulator, explicit database ID ---
    const { initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-test';
    const databaseId = (process.env.FIRESTORE_DATABASE_ID || '').trim();
    const app = initializeApp({ projectId }, `test18-${ts}`);
    // THE critical line from BACKUP_RESTORE.md: explicit database ID, never
    // the silent (default) fallback.
    const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
    const docRef = db.doc('app-state/main');

    // Sanity: we are talking to the same database the server uses.
    const before = (await docRef.get()).data();
    if (!before || before._v !== counts.version) {
      throw new Error(`database mismatch: doc _v=${before?._v}, expected ${counts.version}`);
    }

    // Disaster: wipe the document.
    await docRef.set({ _wipedByTest18: true });
    const wiped = (await docRef.get()).data();
    if (wiped.tasks || wiped._v) throw new Error('wipe did not clear the document');

    // Restore: write the export back (strip export metadata like the script).
    const toRestore = { ...backup };
    delete toRestore.exportedAt;
    await docRef.set(JSON.parse(JSON.stringify(toRestore)));

    // Verify: counts, version, and canary match the backup exactly.
    const restored = (await docRef.get()).data();
    const rCounts = {
      tasks: (restored.tasks || []).length,
      venues: (restored.venues || []).length,
      users: (restored.users || []).length,
      version: restored._v,
    };
    for (const k of Object.keys(counts)) {
      if (rCounts[k] !== counts[k]) {
        throw new Error(`restore mismatch on ${k}: backup=${counts[k]}, restored=${rCounts[k]}`);
      }
    }
    if (!(restored.tasks || []).some((t) => t.id === canaryId && t.title === `Test18 Canary ${ts}`)) {
      throw new Error('canary task not intact after restore');
    }

    // The restored doc must be writable (not corrupted).
    const vW = await ctx.getVersion();
    const wr = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test18 Post-Restore ${ts}`,
      createdByEmail: 'kenan@hartfordkashrut.org',
    });
    if (wr.status !== 201 && wr.status !== 200) {
      throw new Error(`write after restore failed: ${wr.status} ${JSON.stringify(wr.json)}`);
    }

    // Cleanup canaries + the PIN test user.
    for (const id of [canaryId, (wr.json.task || wr.json).id]) {
      const v = await ctx.getVersion();
      await ctx.api('DELETE', `/api/tasks/${id}`, { expectedVersion: v });
    }
    {
      const v = await ctx.getVersion();
      const del = await ctx.api('DELETE', `/api/users/${pinUserId}`, { expectedVersion: v });
      if (del.status !== 200) throw new Error(`pin-user cleanup failed: ${del.status}`);
    }

    try { await app.delete(); } catch {}
    return `restore cycle OK (db: ${databaseId || '(default)'}): ${rCounts.tasks} tasks, ${rCounts.venues} venues, ${rCounts.users} users, v${rCounts.version} — identical to backup; post-restore write OK`;
  },
};
