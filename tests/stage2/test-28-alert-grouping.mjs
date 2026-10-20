/**
 * Test 28: Alert grouping routes (item 3; auth pattern fixed in fix round 1).
 *
 * Self-sufficient auth, same as test-27: inject one agency with one admin
 * and one mashgiach through /api/__test__/inject-fixture and mint both
 * tokens via /api/__test__/mint-token (ctx.api's seed-admin session does
 * not exist on the real-emulator path — the admin routes answered 401).
 *
 * Cases:
 * - No session: POST test-alert refuses (401).
 * - Mashgiach (requireAdmin gate): test-alert {}, test-alert {"mode":"demo"}
 *   and consistency-check all answer 403 — the gate runs before any log
 *   line is written (asserted on the response; the gate precedes the log
 *   call in the handlers).
 * - Admin classic test-alert: 200 with today's exact message.
 * - Admin demo test-alert: 200 with the grouped demo summary (demo prefix,
 *   never the real consistency prefix).
 * - Admin consistency-check: non-2xx in the test env (backup unconfigured),
 *   body carries runId, issues (incl. backup-unconfigured) and the one
 *   summary line.
 * - None of the calls writes anything: the app-state doc _v is unchanged.
 */

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export default {
  name: 'Test 28: Alert grouping routes',
  whatItProves:
    'Test-alert keeps its exact classic response for admins, demo mode returns the grouped summary shape, the requireAdmin gate refuses mashgiach calls (403) before any alert line, and the consistency check returns one grouped summary (runId + issues + summary) without writing any data.',

  async run(baseUrl, ctx) {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const post = async (path, headers, body) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };

    // Fixture: one agency, one venue, one admin, one mashgiach.
    const ts = Date.now();
    const AGENCY = `agency-test28-${ts}`;
    const VENUE = `venue-test28-${ts}`;
    const adminId = `user-test28-admin-${ts}`;
    const mashId = `user-test28-mash-${ts}`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AGENCY, name: 'Test28 Agency' }],
      venues: [{ id: VENUE, name: `T28 Venue ${ts}`, agencyId: AGENCY }],
      users: [
        { id: adminId, email: `admin28-${ts}@test.local`, name: 'T28 Admin', role: 'admin', agencyId: AGENCY },
        { id: mashId, email: `mash28-${ts}@test.local`, name: 'T28 Mashgiach', role: 'mashgiach', agencyId: AGENCY, venueId: VENUE },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, adminId);
    const tMash = await mintToken(baseUrl, mashId);
    const getVersion = async () => {
      const r = await fetch(`${baseUrl}/api/__test__/firestore-doc`, { headers: auth(tAdmin) });
      const j = await r.json();
      return j.version;
    };
    const v0 = await getVersion();

    // 1. No session → refused (401 from the auth middleware).
    {
      const r = await post('/api/internal/test-alert', { 'Content-Type': 'application/json' }, {});
      assert(r.status === 401 || r.status === 403,
        `test-alert without a session must refuse (401/403), got ${r.status}`);
      console.log(`  ✓ test-alert without a session → ${r.status}`);
    }

    // 2. Mashgiach → requireAdmin answers 403 on all three calls, before
    //    any alert/demo/summary line can be written.
    {
      const a = await post('/api/internal/test-alert', auth(tMash), {});
      assert(a.status === 403, `mashgiach classic test-alert must be 403, got ${a.status}`);
      const b = await post('/api/internal/test-alert', auth(tMash), { mode: 'demo' });
      assert(b.status === 403, `mashgiach demo test-alert must be 403, got ${b.status}`);
      assert(!b.json?.summary, 'mashgiach demo call must not produce a summary');
      const c = await post('/api/internal/consistency-check', auth(tMash), {});
      assert(c.status === 403, `mashgiach consistency-check must be 403, got ${c.status}`);
      assert(!c.json?.summary && !c.json?.runId, 'mashgiach consistency-check must not produce a run');
      console.log('  ✓ mashgiach → 403 on test-alert {}, test-alert demo, consistency-check');
    }

    // 3. Admin, no body → today's response, byte-for-byte shape.
    {
      const r = await post('/api/internal/test-alert', auth(tAdmin));
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

    // 4. Admin, {"mode":"demo"} → grouped demo summary.
    {
      const r = await post('/api/internal/test-alert', auth(tAdmin), { mode: 'demo' });
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

    // 5. Admin consistency check → grouped body, non-2xx (backup
    //    unconfigured in the test env), no writes.
    {
      const r = await post('/api/internal/consistency-check', auth(tAdmin), {});
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

    // 6. No writes happened anywhere above.
    {
      const v1 = await getVersion();
      assert(v1 === v0, `app-state _v must be unchanged (${v0} → ${v1})`);
      console.log('  ✓ app-state _v unchanged after all calls');
    }
  },
};
