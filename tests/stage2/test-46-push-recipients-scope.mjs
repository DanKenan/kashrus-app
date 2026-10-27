/**
 * Test 46 (item 8t): task push alerts reach only the task's own agency, and
 * only the recipient's OWN identity-bound devices.
 *
 * Before 8t: the overdue alert for an 'all' task pushed every venue-less user
 * (in practice the admins) of EVERY agency; explicit-assignee and task-create
 * pushes went to any listed email; delivery matched subscriptions by email only.
 * Proves (plan "Agreed — ChatGPT — 8t plan v3"), asserting on ENDPOINTS from the
 * test-only push log (recorded before any network send):
 *  O1 overdue 'all' task in A → A's venue users only (ADMINALL, Oct 27: an agency
 *     admin is not part of a venue's 'All'); no A or B admin, no other-venue user
 *  O2 overdue explicit [A user, B user, unknown] → the A user only
 *  O3 private task: an assignee who cannot see it (other venue) → nothing;
 *     positive twin → pushed
 *  C  task create with [A user, B user, creator] → the A user only
 *  L  a legacy (no userId) subscription is never used for task pushes
 *  E  every endpoint targeted is one the recipient subscribed with themselves
 *  D  deleting a user removes their subscriptions (id-bound + legacy) in the same
 *     commit; the same email re-created in agency B never reaches the old devices
 */
const A = 'agency-test46-a';
const B = 'agency-test46-b';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

