import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 105: overnight own-time occurrence deadlines and explicit opt-in',
  whatItProves: 'Two people receive identity-bound overdue alerts for the start-date occurrence, including first checks after midnight; next-morning deadlines wait until that morning; enabling own time requires an explicit primary clock value.',
  async run(baseUrl, ctx) {
    const { api, venueId, people } = await shiftFixture(baseUrl, ctx, '105');
    const sunday = '2026-11-08', monday = '2026-11-09';
    const clock = async (date, time) => assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso: `${date}T${time}:00Z` })).status, 200);
    try {
      await clock(sunday, '22:00');
      const sr = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Two-person night', daysOfWeek: [0], startMinutes: 1320, endMinutes: 120, userIds: [people.mash.id, people.assign.id] });
      assert.equal(sr.status, 201);
      const shiftId = sr.json.id;
      const body = { venueId, title: 'Night fallback', shiftId };
      assert.equal((await api('admin', 'POST', '/api/tasks', { ...body, shiftTime: true })).status, 400);
      const fallback = await api('admin', 'POST', '/api/tasks', body);
      assert.equal(fallback.status, 201);
      for (const edit of [{ shiftTime: true }, { shiftTime: true, targetTime2: '1:00 AM' }, { targetTime2: '1:00 AM' }]) {
        const denied = await api('admin', 'PUT', `/api/tasks/${fallback.json.id}`, { ...edit, expectedVersion: await ctx.getVersion() });
        assert.equal(denied.status, 400, JSON.stringify(denied.json));
      }
      const explicit = await api('admin', 'PUT', `/api/tasks/${fallback.json.id}`, { shiftTime: true, targetTimeMinutes: 1410, expectedVersion: await ctx.getVersion() });
      assert.equal(explicit.status, 200);
      assert.equal(explicit.json.targetTime, '11:30 PM');
      // An existing own-time task may still receive ordinary partial edits.
      assert.equal((await api('admin', 'PUT', `/api/tasks/${fallback.json.id}`, { title: 'Renamed night task', expectedVersion: await ctx.getVersion() })).status, 200);
      assert.equal((await api('admin', 'DELETE', `/api/tasks/${fallback.json.id}`, { expectedVersion: await ctx.getVersion() })).status, 200);
      const endpoints = [];
      for (const who of ['mash', 'assign']) {
        const endpoint = `https://push.example/overnight-own-${people[who].id}`;
        endpoints.push(endpoint);
        assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      }
      const tasks = [];
      for (const [title, targetTime] of [['Late night', '11:30 PM'], ['Next morning', '1:00 AM']]) {
        const r = await api('admin', 'POST', '/api/tasks', { ...body, title, shiftTime: true, targetTime, enableOverdueAlert: true });
        assert.equal(r.status, 201);
        tasks.push(r.json);
      }
      const check = async (date, time, expected, clear = true) => {
        await clock(date, time);
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.notified.filter((key) => tasks.some((t) => key.startsWith(`${t.id}:`))).sort(), expected.map((i) => `${tasks[i].id}:${sunday}`).sort());
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        for (const [i, task] of tasks.entries()) assert.deepEqual(log.filter((e) => e.title === `Overdue: ${task.title}`).map((e) => e.endpoint).sort(), expected.includes(i) ? [...endpoints].sort() : []);
        const dashboard = await api('admin', 'GET', '/api/admin/dashboard');
        assert.equal(dashboard.status, 200);
        const list = dashboard.json.venues.find((v) => v.venue.id === venueId).overdueTaskList;
        const due = list.filter((t) => tasks.some((own) => own.id === t.id));
        const expectedDue = !clear ? [0] : expected;
        assert.deepEqual(due.map((t) => t.id).sort(), expectedDue.map((i) => tasks[i].id).sort());
        for (const t of due) assert.equal(t.targetTime, tasks.find((own) => own.id === t.id).targetTime);
      };
      await check(sunday, '23:00', []);
      await check(sunday, '23:45', [0]);
      await check(monday, '00:30', [0]); // clear=true models the first poll after midnight
      await check(monday, '00:31', [], false); // Sunday key deduplicates the same occurrence
      await check(monday, '01:30', [0, 1]);
      await check(monday, '12:00', []);
      return 'overnight start-date keys, both recipients, morning deadlines, daytime exclusion and explicit primary-time opt-in passed';
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
    }
  },
};
