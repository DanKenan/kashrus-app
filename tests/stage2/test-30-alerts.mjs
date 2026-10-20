/**
 * Test 30: Alerts (item 5b) — raise, route, Open → Acknowledged → Resolved,
 * privacy of payloads, read marks, ✓✓ receipts, the receiver's mute, kiosk.
 *
 * Rule T (fail closed): admin = whole agency; coordinator = own venue(s) only;
 * everyone else = own venue and own records. Kiosk = no alerts at all (the
 * kiosk sheet is read-only; alert routes are off its allowlist).
 * Alerts rule (Don): every alert is delivered immediately, 24/7; the receiver
 * controls silence (a mute makes the push silent, never absent). No real push
 * is sent in tests: the routing decision is read from a test-only endpoint.
 *
 * Fixture: agency X (venues A1, A2), agency Y (venue B1).
 * Users: adminX, coordA1, coordA2, coordNo (no venue), mashA1 (reporter),
 * mashA1b (same venue), mashA2, adminY. One agency-wide announcement by adminX.
 *
 * Every positive check has its negative twin (rule G).
 */

const AX = 'agency-test30-x';
const AY = 'agency-test30-y';

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
let deviceHeader = null;
const authK = (t) => ({ ...auth(t), ...(deviceHeader ? { 'X-Kiosk-Device': deviceHeader } : {}) });

async function pairDevice(baseUrl, adminToken, venueId) {
  const s = await (await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code: s.code, venueId }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const sb = await (await fetch(`${baseUrl}/api/kiosk/pairing/status`, {
    headers: { 'X-Kiosk-Pairing': `${s.pairingId}.${s.deviceSecret}` },
  })).json();
  if (sb.status !== 'approved' || !sb.device) throw new Error('pairing not approved');
  return `${sb.device.id}.${s.deviceSecret}`;
}

