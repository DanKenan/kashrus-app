/**
 * Test 37 (item 6): per-venue time zones — work day, rollover, #27 archive
 * date, legacy migration, zone changes, zone writes and rule T.
 *
 * Uses the test-only fake clock (/api/__test__/clock) and one-pass rollover
 * (/api/__test__/rollover-tick). Every assertion is about this test's own
 * venues (other venues in the doc may roll too under the fake clock); the
 * work-date state is restored at the end.
 *
 * Proves:
 *  a) a venue created with a zone stores it; its workday starts at today in
 *     its zone; bad zones are 400 (no write).
 *  b) Jerusalem rolls at Jerusalem midnight while the New York venue (same
 *     agency) stays byte-for-byte untouched; New York rolls at NY midnight.
 *  c) PR #27: a scheduled snapshot is dated with the CLOSED workday; a
 *     manual one with today; a second tick at the same instant is a no-op.
 *  d) legacy (pre-item-6) data: no markers, legacy NY date -> Jerusalem rolls
 *     on its own midnight, the NY venue's marker is materialized from the
 *     legacy date and it rolls at NY midnight exactly as before.
 *  e) zone change = prospective: westward (no early reset, manual reset never
 *     lowers the marker), eastward (no immediate reset, nothing destroyed),
 *     clearing an override.
 *  f) rule T: mashgiach and coordinator get 403 on venue/agency zone writes,
 *     another agency's admin cannot touch our venue, agency writes only
 *     change the caller's agency, a stale form is 409 — all with the doc
 *     version unchanged.
 */

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

/**
 * A ctx whose requests carry a FRESH admin token: after Test 18 the harness's
 * login token can be invalid (rule F), so mint one for the seed admin
 * (usr_admin, agency-hkc) via the test-only mint-token route.
 */
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

