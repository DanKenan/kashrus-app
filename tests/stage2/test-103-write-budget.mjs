/**
 * Test 103: Database WRITE budget (WRITECUT, Nov 2 2026).
 *
 * The live app ran out of Google's free daily WRITE quota (20,000 document
 * writes/day) on Nov 1 (~9 PM ET) and sign-in hung on "Verifying
 * Credentials…". This test measures, with the server's own write meter
 * (src/server/write-meter.ts), what each thing a real day does costs in
 * database writes (by collection and by caller), then adds up the same
 * scripted HKC-sized day as test 97 (3 venues, 28 tasks, 10 staff, phones +
 * 3 kiosks) plus an editor's shift/task work, and fails when that day
 * exceeds DAY_BUDGET (a tenth of the free quota).
 *
 *  P  each read endpoint on its own: must write NOTHING
 *  L  a password sign-in
 *  A  app open (admin + mashgiach: socket + GETs); B the GETs again after 16 s
 *  C  a task save; a shift note + 5 phone refreshes; a check-in
 *  H  an editor's shift work: create a shift, edit it, a shift task, 3 task edits
 *  D  kiosk login + a kiosk poll
 *  E  idle: phone + kiosk sockets for 65 s (background timers included)
 *  G  a task save fanned out to idle sockets
 *  S  "Seen by" counts x4; R 5 phone sockets reconnect
 *  O  the overdue checker for one simulated hour (4 runs) + 5 rollover ticks
 *  Q  a QR tablet on its sign-in screen for 65 s
 *  F  the day: counts x measured costs <= DAY_BUDGET (and with the QR
 *     tablets <= DAY_WITH_QR_BUDGET); every single save <= SAVE_MAX writes
 * Deletes are counted apart (Google bills them on their own daily quota).
 * Production Firestore answers map keys sorted (the emulator and the mock keep
 * insertion order), so the test reads the state the way production does
 * (POST /api/__test__/prod-key-order): on Nov 1 that order difference made
 * every save re-write every user row.
 */

