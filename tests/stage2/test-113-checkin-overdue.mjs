import assert from 'node:assert/strict';
import { shiftFixture } from './test-101-shifts-crud.mjs';
export default {
  name: 'Test 112: checked check-in tasks leave dashboard overdue list without I/O',
  whatItProves: 'Dashboard and overdue push keys respect scheduled check-in intervals and overnight occurrences with zero database reads or writes.',
  async run(baseUrl, ctx) {
    const { api, venueId, agencyId } = await shiftFixture(baseUrl, ctx, '112');
    const task = { id: `${venueId}-check`, venueId, agencyId, title: 'Multiple check', inputType: 'check_in', targetTime: '6:30 AM', targetTimeMinutes: 390, targetTime2: '5:00 PM', targetTime2Minutes: 1020, daysOfWeek: [], enableOverdueAlert: true, isCompleted: false };
    let installed = false;
    const inject = async (t) => {
      // Fixture injection appends; remove the previous row before replacing it.
      if (installed) assert.equal((await api('admin', 'DELETE', `/api/tasks/${task.id}`, { expectedVersion: await ctx.getVersion() })).status, 200);
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { tasks: [t] })).status, 200);
      installed = true;
    };
    const check = async (iso, expected) => {
      assert.equal((await ctx.api('POST', '/api/__test__/clock', { iso })).status, 200);
      const meter = async (kind) => (await ctx.api('POST', `/api/__test__/${kind}`, {})).json.total;
      const reads = await meter('reads'), writes = await meter('writes');
      const dash = await api('admin', 'GET', '/api/admin/dashboard');
      assert.equal(dash.status, 200);
      assert.equal(dash.json.venues.find((v) => v.venue.id === venueId).overdueTaskList.some((t) => t.id === task.id), expected, `dashboard at ${iso}`);
      const push = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
      assert.equal(push.status, 200);
      assert.equal(push.json.notified.some((key) => key.startsWith(`${task.id}:`)), expected, `push at ${iso}`);
      assert.equal(await meter('reads') - reads, 0, 'no extra reads');
      assert.equal(await meter('writes') - writes, 0, 'no extra writes');
    };
    try {
      await inject(task);
      await check('2026-11-05T12:28:00Z', true);
      await inject({ ...task, checkIns: [{ at: '2026-11-04T07:00:00Z' }] });
      await check('2026-11-05T12:28:00Z', true);
      await inject({ ...task, checkIns: [{ at: '2026-11-05T06:00:00Z' }] });
      await check('2026-11-05T12:28:00Z', false);
      await check('2026-11-05T17:01:00Z', true);
      await inject({ ...task, checkIns: [{ at: '2026-11-05T07:00:00Z' }] });
      await check('2026-11-05T17:01:00Z', false);
      const night = { ...task, shiftId: `builtin-night:${encodeURIComponent(venueId)}`, checkIns: [{ at: '2026-11-05T23:00:00Z' }] };
      await inject(night);
      await check('2026-11-06T06:15:00Z', false);
      await inject({ ...night, checkIns: [{ at: '2026-11-05T21:00:00Z' }] });
      await check('2026-11-06T06:15:00Z', true);
      return 'checked tasks dropped; old checks excluded; second deadline and overnight start respected; 0 reads / 0 writes';
    } finally { await ctx.api('POST', '/api/__test__/clock', { iso: null }); }
  },
};
