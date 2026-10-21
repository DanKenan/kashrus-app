/**
 * Test 40 (6c): any-time tasks — a task with no target time.
 *
 * "Any time" is stored as the reserved targetTime text "Any time" with no
 * minutes, no second time and the overdue alert off (6c plan v2, agreed with
 * ChatGPT). The server enforces that on EVERY write path and the overdue
 * check skips it explicitly.
 *
 * Proves, on the real emulator with the test-only fake clock:
 *  - create: a body with stray minutes, a second time and enableOverdueAlert
 *    true is stored as "Any time", no minutes, no time2, alert off; "any time "
 *    typed as custom text is stored as "Any time".
 *  - overdue: at 23:30 venue time the any-time tasks never alert, while a
 *    timed 10:00 AM task in the same venue still alerts once.
 *  - edit to Any time (only targetTime sent, as an old client might): the old
 *    minutes and the alert are cleared, so it stops alerting.
 *  - partial edits on an any-time task cannot turn the alert back on or add a
 *    second time.
 *  - edit back to 9:00 AM with the alert on: it alerts again.
 *  - templates: an any-time template entry applies with the alert off; an
 *    ordinary entry applies unchanged and still alerts.
 *  - old tasks: a task created with no time still reads "End of Day"; a timed
 *    task keeps its minutes and alert exactly.
 *  - order: a new any-time task is placed after the timed tasks.
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

export default {
  name: 'Test 40: any-time tasks (no target time) never go overdue; old and timed tasks unchanged',
  whatItProves:
    'An "Any time" task is stored with no minutes, no second time and the alert off on every write path (create, edit incl. partial edits, template apply); the overdue check skips it while timed tasks still alert; editing back to a time restores alerts; old tasks keep their time; new any-time tasks sit after timed ones.',

  async run(baseUrl, harnessCtx) {
    const ctx = await freshAdminCtx(baseUrl, harnessCtx);
    const ts = Date.now();
    const details = [];
    const createdTasks = [];
    let templateId = null;
    const saved = await saveWorkDates(ctx);
    try {
      await setClock(ctx, '2026-11-10T14:00:00Z'); // NY 09:00 EST
      const vr = await ctx.api('POST', '/api/venues', { name: `T40 any-time ${ts}` });
      assert(vr.status === 201 || vr.status === 200, `venue create failed: ${vr.status} ${JSON.stringify(vr.json)}`);
      const venueId = vr.json.venue.id;

      // ---------- create ----------
      const early = await makeTask(ctx, venueId, `T40 early 8AM ${ts}`, { targetTime: '8:00 AM', targetTimeMinutes: 480 });
      const timed = await makeTask(ctx, venueId, `T40 timed 10AM ${ts}`, { targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true });
      const anyA = await makeTask(ctx, venueId, `T40 any A ${ts}`, {
        targetTime: 'Any time',
        targetTimeMinutes: 540,
        targetTime2: '3:00 PM',
        targetTime2Minutes: 900,
        enableOverdueAlert: true,
      });
      const anyTyped = await makeTask(ctx, venueId, `T40 any typed ${ts}`, { targetTime: 'any time ', targetTimeMinutes: null, enableOverdueAlert: true });
      const late = await makeTask(ctx, venueId, `T40 late 11AM ${ts}`, { targetTime: '11:00 AM', targetTimeMinutes: 660 });
      const oldStyle = await makeTask(ctx, venueId, `T40 no time ${ts}`, {});
      createdTasks.push(early, timed, anyA, anyTyped, late, oldStyle);

      expectAnyTime(await stored(ctx, anyA), 'create with stray minutes/time2/alert');
      expectAnyTime(await stored(ctx, anyTyped), 'create with typed "any time "');
      const tTimed = await stored(ctx, timed);
      assert(tTimed.targetTime === '10:00 AM' && tTimed.targetTimeMinutes === 600 && tTimed.enableOverdueAlert === true, `timed task changed: ${JSON.stringify([tTimed.targetTime, tTimed.targetTimeMinutes, tTimed.enableOverdueAlert])}`);
      const tOld = await stored(ctx, oldStyle);
      assert(tOld.targetTime === 'End of Day', `no-time task should still read End of Day: ${JSON.stringify(tOld.targetTime)}`);
      details.push('create: any-time stored with no minutes/time2 and alert off; typed "any time " canonical; timed and no-time tasks unchanged');

      // ---------- order ----------
      const doc0 = await ctx.getDoc();
      const so = (id) => (doc0.tasks.find((t) => t.id === id) || {}).sortOrder;
      assert(so(anyA) > so(early) && so(anyA) > so(timed) && so(anyA) > so(late), `any-time not after timed tasks: early ${so(early)} timed ${so(timed)} late ${so(late)} any ${so(anyA)}`);
      details.push('order: new any-time task placed after the timed tasks');

      // ---------- overdue at 23:30 venue time ----------
      await setClock(ctx, '2026-11-11T04:30:00Z'); // NY 23:30 EST Nov 10
      let keys = await overdue(ctx);
      assert(keys.includes(`${timed}:2026-11-10`), `timed 10 AM task should alert: ${JSON.stringify(keys)}`);
      assert(!keys.some((k) => k.startsWith(`${anyA}:`) || k.startsWith(`${anyTyped}:`)), `any-time task alerted: ${JSON.stringify(keys)}`);
      details.push('overdue: timed task alerts, any-time tasks never');

      // ---------- edit a timed task to Any time (only targetTime sent) ----------
      await setClock(ctx, '2026-11-10T14:00:00Z');
      const toAny = await makeTask(ctx, venueId, `T40 timed->any ${ts}`, { targetTime: '9:00 AM', targetTimeMinutes: 540, enableOverdueAlert: true });
      createdTasks.push(toAny);
      await setClock(ctx, '2026-11-11T04:30:00Z');
      keys = await overdue(ctx);
      assert(keys.includes(`${toAny}:2026-11-10`), `9 AM task should alert before the edit: ${JSON.stringify(keys)}`);
      await editTask(ctx, toAny, { targetTime: 'Any time' });
      expectAnyTime(await stored(ctx, toAny), 'edit to Any time (only targetTime sent)');
      keys = await overdue(ctx);
      assert(!keys.some((k) => k.startsWith(`${toAny}:`)), `task edited to Any time still alerts (stale minutes): ${JSON.stringify(keys)}`);
      details.push('edit to Any time: old minutes and alert cleared, no longer alerts');

      // ---------- partial edits on an any-time task ----------
      await editTask(ctx, anyA, { enableOverdueAlert: true });
      expectAnyTime(await stored(ctx, anyA), 'partial edit enableOverdueAlert: true');
      await editTask(ctx, anyA, { targetTime2: '3:00 PM', targetTime2Minutes: 900 });
      expectAnyTime(await stored(ctx, anyA), 'partial edit adding a second time');
      await editTask(ctx, anyA, { title: `T40 any A renamed ${ts}` });
      const renamed = await stored(ctx, anyA);
      expectAnyTime(renamed, 'title-only edit');
      assert(renamed.title === `T40 any A renamed ${ts}`, 'title-only edit lost the title');
      details.push('partial edits cannot re-enable the alert or add a second time');

      // ---------- edit back to a time ----------
      await editTask(ctx, anyA, { targetTime: '9:00 AM', targetTimeMinutes: 540, targetTime2: '', targetTime2Minutes: null, enableOverdueAlert: true });
      const back = await stored(ctx, anyA);
      assert(back.targetTime === '9:00 AM' && back.targetTimeMinutes === 540 && back.enableOverdueAlert === true, `edit back to 9 AM: ${JSON.stringify([back.targetTime, back.targetTimeMinutes, back.enableOverdueAlert])}`);
      keys = await overdue(ctx);
      assert(keys.includes(`${anyA}:2026-11-10`), `task switched back to 9 AM should alert again: ${JSON.stringify(keys)}`);
      details.push('edit back to 9:00 AM with the alert on: alerts again');

      // ---------- templates ----------
      await setClock(ctx, '2026-11-10T14:00:00Z');
      const tr = await ctx.api('POST', '/api/task-templates', {
        name: `T40 template ${ts}`,
        tasks: [
          { title: `T40 tmpl any ${ts}`, description: '', category: 'General', targetTime: 'Any time', priority: 'medium', enableOverdueAlert: true },
          { title: `T40 tmpl timed ${ts}`, description: '', category: 'General', targetTime: '10:00 AM', priority: 'medium', enableOverdueAlert: true },
        ],
      });
      assert(tr.status === 200 || tr.status === 201, `template create failed: ${tr.status} ${JSON.stringify(tr.json)}`);
      templateId = tr.json.template.id;
      const ap = await ctx.api('POST', `/api/task-templates/${templateId}/apply`, { venueId });
      assert(ap.status === 200, `template apply failed: ${ap.status} ${JSON.stringify(ap.json)}`);
      const doc1 = await ctx.getDoc();
      const tAny = doc1.tasks.find((t) => t.venueId === venueId && t.title === `T40 tmpl any ${ts}`);
      const tTim = doc1.tasks.find((t) => t.venueId === venueId && t.title === `T40 tmpl timed ${ts}`);
      assert(tAny && tTim, 'template tasks not created');
      createdTasks.push(tAny.id, tTim.id);
      expectAnyTime(tAny, 'template any-time entry');
      assert(tTim.targetTime === '10:00 AM' && tTim.enableOverdueAlert === true, `ordinary template entry changed: ${JSON.stringify([tTim.targetTime, tTim.enableOverdueAlert])}`);
      await setClock(ctx, '2026-11-11T04:30:00Z');
      keys = await overdue(ctx);
      assert(keys.includes(`${tTim.id}:2026-11-10`), `timed template task should alert: ${JSON.stringify(keys)}`);
      assert(!keys.some((k) => k.startsWith(`${tAny.id}:`)), `any-time template task alerted: ${JSON.stringify(keys)}`);
      details.push('templates: any-time entry applies with the alert off; ordinary entry unchanged and alerts');
    } finally {
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true }).catch(() => {});
      for (const id of createdTasks) {
        try {
          const v = await ctx.getVersion();
          await ctx.api('DELETE', `/api/tasks/${id}`, { userEmail: ADMIN_EMAIL, expectedVersion: v });
        } catch {}
      }
      if (templateId) await ctx.api('DELETE', `/api/task-templates/${templateId}`).catch(() => {});
      await restoreWorkDates(ctx, saved);
    }
    return details.join('; ');
  },
};
