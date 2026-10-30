/**
 * Test 97: Database read budget (READCUT, Oct 29 2026).
 *
 * The live app ran out of Google's free daily read quota (50,000 reads/day)
 * at ~8:45 PM and every save and sign-in check failed. This test measures,
 * with the server's own read meter (src/server/read-meter.ts), what each
 * thing a real day does costs in database reads, then adds up one scripted
 * HKC-sized day (3 venues, 28 tasks, 10 staff, phones + 3 kiosks) and fails
 * when that day exceeds DAY_BUDGET (a fifth of the free quota).
 *
 *  A  a phone opening the app (the GETs the client sends + its socket)
 *  B  the same GETs again 16 s later (past the 15 s session cache)
 *  C  a task save; a shift note save with 5 phones connected (+ each phone's
 *     unread refresh, as the client does on the note's socket message)
 *  D  a kiosk's once-a-minute private-note poll
 *  E  idle: 6 phone sockets + 1 kiosk socket for 65 s
 *  G  a task save fanned out to those idle sockets 16 s later (each socket's
 *     session is re-checked before it gets the update)
 *  S  Shift notes "Seen by" counts opened by 4 team members
 *  R  5 phone sockets reconnecting (a phone back from the background)
 *  Q  a QR tablet left on its sign-in screen: 65 s of polls every 2 s (one code rotation)
 *  P  each endpoint seen in the live request log, measured on its own
 *  F  the day: counts below x the measured costs <= DAY_BUDGET
 * Every session here is a real server session (sid), like production phones.
 */

