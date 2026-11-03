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
    const body = { venueId, name: 'Deli day', area: 'Any area', daysOfWeek: [0, 2], startMinutes: 480, endMinutes: 1080, userId: people.mash.id, overrides: [{ date: '2000-01-01', userId: null }, { date: today, userId: people.assign.id, userName: 'Forged', email: people.assign.email }], userName: 'Untrusted' };
    let r = await api('admin', 'POST', '/api/shifts', body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.id;
    assert.equal(r.json.userName, people.mash.name);
    assert.deepEqual(r.json.overrides, [{ date: today, userIds: [people.assign.id], userNames: [people.assign.name], userId: people.assign.id, userName: people.assign.name }]);
    assert.equal(JSON.stringify(r.json.overrides).includes('@'), false);
    assert.deepEqual((await ctx.getDoc()).shifts.find((s) => s.id === id).overrides, [{ date: today, userIds: [people.assign.id], userId: people.assign.id }]);
    const nobody = await api('admin', 'PUT', `/api/shifts/${id}`, { overrides: [{ date: today, userId: null, userName: 'Forged' }] });
    assert.equal(nobody.status, 200);
    assert.deepEqual(nobody.json.overrides, [{ date: today, userIds: [], userNames: [], userId: null }]);
    assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { overrides: body.overrides })).status, 200);
    assert.deepEqual((await ctx.getDoc()).shifts.find((s) => s.id === id).overrides, [{ date: today, userIds: [people.assign.id], userId: people.assign.id }]);
    assert.equal('email' in r.json, false);
    assert.equal('daysOfWeek' in r.json, false);
    assert.deepEqual(r.json.days, Array.from({ length: 7 }, (_, w) => ({ on: [0, 2].includes(w) })));
    const days = Array.from({ length: 7 }, (_, w) => ({ on: w === 0 }));
    for (const badDay of [{ on: 'yes' }, { on: true, userId: 'missing' }, { on: true, userId: people.foreign.id }, { on: true, userId: people.elsewhere.id }, { on: true, startMinutes: 600 }, { on: true, startMinutes: 600, endMinutes: 600 }, { on: true, startMinutes: -1, endMinutes: 600 }, { on: true, startMinutes: 600, endMinutes: 1440 }]) {
      const invalid = { days: [badDay, ...days.slice(1)] };
      assert.equal((await api('admin', 'POST', '/api/shifts', { ...body, ...invalid })).status, 400);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, invalid)).status, 400);
    }
    for (const invalid of [[], days.slice(1), [...days, { on: false }], Array.from({ length: 7 }, () => ({ on: false })), [null, ...days.slice(1)]]) {
      assert.equal((await api('admin', 'POST', '/api/shifts', { ...body, days: invalid })).status, 400);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { days: invalid })).status, 400);
    }
    for (const w of [0, 6]) {
      const overlapDays = Array.from({ length: 7 }, (_, i) => ({ on: i === w || i === (w + 1) % 7,
        ...(i === w ? { startMinutes: 1320, endMinutes: 120 } : { startMinutes: 30, endMinutes: 240 }) }));
      const error = `Two days of this shift overlap: ${w === 0 ? 'Sun' : 'Sat'} ends after ${w === 0 ? 'Mon' : 'Sun'} starts.`;
      const beforeOverlap = (await ctx.getDoc()).shifts;
      for (const [method, path, payload] of [['POST', '/api/shifts', { ...body, days: overlapDays }], ['PUT', `/api/shifts/${id}`, { days: overlapDays }]]) {
        const denied = await api('admin', method, path, payload);
        assert.equal(denied.status, 400);
        assert.equal(denied.json.error, error);
      }
      assert.deepEqual((await ctx.getDoc()).shifts, beforeOverlap);
      overlapDays[(w + 1) % 7].startMinutes = 120;
      const touching = await api('admin', 'POST', '/api/shifts', { ...body, days: overlapDays });
      assert.equal(touching.status, 201, JSON.stringify(touching.json));
      assert.equal((await api('admin', 'PUT', `/api/shifts/${touching.json.id}`, { days: overlapDays })).status, 200);
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${touching.json.id}`)).status, 200);
    }
    const { startMinutes: _start, endMinutes: _end, ...withoutGeneral } = body;
    assert.equal((await api('admin', 'POST', '/api/shifts', { ...withoutGeneral, days })).status, 400);
    const ownDays = days.map((d, w) => w === 0 ? { ...d, userId: people.assign.id, startMinutes: 600, endMinutes: 900 } : d);
    const varied = await api('admin', 'POST', '/api/shifts', { ...body, days: ownDays, overrides: [], dayUserNames: ['Untrusted'] });
    assert.equal(varied.status, 201, JSON.stringify(varied.json));
    assert.equal(varied.json.dayUserNames.length, 7);
    assert.equal(varied.json.dayUserNames[0], people.assign.name);
    assert.equal(varied.json.dayUserNames[1], null);
    assert.deepEqual(varied.json.days, ownDays.map((d) => d.userId ? { ...d, userIds: [d.userId], userNames: [people.assign.name] } : d));
    assert.equal(JSON.stringify(varied.json).includes('@'), false);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${varied.json.id}`)).status, 200);
    const loaded = await api('mash', 'GET', `/api/tasks?venueId=${venueId}`);
    assert.equal(loaded.status, 200);
    const savedShifts = loaded.json.shifts.filter((s) => !s.id.startsWith('builtin-'));
    assert.deepEqual(savedShifts.map((s) => s.id), [id]);
    assert.deepEqual(savedShifts[0].overrides, [{ date: today, userIds: [people.assign.id], userNames: [people.assign.name], userId: people.assign.id, userName: people.assign.name }]);
    assert.deepEqual(loaded.json.shifts.filter((s) => s.id.startsWith('builtin-')).map((s) => s.id).sort(), ['builtin-afternoon', 'builtin-morning', 'builtin-night']);
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
    assert.equal((await api('admin', 'PUT', `/api/shifts/${id}`, { days: Array.from({ length: 7 }, (_, w) => ({ on: [1, 3].includes(w), ...(w === 1 ? { userId: people.assign.id, startMinutes: 600, endMinutes: 660 } : {}) })) })).status, 200);
    r = await api('admin', 'DELETE', `/api/shifts/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const doc = await ctx.getDoc();
    assert.equal(doc.shifts.some((s) => s.id === id), false);
    const detached = doc.tasks.find((t) => t.id === taskId);
    assert.equal(detached.shiftId, null);
    assert.deepEqual(detached.daysOfWeek, [1]);
    assert.equal(detached.targetTime, '10:00 AM');
    assert.equal(detached.targetTime2, '11:00 AM');
    assert.equal(detached.targetTimeMinutes, 600);
    assert.equal(detached.targetTime2Minutes, 660);
    const otherDay = doc.tasks.find((t) => t.title === detached.title && t.venueId === venueId && t.id !== detached.id);
    assert.deepEqual(otherDay.daysOfWeek, [3]);
    assert.equal(otherDay.targetTimeMinutes, 540);
    assert.equal(otherDay.targetTime2Minutes, 1200);
    const splitShift = await api('admin', 'POST', '/api/shifts', { ...body, overrides: [], days: Array.from({ length: 7 }, (_, w) => ({ on: w < 3, ...(w === 0 ? { startMinutes: 420, endMinutes: 780 } : w === 1 ? { startMinutes: 600, endMinutes: 1020 } : {}) })) });
    assert.equal(splitShift.status, 201);
    const answered = { ...detached, id: `split-${venueId}`, title: 'Split weekday schedule', shiftId: splitShift.json.id, daysOfWeek: [0, 1, 2], isCompleted: true, currentStatus: 'completed', notes: 'Original answer', checkIns: [{ id: 'visit', at: new Date().toISOString(), byName: 'Original', byEmail: null }], answerPhoto: { id: 'original-photo', at: new Date().toISOString(), byName: 'Original', byEmail: null } };
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { tasks: [answered] })).status, 200);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${splitShift.json.id}`)).status, 200);
    let split = (await ctx.getDoc()).tasks.filter((t) => t.title === answered.title);
    assert.equal(split.length, 3);
    const expectedWindows = [[0, 420, 780], [1, 600, 1020], [2, 480, 1080]];
    for (const [weekday, start, end] of expectedWindows) {
      const t = split.find((t) => t.daysOfWeek.includes(weekday));
      assert.deepEqual(t.daysOfWeek, [weekday]);
      assert.equal(t.shiftId, null);
      assert.equal(t.targetTimeMinutes, start);
      assert.equal(t.targetTime2Minutes, end);
      if (weekday === 0) {
        assert.equal(t.id, answered.id, 'earliest weekday wins equal-size groups');
        assert.equal(t.isCompleted, true);
        assert.equal(t.checkIns.length, 1);
      } else {
        assert.notEqual(t.id, answered.id);
        assert.equal(t.isCompleted, false);
        assert.equal(t.currentStatus, 'pending');
        assert.equal(t.notes, '');
        assert.deepEqual(t.checkIns, []);
        assert.equal(t.answerPhoto, undefined);
        assert.equal(t.updatedAt, null);
      }
    }
    // The original id stays with the largest group, even if it starts later.
    const groupedShift = await api('admin', 'POST', '/api/shifts', { ...body, overrides: [], days: Array.from({ length: 7 }, (_, w) => ({ on: w < 3, ...(w === 0 ? { startMinutes: 420, endMinutes: 780 } : {}) })) });
    const groupedTask = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Largest weekday group', shiftId: groupedShift.json.id });
    assert.equal(groupedTask.status, 201);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${groupedShift.json.id}`)).status, 200);
    split = (await ctx.getDoc()).tasks.filter((t) => t.title === 'Largest weekday group');
    assert.equal(split.length, 2);
    assert.deepEqual(split.find((t) => t.id === groupedTask.json.id).daysOfWeek, [1, 2]);
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
      assert.deepEqual(updates[0].payload.shifts[0].overrides, [{ date: today, userIds: [people.assign.id], userNames: [people.assign.name], userId: people.assign.id, userName: people.assign.name }]);
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
    const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { days: Array.from({ length: 7 }, (_, w) => ({ on: true, ...(w === todayWeekday ? { userId: people.assign.id } : {}) })) });
    await pushTask(['assign']);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [{ date: today, userId: people.assign.id }] });
    await pushTask(['assign']);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [{ date: today, userId: null }] });
    await pushTask([]);
    await api('admin', 'PUT', `/api/shifts/${pushShift.json.id}`, { overrides: [], daysOfWeek: [(new Date(`${today}T12:00:00Z`).getUTCDay() + 1) % 7] });
    await pushTask([]);
    assert.equal((await api('admin', 'DELETE', `/api/shifts/${pushShift.json.id}`)).status, 200);
    const datePlus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const clock = (ymd) => ctx.api('POST', '/api/__test__/clock', { iso: ymd ? `${ymd}T12:00:00Z` : null });
    try {
      await clock(today);
      const expiryMessages = await connect(tokens.admin);
      const onceBody = { venueId, name: 'One time', area: '', oneTimeDate: today, startMinutes: 480, endMinutes: 600, userId: people.mash.id };
      for (const oneTimeDate of [datePlus(-1), datePlus(61), '2026-02-30', 'bad']) {
        assert.equal((await api('admin', 'POST', '/api/shifts', { ...onceBody, oneTimeDate })).status, 400);
      }
      const saved = await api('admin', 'POST', '/api/shifts', { ...body, overrides: [] });
      assert.equal(saved.status, 201);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${saved.json.id}`, { oneTimeDate: today })).status, 400);
      const ignoredDays = await api('admin', 'POST', '/api/shifts', { ...onceBody, days: [], daysOfWeek: [] });
      assert.equal(ignoredDays.status, 201);
      assert.deepEqual(ignoredDays.json.days, Array.from({ length: 7 }, () => ({ on: false })));
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${ignoredDays.json.id}`)).status, 200);
      const once = await api('admin', 'POST', '/api/shifts', onceBody);
      assert.equal(once.status, 201, JSON.stringify(once.json));
      assert.equal((await api('admin', 'PUT', `/api/shifts/${once.json.id}`, { oneTimeDate: null })).status, 400);
      const createOnceTask = async (shiftId) => {
        const t = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Dated shift task', shiftId });
        assert.equal(t.status, 201, JSON.stringify(t.json));
        assert.equal(t.json.scheduleType, 'specific_dates');
        assert.deepEqual(t.json.specificDates, [today]);
        assert.deepEqual(t.json.assignedTo, ['all']);
        assert.equal(t.json.targetTimeMinutes, 480);
        assert.equal(t.json.targetTime2Minutes, 600);
        return t.json;
      };
      const onceTask = await createOnceTask(once.json.id);
      const rebound = await api('admin', 'PUT', `/api/tasks/${onceTask.id}`, { scheduleType: 'recurring', expectedVersion: await ctx.getVersion() });
      assert.equal(rebound.status, 200);
      assert.equal(rebound.json.scheduleType, 'specific_dates');
      const moved = await api('admin', 'POST', '/api/shifts', { ...onceBody, oneTimeDate: datePlus(5) });
      assert.equal(moved.status, 201);
      const movedTask = await api('admin', 'POST', '/api/tasks', { venueId, title: 'Moved dated shift', shiftId: moved.json.id });
      assert.equal(movedTask.status, 201);
      assert.equal((await api('admin', 'PUT', `/api/shifts/${moved.json.id}`, { oneTimeDate: today })).status, 200);
      const toDelete = await api('admin', 'POST', '/api/shifts', onceBody);
      const deletedTask = await createOnceTask(toDelete.json.id);
      assert.equal((await api('admin', 'DELETE', `/api/shifts/${toDelete.json.id}`)).status, 200);
      let stored = (await ctx.getDoc()).tasks.find((t) => t.id === deletedTask.id);
      assert.equal(stored.shiftId, null);
      assert.deepEqual(stored.specificDates, [today]);
      assert.equal(stored.scheduleType, 'specific_dates');
      assert.equal(stored.targetTime2Minutes, 600);
      // Keep yesterday for overnight work; prune before-yesterday on a write.
      await clock(datePlus(1));
      assert.equal((await api('admin', 'PUT', `/api/shifts/${saved.json.id}`, { area: 'Yesterday retained' })).status, 200);
      assert.ok((await ctx.getDoc()).shifts.some((s) => s.id === once.json.id));
      await clock(datePlus(2));
      assert.equal((await api('admin', 'PUT', `/api/shifts/${saved.json.id}`, { area: 'Prune now' })).status, 200);
      let after = await ctx.getDoc();
      assert.equal(after.shifts.some((s) => s.id === once.json.id), false);
      stored = after.tasks.find((t) => t.id === onceTask.id);
      assert.equal(stored.shiftId, null);
      assert.equal(stored.scheduleType, 'specific_dates');
      assert.deepEqual(stored.specificDates, [today]);
      assert.equal(stored.targetTime2Minutes, 600);
      assert.deepEqual(after.tasks.find((t) => t.id === movedTask.json.id).specificDates, [today], 'pruning a rescheduled shift cannot resurrect its original future date');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const expiryEvent = expiryMessages.find((m) => m.type === 'TASK_UPDATED' && (m.payload.task || m.payload).id === movedTask.json.id);
      assert.ok(expiryEvent, 'the pruning caller also receives the dated task update');
      assert.equal(expiryEvent.senderEmail, undefined);
      assert.deepEqual((expiryEvent.payload.task || expiryEvent.payload).specificDates, [today]);
      const rolloverShift = await api('admin', 'POST', '/api/shifts', { ...onceBody, oneTimeDate: datePlus(2) });
      assert.equal(rolloverShift.status, 201);
      // An upcoming cap cannot be bypassed by creating many dated records.
      const fixture = Array.from({ length: 60 }, (_, i) => ({ ...onceBody, venueId: venue2, userId: null, id: `${venueId}-cap-${i}`, oneTimeDate: datePlus(3), days: Array.from({ length: 7 }, () => ({ on: false })), agencyId: people.admin.agencyId }));
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { shifts: fixture, venueWorkDates: { [venueId]: datePlus(2) } })).status, 200);
      assert.equal((await api('admin', 'POST', '/api/shifts', { ...onceBody, venueId: venue2, userId: null, oneTimeDate: datePlus(3) })).status, 400);
      await clock(datePlus(4));
      assert.equal((await ctx.api('POST', '/api/__test__/rollover-tick', {})).status, 200);
      after = await ctx.getDoc();
      assert.equal(after.shifts.some((s) => s.id === rolloverShift.json.id), false);
    } finally { for (const ws of connections) ws.close(); await clock(null); }
    // 34 attached tasks with seven hour groups would create 204 new copies.
    const boundedShift = await api('admin', 'POST', '/api/shifts', { ...body, overrides: [], days: Array.from({ length: 7 }, (_, w) => ({ on: true, startMinutes: 480 + w, endMinutes: 1080 })) });
    assert.equal(boundedShift.status, 201);
    const attachedBatch = Array.from({ length: 34 }, (_, i) => ({ id: `${venueId}-bounded-${i}`, agencyId: people.admin.agencyId, venueId, title: 'Bounded split', shiftId: boundedShift.json.id, assignedTo: ['all'], scheduleType: 'recurring' }));
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { tasks: attachedBatch })).status, 200);
    const beforeBound = await ctx.getDoc();
    const bounded = await api('admin', 'DELETE', `/api/shifts/${boundedShift.json.id}`);
    assert.equal(bounded.status, 409);
    assert.deepEqual(bounded.json, { code: 'SHIFT_SPLIT_TOO_LARGE', error: 'This shift has too many tasks with different hours per day. Move some tasks to another shift first.' });
    const afterBound = await ctx.getDoc();
    assert.deepEqual(afterBound.shifts, beforeBound.shifts);
    assert.deepEqual(afterBound.tasks, beforeBound.tasks);
    return 'CRUD, permission/validation denials, safe cached payloads, task binding, atomic detach, scoped websocket updates and identity-bound shift pushes passed';
  },
};
