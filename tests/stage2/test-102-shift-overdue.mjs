import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 102: shift overdue uses live days and window end',
  whatItProves: 'Both overdue push checks and dashboard use the shift end and start weekday, including a midnight-crossing shift; editing the shift changes task deadlines immediately.',
  async run(baseUrl, ctx) {
    const { api, venueId, agencyId, people } = await shiftFixture(baseUrl, ctx, '102');
    const legacy = { agencyId, venueId, name: 'Legacy', startMinutes: 480, endMinutes: 1080, userId: people.mash.id };
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { shifts: [
      { ...legacy, id: `${venueId}-no-overrides`, daysOfWeek: [0] },
      { ...legacy, id: `${venueId}-no-days` },
      { ...legacy, id: `${venueId}-bad-hours`, startMinutes: -1 },
    ] })).status, 200);
    const hydrated = await api('mash', 'GET', `/api/tasks?venueId=${venueId}`);
    assert.equal(hydrated.status, 200, 'legacy shifts do not crash task loading');
    assert.equal(hydrated.json.shifts.find((s) => s.id.endsWith('-no-overrides')).days[0].on, true);
    assert.equal('daysOfWeek' in hydrated.json.shifts[0], false);
    assert.deepEqual(hydrated.json.shifts.find((s) => s.id.endsWith('-no-overrides')).overrides, []);
    assert.deepEqual(hydrated.json.shifts.find((s) => s.id.endsWith('-no-days')).days, Array.from({ length: 7 }, () => ({ on: false })));
    assert.equal(hydrated.json.shifts.some((s) => s.id.endsWith('-bad-hours')), false);
    // Pick Sunday within the next week; all boundaries are venue-local UTC.
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + (7 - date.getUTCDay()) % 7);
    const sunday = date.toISOString().slice(0, 10);
    const nextDay = (n) => new Date(Date.parse(`${sunday}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const clock = async (day, time) => {
      const r = await ctx.api('POST', '/api/__test__/clock', { iso: `${day}T${time}:00Z` });
      assert.equal(r.status, 200);
    };
    const create = async (name, startMinutes, endMinutes) => {
      const r = await api('admin', 'POST', '/api/shifts', { venueId, name, area: '',
        days: Array.from({ length: 7 }, (_, w) => ({ on: w === 0 || (name === 'Night' && w === 1), ...(name === 'Night' && w === 0 ? { userId: people.assign.id, startMinutes, endMinutes } : {}), ...(name === 'Night' && w === 1 ? { userId: people.mash.id, startMinutes: 600, endMinutes: 900 } : {}) })),
        startMinutes: 480, endMinutes: 1080, userId: people.mash.id, overrides: [] });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const t = await api('admin', 'POST', '/api/tasks', { venueId, title: name, shiftId: r.json.id, targetTime: 'Any time', enableOverdueAlert: true, daysOfWeek: [1] });
      assert.equal(t.status, 201, JSON.stringify(t.json));
      assert.equal(t.json.enableOverdueAlert, true);
      return { shift: r.json, task: t.json };
    };
    const endpoints = {};
    for (const who of ['mash', 'assign', 'coord']) {
      endpoints[who] = `https://push.example/overdue-${people[who].id}`;
      assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint: endpoints[who], keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
    }
    const ids = [];
    const expectedPeople = new Map();
    const check = async (expected, expectedDay = sunday) => {
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      assert.equal(r.status, 200);
      const keys = r.json.notified.filter((k) => ids.some((id) => k.startsWith(`${id}:`))).sort();
      assert.deepEqual(keys, expected.map((id) => `${id}:${expectedDay}`).sort(), 'overdue push keys');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      const pushes = log.filter((e) => e.title === 'Overdue: Day' || e.title === 'Overdue: Night');
      assert.deepEqual(pushes.map((e) => e.endpoint).sort(), expected.map((id) => expectedPeople.get(id)).filter(Boolean).sort(), 'only the occurrence person receives overdue push');
      const dash = await api('admin', 'GET', '/api/admin/dashboard');
      assert.equal(dash.status, 200);
      const venue = dash.json.venues.find((v) => v.venue.id === venueId);
      assert.ok(venue, JSON.stringify(dash.json));
      assert.deepEqual(venue.overdueTaskList.map((t) => t.id).sort(), [...expected].sort(), 'dashboard overdue list');
      for (const item of venue.overdueTaskList) {
        assert.equal(item.targetTime, item.title === 'Night' ? (expectedDay === sunday ? '2:00 AM' : '3:00 PM') : expectedDay === sunday ? '6:00 PM' : '8:00 PM', 'dashboard displays the occurrence window end');
      }
    };
    try {
      await clock(sunday, '12:00');
      const day = await create('Day', 480, 1080);
      const night = await create('Night', 1320, 120);
      ids.push(day.task.id, night.task.id);
      expectedPeople.set(day.task.id, endpoints.mash);
      expectedPeople.set(night.task.id, endpoints.coord);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${night.shift.id}`, { overrides: [{ date: sunday, userId: people.coord.id }] })).status, 200);
      await check([]); // Day has started but its end has not passed.
      await clock(sunday, '18:00'); await check([]);
      await clock(sunday, '18:01'); await check([day.task.id]);
      await clock(sunday, '23:30'); await check([day.task.id]);
      await clock(nextDay(1), '01:00'); await check([]);
      await clock(nextDay(1), '02:00'); await check([]);
      await clock(nextDay(1), '02:01'); await check([night.task.id]);
      // Writing on Sunday keeps its override; it still decides Monday's push.
      await clock(sunday, '23:30');
      assert.equal((await api('admin', 'PUT', `/api/shifts/${night.shift.id}`, { overrides: [{ date: sunday, userId: null }] })).status, 200);
      expectedPeople.set(night.task.id, null);
      await clock(nextDay(1), '02:01'); await check([night.task.id]);
      expectedPeople.set(night.task.id, endpoints.mash);
      await clock(nextDay(1), '15:01'); await check([night.task.id], nextDay(1));
      await clock(nextDay(2), '19:00'); await check([]);
      // Change live days and hours; the task's saved Sunday window is stale.
      const edit = await api('admin', 'PUT', `/api/shifts/${day.shift.id}`, { daysOfWeek: [2], endMinutes: 1200 });
      assert.equal(edit.status, 200);
      await check([]);
      await clock(nextDay(2), '20:01'); await check([day.task.id], nextDay(2));
      const onceDate = nextDay(3);
      await clock(onceDate, '09:00');
      const once = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Once', oneTimeDate: onceDate, startMinutes: 480, endMinutes: 600, userId: people.assign.id });
      assert.equal(once.status, 201, JSON.stringify(once.json));
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const onceTask = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Once', shiftId: once.json.id, enableOverdueAlert: true });
      assert.equal(onceTask.status, 201);
      await new Promise((resolve) => setTimeout(resolve, 150));
      let pushes = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.deepEqual(pushes.filter((e) => e.title === '📋 New task assigned to you').map((e) => e.endpoint), [endpoints.assign]);
      const onceOverdue = async (ymd, time, expected) => {
        await clock(ymd, time);
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.notified.filter((k) => k.startsWith(`${onceTask.json.id}:`)), expected ? [`${onceTask.json.id}:${onceDate}`] : []);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        assert.deepEqual(log.filter((e) => e.title === 'Overdue: Once').map((e) => e.endpoint), expected ? [endpoints.assign] : []);
      };
      await onceOverdue(onceDate, '10:00', false);
      await onceOverdue(onceDate, '10:01', true);
      await onceOverdue(nextDay(4), '10:01', false);
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      assert.equal((await api('admin', 'POST', '/api/tasks', { venueId, title: 'Once after date', shiftId: once.json.id })).status, 201);
      await new Promise((resolve) => setTimeout(resolve, 150));
      pushes = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.equal(pushes.some((e) => e.title === '📋 New task assigned to you'), false);
      return 'window end boundaries, non-shift days, overnight start-date keys and live shift edits agree across push and dashboard';
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
    }
  },
};
