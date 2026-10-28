/**
 * Test 92 (CHECKINPHOTO, Don Oct 28 2026 "Sure do it"): check-in photos ("Log
 * check with photo evidence") go to the separate photo store (taskPhotos, as
 * the #176 answer photos; own collection checkInPhotos), never inline in the shared document. The check-in
 * keeps only a reference (photoId + who + when). Old check-ins that already
 * carry inline base64 still show exactly as before.
 * Proves:
 *  A  a venue mashgiach logs a check with a photo → 200; the check-in has a
 *     cph- photoId, no photoData; the shared document holds no photo bytes
 *     (3 photos of 300 000 chars grow it by < 3 KiB); 900 KiB guard unchanged
 *  B  GET /api/tasks/:id/check-in/:checkInId/photo returns the same bytes to
 *     the logger, the venue coordinator, a no-fill owner, the admin; refused
 *     to another venue (403), another agency (403), no session (401), and on
 *     someone else's private task (403)
 *  C  uploads refused (fail closed) and NOTHING is stored: another venue's
 *     mashgiach, an owner without fill, canFillTasks:false, another agency's
 *     admin → 403; no session → 401 (the sweep finds no orphan bytes)
 *     (who may log a check at all is unchanged by this PR)
 *  D  an OLD check-in with inline base64 is untouched and still served (task
 *     payload + the photo route); a new check-in next to it does not change it
 *  E  a photo problem never loses the check-in: over the cap, an svg, or a
 *     save past the deadline → 200, check logged WITHOUT a photo (no photoId,
 *     no photoData); the late save's bytes are swept after the grace
 *  F  removing a check-in removes its stored bytes; the sweep keeps photos a
 *     check-in still references
 *  H  kiosk: a tablet session logs a check with a photo on its venue and reads
 *     it back; another venue's task → 403 KIOSK_SCOPE
 *  Q  (RV1) the answer-photo sweep — all an older server revision knows (rolling
 *     deploy / rollback) — never removes a check-in photo (own collection)
 *  R  (RV1) the commit re-checks the caller on FRESH data: lost fill permission,
 *     moved to another venue, removed, (RV2) tablet PIN cleared or changed →
 *     refused, nothing logged
 *  V  (RV3) a photo read on an instance whose cache has not seen the check-in
 *     yet is answered from the STORED document (gate still applies); a failed
 *     stored read is 503 (the viewer retries), never a terminal "no photo"
 *  S  (RV1) a failing or stuck photo store never holds or loses the check-in:
 *     logged without the photo (bounded wait); late bytes swept after the grace
 */
import fs from 'node:fs';

const A = 'agency-test92-a';
const B = 'agency-test92-b';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return `${claimed.device.id}.${deviceSecret}`;
}

/** A valid JPEG data URL of exactly `chars` characters (base64 body padded with 'A'). */
function jpeg(chars, seed = 'x') {
  const head = 'data:image/jpeg;base64,/9j/4AAQSkZJRgCI' + Buffer.from(seed).toString('base64').replace(/=/g, '');
  return head + 'A'.repeat(Math.max(0, chars - head.length));
}

