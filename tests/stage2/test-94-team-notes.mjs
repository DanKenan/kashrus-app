/**
 * Test 94: Team notes — @mentions, @All, Private and Seen-by in Shift notes
 * (TEAMNOTES, Don Oct 29 2026: "when you press @ you can choose someone to
 * tag ... @All should also be an option. Everyone can see who saw it ...
 * send it private, so only the one being tagged, admin and coordinators can
 * see it").
 *
 * Fixture: agency X (venues A1, A2), agency Y (B1). Users: adminX, coordA1,
 * coordA2, mashA1 (author), mashA1b (tagged), mashA1c (not tagged), ownerA1,
 * mashA2, adminY. Every user subscribes one push device.
 *  A  tag picker list = A1 team + X admins; other venue 403; kiosk 403.
 *  B  a tag pushes ONLY the tagged person; untagged people still read it.
 *  C  @All pushes the venue team (not admins, not the author, not other venues).
 *  D  validation: other-venue tag, private without a tag, private + @All.
 *  E  private: REST list (every reader / non-reader), kiosk list, socket
 *     (staff + kiosk), push, delete event — only author, tagged, admins,
 *     the venue's coordinators.
 *  K  (TEAMNOTES2) every tag push carries the note's text, like WhatsApp; a
 *     private one is marked "(private)" in the title and still reaches only
 *     its readers. The kiosk gets ONLY a number for the person signed in on
 *     the tablet: unread private notes tagged to them at the tablet's venue
 *     (privateForYou) — no text, id or author; 0 for an untagged person; the
 *     number drops when they read it on their phone; phones get no field.
 *  F  seen-by: any team member sees names; private seen-by 404 to non-readers;
 *     marks on an invisible private note are not recorded; unread counts.
 * Every positive check has its negative twin (rule G).
 */