/** Open a WS as `token`; resolves after INITIAL_STATE with { ws, messages }. */
function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve({ ws, messages }); }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WS error: ${e?.message || 'unknown'}`)); };
  });
}
async function waitFor(messages, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = messages.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export default {
  name: 'Test 37: Per-venue time zones (rollover, archive date, legacy, zone changes, rule T)',
  whatItProves:
    "Each venue's work day and daily reset follow its own IANA zone (venue -> agency -> New York); only due venues reset; snapshots carry the closed workday; legacy data migrates without reinterpretation; zone changes never reset or go backwards; zone writes are admin-only within the agency.",

  async run(baseUrl, harnessCtx) {
    const ctx = await freshAdminCtx(baseUrl, harnessCtx);
    const ts = Date.now();
    const details = [];
    const saved = await saveWorkDates(ctx);
    try {
      // ---------- a) create venues under the fake clock ----------
      await setClock(ctx, '2026-10-21T16:00:00Z'); // 12:00 EDT, 19:00 IDT
      await tick(ctx); // flush anything already due at this instant
      const again = await tick(ctx);
      assert(again.reset.length === 0, `second tick at the same instant should be a no-op, reset ${JSON.stringify(again.reset)}`);
      details.push('tick at same instant = no-op');

      const bad1 = await ctx.api('POST', '/api/venues', { name: `T37 bad ${ts}`, timeZone: 'Mars/Olympus' });
      const bad2 = await ctx.api('POST', '/api/venues', { name: `T37 bad2 ${ts}`, timeZone: 'EST5EDT' });
      const bad3 = await ctx.api('POST', '/api/venues', { name: `T37 bad3 ${ts}`, timeZone: 42 });
      assert(bad1.status === 400 && bad2.status === 400 && bad3.status === 400, `bad zones should be 400: ${bad1.status}/${bad2.status}/${bad3.status}`);
      const docA = await ctx.getDoc();
      assert(!docA.venues.some((v) => String(v.name).startsWith(`T37 bad`)), 'a rejected venue was written');

      const ny = await makeVenue(ctx, `T37 NY ${ts}`);
      const jlm = await makeVenue(ctx, `T37 JLM ${ts}`, 'Asia/Jerusalem');
      assert(!ny.timeZone, 'NY venue should store no zone');
      assert(jlm.timeZone === 'Asia/Jerusalem', `JLM zone not stored: ${jlm.timeZone}`);
      let doc = await ctx.getDoc();
      assert(doc.venueWorkDates[ny.id] === '2026-10-21', `NY marker ${doc.venueWorkDates[ny.id]}`);
      assert(doc.venueWorkDates[jlm.id] === '2026-10-21', `JLM marker ${doc.venueWorkDates[jlm.id]}`);
      details.push('venues created; markers = today in zone; bad zones 400');

      const nyTask = await makeDoneTask(ctx, ny.id, `T37 NY task ${ts}`);
      const jlmTask = await makeDoneTask(ctx, jlm.id, `T37 JLM task ${ts}`);

      // ---------- b/c) Jerusalem midnight ----------
      let r = await tickAt(ctx, '2026-10-21T20:59:30Z'); // 23:59:30 IDT
      assert(!r.reset.includes(jlm.id) && !r.reset.includes(ny.id), `nothing of ours due at 23:59:30 IDT: ${JSON.stringify(r.reset)}`);
      doc = await ctx.getDoc();
      const nyTaskBefore = doc.tasks.find((t) => t.id === nyTask);
      const nySnapsBefore = snapsFor(doc, ny.id).length;
      r = await tickAt(ctx, '2026-10-21T21:00:30Z'); // 00:00:30 IDT Oct 22, 17:00:30 EDT Oct 21
      assert(r.reset.includes(jlm.id), `JLM should roll at Jerusalem midnight: ${JSON.stringify(r.reset)}`);
      assert(!r.reset.includes(ny.id), 'NY must not roll at Jerusalem midnight');
      doc = await ctx.getDoc();
      const jt = doc.tasks.find((t) => t.id === jlmTask);
      assert(jt.isCompleted === false && jt.notes === '', 'JLM task not reset');
      const js = snapsFor(doc, jlm.id);
      assert(js.length === 1 && js[0].date === '2026-10-21', `JLM snapshot should be dated the CLOSED day 2026-10-21: ${JSON.stringify(js.map((s) => s.date))}`);
      assert(js[0].entries.some((e) => e.taskId === jlmTask && e.isCompleted === true), 'JLM snapshot did not archive the completed task');
      assert(same(doc.tasks.find((t) => t.id === nyTask), nyTaskBefore), 'NY task changed when only Jerusalem was due');
      assert(snapsFor(doc, ny.id).length === nySnapsBefore, 'NY got a snapshot at Jerusalem midnight');
      assert(doc.venueWorkDates[jlm.id] === '2026-10-22' && doc.venueWorkDates[ny.id] === '2026-10-21', `markers after JLM roll: ${doc.venueWorkDates[jlm.id]} / ${doc.venueWorkDates[ny.id]}`);
      const vNo = await ctx.getVersion();
      r = await tick(ctx);
      assert(r.reset.length === 0 && (await ctx.getVersion()) === vNo, 'repeat tick bumped the version or reset something');
      details.push('Jerusalem rolled alone at its midnight; NY byte-for-byte untouched; snapshot dated closed day; repeat = no-op');

      // ---------- NY midnight ----------
      r = await tickAt(ctx, '2026-10-22T03:59:30Z'); // 23:59:30 EDT Oct 21
      assert(!r.reset.includes(ny.id), 'NY rolled before NY midnight');
      r = await tickAt(ctx, '2026-10-22T04:00:30Z'); // 00:00:30 EDT Oct 22
      assert(r.reset.includes(ny.id) && !r.reset.includes(jlm.id), `NY should roll alone at NY midnight: ${JSON.stringify(r.reset)}`);
      doc = await ctx.getDoc();
      const ns = snapsFor(doc, ny.id);
      assert(ns[0].date === '2026-10-21', `NY snapshot date ${ns[0].date} (closed day 2026-10-21 expected)`);
      assert(doc.venueWorkDates[ny.id] === '2026-10-22', `NY marker ${doc.venueWorkDates[ny.id]}`);
      details.push('NY rolled at NY midnight, dated 2026-10-21');

      // ---------- manual reset: dated today ----------
      await setClock(ctx, '2026-10-22T15:00:00Z');
      const mr = await ctx.api('POST', '/api/reset-daily', { force: true, venueId: ny.id });
      assert(mr.status === 200, `manual reset failed: ${mr.status}`);
      doc = await ctx.getDoc();
      const ns2 = snapsFor(doc, ny.id);
      assert(ns2[0].date === '2026-10-22' && doc.venueWorkDates[ny.id] === '2026-10-22', `manual snapshot ${ns2[0].date}, marker ${doc.venueWorkDates[ny.id]}`);
      assert(snapsFor(doc, jlm.id).length === 1, 'manual NY reset touched JLM');
      details.push('manual reset dated today (2026-10-22), venue-only');

      // ---------- d) legacy (pre-item-6) shape ----------
      await setClock(ctx, '2026-10-22T21:30:00Z'); // 17:30 EDT Oct 22, 00:30 IDT Oct 23
      const inj = await ctx.api('POST', '/api/__test__/inject-fixture', { venueWorkDates: null, currentWorkDate: '2026-10-22' });
      assert(inj.status === 200, 'inject legacy shape failed');
      doc = await ctx.getDoc();
      assert(!doc.venueWorkDates || Object.keys(doc.venueWorkDates).length === 0, 'markers not cleared for the legacy shape');
      r = await tick(ctx);
      assert(r.reset.includes(jlm.id) && !r.reset.includes(ny.id), `legacy: only JLM should roll at 00:30 IDT: ${JSON.stringify(r.reset)}`);
      doc = await ctx.getDoc();
      assert(snapsFor(doc, jlm.id)[0].date === '2026-10-22', `legacy JLM snapshot ${snapsFor(doc, jlm.id)[0].date}`);
      assert(doc.venueWorkDates[ny.id] === '2026-10-22', `NY marker not materialized from the legacy date: ${doc.venueWorkDates[ny.id]}`);
      assert(doc.currentWorkDate === '2026-10-22', `legacy date advanced early: ${doc.currentWorkDate}`);
      r = await tickAt(ctx, '2026-10-23T04:00:30Z');
      assert(r.reset.includes(ny.id), 'legacy NY venue did not roll at NY midnight');
      doc = await ctx.getDoc();
      assert(snapsFor(doc, ny.id)[0].date === '2026-10-22' && doc.currentWorkDate === '2026-10-23', `legacy NY: snapshot ${snapsFor(doc, ny.id)[0].date}, legacy ${doc.currentWorkDate}`);
      details.push('legacy shape: JLM on its own midnight, NY marker materialized (not reinterpreted), NY at NY midnight');

      // ---------- e) westward zone change ----------
      await setClock(ctx, '2026-10-23T22:00:00Z'); // 18:00 EDT Oct 23, 01:00 IDT Oct 24
      const w = await makeVenue(ctx, `T37 West ${ts}`, 'Asia/Jerusalem');
      const wTask = await makeDoneTask(ctx, w.id, `T37 West task ${ts}`);
      doc = await ctx.getDoc();
      assert(doc.venueWorkDates[w.id] === '2026-10-24', `W marker ${doc.venueWorkDates[w.id]}`);
      let v = await ctx.getVersion();
      let pr = await ctx.api('PUT', `/api/venues/${w.id}`, { timeZone: 'America/New_York', expectedVersion: v });
      assert(pr.status === 200 && pr.json.venue.timeZone === 'America/New_York', `westward PUT failed: ${pr.status} ${JSON.stringify(pr.json)}`);
      assert(pr.json.nextResetDate === '2026-10-25', `westward next reset should be 2026-10-25, got ${pr.json.nextResetDate}`);
      doc = await ctx.getDoc();
      assert(doc.venueWorkDates[w.id] === '2026-10-24', `westward marker moved: ${doc.venueWorkDates[w.id]}`);
      assert(snapsFor(doc, w.id).length === 0 && doc.tasks.find((t) => t.id === wTask).isCompleted === true, 'zone change reset something');
      await setClock(ctx, '2026-10-23T22:30:00Z');
      const wm = await ctx.api('POST', '/api/reset-daily', { force: true, venueId: w.id });
      assert(wm.status === 200, 'manual reset W failed');
      doc = await ctx.getDoc();
      assert(doc.venueWorkDates[w.id] === '2026-10-24', `manual reset lowered the marker: ${doc.venueWorkDates[w.id]}`);
      assert(snapsFor(doc, w.id)[0].date === '2026-10-24', `manual snapshot during westward transition dated ${snapsFor(doc, w.id)[0].date}`);
      r = await tickAt(ctx, '2026-10-24T04:00:30Z'); // NY midnight starting the 24th
      assert(!r.reset.includes(w.id), 'W reset again at the midnight starting the 24th');
      r = await tickAt(ctx, '2026-10-25T04:00:30Z'); // NY midnight starting the 25th
      assert(r.reset.includes(w.id), 'W did not roll at the midnight starting the 25th');
      doc = await ctx.getDoc();
      const wsn = snapsFor(doc, w.id);
      assert(wsn.length === 2 && wsn[0].date === '2026-10-24' && doc.venueWorkDates[w.id] === '2026-10-25', `W after roll: ${JSON.stringify(wsn.map((s) => s.date))} marker ${doc.venueWorkDates[w.id]}`);
      details.push('westward: no early reset, manual never lowers marker, next roll at the 25th dated 24');

      // ---------- e) eastward + clearing an override ----------
      await setClock(ctx, '2026-10-25T23:00:00Z'); // 19:00 EDT Oct 25, 01:00 IST Oct 26
      const e = await makeVenue(ctx, `T37 East ${ts}`);
      const eTask = await makeDoneTask(ctx, e.id, `T37 East task ${ts}`);
      v = await ctx.getVersion();
      pr = await ctx.api('PUT', `/api/venues/${e.id}`, { timeZone: 'Asia/Jerusalem', expectedVersion: v });
      assert(pr.status === 200, `eastward PUT failed: ${pr.status}`);
      doc = await ctx.getDoc();
      assert(doc.venueWorkDates[e.id] === '2026-10-26', `eastward marker ${doc.venueWorkDates[e.id]}`);
      assert(snapsFor(doc, e.id).length === 0 && doc.tasks.find((t) => t.id === eTask).isCompleted === true, 'eastward change destroyed work');
      r = await tick(ctx);
      assert(!r.reset.includes(e.id), 'eastward change caused an immediate reset');
      r = await tickAt(ctx, '2026-10-26T22:00:30Z'); // 00:00:30 IST Oct 27
      assert(r.reset.includes(e.id), 'E did not roll at the next Jerusalem midnight');
      doc = await ctx.getDoc();
      const es = snapsFor(doc, e.id);
      assert(es.length === 1 && es[0].date === '2026-10-26' && es[0].entries.some((x) => x.taskId === eTask && x.isCompleted), `E snapshot ${JSON.stringify(es.map((s) => s.date))}`);
      await setClock(ctx, '2026-10-26T22:10:00Z'); // 18:10 EDT Oct 26
      v = await ctx.getVersion();
      pr = await ctx.api('PUT', `/api/venues/${e.id}`, { timeZone: '', expectedVersion: v });
      assert(pr.status === 200 && !pr.json.venue.timeZone, `clearing override failed: ${pr.status} ${JSON.stringify(pr.json)}`);
      doc = await ctx.getDoc();
      assert(doc.venueWorkDates[e.id] === '2026-10-27', `clearing moved the marker: ${doc.venueWorkDates[e.id]}`);
      r = await tickAt(ctx, '2026-10-27T04:00:30Z');
      assert(!r.reset.includes(e.id), 'E reset at the NY midnight starting the 27th (marker already 27)');
      r = await tickAt(ctx, '2026-10-28T04:00:30Z');
      assert(r.reset.includes(e.id), 'E did not roll at the NY midnight starting the 28th');
      details.push('eastward: no immediate reset, work archived at next Jerusalem midnight; clearing override prospective');

      // ---------- f) zone writes + rule T ----------
      const mEmail = `t37-m-${ts}@test.local`;
      const cEmail = `t37-c-${ts}@test.local`;
      const cm = await ctx.api('POST', '/api/users', { email: mEmail, name: 'T37 M', role: 'mashgiach', password: 'pw-t37-mmm', venueId: ny.id });
      const cc = await ctx.api('POST', '/api/users', { email: cEmail, name: 'T37 C', role: 'coordinator', password: 'pw-t37-ccc', venueId: ny.id });
      assert([200, 201].includes(cm.status) && [200, 201].includes(cc.status), `user create failed: ${cm.status}/${cc.status}`);
      const mTok = await loginAs(baseUrl, mEmail, 'pw-t37-mmm');
      const cTok = await loginAs(baseUrl, cEmail, 'pw-t37-ccc');
      const bAdminId = `usr_t37_badmin_${ts}`;
      const injB = await ctx.api('POST', '/api/__test__/inject-fixture', {
        agencies: [{ id: 'agency-t37-b', name: 'T37 Agency B', shortCode: 'T37B', adminEmail: `t37-b-${ts}@test.local`, certificationSeal: 'K', region: 'X', createdAt: new Date().toISOString() }],
        users: [{ id: bAdminId, agencyId: 'agency-t37-b', email: `t37-b-${ts}@test.local`, name: 'T37 B Admin', role: 'admin' }],
      });
      assert(injB.status === 200, 'inject agency B failed');
      const mt = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: bAdminId }) });
      const bTok = (await mt.json()).token;
      assert(bTok, 'mint agency-B token failed');

      const v0 = await ctx.getVersion();
      for (const [who, tok] of [['mashgiach', mTok], ['coordinator', cTok]]) {
        const a = await asUser(baseUrl, tok, 'PUT', `/api/venues/${ny.id}`, { timeZone: 'Asia/Jerusalem', expectedVersion: v0 });
        const b = await asUser(baseUrl, tok, 'PUT', '/api/agencies/current', { timeZone: 'Asia/Jerusalem', expectedVersion: v0 });
        assert(a.status === 403 && b.status === 403, `${who} zone writes should be 403: venue ${a.status}, agency ${b.status}`);
      }
      const bx = await asUser(baseUrl, bTok, 'PUT', `/api/venues/${ny.id}`, { timeZone: 'Asia/Jerusalem', expectedVersion: v0 });
      assert(bx.status === 403 || bx.status === 404, `other agency admin on our venue should be 403/404: ${bx.status}`);
      const badPut = await ctx.api('PUT', `/api/venues/${ny.id}`, { timeZone: 'Not/AZone', expectedVersion: v0 });
      assert(badPut.status === 400, `invalid zone PUT should be 400: ${badPut.status}`);
      const badAg = await ctx.api('PUT', '/api/agencies/current', { timeZone: 'Not/AZone', expectedVersion: v0 });
      assert(badAg.status === 400, `invalid agency zone should be 400: ${badAg.status}`);
      assert((await ctx.getVersion()) === v0, 'a refused zone write changed the document');
      doc = await ctx.getDoc();
      assert(!doc.venues.find((x) => x.id === ny.id).timeZone, 'NY venue zone changed by a refused write');
      details.push('mashgiach/coordinator 403, other agency 403/404, invalid 400, version unchanged');

      // Agency B admin changes ONLY agency B.
      const hkcBefore = (doc.agencies.find((a) => a.id === 'agency-hkc') || {}).timeZone;
      const vb = await ctx.getVersion();
      const agB = await asUser(baseUrl, bTok, 'PUT', '/api/agencies/current', { timeZone: 'Asia/Jerusalem', expectedVersion: vb });
      assert(agB.status === 200, `agency B zone write failed: ${agB.status} ${JSON.stringify(agB.json)}`);
      doc = await ctx.getDoc();
      assert(doc.agencies.find((a) => a.id === 'agency-t37-b').timeZone === 'Asia/Jerusalem', 'agency B zone not stored');
      assert((doc.agencies.find((a) => a.id === 'agency-hkc') || {}).timeZone === hkcBefore, 'agency B write changed agency HKC');
      details.push('agency write changes only the caller agency');

      // Stale form: someone else changes the zone; an old-version save is 409.
      const vs = await ctx.getVersion();
      const ok1 = await ctx.api('PUT', `/api/venues/${ny.id}`, { timeZone: 'America/Chicago', expectedVersion: vs });
      assert(ok1.status === 200, `zone set failed: ${ok1.status}`);
      const stale = await ctx.api('PUT', `/api/venues/${ny.id}`, { timeZone: 'America/Denver', expectedVersion: vs });
      assert(stale.status === 409, `stale zone save should be 409: ${stale.status}`);
      doc = await ctx.getDoc();
      assert(doc.venues.find((x) => x.id === ny.id).timeZone === 'America/Chicago', 'stale save overwrote the zone');
      details.push('stale zone save 409, newer value kept');

      // Agency zone applies when the venue has none; venue zone wins.
      const vc = await ctx.getVersion();
      const clr = await ctx.api('PUT', `/api/venues/${ny.id}`, { timeZone: null, expectedVersion: vc });
      assert(clr.status === 200 && !clr.json.venue.timeZone, 'clear NY zone failed');
      // An already-open staff client hears the agency zone change (non-admin
      // public profile carries timeZone) and, later, its clearing.
      const live = await connectWs(baseUrl, mTok);
      const va = await ctx.getVersion();
      const agH = await ctx.api('PUT', '/api/agencies/current', { timeZone: 'America/Los_Angeles', expectedVersion: va });
      assert(agH.status === 200 && agH.json.agency.timeZone === 'America/Los_Angeles', `HKC agency zone failed: ${agH.status}`);
      const heard = await waitFor(live.messages, (m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.timeZone === 'America/Los_Angeles');
      assert(heard, 'open mashgiach client did not receive AGENCY_UPDATED with the new zone');
      assert(!('adminEmail' in heard.payload.agency), 'non-admin AGENCY_UPDATED leaked adminEmail');
      const me = await ctx.api('PUT', `/api/venues/${ny.id}`, { name: `T37 NY ${ts}`, expectedVersion: await ctx.getVersion() });
      assert(me.status === 200 && me.json.effectiveTimeZone === 'America/Los_Angeles', `inherited zone should be LA: ${me.json && me.json.effectiveTimeZone}`);
      assert(clr.json && true, '');
      const jx = await ctx.api('PUT', `/api/venues/${jlm.id}`, { name: `T37 JLM ${ts}`, expectedVersion: await ctx.getVersion() });
      assert(jx.json.effectiveTimeZone === 'Asia/Jerusalem', `venue zone should win over agency: ${jx.json.effectiveTimeZone}`);
      const vz = await ctx.getVersion();
      const agClr = await ctx.api('PUT', '/api/agencies/current', { timeZone: '', expectedVersion: vz });
      assert(agClr.status === 200 && !agClr.json.agency.timeZone, `clearing agency zone failed: ${agClr.status}`);
      const heardClr = await waitFor(
        live.messages,
        (m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.id === 'agency-hkc' && !m.payload.agency.timeZone
      );
      assert(heardClr, 'open client did not hear the agency zone being cleared');
      try { live.ws.close(); } catch {}
      details.push('venue without zone inherits agency zone; venue zone wins; open staff client hears agency zone set + cleared (no adminEmail)');
    } finally {
      // Put the HKC agency zone back (other tests assume New York).
      try {
        const vr = await ctx.getVersion();
        await ctx.api('PUT', '/api/agencies/current', { timeZone: null, expectedVersion: vr });
      } catch {}
      await restoreWorkDates(ctx, saved);
    }
    return details.join('; ');
  },
};
