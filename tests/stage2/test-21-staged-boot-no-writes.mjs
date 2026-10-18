/**
 * Test 21: Staged revision makes ZERO writes during boot (round 6).
 *
 * The defect: STAGED_REVISION=true blocked HTTP writes and background
 * intervals, but startServer() still ran four startup writes —
 * initResetPepper(), the normalize-task-order commitState, ensureVapidKeys(),
 * and migratePasswordsToBcrypt(). A staged revision could mutate Firestore
 * during boot, before the operator ever health-checked it.
 *
 * The fix: startServer() skips all four startup writes when
 * isStagedRevision() is true. Reads (initFirestore/loadStateFromFirestore)
 * stay.
 *
 * Method (unlike test 20, which toggles staged mode at runtime): do a REAL
 * process restart with STAGED_REVISION=true via the harness restart hook,
 * exercising the actual boot path.
 *   1. Record the Firestore doc version + canonical hash.
 *   2. Restart with { STAGED_REVISION: 'true' }.
 *   3. Doc version UNCHANGED, doc hash UNCHANGED (no startup writes).
 *   4. /api/health reports staged:true; a mutation returns 503.
 *   5. Restart back without the flag (clean state for later tests).
 */
import { createHash } from 'node:crypto';

function docHash(doc) {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
}

export default {
  name: 'Test 21: Staged boot writes nothing',
  whatItProves:
    'A server booted with STAGED_REVISION=true performs zero Firestore mutations during startup — doc version and hash identical before/after; reads and health work, writes refuse with 503.',

  async run(baseUrl, ctx) {
    if (!ctx.restartServer) {
      throw new Error('restartServer hook not provided by harness — cannot run');
    }

    // --- 1. Baseline: version + hash before the staged boot ---
    const vBefore = await ctx.getVersion();
    const docBefore = await ctx.getDoc();
    const hashBefore = docHash(docBefore);

    // --- 2. Real restart with STAGED_REVISION=true (actual boot path) ---
    await ctx.restartServer({ STAGED_REVISION: 'true' });

    // --- 3. Doc must be byte-identical: no startup writes happened ---
    const vAfter = await ctx.getVersion();
    if (vAfter !== vBefore) {
      throw new Error(`staged boot mutated Firestore: version ${vBefore} -> ${vAfter}`);
    }
    const docAfter = await ctx.getDoc();
    const hashAfter = docHash(docAfter);
    if (hashAfter !== hashBefore) {
      throw new Error(`staged boot changed doc content (hash ${hashBefore} -> ${hashAfter}) at same version`);
    }

    // --- 4. Staged behavior: health reports staged, mutations refuse ---
    const health = await ctx.api('GET', '/api/health');
    if (health.status !== 200) throw new Error(`health failed in staged boot: ${health.status}`);
    if (health.json.staged !== true) throw new Error('health does not report staged:true after staged boot');

    const v = await ctx.getVersion();
    const w = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: 'Test21 must not write',
      expectedVersion: v,
    });
    if (w.status !== 503) throw new Error(`staged boot allowed a write: ${w.status}`);
    const vStill = await ctx.getVersion();
    if (vStill !== vBefore) throw new Error('write attempt moved version in staged mode');

    // --- 4b. Indirect write via read path: an authenticated request triggers
    // getJwtSecret() -> commitState() (fire-and-forget persist). The
    // centralized commitState guard must block it — doc stays byte-identical.
    // This subtest is meaningful only when the doc has no persisted jwtSecret
    // (getJwtSecret only persists when the secret is missing); otherwise the
    // hash check above already covers it.
    const docNoSecret = await ctx.getDoc();
    if (docNoSecret.jwtSecret === undefined) {
      // Any request hitting the auth middleware invokes getJwtSecret().
      // In staged mode the old token is invalid (secret rotated at boot,
      // persist blocked) → 401 is fine; what matters is that the persist
      // path was exercised and blocked.
      const authed = await ctx.api('GET', '/api/tasks?venueId=venue-crown-market');
      if (authed.status !== 200 && authed.status !== 401) {
        throw new Error(`unexpected status in staged mode: ${authed.status}`);
      }
      const docAfterJwt = await ctx.getDoc();
      if (docHash(docAfterJwt) !== hashBefore) {
        throw new Error('getJwtSecret() persisted via read path in staged mode — central guard failed');
      }
      if ((await ctx.getVersion()) !== vBefore) {
        throw new Error('indirect write moved version in staged mode');
      }
    }

    // --- 5. Restart back to normal (clean state for subsequent tests) ---
    await ctx.restartServer({});
    const health2 = await ctx.api('GET', '/api/health');
    if (health2.json.staged) throw new Error('server still staged after normal restart');

    return `staged boot: version ${vBefore} unchanged, hash ${hashBefore} unchanged, health staged:true, mutation 503`;
  },
};