export default {
  name: 'Test 92: check-in photos in the separate photo store (CHECKINPHOTO)',
  whatItProves:
    'A check-in photo is stored outside the shared document (the check-in keeps only a reference), read back behind the task\'s own visibility, refused for everyone who may not log the check, old inline photos still served, and a photo problem never loses the check-in.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const v1 = `venue-t92-1-${ts}`, v2 = `venue-t92-2-${ts}`, vb = `venue-t92-b-${ts}`;
    const id = (k) => `user-t92-${k}-${ts}`;
    const em = (k) => `t92-${k}-${ts}@test.local`;
    const PIN = '5826';
    const people = [
      { id: id('admin'), email: em('admin'), name: 'T92 Admin', role: 'admin', agencyId: A },
      { id: id('coord'), email: em('coord'), name: 'T92 Coord', role: 'coordinator', agencyId: A, venueId: v1 },
      { id: id('mash'), email: em('mash'), name: 'T92 Mash', role: 'mashgiach', agencyId: A, venueId: v1, kioskPin: PIN },
      { id: id('nofill'), email: em('nofill'), name: 'T92 NoFill', role: 'mashgiach', agencyId: A, venueId: v1, permissions: { canFillTasks: false } },
      { id: id('owner'), email: em('owner'), name: 'T92 Owner', role: 'owner', agencyId: A, venueId: v1 },
      { id: id('mashv2'), email: em('mashv2'), name: 'T92 Mash V2', role: 'mashgiach', agencyId: A, venueId: v2 },
      { id: id('adminb'), email: em('adminb'), name: 'T92 Admin B', role: 'admin', agencyId: B },
    ];
    // Not the jpeg() prefix: test 90 checks that prefix is nowhere in the document.
    const OLD = 'data:image/png;base64,T0xEUEhPVE8' + 'B'.repeat(5000);
    const oldCheckIn = { id: `checkin-t92-old-${ts}`, byName: 'T92 Mash', byEmail: em('mash'), at: new Date(ts - 60000).toISOString(), photoData: OLD, photoCaption: 'old seal' };
    const task = (k, extra = {}) => ({
      id: `task-t92-${k}-${ts}`, agencyId: A, venueId: v1, title: `T92 ${k}`, category: 'General', categories: ['General'],
      inputType: 'check_in', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false,
      notes: '', assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0, checkIns: [], ...extra,
    });
    const T = {
      ci: task('ci'),
      old: task('old', { checkIns: [oldCheckIn] }),
      prob: task('prob'),
      priv: task('priv', { isPrivate: true, assignedTo: [em('coord')] }),
      v2: task('v2', { venueId: v2 }),
    };
    const doc0 = await ctx.getDoc();
    const park = { ...(doc0.venueWorkDates || {}), [v1]: '2099-12-31', [v2]: '2099-12-31', [vb]: '2099-12-31' };
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T92 A ${ts}` }, { id: B, name: `T92 B ${ts}` }],
      venues: [
        { id: v1, name: `T92 V1 ${ts}`, agencyId: A },
        { id: v2, name: `T92 V2 ${ts}`, agencyId: A },
        { id: vb, name: `T92 VB ${ts}`, agencyId: B },
      ],
      users: people,
      tasks: Object.values(T),
      venueWorkDates: park,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const p of people) tok[p.id.replace('user-t92-', '').replace(`-${ts}`, '')] = auth(await mintToken(baseUrl, p.id));

    const logCheck = async (taskId, headers, body) => {
      const r = await fetch(`${baseUrl}/api/tasks/${taskId}/check-in`, { method: 'POST', headers: headers || { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const getPhoto = async (taskId, checkInId, headers) => {
      const r = await fetch(`${baseUrl}/api/tasks/${taskId}/check-in/${checkInId}/photo`, { headers: headers || {} });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const removeCheck = async (taskId, checkInId, headers) => {
      const ver = await ctx.getVersion();
      const r = await fetch(`${baseUrl}/api/tasks/${taskId}/check-in/${checkInId}?expectedVersion=${ver}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: ver }) });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const sweep = async (later) => {
      const r = await ctx.api('POST', '/api/__test__/checkin-photo-sweep', { nowMs: Date.now() + (later ? 60 * 60 * 1000 : 0) });
      assert(r.status === 200, `sweep: ${r.status}`);
      return r.json.removed;
    };
    const taskInDoc = async (taskId) => ((await ctx.getDoc()).tasks || []).find((t) => t.id === taskId);
    const docBytes = async () => JSON.stringify(await ctx.getDoc()).length;
    const newest = (json) => (json?.checkIns || [])[(json?.checkIns || []).length - 1];
    const out = [];

    // Start from a store with no orphans (earlier tests may have left some past the grace).
    await sweep(true);

    // ---- A: stored outside the document ---------------------------------------------
    const before = await docBytes();
    const photos = [];
    for (let i = 0; i < 3; i++) {
      const data = jpeg(300_000, `a${i}`);
      const r = await logCheck(T.ci.id, tok.mash, { photoData: data, photoCaption: i === 0 ? 'walk-in seal' : undefined });
      assert(r.status === 200, `A${i}: POST ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      const c = newest(r.json);
      assert(c && /^cph-[0-9a-f-]{36}$/.test(c.photoId || '') && c.photoData === undefined, `A${i}: the check-in has a photoId and no bytes: ${JSON.stringify(c)?.slice(0, 200)}`);
      assert(c.byEmail === em('mash') && c.byName === 'T92 Mash' && !isNaN(Date.parse(c.at)), `A${i}: who/when`);
      if (i === 0) assert(c.photoCaption === 'walk-in seal', 'A0: caption kept on the check-in');
      assert(JSON.stringify(r.json).length < 4000, `A${i}: the task response carries no bytes`);
      photos.push({ checkInId: c.id, photoId: c.photoId, data });
    }
    const after = await docBytes();
    const dt = await taskInDoc(T.ci.id);
    assert(dt.checkIns.length === 3 && dt.checkIns.every((c) => c.photoId && c.photoData === undefined), `A: the document's check-ins carry only references: ${JSON.stringify(dt.checkIns).slice(0, 300)}`);
    assert(!JSON.stringify(await ctx.getDoc()).includes('/9j/4AAQSkZJRgCIYT'), 'A: no new photo bytes anywhere in the shared document');
    assert(after - before < 3072, `A: 900 000 chars of photos grew the document by ${after - before} bytes (want < 3072)`);
    const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    assert(src.includes('const SIZE_LIMIT_BYTES = 900 * 1024;') && src.includes('throw new DocumentTooLargeError(payloadSize, SIZE_LIMIT_BYTES);'), 'A: the 900 KiB guard is unchanged');
    assert(!/photoData\.slice\(0, 500000\)/.test(src), 'A: no silent 500 000-char cut left');
    out.push(`A 3 photos, doc +${after - before} B`);

    // ---- B: reads follow the task's visibility ----------------------------------------
    const p0 = photos[0];
    for (const [label, h, want] of [['logger', tok.mash, 200], ['coordinator', tok.coord, 200], ['owner (no fill)', tok.owner, 200], ['admin', tok.admin, 200], ['other venue', tok.mashv2, 403], ['other agency', tok.adminb, 403], ['no session', undefined, 401]]) {
      const g = await getPhoto(T.ci.id, p0.checkInId, h);
      assert(g.status === want, `B ${label}: GET want ${want}, got ${g.status} ${JSON.stringify(g.json)?.slice(0, 120)}`);
      if (want === 200) assert(g.json.photoData === p0.data && g.json.id === p0.photoId, `B ${label}: the same bytes`);
    }
    assert((await getPhoto(T.ci.id, 'checkin-nope', tok.mash)).status === 404, 'B: unknown check-in → 404');
    const pc = await logCheck(T.priv.id, tok.coord, { photoData: jpeg(2000, 'priv') });
    assert(pc.status === 200 && newest(pc.json)?.photoId, `B: the private task's coordinator logs with a photo (${pc.status})`);
    assert((await getPhoto(T.priv.id, newest(pc.json).id, tok.mash)).status === 403, "B: someone else's private task → 403");
    assert((await getPhoto(T.priv.id, newest(pc.json).id, tok.coord)).status === 200, 'B twin: its assignee reads it');
    out.push('B reads');

    // ---- C: uploads refused, nothing stored -------------------------------------------
    const small = jpeg(3000, 'c');
    const refusals = [
      ['other venue mashgiach', T.ci.id, tok.mashv2, 403],
      ['owner without fill', T.ci.id, tok.owner, 403],
      ['canFillTasks:false', T.ci.id, tok.nofill, 403],
      ['other agency admin', T.ci.id, tok.adminb, 403],
      ['no session', T.ci.id, undefined, 401],
    ];
    const countBefore = (await taskInDoc(T.ci.id)).checkIns.length;
    for (const [label, taskId, h, want] of refusals) {
      const r = await logCheck(taskId, h, { photoData: small });
      assert(r.status === want, `C ${label}: want ${want}, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
    }
    assert((await taskInDoc(T.ci.id)).checkIns.length === countBefore, 'C: no check-in was added by a refusal');
    const orphans = await sweep(true);
    assert(orphans === 0, `C: a refused upload stored no bytes (the sweep found ${orphans} orphan(s))`);
    const pa = await logCheck(T.v2.id, tok.admin, { photoData: small });
    assert(pa.status === 200 && newest(pa.json)?.photoId, `C twin: the agency admin logs with a photo at any venue (${pa.status})`);
    out.push('C 5 refusals, 0 bytes stored');

    // ---- D: old inline photos untouched and still served ---------------------------------
    const od = await taskInDoc(T.old.id);
    assert(od.checkIns.length === 1 && od.checkIns[0].photoData === OLD && !od.checkIns[0].photoId, 'D: the old inline check-in is in the document as it was');
    const og = await getPhoto(T.old.id, oldCheckIn.id, tok.coord);
    assert(og.status === 200 && og.json.photoData === OLD, `D: the photo route serves the old inline photo (${og.status})`);
    const tl = await fetch(`${baseUrl}/api/tasks?venueId=${v1}`, { headers: tok.mash });
    const tlj = await tl.json().catch(() => null);
    const listed = (Array.isArray(tlj) ? tlj : (tlj?.tasks || [])).find((t) => t.id === T.old.id);
    assert(listed && listed.checkIns?.[0]?.photoData === OLD, `D: the task list still carries the old inline photo (${tl.status})`);
    const on = await logCheck(T.old.id, tok.mash, { photoData: small });
    assert(on.status === 200 && on.json.checkIns.length === 2 && on.json.checkIns[0].photoData === OLD && on.json.checkIns[1].photoId && !on.json.checkIns[1].photoData, 'D: a new check-in beside it is stored outside; the old one is unchanged');
    out.push('D old inline served');

    // ---- E: a photo problem never loses the check-in --------------------------------------
    for (const [label, photoData] of [['over the cap', jpeg(400_001, 'big')], ['svg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='], ['junk', 'hello'], ['number', 7]]) {
      const n0 = (await taskInDoc(T.prob.id)).checkIns.length;
      const r = await logCheck(T.prob.id, tok.mash, { photoData });
      const c = newest(r.json);
      assert(r.status === 200 && c && !c.photoId && c.photoData === undefined && r.json.checkIns.length === n0 + 1, `E ${label}: check logged without a photo (${r.status} ${JSON.stringify(c)?.slice(0, 160)})`);
    }
    const capOk = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(400_000, 'cap') });
    assert(capOk.status === 200 && newest(capOk.json)?.photoId, 'E: exactly at the cap (400 000) is kept');
    const plain = await logCheck(T.prob.id, tok.mash, {});
    assert(plain.status === 200 && !newest(plain.json).photoId && newest(plain.json).photoData === undefined, 'E: a check without a photo is as before');
    // slow save: past the deadline the reference is never published, the check still is
    const hk = await ctx.api('POST', '/api/__test__/answer-photo-hooks', { clockSkewMs: 6 * 60 * 1000 });
    assert(hk.status === 200, `E: hooks ${hk.status}`);
    let late;
    try { late = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(2500, 'late') }); }
    finally { await ctx.api('POST', '/api/__test__/answer-photo-hooks', { clockSkewMs: 0 }); }
    assert(late.status === 200 && newest(late.json) && !newest(late.json).photoId, `E: a save past the deadline logs the check without the photo (${late.status})`);
    assert((await sweep(false)) === 0, 'E: the late bytes are kept inside the grace');
    assert((await sweep(true)) >= 1, 'E: the late (unreferenced) bytes are swept after the grace');
    out.push('E problems keep the check');

    // ---- F: remove + sweep keeps referenced -------------------------------------------------
    assert((await sweep(true)) === 0, 'F: the sweep keeps every photo a check-in references');
    for (const p of photos) assert((await getPhoto(T.ci.id, p.checkInId, tok.mash)).json?.photoData === p.data, 'F: referenced photos survive the sweep');
    const rm = await removeCheck(T.ci.id, photos[1].checkInId, tok.mash);
    assert(rm.status === 200 && !rm.json.checkIns.some((c) => c.id === photos[1].checkInId), `F: remove ${rm.status} ${JSON.stringify(rm.json)?.slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 300));
    assert((await sweep(true)) === 0, 'F: the removed check-in\'s bytes were already deleted (nothing left for the sweep)');
    assert((await getPhoto(T.ci.id, photos[0].checkInId, tok.mash)).status === 200, 'F: the other photos stay');
    out.push('F remove deletes bytes');

    // ---- H: kiosk -------------------------------------------------------------------------------
    const device = await pairDevice(baseUrl, (tok.admin.Authorization || '').replace('Bearer ', ''), v1);
    const kl = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': device }, body: JSON.stringify({ userId: id('mash'), pin: PIN }) });
    const klj = await kl.json();
    assert(kl.status === 200 && klj.token, `H: kiosk login ${kl.status}`);
    const K = { ...auth(klj.token), 'X-Kiosk-Device': device };
    const kdata = jpeg(4000, 'kiosk');
    const kp = await logCheck(T.ci.id, K, { photoData: kdata });
    const kc = newest(kp.json);
    assert(kp.status === 200 && kc?.photoId && kc.photoData === undefined && kc.byEmail === em('mash'), `H: kiosk logs with a photo on its venue (${kp.status} ${JSON.stringify(kc)?.slice(0, 160)})`);
    const kg = await getPhoto(T.ci.id, kc.id, K);
    assert(kg.status === 200 && kg.json.photoData === kdata, `H: the tablet reads it back (${kg.status})`);
    const kv2 = await logCheck(T.v2.id, K, { photoData: small });
    assert(kv2.status === 403 && kv2.json?.code === 'KIOSK_SCOPE', `H: kiosk on another venue → 403 KIOSK_SCOPE, got ${kv2.status}`);
    const kgv2 = await getPhoto(T.v2.id, newest(pa.json).id, K);
    assert(kgv2.status === 403, `H: kiosk cannot read another venue's check-in photo (${kgv2.status})`);
    assert(!JSON.stringify(await ctx.getDoc()).includes('/9j/4AAQSkZJRgCIa2lvc2s'), 'H: no kiosk photo bytes in the shared document');
    out.push('H kiosk');

    // ---- Q: an older revision's sweep (answer photos only) leaves check-in photos alone ----
    const oldSweep = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() + 60 * 60 * 1000 });
    assert(oldSweep.status === 200, `Q: answer-photo sweep ${oldSweep.status}`);
    for (const p of [photos[0], photos[2]]) assert((await getPhoto(T.ci.id, p.checkInId, tok.mash)).json?.photoData === p.data, 'Q: check-in photos survive the answer-photo sweep');
    assert((await getPhoto(T.ci.id, kc.id, tok.mash)).status === 200, 'Q: the kiosk photo survives too');
    out.push('Q old sweep safe');

    // ---- R: the commit re-checks the caller on FRESH data (stored doc changes, cache does not) ----
    const storedUsers = (await ctx.getDoc()).users;
    const setUsers = async (users) => {
      const r = await ctx.api('POST', '/api/__test__/doc-set-users', { users });
      assert(r.status === 200, `doc-set-users: ${r.status}`);
    };
    const mid = id('mash');
    const fresh = [
      ['lost fill permission', storedUsers.map((u) => (u.id === mid ? { ...u, permissions: { ...(u.permissions || {}), canFillTasks: false } } : u))],
      ['moved to another venue', storedUsers.map((u) => (u.id === mid ? { ...u, venueId: v2, ...(u.venueAccess ? { venueAccess: [v2] } : {}) } : u))],
      ['removed from the agency', storedUsers.filter((u) => u.id !== mid)],
    ];
    const rCodes = [];
    try {
      for (const [why, users] of fresh) {
        const n0 = (await taskInDoc(T.prob.id)).checkIns.length;
        await setUsers(users);
        const r = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(2200, `fresh-${why}`) });
        rCodes.push(r.status);
        assert([401, 403, 409].includes(r.status), `R ${why}: refused on fresh data, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
        await setUsers(storedUsers);
        assert((await taskInDoc(T.prob.id)).checkIns.length === n0, `R ${why}: nothing logged`);
      }
    } finally { await setUsers(storedUsers); }
    // RV2: a kiosk PIN cleared or changed while the photo was stored revokes the tablet session too.
    const mrow = storedUsers.find((u) => u.id === mid);
    assert(mrow?.kioskPinHash && Number.isInteger(mrow.kioskPinRev), 'R: the kiosk login left a PIN hash and revision on the stored row');
    const kioskFresh = [
      ['kiosk PIN cleared', storedUsers.map((u) => (u.id === mid ? { ...u, kioskPinHash: undefined, kioskPin: undefined, kioskPinRev: (u.kioskPinRev || 0) + 1 } : u))],
      ['kiosk PIN changed', storedUsers.map((u) => (u.id === mid ? { ...u, kioskPinRev: (u.kioskPinRev || 0) + 1 } : u))],
    ];
    try {
      for (const [why, users] of kioskFresh) {
        const n0 = (await taskInDoc(T.ci.id)).checkIns.length;
        await setUsers(users);
        const r = await logCheck(T.ci.id, K, { photoData: jpeg(2200, `fresh-${why}`) });
        rCodes.push(r.status);
        assert([401, 403, 409].includes(r.status), `R ${why}: refused on fresh data, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
        await setUsers(storedUsers);
        assert((await taskInDoc(T.ci.id)).checkIns.length === n0, `R ${why}: nothing logged`);
      }
    } finally { await setUsers(storedUsers); }
    const rk = await logCheck(T.ci.id, K, { photoData: jpeg(2200, 'fresh-kiosk-ok') });
    assert(rk.status === 200 && newest(rk.json)?.photoId, `R twin: kiosk PIN unchanged → logs with a photo (${rk.status})`);
    const rOk = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(2200, 'fresh-ok') });
    assert(rOk.status === 200 && newest(rOk.json)?.photoId, `R twin: restored → logs with a photo (${rOk.status})`);
    out.push(`R fresh gate ${rCodes.join(',')}`);

    // ---- S: a failing / stuck store: the check is logged without the photo, quickly ----
    const hooks = async (h) => { const r = await ctx.api('POST', '/api/__test__/checkin-photo-hooks', h); assert(r.status === 200, `hooks ${r.status}`); };
    try {
      await hooks({ failStore: true });
      const sf = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(2400, 'fail') });
      assert(sf.status === 200 && newest(sf.json) && !newest(sf.json).photoId && newest(sf.json).photoData === undefined, `S: store failing → check logged without the photo (${sf.status})`);
      await hooks({ storeDelayMs: 1500, storeTimeoutMs: 300 });
      const t0 = Date.now();
      const ss = await logCheck(T.prob.id, tok.mash, { photoData: jpeg(2400, 'stuck') });
      const took = Date.now() - t0;
      assert(ss.status === 200 && newest(ss.json) && !newest(ss.json).photoId, `S: store stuck → check logged without the photo (${ss.status})`);
      assert(took < 1400, `S: the check did not wait for the stuck store (${took} ms)`);
    } finally { await hooks({}); }
    await new Promise((r) => setTimeout(r, 1800)); // the stuck write lands late, unreferenced
    assert((await sweep(false)) === 0, 'S: late bytes kept inside the grace');
    assert((await sweep(true)) >= 1, 'S: late (unreferenced) bytes swept after the grace');
    out.push(`S store fail/stuck keep the check`);

    // ---- V (RV3): an instance whose cache has not seen the check-in yet answers from the STORED doc ----
    const pv = photos[0];
    try {
      await hooks({ staleCheckInIds: [pv.checkInId] });
      const v1 = await getPhoto(T.ci.id, pv.checkInId, tok.mash);
      assert(v1.status === 200 && v1.json?.photoData === pv.data, `V: cache behind → served from the stored document (${v1.status})`);
      const vb = await getPhoto(T.ci.id, pv.checkInId, tok.adminb);
      assert(vb.status === 403 || vb.status === 404, `V: the task gate still applies on that path (other agency ${vb.status})`);
      await hooks({ staleCheckInIds: [pv.checkInId], failStoredRead: true });
      const v2 = await getPhoto(T.ci.id, pv.checkInId, tok.mash);
      assert(v2.status === 503, `V: cache behind and the stored read fails → 503 (try again), never "no photo" (${v2.status})`);
      const v3 = await getPhoto(T.ci.id, 'checkin-nope', tok.mash);
      assert(v3.status === 503, `V: unknown check-in while the stored read fails → 503 (${v3.status})`);
      const v4 = await getPhoto(T.ci.id, photos[2].checkInId, tok.mash);
      assert(v4.status === 200, `V: a check-in the cache has needs no stored read (${v4.status})`);
      await hooks({});
      const v5 = await getPhoto(T.ci.id, 'checkin-nope', tok.mash);
      assert(v5.status === 404, `V: confirmed absent in the stored document → 404 (${v5.status})`);
      const v6 = await getPhoto(T.ci.id, pv.checkInId, tok.mash);
      assert(v6.status === 200 && v6.json?.photoData === pv.data, 'V: cache caught up → served as before');
    } finally { await hooks({}); }
    out.push('V stale cache → stored doc / 503');

    return out.join('; ');
  },
};
