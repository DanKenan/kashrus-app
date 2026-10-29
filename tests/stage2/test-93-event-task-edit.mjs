/**
 * Test 93 (EVENTEDIT, Don Oct 28 2026: "When a task created in an event, it
 * can't be edited. Fix it."): an event task's wording (its name and details)
 * can be changed by the people who may edit an ordinary task at that venue,
 * through PATCH /api/events/:id/tasks/:taskId. Before this PR the route did
 * not exist (404) and the event screen had no way to edit a task.
 * Proves:
 *  A  allowed: admin, the venue coordinator, the venue owner and manager
 *     (they manage the event), a venue mashgiach granted "can assign tasks"
 *     -> 200; only the name/details change (checked state, who checked it,
 *     when, notes and the other tasks stay exactly as stored); a reload
 *     (GET /api/events) shows the new wording
 *  B  refused, nothing written: a venue mashgiach who can only check tasks
 *     (they still check and add as before), the mashgiach ASSIGNED to the
 *     event from another venue (may check it, may not reword it), the
 *     coordinator of another venue of the same agency, another agency's
 *     admin, no session (401), and a kiosk tablet session at the event's
 *     venue (even with a coordinator signed in)
 *  C  input: a blank or too-long name, too-long or non-text details, an empty
 *     body -> 400; unknown event / task -> 404; fields other than the name
 *     and details (isCompleted, completedByName, notes) are ignored
 *  D  the commit re-checks on FRESH data (stored doc changes, cache does not):
 *     a name someone else changed first -> 409; the caller lost "can assign
 *     tasks" or moved venue, or the event moved venue -> 403; nothing written
 *  D0 (RV1 P2) the edit carries the wording the editor saw: an editor who
 *     saw older wording gets 409 and the newer save stays; a field nobody else
 *     changed still saves (merge); a field sent without its base -> 400
 *  D' (RV4) the event's venue deleted (fresh doc only, then the cache too):
 *     a can-assign mashgiach / coordinator at that venue -> 403, nothing written
 *  E  the full-object save (PUT /api/events/:id) never changes an existing
 *     task's wording, for anyone (the stored wording is kept, the save goes
 *     through; renames go through the PATCH); a check-only mashgiach's save
 *     without a task keeps the task; (RV2 #1) a STALE save (old wording on
 *     screen, a newer task missing) by a check-only mashgiach is not refused,
 *     keeps the newer name and task and lands their check; (RV3) the save
 *     never removes a task, not even a coordinator's stale save, and a legacy
 *     id-less task cannot be replaced by a coordinator either; (RV1 P1) a duplicate id -> 400 for everyone,
 *     tasks not a list -> 400; legacy id-less tasks are matched by wording
 *     (kept, still checkable); (RV2 #2) a PATCH on an id stored twice ->
 *     409 EVENT_TASK_AMBIGUOUS, both untouched (cache or fresh doc)
 */
