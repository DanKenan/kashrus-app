import { futureWeekday } from './future-dates.mjs';
/**
 * Test 100 (TODAYSORT, Don Nov 1 2026): a task only counts as overdue on the days it is scheduled for.
 *
 * "If something is not assigned for this day, meaning it is for Friday and today is Sunday, the
 * mashgichim shouldn't see it" — so its overdue push must not fire either, and the admin dashboard
 * must not list it as overdue. Proves, with the test-only fake clock, at 23:30 venue time:
 *  - Sunday: a Sunday-only task, an every-day task (empty days = every day) and a task dated today
 *    alert and are on the dashboard's overdue list; a Friday-only task and a task dated next Friday
 *    do neither.
 *  - Friday: the Friday-only task and the task dated that Friday alert; the Sunday-only task does not.
 */
const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

async function freshAdminCtx(baseUrl, ctx) {
  let headers = ctx.authHeaders;
  try {
    const r = await fetch(`${baseUrl}/api/__test__/mint-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_admin' }),
    });
    if (r.status === 200) {
      const j = await r.json();
      if (j.token) headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${j.token}` };
    }
  } catch {}
  const api = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const getDoc = async () => (await api('GET', '/api/__test__/firestore-doc')).json.doc;
  const getVersion = async () => (await api('GET', '/api/__test__/firestore-doc')).json.version;
  return { ...ctx, authHeaders: headers, api, getDoc, getVersion };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function setClock(ctx, iso) {
  const r = await ctx.api('POST', '/api/__test__/clock', { iso });
  assert(r.status === 200, `clock ${iso} failed: ${r.status} ${JSON.stringify(r.json)}`);
}
async function overdue(ctx) {
  const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
  assert(r.status === 200, `overdue-check failed: ${r.status}`);
  return r.json.notified || [];
}
async function makeTask(ctx, venueId, title, extra = {}) {
  const tr = await ctx.api('POST', '/api/tasks', { venueId, title, createdByEmail: ADMIN_EMAIL, ...extra });
  assert(tr.status === 201 || tr.status === 200, `task create failed: ${tr.status} ${JSON.stringify(tr.json)}`);
  return (tr.json.task || tr.json).id;
}
async function editTask(ctx, id, body) {
  const v = await ctx.getVersion();
  const r = await ctx.api('PUT', `/api/tasks/${id}`, { userEmail: ADMIN_EMAIL, expectedVersion: v, ...body });
  assert(r.status === 200, `edit ${id} ${JSON.stringify(body)} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
async function stored(ctx, id) {
  const doc = await ctx.getDoc();
  const t = (doc.tasks || []).find((x) => x.id === id);
  assert(t, `task ${id} not in the stored doc`);
  return t;
}
function expectAnyTime(t, label) {
  assert(t.targetTime === 'Any time', `${label}: targetTime ${JSON.stringify(t.targetTime)}`);
  assert(t.targetTimeMinutes === undefined || t.targetTimeMinutes === null, `${label}: targetTimeMinutes ${JSON.stringify(t.targetTimeMinutes)}`);
  assert(!t.targetTime2, `${label}: targetTime2 ${JSON.stringify(t.targetTime2)}`);
  assert(t.targetTime2Minutes === undefined || t.targetTime2Minutes === null, `${label}: targetTime2Minutes ${JSON.stringify(t.targetTime2Minutes)}`);
  assert(t.enableOverdueAlert === false, `${label}: enableOverdueAlert ${JSON.stringify(t.enableOverdueAlert)}`);
}
/** Park other venues' work dates so fake-clock jumps never roll them (as Test 38). */
async function saveWorkDates(ctx) {
  const doc = await ctx.getDoc();
  const saved = { venueWorkDates: { ...(doc.venueWorkDates || {}) }, currentWorkDate: doc.currentWorkDate };
  const park = {};
  for (const v of doc.venues || []) if (v && v.id) park[v.id] = '2099-12-31';
  await ctx.api('POST', '/api/__test__/inject-fixture', { venueWorkDates: park });
  return saved;
}
async function restoreWorkDates(ctx, saved) {
  try {
    await ctx.api('POST', '/api/__test__/clock', { iso: null });
    const doc = await ctx.getDoc();
    const now = doc.venueWorkDates || {};
    const patch = { ...saved.venueWorkDates };
    for (const k of Object.keys(now)) if (!(k in patch)) patch[k] = null;
    await ctx.api('POST', '/api/__test__/inject-fixture', {
      venueWorkDates: patch,
      ...(saved.currentWorkDate ? { currentWorkDate: saved.currentWorkDate } : {}),
    });
  } catch {}
}


async function dashboardOverdueIds(ctx, venueId) {
  const r = await ctx.api('GET', '/api/admin/dashboard');
  assert(r.status === 200, `dashboard ${r.status}`);
  const v = (r.json?.venues || []).find((x) => x.venue?.id === venueId);
  assert(v, `venue ${venueId} not on the dashboard`);
  return (v.overdueTaskList || []).map((t) => t.id);
}

export default {
  name: 'Test 100: overdue only on the days a task is scheduled for (push + dashboard)',
  whatItProves:
    'At 23:30 venue time on a Sunday, the overdue push and the dashboard overdue list include Sunday, every-day and dated-today tasks but never a Friday-only task or a task dated another day; on the Friday it is the other way round.',

  async run(baseUrl, harnessCtx) {
    const ctx = await freshAdminCtx(baseUrl, harnessCtx);
    const { date, at } = futureWeekday('America/New_York', 0);
    const ts = Date.now();
    const details = [];
    const createdTasks = [];
    const saved = await saveWorkDates(ctx);
    try {
      await setClock(ctx, at(0, '09:00:00'));
      const vr = await ctx.api('POST', '/api/venues', { name: `T100 days ${ts}` });
      assert(vr.status === 201 || vr.status === 200, `venue create failed: ${vr.status} ${JSON.stringify(vr.json)}`);
      const venueId = vr.json.venue.id;
      const due = { targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true };
      const sun = await makeTask(ctx, venueId, `T100 Sunday only ${ts}`, { ...due, daysOfWeek: [0] });
      const fri = await makeTask(ctx, venueId, `T100 Friday only ${ts}`, { ...due, daysOfWeek: [5] });
      const every = await makeTask(ctx, venueId, `T100 every day (empty) ${ts}`, { ...due, daysOfWeek: [] });
      const datedSun = await makeTask(ctx, venueId, `T100 dated Sunday ${ts}`, { ...due, scheduleType: 'specific_dates', specificDates: [date(0)], daysOfWeek: [] });
      const datedFri = await makeTask(ctx, venueId, `T100 dated Friday ${ts}`, { ...due, scheduleType: 'specific_dates', specificDates: [date(5)], daysOfWeek: [0, 1, 2, 3, 4, 5, 6] });
      createdTasks.push(sun, fri, every, datedSun, datedFri);
      const st = await stored(ctx, every);
      assert(Array.isArray(st.daysOfWeek) && st.daysOfWeek.length === 0, `every-day task stored days ${JSON.stringify(st.daysOfWeek)}`);

      // ---------- Sunday 23:30 ----------
      await setClock(ctx, at(0, '23:30:00'));
      let keys = await overdue(ctx);
      for (const [id, label] of [[sun, 'Sunday-only'], [every, 'every-day'], [datedSun, 'dated today']]) {
        assert(keys.includes(`${id}:${date(0)}`), `${label} task should alert on Sunday: ${JSON.stringify(keys)}`);
      }
      for (const [id, label] of [[fri, 'Friday-only'], [datedFri, 'dated next Friday']]) {
        assert(!keys.some((k) => k.startsWith(`${id}:`)), `${label} task alerted on a Sunday: ${JSON.stringify(keys)}`);
      }
      let dash = await dashboardOverdueIds(ctx, venueId);
      assert([sun, every, datedSun].every((id) => dash.includes(id)), `dashboard Sunday missing a due task: ${JSON.stringify(dash)}`);
      assert(!dash.includes(fri) && !dash.includes(datedFri), `dashboard Sunday lists a task not scheduled today: ${JSON.stringify(dash)}`);
      details.push('Sunday: Sunday-only, every-day and dated-today alert + dashboard; Friday-only and dated-Friday neither');

      // ---------- Friday 23:30 ----------
      await setClock(ctx, at(5, '23:30:00'));
      keys = await overdue(ctx);
      for (const [id, label] of [[fri, 'Friday-only'], [datedFri, 'dated Friday'], [every, 'every-day']]) {
        assert(keys.includes(`${id}:${date(5)}`), `${label} task should alert on Friday: ${JSON.stringify(keys)}`);
      }
      for (const [id, label] of [[sun, 'Sunday-only'], [datedSun, 'dated last Sunday']]) {
        assert(!keys.some((k) => k.startsWith(`${id}:`)), `${label} task alerted on a Friday: ${JSON.stringify(keys)}`);
      }
      dash = await dashboardOverdueIds(ctx, venueId);
      assert(dash.includes(fri) && dash.includes(datedFri) && !dash.includes(sun) && !dash.includes(datedSun), `dashboard Friday wrong: ${JSON.stringify(dash)}`);
      details.push('Friday: the Friday tasks alert + dashboard; the Sunday tasks do not');

    } finally {
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true }).catch(() => {});
      for (const id of createdTasks) {
        try {
          const v = await ctx.getVersion();
          await ctx.api('DELETE', `/api/tasks/${id}`, { userEmail: ADMIN_EMAIL, expectedVersion: v });
        } catch {}
      }
      await restoreWorkDates(ctx, saved);
    }
    return details.join('; ');
  },
};
