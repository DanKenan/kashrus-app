import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';
export default {
  name: 'Test 111: shift occurrences cannot be overdue before task creation',
  whatItProves: 'A Night task created at 3 PM ignores the previous deadline, then alerts next morning; own times, dashboard and pushes agree, Afternoon and missing-createdAt tasks retain their rules, with zero database I/O.',
  async run(baseUrl, ctx) {
    const { api, venueId, agencyId, people } = await shiftFixture(baseUrl, ctx, '111');
    const shift = (name) => `builtin-${name}:${encodeURIComponent(venueId)}`;
    const task = (id, title, shiftId, extra = {}) => ({ id: `${venueId}-${id}`, title, venueId, agencyId, shiftId, assignedTo: ['all'], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], enableOverdueAlert: true, createdAt: '2026-11-03T20:00:00Z', ...extra });
    const night = task('night', 'Night created at 3 PM', shift('night'));
    const own = task('own', 'Own time created at 3 PM', shift('night'), { shiftTime: true, targetTime: '5:00 AM', targetTimeMinutes: 300 });
    const day = task('afternoon', 'Afternoon created at 3 PM', shift('afternoon'));
    const legacy = task('legacy', 'Legacy Night', shift('night'));
    delete legacy.createdAt;
    const endpoint = `https://push.example/nightfix-${people.mash.id}`;
    try {
      assert.equal((await api('admin', 'PUT', `/api/venues/${venueId}`, { timeZone: 'America/New_York', expectedVersion: await ctx.getVersion() })).status, 200);
      for (const id of [shift('night'), shift('afternoon')]) {
        assert.equal((await api('admin', 'PUT', `/api/shifts/${encodeURIComponent(id)}`, { userIds: [people.mash.id] })).status, 200);
      }
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { venueWorkDates: { [venueId]: '2099-12-31' }, tasks: [night, own, day, legacy] })).status, 200);
      assert.equal((await api('mash', 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
      const check = async (iso, expected, occurrence) => {
        assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso })).status, 200);
        await ctx.api('POST', '/api/__test__/push-log/clear', {});
        const writesBefore = (await ctx.api('POST', '/api/__test__/writes', {})).json.total;
        const readsBefore = (await ctx.api('POST', '/api/__test__/reads', {})).json.total;
        const overdue = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        assert.equal(overdue.status, 200);
        assert.deepEqual(overdue.json.notified.filter((key) => key.startsWith(venueId)).sort(), expected.map((t) => `${t.id}:${occurrence}`).sort());
        const dash = await api('admin', 'GET', '/api/admin/dashboard');
        assert.equal(dash.status, 200);
        assert.deepEqual(dash.json.venues.find((v) => v.venue.id === venueId).overdueTaskList.map((t) => t.id).sort(), expected.map((t) => t.id).sort());
        await new Promise((resolve) => setTimeout(resolve, 150));
        const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
        assert.deepEqual(log.filter((p) => p.endpoint === endpoint && p.title.startsWith('Overdue:')).map((p) => p.title).sort(), expected.map((t) => `Overdue: ${t.title}`).sort());
        assert.equal((await ctx.api('POST', '/api/__test__/writes', {})).json.total - writesBefore, 0);
        assert.equal((await ctx.api('POST', '/api/__test__/reads', {})).json.total - readsBefore, 0);
      };
      await check('2026-11-03T20:00:00Z', [legacy], '2026-11-02'); // 3 PM
      await check('2026-11-04T03:15:00Z', [day], '2026-11-03'); // 10:15 PM
      await check('2026-11-04T11:15:00Z', [night, own, legacy], '2026-11-03'); // 6:15 AM
      return 'new Night and own-time tasks exclude pre-creation deadlines; legacy, Afternoon, dashboard and push routing agree; 0 reads / 0 writes';
    } finally { await ctx.api('POST', '/api/__test__/clock', { iso: null }); }
  },
};
