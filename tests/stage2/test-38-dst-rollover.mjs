/**
 * Test 38 (item 6): DST and edge cases of the per-venue rollover, with the
 * test-only fake clock.
 *
 * Proves, with real instants:
 *  - Israel fall-back (2026-10-25) and spring-forward (2027-03-26): one reset
 *    at each local midnight, ±30 s around it.
 *  - US fall-back (2026-11-01): one reset at 00:00 EDT, none at either 01:30
 *    (the repeated hour), the next at 00:00 EST.
 *  - US spring-forward (2027-03-14): one reset at 00:00 EST, none in the
 *    skipped hour, the next at 00:00 EDT.
 *  - Outage catch-up: a 3-day jump closes ONE snapshot dated the last
 *    workday with catchUpDays 3; no empty days; a repeat tick is a no-op.
 *  - Concurrency: three scheduled resets fired at once straight into the
 *    transaction archive each due venue exactly once.
 *  - Overdue alerts use the venue's local time and date: New York and
 *    Jerusalem keys coexist (neither clears the other), each alerts once per
 *    local day, and the repeated 01:xx hour on US fall-back does not repeat.
 */

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function setClock(ctx, iso) {
  const r = await ctx.api('POST', '/api/__test__/clock', { iso });
  assert(r.status === 200, `clock ${iso} failed: ${r.status} ${JSON.stringify(r.json)}`);
}
async function tick(ctx, body = {}) {
  const r = await ctx.api('POST', '/api/__test__/rollover-tick', body);
  assert(r.status === 200, `rollover-tick failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
async function tickAt(ctx, iso) {
  await setClock(ctx, iso);
  return tick(ctx);
}
async function makeVenue(ctx, name, timeZone) {
  const r = await ctx.api('POST', '/api/venues', { name, ...(timeZone !== undefined ? { timeZone } : {}) });
  assert(r.status === 201 || r.status === 200, `venue create failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.venue;
}
async function makeDoneTask(ctx, venueId, title, extra = {}) {
  const tr = await ctx.api('POST', '/api/tasks', { venueId, title, createdByEmail: ADMIN_EMAIL, ...extra });
  assert(tr.status === 201 || tr.status === 200, `task create failed: ${tr.status} ${JSON.stringify(tr.json)}`);
  const taskId = (tr.json.task || tr.json).id;
  if (extra.leaveOpen) return taskId;
  const v = await ctx.getVersion();
  const done = await ctx.api('PUT', `/api/tasks/${taskId}`, {
    isCompleted: true,
    notes: `${title} notes`,
    userEmail: ADMIN_EMAIL,
    expectedVersion: v,
  });
  assert(done.status === 200, `completing task failed: ${done.status} ${JSON.stringify(done.json)}`);
  return taskId;
}
function snapsFor(doc, venueId) {
  return (doc.historyLogs || []).filter((h) => h.venueId === venueId);
}
/** Save the work-date state so the test can put it back (other tests stay unaffected). */
async function saveWorkDates(ctx) {
  const doc = await ctx.getDoc();
  return { venueWorkDates: { ...(doc.venueWorkDates || {}) }, currentWorkDate: doc.currentWorkDate };
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
async function loginAs(baseUrl, email, password) {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  assert(j.token, `login failed for ${email}: ${r.status}`);
  return j.token;
}
async function asUser(baseUrl, token, method, path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function overdue(ctx, clear = false) {
  const r = await ctx.api('POST', '/api/__test__/overdue-check', { clear });
  assert(r.status === 200, `overdue-check failed: ${r.status}`);
  return r.json.notified || [];
}

/** Assert venue `id` rolls exactly at the given instants (±30 s). */
async function expectRoll(ctx, id, before, after, label) {
  let r = await tickAt(ctx, before);
  assert(!r.reset.includes(id), `${label}: rolled early at ${before}`);
  r = await tickAt(ctx, after);
  assert(r.reset.includes(id), `${label}: did not roll at ${after}`);
  r = await tick(ctx);
  assert(!r.reset.includes(id), `${label}: rolled twice at ${after}`);
}

export default {
  name: 'Test 38: DST, catch-up, concurrency and overdue alerts per venue zone',
  whatItProves:
    'Rollovers happen once per local midnight across US and Israel DST changes (never in the repeated or skipped hour); an outage closes in one catch-up snapshot; concurrent resets archive once; overdue alerts are per venue-local day.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const details = [];
    const saved = await saveWorkDates(ctx);
    try {
      // ---------- Israel fall-back (IDT -> IST, 2026-10-25 02:00) ----------
      await setClock(ctx, '2026-10-24T12:00:00Z');
      await tick(ctx);
      const jf = await makeVenue(ctx, `T38 JLM fall ${ts}`, 'Asia/Jerusalem');
      let doc = await ctx.getDoc();
      assert(doc.venueWorkDates[jf.id] === '2026-10-24', `jf marker ${doc.venueWorkDates[jf.id]}`);
      await expectRoll(ctx, jf.id, '2026-10-24T20:59:30Z', '2026-10-24T21:00:30Z', 'Israel midnight Oct 25 (IDT)');
      await expectRoll(ctx, jf.id, '2026-10-25T21:59:30Z', '2026-10-25T22:00:30Z', 'Israel midnight Oct 26 (IST)');
      doc = await ctx.getDoc();
      assert(same(snapsFor(doc, jf.id).map((s) => s.date), ['2026-10-25', '2026-10-24']), `jf snapshots ${JSON.stringify(snapsFor(doc, jf.id).map((s) => s.date))}`);
      details.push('Israel fall-back: one reset per local midnight');

      // ---------- US fall-back (EDT -> EST, 2026-11-01 02:00) ----------
      await setClock(ctx, '2026-10-31T16:00:00Z');
      await tick(ctx);
      const nf = await makeVenue(ctx, `T38 NY fall ${ts}`);
      const ovNy = await makeDoneTask(ctx, nf.id, `T38 NY 1AM ${ts}`, { leaveOpen: true, targetTime: '01:00 AM', targetTimeMinutes: 60, enableOverdueAlert: true });
      await expectRoll(ctx, nf.id, '2026-11-01T03:59:30Z', '2026-11-01T04:00:30Z', 'NY midnight Nov 1 (EDT)');
      let r = await tickAt(ctx, '2026-11-01T05:30:00Z'); // 01:30 EDT
      assert(!r.reset.includes(nf.id), 'reset at the first 01:30');
      let keys = (await overdue(ctx, true)).filter((k) => k.startsWith(`${ovNy}:`));
      assert(same(keys, [`${ovNy}:2026-11-01`]), `1 AM task should alert once at 01:30 EDT: ${JSON.stringify(keys)}`);
      r = await tickAt(ctx, '2026-11-01T06:30:00Z'); // 01:30 EST (repeated hour)
      assert(!r.reset.includes(nf.id), 'reset in the repeated 01:30 hour');
      keys = (await overdue(ctx)).filter((k) => k.startsWith(`${ovNy}:`));
      assert(keys.length === 0, `repeated 01:30 re-alerted: ${JSON.stringify(keys)}`);
      await expectRoll(ctx, nf.id, '2026-11-02T04:59:30Z', '2026-11-02T05:00:30Z', 'NY midnight Nov 2 (EST)');
      doc = await ctx.getDoc();
      assert(same(snapsFor(doc, nf.id).map((s) => s.date), ['2026-11-01', '2026-10-31']), `nf snapshots ${JSON.stringify(snapsFor(doc, nf.id).map((s) => s.date))}`);
      details.push('US fall-back: one reset at 00:00 EDT, none at either 01:30, next at 00:00 EST; overdue once');

      // ---------- outage catch-up ----------
      await setClock(ctx, '2026-11-03T16:00:00Z');
      await tick(ctx);
      const cv = await makeVenue(ctx, `T38 catch-up ${ts}`);
      const cTask = await makeDoneTask(ctx, cv.id, `T38 catch-up task ${ts}`);
      r = await tickAt(ctx, '2026-11-06T15:00:00Z'); // 3 days later
      assert(r.reset.filter((x) => x === cv.id).length === 1, `catch-up should reset the venue once: ${JSON.stringify(r.reset)}`);
      doc = await ctx.getDoc();
      const cs = snapsFor(doc, cv.id);
      assert(cs.length === 1 && cs[0].date === '2026-11-03' && cs[0].catchUpDays === 3, `catch-up snapshot ${JSON.stringify(cs.map((s) => [s.date, s.catchUpDays]))}`);
      assert(cs[0].entries.some((e) => e.taskId === cTask && e.isCompleted), 'catch-up snapshot lost the completed task');
      assert(doc.venueWorkDates[cv.id] === '2026-11-06', `catch-up marker ${doc.venueWorkDates[cv.id]}`);
      r = await tick(ctx);
      assert(!r.reset.includes(cv.id), 'catch-up repeated');
      details.push('3-day outage: one snapshot dated 2026-11-03, catchUpDays 3, no empty days');

      // ---------- concurrency ----------
      await setClock(ctx, '2026-11-06T16:00:00Z');
      const pv = await makeVenue(ctx, `T38 parallel ${ts}`);
      await makeDoneTask(ctx, pv.id, `T38 parallel task ${ts}`);
      await setClock(ctx, '2026-11-07T05:00:30Z');
      r = await tick(ctx, { parallel: 3 });
      assert(r.reset.filter((x) => x === pv.id).length === 1, `parallel resets archived the venue ${r.reset.filter((x) => x === pv.id).length} times`);
      doc = await ctx.getDoc();
      assert(snapsFor(doc, pv.id).length === 1, `parallel: ${snapsFor(doc, pv.id).length} snapshots`);
      details.push('3 concurrent scheduled resets -> exactly one snapshot');

      // ---------- overdue keys per venue-local date ----------
      await setClock(ctx, '2026-11-07T12:00:00Z');
      const on = await makeVenue(ctx, `T38 OD NY ${ts}`);
      const oj = await makeVenue(ctx, `T38 OD JLM ${ts}`, 'Asia/Jerusalem');
      const tNy = await makeDoneTask(ctx, on.id, `T38 OD NY task ${ts}`, { leaveOpen: true, targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true });
      const tJ = await makeDoneTask(ctx, oj.id, `T38 OD JLM task ${ts}`, { leaveOpen: true, targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true });
      const ours = (ks) => ks.filter((k) => k.startsWith(`${tNy}:`) || k.startsWith(`${tJ}:`)).sort();
      await setClock(ctx, '2026-11-07T15:30:00Z'); // NY 10:30 EST, JLM 17:30 IST
      keys = ours(await overdue(ctx, true));
      assert(same(keys, [`${tNy}:2026-11-07`, `${tJ}:2026-11-07`].sort()), `both should alert: ${JSON.stringify(keys)}`);
      keys = ours(await overdue(ctx));
      assert(keys.length === 0, `second check re-alerted: ${JSON.stringify(keys)}`);
      await setClock(ctx, '2026-11-07T22:30:00Z'); // JLM 00:30 Nov 8, NY 17:30 Nov 7
      keys = ours(await overdue(ctx));
      assert(keys.length === 0, `JLM date change cleared the NY key: ${JSON.stringify(keys)}`);
      await setClock(ctx, '2026-11-08T01:30:00Z'); // UTC already Nov 8, NY 20:30 Nov 7, JLM 03:30 Nov 8
      keys = ours(await overdue(ctx));
      assert(keys.length === 0, `a UTC/other-zone date change re-alerted a venue still on its old day: ${JSON.stringify(keys)}`);
      await setClock(ctx, '2026-11-08T08:30:00Z'); // JLM 10:30 Nov 8, NY 03:30 Nov 8
      keys = ours(await overdue(ctx));
      assert(same(keys, [`${tJ}:2026-11-08`]), `only JLM should alert on its new day: ${JSON.stringify(keys)}`);
      await setClock(ctx, '2026-11-08T15:30:00Z'); // NY 10:30 Nov 8
      keys = ours(await overdue(ctx));
      assert(same(keys, [`${tNy}:2026-11-08`]), `only NY should alert on its new day: ${JSON.stringify(keys)}`);
      details.push('overdue: NY and Jerusalem keys coexist, once per venue-local day');

      // ---------- US spring-forward (EST -> EDT, 2027-03-14 02:00) ----------
      await setClock(ctx, '2027-03-13T16:00:00Z');
      await tick(ctx);
      const ns = await makeVenue(ctx, `T38 NY spring ${ts}`);
      await expectRoll(ctx, ns.id, '2027-03-14T04:59:30Z', '2027-03-14T05:00:30Z', 'NY midnight Mar 14 (EST)');
      r = await tickAt(ctx, '2027-03-14T07:00:00Z'); // 03:00 EDT, just after the skipped hour
      assert(!r.reset.includes(ns.id), 'reset around the skipped hour');
      await expectRoll(ctx, ns.id, '2027-03-15T03:59:30Z', '2027-03-15T04:00:30Z', 'NY midnight Mar 15 (EDT)');
      details.push('US spring-forward: 00:00 EST then 00:00 EDT, none in the skipped hour');

      // ---------- Israel spring-forward (IST -> IDT, 2027-03-26 02:00) ----------
      await setClock(ctx, '2027-03-25T12:00:00Z');
      await tick(ctx);
      const js = await makeVenue(ctx, `T38 JLM spring ${ts}`, 'Asia/Jerusalem');
      await expectRoll(ctx, js.id, '2027-03-25T21:59:30Z', '2027-03-25T22:00:30Z', 'Israel midnight Mar 26 (IST)');
      await expectRoll(ctx, js.id, '2027-03-26T20:59:30Z', '2027-03-26T21:00:30Z', 'Israel midnight Mar 27 (IDT)');
      details.push('Israel spring-forward: one reset per local midnight');
    } finally {
      await ctx.api('POST', '/api/__test__/overdue-check', { clear: true }).catch(() => {});
      await restoreWorkDates(ctx, saved);
    }
    return details.join('; ');
  },
};
