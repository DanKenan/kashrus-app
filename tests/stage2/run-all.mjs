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
    FRESH_STATE,
    FRESH_STATE,
    FRESH_STATE,
    FRESH_STATE,
    FRESH_STATE,
    FRESH_STATE,
    FRESH_STATE,
    (await import('./test-97-read-budget.mjs')).default, // READCUT
    // MERGE-FIX: merges into the operator row and re-signs the suite's admin session; keep it LAST, after its own fresh state.
    FRESH_STATE,
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
