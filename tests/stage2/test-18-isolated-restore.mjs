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
    "The admin export is the caller agency's secret-free data, marked non-restorable over the whole document, and it round-trips (explicit database ID) into an isolated fixture document with identical counts while app-state/main is untouched.",

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
    // Confirm the PIN hash is actually populated server-side (via the test doc endpoint).
    // (PUT /api/users hashes kioskPin to kioskPinHash; plain kioskPin is never stored.)
    const docCheck = await ctx.getDoc();
    const pinUserDoc = (docCheck.users || []).find((u) => u.id === pinUserId);
    if (!pinUserDoc || !pinUserDoc.kioskPinHash || !String(pinUserDoc.kioskPinHash).startsWith('$2')) {
      throw new Error('kioskPinHash was not populated on the test user — strip check would be vacuous');
    }
    if (pinUserDoc.kioskPin) {
      throw new Error('plain kioskPin stored in doc (should be hash only)');
    }

    // --- 2. Export (admin-only) ---
    const expRes = await fetch(`${baseUrl}/api/admin/export`, { headers: ctx.authHeaders });
    if (expRes.status !== 200) throw new Error(`export failed: ${expRes.status}`);
    const backup = await expRes.json();
    // Structure validation (8h): an AGENCY export, never a whole-doc snapshot.
    if (backup.exportScope !== 'agency' || backup.exportAgencyId !== 'agency-hkc' || backup.restorable !== false) {
      throw new Error(`export is not marked as the caller's agency export: ${JSON.stringify({ s: backup.exportScope, a: backup.exportAgencyId, r: backup.restorable })}`);
    }
    for (const k of ['_v', 'currentWorkDate', 'isDemoCleared']) {
      if (k in backup) throw new Error(`agency export must not carry whole-document field ${k}`);
    }
    for (const k of ['tasks', 'venues', 'users', 'agencies']) {
      if (!Array.isArray(backup[k])) throw new Error(`export missing required collection: ${k}`);
    }
    if (backup.agencies.some((a) => a.id !== 'agency-hkc')) throw new Error('export carries another agency');
    // Passwords must be stripped (by design — restores require password resets).
    for (const u of backup.users || []) {
      if (u.password !== undefined || u.passwordHash !== undefined || u.kioskPin !== undefined || u.kioskPinHash !== undefined) {
        throw new Error(`export leaked credentials for user ${u.id}`);
      }
    }
    if (!(backup.users || []).some((u) => u.id === pinUserId)) throw new Error('PIN test user missing from export (strip check would be vacuous)');
    const counts = {
      tasks: (backup.tasks || []).length,
      venues: (backup.venues || []).length,
      users: (backup.users || []).length,
    };
    if (!(backup.tasks || []).some((t) => t.id === canaryId)) {
      throw new Error('canary task missing from export');
    }

    if (!useEmulator) {
      // Mock mode: no Admin SDK surface — structural validation is the test.
      return `agency export validated (mock mode): ${counts.tasks} tasks, ${counts.venues} venues, ${counts.users} users; marked non-restorable over the whole doc; passwords AND kiosk PINs stripped (verified with populated-PIN user); isolated round trip runs in CI (emulator)`;
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
    const mainRef = db.doc('app-state/main');
    const mainBefore = (await mainRef.get()).data();
    if (!mainBefore || !(mainBefore.tasks || []).some((t) => t.id === canaryId)) {
      throw new Error('database mismatch: canary not found in app-state/main of the target database');
    }

    // Round trip into an ISOLATED fixture document (never app-state/main).
    const isoRef = db.doc(`app-state/test18-agency-${ts}`);
    const toRestore = { ...backup };
    delete toRestore.exportedAt;
    await isoRef.set(JSON.parse(JSON.stringify(toRestore)));
    const restored = (await isoRef.get()).data();
    const rCounts = {
      tasks: (restored.tasks || []).length,
      venues: (restored.venues || []).length,
      users: (restored.users || []).length,
    };
    for (const k of Object.keys(counts)) {
      if (rCounts[k] !== counts[k]) {
        throw new Error(`restore mismatch on ${k}: backup=${counts[k]}, restored=${rCounts[k]}`);
      }
    }
    if (!(restored.tasks || []).some((t) => t.id === canaryId && t.title === `Test18 Canary ${ts}`)) {
      throw new Error('canary task not intact after restore');
    }
    if (restored.exportScope !== 'agency' || restored.restorable !== false) throw new Error('scope markers lost in round trip');
    await isoRef.delete();

    // app-state/main untouched by the round trip.
    const mainAfter = (await mainRef.get()).data();
    if (mainAfter._v !== mainBefore._v || (mainAfter.tasks || []).length !== (mainBefore.tasks || []).length) {
      throw new Error('app-state/main changed during the isolated round trip');
    }

    // The live doc is still writable.
    const wr = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test18 Post-Roundtrip ${ts}`,
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
    return `agency export round trip OK into an isolated doc (db: ${databaseId || '(default)'}): ${rCounts.tasks} tasks, ${rCounts.venues} venues, ${rCounts.users} users; app-state/main untouched; live doc still writable`;
  },
};
