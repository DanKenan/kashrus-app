/**
 * Test 39: Copy event (item 7) — "task names only, never assignments."
 *
 * POST /api/events/:id/copy makes a NEW, independent event from an existing
 * one. Proves, on the real Firestore emulator:
 *  - the copy carries the event template only (title, location, times, task
 *    names with their description/category) — never the assignee (staff or
 *    external), task completion, completedBy, task notes, event notes, menu
 *    file, status or edit history; every id is new; the source is unchanged;
 *  - the stored record is an explicit allowlist (no other key rides along);
 *  - rule T on the server: admin = own agency, coordinator = own venue only;
 *    mashgiach / worker / owner, a coordinator at another venue and another
 *    agency's admin get 403 and nothing is written; no token → 401;
 *  - rule BR: the 201 comes only after the write is saved (the stored doc and
 *    GET /api/events already hold it); a failed commit (stale version) gives
 *    no 201 and stores nothing; a retry with the same operationId makes one
 *    event, not two;
 *  - dates: invalid dates → 400; "today" is the VENUE's local date (item 6),
 *    checked with the fake clock at an hour where Jerusalem is already on
 *    the next day while New York is not; multi-day spans are preserved;
 *  - the EVENT_CREATED broadcast reaches the venue's coordinator and not a
 *    coordinator at another venue or another agency's admin; a retry never
 *    re-broadcasts;
 *  - rule T is re-checked INSIDE the transaction: a coordinator moved to
 *    another venue, or a source deleted, in the committed doc while the
 *    cache still has the old state → 409 and nothing written.
 */

const AGENCY_X = 'agency-test39-x';
const AGENCY_Y = 'agency-test39-y';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve({ ws, messages }); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

const ALLOWED_EVENT_KEYS = new Set([
  'id', 'agencyId', 'venueId', 'venueName', 'title', 'location', 'date', 'endDate',
  'startTime', 'endTime', 'mashgiachType', 'notes', 'status', 'tasks',
  'createdByEmail', 'createdByName', 'createdAt',
]);
const ALLOWED_TASK_KEYS = ['category', 'description', 'id', 'isCompleted', 'notes', 'title'];