const DAY_BUDGET = 10_000;
const DAY = {
  appOpens: 80,          // 10 staff opening the app ~8 times a day
  revisits: 400,         // GET bursts after the 15 s cache (tab switches, sheet opens)
  taskSaves: 250,        // check-ins / task edits
  notes: 40,             // shift notes, each fanned out to ~5 phones
  kioskPolls: 3 * 12 * 60, // 3 kiosks, 12 h, once a minute
  phoneSocketHours: 6 * 10, // 6 phones x ~10 h of open socket
  kioskSocketHours: 3 * 12,
  qrScreenHours: 3 * 12,   // 3 tablets on the QR sign-in screen 12 h a day
  seenOpens: 200,          // Shift notes opened (Seen-by counts) by someone
  reconnects: 300,         // phone sockets reconnecting (back from the background)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

export default {
  name: 'Test 97: Database read budget for one HKC-sized day',
  whatItProves:
    'Measured with the server read meter: an app open, repeat GETs, a task save, a shift note fanned out to phones, a kiosk poll and an idle hour of phone + kiosk sockets cost few enough database reads that a scripted HKC-sized day stays under a fifth of the 50,000/day free quota.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t97-${ts}`;
    const V = [1, 2, 3].map((n) => `venue-t97-${n}-${ts}`);
    const uid = (n) => `user-t97-${n}-${ts}`;
    const people = [
      ['don', 'admin', V[0]], ['coord1', 'coordinator', V[0]], ['coord2', 'coordinator', V[1]],
      ['m1', 'mashgiach', V[0]], ['m2', 'mashgiach', V[0]], ['m3', 'mashgiach', V[1]], ['m4', 'mashgiach', V[1]],
      ['m5', 'mashgiach', V[2]], ['m6', 'mashgiach', V[2]], ['owner1', 'owner', V[0]],
    ];
    const tasks = [];
    for (let i = 0; i < 28; i++) tasks.push({ id: `task-t97-${i}-${ts}`, title: `T97 task ${i}`, venueId: V[i % 3], agencyId: AG, status: 'pending', assignedTo: [] });
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'T97 Agency' }],
      venues: V.map((id, i) => ({ id, name: `T97 V${i + 1} ${ts}`, agencyId: AG })),
      users: people.map(([n, role, venueId]) => ({ id: uid(n), email: `${n}-t97-${ts}@test.local`, name: `T97 ${n}`, role, agencyId: AG, venueId })),
      tasks,
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);

    const T = {};
    for (const [n] of people) {
      const r = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ userId: uid(n), session: true }) });
      if (r.status !== 200) throw new Error(`session token ${n}: ${r.status}`);
      T[n] = (await r.json()).token;
    }
    const reads = async (reset = false) => (await ctx.api('POST', '/api/__test__/reads', reset ? { reset: true } : {})).json;
    const costs = {};
    const measure = async (label, fn) => {
      await sleep(250);
      const a = await reads();
      await fn();
      await sleep(400);
      const b = await reads();
      const by = {};
      for (const [k, v] of Object.entries(b.byCollection)) { const d = v - (a.byCollection[k] || 0); if (d) by[k] = d; }
      costs[label] = b.total - a.total;
      console.log(`[reads] ${label}: ${costs[label]} ${J(by)}`);
      return costs[label];
    };
    const get = (tok, path, headers = {}) => fetch(`${baseUrl}${path}`, { headers: { ...auth(tok), ...headers } }).then((r) => r.status);

    let deviceHeader = null;
    const ws = [];
    const connectWs = (token, kiosk = false) => new Promise((resolve, reject) => {
      const s = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
      s.onopen = () => {
        if (kiosk && deviceHeader) s.send(J({ type: 'KIOSK_DEVICE', credential: deviceHeader }));
      };
      s.onmessage = (ev) => {
        let m = null; try { m = JSON.parse(String(ev.data)); } catch {}
        if (m && m.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(s); }
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
      ws.push(s);
    });
    const post = (tok, path, body = {}) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: auth(tok), body: J(body) }).then((r) => r.status);
    const appOpenGets = (tok, venueId, admin) => Promise.all([
      get(tok, '/api/auth/me'), get(tok, '/api/agencies/current'), post(tok, '/api/push/status', { endpoint: 'https://push.example/t97' }),
      get(tok, `/api/updates/unread?venueId=${venueId}`), get(tok, '/api/announcements'),
      get(tok, `/api/handoff-notes?venueId=${venueId}`), get(tok, `/api/incidents?venueId=${venueId}`),
      get(tok, '/api/updates/alert-mute'),
      ...(admin ? [get(tok, `/api/updates/receipts?venueId=${venueId}`)] : []),
    ]);

    try {
      // ---- P: each endpoint the live log showed, on its own (session warm) ----
      await get(T.don, '/api/auth/me');
      for (const [label, fn] of [
        ['GET /api/auth/me', () => get(T.don, '/api/auth/me')],
        ['GET /api/announcements', () => get(T.don, '/api/announcements')],
        [`GET /api/updates/unread`, () => get(T.don, `/api/updates/unread?venueId=${V[0]}`)],
        ['GET /api/handoff-notes', () => get(T.don, `/api/handoff-notes?venueId=${V[0]}`)],
        ['GET /api/handoff-notes/seen', () => get(T.don, `/api/handoff-notes/seen?venueId=${V[0]}`)],
        ['GET /api/updates/receipts', () => get(T.don, `/api/updates/receipts?venueId=${V[0]}`)],
        ['GET /api/updates/alert-mute', () => get(T.don, '/api/updates/alert-mute')],
        ['GET /api/passkeys', () => get(T.don, '/api/passkeys')],
        ['GET /api/kiosk/qr/tablets', () => get(T.don, '/api/kiosk/qr/tablets')],
        ['POST /api/push/status', () => post(T.don, '/api/push/status', { endpoint: 'https://push.example/t97' })],
        ['GET /api/health', () => fetch(`${baseUrl}/api/health`).then((r) => r.status)],
      ]) await measure(`P ${label}`, async () => { await fn(); });

      // ---- A: app open (admin + mashgiach) ----
      await measure('A app open (admin, socket + GETs)', async () => { await connectWs(T.don); await appOpenGets(T.don, V[0], true); });
      await measure('A app open (mashgiach, socket + GETs)', async () => { await connectWs(T.m1); await appOpenGets(T.m1, V[0], false); });

      // ---- B: the same GETs past the 15 s session cache ----
      await sleep(16_000);
      await measure('B revisit GETs after 16 s (mashgiach)', async () => { await appOpenGets(T.m1, V[0], false); });

      // ---- C: saves ----
      for (const n of ['m2', 'm3', 'coord1']) await connectWs(T[n]);
      const ver = await ctx.getVersion();
      await measure('C task save', async () => {
        const r = await fetch(`${baseUrl}/api/tasks/${tasks[0].id}`, { method: 'PUT', headers: auth(T.don), body: J({ title: 'T97 task 0 edited', expectedVersion: ver }) });
        if (r.status !== 200) throw new Error(`C task save: ${r.status} ${await r.text()}`);
      });
      await measure('C shift note + 5 phone refreshes', async () => {
        const r = await fetch(`${baseUrl}/api/handoff-notes`, { method: 'POST', headers: auth(T.m1), body: J({ venueId: V[0], content: 'T97 delivery came', shift: 'Morning' }) });
        if (r.status !== 200) throw new Error(`C note: ${r.status} ${await r.text()}`);
        await sleep(450);
        await Promise.all(['don', 'm1', 'm2', 'coord1', 'owner1'].map((n) => get(T[n], `/api/updates/unread?venueId=${V[0]}`)));
      });

      // ---- D: kiosk ----
      {
        const v0 = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/users/${uid('m2')}?expectedVersion=${v0}`, { method: 'PUT', headers: auth(T.don), body: J({ kioskPin: '9711', expectedVersion: v0 }) });
        if (r.status !== 200) throw new Error(`D set PIN: ${r.status}`);
        const s = await (await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, { method: 'POST', headers: auth(T.don), body: J({ code: s.code, venueId: V[0] }) });
        if (pair.status !== 201) throw new Error(`D pair: ${pair.status}`);
        const sb = await (await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${s.pairingId}.${s.deviceSecret}` } })).json();
        deviceHeader = `${sb.device.id}.${s.deviceSecret}`;
      }
      const kl = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader }, body: J({ userId: uid('m2'), pin: '9711' }) });
      if (kl.status !== 200) throw new Error(`D kiosk login: ${kl.status}`);
      const kTok = (await kl.json()).token;
      await connectWs(kTok, true);
      await sleep(16_000);
      await measure('D kiosk poll (after 16 s)', async () => {
        const st = await get(kTok, `/api/handoff-notes?venueId=${V[0]}`, { 'X-Kiosk-Device': deviceHeader });
        if (st !== 200) throw new Error(`D kiosk poll: ${st}`);
      });

      // ---- E: idle sockets ----
      for (const n of ['m4', 'm5']) await connectWs(T[n]);
      const idleMs = 65_000;
      const idle = await measure('E idle 65 s (6 phone + 1 kiosk sockets)', () => sleep(idleMs));
      const phoneSockets = 6, kioskSockets = 1;
      const perSocketHour = idle / (phoneSockets + kioskSockets) * (3_600_000 / idleMs);

      // ---- G: a save fanned out to sockets idle for 16 s+ ----
      const ver2 = await ctx.getVersion();
      await measure('G task save + fan-out to 7 idle sockets', async () => {
        const r = await fetch(`${baseUrl}/api/tasks/${tasks[3].id}`, { method: 'PUT', headers: auth(T.don), body: J({ title: 'T97 task 3 edited', expectedVersion: ver2 }) });
        if (r.status !== 200) throw new Error(`G task save: ${r.status} ${await r.text()}`);
        await sleep(1500);
      });

      // ---- S: shift notes "Seen by" opened by 4 team members (after the 65 s idle) ----
      await measure('S seen-by counts x4 viewers', async () => {
        await Promise.all(['don', 'm1', 'm2', 'coord1'].map((n) => get(T[n], `/api/handoff-notes/seen?venueId=${V[0]}`)));
      });
      // ---- R: 5 phones reconnect their sockets (back from the background) ----
      await measure('R 5 phone sockets reconnect', async () => {
        for (const n of ['don', 'm1', 'm2', 'm3', 'coord1']) await connectWs(T[n]);
      });

      // ---- Q: a QR tablet idle on its sign-in screen ----
      // (the tablet's kiosk session ends first, as when nobody is signed in)
      for (const s of ws) { try { s.close(); } catch {} }
      const qr = (path) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader }, body: '{}' });
      const st = await qr('/api/kiosk/qr/start');
      if (st.status !== 200) throw new Error(`Q start: ${st.status} ${await st.text()}`);
      const qrMs = 65_000;
      const qrReads = await measure('Q QR screen 65 s (poll every 2 s)', async () => {
        for (let t0 = Date.now(); Date.now() - t0 < qrMs;) {
          const r = await qr('/api/kiosk/qr/poll');
          if (r.status !== 200) throw new Error(`Q poll: ${r.status} ${await r.text()}`);
          const b = await r.json();
          if (b.state !== 'waiting') throw new Error(`Q poll state ${b.state}`);
          await sleep(2000);
        }
      });
      const qrPerHour = qrReads * (3_600_000 / qrMs);

      // ---- F: the day ----
      const day = Math.round(
        DAY.appOpens * (costs['A app open (admin, socket + GETs)'] + costs['A app open (mashgiach, socket + GETs)']) / 2 +
        DAY.revisits * costs['B revisit GETs after 16 s (mashgiach)'] / 9 * 3 +
        DAY.taskSaves * costs['C task save'] +
        DAY.notes * costs['C shift note + 5 phone refreshes'] +
        DAY.kioskPolls * costs['D kiosk poll (after 16 s)'] +
        (DAY.phoneSocketHours + DAY.kioskSocketHours) * perSocketHour +
        DAY.taskSaves * Math.max(0, costs['G task save + fan-out to 7 idle sockets'] - costs['C task save']) +
        DAY.qrScreenHours * qrPerHour +
        DAY.seenOpens * costs['S seen-by counts x4 viewers'] / 4 +
        DAY.reconnects * costs['R 5 phone sockets reconnect'] / 5,
      );
      console.log(`[reads] QR screen per hour: ${qrPerHour.toFixed(0)}`);
      console.log(`[reads] idle per socket-hour: ${perSocketHour.toFixed(1)}`);
      console.log(`[reads] scripted HKC day: ${day} reads (budget ${DAY_BUDGET}; free quota 50000)`);
      if (day > DAY_BUDGET) throw new Error(`scripted day costs ${day} reads > budget ${DAY_BUDGET} (${J(costs)}, idle/socket-hour ${perSocketHour.toFixed(1)})`);
      return `scripted HKC day ${day} reads <= ${DAY_BUDGET} (${J(costs)}, idle/socket-hour ${perSocketHour.toFixed(1)})`;
    } finally {
      for (const s of ws) { try { s.close(); } catch {} }
    }
  },
};
