/**
 * Test 55 (item D8s): GET /api/admin/dashboard counts "overdue" in each
 * venue's OWN time zone, and its people list carries the real stored phone
 * number only where Rule N already allows it.
 *
 *  1 two venues of one agency, America/Los_Angeles and Asia/Jerusalem, each
 *    with an incomplete 10:00 AM task; the test clock pinned to 16:30 UTC of
 *    today (LA 08:30-09:30, Jerusalem 18:30-19:30 depending on DST): LA
 *    overdue 0, Jerusalem overdue 1
 *  2 people per card: only NON-ADMIN people whose 9a venue scope (home or
 *    granted) includes that venue; admins never listed; a task assigned to
 *    'all' (or to the admin) pulls nobody onto a card
 *  3 phones: the admin sees each listed person's stored phoneNumber; a
 *    coordinator sees it for mashgichim sharing a venue; no number -> ''
 *  4 agency B's admin sees none of agency A
 */
function assert(c, m) { if (!c) throw new Error(m); }
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 55: dashboard overdue per venue zone + real phone (D8s)',
  whatItProves:
    'The admin dashboard decides "overdue" by each venue\'s own clock (not the server\'s), and shows a stored phone number only to a recipient who manages that person; nothing crosses agencies.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t55a-${ts}`, B = `agency-t55b-${ts}`;
    const VLA = `venue-t55-la-${ts}`, VJ = `venue-t55-j-${ts}`, VB = `venue-t55-b-${ts}`;
    const U = (k) => `user-t55-${k}-${ts}`;
    const E = (k) => `t55-${k}-${ts}@test.local`;
    const PW = 'stage2-t55-password';
    const PH = { adminA: '+18605550101', coordA: '+18605550102', mashLA: '+18605550103', mashG: '+18605550104' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const write = async (method, path, token, body) => call(method, path, auth(token), { ...body, expectedVersion: await ctx.getVersion() });
    const hook = async (path, body) => {
      const r = await ctx.api('POST', `/api/__test__/${path}`, body);
      assert(r.status === 200, `${path} ${r.status} ${J(r.json)}`);
      return r.json;
    };
    const login = async (k) => {
      const r = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E(k), password: PW });
      assert(r.status === 200 && r.json?.token, `login ${k} ${r.status}`);
      return r.json.token;
    };
    const task = (id, v, extra = {}) => ({ id, agencyId: A, venueId: v, title: `T55 ${id}`, isCompleted: false, inputType: 'toggle', category: 'General', targetTime: '10:00 AM', targetTimeMinutes: 600, createdAt: new Date().toISOString(), ...extra });

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T55 A ${ts}`, shortCode: 'T55A', adminEmail: E('adminA') },
        { id: B, name: `T55 B ${ts}`, shortCode: 'T55B', adminEmail: E('adminB') },
      ],
      venues: [
        { id: VLA, name: 'T55 LA', agencyId: A, timeZone: 'America/Los_Angeles' },
        { id: VJ, name: 'T55 Jerusalem', agencyId: A, timeZone: 'Asia/Jerusalem' },
        { id: VB, name: 'T55 B', agencyId: B },
      ],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T55 Admin A', role: 'admin', agencyId: A, phoneNumber: PH.adminA },
        { id: U('coordA'), email: E('coordA'), name: 'T55 Coord A', role: 'coordinator', agencyId: A, venueId: VLA, phoneNumber: PH.coordA },
        { id: U('mashLA'), email: E('mashLA'), name: 'T55 Mash LA', role: 'mashgiach', agencyId: A, venueId: VLA, phoneNumber: PH.mashLA },
        { id: U('mashJ'), email: E('mashJ'), name: 'T55 Mash J', role: 'mashgiach', agencyId: A, venueId: VJ },
        { id: U('mashG'), email: E('mashG'), name: 'T55 Mash G', role: 'mashgiach', agencyId: A, venueId: VJ, phoneNumber: PH.mashG },
        { id: U('adminB'), email: E('adminB'), name: 'T55 Admin B', role: 'admin', agencyId: B },
      ],
      // assignments must not pull anyone onto a card: LA's task names the
      // admin, Jerusalem's is assigned to 'all'
      tasks: [task(`task-t55-la-${ts}`, VLA, { assignedTo: [E('adminA')] }), task(`task-t55-j-${ts}`, VJ, { assignedTo: ['all'] })],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'coordA', 'adminB']) await hook('set-password', { userId: U(k), password: PW });
    const tAdminA = await login('adminA'), tCoordA = await login('coordA'), tAdminB = await login('adminB');
    // grant mashG (home Jerusalem) the LA venue (9a grant)
    r = await write('PUT', `/api/users/${U('mashG')}/venues`, tAdminA, { venueIds: [VLA], expectedVenueIds: [VJ] });
    assert(r.status === 200 && J(r.json?.venueIds) === J([VJ, VLA]), `grant mashG LA ${r.status} ${r.text.slice(0, 200)}`);
    const dash = async (tok) => {
      const d = await call('GET', '/api/admin/dashboard', auth(tok));
      assert(d.status === 200, `dashboard ${d.status} ${d.text.slice(0, 120)}`);
      return Object.fromEntries((d.json?.venues || []).map((v) => [v.venue.id, v]));
    };

    // ---- 1. overdue by the venue's own clock ----
    const day = new Date().toISOString().slice(0, 10);
    await hook('clock', { iso: `${day}T16:30:00.000Z` });
    try {
      const d = await dash(tAdminA);
      assert(d[VLA] && d[VJ], `both venues listed ${J(Object.keys(d))}`);
      assert(d[VLA].overdueTasks === 0, `LA (before 10:00 local) must not be overdue: ${J(d[VLA].overdueTaskList)}`);
      assert(d[VJ].overdueTasks === 1 && d[VJ].overdueTaskList[0]?.id === `task-t55-j-${ts}`, `Jerusalem (after 10:00 local) must be overdue: ${J(d[VJ].overdueTaskList)}`);

      // ---- 2. people per card ----
      const people = (v) => (v.mashgichim || []).map((p) => p.email).sort();
      const sortE = (ks) => ks.map(E).sort();
      assert(J(people(d[VLA])) === J(sortE(['coordA', 'mashLA', 'mashG'])), `LA card people ${J(people(d[VLA]))}`);
      assert(J(people(d[VJ])) === J(sortE(['mashJ', 'mashG'])), `Jerusalem card people ('all' task pulls nobody) ${J(people(d[VJ]))}`);
      for (const v of Object.values(d)) for (const p of v.mashgichim || []) {
        assert(p.role !== 'admin' && p.email !== E('adminA'), `admins are never listed ${J(p)}`);
        assert(Object.keys(p).sort().join() === 'email,name,phone,role', `people shape unchanged ${J(p)}`);
      }

      // ---- 3. phones ----
      const ph = (v, k) => (v.mashgichim || []).find((p) => p.email === E(k));
      assert(ph(d[VLA], 'mashLA')?.phone === PH.mashLA, `admin sees mashgiach phone ${J(ph(d[VLA], 'mashLA'))}`);
      assert(ph(d[VLA], 'coordA')?.phone === PH.coordA, `admin sees coordinator phone ${J(ph(d[VLA], 'coordA'))}`);
      assert(ph(d[VLA], 'mashG')?.phone === PH.mashG && ph(d[VJ], 'mashG')?.phone === PH.mashG, `admin sees granted mashgiach phone on both cards`);
      assert(ph(d[VJ], 'mashJ')?.phone === '', `no number = '' ${J(ph(d[VJ], 'mashJ'))}`);
      const c = await dash(tCoordA);
      assert(c[VLA] && !c[VJ], `coordinator scope ${J(Object.keys(c))}`);
      assert(J(people(c[VLA])) === J(sortE(['coordA', 'mashLA', 'mashG'])), `coordinator LA card people ${J(people(c[VLA]))}`);
      assert(ph(c[VLA], 'mashLA')?.phone === PH.mashLA, `coordinator sees shared-venue mashgiach phone ${J(ph(c[VLA], 'mashLA'))}`);
      assert(ph(c[VLA], 'mashG')?.phone === PH.mashG, `coordinator sees the granted (shared LA) mashgiach phone ${J(ph(c[VLA], 'mashG'))}`);
      assert(!J(c).includes(PH.adminA), 'coordinator never sees the admin phone');

      // ---- 4. no cross-agency ----
      const b = await dash(tAdminB);
      assert(!J(b).includes(VLA) && !J(b).includes(VJ) && !J(b).includes(PH.mashLA), 'agency B sees none of A');
    } finally {
      await hook('clock', { iso: null });
    }
    return 'overdue decided per venue zone (LA 0, Jerusalem 1 at 16:30 UTC); cards list only non-admin people whose home/granted scope includes the venue (assignments pull nobody, admins never listed); phone = stored phoneNumber only for managers, \'\' otherwise, shape unchanged; agency B sees none of A';
  },
};