export default {
  name: 'Test 39: Copy event (task names only, never assignments)',
  whatItProves:
    'A copied event is a new, independent event carrying only the template (title, location, times, task names) — never assignees, completions, notes, files or history; rule T and rule BR are enforced on the server; dates follow the venue time zone.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vNY = `venue-test39-ny-${ts}`;
    const vJLM = `venue-test39-jlm-${ts}`;
    const vOther = `venue-test39-other-${ts}`;
    const vB = `venue-test39-b-${ts}`;
    const vGone = `venue-test39-gone-${ts}`;
    const ids = {
      adminX: `user-test39-adminx-${ts}`,
      coordNY: `user-test39-coordny-${ts}`,
      coordOther: `user-test39-coordother-${ts}`,
      mashNY: `user-test39-mashny-${ts}`,
      workerNY: `user-test39-workerny-${ts}`,
      ownerNY: `user-test39-ownerny-${ts}`,
      adminY: `user-test39-adminy-${ts}`,
    };
    const mashEmail = `mashny-${ts}@test.local`;
    const srcId = `evt-test39-src-${ts}`;
    const srcJlmId = `evt-test39-jlm-${ts}`;
    const srcEmptyId = `evt-test39-empty-${ts}`;
    const srcGoneId = `evt-test39-gone-${ts}`;
    const srcBadId = `evt-test39-bad-${ts}`;
    const srcTitle = `T39 Wedding ${ts}`;

    const source = {
      id: srcId, agencyId: AGENCY_X, venueId: vNY, venueName: `T39 NY ${ts}`,
      title: srcTitle, location: 'Grand Ballroom', date: '2027-03-01', endDate: '2027-03-03',
      startTime: '05:00 PM', endTime: '11:00 PM',
      mashgiachType: 'assigned_user', assignedMashgiachEmail: mashEmail, assignedMashgiachName: 'T39 Mash NY',
      externalMashgiach: { name: 'Ext Person', phone: '555-0100', email: 'ext@test.local' },
      menuAttachmentName: 'menu.png', menuAttachmentData: 'data:image/png;base64,AAAA',
      notes: 'Caterer: Levy. 300 guests.', status: 'completed',
      createdByEmail: 'someone@test.local', createdByName: 'Someone', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z', updatedByEmail: 'someone@test.local',
      tasks: [
        { id: `t39-a-${ts}`, title: 'Seal check', description: 'Check delivery seals', category: 'Delivery', isCompleted: true, completedAt: '2026-03-01T18:00:00.000Z', completedByName: 'T39 Mash NY', completedByEmail: mashEmail, notes: 'All sealed', photoData: 'data:image/png;base64,BBBB' },
        { id: `t39-b-${ts}`, title: 'Ovens lit', description: '', category: 'Bishul Yisroel', isCompleted: false, notes: 'pending' },
        { id: `t39-c-${ts}`, title: 'Wrap-up', isCompleted: true, completedByEmail: mashEmail, assignedTo: [mashEmail] },
      ],
    };

    await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: AGENCY_X, name: 'Test39 Agency X' },
        { id: AGENCY_Y, name: 'Test39 Agency Y' },
      ],
      venues: [
        { id: vNY, name: `T39 NY ${ts}`, agencyId: AGENCY_X, timeZone: 'America/New_York' },
        { id: vJLM, name: `T39 JLM ${ts}`, agencyId: AGENCY_X, timeZone: 'Asia/Jerusalem' },
        { id: vOther, name: `T39 Other ${ts}`, agencyId: AGENCY_X },
        { id: vB, name: `T39 B ${ts}`, agencyId: AGENCY_Y },
      ],
      users: [
        { id: ids.adminX, email: `adminx-${ts}@test.local`, name: 'T39 Admin X', role: 'admin', agencyId: AGENCY_X },
        { id: ids.coordNY, email: `coordny-${ts}@test.local`, name: 'T39 Coord NY', role: 'coordinator', agencyId: AGENCY_X, venueId: vNY },
        { id: ids.coordOther, email: `coordother-${ts}@test.local`, name: 'T39 Coord Other', role: 'coordinator', agencyId: AGENCY_X, venueId: vOther },
        { id: ids.mashNY, email: mashEmail, name: 'T39 Mash NY', role: 'mashgiach', agencyId: AGENCY_X, venueId: vNY },
        { id: ids.workerNY, email: `workerny-${ts}@test.local`, name: 'T39 Worker NY', role: 'worker', agencyId: AGENCY_X, venueId: vNY },
        { id: ids.ownerNY, email: `ownerny-${ts}@test.local`, name: 'T39 Owner NY', role: 'owner', agencyId: AGENCY_X, venueId: vNY, permissions: { canFillTasks: true, canAssignTasks: true } },
        { id: ids.adminY, email: `adminy-${ts}@test.local`, name: 'T39 Admin Y', role: 'admin', agencyId: AGENCY_Y },
      ],
      events: [
        source,
        { id: srcJlmId, agencyId: AGENCY_X, venueId: vJLM, title: `T39 JLM event ${ts}`, location: 'Hall J', date: '2026-10-01', startTime: '07:00 PM', endTime: '10:00 PM', mashgiachType: 'unassigned', status: 'confirmed', tasks: [{ id: `t39-j-${ts}`, title: 'Check', isCompleted: false }] },
        { id: srcEmptyId, agencyId: AGENCY_X, venueId: vNY, title: `T39 Empty ${ts}`, location: 'Room 2', date: '2026-10-01', mashgiachType: 'unassigned', status: 'confirmed', tasks: [] },
        { id: srcBadId, agencyId: AGENCY_X, venueId: vNY, title: `T39 Bad dates ${ts}`, location: 'Room 3', date: '2026-10-05', endDate: '2026-10-02', mashgiachType: 'unassigned', status: 'confirmed', tasks: [] },
        { id: srcGoneId, agencyId: AGENCY_X, venueId: vGone, title: `T39 Gone ${ts}`, location: 'Nowhere', date: '2026-10-01', mashgiachType: 'unassigned', status: 'confirmed', tasks: [] },
      ],
    });

    const tok = {};
    for (const [k, id] of Object.entries(ids)) tok[k] = await mintToken(baseUrl, id);

    const copy = async (who, eventId, body, extra = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (who) headers.Authorization = `Bearer ${tok[who]}`;
      const r = await fetch(`${baseUrl}/api/events/${eventId}/copy`, {
        method: 'POST', headers,
        // apiWrite shape (rule AA): operationId in the body; POST sends no version.
        body: JSON.stringify({ ...body, operationId: extra.operationId || `op39-${Math.random().toString(36).slice(2, 10)}`, ...(extra.expectedVersion !== undefined ? { expectedVersion: extra.expectedVersion } : {}) }),
      });
      let json = null;
      try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const storedEvents = async () => ((await ctx.getDoc()).events || []);
    const copiesOf = (arr, title) => arr.filter((e) => e.title === title && e.id !== srcId);
    const sourceBefore = (await storedEvents()).find((e) => e.id === srcId);
    assert(sourceBefore && sourceBefore.assignedMashgiachEmail === mashEmail, 'fixture source event not stored');

    const checks = [];

    /* ---- 1. Role T, fail closed: denied callers write nothing ---- */
    {
      const before = (await storedEvents()).length;
      const noTok = await copy(null, srcId, { date: '2027-04-01' });
      assert(noTok.status === 401, `no token: expected 401, got ${noTok.status}`);
      for (const who of ['mashNY', 'workerNY', 'ownerNY', 'coordOther', 'adminY']) {
        const r = await copy(who, srcId, { date: '2027-04-01' });
        assert(r.status === 403, `${who}: expected 403, got ${r.status} ${JSON.stringify(r.json)}`);
      }
      const after = await storedEvents();
      assert(after.length === before, `denied copies wrote events (${before} → ${after.length})`);
      assert(copiesOf(after, srcTitle).length === 0, 'a denied copy was stored');
      // Coordinator at another venue cannot copy THAT venue's events either way round.
      const r2 = await copy('coordNY', srcJlmId, { date: '2027-04-01' });
      assert(r2.status === 403, `coordNY copying a JLM event: expected 403, got ${r2.status}`);
      checks.push('rule T: 401 no token; 403 mashgiach/worker/owner/other-venue coordinator/other-agency admin; nothing written');
    }

    /* ---- 2. Coordinator at the venue copies; BR + allowlist ---- */
    let ws;
    try {
      const wsCoordNY = await connectWs(baseUrl, tok.coordNY);
      const wsCoordOther = await connectWs(baseUrl, tok.coordOther);
      const wsAdminY = await connectWs(baseUrl, tok.adminY);
      ws = [wsCoordNY, wsCoordOther, wsAdminY];

      const r = await copy('coordNY', srcId, { date: '2027-04-10' });
      assert(r.status === 201, `coordNY copy: expected 201, got ${r.status} ${JSON.stringify(r.json)}`);
      const ev = r.json.event;
      // BR: already in the stored document and in GET /api/events at 201 time.
      const stored = (await storedEvents()).find((e) => e.id === ev.id);
      assert(stored, 'BR: the copy is not in the stored doc when the 201 arrived');
      const list = await fetch(`${baseUrl}/api/events`, { headers: { Authorization: `Bearer ${tok.coordNY}` } }).then((x) => x.json());
      assert((list.events || []).some((e) => e.id === ev.id), 'BR: GET /api/events does not list the copy');
      assert(same(stored, ev), 'the response differs from the stored copy');

      for (const e of [ev, stored]) {
        assert(e.id !== srcId && /^evt-/.test(e.id), `copy id not new: ${e.id}`);
        assert(e.title === srcTitle && e.location === 'Grand Ballroom', 'title/location not carried');
        assert(e.venueId === vNY && e.agencyId === AGENCY_X, 'venue/agency wrong');
        assert(e.date === '2027-04-10' && e.endDate === '2027-04-12', `date/endDate wrong: ${e.date} ${e.endDate}`);
        assert(e.startTime === '05:00 PM' && e.endTime === '11:00 PM', 'timing slot not carried');
        assert(e.mashgiachType === 'unassigned', `mashgiachType ${e.mashgiachType}`);
        for (const k of ['assignedMashgiachEmail', 'assignedMashgiachName', 'externalMashgiach', 'menuAttachmentName', 'menuAttachmentData', 'updatedAt', 'updatedByEmail']) {
          assert(e[k] === undefined, `copy carried ${k}: ${JSON.stringify(e[k])}`);
        }
        assert(e.notes === '', `event notes carried: ${e.notes}`);
        assert(e.status === 'confirmed', `status carried: ${e.status}`);
        assert(e.createdByEmail === `coordny-${ts}@test.local`, `createdBy is not the copier: ${e.createdByEmail}`);
        const extraKeys = Object.keys(e).filter((k) => !ALLOWED_EVENT_KEYS.has(k));
        assert(extraKeys.length === 0, `copy has keys outside the allowlist: ${extraKeys.join(',')}`);
        assert(same(e.tasks.map((t) => t.title), ['Seal check', 'Ovens lit', 'Wrap-up']), `task names/order wrong: ${JSON.stringify(e.tasks.map((t) => t.title))}`);
        assert(same(e.tasks.map((t) => t.category), ['Delivery', 'Bishul Yisroel', 'Inspection']), 'task categories wrong');
        assert(e.tasks[0].description === 'Check delivery seals', 'task description not carried');
        const srcTaskIds = new Set(source.tasks.map((t) => t.id));
        for (const t of e.tasks) {
          assert(same(Object.keys(t).sort(), ALLOWED_TASK_KEYS), `task keys outside the allowlist: ${Object.keys(t).join(',')}`);
          assert(!srcTaskIds.has(t.id), `task id reused: ${t.id}`);
          assert(t.isCompleted === false && t.notes === '', `task state carried: ${JSON.stringify(t)}`);
        }
        assert(new Set(e.tasks.map((t) => t.id)).size === e.tasks.length, 'task ids not unique');
      }
      const sourceAfter = (await storedEvents()).find((x) => x.id === srcId);
      assert(same(sourceAfter, sourceBefore), 'the source event changed');
      checks.push('coordinator copy: 201 after save (doc + GET list), template only, allowlisted keys, new ids, source untouched');

      // Broadcast: venue coordinator hears it; other venue / other agency do not.
      await new Promise((res) => setTimeout(res, 1200));
      const heard = (c) => c.messages.find((m) => m.type === 'EVENT_CREATED' && ((m.payload || m.data || m).event || {}).id === ev.id);
      const hNY = heard(wsCoordNY);
      assert(hNY, 'coordNY did not hear EVENT_CREATED for the copy');
      const hEvent = (hNY.payload || hNY.data || hNY).event;
      assert(!hEvent.assignedMashgiachEmail && !hEvent.externalMashgiach, 'broadcast carried an assignee');
      assert(!heard(wsCoordOther), 'a coordinator at another venue heard the copy');
      assert(!heard(wsAdminY), "another agency's admin heard the copy");
      checks.push('broadcast: venue coordinator only (not other venue, not other agency), no assignee in payload');
    } finally {
      for (const c of ws || []) { try { c.ws.close(); } catch {} }
    }

    /* ---- 3. Admin copy with a new name; idempotent retry; failed commit ---- */
    {
      const op = `op39-retry-${ts}`;
      const body = { date: '2027-05-01', title: `  T39 Copy Renamed ${ts}  ` };
      const r1 = await copy('adminX', srcId, body, { operationId: op });
      assert(r1.status === 201, `admin copy: ${r1.status} ${JSON.stringify(r1.json)}`);
      assert(r1.json.event.title === `T39 Copy Renamed ${ts}`, 'title not trimmed/overridden');
      const r2 = await copy('adminX', srcId, body, { operationId: op });
      assert(r2.status === 200 || r2.status === 201, `retry: ${r2.status}`);
      const retried = (r2.json && (r2.json.event || r2.json)) || {};
      assert(retried.id === r1.json.event.id, 'retry with the same operationId made a different event');
      const n = (await storedEvents()).filter((e) => e.title === `T39 Copy Renamed ${ts}`).length;
      assert(n === 1, `retry duplicated the copy (${n} stored)`);

      const v = await ctx.getVersion();
      const bump = await copy('adminX', srcEmptyId, { date: '2027-05-02' }); // moves the version on
      assert(bump.status === 201, `bump copy: ${bump.status}`);
      assert(same(bump.json.event.tasks, []), 'a source with no tasks must copy no tasks (no starter tasks)');
      const stale = await copy('adminX', srcId, { date: '2027-05-03', title: `T39 Stale ${ts}` }, { expectedVersion: v });
      assert(stale.status === 409, `stale commit: expected 409, got ${stale.status}`);
      assert((await storedEvents()).every((e) => e.title !== `T39 Stale ${ts}`), 'a failed commit stored the copy');
      checks.push('admin copy + rename; same operationId → one event; failed commit → 409, nothing stored; empty source → no tasks');
    }

    /* ---- 4. Input checks ---- */
    {
      const before = (await storedEvents()).length;
      for (const date of [undefined, '', 'tomorrow', '2027-02-30', '2027-13-01', '27-04-01']) {
        const r = await copy('adminX', srcId, date === undefined ? {} : { date });
        assert(r.status === 400, `date ${JSON.stringify(date)}: expected 400, got ${r.status}`);
      }
      for (const title of ['', '   ', 'x'.repeat(201), 42]) {
        const r = await copy('adminX', srcId, { date: '2027-06-01', title });
        assert(r.status === 400, `title ${JSON.stringify(title).slice(0, 20)}: expected 400, got ${r.status}`);
      }
      const nf = await copy('adminX', `evt-test39-missing-${ts}`, { date: '2027-06-01' });
      assert(nf.status === 404, `missing event: expected 404, got ${nf.status}`);
      const gone = await copy('adminX', srcGoneId, { date: '2027-06-01' });
      assert(gone.status === 409, `venue gone: expected 409, got ${gone.status}`);
      const bad = await copy('adminX', srcBadId, { date: '2027-06-01' });
      assert(bad.status === 409, `reversed source dates: expected 409, got ${bad.status}`);
      assert((await storedEvents()).length === before, 'a rejected copy was stored');
      checks.push('400 bad dates/titles, 404 missing event, 409 venue gone / malformed source dates, nothing stored');
    }

    /* ---- 5. "Today" is the venue's date (item 6), fake clock ---- */
    try {
      // 23:30Z Nov 3: New York is 6:30 PM Nov 3; Jerusalem is 1:30 AM Nov 4.
      const c = await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-03T23:30:00.000Z' });
      assert(c.status === 200, `clock: ${c.status}`);
      const jlmPast = await copy('adminX', srcJlmId, { date: '2026-11-03' });
      assert(jlmPast.status === 400, `JLM venue, Nov 3 (already yesterday there): expected 400, got ${jlmPast.status}`);
      const jlmToday = await copy('adminX', srcJlmId, { date: '2026-11-04' });
      assert(jlmToday.status === 201, `JLM venue, Nov 4: expected 201, got ${jlmToday.status} ${JSON.stringify(jlmToday.json)}`);
      assert(jlmToday.json.event.endDate === undefined, 'a one-day event gained an endDate');
      const nyToday = await copy('adminX', srcId, { date: '2026-11-03' });
      assert(nyToday.status === 201, `NY venue, Nov 3: expected 201, got ${nyToday.status} ${JSON.stringify(nyToday.json)}`);
      assert(nyToday.json.event.endDate === '2026-11-05', `NY multi-day span: ${nyToday.json.event.endDate}`);
      const nyPast = await copy('adminX', srcId, { date: '2026-11-02' });
      assert(nyPast.status === 400, `NY venue, Nov 2: expected 400, got ${nyPast.status}`);
      checks.push('venue-local today: JLM rejects Nov 3 / accepts Nov 4 while NY accepts Nov 3 / rejects Nov 2; spans kept');
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
    }

    /* ---- 6. Retries and races (rule T re-check inside the transaction) ---- */
    {
      // Same operationId: one event and ONE broadcast, even when concurrent.
      const wsNY = await connectWs(baseUrl, tok.coordNY);
      try {
        const op = `op39-conc-${ts}`;
        const body = { date: '2027-07-01', title: `T39 Concurrent ${ts}` };
        const [a, b] = await Promise.all([
          copy('coordNY', srcId, body, { operationId: op }),
          copy('coordNY', srcId, body, { operationId: op }),
        ]);
        const okRes = [a, b].filter((r) => r.status === 200 || r.status === 201);
        assert(okRes.length >= 1, `concurrent duplicate: no success (${a.status}, ${b.status})`);
        const idsSeen = new Set(okRes.map((r) => (r.json.event || r.json).id));
        assert(idsSeen.size === 1, `concurrent duplicate returned different events: ${[...idsSeen].join(',')}`);
        const again = await copy('coordNY', srcId, body, { operationId: op });
        assert((again.json.event || again.json).id === [...idsSeen][0], 'later retry returned a different event');
        const stored = (await storedEvents()).filter((e) => e.title === `T39 Concurrent ${ts}`);
        assert(stored.length === 1, `concurrent duplicate stored ${stored.length} events`);
        // Same operationId, DIFFERENT input: never another copy's result.
        const diff = await copy('coordNY', srcId, { date: '2027-07-02', title: `T39 Concurrent ${ts}` }, { operationId: op });
        assert(diff.status === 409, `same operationId + different date: expected 409, got ${diff.status}`);
        await new Promise((res) => setTimeout(res, 1200));
        const n = wsNY.messages.filter((m) => m.type === 'EVENT_CREATED' && ((m.payload || m.data || m).event || {}).id === stored[0].id).length;
        assert(n === 1, `retries re-broadcast the copy (${n} EVENT_CREATED)`);
      } finally {
        try { wsNY.ws.close(); } catch {}
      }

      // The caller's venue changed in the COMMITTED doc while the cache still
      // has the old one: the in-transaction re-check must refuse.
      const doc0 = await ctx.getDoc();
      const usersOrig = doc0.users;
      const eventsOrig = doc0.events;
      try {
        const moved = usersOrig.map((u) => (u.id === ids.coordNY ? { ...u, venueId: vOther } : u));
        const s1 = await ctx.api('POST', '/api/__test__/doc-set-users', { users: moved });
        assert(s1.status === 200, `doc-set-users: ${s1.status}`);
        const r = await copy('coordNY', srcId, { date: '2027-07-03', title: `T39 Race user ${ts}` });
        assert(r.status === 409, `coordinator moved mid-flight: expected 409, got ${r.status} ${JSON.stringify(r.json)}`);
      } finally {
        await ctx.api('POST', '/api/__test__/doc-set-users', { users: usersOrig });
      }
      try {
        const without = eventsOrig.filter((e) => e.id !== srcId);
        const s2 = await ctx.api('POST', '/api/__test__/doc-set-events', { events: without });
        assert(s2.status === 200, `doc-set-events: ${s2.status}`);
        const r = await copy('adminX', srcId, { date: '2027-07-04', title: `T39 Race event ${ts}` });
        assert(r.status === 409, `source deleted mid-flight: expected 409, got ${r.status} ${JSON.stringify(r.json)}`);
      } finally {
        await ctx.api('POST', '/api/__test__/doc-set-events', { events: eventsOrig });
      }
      const after = await storedEvents();
      assert(after.every((e) => e.title !== `T39 Race user ${ts}` && e.title !== `T39 Race event ${ts}`), 'a refused in-flight copy was stored');
      checks.push('same operationId (concurrent + later retry) → one event, one broadcast; different input → 409; in-flight venue move / source delete → 409, nothing stored');
    }

    return checks.join('; ');
  },
};
