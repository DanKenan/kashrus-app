/**
 * Test 60 (10c checkpoint after 10d; "Agreed — 10CK plan v2"): the full
 * two-membership matrix. P = X (mashgiach, home A1, agency A, credential
 * owner) + Y (coordinator, home B1, agency B, same email + personId, no
 * credential), built by the isTestMode-only hook identity-build-person (404
 * outside test mode: Test 59 H). Test only; no production route creates a
 * second membership before 10i.
 *
 *  V1 venue data (tasks, history, alerts, notes, events, roster) — X: A1 only;
 *     Y: B1 only; REST + INITIAL_STATE
 *  V2 agency data (announcements, venues) — X: A's only; Y: B's only
 *  V3 WS — recipient AND payload: changes in A1/A2/B1/B2 and a user update of
 *     the other row never reach the wrong socket or leak foreign records
 *  V4 the event-assignment exception (keyed by email): a B2 event assigned to
 *     P's email never reaches X; an A2 control event assigned to P's email
 *     reaches X (documented own-agency exception); Y (coordinator) gets neither
 *  V5 REST writes across the boundary: generic refusal, nothing written
 *  P1-P5 push: per-row delivery; concurrent subscribe; endpoint follows the
 *     latest subscriber; delete Y keeps X; forgot-password -> agency A admin only
 *  O1 venue owner with P's email: generic refusal in A and B, X/Y untouched
 *  K1 kiosk with a SHARED email: X's PIN on Y's tile = wrong PIN on Y only
 *  E1 admin exports per agency; H1 HISTORY_PRUNED per agency
 *  L1 R1 R2 PRE-10e BASELINE (later auth PRs update these deliberately): login
 *     resolves X; reset is bound to X and changes only X; bad/expired token
 *     changes nothing
 *  C1 consistency + owner-derived projections after every block (usersByEmail
 *     read directly from the store)
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emailKey = (e) => createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');
const decode = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const dayIn = (tz, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = { ws, messages, close: () => { try { ws.close(); } catch {} } };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

/** usersByEmail/{key} straight from the store (real emulator REST, or the mock file). */
async function usersByEmailDoc(key) {
  const real = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_MOCK !== 'true';
  if (real) {
    const project = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-test';
    const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents/usersByEmail/${key}`);
    if (r.status === 404) return null;
    assert(r.ok, `emulator read usersByEmail ${r.status}`);
    const f = (await r.json()).fields || {};
    const out = {};
    for (const [k, v] of Object.entries(f)) out[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ?? v.nullValue ?? v;
    return out;
  }
  const file = process.env.FIRESTORE_MOCK_FILE || join(tmpdir(), 'stage2-mock-firestore.json');
  const store = JSON.parse(readFileSync(file, 'utf-8'));
  return store[`usersByEmail/${key}`] || null;
}

export default {
  name: 'Test 60: two-membership matrix (10c checkpoint after 10d)',
  whatItProves:
    'One person with memberships in two agencies (X owner in A, Y coordinator in B, same email): REST, WS, push, reset, venue owner, kiosk, exports and history never cross X/Y; the event exception keyed by email stays inside its agency; pre-10e login/reset baseline pinned (resolves the credential owner, changes only it).',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const NY = 'America/New_York', JER = 'Asia/Jerusalem';
    const A = `agency-t60a-${ts}`, B = `agency-t60b-${ts}`;
    const A1 = `venue-t60-a1-${ts}`, A2 = `venue-t60-a2-${ts}`, B1 = `venue-t60-b1-${ts}`, B2 = `venue-t60-b2-${ts}`;
    const U = (k) => `user-t60-${k}-${ts}`;
    const E = (k) => `t60-${k}-${ts}@test.local`;
    const EP = (k) => `https://push.test.invalid/t60-${k}-${ts}`;
    const PE = E('p');
    const PW = 'stage2-t60-password';
    const X = U('x');
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.60.${ts % 200}.${ipN++}` });
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const opId = () => `op-t60-${Math.random().toString(36).slice(2)}`;
    const write = async (method, path, token, body) => call(method, path, auth(token), { expectedVersion: await ctx.getVersion(), operationId: opId(), ...body });
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); return { status: r.status, json: r.json }; };
    const rows = async () => ((await ctx.getDoc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);

    // ---- ids per venue (the leak needles) ----
    const ids = {};
    for (const v of ['a1', 'a2', 'b1', 'b2']) {
      ids[v] = { task: `task-t60-${v}-${ts}`, inc: `inc-t60-${v}-${ts}`, note: `note-t60-${v}-${ts}`, hist: `hist-t60-${v}-${ts}`, ev: `ev-t60-${v}-${ts}` };
    }
    const VID = { a1: A1, a2: A2, b1: B1, b2: B2 };
    const AG = { a1: A, a2: A, b1: B, b2: B };
    const now = new Date(ts).toISOString();
    const task = (v) => ({
      id: ids[v].task, agencyId: AG[v], venueId: VID[v], title: `T60 task ${v} ${ts}`, description: '', category: 'General', categories: ['General'],
      isPrivate: false, sortOrder: 0, inputType: 'yes_no', assignedTo: ['all'], scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetTime: 'End of Day', priority: 'medium', enableOverdueAlert: false, currentStatus: null, isCompleted: false, notes: '',
      updatedAt: now, checkIns: [], createdAt: now,
    });
    const yesterday = (tz) => addDays(dayIn(tz, ts), -1);
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T60 A ${ts}`, timeZone: NY }, { id: B, name: `T60 B ${ts}`, timeZone: JER }],
      venues: [{ id: A1, name: `T60 A1 ${ts}`, agencyId: A }, { id: A2, name: `T60 A2 ${ts}`, agencyId: A }, { id: B1, name: `T60 B1 ${ts}`, agencyId: B }, { id: B2, name: `T60 B2 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T60 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T60 Admin B', role: 'admin', agencyId: B },
        { id: X, email: PE, name: 'T60 X', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('mA2'), email: E('ma2'), name: 'T60 Mash A2', role: 'mashgiach', agencyId: A, venueId: A2 },
        { id: U('mB2'), email: E('mb2'), name: 'T60 Mash B2', role: 'mashgiach', agencyId: B, venueId: B2 },
      ],
      tasks: ['a1', 'a2', 'b1', 'b2'].map(task),
      incidents: ['a1', 'a2', 'b1', 'b2'].map((v) => ({ id: ids[v].inc, agencyId: AG[v], venueId: VID[v], title: `T60 inc ${v} ${ts}`, description: 'd', severity: 'medium', status: 'open', reporterEmail: E('ada'), reporterName: 'T60', createdAt: now })),
      handoffNotes: ['a1', 'a2', 'b1', 'b2'].map((v) => ({ id: ids[v].note, agencyId: AG[v], venueId: VID[v], authorEmail: E('ada'), authorName: 'T60', content: `T60 note ${v} ${ts}`, shift: 'Morning', createdAt: now })),
      historyLogs: ['a1', 'a2', 'b1', 'b2'].map((v) => ({ id: ids[v].hist, agencyId: AG[v], venueId: VID[v], date: yesterday(AG[v] === A ? NY : JER), totalTasks: 1, completedTasks: 1, completionRate: 100, entries: [] })),
      events: [
        { id: ids.a1.ev, agencyId: A, venueId: A1, title: `T60 ev a1 ${ts}`, location: 'Hall', date: '2026-11-05', tasks: [] },
        { id: ids.b1.ev, agencyId: B, venueId: B1, title: `T60 ev b1 ${ts}`, location: 'Hall', date: '2026-11-05', tasks: [] },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status} ${J(inj.json)}`);

    // X: credential owner (planted like Test 59; 10i is the production writer).
    let r = await hook('set-password', { userId: X, password: PW });
    assert(r.status === 200, `set-password X ${r.status}`);
    {
      const users = (await rows()).map((u) => (u.id === X ? { ...u, credentialOwner: true, credentialOrigin: 'self-registered' } : u));
      assert((await hook('doc-set-users', { users })).status === 200, 'plant owner');
      assert((await hook('inject-fixture', { venues: [{ id: `venue-t60-h-${ts}`, name: 'T60 hydrate', agencyId: A }] })).status === 200, 'rehydrate');
    }
    const pid = (await rowOf(X)).personId;
    assert(pid === X, `X is its own person ${pid}`);
    r = await hook('identity-build-person', { ownerUserId: X, agencyId: B, role: 'coordinator', venueId: B1, name: 'T60 Y' });
    assert(r.status === 200 && typeof r.json?.id === 'string', `build Y ${r.status} ${J(r.json)}`);
    const Y = r.json.id;
    {
      const y = await rowOf(Y);
      assert(y && y.personId === pid && y.email === PE && y.agencyId === B && y.role === 'coordinator' && y.venueId === B1, `Y joined P ${J(y)}`);
      assert(y.password === undefined && y.credentialOwner === undefined, 'Y holds no credential');
    }
    const tok = { x: await mintToken(baseUrl, X), y: await mintToken(baseUrl, Y), adA: await mintToken(baseUrl, U('adA')), adB: await mintToken(baseUrl, U('adB')) };
    assert(decode(tok.y).mem === Y || decode(tok.y).sub === Y || decode(tok.y).userId === Y, `Y token is bound to Y's row ${J(decode(tok.y))}`);

    // ---- C1 helpers ----
    const opTok = await mintToken(baseUrl, 'usr_admin');
    const status = async () => {
      const s = await ctx.api('GET', '/api/admin/per-entity-status');
      assert(s.status === 200 && s.json, `per-entity-status ${s.status}`);
      return s.json.status || s.json;
    };
    const baseInvalid = (await status()).identity.invalidGroups;
    const projections = async (label, ownerId, ownerName) => {
      const st = await status();
      assert(st.identity.invalidGroups === baseInvalid, `${label}: identity.invalidGroups ${st.identity.invalidGroups} != ${baseInvalid}`);
      const mine = (st.mismatches || []).filter((m) => String(m.id).includes(X) || String(m.id).includes(Y) || String(m.id).includes(pid));
      assert(mine.length === 0, `${label}: per-entity mismatch for P ${J(mine)}`);
      const d = await ctx.api('POST', '/api/__test__/identity-docs-bulk', { peopleIds: [pid], emails: [PE] });
      assert(d.status === 200, `identity-docs-bulk ${d.status}`);
      const people = d.json.people[pid], emails = d.json.emails[PE];
      assert(people?.status === 'active' && people.name === ownerName, `${label}: people/P from the owner ${J(people)}`);
      assert(emails?.status === 'active' && emails.personId === pid, `${label}: emails -> P ${J(emails)}`);
      const ube = await usersByEmailDoc(emailKey(PE));
      assert(ube && ube.userId === ownerId, `${label}: usersByEmail -> ${ownerId}, got ${J(ube)}`);
    };
    await projections('setup', X, 'T60 X');

    const all = (vs) => vs.flatMap((v) => Object.values(ids[v]));
    const noneOf = (blob, needles, label) => {
      const s = typeof blob === 'string' ? blob : J(blob);
      const hit = needles.filter((n) => s.includes(n));
      assert(hit.length === 0, `${label}: foreign records leaked ${J(hit)}`);
    };
    const has = (blob, needle, label) => assert((typeof blob === 'string' ? blob : J(blob)).includes(needle), `${label}: missing ${needle}`);

    // ---- V1 / V2: REST reads ----
    {
      const routes = ['/api/tasks', '/api/history', '/api/incidents', '/api/handoff-notes', '/api/events', '/api/users', '/api/announcements', '/api/venues'];
      for (const [who, own, foreign] of [['x', 'a1', ['a2', 'b1', 'b2']], ['y', 'b1', ['b2', 'a1', 'a2']]]) {
        const got = {};
        for (const p of routes) {
          const res = await call('GET', p, auth(tok[who]));
          assert(res.status === 200, `V1 ${who} GET ${p}: ${res.status} ${res.text.slice(0, 120)}`);
          got[p] = res.text;
          noneOf(res.text, all(foreign), `V1 ${who} GET ${p}`);
        }
        has(got['/api/tasks'], ids[own].task, `V1 ${who} own task`);
        has(got['/api/incidents'], ids[own].inc, `V1 ${who} own alert`);
        has(got['/api/events'], ids[own].ev, `V1 ${who} own-venue event`);
        const otherAgency = who === 'x' ? [B, B1, B2, U('adB'), U('mB2'), Y] : [A, A1, A2, U('adA'), U('mA2'), X];
        noneOf(got['/api/users'] + got['/api/venues'], otherAgency, `V2 ${who} roster/venues`);
      }
      console.log('  ✓ V1/V2 REST reads stay in the row\'s agency and venue scope');
    }

    // ---- V3 / V4: WS (INITIAL_STATE, broadcasts) ----
    let wsX, wsY;
    try {
      wsX = await connectWs(baseUrl, tok.x); wsY = await connectWs(baseUrl, tok.y);
      const initX = wsX.messages.find((m) => m.type === 'INITIAL_STATE'), initY = wsY.messages.find((m) => m.type === 'INITIAL_STATE');
      noneOf(initX, [...all(['a2', 'b1', 'b2']), B, Y, U('adB')], 'V1 X INITIAL_STATE');
      noneOf(initY, [...all(['b2', 'a1', 'a2']), A, X, U('adA')], 'V1 Y INITIAL_STATE');
      has(initX, ids.a1.task, 'V1 X INITIAL_STATE own task'); has(initY, ids.b1.task, 'V1 Y INITIAL_STATE own task');
      const mark = { x: wsX.messages.length, y: wsY.messages.length };
      // task changes in all four venues
      for (const [v, t] of [['a1', 'adA'], ['a2', 'adA'], ['b1', 'adB'], ['b2', 'adB']]) {
        const u = await write('PUT', `/api/tasks/${ids[v].task}`, tok[t], { title: `T60 task ${v} ${ts} edited` });
        assert(u.status === 200, `V3 edit ${v}: ${u.status} ${u.text.slice(0, 160)}`);
      }
      // user update of the OTHER row
      let u = await write('PUT', `/api/users/${Y}`, tok.adB, { name: 'T60 Y renamed' });
      assert(u.status === 200, `V3 rename Y: ${u.status} ${u.text.slice(0, 160)}`);
      u = await write('PUT', `/api/users/${X}`, tok.adA, { name: 'T60 X renamed' });
      assert(u.status === 200, `V3 rename X: ${u.status} ${u.text.slice(0, 160)}`);
      // V4: events assigned to P's email — B2 (foreign for X) and A2 (own-agency exception for X)
      const evB2 = await call('POST', '/api/events', auth(tok.adB), { venueId: B2, title: `T60 ev b2 ${ts}`, location: 'Hall', date: '2026-11-06', mashgiachType: 'assigned_user', assignedMashgiachEmail: PE, operationId: opId() });
      assert(evB2.status === 201, `V4 event B2: ${evB2.status} ${evB2.text.slice(0, 160)}`);
      const evA2 = await call('POST', '/api/events', auth(tok.adA), { venueId: A2, title: `T60 ev a2 ${ts}`, location: 'Hall', date: '2026-11-06', mashgiachType: 'assigned_user', assignedMashgiachEmail: PE, operationId: opId() });
      assert(evA2.status === 201, `V4 event A2: ${evA2.status} ${evA2.text.slice(0, 160)}`);
      const evB2Id = evB2.json?.event?.id || evB2.json?.id, evA2Id = evA2.json?.event?.id || evA2.json?.id;
      assert(evB2Id && evA2Id, `V4 event ids ${J(evB2.json)} ${J(evA2.json)}`);
      await sleep(1500);
      const newX = wsX.messages.slice(mark.x), newY = wsY.messages.slice(mark.y);
      // (a) recipients: X saw its A1 change, Y its B1 change
      assert(newX.some((m) => J(m).includes(ids.a1.task)), 'V3 X got no A1 task update');
      assert(newY.some((m) => J(m).includes(ids.b1.task)), 'V3 Y got no B1 task update');
      // (b) payloads: nothing foreign in anything either socket received
      noneOf(newX, [ids.a2.task, ids.b1.task, ids.b2.task, B, B1, B2, Y, 'T60 Y renamed', evB2Id], 'V3/V4 X socket');
      noneOf(newY, [ids.b2.task, ids.a1.task, ids.a2.task, A, A1, A2, X, 'T60 X renamed', evA2Id, evB2Id], 'V3/V4 Y socket');
      assert(newX.some((m) => J(m).includes(evA2Id)), 'V4 X (assigned mashgiach, own agency) got no A2 event broadcast');
      // REST view of events after the fact
      const ex = await call('GET', '/api/events', auth(tok.x)), ey = await call('GET', '/api/events', auth(tok.y));
      noneOf(ex.text, [evB2Id, ids.b1.ev], 'V4 X GET /api/events'); has(ex.text, evA2Id, 'V4 X sees the A2 event assigned to it');
      noneOf(ey.text, [evB2Id, evA2Id, ids.a1.ev], 'V4 Y GET /api/events (coordinator at B1: no assignee exception)');
      console.log('  ✓ V3/V4 WS recipients + payloads; event exception stays in its agency');
    } finally {
      wsX?.close(); wsY?.close();
    }

    // ---- V5: writes across the boundary ----
    {
      for (const [who, v] of [['x', 'b1'], ['x', 'a2'], ['y', 'a1'], ['y', 'b2']]) {
        const v0 = await ctx.getVersion();
        const w = await write('PUT', `/api/tasks/${ids[v].task}`, tok[who], { title: `HACK ${who} ${v}` });
        assert(w.status === 403 || w.status === 404, `V5 ${who} -> ${v} task: ${w.status} ${w.text.slice(0, 120)}`);
        await unchanged(v0, `V5 ${who} -> ${v}`);
      }
      console.log('  ✓ V5 cross-boundary writes refused, nothing written');
    }
    await projections('V', X, 'T60 X renamed');

    // ---- push ----
    const subscribe = async (who, endpoint) => {
      const s = await call('POST', '/api/push/subscribe', auth(tok[who]), { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
      assert(s.status === 200, `subscribe ${who}: ${s.status} ${s.text.slice(0, 120)}`);
    };
    const subAt = async (endpoint) => ((await ctx.getDoc()).pushSubscriptions || []).filter((s) => s.endpoint === endpoint);
    const log = async () => ((await ctx.api('GET', '/api/__test__/push-log')).json?.log || []).filter((e) => String(e.endpoint).includes(`-${ts}`));
    const clear = async () => { await ctx.api('POST', '/api/__test__/push-log/clear', {}); };
    const eps = (entries) => [...new Set(entries.map((e) => e.endpoint))].sort();
    {
      await subscribe('adA', EP('ada')); await subscribe('adB', EP('adb'));
      // P2: concurrent subscribe of both memberships keeps both records
      await Promise.all([subscribe('x', EP('x')), subscribe('y', EP('y'))]);
      const sx = await subAt(EP('x')), sy = await subAt(EP('y'));
      assert(sx.length === 1 && sx[0].userId === X && sx[0].agencyId === A, `P2 X record ${J(sx)}`);
      assert(sy.length === 1 && sy[0].userId === Y && sy[0].agencyId === B, `P2 Y record ${J(sy)}`);
      // P1: announcements per agency
      await clear();
      let w = await write('POST', '/api/announcements', tok.adA, { title: `T60 annA ${ts}`, body: 'a', targetRoles: ['all'] });
      assert(w.status === 200 || w.status === 201, `annA ${w.status}`);
      w = await write('POST', '/api/announcements', tok.adB, { title: `T60 annB ${ts}`, body: 'b', targetRoles: ['all'] });
      assert(w.status === 200 || w.status === 201, `annB ${w.status}`);
      let e = await log();
      const annA = e.filter((x) => String(x.title).includes(`T60 annA ${ts}`)), annB = e.filter((x) => String(x.title).includes(`T60 annB ${ts}`));
      assert(eps(annA).includes(EP('x')) && !eps(annA).includes(EP('y')) && !eps(annA).includes(EP('adb')), `P1 A announcement endpoints ${J(eps(annA))}`);
      assert(eps(annB).includes(EP('y')) && !eps(annB).includes(EP('x')) && !eps(annB).includes(EP('ada')), `P1 B announcement endpoints ${J(eps(annB))}`);
      // P1: alerts raised by each row go to its own agency's admin only
      await clear();
      w = await write('POST', '/api/incidents', tok.x, { severity: 'high', venueId: A1, title: `T60 alertX ${ts}` });
      assert(w.status === 200, `alert X ${w.status} ${w.text.slice(0, 120)}`);
      w = await write('POST', '/api/incidents', tok.y, { severity: 'high', venueId: B1, title: `T60 alertY ${ts}` });
      assert(w.status === 200, `alert Y ${w.status} ${w.text.slice(0, 120)}`);
      e = await log();
      const alX = e.filter((x) => String(x.title).includes(`T60 alertX ${ts}`)), alY = e.filter((x) => String(x.title).includes(`T60 alertY ${ts}`));
      assert(J(eps(alX)) === J([EP('ada')]), `P1 X's alert endpoints ${J(eps(alX))}`);
      assert(!eps(alY).includes(EP('ada')) && !eps(alY).includes(EP('x')), `P1 Y's alert crossed to A ${J(eps(alY))}`);
      assert(eps(alY).includes(EP('adb')), `P1 Y's alert did not reach B's admin ${J(eps(alY))}`);
      // P1: event assignment in A reaches X only
      await clear();
      const ev = await call('POST', '/api/events', auth(tok.adA), { venueId: A1, title: `T60 evp ${ts}`, location: 'Hall', date: '2026-11-07', mashgiachType: 'assigned_user', assignedMashgiachEmail: PE, operationId: opId() });
      assert(ev.status === 201, `P1 event ${ev.status}`);
      e = (await log()).filter((x) => x.title === '⭐ New event assignment');
      assert(J(eps(e)) === J([EP('x')]), `P1 A event assignment endpoints ${J(eps(e))}`);
      // P3: one endpoint follows the most recent subscriber
      await subscribe('x', EP('sw')); await subscribe('y', EP('sw'));
      const sw = await subAt(EP('sw'));
      assert(sw.length === 1 && sw[0].userId === Y && sw[0].agencyId === B, `P3 endpoint follows Y ${J(sw)}`);
      await clear();
      w = await write('POST', '/api/announcements', tok.adA, { title: `T60 annA2 ${ts}`, body: 'a', targetRoles: ['all'] });
      assert(w.status === 200 || w.status === 201, `annA2 ${w.status}`);
      e = (await log()).filter((x) => String(x.title).includes(`T60 annA2 ${ts}`));
      assert(!eps(e).includes(EP('sw')) && eps(e).includes(EP('x')), `P3 A push on the switched endpoint ${J(eps(e))}`);
      // P5: forgot-password -> agency A's admin only; one reset record, X's
      await clear();
      const fp = await call('POST', '/api/auth/forgot-password', ipH(), { email: PE });
      assert(fp.status === 200, `P5 forgot ${fp.status}`);
      e = (await log()).filter((x) => String(x.title).startsWith('🔑 Password reset code'));
      assert(J(eps(e)) === J([EP('ada')]), `P5 reset-code push endpoints ${J(eps(e))}`);
      const resets = ((await ctx.getDoc()).passwordResets || []).filter((x) => x.email === PE);
      assert(resets.length === 1, `P5 exactly one reset record ${resets.length}`);
      if (resets[0].userId !== undefined) assert(resets[0].userId === X, `P5 the reset is X's ${resets[0].userId}`);
      console.log('  ✓ P1/P2/P3/P5 push per row; concurrent subscribe; endpoint follows Y; reset code -> agency A admin only');
    }

    // ---- O1: venue owner with P's email ----
    {
      const before = J([await rowOf(X), await rowOf(Y)]);
      for (const [t, ag] of [['adA', 'A'], ['adB', 'B']]) {
        const v0 = await ctx.getVersion();
        const o = await call('POST', '/api/venues', auth(tok[t]), { name: `T60 owner ${ag} ${ts}`, ownerEmail: PE.toUpperCase(), ownerName: 'Nope' });
        assert(o.status === 409 && /OWNER_EMAIL_UNAVAILABLE/.test(o.text), `O1 ${ag}: ${o.status} ${o.text.slice(0, 160)}`);
        await unchanged(v0, `O1 ${ag}`);
      }
      assert(J([await rowOf(X), await rowOf(Y)]) === before, 'O1 X/Y unchanged');
      assert(!((await ctx.getDoc()).venues || []).some((v) => String(v.name).startsWith(`T60 owner`)), 'O1 no venue created');
      console.log('  ✓ O1 venue owner with P\'s email refused in A and B; rows untouched');
    }

    // ---- K1: kiosk, shared email ----
    {
      let w = await write('PUT', `/api/users/${X}`, tok.adA, { kioskPin: '6011' });
      assert(w.status === 200, `PIN X ${w.status} ${w.text.slice(0, 120)}`);
      w = await write('PUT', `/api/users/${Y}`, tok.adB, { kioskPin: '6022' });
      assert(w.status === 200, `PIN Y ${w.status} ${w.text.slice(0, 120)}`);
      const start = await call('POST', '/api/kiosk/pairing/start', jsonH, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const p = await call('POST', '/api/kiosk/devices/pair', auth(tok.adB), { code: start.json.code, venueId: B1 });
      assert(p.status === 201, `devices/pair ${p.status} ${p.text.slice(0, 120)}`);
      const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } }).then((x) => x.json());
      assert(st.status === 'approved', `claim ${J(st).slice(0, 120)}`);
      const dev = `${st.device.id}.${start.json.deviceSecret}`;
      const lk0 = (await ctx.getDoc()).kioskPinLockouts || { users: {} };
      const xBefore = J((lk0.users || {})[X] || null);
      const yBefore = (((lk0.users || {})[Y] || {}).fails || []).length;
      let k = await call('POST', '/api/kiosk/login', { ...jsonH, 'X-Kiosk-Device': dev, 'X-Forwarded-For': `10.60.${ts % 200}.250` }, { userId: Y, pin: '6011' });
      assert(k.status === 401 && k.json?.error === 'Wrong code. Try again.', `K1 X's PIN on Y's tile: ${k.status} ${k.text.slice(0, 120)}`);
      assert(!k.text.includes(X) && !k.text.includes('T60 X'), 'K1 no hint about X');
      const lk1 = (await ctx.getDoc()).kioskPinLockouts || { users: {} };
      assert((((lk1.users || {})[Y] || {}).fails || []).length === yBefore + 1, 'K1 counted once on Y');
      assert(J((lk1.users || {})[X] || null) === xBefore, 'K1 X lockout untouched');
      k = await call('POST', '/api/kiosk/login', { ...jsonH, 'X-Kiosk-Device': dev, 'X-Forwarded-For': `10.60.${ts % 200}.251` }, { userId: Y, pin: '6022' });
      assert(k.status === 200 && k.json?.user?.id === Y, `K1 Y's own PIN: ${k.status} ${k.text.slice(0, 120)}`);
      console.log('  ✓ K1 kiosk wrong PIN counted on Y only (shared email)');
    }

    // ---- E1: admin exports ----
    {
      const ea = await call('GET', '/api/admin/export', auth(tok.adA)), eb = await call('GET', '/api/admin/export', auth(tok.adB));
      assert(ea.status === 200 && eb.status === 200, `E1 export ${ea.status} ${eb.status}`);
      has(ea.text, X, 'E1 A export lists X'); noneOf(ea.text, [Y, ...all(['b1', 'b2'])], 'E1 A export');
      has(eb.text, Y, 'E1 B export lists Y'); noneOf(eb.text, [X, ...all(['a1', 'a2'])], 'E1 B export');
      console.log('  ✓ E1 exports per agency');
    }

    // ---- H1: HISTORY_PRUNED per agency ----
    {
      const nowMs = Date.parse(`${dayIn(NY, ts)}T12:00:00.000Z`);   // same date in NY and Jerusalem (see Test 48)
      assert((await ctx.api('POST', '/api/__test__/clock', { iso: new Date(nowMs).toISOString() })).status === 200, 'clock');
      let wx, wy;
      try {
        const old = (v, tz) => ({ id: `hist-t60-old-${v}-${ts}`, agencyId: AG[v], venueId: VID[v], date: addDays(dayIn(tz, nowMs), -20), totalTasks: 1, completedTasks: 1, completionRate: 100, entries: [] });
        assert((await hook('inject-fixture', { historyLogs: [old('a1', NY), old('b1', JER)] })).status === 200, 'H1 inject');
        wx = await connectWs(baseUrl, tok.x); wy = await connectWs(baseUrl, tok.y);
        await ctx.api('POST', '/api/__test__/history-retention-gate', {});
        const t = await ctx.api('POST', '/api/__test__/rollover-tick', {});
        assert(t.status === 200 && (t.json?.historyRemoved || 0) >= 2, `H1 sweep ${t.status} ${J(t.json)}`);
        await sleep(1000);
        const px = wx.messages.filter((m) => m.type === 'HISTORY_PRUNED'), py = wy.messages.filter((m) => m.type === 'HISTORY_PRUNED');
        noneOf(px, [B, B1, B2, ...all(['a2', 'b1', 'b2'])], 'H1 X HISTORY_PRUNED');
        noneOf(py, [A, A1, A2, ...all(['b2', 'a1', 'a2'])], 'H1 Y HISTORY_PRUNED');
        const d = await ctx.getDoc();
        assert(!(d.historyLogs || []).some((h) => h.id === `hist-t60-old-a1-${ts}` || h.id === `hist-t60-old-b1-${ts}`), 'H1 the expired snapshots were removed');
      } finally {
        wx?.close(); wy?.close();
        await ctx.api('POST', '/api/__test__/clock', { iso: null });
      }
      console.log('  ✓ H1 HISTORY_PRUNED stays per agency');
    }
    await projections('P/O/K/E/H', X, 'T60 X renamed');

    // ---- L1 / R1 / R2: PRE-10e BASELINE (later auth PRs update these deliberately) ----
    {
      // L1: login resolves the credential owner X; never a Y session
      let lg = await call('POST', '/api/auth/login', jsonH, { email: PE, password: PW });
      assert(lg.status === 200 && lg.json?.user?.id === X, `L1 login resolves X: ${lg.status} ${lg.text.slice(0, 160)}`);
      const c = decode(lg.json.token);
      assert(J(c).includes(X) && !J(c).includes(Y), `L1 the session is X's ${J(c)}`);
      // R2 (invalid): a made-up token changes nothing
      let v0 = await ctx.getVersion();
      let rr = await call('POST', '/api/auth/reset-password', jsonH, { email: PE, resetToken: 'not-a-real-token-0000', newPassword: 'stage2-t60-nope' });
      assert(rr.status !== 200, `R2 invalid token must be refused: ${rr.status}`);
      await unchanged(v0, 'R2 invalid token');
      // R2 (expired): an expired code yields no reset token and changes neither row.
      // (verify-reset-code checks expiresAt; the test hook expire-reset ages the
      // request. Finding for 10e, not pinned here: reset-password itself does not
      // re-check expiresAt once a request is verified.)
      {
        const fp0 = await call('POST', '/api/auth/forgot-password', ipH(), { email: PE });
        assert(fp0.status === 200, `R2 forgot ${fp0.status}`);
        const code0 = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(PE)}`)).json()).code;
        assert((await hook('expire-reset', { email: PE })).status === 200, 'R2 expire-reset');
        const xs = J(await rowOf(X)), ys = J(await rowOf(Y));
        rr = await call('POST', '/api/auth/verify-reset-code', ipH(), { email: PE, code: code0 });
        assert(rr.status !== 200 && !rr.json?.resetToken, `R2 expired code must not verify: ${rr.status} ${rr.text.slice(0, 120)}`);
        assert(J(await rowOf(X)) === xs && J(await rowOf(Y)) === ys, 'R2 expired code changed a row');
      }
      // R1: a fresh request is bound to X; a successful reset changes only X
      const fp = await call('POST', '/api/auth/forgot-password', ipH(), { email: PE });
      assert(fp.status === 200, `R1 forgot ${fp.status}`);
      const code2 = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(PE)}`)).json()).code;
      const ip2 = ipH();
      rr = await call('POST', '/api/auth/verify-reset-code', ip2, { email: PE, code: code2 });
      assert(rr.status === 200 && rr.json?.resetToken, `R1 verify 2 ${rr.status} ${rr.text.slice(0, 120)}`);
      const xBefore = await rowOf(X), yBefore = await rowOf(Y);
      rr = await call('POST', '/api/auth/reset-password', jsonH, { email: PE, resetToken: rr.json.resetToken, newPassword: 'stage2-t60-newpass' });
      assert(rr.status === 200 && rr.json?.user?.id === X, `R1 reset resolves X: ${rr.status} ${rr.text.slice(0, 160)}`);
      const xAfter = await rowOf(X), yAfter = await rowOf(Y);
      assert(xAfter.password && xAfter.password !== xBefore.password, 'R1 X\'s credential changed');
      assert(J(yAfter) === J(yBefore), `R1 Y unchanged (no password, same membership fields) ${J(yAfter)}`);
      assert(yAfter.password === undefined, 'R1 Y still holds no credential');
      lg = await call('POST', '/api/auth/login', jsonH, { email: PE, password: 'stage2-t60-newpass' });
      assert(lg.status === 200 && lg.json?.user?.id === X, `R1 new password logs in as X: ${lg.status}`);
      assert(!((await ctx.getDoc()).passwordResets || []).some((x) => x.email === PE), 'R1 no pending reset left');
      console.log('  ✓ L1/R1/R2 PRE-10e BASELINE: login and reset resolve X only; bad/expired tokens change nothing');
    }
    await projections('L/R', X, 'T60 X renamed');

    // ---- P4 + cleanup: delete Y keeps X; then X; P retired ----
    {
      let d = await call('DELETE', `/api/users/${Y}`, auth(tok.adB), { expectedVersion: await ctx.getVersion() });
      assert(d.status === 200, `delete Y ${d.status} ${d.text.slice(0, 120)}`);
      assert((await subAt(EP('y'))).length === 0 && (await subAt(EP('sw'))).length === 0, 'P4 Y\'s records removed');
      assert((await subAt(EP('x'))).length === 1, 'P4 X\'s record kept');
      await clear();
      const w = await write('POST', '/api/announcements', tok.adA, { title: `T60 annA3 ${ts}`, body: 'a', targetRoles: ['all'] });
      assert(w.status === 200 || w.status === 201, `annA3 ${w.status}`);
      const e = (await log()).filter((x) => String(x.title).includes(`T60 annA3 ${ts}`));
      assert(eps(e).includes(EP('x')), `P4 X still receives after Y is deleted ${J(eps(e))}`);
      await projections('P4', X, 'T60 X renamed');
      d = await call('DELETE', `/api/users/${X}`, auth(tok.adA), { expectedVersion: await ctx.getVersion() });
      assert(d.status === 200, `delete X ${d.status} ${d.text.slice(0, 120)}`);
      const docs = await ctx.api('POST', '/api/__test__/identity-docs-bulk', { peopleIds: [pid], emails: [PE] });
      assert(docs.json.people[pid]?.status === 'retired' && docs.json.emails[PE]?.status === 'retired', `cleanup retires P ${J(docs.json)}`);
      for (const k of ['ada', 'adb']) await call('POST', '/api/push/unsubscribe', auth(tok[k === 'ada' ? 'adA' : 'adB']), { endpoint: EP(k) });
      const left = ((await ctx.getDoc()).pushSubscriptions || []).filter((s) => String(s.endpoint).includes(`-${ts}`));
      assert(left.length === 0, `cleanup: no test subscriptions left ${J(left.map((s) => s.endpoint))}`);
      assert(!((await ctx.getDoc()).passwordResets || []).some((x) => x.email === PE), 'cleanup: no pending reset');
      console.log('  ✓ P4 delete Y keeps X; cleanup retires P, no subscriptions or resets left');
    }
    return 'X(A, owner) + Y(B, coordinator) share one email: REST/WS reads and payloads, writes, events (assignment exception inside its agency), pushes (per row, concurrent, endpoint switch, reset code to agency A admin), venue owner refusal, kiosk, exports, history prune all stay per row; PRE-10e baseline: login/reset resolve X only, bad/expired token inert; projections from the owner throughout; cleanup retires P';
  },
};
