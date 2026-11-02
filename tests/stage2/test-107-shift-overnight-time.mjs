import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 107: overnight own-time occurrence deadlines and explicit opt-in',
  whatItProves: 'Two people receive identity-bound overdue alerts for the start-date occurrence, including first checks after midnight; next-morning deadlines wait until that morning; enabling own time requires an explicit primary clock value.',
  async run(baseUrl, ctx) {
    const { api, venueId, people } = await shiftFixture(baseUrl, ctx, '107');
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
      await check(monday, '02:01', [0, 1]); // first tick after the shift ends
      await check(monday, '12:00', [0, 1]);
      await check(monday, '22:00', []);
      // Monday has a different person; both overdue paths must use Sunday.
      await clock(sunday, '22:00');
      const varied = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Occurrence people', startMinutes: 1320, endMinutes: 120, userIds: [people.coord.id],
        days: Array.from({ length: 7 }, (_, w) => ({ on: w < 2, ...(w === 0 ? { userIds: [people.mash.id, people.assign.id] } : w === 1 ? { userIds: [people.coord.id], startMinutes: 600, endMinutes: 1080 } : {}) })) });
      assert.equal(varied.status, 201);
      const mondayEndpoint = `https://push.example/monday-${people.coord.id}`;
      assert.equal((await api('coord', 'POST', '/api/push/subscribe', { subscription: { endpoint: mondayEndpoint, keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      for (const ownTime of [true, false]) {
        const title = ownTime ? 'Sunday own deadline' : 'Sunday window deadline';
        const made = await api('admin', 'POST', '/api/tasks', { venueId, title, shiftId: varied.json.id, enableOverdueAlert: true, ...(ownTime ? { shiftTime: true, targetTime: '11:30 PM' } : {}) });
        assert.equal(made.status, 201);
        await clock(monday, ownTime ? '00:30' : '02:01');
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const checked = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        assert.ok(checked.json.notified.includes(`${made.json.id}:${sunday}`));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        assert.deepEqual(log.filter((e) => e.title === `Overdue: ${title}`).map((e) => e.endpoint).sort(), [...endpoints].sort());
        assert.equal(log.some((e) => e.title === `Overdue: ${title}` && e.endpoint === mondayEndpoint), false);
        await clock(sunday, '22:00');
      }
      // Consecutive night shifts: Sunday's missed morning deadline survives its end.
      await clock(sunday, '22:00');
      const consecutive = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Consecutive nights', startMinutes: 1320, endMinutes: 120,
        days: Array.from({ length: 7 }, (_, w) => ({ on: w < 2, userIds: w === 0 ? [people.mash.id, people.assign.id] : [people.coord.id] })) });
      assert.equal(consecutive.status, 201);
      const morning = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Consecutive morning deadline', shiftId: consecutive.json.id, shiftTime: true, targetTime: '1:00 AM', enableOverdueAlert: true });
      assert.equal(morning.status, 201);
      for (const [date, time, occurrence, recipients] of [
        [monday, '02:01', sunday, endpoints], [monday, '23:00', null, []],
        ['2026-11-10', '01:30', monday, [mondayEndpoint]],
      ]) {
        await clock(date, time);
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const checked = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        assert.deepEqual(checked.json.notified.filter((key) => key.startsWith(`${morning.json.id}:`)), occurrence ? [`${morning.json.id}:${occurrence}`] : []);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        assert.deepEqual(log.filter((e) => e.title === `Overdue: ${morning.json.title}`).map((e) => e.endpoint).sort(), [...recipients].sort());
        const dashboard = await api('admin', 'GET', '/api/admin/dashboard');
        assert.equal(dashboard.json.venues.find((v) => v.venue.id === venueId).overdueTaskList.some((t) => t.id === morning.json.id), !!occurrence);
      }
      return 'overnight deadlines and occurrence recipients for own-time and shift-window tasks passed';
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
    }
  },
};