const A = 'agency-test93-a';
const B = 'agency-test93-b';
const PIN = '4821';
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const auth = (token) => ({ ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return `${claimed.device.id}.${deviceSecret}`;
}

export default {
  name: 'Test 93: event tasks can be edited by the people who edit tasks (EVENTEDIT)',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const id = (k) => `t93-${k}-${ts}`;
    const em = (k) => `t93-${k}-${ts}@example.test`;
    const v1 = id('v1'); const v2 = id('v2'); const vb = id('vb');
    const people = [
      { id: id('admin'), email: em('admin'), name: 'T93 Admin', role: 'admin', agencyId: A },
      { id: id('coord'), email: em('coord'), name: 'T93 Coord', role: 'coordinator', agencyId: A, venueId: v1, kioskPin: PIN },
      { id: id('coordv2'), email: em('coordv2'), name: 'T93 Coord V2', role: 'coordinator', agencyId: A, venueId: v2 },
      { id: id('owner'), email: em('owner'), name: 'T93 Owner', role: 'owner', agencyId: A, venueId: v1 },
      { id: id('manager'), email: em('manager'), name: 'T93 Manager', role: 'manager', agencyId: A, venueId: v1 },
      { id: id('mashassign'), email: em('mashassign'), name: 'T93 Mash Assign', role: 'mashgiach', agencyId: A, venueId: v1, permissions: { canFillTasks: true, canAssignTasks: true } },
      { id: id('mashfill'), email: em('mashfill'), name: 'T93 Mash Fill', role: 'mashgiach', agencyId: A, venueId: v1 },
      { id: id('mashv2'), email: em('mashv2'), name: 'T93 Mash V2', role: 'mashgiach', agencyId: A, venueId: v2, permissions: { canFillTasks: true, canAssignTasks: true } },
      { id: id('adminb'), email: em('adminb'), name: 'T93 Admin B', role: 'admin', agencyId: B },
    ];
    const evId = id('ev');
    const checkedAt = '2026-10-20T15:00:00.000Z';
    const event = {
      id: evId, agencyId: A, venueId: v1, title: 'T93 Dinner', location: 'Hall', date: '2026-11-20',
      startTime: '18:00', endTime: '22:00',
      mashgiachType: 'assigned_user', assignedMashgiachEmail: em('mashv2'), assignedMashgiachName: 'T93 Mash V2',
      status: 'confirmed', notes: '', createdByEmail: em('admin'), createdByName: 'T93 Admin', createdAt: checkedAt,
      tasks: [
        { id: 'etask-t93-1', title: 'Check the fish', description: 'scales and fins', category: 'Inspection', isCompleted: false, notes: '' },
        { id: 'etask-t93-2', title: 'Seal the ovens', description: '', category: 'Inspection', isCompleted: true,
          completedAt: checkedAt, completedByName: 'T93 Mash Fill', completedByEmail: em('mashfill'), notes: 'seal 12' },
      ],
    };
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T93 A ${ts}` }, { id: B, name: `T93 B ${ts}` }],
      venues: [
        { id: v1, name: `T93 V1 ${ts}`, agencyId: A },
        { id: v2, name: `T93 V2 ${ts}`, agencyId: A },
        { id: vb, name: `T93 VB ${ts}`, agencyId: B },
      ],
      users: people,
      events: [event],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const p of people) tok[p.id.split('-')[1]] = await mintToken(baseUrl, p.id);

    const call = async (method, path, token, body, extra = {}) => {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...auth(token), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null; try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };
    const storedEvent = async () => (await ctx.getDoc()).events.find((e) => e.id === evId);
    const taskOf = (ev, tid) => (ev.tasks || []).find((t) => t.id === tid);
    // The client sends, with each changed field, the wording the editor saw
    // (baseTitle / baseDescription). Unless a case sets them, they are the
    // stored wording (an editor who saw the current task).
    const edit = async (token, body, taskId = 'etask-t93-1', eventId = evId, extra, { noBase = false } = {}) => {
      const b = { ...body };
      if (!noBase) {
        const cur = taskOf((await storedEvent()) || { tasks: [] }, taskId) || {};
        if (b.title !== undefined && !('baseTitle' in b)) b.baseTitle = cur.title || '';
        if (b.description !== undefined && !('baseDescription' in b)) b.baseDescription = cur.description || '';
      }
      return call('PATCH', `/api/events/${eventId}/tasks/${taskId}`, token, b, extra);
    };
    const out = [];

    // ---- A: allowed --------------------------------------------------------------------------
    const allowed = ['admin', 'coord', 'owner', 'manager', 'mashassign'];
    for (const who of allowed) {
      const before = await storedEvent();
      const title = `Check the fish (${who})`;
      const r = await edit(tok[who], { title, description: `details by ${who}` });
      assert(r.status === 200, `A ${who}: edit -> 200, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      assert(r.json?.task?.title === title && r.json?.event?.id === evId, `A ${who}: the answer carries the saved task and event`);
      const after = await storedEvent();
      const t1 = taskOf(after, 'etask-t93-1');
      assert(t1.title === title && t1.description === `details by ${who}`, `A ${who}: stored wording changed`);
      const b1 = taskOf(before, 'etask-t93-1');
      for (const f of ['isCompleted', 'notes', 'category', 'completedAt', 'completedByName', 'completedByEmail']) {
        assert(JSON.stringify(t1[f]) === JSON.stringify(b1[f]), `A ${who}: ${f} unchanged`);
      }
      assert(JSON.stringify(taskOf(after, 'etask-t93-2')) === JSON.stringify(taskOf(before, 'etask-t93-2')), `A ${who}: the other task is untouched`);
      for (const f of ['title', 'venueId', 'agencyId', 'assignedMashgiachEmail', 'status', 'date']) {
        assert(JSON.stringify(after[f]) === JSON.stringify(before[f]), `A ${who}: event ${f} unchanged`);
      }
    }
    // A checked task keeps its check, who and when, and its notes.
    const done = await edit(tok.coord, { title: 'Seal both ovens', description: 'left and right' }, 'etask-t93-2');
    assert(done.status === 200, `A checked task: ${done.status}`);
    const t2 = taskOf(await storedEvent(), 'etask-t93-2');
    assert(t2.title === 'Seal both ovens' && t2.description === 'left and right' && t2.isCompleted === true &&
      t2.completedAt === checkedAt && t2.completedByName === 'T93 Mash Fill' && t2.completedByEmail === em('mashfill') && t2.notes === 'seal 12',
      `A checked task keeps its check: ${JSON.stringify(t2)}`);
    // A reload shows it (what the app reads on open).
    const g = await call('GET', '/api/events', tok.coord);
    const ge = (g.json?.events || g.json || []).find?.((e) => e.id === evId);
    assert(g.status === 200 && ge && taskOf(ge, 'etask-t93-1').title === 'Check the fish (mashassign)' && taskOf(ge, 'etask-t93-2').title === 'Seal both ovens',
      `A reload shows the new wording (${g.status})`);
    out.push(`A ${allowed.join('/')} + checked task kept`);

    // ---- B: refused, nothing written ---------------------------------------------------------
    const device = await pairDevice(baseUrl, tok.admin, v1);
    const kl = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': device }, body: JSON.stringify({ userId: id('coord'), pin: PIN }) });
    const klj = await kl.json().catch(() => ({}));
    assert(kl.status === 200 && klj.token, `B kiosk login ${kl.status}`);
    const refusals = [
      ['check-only mashgiach', tok.mashfill, [403], 'EVENT_TASK_EDIT_FORBIDDEN'],
      ['assigned mashgiach from another venue', tok.mashv2, [403], 'EVENT_TASK_EDIT_FORBIDDEN'],
      ['coordinator of another venue', tok.coordv2, [403], 'EVENT_TASK_EDIT_FORBIDDEN'],
      ['another agency admin', tok.adminb, [403, 404], null],
      ['no session', null, [401], null],
      ['kiosk tablet at the venue', klj.token, [403], null],
    ];
    const bCodes = [];
    for (const [why, token, statuses, code] of refusals) {
      const before = JSON.stringify(await storedEvent());
      const extra = why.startsWith('kiosk') ? { 'X-Kiosk-Device': device } : {};
      const r = await edit(token, { title: `hijack ${why}`, description: 'x' }, 'etask-t93-1', evId, extra);
      bCodes.push(r.status);
      assert(statuses.includes(r.status), `B ${why}: refused ${statuses.join('/')}, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
      if (code) assert(r.json?.code === code, `B ${why}: code ${code}, got ${r.json?.code}`);
      assert(JSON.stringify(await storedEvent()) === before, `B ${why}: nothing written`);
      assert(!JSON.stringify(r.json || {}).includes('scales'), `B ${why}: the refusal carries no event data`);
    }
    // They keep what they could do before: check / uncheck a task.
    for (const who of ['mashfill', 'mashv2']) {
      const on = await call('POST', `/api/events/${evId}/tasks/etask-t93-1/toggle`, tok[who], { isCompleted: true });
      const off = await call('POST', `/api/events/${evId}/tasks/etask-t93-1/toggle`, tok[who], { isCompleted: false });
      assert(on.status === 200 && off.status === 200, `B ${who} still checks event tasks (${on.status}/${off.status})`);
    }
    out.push(`B refused ${bCodes.join(',')}; check-only + assigned still check`);

    // ---- C: input ----------------------------------------------------------------------------
    const bad = [
      ['blank name', { title: '   ' }, 400, 'EVENT_TASK_TITLE_REQUIRED'],
      ['name too long', { title: 'x'.repeat(201) }, 400, 'EVENT_TASK_TITLE_TOO_LONG'],
      ['details too long', { description: 'x'.repeat(1001) }, 400, 'EVENT_TASK_DESCRIPTION_TOO_LONG'],
      ['details not text', { description: 5 }, 400, 'EVENT_TASK_DESCRIPTION_INVALID'],
      ['nothing to change', {}, 400, 'EVENT_TASK_EDIT_EMPTY'],
      ['only other fields', { isCompleted: true, notes: 'n' }, 400, 'EVENT_TASK_EDIT_EMPTY'],
    ];
    for (const [why, body, st, code] of bad) {
      const before = JSON.stringify(await storedEvent());
      const r = await edit(tok.coord, body);
      assert(r.status === st && r.json?.code === code, `C ${why}: ${st} ${code}, got ${r.status} ${r.json?.code}`);
      assert(JSON.stringify(await storedEvent()) === before, `C ${why}: nothing written`);
    }
    {
      const before = JSON.stringify(await storedEvent());
      const nb = await edit(tok.coord, { title: 'no base' }, 'etask-t93-1', evId, undefined, { noBase: true });
      const nd = await edit(tok.coord, { description: 'no base' }, 'etask-t93-1', evId, undefined, { noBase: true });
      assert(nb.status === 400 && nb.json?.code === 'EVENT_TASK_EDIT_BASE_MISSING' && nd.status === 400 && nd.json?.code === 'EVENT_TASK_EDIT_BASE_MISSING',
        `C a field without the wording the editor saw -> 400 (${nb.status}/${nd.status})`);
      assert(JSON.stringify(await storedEvent()) === before, 'C no base: nothing written');
    }
    assert((await edit(tok.coord, { title: 'x' }, 'etask-nope')).status === 404, 'C unknown task -> 404');
    assert((await edit(tok.coord, { title: 'x' }, 'etask-t93-1', `${evId}-nope`)).status === 404, 'C unknown event -> 404');
    const exact = await edit(tok.coord, { title: '  Check the fish  ', isCompleted: true, completedByName: 'Forged', notes: 'forged note' });
    let t1 = taskOf(await storedEvent(), 'etask-t93-1');
    assert(exact.status === 200 && t1.title === 'Check the fish' && t1.isCompleted === false && !t1.completedByName && t1.notes === '' && t1.description === 'details by mashassign',
      `C name trimmed; other fields ignored; details kept when not sent: ${JSON.stringify(t1)}`);
    const donly = await edit(tok.coord, { description: 'scales and fins' });
    t1 = taskOf(await storedEvent(), 'etask-t93-1');
    assert(donly.status === 200 && t1.title === 'Check the fish' && t1.description === 'scales and fins', 'C details only: name kept');
    out.push('C input');

    // ---- D0 (RV1 P2): an editor who saw older wording never overwrites a newer save ----------
    {
      const seen = taskOf(await storedEvent(), 'etask-t93-1');
      const b1 = await edit(tok.admin, { title: 'Inspect all fish' });          // B saves first
      assert(b1.status === 200, `D0 first editor saves (${b1.status})`);
      const a1 = await edit(tok.coord, { title: 'Check every fish', baseTitle: seen.title }); // A saw the old name
      assert(a1.status === 409, `D0 stale editor -> 409, got ${a1.status}`);
      assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Inspect all fish', 'D0 the newer save stays');
      const a2 = await edit(tok.coord, { description: 'only the details', baseDescription: seen.description });
      assert(a2.status === 200, `D0 a field nobody else changed still saves (${a2.status})`);
      const t1d = taskOf(await storedEvent(), 'etask-t93-1');
      assert(t1d.title === 'Inspect all fish' && t1d.description === 'only the details', 'D0 merge: the other person\'s name kept, my details saved');
      const r = await edit(tok.coord, { title: 'Check the fish', description: 'scales and fins' });
      assert(r.status === 200, 'D0 restore');
      out.push('D0 stale editor 409');
    }

    // ---- D: fresh data -----------------------------------------------------------------------
    const storedDoc = await ctx.getDoc();
    const storedEvents = storedDoc.events;
    const storedUsers = storedDoc.users;
    const setEvents = async (evs) => { const r = await ctx.api('POST', '/api/__test__/doc-set-events', { events: evs }); assert(r.status === 200, `doc-set-events ${r.status}`); };
    const setUsers = async (us) => { const r = await ctx.api('POST', '/api/__test__/doc-set-users', { users: us }); assert(r.status === 200, `doc-set-users ${r.status}`); };
    const withEvent = (patch) => storedEvents.map((e) => (e.id === evId ? patch(e) : e));
    const dCodes = [];
    try {
      // someone else renamed it first (stored only)
      await setEvents(withEvent((e) => ({ ...e, tasks: e.tasks.map((t) => (t.id === 'etask-t93-1' ? { ...t, title: 'Renamed elsewhere' } : t)) })));
      const r1 = await edit(tok.coord, { title: 'My rename', baseTitle: 'Check the fish' }); // the editor saw the old name
      dCodes.push(r1.status);
      assert(r1.status === 409, `D renamed elsewhere -> 409, got ${r1.status}`);
      assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Renamed elsewhere', 'D the other rename stays');
      await setEvents(storedEvents);
      // the event moved to another venue (stored only)
      await setEvents(withEvent((e) => ({ ...e, venueId: v2 })));
      const r2 = await edit(tok.mashassign, { title: 'after move' });
      dCodes.push(r2.status);
      assert(r2.status === 403, `D event moved venue -> 403, got ${r2.status}`);
      assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Check the fish', 'D event moved: nothing written');
      await setEvents(storedEvents);
      // the caller changed (stored only)
      const mid = id('mashassign');
      const fresh = [
        ['lost can-assign', storedUsers.map((u) => (u.id === mid ? { ...u, permissions: { ...(u.permissions || {}), canAssignTasks: false } } : u))],
        ['moved to another venue', storedUsers.map((u) => (u.id === mid ? { ...u, venueId: v2, ...(u.venueAccess ? { venueAccess: [v2] } : {}) } : u))],
        ['removed', storedUsers.filter((u) => u.id !== mid)],
      ];
      for (const [why, us] of fresh) {
        await setUsers(us);
        const r = await edit(tok.mashassign, { title: `fresh ${why}` });
        dCodes.push(r.status);
        assert([401, 403, 409].includes(r.status) && r.status !== 200, `D ${why}: refused, got ${r.status}`);
        await setUsers(storedUsers);
        assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Check the fish', `D ${why}: nothing written`);
      }
      // RV4: the event's venue was deleted (event and caller kept). A home
      // venue id left on the caller's row must not authorize.
      {
        const storedVenues = (await ctx.getDoc()).venues;
        const setVenues = async (vs) => { const r = await ctx.api('POST', '/api/__test__/doc-set-venues', { venues: vs }); assert(r.status === 200, `doc-set-venues ${r.status}`); };
        try {
          await setVenues(storedVenues.filter((v) => v.id !== v1));
          // fresh doc only: the commit refuses
          for (const who of ['mashassign', 'coord']) {
            const r = await edit(tok[who], { title: `venue gone ${who}`, baseTitle: 'Check the fish' }, 'etask-t93-1', evId, undefined, { noBase: true });
            dCodes.push(r.status);
            assert(r.status === 403, `D venue deleted (fresh) ${who} -> 403, got ${r.status}`);
          }
          assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Check the fish', 'D venue deleted (fresh): nothing written');
          // the cache too (an admin commit re-hydrates it without the venue): refused before the commit
          const sync = await call('POST', `/api/events/${evId}/tasks/etask-t93-2/toggle`, tok.admin, { isCompleted: false });
          const r3 = await edit(tok.mashassign, { title: 'venue gone cached', baseTitle: 'Check the fish' }, 'etask-t93-1', evId, undefined, { noBase: true });
          dCodes.push(r3.status);
          assert(r3.status === 403, `D venue deleted (cache, sync ${sync.status}) mashassign -> 403, got ${r3.status}`);
          assert(taskOf(await storedEvent(), 'etask-t93-1').title === 'Check the fish', 'D venue deleted (cache): nothing written');
        } finally {
          await setVenues(storedVenues);
          await call('POST', `/api/events/${evId}/tasks/etask-t93-2/toggle`, tok.admin, { isCompleted: false });
        }
      }
    } finally {
      await setEvents(storedEvents);
      await setUsers(storedUsers);
    }
    const back = await edit(tok.mashassign, { title: 'Check the fish' });
    assert(back.status === 200, `D twin: restored -> 200 (${back.status})`);
    out.push(`D fresh ${dCodes.join(',')}`);

    // ---- E: the full-object save follows the same wording rule ---------------------------------
    const op = () => `t93-op-${Math.random().toString(36).slice(2)}`;
    const put = async (who, mutate) => {
      const cur = await storedEvent();
      const body = { ...cur, tasks: mutate(cur.tasks.map((t) => ({ ...t }))), expectedVersion: await ctx.getVersion(), operationId: op() };
      return call('PUT', `/api/events/${evId}`, tok[who], body);
    };
    const wordingOf = (ev) => JSON.stringify((ev.tasks || []).map((x) => [x.id || null, x.title, x.description ?? null]));
    // A full-object save never changes an existing task's wording (for anyone):
    // the stored wording is kept, the rest of the save goes through.
    for (const [who, why, mutate] of [
      ['mashfill', 'rename', (ts2) => ts2.map((t) => (t.id === 'etask-t93-1' ? { ...t, title: 'renamed via PUT' } : t))],
      ['mashfill', 'new details', (ts2) => ts2.map((t) => (t.id === 'etask-t93-1' ? { ...t, description: 'changed via PUT' } : t))],
      ['coord', 'rename', (ts2) => ts2.map((t) => (t.id === 'etask-t93-1' ? { ...t, title: 'coordinator renamed via PUT' } : t))],
    ]) {
      const before = wordingOf(await storedEvent());
      const r = await put(who, mutate);
      assert(r.status === 200, `E ${who} ${why} via PUT -> 200 (the save goes through), got ${r.status} ${r.json?.code}`);
      assert(wordingOf(await storedEvent()) === before && wordingOf(r.json?.event || {}) === before, `E ${who} ${why} via PUT: stored wording unchanged`);
    }
    {
      const r = await put('mashfill', (ts2) => ts2.filter((t) => t.id !== 'etask-t93-2'));
      assert(r.status === 200 && !!taskOf(await storedEvent(), 'etask-t93-2'), `E check-only save without a task: the task is KEPT (${r.status})`);
    }
    // RV1 P1: duplicate ids are refused for everyone, nothing written.
    {
      const before = JSON.stringify(await storedEvent());
      for (const [who, why, mutate] of [
        ['mashfill', 'renamed copy first', (ts2) => [{ ...ts2[0], title: 'Skip the fish check' }, ...ts2]],
        ['mashfill', 'renamed copy last', (ts2) => [...ts2, { ...ts2[0], title: 'Skip the fish check' }]],
        ['mashfill', 'exact copy', (ts2) => [...ts2, { ...ts2[0] }]],
        ['coord', 'exact copy', (ts2) => [...ts2, { ...ts2[0] }]],
      ]) {
        const r = await put(who, mutate);
        assert(r.status === 400 && r.json?.code === 'EVENT_TASKS_DUPLICATE_ID', `E ${who} duplicate id (${why}) -> 400, got ${r.status} ${r.json?.code}`);
      }
      const bad = await put('coord', () => 'not a list');
      assert(bad.status === 400 && bad.json?.code === 'EVENT_TASKS_INVALID', `E tasks not a list -> 400 (${bad.status})`);
      assert(JSON.stringify(await storedEvent()) === before, 'E duplicates / not a list: nothing written');
    }
    const add = await put('mashfill', (ts2) => [...ts2, { id: 'etask-t93-3', title: 'Added by the mashgiach', isCompleted: false }]);
    assert(add.status === 200 && taskOf(await storedEvent(), 'etask-t93-3')?.title === 'Added by the mashgiach', `E check-only can still ADD a task (${add.status})`);
    // RV2 #1: a STALE full-object save (old wording on screen, a task added
    // meanwhile missing) by someone who may only check tasks: no refusal, the
    // newer wording and the newer task stay, their own change lands.
    {
      const stale = await storedEvent();                                   // the mashgiach's screen
      const pr = await edit(tok.coord, { title: 'Inspect all fish' });     // coordinator renames meanwhile
      assert(pr.status === 200, `E RV2 setup: coordinator renames (${pr.status})`);
      const ad = await put('coord', (ts2) => [...ts2, { id: 'etask-t93-5', title: 'Added by the coordinator', isCompleted: false }]);
      assert(ad.status === 200, `E RV2 setup: coordinator adds a task (${ad.status})`);
      const body = {
        ...stale,
        tasks: [...stale.tasks.map((x) => (x.id === 'etask-t93-1' ? { ...x, isCompleted: true, completedBy: 'Moshe' } : { ...x })),
          { id: 'etask-t93-6', title: 'Added from the old screen', isCompleted: false }],
        expectedVersion: await ctx.getVersion(), operationId: op(),
      };
      const r = await call('PUT', `/api/events/${evId}`, tok.mashfill, body);
      const ev = await storedEvent();
      assert(r.status === 200, `E RV2 stale tasks save by a check-only mashgiach -> 200, got ${r.status} ${r.json?.code}`);
      assert(taskOf(ev, 'etask-t93-1')?.title === 'Inspect all fish', 'E RV2 the newer name is NOT overwritten by the old screen');
      assert(taskOf(ev, 'etask-t93-1')?.isCompleted === true, 'E RV2 their check landed');
      assert(!!taskOf(ev, 'etask-t93-5') && !!taskOf(ev, 'etask-t93-6'), 'E RV2 the task added meanwhile is kept, theirs is added');
      const rs = await edit(tok.coord, { title: 'Check the fish' });
      assert(rs.status === 200, 'E RV2 restore');
    }
    // RV3 #1: the save never removes a task — not even for a coordinator (a
    // stale screen of an editor must not drop a task added meanwhile).
    {
      const stale = await storedEvent();                                   // coordinator A's screen
      const ad = await put('admin', (ts2) => [...ts2, { id: 'etask-t93-7', title: 'Added by the admin', isCompleted: false }]);
      assert(ad.status === 200, `E RV3 setup: admin adds a task (${ad.status})`);
      const r = await call('PUT', `/api/events/${evId}`, tok.coord, { ...stale, status: 'confirmed', expectedVersion: await ctx.getVersion(), operationId: op() });
      const ev = await storedEvent();
      assert(r.status === 200 && ev.status === 'confirmed', `E RV3 coordinator's stale status save goes through (${r.status} ${ev.status})`);
      assert(!!taskOf(ev, 'etask-t93-7'), 'E RV3 the task added meanwhile is KEPT');
      const rm = await put('coord', (ts2) => ts2.filter((t) => t.id !== 'etask-t93-6'));
      assert(rm.status === 200 && !!taskOf(await storedEvent(), 'etask-t93-6'), `E RV3 a coordinator save without a task keeps it (${rm.status})`);
    }
    // A legacy task stored WITHOUT an id: matched one to one by its wording.
    {
      const storedEvents2 = (await ctx.getDoc()).events;
      await ctx.api('POST', '/api/__test__/doc-set-events', { events: storedEvents2.map((e) => (e.id === evId ? { ...e, tasks: [...e.tasks, { title: 'Legacy task', description: '', isCompleted: false }] } : e)) });
      // make the cache match the stored doc (a harmless allowed write re-hydrates it)
      const sync = await call('POST', `/api/events/${evId}/tasks/etask-t93-1/toggle`, tok.coord, { isCompleted: false });
      assert(sync.status === 200 && (await storedEvent()).tasks.some((x) => !x.id && x.title === 'Legacy task'), `E legacy fixture (${sync.status})`);
      const legacy = (ev) => (ev.tasks || []).filter((x) => !x.id && x.title === 'Legacy task');
      const lr = await put('mashfill', (ts2) => ts2.map((x) => (!x.id ? { ...x, title: 'Legacy renamed' } : x)));
      assert(lr.status === 200 && legacy(await storedEvent()).length === 1, `E check-only "renaming" an id-less legacy task: the original stays (${lr.status})`);
      const ld = await put('mashfill', (ts2) => ts2.filter((x) => !!x.id));
      assert(ld.status === 200 && legacy(await storedEvent()).length === 1, `E check-only save without the legacy task: it is kept (${ld.status})`);
      // RV3 #2: a coordinator cannot replace a legacy task's wording through the save either.
      {
        const before = legacy(await storedEvent());
        const cr = await put('coord', (ts2) => ts2.map((x) => (!x.id && x.title === 'Legacy task' ? { ...x, title: 'Legacy renamed by coordinator', isCompleted: true } : x)));
        const after = legacy(await storedEvent());
        assert(cr.status === 200 && after.length === 1 && JSON.stringify(after) === JSON.stringify(before), `E RV3 coordinator "renaming" a legacy task: the stored one stays as it was (${cr.status})`);
      }
      const lc = await put('mashfill', (ts2) => ts2.map((x) => (!x.id && x.title === 'Legacy task' ? { ...x, isCompleted: true } : x)));
      assert(lc.status === 200 && legacy(await storedEvent())[0]?.isCompleted === true, `E check-only can still check the legacy task (${lc.status})`);
    }
    // RV2 #2: two stored tasks under one id -> PATCH refuses, both untouched.
    {
      const dupA = { id: 'etask-t93-dup', title: 'Dup one', isCompleted: true, completedBy: 'Moshe', notes: 'first' };
      const dupB = { id: 'etask-t93-dup', title: 'Dup two', isCompleted: false, notes: 'second' };
      const setDocTasks = async (extra) => {
        const evs = (await ctx.getDoc()).events;
        await ctx.api('POST', '/api/__test__/doc-set-events', { events: evs.map((e) => (e.id === evId ? { ...e, tasks: [...e.tasks.filter((x) => x.id !== 'etask-t93-dup'), ...extra] } : e)) });
      };
      const dupsOf = async () => JSON.stringify((await storedEvent()).tasks.filter((x) => x.id === 'etask-t93-dup'));
      // the server's cache holds ONE task under the id; the stored doc gets a second -> the commit refuses
      await setDocTasks([dupA]);
      const sync1 = await call('POST', `/api/events/${evId}/tasks/etask-t93-1/toggle`, tok.coord, { isCompleted: false });
      assert(sync1.status === 200, 'E RV2 single fixture synced');
      await setDocTasks([dupA, dupB]);
      const before = await dupsOf();
      const r1 = await edit(tok.coord, { title: 'Dup renamed', baseTitle: 'Dup one' }, 'etask-t93-dup', evId, undefined, { noBase: true });
      assert(r1.status === 409 && r1.json?.code === 'EVENT_TASK_AMBIGUOUS', `E RV2 PATCH, duplicate only in the fresh doc -> 409 EVENT_TASK_AMBIGUOUS, got ${r1.status} ${r1.json?.code}`);
      assert(await dupsOf() === before, 'E RV2 (fresh) both duplicates untouched');
      // both in the cache too -> refused before the commit
      const sync = await call('POST', `/api/events/${evId}/tasks/etask-t93-1/toggle`, tok.coord, { isCompleted: false });
      assert(sync.status === 200, 'E RV2 dup fixture synced');
      const r2 = await edit(tok.coord, { title: 'Dup renamed', baseTitle: 'Dup one' }, 'etask-t93-dup', evId, undefined, { noBase: true });
      assert(r2.status === 409 && r2.json?.code === 'EVENT_TASK_AMBIGUOUS', `E RV2 PATCH on a duplicated id -> 409 EVENT_TASK_AMBIGUOUS, got ${r2.status} ${r2.json?.code}`);
      assert(await dupsOf() === before, 'E RV2 both duplicates untouched');
    }
    out.push('E PUT keeps stored wording (+stale save, duplicates, legacy id-less, ambiguous PATCH)');

    return out.join('; ');
  },
};
