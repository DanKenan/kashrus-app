import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 110: Task form people, built-ins, atomic batch and write costs',
  whatItProves: 'Code defaults require zero writes; venue overrides and tombstones persist; task-owned per-day people and date swaps route private visibility and overdue pushes; a batch commits atomically with one push per person.',
  async run(baseUrl, ctx) {
    const { api, venueId, venue2, people } = await shiftFixture(baseUrl, ctx, '110');
    const clock = async (iso) => assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso })).status, 200);
    const read = async (who = 'admin', v = venueId) => {
      const r = await api(who, 'GET', `/api/tasks?venueId=${v}`);
      assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
    };
    const meter = async () => (await ctx.api('POST', '/api/__test__/writes', {})).json.total;
    const reads = async () => (await ctx.api('POST', '/api/__test__/reads', {})).json.total;
    const costs = {};
    const measure = async (label, expected, action, expectedReads = expected || 1) => {
      const before = await meter(), beforeReads = await reads(); const result = await action();
      const delta = (await meter()) - before; costs[label] = delta;
      const readDelta = (await reads()) - beforeReads;
      console.log(`[writes] TASKFORM ${label}: ${delta}; reads: ${readDelta}`);
      assert.equal(readDelta, label.startsWith('GET') ? 0 : expectedReads, `${label} reads`);
      assert.equal(delta, expected, label); return result;
    };
    const save = async (id, body) => {
      const r = await api('admin', 'PUT', `/api/tasks/${id}`, { ...body, expectedVersion: await ctx.getVersion() });
      assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
    };
    const endpoints = {};
    try {
      await clock('2026-11-06T12:00:00Z');
      const fresh = await measure('GET tasks and shifts', 0, () => read());
      assert.deepEqual(fresh.shifts.map((s) => s.id.split(':')[0]).sort(), ['builtin-afternoon', 'builtin-morning', 'builtin-night']);
      assert.equal((await ctx.getDoc()).shifts.some((s) => s.venueId === venueId), false);
      const builtin = (key, v = venueId) => `builtin-${key}:${encodeURIComponent(v)}`;
      const late = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Existing late task', targetTime: '11:00 PM' });
      assert.equal(late.status, 201);
      const originalLate = (await ctx.getDoc()).tasks.find((t) => t.id === late.json.id);
      await measure('create 1 task in populated venue', 2, async () => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Earlier single', targetTime: '10:30 PM' });
        assert.equal(r.status, 201); assert.ok(r.json.sortOrder < originalLate.sortOrder);
      });
      for (const who of ['mash', 'assign', 'coord']) {
        endpoints[who] = `https://push.example/taskform-${people[who].id}`;
        assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint: endpoints[who], keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      }
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const batchBody = { venueId, operationId: randomUUID(), shiftId: 'builtin-afternoon', assignmentMode: 'task', assignedTo: [people.mash.email], isPrivate: true, enableOverdueAlert: true, tasks: Array.from({ length: 5 }, (_, i) => ({ title: `Taskform ${i}` })) };
      const created = await measure('create 5 tasks', 6, async () => {
        const r = await api('admin', 'POST', '/api/tasks', batchBody);
        assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.tasks;
      });
      await measure('batch retry', 0, async () => {
        const r = await api('admin', 'POST', '/api/tasks', batchBody);
        assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.tasks, created);
      });
      assert.equal((await api('admin', 'POST', '/api/tasks', { ...batchBody, tasks: [{ title: 'Changed payload' }] })).status, 409);
      assert.equal(created.length, 5);
      assert.deepEqual((await ctx.getDoc()).tasks.find((t) => t.id === originalLate.id), originalLate, 'inserting before an existing task never rewrites it');
      assert.ok(created.every((t) => t.sortOrder < originalLate.sortOrder));
      assert.equal(new Set(created.map((t) => t.sortOrder)).size, 5);
      assert.equal(created[0].targetTime, '2:00 PM'); assert.equal(created[0].targetTime2, '10:00 PM');
      await new Promise((r) => setTimeout(r, 150));
      let pushes = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.deepEqual(pushes.filter((p) => p.title === '📋 New task assigned to you').map((p) => p.endpoint), [endpoints.mash]);
      const id = created[0].id;
      await measure('change one weekday', 2, () => save(id, { dayAssignees: { '5': [people.assign.email] } }));
      await measure('one-time swap', 2, () => save(id, { assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.coord.email] }] }));
      await measure('unchanged task save', 0, () => save(id, { dayAssignees: { '5': [people.assign.email] }, assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.coord.email] }] }));
      assert.ok((await read('assign')).tasks.some((t) => t.id === id), 'weekday assignee can see private task');
      assert.equal((await read('elsewhere')).tasks.some((t) => t.id === id), false);
      const edit = await measure('first built-in edit', 1, async () => {
        const r = await api('admin', 'PUT', '/api/shifts/builtin-morning', { venueId, endMinutes: 800, userIds: [people.mash.id] });
        assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
      });
      await measure('unchanged shift save', 0, async () => assert.equal((await api('admin', 'PUT', '/api/shifts/builtin-morning', edit)).status, 200));
      assert.equal((await read('admin', venue2)).shifts.find((s) => s.id === builtin('morning', venue2)).endMinutes, 840, 'other venue unchanged');
      await measure('drag-release shift hours', 1, async () => {
        const r = await api('admin', 'PUT', `/api/shifts/${encodeURIComponent(edit.id)}`, { endMinutes: 801 });
        assert.equal(r.status, 200);
      });
      const beforeOld = (await read()).tasks.find((t) => t.id === id);
      const oldPayload = { title: 'Taskform 0 old client', assignedTo: ['all'], isPrivate: false };
      await measure('old-client title edit', 2, async () => {
        const r = await save(id, oldPayload);
        assert.deepEqual(r.assignedTo, beforeOld.assignedTo); assert.equal(r.isPrivate, true);
        assert.deepEqual(r.dayAssignees, beforeOld.dayAssignees); assert.deepEqual(r.assigneeSwaps, beforeOld.assigneeSwaps);
      });
      await measure('unchanged old-client save', 0, () => save(id, oldPayload));
      await measure('old-client people change refused', 0, async () => {
        const r = await api('admin', 'PUT', `/api/tasks/${id}`, { assignedTo: [people.coord.email], expectedVersion: await ctx.getVersion() });
        assert.equal(r.status, 409); assert.equal(r.json.error, 'Update the app to change who does this task');
      });
      await save(id, { title: 'Taskform 0' });
      // Legacy shift tasks still follow shift people; their assignedTo fallback is all.
      const legacy = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Taskform legacy', shiftId: edit.id, assignedTo: [people.assign.email], enableOverdueAlert: true });
      assert.equal(legacy.status, 201); assert.deepEqual(legacy.json.assignedTo, ['all']);
      const check = async (iso, title, expected) => {
        await clock(iso); await ctx.api('POST', '/api/__test__/push-log/clear', {});
        assert.equal((await ctx.api('POST', '/api/__test__/overdue-check', { clear: true })).status, 200);
        await new Promise((r) => setTimeout(r, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        assert.deepEqual(log.filter((p) => p.title === `Overdue: ${title}`).map((p) => p.endpoint).sort(), expected.map((w) => endpoints[w]).sort(), `${title} at ${iso}`);
      };
      await check('2026-11-06T22:01:00Z', 'Taskform 0', ['coord']);
      await check('2026-11-13T22:01:00Z', 'Taskform 0', ['assign']);
      await check('2026-11-14T22:01:00Z', 'Taskform 0', ['mash']);
      await check('2026-11-06T13:22:00Z', 'Taskform legacy', ['mash']);
      // Private visibility includes upcoming swaps, but not expired ones.
      const swapOnly = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Swap visibility', isPrivate: true, assignedTo: [people.mash.email], assigneeSwaps: [{ date: '2026-11-07', assignedTo: [people.assign.email] }] });
      assert.equal(swapOnly.status, 201);
      assert.ok((await read('assign')).tasks.some((t) => t.id === swapOnly.json.id));
      await clock('2026-11-08T12:00:00Z');
      assert.equal((await read('assign')).tasks.some((t) => t.id === swapOnly.json.id), false);
      await measure('unchanged with expired swap', 0, () => save(swapOnly.json.id, { title: 'Swap visibility' }));
      const pruned = await save(swapOnly.json.id, { title: 'Swap visibility edited' });
      assert.deepEqual(pruned.assigneeSwaps, []);
      await clock('2026-11-06T22:00:00Z');
      const night = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Taskform Night', shiftId: 'builtin-night', assignmentMode: 'task', assignedTo: [people.mash.email], dayAssignees: { '5': [people.coord.email] }, assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.assign.email] }], isPrivate: true, enableOverdueAlert: true });
      assert.equal(night.status, 201);
      await clock('2026-11-07T01:00:00Z');
      const nightEdited = await save(night.json.id, { title: 'Taskform Night edited', assignedTo: ['all'], isPrivate: false });
      assert.equal(nightEdited.isPrivate, true);
      assert.deepEqual(nightEdited.assigneeSwaps, [{ date: '2026-11-06', assignedTo: [people.assign.email] }]);
      assert.ok((await read('assign')).tasks.some((t) => t.id === night.json.id));
      await clock('2026-11-07T06:01:00Z');
      const tailEdit = await save(night.json.id, { description: 'Edit during overdue tail' });
      assert.deepEqual(tailEdit.assigneeSwaps, nightEdited.assigneeSwaps);
      assert.ok((await read('assign')).tasks.some((t) => t.id === night.json.id), 'private swap person remains visible after overnight end');
      await check('2026-11-07T06:01:00Z', 'Taskform Night edited', ['assign']);
      await clock('2026-11-07T22:00:00Z');
      assert.equal((await read('assign')).tasks.some((t) => t.id === night.json.id), false, 'expired swap no longer grants private access');
      assert.deepEqual((await save(night.json.id, { description: 'Next occurrence' })).assigneeSwaps, []);

      const beforeBad = await read();
      await measure('invalid batch', 0, async () => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, tasks: [{ title: 'Good' }, { title: 'Bad', dayAssignees: { '5': [people.foreign.email] } }] });
        assert.equal(r.status, 400, JSON.stringify(r.json));
      });
      assert.deepEqual((await read()).tasks.map((t) => t.id), beforeBad.tasks.map((t) => t.id));
      for (const bad of [{ dayAssignees: { '7': [] } }, { assigneeSwaps: [{ date: '2026-02-30', assignedTo: [] }] }, { assignmentMode: 'shift' }, { assigneeSwaps: Array.from({ length: 31 }, (_, i) => ({ date: `2026-12-${String(i + 1).padStart(2, '0')}`, assignedTo: [] })) }]) {
        assert.equal((await api('admin', 'POST', '/api/tasks', { venueId, title: 'Bad fields', ...bad })).status, 400);
      }
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('night', venue2))}`, { venueId })).status, 404);
      await measure('delete unused built-in', 1, async () => assert.equal((await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('night', venue2))}`)).status, 200));
      await measure('delete attached built-in', 2, async () => assert.equal((await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('morning'))}`)).status, 200));
      assert.equal((await read()).tasks.find((t) => t.id === legacy.json.id).shiftId, null);
      assert.equal((await ctx.getDoc()).shifts.find((s) => s.id === builtin('morning') && s.venueId === venueId).deleted, true);
      if (ctx.restartServer) await ctx.restartServer();
      assert.equal((await read()).shifts.some((s) => s.id === builtin('morning')), false, 'tombstone survives reload');
      assert.equal((await read('admin', venue2)).shifts.some((s) => s.id === builtin('night', venue2)), false);
      await measure('GET after reload', 0, () => read());
      return JSON.stringify(costs);
    } finally { await clock(null); }
  },
};
