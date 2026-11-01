import assert from 'node:assert/strict';

// Reused by test 102: isolated agency and identity-bound callers, no real data.
export async function shiftFixture(baseUrl, ctx, suffix) {
  const prefix = `shifts-${suffix}-${Date.now()}`;
  const agencyId = `${prefix}-agency`, venueId = `${prefix}-venue`, venue2 = `${prefix}-venue2`;
  const people = [
    ['admin', 'admin'], ['coord', 'coordinator'], ['coordOff', 'coordinator', false],
    ['mash', 'mashgiach'], ['assign', 'mashgiach', true], ['elsewhere', 'mashgiach'], ['foreign', 'admin'],
  ].map(([key, role, canAssignTasks]) => ({
    key, id: `${prefix}-${key}`, email: `${prefix}-${key}@test.local`, name: `Shift ${key}`, role,
    agencyId: key === 'foreign' ? `${agencyId}-other` : agencyId,
    venueId: key === 'elsewhere' ? venue2 : venueId,
    ...(canAssignTasks !== undefined ? { permissions: { canAssignTasks } } : {}),
  }));
  const injected = await ctx.api('POST', '/api/__test__/inject-fixture', {
    agencies: [{ id: agencyId, name: prefix }, { id: `${agencyId}-other`, name: 'Other shift agency' }],
    venues: [{ id: venueId, agencyId, name: prefix, timeZone: 'UTC' }, { id: venue2, agencyId, name: 'Second', timeZone: 'UTC' }],
    users: people.map(({ key, ...u }) => u),
    venueWorkDates: { [venueId]: '2099-12-31', [venue2]: '2099-12-31' },
  });
  assert.equal(injected.status, 200, JSON.stringify(injected.json));
  const tokens = {};
  for (const u of people) {
    const r = await ctx.api('POST', '/api/__test__/mint-token', { userId: u.id });
    assert.equal(r.status, 200);
    tokens[u.key] = r.json.token;
  }
  const api = async (who, method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return { agencyId, venueId, venue2, tokens, people: Object.fromEntries(people.map((u) => [u.key, u])), api };
}

export default {
  name: 'Test 101: shifts CRUD, scope, validation and task binding',
  whatItProves: 'Task creators alone manage venue shifts; tenant/scope checks fail closed; dates and people are validated; existing task reads carry safe shifts; deleting a shift detaches tasks with its live hours and days.',
  async run(baseUrl, ctx) {
    const { api, venueId, venue2, tokens, people } = await shiftFixture(baseUrl, ctx, '101');
    const today = new Date().toISOString().slice(0, 10);
    const body = { venueId, name: 'Deli day', area: 'Any area', daysOfWeek: [0, 2], startMinutes: 480, endMinutes: 1080, userId: people.mash.id, overrides: [{ date: '2000-01-01', userId: null }, { date: today, userId: people.assign.id }], userName: 'Untrusted' };
    let r = await api('admin', 'POST', '/api/shifts', body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.id;
    assert.equal(r.json.userName, people.mash.name);
    assert.deepEqual(r.json.overrides, [{ date: today, userId: people.assign.id }]);
    assert.equal('email' in r.json, false);
    const loaded = await api('mash', 'GET', `/api/tasks?venueId=${venueId}`);
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.json.shifts.map((s) => s.id), [id]);
    assert.equal(JSON.stringify(loaded.json.shifts).includes('@'), false);
    assert.equal((await api('foreign', 'GET', `/api/tasks?venueId=${venueId}`)).status, 403);
    for (const who of ['mash', 'foreign', 'elsewhere']) {
      assert.equal((await api(who, 'POST', '/api/shifts', body)).status, 403, `${who} create`);
      assert.equal((await api(who, 'PUT', `/api/shifts/${id}`, { name: 'Forbidden' })).status, 403, `${who} edit`);
      assert.equal((await api(who, 'DELETE', `/api/shifts/${id}`)).status, 403, `${who} delete`);
    }
    assert.equal((await api('admin', 'PUT', '/api/shifts/missing', {})).status, 404);
    assert.equal((await api('admin', 'DELETE', '/api/shifts/missing')).status, 404);
    for (const who of ['coord', 'coordOff', 'assign']) {
      r = await api(who, 'POST', '/api/shifts', { ...body, name: who });
      assert.equal(r.status, 201, `${who} create ${JSON.stringify(r.json)}`);
      assert.equal((await api(who, 'PUT', `/api/shifts/${r.json.id}`, { area: 'Kitchen' })).status, 200);
      assert.equal((await api(who, 'DELETE', `/api/shifts/${r.json.id}`)).status, 200);
    }
    const many = Array.from({ length: 61 }, (_, i) => ({ date: new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10), userId: null }));
    for (const invalid of [
      { name: '' }, { name: '<b>Hi</b>' }, { name: 'x'.repeat(41) }, { area: 'x'.repeat(41) },
      { daysOfWeek: [] }, { daysOfWeek: [0, 0] }, { daysOfWeek: [7] }, { daysOfWeek: [0.5] },
      { endMinutes: 480 }, { startMinutes: -1 }, { endMinutes: 1440 }, { startMinutes: 2.5 },
      { overrides: many }, { userId: 'missing' }, { userId: people.foreign.id }, { userId: people.elsewhere.id },
      { overrides: [{ date: today, userId: 'missing' }] },
      { overrides: [{ date: '2026-02-30', userId: null }] },
      { overrides: [{ date: today, userId: null }, { date: today, userId: null }] },
    ]) {
      for (const [method, path, input] of [['POST', '/api/shifts', { ...body, ...invalid }], ['PUT', `/api/shifts/${id}`, invalid]]) {
        const bad = await api('admin', method, path, input);
        assert.equal(bad.status, 400, `${method} ${JSON.stringify(invalid)}: ${JSON.stringify(bad)}`);
        assert.equal(typeof bad.json.error, 'string');
      }
    }
    assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { venueId: venue2 })).status, 400);
    const capped = await api('admin', 'POST', '/api/shifts', { ...body, overrides: many.slice(0, 60) });
    assert.equal(capped.status, 201);
    assert.equal(capped.json.overrides.length, 60);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${capped.json.id}`)).status, 200);
    r = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Shift task', shiftId: id, assignedTo: [people.admin.email], scheduleType: 'specific_dates', specificDates: [today], enableOverdueAlert: true });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const taskId = r.json.id;
    assert.deepEqual(r.json.assignedTo, ['all']);
    assert.equal(r.json.scheduleType, 'recurring');
    assert.deepEqual(r.json.specificDates, []);
    assert.equal((await api('mash', 'PUT', `/api/tasks/${taskId}`, { shiftId: null })).status, 403);
    for (const shiftId of [id, 'missing', 42]) {
      assert.equal((await api('admin', 'POST', '/api/tasks', { venueId: venue2, title: 'Bad shift', shiftId })).status, 400);
    }
    const normal = await api('admin', 'POST', '/api/tasks', { venueId: venue2, title: 'Normal task' });
    assert.equal(normal.status, 201);
    assert.equal((await api('admin', 'PUT', `/api/tasks/${normal.json.id}`, { shiftId: id, expectedVersion: await ctx.getVersion() })).status, 400);
    r = await api('admin', 'PUT', `/api/tasks/${taskId}`, { shiftId: null, expectedVersion: await ctx.getVersion() });
    assert.equal(r.status, 200);
    assert.equal(r.json.shiftId, null);
    // Task edits cannot override the shift's assignment or schedule.
    r = await api('assign', 'PUT', `/api/tasks/${taskId}`, { shiftId: id, assignedTo: [people.assign.email], scheduleType: 'specific_dates', expectedVersion: await ctx.getVersion() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.assignedTo, ['all']);
    assert.equal(r.json.scheduleType, 'recurring');
    r = await api('admin', 'PUT', `/api/shifts/${id}`, { startMinutes: 540, endMinutes: 1200, daysOfWeek: [1, 3], overrides: [{ date: '2000-01-01', userId: null }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.overrides, []);
    const live = (await api('mash', 'GET', `/api/tasks?venueId=${venueId}`)).json.tasks.find((t) => t.id === taskId);
    assert.deepEqual(live.daysOfWeek, [1, 3]);
    assert.equal(live.targetTimeMinutes, 540);
    assert.equal(live.targetTime2Minutes, 1200);
    r = await api('admin', 'DELETE', `/api/shifts/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const doc = await ctx.getDoc();
    assert.equal(doc.shifts.some((s) => s.id === id), false);
    const detached = doc.tasks.find((t) => t.id === taskId);
    assert.equal(detached.shiftId, null);
    assert.deepEqual(detached.daysOfWeek, [1, 3]);
    assert.equal(detached.targetTime, '9:00 AM');
    assert.equal(detached.targetTime2, '8:00 PM');
    assert.equal(detached.targetTimeMinutes, 540);
    assert.equal(detached.targetTime2Minutes, 1200);
    // Existing websocket channels must deliver shift changes to this venue
    // and drop them for another venue and another agency.
    const connections = [];
    const connect = (token) => new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const messages = [];
      connections.push(ws);
      const timer = setTimeout(() => { ws.close(); reject(new Error('shift websocket timeout')); }, 10000);
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        if (message.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(messages); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('shift websocket failed')); };
    });
    try {
      const [mine, elsewhere, foreign] = await Promise.all(['mash', 'elsewhere', 'foreign'].map((who) => connect(tokens[who])));
      const made = await api('admin', 'POST', '/api/shifts', { ...body, name: 'Live shift' });
      assert.equal(made.status, 201);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${made.json.id}`, { area: 'Live edit' })).status, 200);
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${made.json.id}`)).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const updates = mine.filter((m) => m.type === 'SHIFTS_UPDATED');
      assert.equal(updates.length, 3, 'venue receives create/edit/delete');
      assert.equal(updates[0].payload.venueId, venueId);
      assert.equal(updates[0].payload.shifts[0].userName, people.mash.name);
      assert.equal(updates[1].payload.shifts[0].area, 'Live edit');
      assert.deepEqual(updates[2].payload.shifts, []);
      assert.equal(JSON.stringify(updates).includes('@'), false);
      for (const messages of [elsewhere, foreign]) assert.equal(messages.some((m) => m.type === 'SHIFTS_UPDATED'), false);
    } finally { for (const ws of connections) ws.close(); }
    // A shift task pushes only today's identity-resolved person, including
    // replacements and nobody; it never fans out to the 'all' team.
    const endpoints = {};
    for (const who of ['mash', 'assign']) {
      endpoints[who] = `https://push.example/${people[who].id}`;
      assert.equal((await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint: endpoints[who], keys: { p256dh: 'p', auth: 'a' } }, mode: 'tagged' })).status, 200);
    }
    const pushShift = await api('admin', 'POST', '/api/shifts', { ...body, name: 'Push shift', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], overrides: [] });
    assert.equal(pushShift.status, 201);
    const pushTask = async (expected) => {
      await ctx.api('POST', '/api/__test__/push-log/clear', {});
      const created = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Shift push', shiftId: pushShift.json.id });
      assert.equal(created.status, 201);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const log = (await ctx.api('GET', '/api/__test__/push-log')).json.log;
      assert.deepEqual(log.filter((e) => e.title === '📋 New task assigned to you').map((e) => e.endpoint).sort(), expected.map((who) => endpoints[who]).sort());
    };
    await pushTask(['mash']);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [{ date: today, userId: people.assign.id }] });
    await pushTask(['assign']);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [{ date: today, userId: null }] });
    await pushTask([]);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [], daysOfWeek: [(new Date(`${today}T12:00:00Z`).getUTCDay() + 1) % 7] });
    await pushTask([]);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${pushShift.json.id}`)).status, 200);
    return 'CRUD, permission/validation denials, safe cached payloads, task binding, atomic detach, scoped websocket updates and identity-bound shift pushes passed';
  },
};
