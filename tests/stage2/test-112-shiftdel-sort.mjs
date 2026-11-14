import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { shiftFixture } from './test-101-shifts-crud.mjs';

const { venueShifts, normalizeShifts, resolveTaskShift } = await tsImport('../../src/lib/shifts.ts', import.meta.url);
export default {
  name: 'Test 112: built-in deletion survives client resolution without extra I/O',
  whatItProves: 'One transaction read and one write delete an unused built-in; cached GET and broadcasts carry safe deletion markers, including after restart and when every default is deleted; remaining shifts still accept tasks.',
  async run(baseUrl, ctx) {
    const { api, agencyId, venueId, venue2, tokens } = await shiftFixture(baseUrl, ctx, '112');
    const builtin = (key, venue = venueId) => `builtin-${key}:${encodeURIComponent(venue)}`;
    const read = async () => {
      const r = await api('admin', 'GET', `/api/tasks?venueId=${venueId}`);
      assert.equal(r.status, 200); return r.json.shifts;
    };
    const counts = async () => ({
      writes: (await ctx.api('POST', '/api/__test__/writes', {})).json.total,
      reads: (await ctx.api('POST', '/api/__test__/reads', {})).json.total,
    });
    const costs = {};
    const measure = async (label, reads, writes, action) => {
      const before = await counts(), result = await action(), after = await counts();
      costs[label] = { reads: after.reads - before.reads, writes: after.writes - before.writes };
      assert.deepEqual(costs[label], { reads, writes }, label); return result;
    };
    let ws;
    const messages = [];
    try {
      await measure('initial cached GET', 0, 0, read);
      await new Promise((resolve, reject) => {
        ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${tokens.mash}`);
        const timer = setTimeout(() => reject(new Error('shift socket timeout')), 10000);
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)); messages.push(message);
          if (message.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(); }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('shift socket failed')); };
      });
      await measure('delete built-in (zero extra reads)', 1, 2, async () => {
        const r = await api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin('morning'))}`);
        assert.equal(r.status, 200, JSON.stringify(r.json));
      });
      const wire = await measure('GET after delete', 0, 0, read);
      const check = (records) => {
        const live = venueShifts(records, venueId, agencyId);
        assert.deepEqual(live.map((s) => s.id), [builtin('afternoon'), builtin('night')]);
        assert.equal(resolveTaskShift({ shiftId: builtin('morning'), venueId, agencyId }, records), undefined);
        // Older clients may normalize before resolving; every wire record must
        // be a complete Shift, even though deletion markers are never shown.
        assert.equal(normalizeShifts(records).length, records.length);
        assert.deepEqual(venueShifts(normalizeShifts(records), venueId, agencyId), normalizeShifts(live));
        return live;
      };
      const remaining = check(wire);
      await new Promise((r) => setTimeout(r, 100));
      check(messages.findLast((m) => m.type === 'SHIFTS_UPDATED').payload.shifts);
      assert.equal(venueShifts(wire, venue2, agencyId).length, 3, 'deletion is venue-scoped');
      assert.equal(venueShifts(wire, venueId, 'another-agency').length, 3, 'deletion is agency-scoped');
      const stored = (await ctx.getDoc()).shifts.find((s) => s.id === builtin('morning'));
      assert.deepEqual(stored, { id: builtin('morning'), venueId, agencyId, deleted: true }, 'wire padding is never persisted');
      for (const shift of remaining) {
        const saved = await api('admin', 'POST', '/api/tasks', { venueId, title: `Remaining ${shift.name}`, shiftId: shift.id, assignedTo: ['all'] });
        assert.equal(saved.status, 201, JSON.stringify(saved.json));
        assert.equal(saved.json.shiftId, shift.id);
      }
      const refused = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Deleted shift', shiftId: builtin('morning') });
      assert.equal(refused.status, 400);
      ws.close(); ws = undefined;
      if (ctx.restartServer) await ctx.restartServer();
      check(await measure('GET after restart', 0, 0, read));
      // No live shift is needed to carry the tombstones.
      for (const key of ['morning', 'afternoon', 'night']) {
        const r = await measure(`delete empty venue ${key}`, 1, 2, () => api('admin', 'DELETE', `/api/shifts/${encodeURIComponent(builtin(key, venue2))}`));
        assert.equal(r.status, 200);
      }
      const empty = await api('admin', 'GET', `/api/tasks?venueId=${venue2}`);
      assert.deepEqual(venueShifts(empty.json.shifts, venue2, agencyId), []);
      return JSON.stringify(costs);
    } finally { ws?.close(); }
  },
};
