/**
 * Test 89 (ADMINALL, approved by Don 12:55 PM Oct 27, 2026): the agency admin
 * is NOT part of a venue's "All" team for task notifications.
 *
 * Before: taskPushRecipients put every admin of the task's agency into an
 * 'all' task's recipients, so an admin got the overdue alert of every venue.
 * Now 'all' = the users at the task's venue (personAtVenue); an admin gets a
 * task push only when the task names them. Visibility and control unchanged.
 * Proves, on ENDPOINTS from the test-only push log (agencies A and B):
 *  A  overdue 'all' task at A1 → A1's staff (coordinator, owner, manager,
 *     mashgiach, worker) only; NOT A's admin, NOT an A admin whose row carries
 *     a home venueId of A1, NOT B's admin, NOT another venue's mashgiach, NOT a
 *     B user, NOT an unknown-role row at A1
 *  B  overdue empty assignedTo ([], treated as 'all') → the same staff set, no admin
 *  C  overdue 'Specific' [A admin] → the A admin only
 *  D  overdue [A admin, A1 mashgiach] → exactly those two
 *  E  overdue ['all', A admin] → A1 staff + the named A admin (not the other admin)
 *  F  overdue [B admin] on an A task → nobody (other agency never named in)
 *  G  overdue private 'all' task → only the A1 coordinator (existing private rule), no admin
 *  H  overdue 'all' task at A2 → A2's mashgiach only
 *  I  new-task push: a coordinator creates [A admin] → the admin is pushed;
 *     'all' → nobody (unchanged explicit-only create path)
 *  V  the A admin still lists every one of these A1 tasks (visibility unchanged)
 */
