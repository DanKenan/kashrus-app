/**
 * Test 29: Updates panel (item 5a) — who can post, who sees what, kiosk
 * read-only, server-recorded read state.
 *
 * Rule T (fail closed): admin = whole agency; coordinator = own venue only;
 * everyone else = own venue and own records. Kiosk = the tablet's venue only,
 * read-only, whatever the logged-in user's role.
 *
 * Fixture: agency X (venues A1, A2), agency Y (venue B1).
 * Users: adminX (venueId A1), coordA1 (also signs in on the A1 kiosk),
 * coordNoVenue, mashA1, mashA2, ownerA2, adminY.
 * Announcements: wide-all, wide-coordinators-only, A1-all, A2-all,
 * A1-urgent, expired, Y-all. Notes: A1 by mashA1, A1 by coordA1, A2 by mashA2.
 *
 * Every positive check has its negative twin (rule G).
 * T5 admin/author visibility, T6 payload validation + concurrent marks,
 * T7 venue-filtered delete events (ChatGPT plan review, Oct 20).
 */

const AX = 'agency-test29-x';
const AY = 'agency-test29-y';

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
function noReadBy(obj, label) {
  if (/"readBy"\s*:/.test(JSON.stringify(obj))) throw new Error(`${label}: readBy leaked`);
}

