import { futureWeekday } from './future-dates.mjs';
import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 105: optional own time on a shift task',
  whatItProves: 'Own times persist and survive live projection, partial edits and detachment; overdue uses own time only on shift dates, with unchanged recipients and fallback deadlines.',
  async run(baseUrl, ctx) {
    const { api, venueId, people } = await shiftFixture(baseUrl, ctx, '105');
    const { date } = futureWeekday('UTC', 0);
    const sunday = date();
    const clock = async (day, time) => assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso: `${day}T${time}:00Z` })).status, 200);
    const put = async (id, body) => {
      const r = await api('admin', 'PUT', `/api/tasks/${id}`, { ...body, expectedVersion: await ctx.getVersion() });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    const get = async (id) => (await api('admin', 'GET', `/api/tasks?venueId=${venueId}`)).json.tasks.find((t) => t.id === id);
    try {
      await clock(sunday, '12:00');
      const sr = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Deli day', daysOfWeek: [0], startMinutes: 480, endMinutes: 1080, userId: people.mash.id });
      assert.equal(sr.status, 201, JSON.stringify(sr.json));
      const shiftId = sr.json.id;
      const create = async (extra = {}) => {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, title: 'SHIFTTIME temperature log', shiftId, enableOverdueAlert: true, ...extra });
        assert.equal(r.status, 201, JSON.stringify(r.json));
        return r.json;
      };
      const own = await create({ shiftTime: true, targetTime: '2:00 PM', targetTimeMinutes: 840 });
      const stored = (await ctx.getDoc()).tasks.find((t) => t.id === own.id);
      assert.equal(stored.shiftId, shiftId);
      assert.equal(stored.shiftTime, true);
      assert.equal(stored.targetTimeMinutes, 840);
      assert.deepEqual(stored.assignedTo, ['all']);
      assert.equal((await get(own.id)).targetTime, '2:00 PM');
      const fallback = await create();
      assert.equal(fallback.shiftTime, undefined);
      assert.equal(fallback.targetTime2Minutes, 1080);
      // Inferring own time also supports callers that only change time fields.
      const inferred = await create({ targetTime: '1:00 PM' });
      assert.equal(inferred.shiftTime, true);
      assert.equal(inferred.targetTimeMinutes, 780);
      assert.equal(inferred.targetTime2, undefined);
      await put(inferred.id, { shiftTime: false });
      assert.equal((await get(inferred.id)).targetTimeMinutes, 480);
      let changed = await put(own.id, { targetTime: '2:30 PM' });
      assert.equal(changed.targetTimeMinutes, 870);
      changed = await put(own.id, { targetTimeMinutes: 840 });
      assert.equal(changed.targetTime, '2:00 PM');
      changed = await put(own.id, { targetTime2: '3:00 PM' });
      assert.equal(changed.targetTime2Minutes, 900);
      changed = await put(own.id, { targetTime2: '', targetTime2Minutes: null });
      assert.equal(changed.targetTime2, undefined);
      for (const bad of [{ targetTime: '25:00' }, { targetTimeMinutes: 1440 }, { targetTime: '2:00 PM', targetTimeMinutes: 900 }, { shiftTime: 'yes' }]) {
        const r = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Invalid own time', shiftId, shiftTime: true, ...bad });
        assert.equal(r.status, 400, JSON.stringify(r.json));
      }
      const endpoint = `https://push.example/shift-time-${people.mash.id}`;
      assert.equal((await api('mash', 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      const check = async (day, time, expected) => {
        await clock(day, time);
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        assert.equal(r.status, 200);
        const ids = [own.id, fallback.id];
        assert.deepEqual(r.json.notified.filter((k) => ids.some((id) => k.startsWith(`${id}:`))).sort(), expected.map((id) => `${id}:${day}`).sort());
        const dash = await api('admin', 'GET', '/api/admin/dashboard');
        const list = dash.json.venues.find((v) => v.venue.id === venueId).overdueTaskList;
        assert.deepEqual(list.filter((t) => ids.includes(t.id)).map((t) => t.id).sort(), [...expected].sort());
        if (expected.includes(own.id)) assert.equal(list.find((t) => t.id === own.id).targetTime, '2:00 PM');
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        const pushes = log.filter((e) => e.title === 'Overdue: SHIFTTIME temperature log');
        assert.equal(pushes.length, expected.includes(own.id) ? (time === '18:01' ? 3 : 1) : 0);
        assert.ok(pushes.every((e) => e.endpoint === endpoint));
      };
      await check(sunday, '14:00', []);
      await check(sunday, '14:01', [own.id]);
      await check(sunday, '18:01', [own.id, fallback.id]);
      await check(date(1), '15:00', []);
      await clock(sunday, '12:00');
      changed = await put(own.id, { shiftTime: false });
      assert.equal(changed.shiftTime, undefined);
      assert.equal(changed.targetTimeMinutes, 480);
      assert.equal(changed.targetTime2Minutes, 1080);
      changed = await put(own.id, { targetTime: '2:00 PM' });
      assert.equal(changed.shiftTime, true);
      assert.equal(changed.targetTime2, undefined);
      changed = await put(own.id, { shiftId: null });
      assert.equal(changed.shiftId, null);
      assert.equal(changed.shiftTime, undefined);
      assert.equal(changed.targetTimeMinutes, 840);
      const ordinary = await put(fallback.id, { shiftId: null });
      assert.equal(ordinary.targetTimeMinutes, 480);
      assert.equal(ordinary.targetTime2Minutes, 1080);
      // Deleting a varying-hours shift retains one own-time task and all shift days.
      const attached = await create({ targetTime: '2:00 PM' });
      assert.equal((await api('admin', 'PUT', `/api/shifts/${shiftId}`, { days: Array.from({ length: 7 }, (_, w) => ({ on: w < 2, ...(w === 1 ? { startMinutes: 600, endMinutes: 960 } : {}) })) })).status, 200);
      assert.equal((await get(attached.id)).targetTimeMinutes, 840);
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${shiftId}`)).status, 200);
      const detached = await get(attached.id);
      assert.equal(detached.shiftId, null);
      assert.equal(detached.shiftTime, undefined);
      assert.equal(detached.targetTimeMinutes, 840);
      assert.deepEqual(detached.daysOfWeek, [0, 1]);
      const once = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Once', oneTimeDate: sunday, startMinutes: 480, endMinutes: 1080, userId: people.mash.id });
      assert.equal(once.status, 201);
      const dated = await create({ shiftId: once.json.id, targetTime: '2:00 PM' });
      await clock(date(2), '12:00');
      // Any shift write prunes expired one-time shifts, without another document read.
      assert.equal((await api('admin', 'POST', '/api/shifts', { venueId, name: 'Trigger prune', daysOfWeek: [0], startMinutes: 480, endMinutes: 1080 })).status, 201);
      const pruned = (await ctx.getDoc()).tasks.find((t) => t.id === dated.id);
      assert.equal(pruned.shiftId, null);
      assert.equal(pruned.shiftTime, undefined);
      assert.equal(pruned.targetTimeMinutes, 840);
      assert.deepEqual(pruned.specificDates, [sunday]);
      return 'own-time CRUD, validation, live reads, overdue boundaries/recipients, detach, varying hours and one-time expiry passed';
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
    }
  },
};
