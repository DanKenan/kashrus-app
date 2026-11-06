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
    const measure = async (label, expectedReads, expectedWrites, action) => {
      const before = await meter(), beforeReads = await reads(); const result = await action();
      const delta = (await meter()) - before; costs[label] = delta;
      const readDelta = (await reads()) - beforeReads;
      console.log(`[writes] TASKFORM ${label}: ${delta}; reads: ${readDelta}`);
      assert.equal(readDelta, expectedReads, `${label} reads`);
      assert.equal(delta, expectedWrites, `${label} writes`); return result;
    };
    const save = async (id, body, expectedVersion) => {
      const r = await api('admin', 'PUT', `/api/tasks/${id}`, { ...body, expectedVersion });
      assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
    };
    const measureSave = async (label, expectedReads, expectedWrites, id, body) => {
      const expectedVersion = await ctx.getVersion();
      return measure(label, expectedReads, expectedWrites, () => save(id, body, expectedVersion));
    };
    const endpoints = {};
    try {
      await clock('2026-11-06T12:00:00Z');
      const fresh = await measure('GET tasks and shifts', 0, 0, () => read());
      assert.deepEqual(fresh.shifts.map((s) => s.id.split(':')[0]).sort(), ['builtin-afternoon', 'builtin-morning', 'builtin-night']);
      assert.equal((await ctx.getDoc()).shifts.some((s) => s.venueId === venueId), false);
      const builtin = (key, v = venueId) => `builtin-${key}:${encodeURIComponent(v)}`;
      const late = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Existing late task', targetTime: '11:00 PM' });
      assert.equal(late.status, 201);
      const originalLate = (await ctx.getDoc()).tasks.find((t) => t.id === late.json.id);
      await measure('create 1 task in populated venue', 2, 2, async () => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Earlier single', targetTime: '10:30 PM' });
        assert.equal(r.status, 201); assert.ok(r.json.sortOrder < originalLate.sortOrder);
      });
      for (const who of ['mash', 'assign', 'coord']) {
        endpoints[who] = `https://push.example/taskform-${people[who].id}`;
        assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint: endpoints[who], keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      }
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const batchBody = { venueId, operationId: randomUUID(), shiftId: 'builtin-afternoon', assignmentMode: 'task', assignedTo: [people.mash.email], isPrivate: true, enableOverdueAlert: true, tasks: Array.from({ length: 5 }, (_, i) => ({ title: `Taskform ${i}` })) };
      const created = await measure('create 5 tasks', 6, 6, async () => {
        const r = await api('admin', 'POST', '/api/tasks', batchBody);
        assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.tasks;
      });
      const receipt = (await ctx.getDoc()).idempotencyRecords.find((r) => r.key === `${people.admin.id}:${batchBody.operationId}`);
      assert.equal(receipt.operation, 'create-task');
      assert.deepEqual(receipt.result.tasks, created);
      await measure('batch retry', 1, 0, async () => {
        const r = await api('admin', 'POST', '/api/tasks', batchBody);
        assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.tasks, created);
      });
      await measure('batch payload mismatch', 1, 0, async () => {
        assert.equal((await api('admin', 'POST', '/api/tasks', { ...batchBody, tasks: [{ title: 'Changed payload' }] })).status, 409);
      });
      assert.equal(created.length, 5);
      assert.deepEqual((await ctx.getDoc()).tasks.find((t) => t.id === originalLate.id), originalLate, 'inserting before an existing task never rewrites it');
      assert.ok(created.every((t) => t.sortOrder < originalLate.sortOrder));
      assert.equal(new Set(created.map((t) => t.sortOrder)).size, 5);
      assert.equal(created[0].targetTime, '2:00 PM'); assert.equal(created[0].targetTime2, '10:00 PM');
      await new Promise((r) => setTimeout(r, 150));
      let pushes = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.deepEqual(pushes.filter((p) => p.title === '📋 New task assigned to you').map((p) => p.endpoint), [endpoints.mash]);
      const id = created[0].id;
      await measureSave('change one weekday', 2, 2, id, { dayAssignees: { '5': [people.assign.email] } });
      await measureSave('one-time swap', 2, 2, id, { assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.coord.email] }] });
      await measureSave('unchanged task save', 1, 0, id, { dayAssignees: { '5': [people.assign.email] }, assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.coord.email] }] });
      assert.ok((await read('assign')).tasks.some((t) => t.id === id), 'weekday assignee can see private task');
      assert.equal((await read('elsewhere')).tasks.some((t) => t.id === id), false);
      const edit = await measure('first built-in edit', 1, 1, async () => {
        const r = await api('admin', 'PUT', `/api/shifts/${encodeURIComponent(builtin('morning'))}`, { venueId, endMinutes: 800, userIds: [people.mash.id] });
        assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
      });
      await measure('unchanged shift save', 1, 0, async () => assert.equal((await api('admin', 'PUT', '/api/shifts/builtin-morning', edit)).status, 200));
      assert.equal((await read('admin', venue2)).shifts.find((s) => s.id === builtin('morning', venue2)).endMinutes, 840, 'other venue unchanged');
      await measure('drag-release shift hours', 1, 1, async () => {
        const r = await api('admin', 'PUT', `/api/shifts/${encodeURIComponent(edit.id)}`, { endMinutes: 801 });
        assert.equal(r.status, 200);
      });
      const beforeOld = (await read()).tasks.find((t) => t.id === id);
      const oldPayload = { title: 'Taskform 0 old client', assignedTo: ['all'], isPrivate: false };
      const oldTitleVersion = await ctx.getVersion();
      await measure('old-client title edit', 2, 2, async () => {
        const r = await save(id, oldPayload, oldTitleVersion);
        assert.deepEqual(r.assignedTo, beforeOld.assignedTo); assert.equal(r.isPrivate, true);
        assert.deepEqual(r.dayAssignees, beforeOld.dayAssignees); assert.deepEqual(r.assigneeSwaps, beforeOld.assigneeSwaps);
      });
      await measureSave('unchanged old-client save', 1, 0, id, oldPayload);
      const refusedVersion = await ctx.getVersion();
      await measure('old-client people change refused', 1, 0, async () => {
        const r = await api('admin', 'PUT', `/api/tasks/${id}`, { assignedTo: [people.coord.email], expectedVersion: refusedVersion });
        assert.equal(r.status, 409); assert.equal(r.json.error, 'Update the app to change who does this task');
      });
      await save(id, { title: 'Taskform 0' }, await ctx.getVersion());
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
      // POST uses the real clock: check this daily shift at least two days later.
      const legacyCheckAt = new Date(Date.now() + 3 * 86_400_000);
      legacyCheckAt.setUTCHours(13, 22, 0, 0);
      await check(legacyCheckAt.toISOString(), 'Taskform legacy', ['mash']);
      await clock('2026-11-06T13:22:00Z'); // Restore the date for the swap fixtures below.
      // Private visibility includes upcoming swaps, but not expired ones.
      const swapOnly = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Swap visibility', isPrivate: true, assignedTo: [people.mash.email], assigneeSwaps: [{ date: '2026-11-07', assignedTo: [people.assign.email] }] });
      assert.equal(swapOnly.status, 201);
      assert.ok((await read('assign')).tasks.some((t) => t.id === swapOnly.json.id));
      await clock('2026-11-08T12:00:00Z');
      assert.equal((await read('assign')).tasks.some((t) => t.id === swapOnly.json.id), false);
      await measureSave('unchanged with expired swap', 1, 0, swapOnly.json.id, { title: 'Swap visibility' });
      const pruned = await save(swapOnly.json.id, { title: 'Swap visibility edited' }, await ctx.getVersion());
      assert.deepEqual(pruned.assigneeSwaps, []);
      await clock('2026-11-06T22:00:00Z');
      const night = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Taskform Night', shiftId: 'builtin-night', assignmentMode: 'task', assignedTo: [people.mash.email], dayAssignees: { '5': [people.coord.email] }, assigneeSwaps: [{ date: '2026-11-06', assignedTo: [people.assign.email] }], isPrivate: true, enableOverdueAlert: true });
      assert.equal(night.status, 201);
      await clock('2026-11-07T01:00:00Z');
      const nightEdited = await save(night.json.id, { title: 'Taskform Night edited', assignedTo: ['all'], isPrivate: false }, await ctx.getVersion());
      assert.equal(nightEdited.isPrivate, true);
      assert.deepEqual(nightEdited.assigneeSwaps, [{ date: '2026-11-06', assignedTo: [people.assign.email] }]);
      assert.ok((await read('assign')).tasks.some((t) => t.id === night.json.id));
      await clock('2026-11-07T06:01:00Z');
      const tailEdit = await save(night.json.id, { description: 'Edit during overdue tail' }, await ctx.getVersion());
      assert.deepEqual(tailEdit.assigneeSwaps, nightEdited.assigneeSwaps);
      assert.ok((await read('assign')).tasks.some((t) => t.id === night.json.id), 'private swap person remains visible after overnight end');
      await check('2026-11-07T06:01:00Z', 'Taskform Night edited', ['assign']);
      await clock('2026-11-07T22:00:00Z');
      assert.equal((await read('assign')).tasks.some((t) => t.id === night.json.id), false, 'expired swap no longer grants private access');
      assert.deepEqual((await save(night.json.id, { description: 'Next occurrence' }, await ctx.getVersion())).assigneeSwaps, []);

      const everyDay = Object.fromEntries(Array.from({ length: 7 }, (_, w) => [String(w), [people.coord.email]]));
      const privateAllDays = await api('admin', 'POST', '/api/tasks', { venueId, title: 'All weekdays overridden', assignmentMode: 'task', assignedTo: [people.mash.email], dayAssignees: everyDay, assigneeSwaps: [{ date: '2026-11-08', assignedTo: [people.assign.email] }], isPrivate: true });
      assert.equal(privateAllDays.status, 201);
      assert.equal((await read('mash')).tasks.some((t) => t.id === privateAllDays.json.id), false, 'fully overridden base person has no private access');
      assert.ok((await read('assign')).tasks.some((t) => t.id === privateAllDays.json.id), 'upcoming swap still grants access');
      const { '0': _sunday, ...sixDays } = everyDay;
      await save(privateAllDays.json.id, { dayAssignees: sixDays }, await ctx.getVersion());
      assert.ok((await read('mash')).tasks.some((t) => t.id === privateAllDays.json.id), 'an uncovered weekday restores base fallback');

      const beforeBad = await read();
      await measure('invalid batch', 1, 0, async () => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, tasks: [{ title: 'Good' }, { title: 'Bad', dayAssignees: { '5': [people.foreign.email] } }] });
        assert.equal(r.status, 400, JSON.stringify(r.json));
      });
      assert.deepEqual((await read()).tasks.map((t) => t.id), beforeBad.tasks.map((t) => t.id));
      for (const bad of [{ dayAssignees: { '7': [] } }, { assigneeSwaps: [{ date: '2026-02-30', assignedTo: [] }] }, { assignmentMode: 'shift' }, { assigneeSwaps: Array.from({ length: 31 }, (_, i) => ({ date: `2026-12-${String(i + 1).padStart(2, '0')}`, assignedTo: [] })) }]) {
        assert.equal((await api('admin', 'POST', '/api/tasks', { venueId, title: 'Bad fields', ...bad })).status, 400);
      }
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('night', venue2))}`, { venueId })).status, 404);
      await measure('delete unused built-in', 1, 1, async () => assert.equal((await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('night', venue2))}`)).status, 200));
      await measure('delete attached built-in', 2, 2, async () => assert.equal((await api('admin', 'DELETE', '/api/shifts/builtin-morning', { venueId })).status, 200));
      assert.equal((await read()).tasks.find((t) => t.id === legacy.json.id).shiftId, null);
      assert.equal((await ctx.getDoc()).shifts.find((s) => s.id === builtin('morning') && s.venueId === venueId).deleted, true);
      if (ctx.restartServer) await ctx.restartServer();
      assert.equal((await read()).shifts.some((s) => s.id === builtin('morning')), false, 'tombstone survives reload');
      assert.equal((await read('admin', venue2)).shifts.some((s) => s.id === builtin('night', venue2)), false);
      await measure('batch retry after reload', 1, 0, async () => {
        const retry = await api('admin', 'POST', '/api/tasks', batchBody);
        assert.equal(retry.status, 200); assert.deepEqual(retry.json.tasks, created);
      });
      const thirdVenue = `${venueId}-suppression`;
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: thirdVenue, agencyId: people.admin.agencyId, name: 'Suppression and ordering', timeZone: 'UTC' }], tasks: [
        { ...late.json, id: `${thirdVenue}-early`, venueId: thirdVenue, title: 'Equal order early', targetTime: '8:00 AM', sortOrder: 0 },
        { ...late.json, id: `${thirdVenue}-late`, venueId: thirdVenue, title: 'Equal order late', targetTime: '10:00 AM', sortOrder: 0 },
      ] })).status, 200);
      const collision = await measure('create with exhausted order gap', 3, 3, () => api('admin', 'POST', '/api/tasks', { venueId: thirdVenue, title: 'Insert between equal positions', targetTime: '9:00 AM' }));
      assert.equal(collision.status, 201, JSON.stringify(collision.json));
      const ordered = (await read('admin', thirdVenue)).tasks.sort((a, b) => a.sortOrder - b.sortOrder);
      assert.deepEqual(ordered.map((t) => t.title), ['Equal order early', 'Insert between equal positions', 'Equal order late']);
      const extremeVenue = `${venueId}-wide-gap`;
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: extremeVenue, agencyId: people.admin.agencyId, name: 'Wide order gap', timeZone: 'UTC' }], tasks: [
        { ...late.json, id: `${extremeVenue}-early`, venueId: extremeVenue, targetTime: '8:00 AM', sortOrder: -1e308 },
        { ...late.json, id: `${extremeVenue}-late`, venueId: extremeVenue, targetTime: '10:00 AM', sortOrder: 1e308 },
      ] })).status, 200);
      await measure('create between wide order values', 2, 2, async () => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId: extremeVenue, title: 'Finite midpoint', targetTime: '9:00 AM' });
        assert.equal(r.status, 201); assert.equal(r.json.sortOrder, 0);
      });
      const customNight = await api('admin', 'POST', '/api/shifts', { venueId: thirdVenue, name: 'Night', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startMinutes: 1320, endMinutes: 360 });
      assert.equal(customNight.status, 201);
      assert.deepEqual((await read('admin', thirdVenue)).shifts.filter((shift) => shift.name === 'Night').map((shift) => shift.id), [customNight.json.id]);
      for (const shiftId of ['builtin-night', builtin('night', thirdVenue)]) {
        const hidden = await api('admin', 'POST', '/api/tasks', { venueId: thirdVenue, title: 'Hidden built-in', shiftId });
        assert.equal(hidden.status, 400, JSON.stringify(hidden.json));
      }
      await measure('GET after reload', 0, 0, () => read());
      return JSON.stringify(costs);
    } finally { await clock(null); }
  },
};
