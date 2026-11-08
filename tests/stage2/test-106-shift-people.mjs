import { futureWeekday } from './future-dates.mjs';
import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';
import { rewriteEmailRefs } from '../../src/server/account-merge.ts';

export default {
  name: 'Test 106: multiple people on a shift, legacy reads and merge remapping',
  whatItProves: 'Usual, weekday and date lists are validated and name-safe; both occurrence people receive identity-bound new-task and overdue pushes; legacy clients and records remain compatible; the merge helper rewrites and deduplicates all ID lists.',
  async run(baseUrl, ctx) {
    const { api, venueId, agencyId, people } = await shiftFixture(baseUrl, ctx, '106');
    const { date } = futureWeekday('UTC', 0);
    const sunday = date();
    const clock = async (time) => assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso: `${sunday}T${time}:00Z` })).status, 200);
    const usual = [people.mash.id, people.assign.id], replacement = [people.coord.id, people.admin.id];
    const body = { venueId, name: 'Deli day', daysOfWeek: [0], startMinutes: 480, endMinutes: 1080, userIds: usual, userNames: ['Forged'], userName: 'Forged' };
    const endpoints = new Map();
    const pushes = async (title, ids) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.deepEqual(log.filter((e) => e.title === title).map((e) => e.endpoint).sort(), ids.map((id) => endpoints.get(id)).sort(), title);
    };
    const clear = () => ctx.api('POST', '/api/__test__/push-log/clear', {});
    try {
      await clock('12:00');
      for (const who of ['mash', 'assign', 'coord', 'admin']) {
        const endpoint = `https://push.example/shift-people-${people[who].id}`;
        endpoints.set(people[who].id, endpoint);
        assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      }
      let r = await api('admin', 'POST', '/api/shifts', { ...body, userIds: [...usual, usual[0]] });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const id = r.json.id;
      assert.deepEqual(r.json.userIds, usual);
      assert.deepEqual(r.json.userNames, [people.mash.name, people.assign.name]);
      assert.equal(r.json.userId, usual[0]);
      assert.equal(r.json.userName, people.mash.name);
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { userId: usual[0], name: 'Deli day' });
      assert.deepEqual(r.json.userIds, usual, 'an unchanged legacy first ID must preserve the full list');
      const stored = (await ctx.getDoc()).shifts.find((s) => s.id === id);
      assert.deepEqual(stored.userIds, usual);
      assert.equal('userNames' in stored, false);
      for (const invalid of [[people.foreign.id], Array(11).fill(usual[0]), [null], 'bad']) {
        assert.equal((await api('admin', 'POST', '/api/shifts', { ...body, userIds: invalid })).status, 400);
        assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { userIds: invalid })).status, 400);
      }
      // Old bundles can still replace the usual person using their scalar field.
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { userId: usual[1] });
      assert.deepEqual(r.json.userIds, [usual[1]]);
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { userIds: usual });
      assert.equal(r.status, 200);
      const createTask = async (title) => {
        await clear();
        const t = await api('admin', 'POST', '/api/tasks', { venueId, title, shiftId: id, shiftTime: true, targetTime: '2:00 PM', enableOverdueAlert: true });
        assert.equal(t.status, 201, JSON.stringify(t.json));
        return t.json;
      };
      const task = await createTask('Two usual people');
      await pushes('📋 New task assigned to you', usual);
      await clear(); await clock('14:01');
      assert.equal((await ctx.api('POST', '/api/__test__/overdue-check', { clear: true })).status, 200);
      await pushes('Overdue: Two usual people', usual);
      await clock('12:00');
      const days = Array.from({ length: 7 }, (_, w) => ({ on: w === 0, ...(w === 0 ? { userIds: replacement, userNames: ['Forged'] } : {}) }));
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { days });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.days[0].userIds, replacement);
      assert.deepEqual(r.json.days[0].userNames, [people.coord.name, people.admin.name]);
      const legacyDays = r.json.days.map(({ userIds, userNames, ...day }) => day);
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { days: legacyDays });
      assert.deepEqual(r.json.days[0].userIds, replacement);
      await createTask('Two weekday people');
      await pushes('📋 New task assigned to you', replacement);
      const override = [people.mash.id, people.coord.id];
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { overrides: [{ date: sunday, userIds: [...override, override[0]], userNames: ['Forged'] }] });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.overrides[0].userIds, override);
      assert.deepEqual(r.json.overrides[0].userNames, [people.mash.name, people.coord.name]);
      r = await api('admin', 'PUT', `/api/shifts/${id}`, { overrides: [{ date: sunday, userId: override[0] }] });
      assert.deepEqual(r.json.overrides[0].userIds, override);
      await createTask('Two date people');
      await pushes('📋 New task assigned to you', override);
      await clear(); await clock('14:01');
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      await pushes('Overdue: Two date people', override);
      for (const invalid of [{ days: days.map((d, w) => w === 0 ? { ...d, userIds: [people.foreign.id] } : d) }, { overrides: [{ date: sunday, userIds: [people.foreign.id] }] }]) {
        assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, invalid)).status, 400);
      }
      await clock('12:00');
      assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { overrides: [{ date: sunday, userIds: [] }] })).status, 200);
      await createTask('Nobody on date');
      await pushes('📋 New task assigned to you', []);
      const legacyId = `${venueId}-legacy`;
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { shifts: [{ id: legacyId, agencyId, venueId, name: 'Legacy', area: '', daysOfWeek: [0], startMinutes: 480, endMinutes: 1080, userId: people.assign.id, overrides: [] }] })).status, 200);
      const loaded = await api('mash', 'GET', `/api/tasks?venueId=${venueId}`);
      const legacy = loaded.json.shifts.find((s) => s.id === legacyId);
      assert.deepEqual(legacy.userIds, [people.assign.id]);
      assert.equal(legacy.userId, people.assign.id);
      await clear();
      assert.equal((await api('admin', 'POST', '/api/tasks', { venueId, title: 'Legacy single person', shiftId: legacyId })).status, 201);
      await pushes('📋 New task assigned to you', [people.assign.id]);
      // This is the same explicit row-ID remap helper used by account merges.
      // Ordinary cross-agency merges keep membership IDs; actual removed rows use the map.
      const merged = rewriteEmailRefs({ shifts: [{ ...stored, userIds: usual, days: [{ on: true, userIds: usual }], overrides: [{ date: sunday, userIds: usual }] }] }, new Set([agencyId]), people.mash.email, people.assign.email, new Map([[usual[0], usual[1]]]));
      assert.equal(merged.ok, true);
      const mapped = merged.patch.shifts[0];
      for (const row of [mapped, mapped.days[0], mapped.overrides[0]]) assert.deepEqual(row.userIds, [usual[1]]);
      assert.equal(mapped.userId, usual[1]);
      assert.deepEqual(stored.userIds, usual, 'remapping must not mutate the loaded document');
      assert.ok((await ctx.getDoc()).tasks.some((t) => t.id === task.id));
      return 'two usual/weekday/date recipients, validation, trusted names, legacy reads/writes and ID-list merge remapping passed';
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
    }
  },
};
