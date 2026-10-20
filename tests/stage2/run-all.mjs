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
export async function runAll(baseUrl, extraCtx = {}) {
  // Authenticate as the default admin user for all test requests.
  // The seed admin (kenan@hartfordkashrut.org) starts with no password;
  // /api/auth/setup sets it on first use.
  const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kenan@hartfordkashrut.org', newPassword: 'stage2-test-password' }),
  });
  // 200 = setup done; 403 = already set up (from a previous run); both fine.
  if (setupRes.status !== 200 && setupRes.status !== 403) {
    const t = await setupRes.text();
    throw new Error(`auth setup failed: ${setupRes.status} ${t}`);
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
  const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

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
  };

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
    (await import('./test-24-auth-sweep.mjs')).default,
    (await import('./test-25-kiosk-hardening.mjs')).default,
    (await import('./test-26-coordinator-venue-scope.mjs')).default,
    (await import('./test-27-kiosk-pairing.mjs')).default,
    (await import('./test-28-alert-grouping.mjs')).default,
    (await import('./test-29-updates-panel.mjs')).default,
    (await import('./test-30-alerts.mjs')).default,
  ];

  const results = [];
  for (const t of tests) {
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
