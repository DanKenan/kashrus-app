import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';
export default {
  name: 'Test 114: checklist completion, permissions and write budget',
  whatItProves: 'Validated checklists; attributed ticks; all-items completion; unticking; partial overdue; legacy behavior; checklist ticks and unticks match a check-in at the same venue by the same mashgiach: 2 reads and 3 writes = one commit (app-state + task mirror + tiny freshness sidecar); no-op 1 read/0 writes; cached GET 0/0; concurrent different-item ticks survive with attribution; same-item races leave one tick (last commit wins), never duplicates.',
  async run(baseUrl, ctx) {
    const { api, venueId, people } = await shiftFixture(baseUrl, ctx, '114');
    const body = { venueId, title: 'Opening checklist', inputType: 'checklist', checklistItems: [' Lights on ', 'Doors open'], targetTime: '6:00 AM', targetTimeMinutes: 360, enableOverdueAlert: true, daysOfWeek: [0,1,2,3,4,5,6] };
    for (const items of [[], ['One'], ['a', ' a '], ['a', ' '], ['a', 'x'.repeat(81)], Array(21).fill('a')]) {
      assert.equal((await api('admin', 'POST', '/api/tasks', { ...body, checklistItems: items })).status, 400);
    }
    const created = await api('admin', 'POST', '/api/tasks', body);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id, path = `/api/tasks/${id}/checklist`;
    assert.deepEqual(created.json.checklistItems, ['Lights on', 'Doors open']);
    const saved = async () => (await ctx.getDoc()).tasks.find((t) => t.id === id);
    const costs = {};
    const counts = async () => ({
      reads: (await ctx.api('POST', '/api/__test__/reads', {})).json.total,
      writes: (await ctx.api('POST', '/api/__test__/writes', {})).json.total,
    });
    const measure = async (label, reads, writes, action) => {
      const before = await counts(), result = await action(), after = await counts();
      costs[label] = { reads: after.reads - before.reads, writes: after.writes - before.writes };
      assert.deepEqual(costs[label], { reads, writes }, label);
      return result;
    };
    let operation = 0;
    const tick = async (item, ticked, delta = 1) => {
      const version = await ctx.getVersion();
      // A changed task reads app-state and its entity mirror; a no-op reads only app-state.
      const label = `${++operation}: ${ticked ? 'tick' : 'untick'} ${item}${delta ? '' : ' no-op'}`;
      const r = await measure(label, delta ? 2 : 1, delta ? 3 : 0,
        () => api('mash', 'POST', path, { item, ticked, byName: 'Forged' }));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await ctx.getVersion()) - version, delta, 'commit count');
      if (delta) assert.deepEqual(costs[label], checkInCost, `${label}: same I/O as check-in`);
      assert.deepEqual(await saved(), r.json);
      await measure(`${operation}: cached GET after`, 0, 0, async () => {
        const cached = await api('mash', 'GET', `/api/tasks?venueId=${venueId}`);
        assert.equal(cached.status, 200);
        const cachedTask = cached.json.tasks.find((t) => t.id === id);
        assert.deepEqual(cachedTask.checklistTicks, r.json.checklistTicks);
        assert.equal(cachedTask.isCompleted, r.json.isCompleted);
      });
      return r.json;
    };
    for (const invalid of [{ item: -1, ticked: true }, { item: 2, ticked: true }, { item: 0.5, ticked: true }, { item: 0, ticked: 'true' }]) assert.equal((await api('mash', 'POST', path, invalid)).status, 400);
    for (const who of ['foreign', 'elsewhere']) {
      const before = await saved();
      assert.equal((await api(who, 'POST', path, { item: 0, ticked: true })).status, 403);
      assert.deepEqual(await saved(), before);
    }
    const owner = { ...people.mash, id: `${id}-owner`, email: `${id}@test.local`, role: 'owner', permissions: { canFillTasks: false } };
    delete owner.key;
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { users: [owner] })).status, 200);
    const token = (await ctx.api('POST', '/api/__test__/mint-token', { userId: owner.id })).json.token;
    const before = await saved();
    const denied = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ item: 0, ticked: true }) });
    assert.equal(denied.status, 403);
    assert.deepEqual(await saved(), before);
    const baseline = await api('admin', 'POST', '/api/tasks', { ...body, title: 'Check-in budget baseline', inputType: 'check_in' });
    assert.equal(baseline.status, 201);
    const baselineVersion = await ctx.getVersion();
    const checkIn = await measure('check-in baseline', 2, 3,
      () => api('mash', 'POST', `/api/tasks/${baseline.json.id}/check-in`, {}));
    assert.equal(checkIn.status, 200, JSON.stringify(checkIn.json));
    assert.equal((await ctx.getVersion()) - baselineVersion, 1, 'check-in is one commit');
    assert.equal(checkIn.json.checkIns[0].byName, people.mash.name);
    const checkInCost = costs['check-in baseline'];
    let task = await tick(0, true);
    assert.equal(task.isCompleted, false);
    assert.equal(task.checklistTicks[0].byName, people.mash.name);
    assert.equal(task.checklistTicks[0].byEmail, people.mash.email);
    assert.ok(Number.isFinite(Date.parse(task.checklistTicks[0].at)));
    await tick(0, true, 0);
    try {
      await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-05T12:00:00Z' });
      const dash = await api('admin', 'GET', '/api/admin/dashboard');
      assert.equal(dash.json.venues.find((v) => v.venue.id === venueId).overdueTaskList.some((t) => t.id === id), true);
      const push = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      assert.equal(push.json.notified.some((key) => key.startsWith(`${id}:`)), true);
    } finally { await ctx.api('POST', '/api/__test__/clock', { iso: null }); }
    task = await tick(1, true);
    assert.equal(task.isCompleted, true);
    assert.equal(task.currentStatus, 'completed');
    task = await tick(0, false);
    assert.equal(task.isCompleted, false);
    assert.equal(task.currentStatus, 'pending');
    await tick(0, false, 0);
    for (const payload of [{ isCompleted: true }, { currentStatus: 'completed' }]) {
      assert.equal((await api('admin', 'PUT', `/api/tasks/${id}`, payload)).status, 400);
      assert.equal((await saved()).isCompleted, false);
    }
    assert.equal((await api('admin', 'PUT', `/api/tasks/${id}`, { checklistItems: ['Only'] })).status, 400);
    assert.equal((await api('admin', 'PUT', `/api/tasks/${id}`, { checklistItems: null })).status, 400);
    const edited = await api('admin', 'PUT', `/api/tasks/${id}`, { checklistItems: ['New item', 'Doors open'], expectedVersion: await ctx.getVersion() });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.deepEqual(edited.json.checklistTicks, []);
    for (const inputType of ['yes_no', 'check_in']) {
      const old = await api('admin', 'POST', '/api/tasks', { ...body, inputType, checklistItems: ['ignored'] });
      assert.equal(old.status, 201);
      assert.equal(old.json.checklistItems, undefined);
      assert.equal((await api('mash', 'POST', `/api/tasks/${old.json.id}/checklist`, { item: 0, ticked: true })).status, 400);
      const updated = inputType === 'check_in'
        ? await api('mash', 'POST', `/api/tasks/${old.json.id}/check-in`, {})
        : await api('mash', 'PUT', `/api/tasks/${old.json.id}`, { isCompleted: true, currentStatus: 'yes', expectedVersion: await ctx.getVersion() });
      assert.equal(updated.status, 200);
      assert.equal(inputType === 'check_in' ? updated.json.checkIns.length : updated.json.isCompleted, inputType === 'check_in' ? 1 : true);
    }
    await tick(0, true);
    await tick(1, true);
    const reset = await api('admin', 'POST', '/api/reset-daily', { venueId, force: true, expectedVersion: await ctx.getVersion() });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    const doc = await ctx.getDoc();
    const resetTask = doc.tasks.find((t) => t.id === id);
    assert.deepEqual(resetTask.checklistTicks, []);
    assert.equal(resetTask.isCompleted, false);
    const entry = doc.historyLogs.flatMap((h) => h.entries || []).find((e) => e.taskId === id);
    assert.equal(entry.isCompleted, true);
    assert.match(entry.notes, /Checklist 2\/2: New item \(Shift mash /);
    const concurrent = await api('admin', 'POST', '/api/tasks', { ...body, title: 'Concurrent checklist', checklistItems: ['Lights', 'Doors', 'Windows'] });
    assert.equal(concurrent.status, 201);
    const concurrentId = concurrent.json.id;
    const concurrentPath = `/api/tasks/${concurrentId}/checklist`;
    // 'assign' is a second authenticated mashgiach at the same venue.
    assert.equal(people.assign.role, 'mashgiach');
    assert.notEqual(people.mash.id, people.assign.id);
    const race = async (items) => {
      const results = await Promise.all(items.map((item, index) => api(index ? 'assign' : 'mash', 'POST', concurrentPath, { item, ticked: true })));
      for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.json));
      return (await ctx.getDoc()).tasks.find((t) => t.id === concurrentId);
    };
    let raced = await race([0, 1]);
    assert.equal(raced.checklistTicks.length, 2, 'counter is 2/3');
    assert.equal(raced.checklistItems.length, 3);
    assert.equal(raced.isCompleted, false);
    assert.equal(raced.currentStatus, 'pending');
    for (const [item, person] of [[0, people.mash], [1, people.assign]]) {
      const entry = raced.checklistTicks.find((t) => t.item === item);
      assert.equal(entry.byName, person.name);
      assert.equal(entry.byEmail, person.email);
      assert.ok(Number.isFinite(Date.parse(entry.at)));
    }
    const third = await api('mash', 'POST', concurrentPath, { item: 2, ticked: true });
    assert.equal(third.status, 200);
    assert.equal(third.json.isCompleted, true);
    assert.equal(third.json.currentStatus, 'completed');
    assert.equal(third.json.checklistTicks.length, 3);
    assert.equal((await api('mash', 'POST', concurrentPath, { item: 0, ticked: false })).status, 200);
    raced = await race([0, 0]);
    const sameItem = raced.checklistTicks.filter((t) => t.item === 0);
    assert.equal(sameItem.length, 1, 'same-item last commit wins without duplicate ticks');
    assert.ok([people.mash, people.assign].some((p) => sameItem[0].byName === p.name && sameItem[0].byEmail === p.email));
    assert.equal(raced.checklistTicks.length, 3);
    assert.equal(raced.isCompleted, true);
    return JSON.stringify({ costs, concurrency: 'different items: 2/3 then 3/3; same item: one tick, no duplicates' });
  },
};
