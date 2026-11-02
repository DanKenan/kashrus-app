import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export default {
  name: 'Test 108: unchanged shift saves do not write or broadcast',
  whatItProves: 'Normalized no-op PUTs cost 0 metered writes and preserve the whole document and version, even with operation IDs, legacy fields or pending expiry; real edits still commit and broadcast.',
  async run(baseUrl, ctx) {
    const { api, venueId, agencyId, people, tokens } = await shiftFixture(baseUrl, ctx, '108');
    let ws;
    try {
      await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-08T12:00:00Z' });
      const made = await api('admin', 'POST', '/api/shifts', { venueId, name: 'Deli day', startMinutes: 480, endMinutes: 1080, daysOfWeek: [0], userIds: [people.mash.id, people.assign.id] });
      assert.equal(made.status, 201);
      const messages = [];
      await new Promise((resolve, reject) => {
        ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${tokens.admin}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error('websocket timeout')); }, 10000);
        ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); messages.push(m); if (m.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(); } };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket failed')); };
      });
      // An unchanged save must not opportunistically prune unrelated expired shifts.
      const expired = { ...made.json, id: `${venueId}-expired`, oneTimeDate: '2026-11-01' };
      const legacy = { ...made.json, id: `${venueId}-legacy`, userId: people.mash.id };
      delete legacy.userIds;
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { shifts: [expired, legacy] })).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      messages.length = 0;
      const before = await ctx.getDoc(), version = await ctx.getVersion();
      // WRITECUT meter: a no-op shift save must cost 0 billed database writes (sets and deletes).
      const writes = async () => { const w = (await ctx.api('POST', '/api/__test__/writes', {})).json; return w.total + (w.deletes || 0); };
      const writesBefore = await writes();
      for (const [id, body] of [[made.json.id, {}], [made.json.id, { ...made.json, name: ' Deli day ', userNames: ['Forged'] }], [legacy.id, { userIds: [people.mash.id] }]]) {
        const r = await api('admin', 'PUT', `/api/shifts/${id}`, { ...body, operationId: randomUUID(), expectedVersion: version });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(await ctx.getVersion(), version, 'no Firestore commit/version bump');
        assert.deepEqual(await ctx.getDoc(), before, 'no timestamp, idempotency, history, expiry or entity changes');
        assert.equal(await writes(), writesBefore, 'no-op shift save writes nothing (write meter)');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(messages.filter((m) => m.type === 'SHIFTS_UPDATED').length, 0);
      const edit = await api('admin', 'PUT', `/api/shifts/${made.json.id}`, { area: 'Changed', operationId: randomUUID(), expectedVersion: version });
      assert.equal(edit.status, 200);
      assert.equal(await ctx.getVersion(), version + 1);
      assert.ok(await writes() > writesBefore, 'a real shift edit is metered as at least one write');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(messages.filter((m) => m.type === 'SHIFTS_UPDATED').length, 1);
      assert.equal((await ctx.getDoc()).shifts.find((s) => s.id === made.json.id).area, 'Changed');
      return 'no-op versions, unchanged document, legacy normalization and broadcast suppression passed';
    } finally {
      ws?.close();
      await ctx.api('POST', '/api/__test__/clock', { iso: null });
    }
  },
};
