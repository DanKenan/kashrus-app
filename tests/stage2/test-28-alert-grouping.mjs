/**
 * Test 28: Alert grouping routes (item 3).
 *
 * POST /api/internal/test-alert: without a session it refuses (401/403, as
 * today); with an admin session and no body it answers with today's exact
 * message; with {"mode":"demo"} it answers 200 with a grouped demo summary
 * that starts with the demo prefix and never uses the real consistency
 * prefix. POST /api/internal/consistency-check as admin runs the grouped
 * check: non-2xx in the test env (backup unconfigured), and the body carries
 * runId, issues (incl. backup-unconfigured) and the one summary line.
 * None of the three calls writes anything: the app-state doc _v is unchanged.
 */

export default {
  name: 'Test 28: Alert grouping routes',
  whatItProves:
    'Test-alert keeps its exact classic response, demo mode returns the grouped summary shape, and the consistency check returns one grouped summary (runId + issues + summary) without writing any data.',

  async run(baseUrl, ctx) {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const v0 = await ctx.getVersion();

    // 1. No session → refused, as today (the auth middleware answers 401;
    //    a non-admin session would get requireAdmin's 403).
    {
      const res = await fetch(`${baseUrl}/api/internal/test-alert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert(res.status === 401 || res.status === 403,
        `test-alert without a session must refuse (401/403), got ${res.status}`);
      console.log(`  ✓ test-alert without a session → ${res.status}`);
    }

    // 2. Admin, no body → today's response, byte-for-byte shape.
    {
      const r = await ctx.api('POST', '/api/internal/test-alert');
      assert(r.status === 200, `classic test-alert status ${r.status}`);
      assert(r.json?.ok === true, 'classic test-alert ok');
      assert(typeof r.json?.sentAt === 'string' && r.json.sentAt.length > 0, 'classic test-alert sentAt');
      assert(
        r.json?.message === 'Test alert logged. Check your email/phone for the Cloud Monitoring notification.',
        `classic test-alert message must be unchanged, got: ${r.json?.message}`
      );
      assert(!('mode' in (r.json || {})), 'classic test-alert must not carry a mode');
      assert(!('summary' in (r.json || {})), 'classic test-alert must not carry a summary');
      console.log('  ✓ admin test-alert (no body) → 200 with today\'s exact message');
    }

    // 3. Admin, {"mode":"demo"} → grouped demo summary.
    {
      const r = await ctx.api('POST', '/api/internal/test-alert', { mode: 'demo' });
      assert(r.status === 200, `demo test-alert status ${r.status}`);
      assert(r.json?.ok === true && r.json?.mode === 'demo', 'demo response shape');
      const s = r.json?.summary || '';
      assert(s.startsWith('[alert-test] TEST ALERT (demo'), `demo summary prefix: ${s.slice(0, 60)}`);
      assert(s.includes('not real data'), 'demo summary must say "not real data"');
      assert(!s.includes('[consistency] ERROR'), 'demo summary must never use the real prefix');
      assert(s.includes('12 issues: 7 mismatch-missing, 3 mismatch-field, 2 mismatch-orphan'),
        `demo summary counts: ${s}`);
      console.log('  ✓ admin test-alert (demo) → 200 with the grouped demo summary');
    }

    // 4. Admin consistency check → grouped body, non-2xx (backup unconfigured
    //    in the test env), no writes.
    {
      const r = await ctx.api('POST', '/api/internal/consistency-check');
      assert(r.status === 500, `consistency-check in test env must be non-2xx (500), got ${r.status}`);
      const b = r.json || {};
      assert(/^c-\d{8}-\d{4}-[0-9a-f]{4}$/.test(b.runId || ''), `runId shape: ${b.runId}`);
      assert(Array.isArray(b.issues) && b.issues.length > 0, 'issues must be a non-empty array');
      assert(b.issues.some((i) => i.type === 'backup-unconfigured'),
        `issues must include backup-unconfigured: ${JSON.stringify(b.issues.map((i) => i.type))}`);
      assert(typeof b.summary === 'string' && b.summary.startsWith(`[consistency] ERROR run=${b.runId}`),
        `summary must be the one grouped ERROR line: ${b.summary?.slice(0, 80)}`);
      assert(b.summary.endsWith(`Details: INFO lines run=${b.runId}`),
        `summary suffix: ${b.summary?.slice(-60)}`);
      assert(b.ok === false, 'consistency-check ok must be false');
      console.log('  ✓ admin consistency-check → 500 with runId, issues (backup-unconfigured), one summary');
    }

    // 5. No writes happened anywhere above.
    {
      const v1 = await ctx.getVersion();
      assert(v1 === v0, `app-state _v must be unchanged (${v0} → ${v1})`);
      console.log('  ✓ app-state _v unchanged after all three calls');
    }
  },
};