// The scripted day without the QR tablets, and the whole day with 3 tablets on
// the QR sign-in screen 12 h each. The QR screen costs ~166 writes per tablet-hour
// today (each code rotation re-writes the device doc and the code doc); cutting that
// is a separate change, so this budget pins today's cost (no regression) and stays
// well under the 20,000/day free write quota.
const DAY_BUDGET = 2_000;
const DAY_WITH_QR_BUDGET = 7_500;
// One save = the main document + the entities it changed (never every user row).
const SAVE_MAX = 3;
const DAY = {
  logins: 20,            // password sign-ins
  appOpens: 80,
  revisits: 400,
  taskSaves: 250,        // check-ins / task edits
  notes: 40,
  kioskPolls: 3 * 12 * 60,
  kioskLogins: 60,
  phoneSocketHours: 6 * 10,
  kioskSocketHours: 3 * 12,
  qrScreenHours: 3 * 12,
  seenOpens: 200,
  reconnects: 300,
  shiftEdits: 10,        // shift create/edit by an editor
  overdueHours: 24,      // the overdue checker + rollover ticks run all day
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

export default {
  name: 'Test 103: Database write budget for one HKC-sized day',
  whatItProves:
    'Measured with the server write meter: read paths write nothing, and a sign-in, app opens, saves, shift work, kiosk use, idle sockets, the overdue checker and QR polling cost few enough database writes that a scripted HKC-sized day stays far under the 20,000/day free write quota.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t103-${ts}`;
    const V = [1, 2, 3].map((n) => `venue-t103-${n}-${ts}`);
    const uid = (n) => `user-t103-${n}-${ts}`;
    const people = [
      ['don', 'admin', V[0]], ['coord1', 'coordinator', V[0]], ['coord2', 'coordinator', V[1]],
      ['m1', 'mashgiach', V[0]], ['m2', 'mashgiach', V[0]], ['m3', 'mashgiach', V[1]], ['m4', 'mashgiach', V[1]],
      ['m5', 'mashgiach', V[2]], ['m6', 'mashgiach', V[2]], ['owner1', 'owner', V[0]],
    ];
    const email = (n) => `${n}-t103-${ts}@test.local`;
    const tasks = [];
    for (let i = 0; i < 28; i++) tasks.push({ id: `task-t103-${i}-${ts}`, title: `T103 task ${i}`, venueId: V[i % 3], agencyId: AG, status: 'pending', assignedTo: i % 2 ? ['all'] : [], targetTime: '08:00', enableOverdueAlert: i % 4 === 0 });
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'T103 Agency' }],
      venues: V.map((id, i) => ({ id, name: `T103 V${i + 1} ${ts}`, agencyId: AG })),
      users: people.map(([n, role, venueId]) => ({ id: uid(n), email: email(n), name: `T103 ${n}`, role, agencyId: AG, venueId })),
      tasks,
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const T = {};
    for (const [n] of people) {
      const r = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ userId: uid(n), session: true }) });
      if (r.status !== 200) throw new Error(`session token ${n}: ${r.status}`);
      T[n] = (await r.json()).token;
    }
    const writes = async () => (await ctx.api('POST', '/api/__test__/writes', {})).json;
    const costs = {};
    const detail = {};
    const measure = async (label, fn) => {
      await sleep(250);
      const a = await writes();
      await fn();
      await sleep(400);
      const b = await writes();
      const by = {}, who = {};
      for (const [k, v] of Object.entries(b.byCollection)) { const d = v - (a.byCollection[k] || 0); if (d) by[k] = d; }
      for (const [k, v] of Object.entries(b.byCaller)) { const d = v - (a.byCaller[k] || 0); if (d) who[k] = d; }
      costs[label] = b.total - a.total;
      const dels = (b.deletes || 0) - (a.deletes || 0);
      detail[label] = { by, who, dels };
      console.log(`[writes] ${label}: ${costs[label]}${dels ? ` (+${dels} deletes)` : ''} ${J(by)} ${J(who)}`);
      return costs[label];
    };
    // A measured request must succeed: an endpoint that errors writes nothing and would
    // make the budget look better than it is (a failed subject is a failure).
    const ok2xx = async (r, what) => {
      if (r.status < 200 || r.status > 299) {
        let body = ''; try { body = (await r.text()).slice(0, 200); } catch {}
        throw new Error(`${what}: ${r.status} ${body}`);
      }
      return r.status;
    };
    const get = (tok, path, headers = {}) => fetch(`${baseUrl}${path}`, { headers: { ...auth(tok), ...headers } }).then((r) => ok2xx(r, `GET ${path}`));
    const post = (tok, path, body = {}) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: auth(tok), body: J(body) }).then((r) => ok2xx(r, `POST ${path}`));
    const call = async (tok, method, path, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers: auth(tok), ...(body !== undefined ? { body: J(body) } : {}) });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, json: j };
    };

    let deviceHeader = null;
    const ws = [];
    const connectWs = (token, kiosk = false) => new Promise((resolve, reject) => {
      const s = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
      s.onopen = () => { if (kiosk && deviceHeader) s.send(J({ type: 'KIOSK_DEVICE', credential: deviceHeader })); };
      s.onmessage = (ev) => {
        let m = null; try { m = JSON.parse(String(ev.data)); } catch {}
        if (m && m.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(s); }
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
      ws.push(s);
    });
    const appOpenGets = (tok, venueId, admin) => Promise.all([
      get(tok, '/api/auth/me'), get(tok, '/api/agencies/current'), post(tok, '/api/push/status', { endpoint: 'https://push.example/t103' }),
      get(tok, `/api/updates/unread?venueId=${venueId}`), get(tok, '/api/announcements'),
      get(tok, `/api/handoff-notes?venueId=${venueId}`), get(tok, `/api/incidents?venueId=${venueId}`),
      get(tok, '/api/updates/alert-mute'), get(tok, '/api/shifts?venueId=' + venueId),
      ...(admin ? [get(tok, `/api/updates/receipts?venueId=${venueId}`)] : []),
    ]);

    try {
      // Production Firestore answers map keys sorted (the emulator and the mock keep insertion order):
      // every commit below reads the state document the way production does.
      const ko = await ctx.api('POST', '/api/__test__/prod-key-order', { on: true });
      if (ko.status !== 200 || ko.json?.on !== true) throw new Error(`prod-key-order: ${ko.status}`);
      // ---- P: read endpoints write nothing ----
      await get(T.don, '/api/auth/me');
      for (const [label, fn] of [
        ['GET /api/auth/me', () => get(T.don, '/api/auth/me')],
        ['GET /api/agencies/current', () => get(T.don, '/api/agencies/current')],
        ['GET /api/announcements', () => get(T.don, '/api/announcements')],
        ['GET /api/updates/unread', () => get(T.don, `/api/updates/unread?venueId=${V[0]}`)],
        ['GET /api/handoff-notes', () => get(T.don, `/api/handoff-notes?venueId=${V[0]}`)],
        ['GET /api/handoff-notes/seen', () => get(T.don, `/api/handoff-notes/seen?venueId=${V[0]}`)],
        ['GET /api/updates/receipts', () => get(T.don, `/api/updates/receipts?venueId=${V[0]}`)],
        ['GET /api/updates/alert-mute', () => get(T.don, '/api/updates/alert-mute')],
        ['GET /api/passkeys', () => get(T.don, '/api/passkeys')],
        ['GET /api/shifts', () => get(T.don, `/api/shifts?venueId=${V[0]}`)],
        ['POST /api/push/status', () => post(T.don, '/api/push/status', { endpoint: 'https://push.example/t103' })],
        ['GET /api/health', () => fetch(`${baseUrl}/api/health`).then((r) => ok2xx(r, 'GET /api/health'))],
      ]) await measure(`P ${label}`, async () => { await fn(); });

      // ---- L: a password sign-in ----
      const pw = await ctx.api('POST', '/api/__test__/set-password', { userId: uid('coord1'), password: 't103-sign-in-pw' });
      if (pw.status !== 200) throw new Error(`L set-password: ${pw.status}`);
      let loginCookie = '';
      await measure('L password sign-in', async () => {
        const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ email: email('coord1'), password: 't103-sign-in-pw' }) });
        const j = await r.json().catch(() => ({}));
        if (r.status !== 200 || !j.token) throw new Error(`L login: ${r.status} ${J(j)}`);
      });
      // The QR tablet list is a cookie-session read: a phone signed in with its password,
      // cookie opt-in + its own Origin (not measured; the sign-in above is).
      {
        const origin = new URL(baseUrl).origin;
        const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Shutfey-Auth': 'cookie' }, body: J({ email: email('coord1'), password: 't103-sign-in-pw' }) });
        if (r.status !== 200) throw new Error(`cookie login: ${r.status}`);
        loginCookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => c.startsWith('shutfey_s=')).join('; ');
        if (!loginCookie) throw new Error('cookie login: no session cookie');
      }
      await measure('P GET /api/kiosk/qr/tablets', async () => {
        const r = await fetch(`${baseUrl}/api/kiosk/qr/tablets`, { headers: { Cookie: loginCookie, Origin: new URL(baseUrl).origin, 'X-Shutfey-Auth': 'cookie' } });
        await ok2xx(r, 'GET /api/kiosk/qr/tablets');
      });

      // ---- A / B ----
      await measure('A app open (admin, socket + GETs)', async () => { await connectWs(T.don); await appOpenGets(T.don, V[0], true); });
      await measure('A app open (mashgiach, socket + GETs)', async () => { await connectWs(T.m1); await appOpenGets(T.m1, V[0], false); });
      await sleep(16_000);
      await measure('B revisit GETs after 16 s (mashgiach)', async () => { await appOpenGets(T.m1, V[0], false); });

      // ---- C: saves ----
      for (const n of ['m2', 'm3', 'coord1']) await connectWs(T[n]);
      await measure('C task save', async () => {
        const ver = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/tasks/${tasks[0].id}`, { method: 'PUT', headers: auth(T.don), body: J({ title: 'T103 task 0 edited', expectedVersion: ver }) });
        if (r.status !== 200) throw new Error(`C task save: ${r.status} ${await r.text()}`);
      });
      await measure('C shift note + 5 phone refreshes', async () => {
        const r = await fetch(`${baseUrl}/api/handoff-notes`, { method: 'POST', headers: auth(T.m1), body: J({ venueId: V[0], content: 'T103 delivery came', shift: 'Morning' }) });
        if (r.status !== 200) throw new Error(`C note: ${r.status} ${await r.text()}`);
        await sleep(450);
        await Promise.all(['don', 'm1', 'm2', 'coord1', 'owner1'].map((n) => get(T[n], `/api/updates/unread?venueId=${V[0]}`)));
      });
      await measure('C check-in (mashgiach)', async () => {
        const r = await call(T.m1, 'POST', `/api/tasks/${tasks[3].id}/check-in`, {});
        if (r.status !== 200 && r.status !== 201) throw new Error(`C check-in: ${r.status} ${J(r.json)}`);
      });

      // ---- H: an editor's shift + task work ----
      let shiftId = null;
      await measure('H create shift', async () => {
        const r = await call(T.don, 'POST', '/api/shifts', { venueId: V[0], name: 'Deli day', area: 'Deli', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startMinutes: 480, endMinutes: 1080, userId: uid('m1') });
        if (r.status !== 201) throw new Error(`H shift: ${r.status} ${J(r.json)}`);
        shiftId = r.json.id;
      });
      await measure('H edit shift', async () => {
        const r = await call(T.don, 'PUT', `/api/shifts/${shiftId}`, { name: 'Deli day 2', endMinutes: 1020 });
        if (r.status !== 200) throw new Error(`H shift edit: ${r.status} ${J(r.json)}`);
      });
      let shiftTask = null;
      await measure('H create shift task', async () => {
        const r = await call(T.don, 'POST', '/api/tasks', { venueId: V[0], title: 'T103 shift task', shiftId, assignedTo: ['all'], enableOverdueAlert: true });
        if (r.status !== 200 && r.status !== 201) throw new Error(`H shift task: ${r.status} ${J(r.json)}`);
        shiftTask = r.json?.id || r.json?.task?.id || null;
      });
      await measure('H 3 task edits', async () => {
        for (const i of [6, 9, 12]) {
          const ver = await ctx.getVersion();
          const r = await call(T.don, 'PUT', `/api/tasks/${tasks[i].id}`, { title: `T103 task ${i} edited`, expectedVersion: ver });
          if (r.status !== 200) throw new Error(`H edit ${i}: ${r.status} ${J(r.json)}`);
        }
      });

      // ---- D: kiosk ----
      {
        const v0 = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/users/${uid('m2')}?expectedVersion=${v0}`, { method: 'PUT', headers: auth(T.don), body: J({ kioskPin: '9713', expectedVersion: v0 }) });
        if (r.status !== 200) throw new Error(`D set PIN: ${r.status}`);
        // Earlier suite tests pair many tablets from this IP: start from clean pairing limits.
        const cl = await call(T.don, 'POST', '/api/__test__/kiosk-clear-lockouts', {});
        if (cl.status !== 200) throw new Error(`D clear lockouts: ${cl.status} ${J(cl.json)}`);
        const str = await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const s = await str.json().catch(() => null);
        if (str.status !== 200 || !s?.code) throw new Error(`D pairing start: ${str.status} ${J(s)}`);
        const pair = await call(T.don, 'POST', '/api/kiosk/devices/pair', { code: s.code, venueId: V[0] });
        if (pair.status !== 201) throw new Error(`D pair: ${pair.status} ${J(pair.json)}`);
        const sbr = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${s.pairingId}.${s.deviceSecret}` } });
        if (sbr.status !== 200) throw new Error(`D pairing status: ${sbr.status}`);
        const sb = await sbr.json();
        if (!sb?.device?.id) throw new Error(`D pairing status: no device ${J(sb)}`);
        deviceHeader = `${sb.device.id}.${s.deviceSecret}`;
      }
      let kTok = null;
      await measure('D kiosk PIN login', async () => {
        const kl = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader }, body: J({ userId: uid('m2'), pin: '9713' }) });
        if (kl.status !== 200) throw new Error(`D kiosk login: ${kl.status}`);
        kTok = (await kl.json()).token;
      });
      await connectWs(kTok, true);
      await sleep(16_000);
      await measure('D kiosk poll (after 16 s)', async () => {
        const st = await get(kTok, `/api/handoff-notes?venueId=${V[0]}`, { 'X-Kiosk-Device': deviceHeader });
        if (st !== 200) throw new Error(`D kiosk poll: ${st}`);
      });

      // ---- E: idle sockets (and whatever background timers run) ----
      for (const n of ['m4', 'm5']) await connectWs(T[n]);
      const idleMs = 65_000;
      const idle = await measure('E idle 65 s (6 phone + 1 kiosk sockets)', () => sleep(idleMs));
      const perSocketHour = idle / 7 * (3_600_000 / idleMs);

      // ---- G ----
      await measure('G task save + fan-out to 7 idle sockets', async () => {
        const ver2 = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/tasks/${tasks[15].id}`, { method: 'PUT', headers: auth(T.don), body: J({ title: 'T103 task 15 edited', expectedVersion: ver2 }) });
        if (r.status !== 200) throw new Error(`G task save: ${r.status} ${await r.text()}`);
        await sleep(1500);
      });
      await measure('S seen-by counts x4 viewers', async () => {
        await Promise.all(['don', 'm1', 'm2', 'coord1'].map((n) => get(T[n], `/api/handoff-notes/seen?venueId=${V[0]}`)));
      });
      await measure('R 5 phone sockets reconnect', async () => {
        for (const n of ['don', 'm1', 'm2', 'm3', 'coord1']) await connectWs(T[n]);
      });

      // ---- O: the overdue checker for one simulated hour + rollover ticks ----
      await measure('O overdue checker x4 + rollover tick x5', async () => {
        for (let i = 0; i < 4; i++) { const r = await ctx.api('POST', '/api/__test__/overdue-check', {}); if (r.status !== 200) throw new Error(`O overdue: ${r.status}`); }
        for (let i = 0; i < 5; i++) { const r = await ctx.api('POST', '/api/__test__/rollover-tick', {}); if (r.status !== 200) throw new Error(`O tick: ${r.status} ${J(r.json)}`); }
      });

      // ---- Q: QR tablet idle on its sign-in screen ----
      for (const s of ws) { try { s.close(); } catch {} }
      const qr = (path) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader }, body: '{}' });
      const st = await qr('/api/kiosk/qr/start');
      if (st.status !== 200) throw new Error(`Q start: ${st.status} ${await st.text()}`);
      const qrMs = 65_000;
      const qrWrites = await measure('Q QR screen 65 s (poll every 2 s)', async () => {
        for (let t0 = Date.now(); Date.now() - t0 < qrMs;) {
          const r = await qr('/api/kiosk/qr/poll');
          if (r.status !== 200) throw new Error(`Q poll: ${r.status} ${await r.text()}`);
          await sleep(2000);
        }
      });
      const qrPerHour = qrWrites * (3_600_000 / qrMs);

      // ---- F: the day ----
      const c = costs;
      const qrDay = Math.round(DAY.qrScreenHours * qrPerHour);
      const day = Math.round(
        DAY.logins * c['L password sign-in'] +
        DAY.appOpens * (c['A app open (admin, socket + GETs)'] + c['A app open (mashgiach, socket + GETs)']) / 2 +
        DAY.revisits * c['B revisit GETs after 16 s (mashgiach)'] / 9 * 3 +
        DAY.taskSaves * (c['C task save'] + c['C check-in (mashgiach)']) / 2 +
        DAY.notes * c['C shift note + 5 phone refreshes'] +
        DAY.shiftEdits * (c['H create shift'] + c['H edit shift'] + c['H create shift task'] + c['H 3 task edits'] / 3) / 4 +
        DAY.kioskLogins * c['D kiosk PIN login'] +
        DAY.kioskPolls * c['D kiosk poll (after 16 s)'] +
        (DAY.phoneSocketHours + DAY.kioskSocketHours) * perSocketHour +
        DAY.taskSaves * Math.max(0, c['G task save + fan-out to 7 idle sockets'] - c['C task save']) +
        DAY.seenOpens * c['S seen-by counts x4 viewers'] / 4 +
        DAY.reconnects * c['R 5 phone sockets reconnect'] / 5 +
        DAY.overdueHours * c['O overdue checker x4 + rollover tick x5'],
      );
      console.log(`[writes] QR screen per hour: ${qrPerHour.toFixed(0)}`);
      console.log(`[writes] idle per socket-hour: ${perSocketHour.toFixed(1)}`);
      console.log(`[writes] scripted HKC day: ${day} writes without QR tablets (budget ${DAY_BUDGET}); + ${qrDay} for ${DAY.qrScreenHours} QR tablet-hours = ${day + qrDay} (budget ${DAY_WITH_QR_BUDGET}; free quota 20000)`);
      const readPathWrites = Object.entries(costs).filter(([k, v]) => k.startsWith('P GET') && v > 0);
      if (readPathWrites.length) throw new Error(`read paths wrote: ${J(readPathWrites)}`);
      const bigSaves = Object.entries(costs).filter(([k, v]) => /^(C|H|G)\b/.test(k) && !/3 task edits/.test(k) && v > SAVE_MAX);
      if (c['H 3 task edits'] > 3 * SAVE_MAX) bigSaves.push(['H 3 task edits', c['H 3 task edits']]);
      if (bigSaves.length) throw new Error(`a save wrote more than ${SAVE_MAX} documents (every user row re-written?): ${J(bigSaves)} ${J(Object.fromEntries(bigSaves.map(([k]) => [k, detail[k]])))}`);
      if (day > DAY_BUDGET) throw new Error(`scripted day costs ${day} writes > budget ${DAY_BUDGET} (${J(costs)}, idle/socket-hour ${perSocketHour.toFixed(1)})`);
      if (day + qrDay > DAY_WITH_QR_BUDGET) throw new Error(`scripted day with QR tablets costs ${day + qrDay} writes > budget ${DAY_WITH_QR_BUDGET} (QR ${qrPerHour.toFixed(0)}/tablet-hour)`);
      return `scripted HKC day ${day} writes <= ${DAY_BUDGET}; with ${DAY.qrScreenHours} QR tablet-hours ${day + qrDay} <= ${DAY_WITH_QR_BUDGET} (${J(costs)}, idle/socket-hour ${perSocketHour.toFixed(1)}, QR/tablet-hour ${qrPerHour.toFixed(0)})`;
    } finally {
      for (const s of ws) { try { s.close(); } catch {} }
      await ctx.api('POST', '/api/__test__/prod-key-order', { on: false }).catch(() => {});
    }
  },
};
