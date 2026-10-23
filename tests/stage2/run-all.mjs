/**
 * Runs all 15 Stage 2 tests sequentially.
 * Each test module exports: { name, whatItProves, run(baseUrl, ctx) }
 * ctx provides shared helpers (api helpers, mock Firestore direct access).
 *
 * The server runs with FIRESTORE_MOCK=true, so Firestore state is inspected
 * via the test-only /api/__test__/firestore-doc endpoint (the mock lives in
 * the server's process and cannot be reached directly from here).
 *
 * Tests 11 and 14 are documentation-heavy by design: the harness cannot boot
 * the server with FORCE_LOCAL_MODE=true (test 11), and pushing a real 900KB
 * document through the API is impractical (test 14). Both verify what can be
 * verified automatically and document the manual steps in their headers.
 */
import { inviteAndAccept } from './invite-helpers.mjs';

export async function runAll(baseUrl, extraCtx = {}) {
  // Authenticate as the default admin user for all test requests.
  // The seed admin (kenan@hartfordkashrut.org, usr_admin) starts with no
  // password. Public first-run setup is closed since 8i, so the harness sets
  // it through the test-only endpoint (test mode only).
  // Admin bootstrap; run again after every fresh state (a wiped doc means a
  // new seed admin with no password and a new signing secret).
  const adminLogin = async () => {
    const setupRes = await fetch(`${baseUrl}/api/__test__/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_admin', password: 'stage2-test-password' }),
    });
    if (setupRes.status !== 200) {
      const t = await setupRes.text();
      throw new Error(`test password set failed: ${setupRes.status} ${t}`);
    }
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'kenan@hartfordkashrut.org', password: 'stage2-test-password' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) {
      throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginJson)}`);
    }
    const token = loginJson.token;
    return token;
  };
  const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await adminLogin()}` };

  const ctx = {
    baseUrl,
    ...extraCtx,
    authHeaders,
    async getVersion() {
      const r = await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: authHeaders });
      const j = await r.json();
      return j.version;
    },
    async getDoc() {
      const r = await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: authHeaders });
      const j = await r.json();
      return j.doc;
    },
    async api(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: authHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    },
    /**
     * Invites always on (Don 2026-10-22): the ONE production way to add a team
     * member — POST /api/users (a pending invite) then the invitee accepts the
     * link with their own password (mode 'new'). Returns the old POST /api/users
     * shape on success: { status: 201, json: { user } } (the admin's view of the
     * new row); any refusal comes back as { status, json } from the step that
     * refused. `headers` = the inviting admin's (default: the harness admin).
     */
    async addMember(body, headers = authHeaders) {
      const { password, ...inviteBody } = body || {};
      if (inviteBody.role !== 'admin' && !inviteBody.venueId) {
        // An invite names a real venue of the inviting agency (the old
        // admin-set-password path silently defaulted to 'venue-crown-market').
        const ag = await fetch(`${baseUrl}/api/agencies/current`, { headers });
        let agj = null; try { agj = await ag.json(); } catch {}
        const agencyId = agj?.agency?.id;
        const doc = await ctx.getDoc();
        let v = (doc.venues || []).find((x) => x && (x.agencyId || 'agency-hkc') === agencyId && !(doc.deletedVenueIds || []).includes(x.id));
        if (!v && agencyId) {
          v = { id: `venue-stage2-default-${agencyId}`, name: 'Stage2 default venue', agencyId };
          await fetch(`${baseUrl}/api/__test__/inject-fixture`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ venues: [v] }) });
        }
        if (v) inviteBody.venueId = v.id;
      }
      const r = await inviteAndAccept(baseUrl, headers, { ...inviteBody, password });
      return { status: r.status, json: r.json };
    },
  };

  // FRESH_STATE: the harness wipes ALL stored state and boots a fresh server
  // before the next test (see freshState in harness.mjs). Every stage2 test
  // shares one app-state doc, and the whole suite outgrew the server's
  // 900 KiB guard (local mock, main f662efb: 881 KiB before Test 68, which
  // then fails). Groups keep each stretch far below the cap; the biggest
  // writers are Test 30 (~250 KiB of incidents) and Test 49 (~130 KiB of
  // users). Tests are self-contained (their own ts-suffixed fixtures), so a
  // marker only goes BETWEEN tests. Add one when a group grows.
  const FRESH_STATE = { freshState: true };
  const tests = [
    (await import('./test-1-stale-write-blocked.mjs')).default,
    (await import('./test-2-concurrent-different-tasks.mjs')).default,
    (await import('./test-3-same-field-conflict.mjs')).default,
    (await import('./test-4-failed-write-no-trace.mjs')).default,
    (await import('./test-5-restart-no-resurrection.mjs')).default,
    (await import('./test-6-idempotency.mjs')).default,
    (await import('./test-7-retry-storm.mjs')).default,
    (await import('./test-8-password-reset-security.mjs')).default,
    (await import('./test-9-airtable-key-preservation.mjs')).default,
    (await import('./test-10-daily-reset.mjs')).default,
    (await import('./test-11-maintenance-mode.mjs')).default,
    (await import('./test-12-out-of-order-hydration.mjs')).default,
    (await import('./test-13-noop-detection.mjs')).default,
    (await import('./test-14-document-size-guard.mjs')).default,
    (await import('./test-15-frontend-smoke.mjs')).default,
    (await import('./test-16-scheduled-reset-broadcast.mjs')).default,
    (await import('./test-17-idempotency-op-scoping.mjs')).default,
    (await import('./test-18-isolated-restore.mjs')).default,
    (await import('./test-19-stale-form-baseline.mjs')).default,
    (await import('./test-20-staged-revision.mjs')).default,
    (await import('./test-21-staged-boot-no-writes.mjs')).default,
    (await import('./test-22-roster-privacy.mjs')).default,
    (await import('./test-23-private-tasks.mjs')).default,
    FRESH_STATE,
    (await import('./test-24-auth-sweep.mjs')).default,
    (await import('./test-25-kiosk-hardening.mjs')).default,
    (await import('./test-26-coordinator-venue-scope.mjs')).default,
    (await import('./test-27-kiosk-pairing.mjs')).default,
    (await import('./test-28-alert-grouping.mjs')).default,
    (await import('./test-29-updates-panel.mjs')).default,
    (await import('./test-30-alerts.mjs')).default,
    FRESH_STATE,
    (await import('./test-31-kiosk-device-seen-version.mjs')).default,
    (await import('./test-32-admin-kiosk-scope.mjs')).default,
    (await import('./test-33-kiosk-code-phone.mjs')).default,
    (await import('./test-35-kiosk-snapshot-allowlist.mjs')).default,
    (await import('./test-36-kiosk-code-generator.mjs')).default,
    (await import('./test-37-venue-timezones.mjs')).default,
    (await import('./test-38-dst-rollover.mjs')).default,
    (await import('./test-39-copy-event.mjs')).default,
    (await import('./test-40-any-time-tasks.mjs')).default,
    FRESH_STATE,
    (await import('./test-41-admin-export-scope.mjs')).default,
    (await import('./test-42-platform-routes.mjs')).default,
    (await import('./test-43-agency-fields.mjs')).default,
    (await import('./test-44-event-assignee-scope.mjs')).default,
    (await import('./test-45-venue-owner-scope.mjs')).default,
    (await import('./test-46-push-recipients-scope.mjs')).default,
    (await import('./test-47-identity-projections.mjs')).default,
    (await import('./test-48-history-retention.mjs')).default,
    (await import('./test-49-identity-migration.mjs')).default,
    FRESH_STATE,
    (await import('./test-50-session-tokens.mjs')).default,
    (await import('./test-51-reset-signout.mjs')).default,
    (await import('./test-52-clean-slate-removed.mjs')).default,
    (await import('./test-53-multi-venue.mjs')).default,
    (await import('./test-55-dashboard-zone-phone.mjs')).default,
    (await import('./test-54-certification-options.mjs')).default,
    (await import('./test-56-uniform-auth.mjs')).default,
    (await import('./test-57-identity-invariants.mjs')).default,
    (await import('./test-58-membership-isolation.mjs')).default,
    (await import('./test-59-projections-deletion.mjs')).default,
    (await import('./test-60-two-membership-matrix.mjs')).default,
    FRESH_STATE,
    (await import('./test-61-agency-logo.mjs')).default,
    (await import('./test-62-credential-owner-auth.mjs')).default,
    (await import('./test-63-recovery-codes.mjs')).default,
    (await import('./test-64-membership-switch.mjs')).default,
    (await import('./test-65-kiosk-agency-updated.mjs')).default,
    (await import('./test-66-venue-cert-edit.mjs')).default,
    (await import('./test-67-invites.mjs')).default,
    (await import('./test-68-invite-accept.mjs')).default,
    (await import('./test-69-send-invite.mjs')).default,
    (await import('./test-70-kiosk-session-3h.mjs')).default,
    (await import('./test-71-qa2-server.mjs')).default,
    (await import('./test-72-invites-enable.mjs')).default,
    (await import('./test-73-reset-links.mjs')).default,
    (await import('./test-74-qa2s2.mjs')).default,
    (await import('./test-75-register-existing.mjs')).default,
    (await import('./test-76-account-merge.mjs')).default,
    (await import('./test-77-server-sessions.mjs')).default,
    (await import('./test-78-cookie-sessions.mjs')).default,
    (await import('./test-79-kiosk-cookies.mjs')).default,
    (await import('./test-80-passkeys.mjs')).default,
    (await import('./test-81-venue-end-dates.mjs')).default,
    FRESH_STATE,
    (await import('./test-82-pool.mjs')).default,
  ];

  const docKiB = async () => Math.round(JSON.stringify(await ctx.getDoc()).length / 1024);
  const WARN_KIB = 700;
  const results = [];
  for (const t of tests) {
    if (t === FRESH_STATE) {
      if (!extraCtx.freshState) throw new Error('FRESH_STATE marker but the harness gave no freshState hook');
      console.log(`\n[state] ${await docKiB()} KiB before the fresh state`);
      await extraCtx.freshState();
      authHeaders.Authorization = `Bearer ${await adminLogin()}`;
      // Proof the wipe hit the server's own storage: the doc is back to the seed.
      const after = await docKiB();
      if (after > 8) throw new Error(`fresh state did not take: the state doc is still ${after} KiB`);
      console.log(`[state] ${after} KiB after the fresh state`);
      continue;
    }
    const kib = await docKiB();
    console.log(`\n[state] ${kib} KiB before ${t.name.split(':')[0]}`);
    if (kib > WARN_KIB) console.log(`[state] WARNING: ${kib} KiB > ${WARN_KIB} KiB (cap 900): add a FRESH_STATE marker in tests/stage2/run-all.mjs`);
    console.log(`\n--- ${t.name} ---`);
    console.log(`Proves: ${t.whatItProves}`);
    try {
      const detail = await t.run(baseUrl, ctx);
      console.log(`PASS: ${detail || 'ok'}`);
      results.push({ name: t.name, pass: true, detail: detail || 'ok' });
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      results.push({ name: t.name, pass: false, detail: err.message });
    }
  }
  return results;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
