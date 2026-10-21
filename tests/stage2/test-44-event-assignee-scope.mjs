/**
 * Test 44 (item 8s): an event's assigned mashgiach is resolved ONLY inside the
 * caller's agency and rule-T roster.
 *
 * Before 8s, POST /api/events and PUT /api/events/:id looked the email up
 * across ALL agencies and copied that person's real name into the event, so an
 * admin or coordinator of agency A could learn whether an email existed in
 * agency B and the person's name (and the assignee push went to them).
 * Proves (plan "Agreed — ChatGPT — 8 plan v4", 8s + amendments):
 *  1 admin A assigns an A person at another A venue → 201; the stored name is
 *    the A record's (a client-sent name is ignored).
 *  2 admin A assigns agency B's email → 400, and a nonexistent email → 400 with
 *    the SAME text; no event is written; no B name in the response.
 *  3 coordinator at A1: an A2 mashgiach → 400; an A admin → 201; an A1
 *    mashgiach → 201. An in-agency owner is never assignable → 400.
 *  4 PUT with agency B's email → 400, event unchanged.
 *  5 a historical cross-agency assignment (stored before 8s): notes-only and
 *    task-only PUTs → 200 and the assignment + name stay byte-for-byte;
 *    reassigning to an out-of-scope email → the same 400.
 *  6 fresh-data re-check: the assignee is moved to another venue in the
 *    committed doc after the cache was read → the coordinator's save → 400,
 *    nothing written.
 *  7 a kiosk token cannot create events (403, as today).
 */