const AX = 'agency-test94-x';
const AY = 'agency-test94-y';

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
  name: 'Test 94: Team notes — @mentions, @All, Private, Seen-by',
  whatItProves:
    'Shift notes take @person / @All tags: only the tagged people (or the venue team for @All) get a push, untagged people still read the note; a private note is visible only to its author, the tagged people, admins and the venue coordinators on REST, sockets, kiosk, push and delete events; any venue team member can see who saw a note.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A1 = `venue-t94-a1-${ts}`, A2 = `venue-t94-a2-${ts}`, B1 = `venue-t94-b1-${ts}`;
    const U = (n) => `user-t94-${n}-${ts}`;
    const E = (n) => `${n}-t94-${ts}@test.local`;
    const people = {
      adminX: ['admin', AX, A1, 'Ada Admin'], coordA1: ['coordinator', AX, A1, 'Cora Coord'], coordA2: ['coordinator', AX, A2, 'Cal Coord'],
      mashA1: ['mashgiach', AX, A1, 'Moshe Author'], mashA1b: ['mashgiach', AX, A1, 'Baruch Tagged'], mashA1c: ['mashgiach', AX, A1, 'Chaim Untagged'],
      ownerA1: ['owner', AX, A1, 'Ora Owner'], mashMov: ['mashgiach', AX, A1, 'Mo Mover'], mashA2: ['mashgiach', AX, A2, 'Dov OtherVenue'], adminY: ['admin', AY, B1, 'Yael AdminY'],
    };
    const id = (k) => U(k.toLowerCase());
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AX, name: 'T94 X' }, { id: AY, name: 'T94 Y' }],
      venues: [
        { id: A1, name: `T94 A1 ${ts}`, agencyId: AX },
        { id: A2, name: `T94 A2 ${ts}`, agencyId: AX },
        { id: B1, name: `T94 B1 ${ts}`, agencyId: AY },
      ],
      users: Object.entries(people).map(([k, [role, agencyId, venueId, name]]) => ({ id: id(k), email: E(k.toLowerCase()), name, role, agencyId, venueId })),
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const T = {};
    for (const k of Object.keys(people)) T[k] = await mintToken(baseUrl, id(k));
    const ep = (k) => `https://push.example/t94-${k}-${ts}`;
    for (const k of Object.keys(people)) {
      const r = await fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: auth(T[k]), body: JSON.stringify({ subscription: { endpoint: ep(k), keys: { p256dh: 'p', auth: 'a' } } }) });
      if (r.status !== 200) throw new Error(`subscribe ${k}: ${r.status}`);
    }
    const byEp = Object.fromEntries(Object.keys(people).map((k) => [ep(k), k]));
    const pushLog = async () => ((await ctx.api('GET', '/api/__test__/push-log')).json?.log || []);
    const clearPush = () => ctx.api('POST', '/api/__test__/push-log/clear', {});
    const pushedTo = async () => { await sleep(150); return (await pushLog()).filter((e) => byEp[e.endpoint]).map((e) => ({ who: byEp[e.endpoint], title: e.title, body: e.body })); };
    const post = (tok, body, k = false) => fetch(`${baseUrl}/api/handoff-notes`, { method: 'POST', headers: k ? authK(tok) : auth(tok), body: JSON.stringify(body) });
    const list = async (tok, qs = '', k = false) => {
      const r = await fetch(`${baseUrl}/api/handoff-notes${qs}`, { headers: k ? authK(tok) : auth(tok) });
      return { status: r.status, list: r.status === 200 ? (await r.json()).notes : [] };
    };
    const get = async (tok, path, k = false) => { const r = await fetch(`${baseUrl}${path}`, { headers: k ? authK(tok) : auth(tok) }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
    const created = async (r, label) => { if (r.status !== 200) throw new Error(`${label}: POST ${r.status} ${await r.text()}`); return (await r.json()).note; };
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

    // ---- A: the tag picker ----
    {
      const t = await get(T.mashA1, `/api/handoff-notes/team?venueId=${A1}`);
      if (t.status !== 200) throw new Error(`A team: ${t.status}`);
      const names = t.body.team.map((m) => m.id);
      for (const k of ['adminX', 'coordA1', 'mashA1', 'mashA1b', 'mashA1c', 'ownerA1']) if (!names.includes(id(k))) throw new Error(`A team must include ${k}`);
      for (const k of ['coordA2', 'mashA2', 'adminY']) if (names.includes(id(k))) throw new Error(`A team must NOT include ${k}`);
      if (JSON.stringify(t.body).includes('@test.local')) throw new Error('A team leaked emails');
      const other = await get(T.mashA1, `/api/handoff-notes/team?venueId=${A2}`);
      if (other.status !== 403) throw new Error(`A other-venue team: ${other.status} (expected 403)`);
      const y = await get(T.adminY, `/api/handoff-notes/team?venueId=${A1}`);
      if (y.status === 200) throw new Error('A other agency admin read the A1 team');
    }

    // ---- B: a tag pushes only the tagged person ----
    let pubNote;
    {
      await clearPush();
      pubNote = await created(await post(T.mashA1, { venueId: A1, content: '@Baruch Tagged the delivery came', shift: 'Morning', mentions: [id('mashA1b')] }), 'B');
      if (!pubNote.mentions || pubNote.mentions[0]?.id !== id('mashA1b') || pubNote.mentions[0]?.name !== 'Baruch Tagged') throw new Error('B mentions not stored with names');
      if (pubNote.private) throw new Error('B public note marked private');
      const p = await pushedTo();
      if (!sameSet(p.map((x) => x.who), ['mashA1b'])) throw new Error(`B push recipients ${JSON.stringify(p.map((x) => x.who))} (expected only mashA1b)`);
      if (!/Moshe Author tagged you/.test(p[0].title) || !/delivery came/.test(p[0].body)) throw new Error(`B push text: ${p[0].title} / ${p[0].body}`);
      if (!p[0].title.includes(`· T94 A1 ${ts}`)) throw new Error(`B push title must name the venue: ${p[0].title}`);
      for (const k of ['mashA1c', 'ownerA1', 'coordA1', 'adminX']) {
        const l = await list(T[k], `?venueId=${A1}`);
        if (!ids(l.list).includes(pubNote.id)) throw new Error(`B untagged ${k} must still see the public note`);
      }
      const o = await list(T.mashA2);
      if (ids(o.list).includes(pubNote.id)) throw new Error('B other-venue mashgiach sees an A1 note');
    }

    // ---- C: @All ----
    {
      await clearPush();
      await created(await post(T.mashA1, { venueId: A1, content: '@All fridge is fixed', shift: 'Evening', mentionAll: true }), 'C');
      const who = (await pushedTo()).map((x) => x.who);
      if (!sameSet(who, ['coordA1', 'mashA1b', 'mashA1c', 'ownerA1', 'mashMov'])) throw new Error(`C @All push recipients ${JSON.stringify(who)}`);
      await clearPush();
      await created(await post(T.mashA1, { venueId: A1, content: 'no tags here', shift: 'Evening' }), 'C2');
      if ((await pushedTo()).length !== 0) throw new Error('C2 an untagged note pushed someone');
    }

    // ---- D: validation ----
    {
      const r1 = await post(T.mashA1, { venueId: A1, content: 'x', mentions: [id('mashA2')] });
      if (r1.status !== 400 || (await r1.json()).code !== 'MENTION_NOT_ON_TEAM') throw new Error(`D other-venue tag: ${r1.status}`);
      const r1y = await post(T.mashA1, { venueId: A1, content: 'x', mentions: [id('adminY')] });
      if (r1y.status !== 400) throw new Error(`D other-agency tag: ${r1y.status}`);
      const r2 = await post(T.mashA1, { venueId: A1, content: 'x', private: true });
      if (r2.status !== 400 || (await r2.json()).code !== 'PRIVATE_NEEDS_TAG') throw new Error(`D private without tag: ${r2.status}`);
      const r3 = await post(T.mashA1, { venueId: A1, content: 'x', private: true, mentionAll: true, mentions: [id('mashA1b')] });
      if (r3.status !== 400 || (await r3.json()).code !== 'PRIVATE_NEEDS_TAG') throw new Error(`D private + @All: ${r3.status}`);
      const r4 = await post(T.mashA1, { venueId: A1, content: 'x', mentions: 'nope' });
      if (r4.status !== 400) throw new Error(`D bad mentions: ${r4.status}`);
      const r5 = await post(T.mashA1, { venueId: A1, content: 'x'.repeat(4001) });
      if (r5.status !== 400) throw new Error(`D too long: ${r5.status}`);
    }

    // ---- E: private ----
    // Kiosk on A1 with mashA1b (the TAGGED person) signed in — still never shown.
    for (const [uid, pin] of [[id('mashA1b'), '9411'], [id('mashA1c'), '9412']]) {
      const ver = await ctx.getVersion();
      const r = await fetch(`${baseUrl}/api/users/${uid}?expectedVersion=${ver}`, { method: 'PUT', headers: auth(T.adminX), body: JSON.stringify({ kioskPin: pin, expectedVersion: ver }) });
      if (r.status !== 200) throw new Error(`E set PIN: ${r.status}`);
    }
    deviceHeader = await pairDevice(baseUrl, T.adminX, A1);
    const kTok = await kioskLogin(baseUrl, id('mashA1b'), '9411');
    const socks = {};
    for (const k of ['mashA1b', 'mashA1c', 'coordA1', 'coordA2', 'ownerA1', 'adminX', 'mashA2']) socks[k] = await connectWs(baseUrl, T[k]);
    socks.kiosk = await connectWs(baseUrl, kTok, true);
    await clearPush();
    const privNote = await created(await post(T.mashA1, { venueId: A1, content: 'PRIVATE-T94 your keys are in the office', shift: 'Morning', mentions: [id('mashA1b')], private: true }), 'E');
    if (privNote.private !== true) throw new Error('E note not stored private');
    {
      const readers = ['mashA1', 'mashA1b', 'coordA1', 'adminX'];
      const others = ['mashA1c', 'ownerA1', 'coordA2', 'mashA2', 'adminY'];
      for (const k of readers) { const l = await list(T[k], `?venueId=${A1}`); if (!ids(l.list).includes(privNote.id)) throw new Error(`E reader ${k} must see the private note`); }
      for (const k of others) {
        for (const qs of ['', `?venueId=${A1}`]) { const l = await list(T[k], qs); if (JSON.stringify(l.list).includes('PRIVATE-T94')) throw new Error(`E non-reader ${k} sees the private note (${qs})`); }
      }
      const kl = await list(kTok, '', true);
      if (kl.status !== 200) throw new Error(`E kiosk list: ${kl.status}`);
      if (JSON.stringify(kl.list).includes('PRIVATE-T94')) throw new Error('E kiosk shows a private note');
      if (!ids(kl.list).includes(pubNote.id)) throw new Error('E kiosk must still show public notes');
      const who = (await pushedTo()).map((x) => x.who);
      if (!sameSet(who, ['mashA1b'])) throw new Error(`E private push recipients ${JSON.stringify(who)}`);
      const pp = (await pushedTo())[0];
      if (!/private/.test(pp.title)) throw new Error(`E private push title: ${pp.title}`);
      // K (TEAMNOTES2): the private push shows the text (Don: "like whatsapp"), marked private, with the venue.
      if (!pp.title.startsWith('🔒 Moshe Author tagged you (private) · T94 A1')) throw new Error(`K private push title: ${pp.title}`);
      if (pp.body !== 'PRIVATE-T94 your keys are in the office') throw new Error(`K private push body must be the note text: ${pp.body}`);
      // K: the kiosk count — the tagged person signed in on the tablet learns a number, nothing else.
      const kb = await get(kTok, '/api/handoff-notes', true);
      if (kb.status !== 200 || kb.body.privateForYou !== 1) throw new Error(`K kiosk privateForYou for the tagged person: ${kb.status} ${kb.body?.privateForYou} (expected 1)`);
      if (!sameSet(Object.keys(kb.body), ['notes', 'privateForYou'])) throw new Error(`K kiosk answer carries extra fields: ${Object.keys(kb.body)}`);
      const kbs = JSON.stringify(kb.body);
      if (kbs.includes('PRIVATE-T94') || kbs.includes(privNote.id)) throw new Error('K kiosk answer leaks the private note');
      const kTokC = await kioskLogin(baseUrl, id('mashA1c'), '9412');
      const kc = await get(kTokC, '/api/handoff-notes', true);
      if (kc.status !== 200 || kc.body.privateForYou !== 0) throw new Error(`K kiosk privateForYou for an untagged person: ${kc.body?.privateForYou} (expected 0)`);
      for (const k of ['mashA1b', 'mashA1', 'coordA1', 'adminX']) {
        const ph = await get(T[k], `/api/handoff-notes?venueId=${A1}`);
        if (ph.status !== 200 || 'privateForYou' in ph.body) throw new Error(`K phone answer for ${k} must not carry privateForYou`);
      }
      await sleep(600);
      const gotIt = (c) => c.messages.some((m) => m.type === 'HANDOFF_NOTE' && JSON.stringify(m.payload).includes('PRIVATE-T94'));
      for (const k of ['mashA1b', 'coordA1', 'adminX']) if (!gotIt(socks[k])) throw new Error(`E socket reader ${k} did not get the private note`);
      for (const k of ['mashA1c', 'coordA2', 'ownerA1', 'mashA2', 'kiosk']) if (gotIt(socks[k])) throw new Error(`E socket non-reader ${k} received the private note`);
      // RV2: a socket that connects AFTER the private note exists (INITIAL_STATE), staff + kiosk.
      const late = { mashA1c: await connectWs(baseUrl, T.mashA1c), ownerA1: await connectWs(baseUrl, T.ownerA1), kiosk: await connectWs(baseUrl, await kioskLogin(baseUrl, id('mashA1b'), '9411'), true) };
      await sleep(400);
      for (const [k, c] of Object.entries(late)) {
        if (JSON.stringify(c.messages).includes('PRIVATE-T94')) throw new Error(`E late socket ${k} (INITIAL_STATE etc.) carries the private note`);
        c.ws.close();
      }
      // RV2: media attached to the private note follows the note's rule on download.
      const seeded = await ctx.api('POST', '/api/__test__/media/seed-doc', { id: `media-t94-${ts}`, agencyId: AX, venueId: A1, state: 'COMMITTED', attachedTo: { entityType: 'handoff-note', entityId: privNote.id } });
      if (seeded.status === 200) {
        for (const k of ['mashA1c', 'ownerA1']) {
          const md = await get(T[k], `/api/media/media-t94-${ts}/download`);
          if (md.status !== 404) throw new Error(`E non-reader ${k} media download of a private note: ${md.status} (expected 404)`);
        }
        const mdB = await get(T.mashA1b, `/api/media/media-t94-${ts}/download`);
        if (mdB.status === 404 || mdB.status === 403) throw new Error(`E tagged reader media download refused: ${mdB.status}`);
      } else console.log(`  (media seed unavailable here: ${seeded.status})`);
      // F (part): marks + seen-by on the private note
      const mk = await fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T.mashA1c), body: JSON.stringify({ venueId: A1, noteIds: [privNote.id] }) });
      if (mk.status !== 200 || (await mk.json()).recorded !== 0) throw new Error('F a non-reader recorded a mark on a private note');
      const s404 = await get(T.mashA1c, `/api/handoff-notes/${privNote.id}/seen?venueId=${A1}`);
      if (s404.status !== 404) throw new Error(`F non-reader private seen-by: ${s404.status} (expected 404)`);
      const counts = await get(T.mashA1c, `/api/handoff-notes/seen?venueId=${A1}`);
      if (counts.status !== 200 || counts.body.counts.some((c) => c.id === privNote.id)) throw new Error('F non-reader got a count for a private note');
      const unread = await get(T.mashA1c, `/api/updates/unread?venueId=${A1}`);
      if ((unread.body.unreadNoteIds || []).includes(privNote.id)) throw new Error('F private note in a non-reader\'s unread ids');
      const unreadB = await get(T.mashA1b, `/api/updates/unread?venueId=${A1}`);
      if (!(unreadB.body.unreadNoteIds || []).includes(privNote.id)) throw new Error('F private note missing from the tagged person\'s unread ids');
      const mkB = await fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T.mashA1b), body: JSON.stringify({ venueId: A1, noteIds: [privNote.id] }) });
      if ((await mkB.json()).recorded !== 1) throw new Error('F tagged reader mark not recorded');
      // K: read on the phone -> the kiosk number for that person drops to 0.
      const kAfter = await get(await kioskLogin(baseUrl, id('mashA1b'), '9411'), '/api/handoff-notes', true);
      if (kAfter.status !== 200 || kAfter.body?.privateForYou !== 0) throw new Error(`K kiosk count after reading on the phone: ${kAfter.status} ${kAfter.body?.privateForYou} (expected 0)`);
      const sp = await get(T.coordA1, `/api/handoff-notes/${privNote.id}/seen?venueId=${A1}`);
      if (sp.status !== 200 || !sp.body.seen.some((r) => r.name === 'Baruch Tagged')) throw new Error(`F coordinator private seen-by: ${JSON.stringify(sp.body)}`);
      if (sp.body.notYet.some((r) => r.name === 'Chaim Untagged')) throw new Error('F private seen-by lists a non-reader');
      if (sp.body.total !== 1) throw new Error(`F private seen-by total must be the tagged people only (stable): ${sp.body.total}`);
      await fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T.coordA1), body: JSON.stringify({ venueId: A1, noteIds: [privNote.id] }) });
      const sp2 = await get(T.coordA1, `/api/handoff-notes/seen?venueId=${A1}`);
      const r2 = sp2.body.counts.find((c) => c.id === privNote.id);
      if (!r2 || r2.seen !== 1 || r2.total !== 1) throw new Error(`F a coordinator reading must not move the count: ${JSON.stringify(r2)}`);
      // delete (author): the delete event reaches readers only, stripped
      const dver = await ctx.getVersion();
      const del = await fetch(`${baseUrl}/api/handoff-notes/${privNote.id}?expectedVersion=${dver}`, { method: 'DELETE', headers: auth(T.mashA1) });
      if (del.status !== 200) throw new Error(`E delete: ${del.status}`);
      await sleep(600);
      const delMsg = (c) => c.messages.find((m) => m.type === 'HANDOFF_NOTE_DELETED' && m.payload?.id === privNote.id);
      const dB = delMsg(socks.mashA1b);
      if (!dB) throw new Error('E delete event missing for the tagged reader');
      if ('mentions' in dB.payload || 'authorEmail' in dB.payload) throw new Error('E delete event not stripped for a non-admin reader');
      for (const k of ['mashA1c', 'ownerA1', 'mashA2', 'coordA2', 'kiosk']) if (delMsg(socks[k])) throw new Error(`E delete event reached non-reader ${k}`);
      if (!delMsg(socks.coordA1)) throw new Error('E delete event missing for the venue coordinator');
    }
    // public-note socket: untagged team members DO get it (no push, but they see it)
    {
      const pn = await created(await post(T.mashA1, { venueId: A1, content: 'PUBLIC-T94 hello team', shift: 'Morning', mentions: [id('mashA1b')] }), 'E2');
      await sleep(600);
      const gotP = (c) => c.messages.some((m) => m.type === 'HANDOFF_NOTE' && JSON.stringify(m.payload).includes('PUBLIC-T94'));
      for (const k of ['mashA1b', 'mashA1c', 'ownerA1', 'coordA1', 'kiosk']) if (!gotP(socks[k])) throw new Error(`E2 public note socket missing for ${k}`);
      for (const k of ['mashA2', 'coordA2']) if (gotP(socks[k])) throw new Error(`E2 public note reached other venue ${k}`);
      void pn;
    }
    Object.values(socks).forEach((c) => c.ws.close());
    // K: a second private tag counts again for each tagged person; deleting it drops the number.
    {
      const kCount = async (uid, pin) => (await get(await kioskLogin(baseUrl, id(uid), pin), '/api/handoff-notes', true)).body?.privateForYou;
      const priv2 = await created(await post(T.coordA1, { venueId: A1, content: 'PRIVATE2-T94', mentions: [id('mashA1b'), id('mashA1c')], private: true }), 'K2');
      const k2 = await get(await kioskLogin(baseUrl, id('mashA1b'), '9411'), '/api/handoff-notes', true);
      const k2c = await kCount('mashA1c', '9412');
      if (k2.body?.privateForYou !== 1 || k2c !== 1) throw new Error(`K second private tag: ${k2.body?.privateForYou}/${k2c} (expected 1/1)`);
      if (JSON.stringify(k2.body).includes('PRIVATE2-T94') || JSON.stringify(k2.body).includes(priv2.id)) throw new Error('K kiosk answer leaks the second private note');
      const mk = await fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T.mashA1c), body: JSON.stringify({ venueId: A1, noteIds: [priv2.id] }) });
      if (mk.status !== 200 || (await mk.json()).recorded !== 1) throw new Error('K tagged reader mark not recorded');
      const after = [await kCount('mashA1c', '9412'), await kCount('mashA1b', '9411')];
      if (after[0] !== 0 || after[1] !== 1) throw new Error(`K reading on the phone must drop only the reader's number: ${after} (expected 0,1)`);
      const dv = await ctx.getVersion();
      const del = await fetch(`${baseUrl}/api/handoff-notes/${priv2.id}?expectedVersion=${dv}`, { method: 'DELETE', headers: auth(T.coordA1) });
      if (del.status !== 200) throw new Error(`K cleanup delete: ${del.status}`);
      const k3 = await kCount('mashA1b', '9411');
      if (k3 !== 0) throw new Error(`K deleted private note still counted: ${k3}`);
    }

    // ---- F: seen-by on a public note, for any team member ----
    {
      const mk = await fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: auth(T.mashA1b), body: JSON.stringify({ venueId: A1, noteIds: [pubNote.id] }) });
      if (mk.status !== 200) throw new Error(`F mark: ${mk.status}`);
      const s = await get(T.mashA1c, `/api/handoff-notes/${pubNote.id}/seen?venueId=${A1}`);
      if (s.status !== 200) throw new Error(`F mashgiach seen-by: ${s.status}`);
      if (!s.body.seen.some((r) => r.name === 'Baruch Tagged')) throw new Error('F seen list missing the reader');
      if (!s.body.notYet.some((r) => r.name === 'Chaim Untagged') || !s.body.notYet.some((r) => r.name === 'Ora Owner')) throw new Error('F not-yet list incomplete');
      if (s.body.notYet.some((r) => r.name === 'Moshe Author') || s.body.seen.some((r) => r.name === 'Moshe Author')) throw new Error('F author counted as a reader');
      if (s.body.notYet.some((r) => r.name === 'Ada Admin' || r.name === 'Dov OtherVenue' || r.name === 'Cal Coord')) throw new Error('F not-yet lists people outside the venue team');
      if (JSON.stringify(s.body).includes('@test.local') || JSON.stringify(s.body).includes('user-t94')) throw new Error('F seen-by leaked emails or ids');
      const c = await get(T.mashA1c, `/api/handoff-notes/seen?venueId=${A1}`);
      const row = c.body.counts.find((x) => x.id === pubNote.id);
      if (!row || row.seen !== 1 || row.total !== s.body.total) throw new Error(`F counts: ${JSON.stringify(row)} total ${s.body.total}`);
      const o = await get(T.mashA2, `/api/handoff-notes/${pubNote.id}/seen?venueId=${A1}`);
      if (o.status !== 403) throw new Error(`F other venue seen-by: ${o.status} (expected 403)`);
      const o2 = await get(T.mashA2, `/api/handoff-notes/${pubNote.id}/seen?venueId=${A2}`);
      if (o2.status !== 404) throw new Error(`F other venue via own venue: ${o2.status} (expected 404)`);
      const ks = await get(kTok, `/api/handoff-notes/seen?venueId=${A1}`, true);
      if (ks.status !== 403) throw new Error(`F kiosk seen-by: ${ks.status} (expected 403)`);
    }
    // ---- G (RV1): an author moved off the venue cannot delete; dashboard uses the note rule + public shape ----
    {
      const pv = await created(await post(T.mashMov, { venueId: A1, content: 'MOVER-PRIV-T94', mentions: [id('mashA1b')], private: true }), 'G1');
      const pb = await created(await post(T.mashMov, { venueId: A1, content: 'MOVER-PUB-T94' }), 'G2');
      const pushedPriv = (await pushedTo()).filter((x) => x.who === 'mashA1b').pop();
      // TEAMNOTES2: the private push now carries the text (Don: "like whatsapp"), to its reader only.
      if (!pushedPriv || pushedPriv.body !== 'MOVER-PRIV-T94' || !/\(private\)/.test(pushedPriv.title)) throw new Error(`G private push: ${JSON.stringify(pushedPriv)}`);
      if ((await pushedTo()).some((x) => x.body === 'MOVER-PRIV-T94' && x.who !== 'mashA1b')) throw new Error('G private text pushed to a non-reader');
      const dash = await get(T.coordA1, '/api/admin/dashboard');
      if (dash.status !== 200) throw new Error(`G dashboard: ${dash.status}`);
      if (/"readBy"\s*:/.test(JSON.stringify(dash.body))) throw new Error('G dashboard leaked readBy');
      if (!JSON.stringify(dash.body).includes('MOVER-PUB-T94')) throw new Error('G dashboard missing the A1 recent note for the A1 coordinator');
      const dash2 = await get(T.coordA2, '/api/admin/dashboard');
      if (JSON.stringify(dash2.body).includes('MOVER-')) throw new Error('G another venue coordinator sees A1 notes on the dashboard');
      const ver = await ctx.getVersion();
      const mv = await fetch(`${baseUrl}/api/users/${id('mashMov')}?expectedVersion=${ver}`, { method: 'PUT', headers: auth(T.adminX), body: JSON.stringify({ venueId: A2, expectedVersion: ver }) });
      if (mv.status !== 200) throw new Error(`G move author to A2: ${mv.status} ${await mv.text()}`);
      for (const n of [pv, pb]) {
        const v = await ctx.getVersion();
        const d = await fetch(`${baseUrl}/api/handoff-notes/${n.id}?expectedVersion=${v}`, { method: 'DELETE', headers: auth(T.mashMov) });
        if (d.status !== 403) throw new Error(`G moved author deleted ${n.content}: ${d.status} (expected 403)`);
      }
      const l = await list(T.mashMov, '');
      if (JSON.stringify(l.list).includes('MOVER-')) throw new Error('G moved author still reads the A1 notes');
      const v2 = await ctx.getVersion();
      const dc = await fetch(`${baseUrl}/api/handoff-notes/${pv.id}?expectedVersion=${v2}`, { method: 'DELETE', headers: auth(T.coordA1) });
      if (dc.status !== 200) throw new Error(`G venue coordinator delete: ${dc.status}`);
    }
    // ---- H (RV2): tags and the author are re-checked on the FRESH document ----
    {
      const docUsers = (await ctx.getDoc()).users;
      const moved = (uid) => docUsers.map((u) => (u && u.id === uid ? { ...u, venueId: A2 } : u));
      // stored doc only: mashA1b moved to A2, the cache still has A1
      let r = await ctx.api('POST', '/api/__test__/doc-set-users', { users: moved(id('mashA1b')) });
      if (r.status !== 200) throw new Error(`H doc-set-users: ${r.status}`);
      await clearPush();
      const p1 = await post(T.mashA1, { venueId: A1, content: 'RACE-T94 tag', mentions: [id('mashA1b')], private: true });
      const b1 = await p1.json();
      if (p1.status !== 400 || b1.code !== 'MENTION_NOT_ON_TEAM') throw new Error(`H stale tag passed the commit: ${p1.status} ${JSON.stringify(b1)}`);
      if ((await pushedTo()).length) throw new Error('H a refused note pushed someone');
      r = await ctx.api('POST', '/api/__test__/doc-set-users', { users: moved(id('mashA1')) });
      const p2 = await post(T.mashA1, { venueId: A1, content: 'RACE-T94 author' });
      if (p2.status !== 403) throw new Error(`H author moved in the fresh doc still posted: ${p2.status}`);
      // RV3: DELETE re-checks on the fresh doc too — the author (moved in the stored doc only) cannot delete.
      const own = (await (await fetch(`${baseUrl}/api/handoff-notes?venueId=${A1}`, { headers: auth(T.mashA1) })).json()).notes.find((n) => n.authorName === 'Moshe Author');
      const dv = await ctx.getVersion();
      const dd = await fetch(`${baseUrl}/api/handoff-notes/${own.id}?expectedVersion=${dv}`, { method: 'DELETE', headers: auth(T.mashA1) });
      if (dd.status !== 403) throw new Error(`H author moved in the fresh doc still deleted: ${dd.status}`);
      await ctx.api('POST', '/api/__test__/doc-set-users', { users: docUsers });
      const dv2 = await ctx.getVersion();
      const dd2 = await fetch(`${baseUrl}/api/handoff-notes/${own.id}?expectedVersion=${dv2}`, { method: 'DELETE', headers: auth(T.mashA1) });
      if (dd2.status !== 200) throw new Error(`H author delete after the roster is restored: ${dd2.status}`);
      const p3 = await post(T.mashA1, { venueId: A1, content: 'RACE-T94 ok', mentions: [id('mashA1b')] });
      if (p3.status !== 200) throw new Error(`H restored roster: ${p3.status}`);
    }
    return 'tags push only the tagged (with the text; private marked private); @All the venue team; private visible only to author/tagged/admins/coordinators on REST, socket, kiosk, push, delete; kiosk gets only an unread private count for its signed-in person; seen-by for the team';
  },
};
