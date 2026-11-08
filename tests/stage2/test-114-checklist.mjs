import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';
export default {
  name: 'Test 114: checklist completion, permissions and write budget',
  whatItProves: 'Validated checklist definitions; attributed ticks; all-items completion; unticking; partial overdue; legacy behavior; one commit per change and none per no-op.',
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
    const tick = async (item, ticked, delta = 1) => {
      const version = await ctx.getVersion();
      const r = await api('mash', 'POST', path, { item, ticked, byName: 'Forged' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await ctx.getVersion()) - version, delta, 'commit count');
      assert.deepEqual(await saved(), r.json);
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
    return 'checklist validation, attribution, scope, completion, partial overdue, edit reset, legacy tasks and commit counts passed';
  },
};