const A = 'agency-test44-a';
const B = 'agency-test44-b';
const REFUSAL = 'Choose someone from your team.';
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
  name: 'Test 44: event assignee resolved only within the caller\'s agency + rule-T roster (8s)',
  whatItProves:
    'Assigning an event to an email outside the caller\'s agency or roster is refused with one generic 400 (no existence or name oracle, nothing written); names come from the in-agency record; historical assignments survive non-assignment edits; the assignee is re-checked on fresh data.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-t44-a1-${ts}`, vA2 = `venue-t44-a2-${ts}`, vB1 = `venue-t44-b1-${ts}`;
    const id = (k) => `user-t44-${k}-${ts}`;
    const em = (k) => `t44-${k}-${ts}@test.local`;
    const people = [
      { id: id('admina'), email: em('admina'), name: 'T44 Admin A', role: 'admin', agencyId: A },
      { id: id('admina2'), email: em('admina2'), name: 'T44 Admin A2', role: 'admin', agencyId: A },
      { id: id('coorda1'), email: em('coorda1'), name: 'T44 Coord A1', role: 'coordinator', agencyId: A, venueId: vA1 },
      { id: id('masha1'), email: em('masha1'), name: 'T44 Mash A1', role: 'mashgiach', agencyId: A, venueId: vA1 },
      { id: id('masha2'), email: em('masha2'), name: 'T44 Mash A2', role: 'mashgiach', agencyId: A, venueId: vA2 },
      { id: id('ownera'), email: em('ownera'), name: 'T44 Owner A', role: 'owner', agencyId: A, venueId: vA1 },
      { id: id('adminb'), email: em('adminb'), name: 'T44 Admin B', role: 'admin', agencyId: B },
      { id: id('mashb'), email: em('mashb'), name: 'T44 Secret B Person', role: 'mashgiach', agencyId: B, venueId: vB1 },
    ];
    const histId = `evt-t44-hist-${ts}`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T44 A ${ts}` }, { id: B, name: `T44 B ${ts}` }],
      venues: [
        { id: vA1, name: `T44 A1 ${ts}`, agencyId: A },
        { id: vA2, name: `T44 A2 ${ts}`, agencyId: A },
        { id: vB1, name: `T44 B1 ${ts}`, agencyId: B },
      ],
      users: people,
      // Stored BEFORE 8s: a cross-agency assignment (B's person on an A event).
      events: [{ id: histId, agencyId: A, venueId: vA1, title: `Hist ${ts}`, location: 'Hall', date: '2026-11-03', mashgiachType: 'assigned_user', assignedMashgiachEmail: em('mashb'), assignedMashgiachName: 'T44 Secret B Person', tasks: [{ id: `etask-t44-h-${ts}`, title: 'Seal check', isCompleted: false }] }],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const p of people) tok[p.id] = auth(await mintToken(baseUrl, p.id));
    const T = (k) => tok[id(k)];

    const create = async (who, venueId, email, extra = {}) => {
      const r = await fetch(`${baseUrl}/api/events`, {
        method: 'POST', headers: T(who),
        body: JSON.stringify({ venueId, title: `E ${who} ${Math.random().toString(36).slice(2, 7)}`, location: 'Hall', date: '2026-11-05', mashgiachType: 'assigned_user', assignedMashgiachEmail: email, assignedMashgiachName: 'Client Fake Name', operationId: `op-t44-${Math.random().toString(36).slice(2)}`, ...extra }),
      });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const eventsInDoc = async () => ((await ctx.getDoc()).events || []);
    const put = async (who, evId, body) => {
      const r = await fetch(`${baseUrl}/api/events/${evId}`, {
        method: 'PUT', headers: T(who),
        body: JSON.stringify({ ...body, expectedVersion: await ctx.getVersion(), operationId: `op-t44p-${Math.random().toString(36).slice(2)}` }),
      });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };

    // 1. in-agency, other venue, admin → 201; name from the record.
    const ok1 = await create('admina', vA1, em('masha2').toUpperCase());
    assert(ok1.status === 201, `admin A assigning an A person: ${ok1.status} ${ok1.text.slice(0, 120)}`);
    assert(ok1.json.event.assignedMashgiachName === 'T44 Mash A2', `stored name must be the record's, got ${ok1.json.event.assignedMashgiachName}`);
    assert(ok1.json.event.assignedMashgiachEmail === em('masha2'), 'stored email is the record\'s');
    const ev1 = ok1.json.event.id;

    // 2. other agency vs nonexistent: same 400, nothing written, no B name.
    const n0 = (await eventsInDoc()).length;
    const v0 = await ctx.getVersion();
    const refB = await create('admina', vA1, em('mashb'));
    const refNone = await create('admina', vA1, `nobody-t44-${ts}@test.local`);
    for (const [label, r] of [['B email', refB], ['nonexistent', refNone]]) {
      assert(r.status === 400, `${label} must be 400, got ${r.status}`);
      assert(r.json && r.json.error === REFUSAL, `${label}: generic text, got ${r.text.slice(0, 100)}`);
      assert(!r.text.includes('Secret B Person'), `${label}: no B name in the response`);
    }
    assert(refB.text === refNone.text, 'B email and nonexistent email answers must be identical');
    assert((await eventsInDoc()).length === n0 && (await ctx.getVersion()) === v0, 'refused creates must write nothing');

    // 3. coordinator at A1 (rule T) and owners.
    const cA2 = await create('coorda1', vA1, em('masha2'));
    assert(cA2.status === 400 && cA2.json.error === REFUSAL, `coordinator assigning an A2 mashgiach must be 400, got ${cA2.status}`);
    const cAdm = await create('coorda1', vA1, em('admina2'));
    assert(cAdm.status === 201 && cAdm.json.event.assignedMashgiachName === 'T44 Admin A2', `coordinator assigning an A admin: ${cAdm.status}`);
    const cA1 = await create('coorda1', vA1, em('masha1'));
    assert(cA1.status === 201, `coordinator assigning an A1 mashgiach: ${cA1.status}`);
    const own = await create('admina', vA1, em('ownera'));
    assert(own.status === 400 && own.json.error === REFUSAL, `an owner is never assignable, got ${own.status}`);
    // The same check applies whatever the type (an API caller cannot park a foreign email on an external event).
    const extB = await create('admina', vA1, em('mashb'), { mashgiachType: 'external', externalMashgiach: { name: 'Ext' } });
    assert(extB.status === 400, `external event carrying a B email must be 400, got ${extB.status}`);
    // Unassigned / external without an email are unchanged.
    const un = await create('admina', vA1, undefined, { mashgiachType: 'unassigned' });
    assert(un.status === 201, `unassigned create: ${un.status}`);

    // 4. PUT with B's email → 400, event unchanged.
    const before4 = JSON.stringify((await eventsInDoc()).find((e) => e.id === ev1));
    const p4 = await put('admina', ev1, { mashgiachType: 'assigned_user', assignedMashgiachEmail: em('mashb') });
    assert(p4.status === 400 && p4.json.error === REFUSAL, `PUT with B email must be 400, got ${p4.status} ${p4.text.slice(0, 100)}`);
    assert(!p4.text.includes('Secret B Person'), 'PUT 400 carries no B name');
    assert(JSON.stringify((await eventsInDoc()).find((e) => e.id === ev1)) === before4, 'event unchanged after refused PUT');
    // Positive twin: reassign within the team → 200, name from the record.
    const p4ok = await put('admina', ev1, { mashgiachType: 'assigned_user', assignedMashgiachEmail: em('masha1'), assignedMashgiachName: 'Client Fake' });
    assert(p4ok.status === 200, `PUT reassign within team: ${p4ok.status} ${p4ok.text.slice(0, 100)}`);
    const ev1b = (await eventsInDoc()).find((e) => e.id === ev1);
    assert(ev1b.assignedMashgiachEmail === em('masha1') && ev1b.assignedMashgiachName === 'T44 Mash A1', `reassigned name from record: ${ev1b.assignedMashgiachName}`);

    // 5. historical cross-agency assignment survives non-assignment edits.
    const hist0 = (await eventsInDoc()).find((e) => e.id === histId);
    const pNotes = await put('admina', histId, { notes: `notes ${ts}` });
    assert(pNotes.status === 200, `notes-only PUT on a historical assignment: ${pNotes.status} ${pNotes.text.slice(0, 100)}`);
    // The real client sends the whole event back (incl. the stored assignment) + an appended task.
    const full = { ...hist0, tasks: [...(hist0.tasks || []), { id: `etask-t44-h2-${ts}`, title: 'Added', isCompleted: false }] };
    const pTask = await put('masha1', histId, full);
    assert(pTask.status === 200, `task-only PUT (whole client body) on a historical assignment: ${pTask.status} ${pTask.text.slice(0, 120)}`);
    const hist1 = (await eventsInDoc()).find((e) => e.id === histId);
    assert(hist1.assignedMashgiachEmail === hist0.assignedMashgiachEmail && hist1.assignedMashgiachName === hist0.assignedMashgiachName, 'historical assignment + name stay byte-for-byte');
    assert(hist1.tasks.length === 2 && hist1.notes === `notes ${ts}`, 'the notes and the task were saved');
    const pRe = await put('admina', histId, { assignedMashgiachEmail: `nobody2-t44-${ts}@test.local` });
    assert(pRe.status === 400 && pRe.json.error === REFUSAL, `reassigning to an out-of-scope email must be 400, got ${pRe.status}`);

    // 6. fresh-data re-check: move the assignee out of the coordinator's venue
    //    in the committed doc only (cache still has the old venue).
    const doc6 = await ctx.getDoc();
    const moved = (doc6.users || []).map((u) => (u.id === id('masha1') ? { ...u, venueId: vA2 } : u));
    const ds = await ctx.api('POST', '/api/__test__/doc-set-users', { users: moved });
    assert(ds.status === 200, `doc-set-users: ${ds.status}`);
    const n6 = ((await ctx.getDoc()).events || []).length;
    const c6 = await create('coorda1', vA1, em('masha1'));
    assert(c6.status === 400 && c6.json && c6.json.error === REFUSAL, `fresh re-check must refuse (assignee moved to A2), got ${c6.status} ${c6.text.slice(0, 100)}`);
    assert(((await ctx.getDoc()).events || []).length === n6, 'refused (fresh) create wrote nothing');
    // Re-sync the cache with the doc (a successful commit re-hydrates).
    const resync = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t44-sync-${ts}`, name: 'sync', agencyId: A }] });
    assert(resync.status === 200, `resync: ${resync.status}`);

    // 7. kiosk token cannot create events.
    const kt = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id('masha2'), agencyId: A, venueId: vA2 }),
    });
    if (kt.status === 200) {
      const k = (await kt.json()).token;
      const r = await fetch(`${baseUrl}/api/events`, { method: 'POST', headers: auth(k), body: JSON.stringify({ venueId: vA2, title: 'k', location: 'k', date: '2026-11-05', mashgiachType: 'assigned_user', assignedMashgiachEmail: em('masha2') }) });
      assert(r.status === 403 || r.status === 401, `kiosk token must not create events, got ${r.status}`);
    }

    return 'assignee scope: in-agency other-venue 201 (record name); B email = nonexistent = same 400, nothing written, no B name; coordinator rule T (A2 mash 400, A admin 201, A1 mash 201); owner 400; external+B email 400; PUT B email 400 unchanged, in-team reassign 200; historical assignment kept on notes/task PUTs, out-of-scope reassign 400; fresh re-check 400; kiosk refused';
  },
};