export default {
  name: 'Test 29: Updates panel — roles, privacy, kiosk read-only, read state',
  whatItProves:
    'Only admins (agency-wide) and coordinators (own venue) post announcements; targetRoles and venue scope hold on REST and WebSocket alike, kiosk included; the kiosk is read-only and venue-scoped for every role that signs in on it; read marks are per item, per user, scope-checked, never leak readBy, and drive the unread counts.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A1 = `venue-t29-a1-${ts}`, A2 = `venue-t29-a2-${ts}`, B1 = `venue-t29-b1-${ts}`;
    const U = (n) => `user-t29-${n}-${ts}`;
    const adminX = U('adminx'), coordA1 = U('coorda1'), coordNo = U('coordno'), mashA1 = U('masha1'),
      mashA2 = U('masha2'), ownerA2 = U('ownera2'), adminY = U('adminy');
    const N = (n) => `ann-t29-${n}-${ts}`;
    const annWide = N('wide'), annWideCoord = N('widecoord'), annA1 = N('a1'), annA2 = N('a2'),
      annA1Urgent = N('a1urgent'), annExpired = N('expired'), annY = N('y');
    const noteA1m = `note-t29-a1m-${ts}`, noteA1c = `note-t29-a1c-${ts}`, noteA2 = `note-t29-a2-${ts}`;
    const t0 = new Date(ts - 60000).toISOString();
    const past = new Date(ts - 3600000).toISOString();
    const ann = (id, agencyId, extra) => ({ id, agencyId, authorEmail: `adminx-${ts}@test.local`, authorName: 'T29 Admin', title: `T ${id}`, body: 'b', category: 'update', targetRoles: ['all'], createdAt: t0, ...extra });
    const note = (id, venueId, authorId, authorEmail) => ({ id, agencyId: AX, venueId, authorId, authorEmail, authorName: 'T29', content: `N ${id}`, shift: 'Morning', createdAt: t0 });

    await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AX, name: 'T29 X' }, { id: AY, name: 'T29 Y' }],
      venues: [
        { id: A1, name: `T29 A1 ${ts}`, agencyId: AX },
        { id: A2, name: `T29 A2 ${ts}`, agencyId: AX },
        { id: B1, name: `T29 B1 ${ts}`, agencyId: AY },
      ],
      users: [
        { id: adminX, email: `adminx-${ts}@test.local`, name: 'T29 Admin X', role: 'admin', agencyId: AX, venueId: A1 },
        { id: coordA1, email: `coorda1-${ts}@test.local`, name: 'T29 Coord A1', role: 'coordinator', agencyId: AX, venueId: A1 },
        { id: coordNo, email: `coordno-${ts}@test.local`, name: 'T29 Coord none', role: 'coordinator', agencyId: AX },
        { id: mashA1, email: `masha1-${ts}@test.local`, name: 'T29 Mash A1', role: 'mashgiach', agencyId: AX, venueId: A1 },
        { id: mashA2, email: `masha2-${ts}@test.local`, name: 'T29 Mash A2', role: 'mashgiach', agencyId: AX, venueId: A2 },
        { id: ownerA2, email: `ownera2-${ts}@test.local`, name: 'T29 Owner A2', role: 'owner', agencyId: AX, venueId: A2 },
        { id: adminY, email: `adminy-${ts}@test.local`, name: 'T29 Admin Y', role: 'admin', agencyId: AY },
      ],
      announcements: [
        ann(annWide, AX),
        ann(annWideCoord, AX, { targetRoles: ['coordinator'] }),
        ann(annA1, AX, { venueId: A1 }),
        ann(annA2, AX, { venueId: A2 }),
        ann(annA1Urgent, AX, { venueId: A1, category: 'urgent' }),
        ann(annExpired, AX, { expiresAt: past }),
        ann(annY, AY),
      ],
      handoffNotes: [
        note(noteA1m, A1, mashA1, `masha1-${ts}@test.local`),
        note(noteA1c, A1, coordA1, `coorda1-${ts}@test.local`),
        note(noteA2, A2, mashA2, `masha2-${ts}@test.local`),
      ],
    });
    const T = {};
    for (const id of [adminX, coordA1, coordNo, mashA1, mashA2, ownerA2, adminY]) T[id] = await mintToken(baseUrl, id);

    const getAnn = async (tok, qs = '', k = false) => {
      const r = await fetch(`${baseUrl}/api/announcements${qs}`, { headers: k ? authK(tok) : auth(tok) });
      const b = await r.json().catch(() => ({}));
      noReadBy(b, `GET announcements${qs}`);
      return { status: r.status, list: b.announcements || [] };
    };
    const getNotes = async (tok, qs = '', k = false) => {
      const r = await fetch(`${baseUrl}/api/handoff-notes${qs}`, { headers: k ? authK(tok) : auth(tok) });
      const b = await r.json().catch(() => ({}));
      noReadBy(b, `GET handoff-notes${qs}`);
      return { status: r.status, list: b.notes || [] };
    };
    const post = async (tok, path, body, k = false) => {
      const ver = await ctx.getVersion();
      const r = await fetch(`${baseUrl}${path}?expectedVersion=${ver}`, {
        method: 'POST', headers: k ? authK(tok) : auth(tok),
        body: JSON.stringify({ expectedVersion: ver, operationId: `op-${Math.random()}`, ...body }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const unread = async (tok, venueId) => {
      const r = await fetch(`${baseUrl}/api/updates/unread?venueId=${venueId}`, { headers: auth(tok) });
      const b = await r.json().catch(() => ({}));
      noReadBy(b, 'GET updates/unread');
      return { status: r.status, ...b };
    };

    // ---- T1: who can post ----
    {
      const a = await post(T[adminX], '/api/announcements', { title: `admin wide ${ts}`, targetRoles: ['all'] });
      if (a.status !== 200) throw new Error(`T1 admin agency-wide post: ${a.status}`);
      const c = await post(T[coordA1], '/api/announcements', { title: `coord own ${ts}`, venueId: A1 });
      if (c.status !== 200) throw new Error(`T1 coordinator own-venue post: ${c.status}`);
      const c2 = await post(T[coordA1], '/api/announcements', { title: `coord other ${ts}`, venueId: A2 });
      if (c2.status !== 403) throw new Error(`T1 coordinator other venue: ${c2.status} (expected 403)`);
      const c3 = await post(T[coordA1], '/api/announcements', { title: `coord wide ${ts}` });
      if (c3.status !== 403) throw new Error(`T1 coordinator agency-wide: ${c3.status} (expected 403)`);
      const c4 = await post(T[coordNo], '/api/announcements', { title: `coord none ${ts}`, venueId: A1 });
      if (c4.status !== 403) throw new Error(`T1 venue-less coordinator: ${c4.status} (expected 403)`);
      for (const who of [mashA1, ownerA2]) {
        const r = await post(T[who], '/api/announcements', { title: `nope ${ts}`, venueId: A1 });
        if (r.status !== 403) throw new Error(`T1 ${who} post: ${r.status} (expected 403)`);
      }
      noReadBy(a.body, 'T1 POST response');
      // Notes: everyone at the venue can write; not at another venue.
      const n1 = await post(T[mashA1], '/api/handoff-notes', { venueId: A1, content: `mash note ${ts}`, shift: 'Morning' });
      if (n1.status !== 200) throw new Error(`T1 mashgiach own-venue note: ${n1.status}`);
      const n2 = await post(T[mashA1], '/api/handoff-notes', { venueId: A2, content: `x ${ts}`, shift: 'Morning' });
      if (n2.status !== 403) throw new Error(`T1 mashgiach other-venue note: ${n2.status} (expected 403)`);
      noReadBy(n1.body, 'T1 note POST response');
    }

    // ---- T2: who sees what (REST) ----
    {
      const m = (await getAnn(T[mashA1])).list;
      mustHave(m, annWide, 'T2 mashA1'); mustHave(m, annA1, 'T2 mashA1');
      mustNot(m, annWideCoord, 'T2 mashA1 (coordinators-only)'); mustNot(m, annA2, 'T2 mashA1 (other venue)');
      mustNot(m, annExpired, 'T2 mashA1 (expired)'); mustNot(m, annY, 'T2 mashA1 (other agency)');
      const c = (await getAnn(T[coordA1])).list;
      mustHave(c, annWideCoord, 'T2 coordA1'); mustHave(c, annA1, 'T2 coordA1'); mustNot(c, annA2, 'T2 coordA1 (other venue)');
      const a = (await getAnn(T[adminX])).list;
      mustHave(a, annA1, 'T2 adminX'); mustHave(a, annA2, 'T2 adminX'); mustNot(a, annY, 'T2 adminX (other agency)');
      const y = (await getAnn(T[adminY])).list;
      mustHave(y, annY, 'T2 adminY'); mustNot(y, annWide, 'T2 adminY (other agency)');
      const nm = (await getNotes(T[mashA1])).list;
      mustHave(nm, noteA1m, 'T2 notes mashA1'); mustNot(nm, noteA2, 'T2 notes mashA1 (other venue)');
      const nc = await getNotes(T[coordA1], `?venueId=${A2}`);
      if (nc.status !== 403) throw new Error(`T2 coordA1 notes ?venueId=A2: ${nc.status} (expected 403)`);
      const ny = (await getNotes(T[adminY])).list;
      mustNot(ny, noteA1m, 'T2 notes adminY (other agency)');
    }

    // ---- T2b: who sees what (WebSocket) — role targeting + venue ----
    {
      const wsM1 = await connectWs(baseUrl, T[mashA1]);
      const wsC1 = await connectWs(baseUrl, T[coordA1]);
      const wsM2 = await connectWs(baseUrl, T[mashA2]);
      noReadBy(wsM1.messages, 'T2b INITIAL_STATE mashA1');
      const coordOnly = await post(T[adminX], '/api/announcements', { title: `ws coord-only ${ts}`, targetRoles: ['coordinator'] });
      const a1Only = await post(T[adminX], '/api/announcements', { title: `ws A1 ${ts}`, venueId: A1 });
      const noteWs = await post(T[mashA1], '/api/handoff-notes', { venueId: A1, content: `ws note ${ts}`, shift: 'Morning' });
      await sleep(1500);
      const got = (conn, id) => conn.messages.some((m) => JSON.stringify(m.payload || {}).includes(id));
      const coId = coordOnly.body.announcement?.id, a1Id = a1Only.body.announcement?.id, nId = noteWs.body.note?.id;
      if (!coId || !a1Id || !nId) throw new Error('T2b setup posts failed');
      if (!got(wsC1, coId)) throw new Error('T2b coordinator socket missed a coordinators-only announcement');
      if (got(wsM1, coId)) throw new Error('T2b mashgiach socket received a coordinators-only announcement');
      if (!got(wsM1, a1Id)) throw new Error('T2b mashA1 socket missed an A1 announcement');
      if (got(wsM2, a1Id)) throw new Error('T2b mashA2 socket received an A1 announcement');
      if (got(wsM2, nId)) throw new Error('T2b mashA2 socket received an A1 shift note');
      for (const c of [wsM1, wsC1, wsM2]) noReadBy(c.messages, 'T2b WS payloads');
      [wsM1, wsC1, wsM2].forEach((c) => c.ws.close());
    }

    // ---- T3: kiosk is read-only and venue-scoped for every role that can sign in on it (admins cannot) ----
    {
      for (const [uid, pin] of [[mashA1, '2911'], [coordA1, '2912']]) {
        const ver = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/users/${uid}?expectedVersion=${ver}`, {
          method: 'PUT', headers: auth(T[adminX]), body: JSON.stringify({ kioskPin: pin, expectedVersion: ver }),
        });
        if (r.status !== 200) throw new Error(`T3 set PIN ${uid}: ${r.status}`);
      }
      deviceHeader = await pairDevice(baseUrl, T[adminX], A1);
      for (const [uid, pin, label] of [[mashA1, '2911', 'mashgiach'], [coordA1, '2912', 'coordinator']]) {
        const k = await kioskLogin(baseUrl, uid, pin);
        const ka = await getAnn(k, '', true);
        if (ka.status !== 200) throw new Error(`T3 kiosk(${label}) GET announcements: ${ka.status}`);
        mustHave(ka.list, annA1, `T3 kiosk(${label})`); mustHave(ka.list, annWide, `T3 kiosk(${label})`);
        mustNot(ka.list, annA2, `T3 kiosk(${label}) other venue`); mustNot(ka.list, annY, `T3 kiosk(${label}) other agency`);
        const kn = await getNotes(k, '', true);
        mustHave(kn.list, noteA1m, `T3 kiosk(${label}) notes`); mustNot(kn.list, noteA2, `T3 kiosk(${label}) notes other venue`);
        const kp = await post(k, '/api/handoff-notes', { venueId: A1, content: `kiosk write ${ts}`, shift: 'Morning' }, true);
        if (kp.status !== 403) throw new Error(`T3 kiosk(${label}) POST note: ${kp.status} (expected 403 read-only)`);
        const ks = await post(k, '/api/updates/seen', { venueId: A1, announcementIds: [annA1], noteIds: [] }, true);
        if (ks.status !== 403) throw new Error(`T3 kiosk(${label}) POST updates/seen: ${ks.status} (expected 403)`);
        const kpa = await post(k, '/api/announcements', { title: `kiosk ann ${ts}`, venueId: A1 }, true);
        if (kpa.status !== 403) throw new Error(`T3 kiosk(${label}) POST announcement: ${kpa.status} (expected 403)`);
      }
      // Kiosk socket: no other-venue announcement; delete events for its venue arrive.
      const k = await kioskLogin(baseUrl, mashA1, '2911');
      const wsK = await connectWs(baseUrl, k, true);
      noReadBy(wsK.messages, 'T3 kiosk INITIAL_STATE');
      const a2 = await post(T[adminX], '/api/announcements', { title: `kiosk ws A2 ${ts}`, venueId: A2 });
      const coordOnly = await post(T[adminX], '/api/announcements', { title: `kiosk ws coord ${ts}`, targetRoles: ['coordinator'] });
      const ver = await ctx.getVersion();
      const del = await fetch(`${baseUrl}/api/handoff-notes/${noteA1c}?expectedVersion=${ver}`, {
        method: 'DELETE', headers: auth(T[coordA1]), body: JSON.stringify({ expectedVersion: ver }),
      });
      if (del.status !== 200) throw new Error(`T3 coordinator deletes own A1 note: ${del.status}`);
      await sleep(1500);
      const got = (id) => wsK.messages.some((m) => JSON.stringify(m.payload || {}).includes(id));
      if (got(a2.body.announcement?.id)) throw new Error('T3 kiosk socket received an A2 announcement');
      if (got(coordOnly.body.announcement?.id)) throw new Error('T3 kiosk socket (mashgiach) received a coordinators-only announcement');
      if (!wsK.messages.some((m) => m.type === 'HANDOFF_NOTE_DELETED' && JSON.stringify(m.payload).includes(noteA1c))) {
        throw new Error('T3 kiosk socket missed HANDOFF_NOTE_DELETED for its own venue');
      }
      wsK.ws.close();
      deviceHeader = null;
    }

    // ---- T4: read state ----
    {
      const u0 = await unread(T[mashA1], A1);
      if (u0.status !== 200) throw new Error(`T4 unread: ${u0.status}`);
      if (!(u0.announcements >= 3)) throw new Error(`T4 mashA1 unread announcements ${u0.announcements} (expected ≥3: wide, A1, A1-urgent)`);
      if (!Array.isArray(u0.urgent) || !u0.urgent.some((x) => x.id === annA1Urgent)) throw new Error('T4 urgent list misses the A1 urgent item');
      // Own notes never count as unread; coordA1's note was deleted in T3; mash's own notes don't count.
      const notesBefore = u0.notes;
      const s = await post(T[mashA1], '/api/updates/seen', {
        venueId: A1, announcementIds: [annA1, annA1Urgent, annA2, annY, 'ann-does-not-exist'], noteIds: [noteA2],
      });
      if (s.status !== 200) throw new Error(`T4 seen: ${s.status}`);
      noReadBy(s.body, 'T4 seen response');
      const u1 = await unread(T[mashA1], A1);
      if (u1.announcements !== u0.announcements - 2) throw new Error(`T4 unread after seen ${u1.announcements} (expected ${u0.announcements - 2})`);
      if (u1.urgent.some((x) => x.id === annA1Urgent)) throw new Error('T4 urgent still listed after seen');
      if (u1.notes !== notesBefore) throw new Error('T4 a forbidden note id changed the notes count');
      // Forbidden ids were not recorded for mashA1: adminX still sees annA2 with no mark side-effects visible,
      // and mashA2's count for A2 is unaffected by mashA1's attempt.
      const uOther = await unread(T[mashA2], A2);
      if (!(uOther.announcements >= 1)) throw new Error('T4 mashA2 A2 unread disturbed');
      // Unread is per user: coordA1 still has the A1 items unread.
      const uc = await unread(T[coordA1], A1);
      if (!(uc.announcements >= 2)) throw new Error(`T4 coordA1 unread ${uc.announcements} (per-user marks broken)`);
      // Scope on the counts endpoint.
      const bad = await unread(T[mashA1], A2);
      if (bad.status !== 403) throw new Error(`T4 mashA1 unread for A2: ${bad.status} (expected 403)`);
      const badS = await post(T[mashA1], '/api/updates/seen', { venueId: A2, announcementIds: [annA2], noteIds: [] });
      if (badS.status !== 403) throw new Error(`T4 mashA1 seen for A2: ${badS.status} (expected 403)`);
      // A note's author never sees it as unread: mashA1 posts, mashA1's count unchanged; coordA1's goes up.
      const ucb = (await unread(T[coordA1], A1)).notes;
      const umb = (await unread(T[mashA1], A1)).notes;
      await post(T[mashA1], '/api/handoff-notes', { venueId: A1, content: `count probe ${ts}`, shift: 'Morning' });
      if ((await unread(T[mashA1], A1)).notes !== umb) throw new Error('T4 own note counted as unread');
      if ((await unread(T[coordA1], A1)).notes !== ucb + 1) throw new Error('T4 new note not unread for a colleague');
      // readBy never in any list read after marks exist.
      await getAnn(T[mashA1]); await getAnn(T[adminX]); await getNotes(T[coordA1]);
    }

    // ---- T5: admin and author visibility (Q6) ----
    {
      const mashOnly = await post(T[adminX], '/api/announcements', { title: `mash-only ${ts}`, targetRoles: ['mashgiach'] });
      const mid = mashOnly.body.announcement?.id;
      if (!mid) throw new Error('T5 admin post mashgiach-only failed');
      mustHave((await getAnn(T[adminX])).list, mid, 'T5 admin sees own mashgiach-only post');
      mustHave((await getAnn(T[mashA1])).list, mid, 'T5 mashgiach sees mashgiach-only post');
      mustNot((await getAnn(T[coordA1])).list, mid, 'T5 coordinator must not see mashgiach-only post');
      const cOwn = await post(T[coordA1], '/api/announcements', { title: `coord to mash ${ts}`, venueId: A1, targetRoles: ['mashgiach'] });
      const cid = cOwn.body.announcement?.id;
      if (!cid) throw new Error('T5 coordinator post failed');
      mustHave((await getAnn(T[coordA1])).list, cid, 'T5 author (coordinator) sees own post');
      mustNot((await getAnn(T[mashA2])).list, cid, 'T5 other venue mashgiach must not see A1 post');
      mustNot((await getAnn(T[adminY])).list, cid, 'T5 other agency admin must not see it');
      // Unknown roles are dropped on create; nothing valid → everyone.
      const junk = await post(T[adminX], '/api/announcements', { title: `junk roles ${ts}`, targetRoles: ['superuser', 42] });
      if (JSON.stringify(junk.body.announcement?.targetRoles) !== '["all"]') throw new Error(`T5 junk targetRoles not normalised: ${JSON.stringify(junk.body.announcement?.targetRoles)}`);
    }

    // ---- T6: seen payload validation + concurrent marks ----
    {
      const bad1 = await post(T[mashA1], '/api/updates/seen', { venueId: A1, announcementIds: 'x', noteIds: [] });
      if (bad1.status !== 400) throw new Error(`T6 non-array ids: ${bad1.status} (expected 400)`);
      const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
      const bad2 = await post(T[mashA1], '/api/updates/seen', { venueId: A1, announcementIds: many, noteIds: [] });
      if (bad2.status !== 400) throw new Error(`T6 201 ids: ${bad2.status} (expected 400)`);
      const bad3 = await post(T[mashA1], '/api/updates/seen', { venueId: A1, announcementIds: [{}], noteIds: [] });
      if (bad3.status !== 400) throw new Error(`T6 object id: ${bad3.status} (expected 400)`);
      // Two devices mark different items at the same moment: both marks survive.
      const p1 = await post(T[adminX], '/api/announcements', { title: `conc1 ${ts}`, venueId: A1 });
      const p2 = await post(T[adminX], '/api/announcements', { title: `conc2 ${ts}`, venueId: A1 });
      const i1 = p1.body.announcement?.id, i2 = p2.body.announcement?.id;
      const before = (await unread(T[coordA1], A1)).announcements;
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T[coordA1]), body: JSON.stringify({ venueId: A1, announcementIds: [i1], noteIds: [] }) }),
        fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T[coordA1]), body: JSON.stringify({ venueId: A1, announcementIds: [i2], noteIds: [] }) }),
      ]);
      if (r1.status !== 200 || r2.status !== 200) throw new Error(`T6 concurrent seen: ${r1.status}/${r2.status}`);
      const after = (await unread(T[coordA1], A1)).announcements;
      if (after !== before - 2) throw new Error(`T6 concurrent marks lost: unread ${before} → ${after} (expected −2)`);
      // Response carries an aggregate count only.
      const again = await post(T[coordA1], '/api/updates/seen', { venueId: A1, announcementIds: [i1, i2, annA2], noteIds: [] });
      if (again.status !== 200 || Object.keys(again.body).sort().join(',') !== 'ok,recorded' || again.body.recorded !== 0) {
        throw new Error(`T6 idempotent/aggregate response wrong: ${JSON.stringify(again.body)}`);
      }
    }

    // ---- T7: deletion events are venue-filtered on sockets ----
    {
      const wsM1 = await connectWs(baseUrl, T[mashA1]);
      const a2 = await post(T[adminX], '/api/announcements', { title: `to delete A2 ${ts}`, venueId: A2 });
      const a1 = await post(T[adminX], '/api/announcements', { title: `to delete A1 ${ts}`, venueId: A1 });
      const del = async (id) => {
        const ver = await ctx.getVersion();
        const r = await fetch(`${baseUrl}/api/announcements/${id}?expectedVersion=${ver}`, { method: 'DELETE', headers: auth(T[adminX]), body: JSON.stringify({ expectedVersion: ver }) });
        if (r.status !== 200) throw new Error(`T7 delete ${id}: ${r.status}`);
      };
      await del(a2.body.announcement.id); await del(a1.body.announcement.id);
      await sleep(1500);
      const dels = wsM1.messages.filter((m) => m.type === 'ANNOUNCEMENT_DELETED').map((m) => JSON.stringify(m.payload));
      if (dels.some((d) => d.includes(a2.body.announcement.id))) throw new Error('T7 A2 delete event reached an A1 mashgiach');
      if (!dels.some((d) => d.includes(a1.body.announcement.id))) throw new Error('T7 A1 delete event missing for A1 mashgiach');
      if (dels.some((d) => /title|body/.test(d))) throw new Error('T7 delete payload carries content');
      wsM1.ws.close();
    }
  },
};