export default {
  name: 'Test 46: task push alerts are agency-scoped and identity-bound (8t)',
  whatItProves:
    'Overdue and task-create pushes reach only users of the task\'s agency who may see the task, and only through subscriptions bound to that user\'s id + agency; legacy and deleted users\' devices are never targeted.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t46-a1-${ts}`, vA2 = `venue-t46-a2-${ts}`, vB1 = `venue-t46-b1-${ts}`;
    const id = (k) => `user-t46-${k}-${ts}`;
    const em = (k) => `t46-${k}-${ts}@test.local`;
    const ep = (k) => `https://push.test.invalid/t46-${k}-${ts}`;
    const keys = ['admina', 'coorda1', 'masha1', 'masha2', 'adminb', 'mashb1', 'victim'];
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T46 Admin A', role: 'admin', agencyId: A },
      { id: id('coorda1'), email: em('coorda1'), name: 'T46 Coord A1', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('masha1'), email: em('masha1'), name: 'T46 Mash A1', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('masha2'), email: em('masha2'), name: 'T46 Mash A2', role: 'mashgiach', agencyId: A, venueId: vA2 },
      { id: id('adminb'), email: em('adminb'), name: 'T46 Admin B', role: 'admin', agencyId: B },
      { id: id('mashb1'), email: em('mashb1'), name: 'T46 Mash B1', role: 'mashgiach', agencyId: B, venueId: vB1 },
      { id: id('victim'), email: em('victim'), name: 'T46 Victim', role: 'mashgiach', agencyId: A, venueId: vA1 },
    ];
    const task = (k, extra) => ({
      id: `task-t46-${k}-${ts}`, agencyId: A, venueId: vA1, title: `T46 ${k} ${ts}`, category: 'General',
      targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true, isCompleted: false,
      priority: 'medium', status: 'pending', ...extra,
    });
    const tasks = [
      task('all', { assignedTo: ['all'] }),
      task('exp', { assignedTo: [em('masha1'), em('mashb1').toUpperCase(), `nobody-t46-${ts}@test.local`] }),
      task('privno', { assignedTo: [em('masha2')], isPrivate: true }),
      task('privyes', { assignedTo: [em('masha1')], isPrivate: true }),
    ];
    // Park every venue's work date so the pinned clock never rolls anything (as Test 40).
    const doc0 = await ctx.getDoc();
    const savedDates = { ...(doc0.venueWorkDates || {}) };
    const park = {};
    for (const v of doc0.venues || []) if (v && v.id) park[v.id] = '2099-12-31';
    for (const v of [vA1, vA2, vB1]) park[v] = '2099-12-31';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T46 A ${ts}` }, { id: B, name: `T46 B ${ts}` }],
      venues: [
        { id: vA1, name: `T46 A1 ${ts}`, agencyId: A },
        { id: vA2, name: `T46 A2 ${ts}`, agencyId: A },
        { id: vB1, name: `T46 B1 ${ts}`, agencyId: B },
      ],
      users: people,
      tasks,
      venueWorkDates: park,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const k of keys) tok[k] = auth(await mintToken(baseUrl, id(k)));
    // Every user subscribes ONE device through the real endpoint (identity-bound).
    const owner = {};
    for (const k of keys) {
      const r = await fetch(`${baseUrl}/api/push/subscribe`, {
        method: 'POST', headers: tok[k],
        body: JSON.stringify({ userEmail: 'ignored@x', subscription: { endpoint: ep(k), keys: { p256dh: 'p', auth: 'a' } } }),
      });
      assert(r.status === 200, `subscribe ${k}: ${r.status}`);
      owner[ep(k)] = id(k);
    }
    // A LEGACY record (no userId) under masha1's email — never used for task pushes.
    const legacyEp = ep('legacy-masha1');
    const sl = await ctx.api('POST', '/api/__test__/seed-legacy-push-sub', { subEmail: em('masha1'), endpoint: legacyEp });
    assert(sl.status === 200, `seed legacy: ${sl.status}`);
    const stored = ((await ctx.getDoc()).pushSubscriptions || []).find((s) => s.endpoint === ep('masha1'));
    assert(stored && stored.userId === id('masha1') && stored.agencyId === A && stored.userEmail === em('masha1'), 'subscribe stores the verified userId + agencyId (body userEmail ignored)');
    const legacyRec = ((await ctx.getDoc()).pushSubscriptions || []).find((s) => s.endpoint === legacyEp);
    assert(legacyRec && !legacyRec.userId && legacyRec.userEmail === em('masha1'), 'legacy record seeded under masha1\'s email with no userId');

    const logFor = async (title) => {
      const r = await ctx.api('GET', '/api/__test__/push-log');
      assert(r.status === 200, `push-log: ${r.status}`);
      return (r.json.log || []).filter((e) => e.title === title);
    };
    const checkEndpoints = (entries, label) => {
      for (const e of entries) {
        assert(e.path === 'identity', `${label}: identity-bound path, got ${e.path}`);
        assert(e.endpoint !== legacyEp, `${label}: legacy subscription targeted`);
        assert(owner[e.endpoint] && owner[e.endpoint] === e.recipientUserId, `${label}: endpoint ${e.endpoint} is not the recipient's own device`);
      }
    };
    const recips = (entries) => [...new Set(entries.map((e) => e.recipientUserId))].sort();
    const want = (...ks) => ks.map(id).sort();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    try {
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const ck = await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-10T20:00:00Z' }); // NY 15:00
      assert(ck.status === 200, `clock: ${ck.status}`);
      const ov = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      assert(ov.status === 200, `overdue-check: ${ov.status}`);

      // O1
      const o1 = await logFor(`Overdue: T46 all ${ts}`);
      checkEndpoints(o1, 'O1');
      assert(same(recips(o1), want('coorda1', 'masha1', 'victim')), `O1 'all' recipients: ${JSON.stringify(recips(o1))}`);
      assert(!o1.some((e) => e.endpoint === ep('admina') || e.endpoint === ep('adminb') || e.endpoint === ep('mashb1') || e.endpoint === ep('masha2')), 'O1: no B user and no other-venue user');
      // O2
      const o2 = await logFor(`Overdue: T46 exp ${ts}`);
      checkEndpoints(o2, 'O2');
      assert(same(recips(o2), want('masha1')), `O2 explicit recipients: ${JSON.stringify(recips(o2))}`);
      // O3
      const o3no = await logFor(`Overdue: T46 privno ${ts}`);
      assert(o3no.length === 0, `O3: an assignee who cannot see the private task must get nothing, got ${JSON.stringify(recips(o3no))}`);
      const o3yes = await logFor(`Overdue: T46 privyes ${ts}`);
      checkEndpoints(o3yes, 'O3+');
      assert(same(recips(o3yes), want('masha1')), `O3 positive twin: ${JSON.stringify(recips(o3yes))}`);
      // L (legacy never used, across everything logged for this test)
      const all46 = ((await ctx.api('GET', '/api/__test__/push-log')).json.log || []).filter((e) => String(e.endpoint).includes(`-${ts}`));
      assert(!all46.some((e) => e.endpoint === legacyEp), 'L: legacy subscription never targeted');

      // C: task create pushes the explicit in-agency assignee only (creator skipped).
      const title = `T46 create ${ts}`;
      const cr = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: tok.admina,
        body: JSON.stringify({ venueId: vA1, title, category: 'General', targetTime: '11:00 AM', assignedTo: [em('masha1'), em('mashb1'), em('admina')], createdByEmail: em('admina'), operationId: `op-t46-${ts}` }),
      });
      assert(cr.status === 201 || cr.status === 200, `task create: ${cr.status} ${(await cr.text()).slice(0, 120)}`);
      const c = (await ctx.api('GET', '/api/__test__/push-log')).json.log.filter((e) => e.title === '📋 New task assigned to you' && String(e.endpoint).includes(`-${ts}`));
      checkEndpoints(c, 'C');
      assert(same(recips(c), want('masha1')), `C create recipients: ${JSON.stringify(recips(c))}`);

      // D: delete removes subscriptions (id-bound + legacy) in the same commit.
      const legacyVictim = ep('legacy-victim');
      await ctx.api('POST', '/api/__test__/seed-legacy-push-sub', { subEmail: em('victim'), endpoint: legacyVictim });
      const v0 = await ctx.getVersion();
      const del = await fetch(`${baseUrl}/api/users/${id('victim')}`, { method: 'DELETE', headers: tok.admina, body: JSON.stringify({ expectedVersion: v0 }) });
      assert(del.status === 200, `delete victim: ${del.status} ${(await del.text()).slice(0, 120)}`);
      const docD = await ctx.getDoc();
      const left = (docD.pushSubscriptions || []).filter((s) => s.userId === id('victim') || s.endpoint === ep('victim') || s.endpoint === legacyVictim);
      assert(left.length === 0, `D: the deleted user's subscriptions must be gone, left ${JSON.stringify(left.map((s) => s.endpoint))}`);
      assert((await ctx.getVersion()) === v0 + 1, 'D: user + subscriptions removed in ONE commit');
      // The same email re-created in agency B, assigned an overdue B task: old devices never targeted.
      const reId = `user-t46-reborn-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', {
        users: [{ id: reId, email: em('victim'), name: 'T46 Reborn', role: 'mashgiach', agencyId: B, venueId: vB1 }],
        tasks: [{ ...task('reborn', { assignedTo: [em('victim')] }), agencyId: B, venueId: vB1 }],
      });
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      const re = await logFor(`Overdue: T46 reborn ${ts}`);
      assert(!re.some((e) => e.endpoint === ep('victim') || e.endpoint === legacyVictim), 'D: the deleted user\'s old devices must never be targeted');
      assert(re.length === 0, `D: the reborn user has no bound device yet, so nothing is sent: ${JSON.stringify(re)}`);
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null }).catch(() => {});
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true }).catch(() => {});
      try {
        const now = (await ctx.getDoc()).venueWorkDates || {};
        const patch = { ...savedDates };
        for (const k of Object.keys(now)) if (!(k in patch)) patch[k] = null;
        await ctx.api('POST', '/api/__test__/inject-fixture', { venueWorkDates: patch });
      } catch {}
    }
    // G: the test-only hooks do not exist outside test mode (404), and come back with it.
    if (typeof ctx.restartServer === 'function') {
      const hooks = [
        ['GET', '/api/__test__/push-log'],
        ['POST', '/api/__test__/push-log/clear'],
        ['POST', '/api/__test__/seed-legacy-push-sub'],
      ];
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        for (const [method, path] of hooks) {
          const r = await fetch(`${baseUrl}${path}`, { method, headers: ctx.authHeaders, body: method === 'POST' ? JSON.stringify({ subEmail: 'x@y', endpoint: 'https://push.test.invalid/g' }) : undefined });
          assert(r.status === 404, `G: ${method} ${path} must be 404 outside test mode, got ${r.status}`);
        }
      } finally {
        await ctx.restartServer();
      }
      const back = await ctx.api('GET', '/api/__test__/push-log');
      assert(back.status === 200, `G: hooks back in test mode: ${back.status}`);
    }
    return 'test-only hooks 404 outside test mode; task pushes: overdue all → A venue users only (no admins); explicit → in-agency visible assignee only; private invisible → none; create → A assignee only; legacy never used; endpoints = recipient\'s own; delete removes subs in one commit, reborn email never reaches old devices';
  },
};