async function kioskLogin(baseUrl, userId, pin) {
  const res = await fetch(`${baseUrl}/api/kiosk/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': deviceHeader },
    body: JSON.stringify({ userId, pin }),
  });
  if (res.status !== 200) throw new Error(`kiosk login ${userId}: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token, kiosk = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {
      if (kiosk && deviceHeader) ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: deviceHeader }));
    };
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve({ ws, messages }); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (list) => (list || []).map((x) => x.id);
function mustHave(list, id, label) { if (!ids(list).includes(id)) throw new Error(`${label}: expected ${id}`); }
function mustNot(list, id, label) { if (ids(list).includes(id)) throw new Error(`${label}: must NOT contain ${id}`); }
function eq(a, b, label) { if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
// No email address, no media bytes, no server-only fields in anything a client receives.
function clean(obj, label) {
  const j = JSON.stringify(obj);
  if (/@test\.local/.test(j)) throw new Error(`${label}: an email address leaked`);
  if (/data:(image|audio)\//.test(j)) throw new Error(`${label}: media bytes leaked`);
  if (/"(reporterEmail|resolvedBy|acknowledgedBy|photoData|voiceNoteData|readBy)"\s*:/.test(j)) {
    throw new Error(`${label}: a server-only field leaked`);
  }
}

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(400);
const VOICE = 'data:audio/webm;base64,' + 'B'.repeat(400);

export default {
  name: 'Test 30: Alerts — routing, lifecycle, privacy, read receipts, mute, kiosk',
  whatItProves:
    'An alert is raised only at the caller\'s own venue, routed exactly to the agency admins + that venue\'s coordinators (never the reporter), visible per rule T on REST and WebSocket with no emails or media bytes; only recipients acknowledge; marks drive unread counts; ✓✓ receipts are admin/coordinator-only and roster-scoped; a mute makes pushes silent, never absent; a retried request never raises a second alert; the kiosk gets no alerts.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A1 = `venue-t30-a1-${ts}`, A2 = `venue-t30-a2-${ts}`, B1 = `venue-t30-b1-${ts}`;
    const U = (n) => `user-t30-${n}-${ts}`;
    const E = (n) => `${n}-${ts}@test.local`;
    const adminX = U('adminx'), coordA1 = U('coorda1'), coordA2 = U('coorda2'), coordNo = U('coordno'),
      mashA1 = U('masha1'), mashA1b = U('masha1b'), mashA2 = U('masha2'), adminY = U('adminy');
    const annWide = `ann-t30-wide-${ts}`;
    const t0 = new Date(ts - 60000).toISOString();

    await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AX, name: 'T30 X' }, { id: AY, name: 'T30 Y' }],
      venues: [
        { id: A1, name: `T30 A1 ${ts}`, agencyId: AX },
        { id: A2, name: `T30 A2 ${ts}`, agencyId: AX },
        { id: B1, name: `T30 B1 ${ts}`, agencyId: AY },
      ],
      users: [
        { id: adminX, email: E('adminx'), name: 'T30 Admin X', role: 'admin', agencyId: AX, venueId: A1 },
        { id: coordA1, email: E('coorda1'), name: 'T30 Coord A1', role: 'coordinator', agencyId: AX, venueId: A1 },
        { id: coordA2, email: E('coorda2'), name: 'T30 Coord A2', role: 'coordinator', agencyId: AX, venueId: A2 },
        { id: coordNo, email: E('coordno'), name: 'T30 Coord none', role: 'coordinator', agencyId: AX },
        { id: mashA1, email: E('masha1'), name: 'T30 Mash A1', role: 'mashgiach', agencyId: AX, venueId: A1 },
        { id: mashA1b, email: E('masha1b'), name: 'T30 Mash A1b', role: 'mashgiach', agencyId: AX, venueId: A1 },
        { id: mashA2, email: E('masha2'), name: 'T30 Mash A2', role: 'mashgiach', agencyId: AX, venueId: A2 },
        { id: adminY, email: E('adminy'), name: 'T30 Admin Y', role: 'admin', agencyId: AY },
      ],
      announcements: [
        { id: annWide, agencyId: AX, authorEmail: E('adminx'), authorName: 'T30 Admin X', title: 'Wide', body: 'b', category: 'update', targetRoles: ['all'], createdAt: t0 },
      ],
    });
    const T = {};
    for (const id of [adminX, coordA1, coordA2, coordNo, mashA1, mashA1b, mashA2, adminY]) T[id] = await mintToken(baseUrl, id);

    const post = async (tok, path, body, k = false) => {
      const ver = await ctx.getVersion();
      const r = await fetch(`${baseUrl}${path}?expectedVersion=${ver}`, {
        method: 'POST', headers: k ? authK(tok) : auth(tok),
        body: JSON.stringify({ expectedVersion: ver, operationId: `op-${Math.random()}`, ...body }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const get = async (tok, path, k = false) => {
      const r = await fetch(`${baseUrl}${path}`, { headers: k ? authK(tok) : auth(tok) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const put = async (tok, path, body, k = false) => {
      const r = await fetch(`${baseUrl}${path}`, { method: 'PUT', headers: k ? authK(tok) : auth(tok), body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const routing = async (id) => (await (await fetch(`${baseUrl}/api/__test__/alert-routing?id=${encodeURIComponent(id)}`)).json()).routing;
    const raise = (tok, body) => post(tok, '/api/incidents', { severity: 'high', ...body });
    const list = async (tok, qs = '') => {
      const r = await get(tok, `/api/incidents${qs}`);
      clean(r.body, `GET /api/incidents${qs}`);
      return { status: r.status, list: r.body.incidents || [] };
    };

    // ---- T1: raise at own venue only; exact routing; payload clean ----
    let alertA1, alertA2;
    {
      const r = await raise(T[mashA1], { venueId: A1, title: `Walk-in at 45F ${ts}`, description: 'dairy moved', photoData: PHOTO, voiceNoteData: VOICE, clientRef: `ref-a1-${ts}` });
      eq(r.status, 200, 'T1 mashA1 raises at A1');
      clean(r.body, 'T1 POST response');
      alertA1 = r.body.incident?.id;
      if (!alertA1) throw new Error('T1 no alert id');
      eq(r.body.incident.hasPhoto, true, 'T1 hasPhoto'); eq(r.body.incident.hasVoice, true, 'T1 hasVoice');
      eq(r.body.incident.mine, true, 'T1 mine'); eq(r.body.incident.status, 'open', 'T1 status');
      const other = await raise(T[mashA1], { venueId: A2, title: `wrong venue ${ts}` });
      eq(other.status, 403, 'T1 mashA1 raises at A2 (not own venue)');
      const cross = await raise(T[adminY], { venueId: A1, title: `cross agency ${ts}` });
      if (cross.status !== 403 && cross.status !== 404) throw new Error(`T1 adminY raises in agency X: ${cross.status}`);
      const route = (await routing(alertA1)) || [];
      const emails = route.map((x) => x.email).sort();
      eq(JSON.stringify(emails), JSON.stringify([E('adminx'), E('coorda1')].sort()), 'T1 routing = admin X + coordinator A1');
      for (const bad of ['coorda2', 'coordno', 'masha1', 'masha1b', 'masha2', 'adminy']) {
        if (emails.includes(E(bad))) throw new Error(`T1 routing must NOT include ${bad}`);
      }
      // Coordinator raises at own venue: the reporter is never notified of their own alert.
      const c = await raise(T[coordA1], { venueId: A1, title: `coord raised ${ts}` });
      eq(c.status, 200, 'T1 coordA1 raises at A1');
      const cr = ((await routing(c.body.incident.id)) || []).map((x) => x.email);
      eq(JSON.stringify(cr), JSON.stringify([E('adminx')]), 'T1 reporter excluded from routing');
      const a2 = await raise(T[mashA2], { venueId: A2, title: `A2 alert ${ts}` });
      eq(a2.status, 200, 'T1 mashA2 raises at A2');
      alertA2 = a2.body.incident.id;
      const r2 = ((await routing(alertA2)) || []).map((x) => x.email).sort();
      eq(JSON.stringify(r2), JSON.stringify([E('adminx'), E('coorda2')].sort()), 'T1 A2 routing');
    }

    // ---- T2: a retried request never raises a second alert; bad input refused, never truncated ----
    {
      const again = await raise(T[mashA1], { venueId: A1, title: `Walk-in at 45F ${ts}`, clientRef: `ref-a1-${ts}` });
      eq(again.status, 200, 'T2 replay status'); eq(again.body.incident?.id, alertA1, 'T2 replay returns the same alert');
      eq(again.body.replayed, true, 'T2 replay flagged');
      const all = await list(T[adminX], `?venueId=${A1}`);
      eq(all.list.filter((i) => i.id === alertA1).length, 1, 'T2 exactly one alert after replay');
      // Another user's identical clientRef is a different alert (the ref is scoped to the user).
      const b = await raise(T[mashA1b], { venueId: A1, title: `same ref other user ${ts}`, clientRef: `ref-a1-${ts}` });
      eq(b.status, 200, 'T2 other user same ref'); if (b.body.incident.id === alertA1) throw new Error('T2 clientRef crossed users');
      const big = await raise(T[mashA1], { venueId: A1, title: `big ${ts}`, photoData: 'data:image/jpeg;base64,' + 'C'.repeat(300001) });
      eq(big.status, 413, 'T2 oversized photo refused');
      const bad = await raise(T[mashA1], { venueId: A1, title: `bad ${ts}`, photoData: 'javascript:alert(1)' });
      eq(bad.status, 400, 'T2 non-image photo refused');
      const long = await raise(T[mashA1], { venueId: A1, title: 'x'.repeat(141) });
      eq(long.status, 400, 'T2 title over 140 refused');
      const noTitle = await raise(T[mashA1], { venueId: A1, title: '   ' });
      eq(noTitle.status, 400, 'T2 empty title refused');
      const badRef = await raise(T[mashA1], { venueId: A1, title: `badref ${ts}`, clientRef: '../../x' });
      eq(badRef.status, 400, 'T2 malformed clientRef refused');
    }

    // ---- T3: who sees which alerts (REST) + media on demand ----
    {
      const ad = await list(T[adminX]); mustHave(ad.list, alertA1, 'T3 adminX'); mustHave(ad.list, alertA2, 'T3 adminX A2');
      const c1 = await list(T[coordA1]); mustHave(c1.list, alertA1, 'T3 coordA1'); mustNot(c1.list, alertA2, 'T3 coordA1 other venue');
      const c1x = await list(T[coordA1], `?venueId=${A2}`); eq(c1x.status, 403, 'T3 coordA1 asks for A2');
      const cn = await list(T[coordNo]); mustNot(cn.list, alertA1, 'T3 coordNo (no venue) sees nothing'); mustNot(cn.list, alertA2, 'T3 coordNo A2');
      const m1b = await list(T[mashA1b]); mustHave(m1b.list, alertA1, 'T3 mashA1b same venue');
      eq(m1b.list.find((i) => i.id === alertA1).mine, false, 'T3 mine=false for a colleague');
      const m2 = await list(T[mashA2]); mustNot(m2.list, alertA1, 'T3 mashA2 other venue'); mustHave(m2.list, alertA2, 'T3 mashA2 own');
      const y = await list(T[adminY]); mustNot(y.list, alertA1, 'T3 adminY other agency'); mustNot(y.list, alertA2, 'T3 adminY other agency A2');
      const med = await get(T[mashA1b], `/api/incidents/${alertA1}/media`);
      eq(med.status, 200, 'T3 media for same venue'); eq(med.body.photoData, PHOTO, 'T3 photo intact (never truncated)');
      eq(med.body.voiceNoteData, VOICE, 'T3 voice intact');
      eq((await get(T[mashA2], `/api/incidents/${alertA1}/media`)).status, 404, 'T3 media other venue → 404');
      eq((await get(T[adminY], `/api/incidents/${alertA1}/media`)).status, 404, 'T3 media other agency → 404');
      eq((await get(T[coordA2], `/api/incidents/${alertA1}/media`)).status, 404, 'T3 media other venue coordinator → 404');
      eq((await get(T[mashA1b], `/api/incidents/incident-nope-${ts}/media`)).status, 404, 'T3 unknown → same 404');
    }

    // ---- T4: WebSocket — signal only, rule T audience ----
    {
      const socks = {};
      for (const u of [adminX, coordA1, coordA2, mashA1b, mashA2, adminY]) socks[u] = await connectWs(baseUrl, T[u]);
      const r = await raise(T[mashA1], { venueId: A1, title: `ws alert ${ts}` });
      eq(r.status, 200, 'T4 raise');
      const id = r.body.incident.id;
      await sleep(700);
      const got = (u) => socks[u].messages.filter((m) => m.type === 'INCIDENT_CREATED' && (m.payload?.incident?.id === id));
      for (const u of [adminX, coordA1, mashA1b]) {
        if (got(u).length !== 1) throw new Error(`T4 ${u} expected exactly one INCIDENT_CREATED`);
        const keys = Object.keys(got(u)[0].payload.incident).sort().join(',');
        eq(keys, 'agencyId,id,status,venueId', `T4 ${u} payload is a signal only`);
      }
      for (const u of [coordA2, mashA2, adminY]) {
        if (got(u).length !== 0) throw new Error(`T4 ${u} must NOT receive the A1 alert`);
      }
      for (const u of Object.keys(socks)) clean(socks[u].messages.filter((m) => /^INCIDENT_/.test(m.type)), `T4 ${u} WS`);
      Object.values(socks).forEach((c) => c.ws.close());
    }

    // ---- T5: lifecycle — only recipients acknowledge; who/when recorded as names ----
    {
      eq((await post(T[mashA1b], `/api/incidents/${alertA1}/acknowledge`, {})).status, 403, 'T5 mashgiach cannot acknowledge');
      eq((await post(T[mashA1], `/api/incidents/${alertA1}/acknowledge`, {})).status, 403, 'T5 reporter cannot acknowledge own alert');
      eq((await post(T[coordA2], `/api/incidents/${alertA1}/acknowledge`, {})).status, 403, 'T5 other venue coordinator');
      eq((await post(T[adminY], `/api/incidents/${alertA1}/acknowledge`, {})).status, 403, 'T5 other agency admin');
      const ack = await post(T[coordA1], `/api/incidents/${alertA1}/acknowledge`, {});
      eq(ack.status, 200, 'T5 coordA1 acknowledges'); clean(ack.body, 'T5 ack response');
      eq(ack.body.incident?.status, 'acknowledged', 'T5 status'); eq(ack.body.incident?.acknowledgedByName, 'T30 Coord A1', 'T5 ack name');
      const again = await post(T[adminX], `/api/incidents/${alertA1}/acknowledge`, {});
      eq(again.status, 200, 'T5 second ack idempotent'); eq(again.body.incident?.acknowledgedByName, 'T30 Coord A1', 'T5 first acknowledger kept');
      eq((await post(T[mashA2], `/api/incidents/${alertA1}/resolve`, {})).status, 403, 'T5 other venue mashgiach cannot resolve');
      const res = await post(T[mashA1b], `/api/incidents/${alertA1}/resolve`, {});
      eq(res.status, 200, 'T5 on-site mashgiach resolves'); clean(res.body, 'T5 resolve response');
      eq(res.body.incident?.status, 'resolved', 'T5 resolved'); eq(res.body.incident?.resolvedByName, 'T30 Mash A1b', 'T5 resolver name');
    }

    // ---- T6: read marks + unread counts ----
    let alertA1c;
    {
      const r = await raise(T[mashA1], { venueId: A1, title: `unread test ${ts}` });
      alertA1c = r.body.incident.id;
      const u0 = await get(T[coordA1], `/api/updates/unread?venueId=${A1}`);
      eq(u0.status, 200, 'T6 unread'); if (!(u0.body.unreadAlertIds || []).includes(alertA1c)) throw new Error('T6 new alert must be unread');
      if ((u0.body.unreadAlertIds || []).includes(alertA1)) throw new Error('T6 a resolved alert is not counted');
      eq(u0.body.alerts, (u0.body.unreadAlertIds || []).length, 'T6 count = ids');
      const mine = await get(T[mashA1], `/api/updates/unread?venueId=${A1}`);
      if ((mine.body.unreadAlertIds || []).includes(alertA1c)) throw new Error('T6 own alert never unread for the reporter');
      const wrongVenue = await post(T[coordA1], '/api/updates/seen', { venueId: A1, alertIds: [alertA2] });
      eq(wrongVenue.body.recorded, 0, 'T6 another venue\'s alert is skipped silently');
      const s = await post(T[coordA1], '/api/updates/seen', { venueId: A1, alertIds: [alertA1c] });
      eq(s.status, 200, 'T6 seen'); eq(s.body.recorded, 1, 'T6 recorded');
      const u1 = await get(T[coordA1], `/api/updates/unread?venueId=${A1}`);
      if ((u1.body.unreadAlertIds || []).includes(alertA1c)) throw new Error('T6 marked alert still unread');
      const ad = await get(T[adminX], `/api/updates/unread?venueId=${A1}`);
      if (!(ad.body.unreadAlertIds || []).includes(alertA1c)) throw new Error('T6 a mark is per user (admin still unread)');
      eq((await post(T[mashA2], '/api/updates/seen', { venueId: A1, alertIds: [alertA1c] })).status, 403, 'T6 other venue gate');
      eq((await post(T[coordA1], '/api/updates/seen', { venueId: A1, alertIds: 'x' })).status, 400, 'T6 bad payload');
    }

    // ---- T7: ✓✓ receipts — admin/coordinator only, roster-scoped, names only ----
    {
      eq((await get(T[mashA1], `/api/updates/receipts?venueId=${A1}`)).status, 403, 'T7 mashgiach → 403');
      eq((await get(T[coordA1], `/api/updates/receipts?venueId=${A2}`)).status, 403, 'T7 coordinator other venue → 403');
      eq((await get(T[adminY], `/api/updates/receipts?venueId=${A1}`)).status, 403, 'T7 other agency admin → 403');
      const rc = await get(T[coordA1], `/api/updates/receipts?venueId=${A1}`);
      eq(rc.status, 200, 'T7 coordA1 receipts'); clean(rc.body, 'T7 receipts');
      const a = (rc.body.alerts || []).find((x) => x.id === alertA1c);
      if (!a) throw new Error('T7 alert receipt missing');
      eq(a.total, 2, 'T7 alert audience = admin X + coord A1'); eq(a.read, 1, 'T7 coordA1 read it');
      if ((rc.body.alerts || []).some((x) => x.id === alertA2)) throw new Error('T7 coordA1 got an A2 alert receipt');
      // Agency-wide announcement: mashA1 reads it; mashA2 (other venue) reads it too.
      await post(T[mashA1], '/api/updates/seen', { venueId: A1, announcementIds: [annWide] });
      await post(T[mashA2], '/api/updates/seen', { venueId: A2, announcementIds: [annWide] });
      const rc2 = await get(T[coordA1], `/api/updates/receipts?venueId=${A1}`);
      const w = (rc2.body.announcements || []).find((x) => x.id === annWide);
      // coordA1 sees: coordA1, mashA1, mashA1b at A1 (author adminX excluded; other venues and admins-only scope)
      eq(w.total, 3, 'T7 coordinator\'s audience is roster-scoped (A1 + admins, minus the author)'); eq(w.read, 1, 'T7 only mashA1 counted (mashA2 is out of scope)');
      const ra = await get(T[adminX], `/api/updates/receipts?venueId=${A1}`);
      const wa = (ra.body.announcements || []).find((x) => x.id === annWide);
      eq(wa.read, 2, 'T7 admin counts the whole agency (mashA1 + mashA2)');
      const list1 = await get(T[coordA1], `/api/updates/receipts/announcement/${annWide}?venueId=${A1}`);
      eq(list1.status, 200, 'T7 reader list'); clean(list1.body, 'T7 reader list');
      const names = (list1.body.read || []).map((x) => x.name);
      if (!names.includes('T30 Mash A1')) throw new Error('T7 reader list must include Mash A1');
      if (names.includes('T30 Mash A2') || (list1.body.notYet || []).some((x) => x.name === 'T30 Mash A2')) throw new Error('T7 coordinator must not see another venue\'s staff');
      eq((await get(T[coordA1], `/api/updates/receipts/alert/${alertA2}?venueId=${A1}`)).status, 404, 'T7 other venue alert → 404');
      eq((await get(T[coordA1], `/api/updates/receipts/alert/incident-nope-${ts}?venueId=${A1}`)).status, 404, 'T7 unknown → same 404');
      eq((await get(T[mashA1], `/api/updates/receipts/alert/${alertA1c}?venueId=${A1}`)).status, 403, 'T7 mashgiach reader list → 403');
    }

    // ---- T8: the receiver's mute — silent, never absent ----
    {
      eq((await put(T[coordA1], '/api/updates/alert-mute', { minutes: -5 })).status, 400, 'T8 bad minutes');
      eq((await put(T[coordA1], '/api/updates/alert-mute', { minutes: 1441 })).status, 400, 'T8 over 24 h');
      const m = await put(T[coordA1], '/api/updates/alert-mute', { minutes: 60 });
      eq(m.status, 200, 'T8 mute'); if (!m.body.mutedUntil) throw new Error('T8 mutedUntil missing');
      eq((await get(T[coordA1], '/api/updates/alert-mute')).body.mutedUntil, m.body.mutedUntil, 'T8 read back');
      const r = await raise(T[mashA1], { venueId: A1, title: `muted ${ts}` });
      const route = (await routing(r.body.incident.id)) || [];
      const c = route.find((x) => x.email === E('coorda1')); const a = route.find((x) => x.email === E('adminx'));
      if (!c) throw new Error('T8 a muted coordinator is still routed (delivered)');
      eq(c.silent, true, 'T8 muted coordinator gets a silent push'); eq(a?.silent, false, 'T8 admin not muted');
      eq((await put(T[coordA1], '/api/updates/alert-mute', { minutes: 0 })).body.mutedUntil, null, 'T8 unmute');
      const r2 = await raise(T[mashA1], { venueId: A1, title: `unmuted ${ts}` });
      eq(((await routing(r2.body.incident.id)) || []).find((x) => x.email === E('coorda1'))?.silent, false, 'T8 loud again');
      // One user's mute is theirs alone.
      eq((await get(T[adminX], '/api/updates/alert-mute')).body.mutedUntil, null, 'T8 mute is per user');
    }

    // ---- T9: kiosk — no alerts at all, whatever role signs in ----
    {
      const ver = await ctx.getVersion();
      const p = await fetch(`${baseUrl}/api/users/${coordA1}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(T[adminX]), body: JSON.stringify({ kioskPin: '3012', expectedVersion: ver }),
      });
      eq(p.status, 200, 'T9 set PIN');
      deviceHeader = await pairDevice(baseUrl, T[adminX], A1);
      const k = await kioskLogin(baseUrl, coordA1, '3012');
      eq((await get(k, '/api/incidents', true)).status, 403, 'T9 kiosk GET incidents');
      eq((await post(k, '/api/incidents', { venueId: A1, title: `kiosk ${ts}` }, true)).status, 403, 'T9 kiosk raise');
      eq((await get(k, `/api/incidents/${alertA1c}/media`, true)).status, 403, 'T9 kiosk media');
      eq((await get(k, `/api/updates/receipts?venueId=${A1}`, true)).status, 403, 'T9 kiosk receipts');
      eq((await put(k, '/api/updates/alert-mute', { minutes: 60 }, true)).status, 403, 'T9 kiosk mute');
      const wsK = await connectWs(baseUrl, k, true);
      const r = await raise(T[mashA1], { venueId: A1, title: `kiosk ws ${ts}` });
      eq(r.status, 200, 'T9 raise while kiosk listens');
      await sleep(700);
      if (wsK.messages.some((m) => /^INCIDENT_/.test(m.type))) throw new Error('T9 kiosk socket received an alert event');
      wsK.ws.close();
    }


    // ======================= plan v2 additions (T10–T15) =======================
    const routingFull = async (id) => (await (await fetch(`${baseUrl}/api/__test__/alert-routing?id=${encodeURIComponent(id)}`)).json());
    const receiptOf = async (tok, id) => ((await get(tok, `/api/updates/receipts?venueId=${A1}`)).body.alerts || []).find((x) => x.id === id);
    const unreadIds = async (tok) => (await get(tok, `/api/updates/unread?venueId=${A1}`)).body.unreadAlertIds || [];

    // ---- T10 (A4): two SIMULTANEOUS raises with one clientRef → one alert, one task, one push dispatch ----
    {
      const ref = `ref-conc-${ts}`; const title = `concurrent ${ts}`;
      const both = await Promise.all([1, 2].map(() => raise(T[mashA1], { venueId: A1, title, clientRef: ref })));
      for (const r of both) if (r.status !== 200 && r.status !== 409) throw new Error(`T10 concurrent raise → ${r.status}`);
      const ok = both.filter((r) => r.status === 200);
      while (ok.length < 2) { const again = await raise(T[mashA1], { venueId: A1, title, clientRef: ref }); eq(again.status, 200, 'T10 retry after a version conflict'); ok.push(again); }
      const idset = new Set(ok.map((r) => r.body.incident?.id));
      eq(idset.size, 1, 'T10 every answer names the same alert');
      eq(ok.filter((r) => r.body.replayed !== true).length, 1, 'T10 exactly one request created it');
      const id = [...idset][0];
      const doc = await ctx.getDoc();
      eq((doc.incidents || []).filter((i) => i.id === id).length, 1, 'T10 one alert stored');
      eq((doc.tasks || []).filter((t) => t.id === `task-${id}`).length, 1, 'T10 one follow-up task stored');
      eq((await routingFull(id)).attempts, 1, 'T10 one push dispatch');
    }

    // ---- T11 (A2): only a recipient's mark counts; a viewing mashgiach adds nothing and gets no badge ----
    let alertR;
    {
      const r = await raise(T[mashA1], { venueId: A1, title: `recipient marks ${ts}` });
      alertR = r.body.incident.id;
      if ((await unreadIds(T[mashA1b])).includes(alertR)) throw new Error('T11 a non-recipient gets no alert badge');
      const m = await post(T[mashA1b], '/api/updates/seen', { venueId: A1, alertIds: [alertR] });
      eq(m.status, 200, 'T11 seen'); eq(m.body.recorded, 0, 'T11 a non-recipient mark is skipped');
      const before = await receiptOf(T[coordA1], alertR);
      eq(before?.total, 2, 'T11 audience = admin X + coordinator A1'); eq(before?.read, 0, 'T11 viewer adds nothing');
      eq((await post(T[coordA1], '/api/updates/seen', { venueId: A1, alertIds: [alertR] })).body.recorded, 1, 'T11 recipient mark recorded');
      eq((await receiptOf(T[coordA1], alertR))?.read, 1, 'T11 recipient mark counts');
      const det = await get(T[coordA1], `/api/updates/receipts/alert/${alertR}?venueId=${A1}`);
      clean(det.body, 'T11 reader list');
      const names = [...(det.body.read || []), ...(det.body.notYet || [])].map((x) => x.name);
      if (names.includes('T30 Mash A1b')) throw new Error('T11 a non-recipient never appears in an alert reader list');
      eq((det.body.read || []).length, 1, 'T11 count and list agree');
    }

    // ---- T12 (A8): receipts follow the CURRENT roster — a reader who moves venue drops out of the old coordinator's view ----
    {
      eq((await post(T[mashA1b], '/api/updates/seen', { venueId: A1, announcementIds: [annWide] })).status, 200, 'T12 mashA1b reads');
      const w0 = ((await get(T[coordA1], `/api/updates/receipts?venueId=${A1}`)).body.announcements || []).find((x) => x.id === annWide);
      eq(w0.read, 2, 'T12 coordinator A1 counts mashA1 + mashA1b');
      const verM = await ctx.getVersion();
      const mv = await fetch(`${baseUrl}/api/users/${mashA1b}?expectedVersion=${verM}`, { method: 'PUT', headers: auth(T[adminX]), body: JSON.stringify({ venueId: A2, expectedVersion: verM }) });
      eq(mv.status, 200, 'T12 admin moves mashA1b to A2');
      const w1 = ((await get(T[coordA1], `/api/updates/receipts?venueId=${A1}`)).body.announcements || []).find((x) => x.id === annWide);
      const l1 = await get(T[coordA1], `/api/updates/receipts/announcement/${annWide}?venueId=${A1}`);
      const n1 = [...(l1.body.read || []), ...(l1.body.notYet || [])].map((x) => x.name);
      eq(w1.read, (l1.body.read || []).length, 'T12 count and list use one audience');
      if (n1.includes('T30 Mash A1b')) throw new Error('T12 a reader who moved to A2 must leave coordinator A1\'s list');
      const wa = ((await get(T[adminX], `/api/updates/receipts?venueId=${A1}`)).body.announcements || []).find((x) => x.id === annWide);
      if (wa.read < 3) throw new Error(`T12 the admin still counts the whole agency (got ${wa.read})`);
    }

    // ---- T13 (A7): acknowledge races — first wins, attribution fixed; a resolved alert never changes again ----
    {
      const r = await raise(T[mashA1], { venueId: A1, title: `ack race ${ts}` });
      const id = r.body.incident.id;
      const acks = await Promise.all([post(T[adminX], `/api/incidents/${id}/acknowledge`, {}), post(T[coordA1], `/api/incidents/${id}/acknowledge`, {})]);
      for (const a of acks) if (a.status !== 200 && a.status !== 409) throw new Error(`T13 concurrent ack → ${a.status}`);
      const first = (await list(T[adminX], `?venueId=${A1}`)).list.find((i) => i.id === id);
      if (!['T30 Admin X', 'T30 Coord A1'].includes(first.acknowledgedByName)) throw new Error(`T13 acknowledged by ${first.acknowledgedByName}`);
      eq(first.status, 'acknowledged', 'T13 status acknowledged');
      const other = first.acknowledgedByName === 'T30 Admin X' ? coordA1 : adminX;
      eq((await post(T[other], `/api/incidents/${id}/acknowledge`, {})).status, 200, 'T13 a later ack is a no-op');
      const again = (await list(T[adminX], `?venueId=${A1}`)).list.find((i) => i.id === id);
      eq(again.acknowledgedByName, first.acknowledgedByName, 'T13 first acknowledger kept');
      eq(again.acknowledgedAt, first.acknowledgedAt, 'T13 acknowledgedAt unchanged');
      // acknowledge vs resolve at once → ends resolved, and stays resolved
      const q = (await raise(T[mashA1], { venueId: A1, title: `ack vs resolve ${ts}` })).body.incident.id;
      await Promise.all([post(T[coordA1], `/api/incidents/${q}/acknowledge`, {}), post(T[adminX], `/api/incidents/${q}/resolve`, {})]);
      let st = (await list(T[adminX], `?venueId=${A1}`)).list.find((i) => i.id === q);
      if (st.status !== 'resolved') { eq((await post(T[adminX], `/api/incidents/${q}/resolve`, {})).status, 200, 'T13 resolve retry'); st = (await list(T[adminX], `?venueId=${A1}`)).list.find((i) => i.id === q); }
      eq(st.status, 'resolved', 'T13 resolve wins the race');
      eq((await post(T[coordA1], `/api/incidents/${q}/acknowledge`, {})).status, 200, 'T13 ack after resolve answers');
      eq((await list(T[adminX], `?venueId=${A1}`)).list.find((i) => i.id === q).status, 'resolved', 'T13 a resolved alert never goes back');
    }

    // ---- T14 (A3): acknowledging clears the acknowledger's badge but writes no read mark ----
    {
      const k = (await raise(T[mashA1], { venueId: A1, title: `badge after ack ${ts}` })).body.incident.id;
      if (!(await unreadIds(T[coordA1])).includes(k)) throw new Error('T14 new alert unread for coordinator A1');
      eq((await post(T[coordA1], `/api/incidents/${k}/acknowledge`, {})).status, 200, 'T14 ack');
      if ((await unreadIds(T[coordA1])).includes(k)) throw new Error('T14 an alert the caller acknowledged leaves their badge');
      eq((await receiptOf(T[coordA1], k))?.read, 0, 'T14 acknowledging is not a read mark');
      if (!(await unreadIds(T[adminX])).includes(k)) throw new Error('T14 the admin still has it unread');
    }

    // ---- T15 (v2.1 A12): inline media is capped and budgeted; alerts never wedge ordinary writes ----
    {
      const P = (n) => 'data:image/jpeg;base64,' + 'P'.repeat(n);
      const V = (n) => 'data:audio/webm;base64,' + 'V'.repeat(n);
      eq((await raise(T[mashA1], { venueId: A1, title: `photo over cap ${ts}`, photoData: P(120001) })).status, 413, 'T15 photo over 120k refused');
      eq((await raise(T[mashA1], { venueId: A1, title: `voice over cap ${ts}`, voiceNoteData: V(90001) })).status, 413, 'T15 voice over 90k refused');
      // Two media alerts at the SAME moment, where the budget fits only one: exactly one is stored.
      const pair = await Promise.all([0, 1].map((i) => raise(T[mashA1], { venueId: A1, title: `media race ${i} ${ts}`, photoData: P(119000), voiceNoteData: V(89000) })));
      const outcomes = pair.map((r) => (r.status === 200 ? 'ok' : `${r.status}:${r.body.code || ''}`));
      for (let i = 0; i < 2; i++) if (pair[i].status === 409) { const again = await raise(T[mashA1], { venueId: A1, title: `media race ${i} ${ts}`, photoData: P(119000), voiceNoteData: V(89000) }); outcomes[i] += `→${again.status}:${again.body.code || ''}`; pair[i] = again; }
      eq(pair.filter((r) => r.status === 200).length, 1, `T15 exactly one of two simultaneous media alerts stored (${outcomes.join(', ')})`);
      const budgetHit = pair.find((r) => r.status !== 200);
      eq(budgetHit.status, 413, 'T15 budget answers 413'); eq(budgetHit.body.code, 'MEDIA_BUDGET', 'T15 budget code (not a generic 503)');
      const textOnly = await raise(T[mashA1], { venueId: A1, title: `text after budget ${ts}` });
      eq(textOnly.status, 200, 'T15 a text alert always goes');
      // an ordinary task write still commits with the budget full
      const doc = await ctx.getDoc();
      const sz = Buffer.byteLength(JSON.stringify(doc));
      const task = (doc.tasks || []).find((x) => x.id === `task-${textOnly.body.incident.id}`) || (doc.tasks || []).find((x) => x.agencyId === AX && x.venueId === A1);
      if (!task) throw new Error(`T15 no follow-up task found (tasks in doc: ${(doc.tasks || []).length}, alert ${textOnly.body.incident?.id})`);
      const ver = await ctx.getVersion();
      const tw = await fetch(`${baseUrl}/api/tasks/${task.id}?expectedVersion=${ver}`, { method: 'PUT', headers: auth(T[adminX]), body: JSON.stringify({ currentStatus: 'yes', isCompleted: true, expectedVersion: ver }) });
      console.log(`      T15 simultaneous media raises: ${outcomes.join(', ')}; doc ≈ ${Math.round(sz / 1024)} KiB; task write → ${tw.status}`);
      eq(tw.status, 200, 'T15 a task write still commits');
      const ciTask = `task-t30-ci-${ts}`;
      await ctx.api('POST', '/api/__test__/inject-fixture', { tasks: [{ id: ciTask, agencyId: AX, venueId: A1, title: 'T30 check-in', description: '', category: 'Shift', inputType: 'check_in', assignedTo: ['all'], daysOfWeek: [], currentStatus: 'pending', isCompleted: false, notes: '', updatedByEmail: null, updatedByName: null, updatedAt: null, createdAt: new Date().toISOString(), checkIns: [] }] });
      const ci = await post(T[adminX], `/api/tasks/${ciTask}/check-in`, { photoData: 'data:image/jpeg;base64,' + 'Q'.repeat(2000) });
      eq(ci.status, 200, 'T15 a check-in with a photo still commits');
      if (sz > 700 * 1024) throw new Error(`T15 the document is too close to the 900 KiB guard (${Math.round(sz / 1024)} KiB)`);
    }

    return 'T1–T15 pass: routing exact (admins + venue coordinators, never the reporter), replay-safe, media refused not truncated, rule T on REST + WS with clean payloads, only recipients acknowledge, per-user marks, roster-scoped ✓✓, mute = silent not absent, kiosk sees no alerts; v2: concurrent raise = one alert/task/push, recipient-only marks, receipts follow the current roster, ack races fixed, badge clears on ack without a read mark, media is capped and budgeted so alerts never wedge ordinary writes.';
  },
};