const A = 'agency-test89-a';
const B = 'agency-test89-b';
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
  name: 'Test 89: agency admin is not in a venue\'s "All" task alerts (ADMINALL)',
  whatItProves:
    'An overdue alert for a task assigned to "All" reaches the venue\'s own staff only; an agency admin is pushed only when the task names them; the admin still sees the tasks.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t89-a1-${ts}`, vA2 = `venue-t89-a2-${ts}`, vB1 = `venue-t89-b1-${ts}`;
    const id = (k) => `user-t89-${k}-${ts}`;
    const em = (k) => `t89-${k}-${ts}@test.local`;
    const ep = (k) => `https://push.test.invalid/t89-${k}-${ts}`;
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T89 Admin A', role: 'admin', agencyId: A },
      { id: id('adminah'), email: em('adminah'), name: 'T89 Admin A (home A1)', role: 'admin', agencyId: A, venueId: vA1 },
      { id: id('coorda1'), email: em('coorda1'), name: 'T89 Coord A1', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('ownera1'), email: em('ownera1'), name: 'T89 Owner A1', role: 'owner', agencyId: A, venueId: vA1 },
      { id: id('mgra1'), email: em('mgra1'), name: 'T89 Manager A1', role: 'manager', agencyId: A, venueId: vA1 },
      { id: id('masha1'), email: em('masha1'), name: 'T89 Mash A1', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('worka1'), email: em('worka1'), name: 'T89 Worker A1', role: 'worker', agencyId: A, venueId: vA1 },
      { id: id('unka1'), email: em('unka1'), name: 'T89 Unknown Role A1', role: 'supervisor', agencyId: A, venueId: vA1 },
      { id: id('masha2'), email: em('masha2'), name: 'T89 Mash A2', role: 'mashgiach', agencyId: A, venueId: vA2 },
      { id: id('adminb'), email: em('adminb'), name: 'T89 Admin B', role: 'admin', agencyId: B },
      { id: id('mashb1'), email: em('mashb1'), name: 'T89 Mash B1', role: 'mashgiach', agencyId: B, venueId: vB1 },
    ];
    const keys = people.map((p) => p.id.replace(`user-t89-`, '').replace(`-${ts}`, ''));
    const task = (k, extra) => ({
      id: `task-t89-${k}-${ts}`, agencyId: A, venueId: vA1, title: `T89 ${k} ${ts}`, category: 'General',
      targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true, isCompleted: false,
      priority: 'medium', status: 'pending', createdAt: '2026-11-10T12:00:00.000Z', ...extra,
    });
    const tasks = [
      task('all', { assignedTo: ['all'] }),
      task('empty', { assignedTo: [] }),
      task('admin', { assignedTo: [em('admina')] }),
      task('adminmash', { assignedTo: [em('admina').toUpperCase(), em('masha1')] }),
      task('alladmin', { assignedTo: ['all', em('admina')] }),
      task('adminb', { assignedTo: [em('adminb')] }),
      task('privall', { assignedTo: ['all'], isPrivate: true }),
      task('a2all', { assignedTo: ['all'], venueId: vA2 }),
    ];
    // Park every venue's work date so the pinned clock never rolls anything (as Tests 40/46).
    const doc0 = await ctx.getDoc();
    const savedDates = { ...(doc0.venueWorkDates || {}) };
    const park = {};
    for (const v of doc0.venues || []) if (v && v.id) park[v.id] = '2099-12-31';
    for (const v of [vA1, vA2, vB1]) park[v] = '2099-12-31';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T89 A ${ts}` }, { id: B, name: `T89 B ${ts}` }],
      venues: [
        { id: vA1, name: `T89 A1 ${ts}`, agencyId: A },
        { id: vA2, name: `T89 A2 ${ts}`, agencyId: A },
        { id: vB1, name: `T89 B1 ${ts}`, agencyId: B },
      ],
      users: people,
      tasks,
      venueWorkDates: park,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    const owner = {};
    for (const k of keys) {
      // The unknown-role row gets no session (fail closed, #169); it subscribes nothing.
      if (k === 'unka1') continue;
      tok[k] = auth(await mintToken(baseUrl, id(k)));
      const r = await fetch(`${baseUrl}/api/push/subscribe`, {
        method: 'POST', headers: tok[k],
        body: JSON.stringify({ subscription: { endpoint: ep(k), keys: { p256dh: 'p', auth: 'a' } } }),
      });
      assert(r.status === 200, `subscribe ${k}: ${r.status}`);
      owner[ep(k)] = id(k);
    }

    const logFor = async (title) => {
      const r = await ctx.api('GET', '/api/__test__/push-log');
      assert(r.status === 200, `push-log: ${r.status}`);
      return (r.json.log || []).filter((e) => e.title === title);
    };
    const recips = (entries, label) => {
      for (const e of entries) {
        assert(e.path === 'identity', `${label}: identity-bound path, got ${e.path}`);
        assert(owner[e.endpoint] === e.recipientUserId, `${label}: endpoint ${e.endpoint} is not the recipient's own device`);
      }
      return [...new Set(entries.map((e) => e.recipientUserId))].sort();
    };
    const want = (...ks) => ks.map(id).sort();
    const J = JSON.stringify;
    const staffA1 = ['coorda1', 'ownera1', 'mgra1', 'masha1', 'worka1'];
    const check = async (k, expectKeys, label) => {
      const got = recips(await logFor(`Overdue: T89 ${k} ${ts}`), label);
      assert(J(got) === J(want(...expectKeys)), `${label} recipients: got ${J(got)}, want ${J(want(...expectKeys))}`);
      return got;
    };

    try {
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const ck = await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-10T20:00:00Z' }); // NY 15:00, after 10:00 AM
      assert(ck.status === 200, `clock: ${ck.status}`);
      const ov = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      assert(ov.status === 200, `overdue-check: ${ov.status}`);
      const notified = ov.json.notified || [];
      for (const t of tasks) assert(notified.some((n) => n.startsWith(`${t.id}:`)), `overdue-check did not process ${t.id}: ${J(notified.filter((n) => n.includes('t89')))}`);

      const a = await check('all', staffA1, 'A');
      for (const k of ['admina', 'adminah', 'adminb', 'masha2', 'mashb1', 'unka1']) assert(!a.includes(id(k)), `A: ${k} must not get an 'All' alert`);
      await check('empty', staffA1, 'B');
      await check('admin', ['admina'], 'C');
      await check('adminmash', ['admina', 'masha1'], 'D');
      await check('alladmin', [...staffA1, 'admina'], 'E');
      await check('adminb', [], 'F');
      await check('privall', ['coorda1'], 'G');
      await check('a2all', ['masha2'], 'H');

      // I: the create path (explicit only) still pushes a NAMED admin; 'all' pushes nobody.
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const create = async (k, assignedTo) => {
        const r = await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST', headers: tok.coorda1,
          body: J({ venueId: vA1, title: `T89 new ${k} ${ts}`, category: 'General', targetTime: '11:00 AM', assignedTo, createdByEmail: em('coorda1'), operationId: `op-t89-${k}-${ts}` }),
        });
        assert(r.status === 201 || r.status === 200, `create ${k}: ${r.status} ${(await r.text()).slice(0, 160)}`);
      };
      await create('admin', [em('admina')]);
      await create('all', ['all']);
      const newLog = ((await ctx.api('GET', '/api/__test__/push-log')).json.log || []).filter((e) => e.title === '📋 New task assigned to you' && String(e.endpoint).includes(`-${ts}`));
      const newRecips = recips(newLog, 'I');
      assert(J(newRecips) === J(want('admina')), `I: create pushes only the named admin, got ${J(newRecips)}`);

      // V: visibility unchanged — the admin still lists every A1 task (incl. private 'all').
      const lr = await fetch(`${baseUrl}/api/tasks?venueId=${encodeURIComponent(vA1)}`, { headers: tok.admina });
      assert(lr.status === 200, `V: admin list tasks: ${lr.status}`);
      const lj = await lr.json();
      const listed = new Set((Array.isArray(lj) ? lj : lj.tasks || []).map((t) => t.id));
      for (const t of tasks.filter((x) => x.venueId === vA1)) assert(listed.has(t.id), `V: admin must still see ${t.id}`);
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
    return "overdue 'All' → the venue's staff only (coordinator/owner/manager/mashgiach/worker), never an admin (also one with a home venueId), other venue or agency, or unknown role; empty = All; a named admin is pushed (alone, with staff, or beside 'all'); B admin named on an A task → nobody; private All → coordinator only; create pushes a named admin, 'all' nobody; admin still sees every task";
  },
};
