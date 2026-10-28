/**
 * Test 90 (PHOTOALL, Don 8:04 PM Oct 27, 2026): "The log check has the ability
 * to add pictures. Add this option for all the types of checks / yes or no."
 *
 * ONE optional photo on a toggle / yes_no / status_select / checkbox task:
 * POST/GET/DELETE /api/tasks/:id/answer-photo. The bytes live OUTSIDE
 * app-state/main (taskPhotos/{taskId}__{photoId}); the task carries only a
 * small reference (id, who, when, caption).
 * Proves:
 *  A  a venue mashgiach attaches a photo to each of the 4 types → 200, the
 *     reference has who/when/caption, and GET returns the same bytes
 *  B  the shared document holds NO photo bytes: 4 photos at the cap (1.6 M
 *     base64 chars — far over 900 KiB if inline) grow it by < 4 KiB; the
 *     900 KiB guard in server.ts is unchanged
 *  C  refused (fail closed) and nothing changes: another venue's mashgiach,
 *     an owner without fill permission, a mashgiach with canFillTasks:false,
 *     another agency's admin, a private task of someone else, no session
 *  D  reads follow task visibility: the venue coordinator and a no-fill owner
 *     may view; another venue / another agency may not
 *  E  size cap: 400 000 chars OK, 400 001 → 413 MEDIA_TOO_LARGE (no silent
 *     cut); not an image / svg / junk → 400; caption trimmed to 200
 *  F  check_in tasks: answer-photo → 400; the check-in photo path unchanged
 *  G  replace = one photo per task (old bytes gone); DELETE ?photoId of an
 *     old photo is a no-op; DELETE removes; the sweep drops unreferenced
 *     bytes (a deleted task's) after the grace and keeps referenced ones
 *  H  kiosk: a tablet session attaches on its venue's task; another venue's
 *     task → 403 KIOSK_SCOPE; it cannot remove someone else's photo
 */
import fs from 'node:fs';

const A = 'agency-test90-a';
const B = 'agency-test90-b';
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
  const head = 'data:image/jpeg;base64,/9j/4AAQSkZJRg' + Buffer.from(seed).toString('base64').replace(/=/g, '');
  return head + 'A'.repeat(Math.max(0, chars - head.length));
}

export default {
  name: 'Test 90: optional photo on every answer-type check (PHOTOALL)',
  whatItProves:
    'A person who may answer a toggle / yes-no / status / checkbox task can attach one photo (who/when/caption); the bytes stay out of the shared document; everyone else is refused; caps enforced; check-in unchanged.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const v1 = `venue-t90-1-${ts}`, v2 = `venue-t90-2-${ts}`, vb = `venue-t90-b-${ts}`;
    const id = (k) => `user-t90-${k}-${ts}`;
    const em = (k) => `t90-${k}-${ts}@test.local`;
    const PIN = '4826';
    const people = [
      { id: id('admin'), email: em('admin'), name: 'T90 Admin', role: 'admin', agencyId: A },
      { id: id('coord'), email: em('coord'), name: 'T90 Coord', role: 'coordinator', agencyId: A, venueId: v1 },
      { id: id('mash'), email: em('mash'), name: 'T90 Mash', role: 'mashgiach', agencyId: A, venueId: v1, kioskPin: PIN },
      { id: id('mash2'), email: em('mash2'), name: 'T90 Mash Two', role: 'mashgiach', agencyId: A, venueId: v1, kioskPin: '7351' },
      { id: id('nofill'), email: em('nofill'), name: 'T90 NoFill', role: 'mashgiach', agencyId: A, venueId: v1, permissions: { canFillTasks: false } },
      { id: id('owner'), email: em('owner'), name: 'T90 Owner', role: 'owner', agencyId: A, venueId: v1 },
      { id: id('mashv2'), email: em('mashv2'), name: 'T90 Mash V2', role: 'mashgiach', agencyId: A, venueId: v2 },
      { id: id('adminb'), email: em('adminb'), name: 'T90 Admin B', role: 'admin', agencyId: B },
    ];
    const task = (k, inputType, extra = {}) => ({
      id: `task-t90-${k}-${ts}`, agencyId: A, venueId: v1, title: `T90 ${k}`, category: 'General', categories: ['General'],
      inputType, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false,
      notes: '', assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0, checkIns: [], ...extra,
    });
    const T = {
      toggle: task('toggle', 'toggle'),
      yes_no: task('yesno', 'yes_no'),
      status_select: task('status', 'status_select', { customStatusOptions: ['Pending', 'Done'], currentStatus: 'Pending' }),
      checkbox: task('checkbox', 'checkbox'),
      check_in: task('checkin', 'check_in'),
      priv: task('priv', 'yes_no', { isPrivate: true, assignedTo: [em('coord')] }),
      v2: task('v2', 'yes_no', { venueId: v2 }),
    };
    const doc0 = await ctx.getDoc();
    const park = { ...(doc0.venueWorkDates || {}), [v1]: '2099-12-31', [v2]: '2099-12-31', [vb]: '2099-12-31' };
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T90 A ${ts}` }, { id: B, name: `T90 B ${ts}` }],
      venues: [
        { id: v1, name: `T90 V1 ${ts}`, agencyId: A },
        { id: v2, name: `T90 V2 ${ts}`, agencyId: A },
        { id: vb, name: `T90 VB ${ts}`, agencyId: B },
      ],
      users: people,
      tasks: Object.values(T),
      venueWorkDates: park,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const p of people) tok[p.id.replace('user-t90-', '').replace(`-${ts}`, '')] = auth(await mintToken(baseUrl, p.id));

    const call = async (method, taskId, headers, body, query = '') => {
      const r = await fetch(`${baseUrl}/api/tasks/${taskId}/answer-photo${query}`, {
        method, headers: headers || { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const taskInDoc = async (taskId) => ((await ctx.getDoc()).tasks || []).find((t) => t.id === taskId);
    const docBytes = async () => JSON.stringify(await ctx.getDoc()).length;
    const out = [];

    // ---- A + B: each of the 4 types, at the size cap --------------------------
    const MAX = 400_000;
    const before = await docBytes();
    const photos = {};
    for (const type of ['toggle', 'yes_no', 'status_select', 'checkbox']) {
      const data = jpeg(MAX, type);
      const r = await call('POST', T[type].id, tok.mash, { photoData: data, photoCaption: `  ${type} seal  ` });
      assert(r.status === 200, `A ${type}: POST ${r.status} ${JSON.stringify(r.json)}`);
      const ref = r.json.answerPhoto;
      assert(ref && typeof ref.id === 'string' && ref.byEmail === em('mash') && ref.byName === 'T90 Mash' && !isNaN(Date.parse(ref.at)), `A ${type}: ref ${JSON.stringify(ref)}`);
      assert(ref.caption === `${type} seal`, `A ${type}: caption trimmed, got ${JSON.stringify(ref.caption)}`);
      assert(r.json.photoData === undefined && JSON.stringify(r.json).length < 3000, `A ${type}: the task response carries no bytes`);
      assert(r.json.isCompleted === false && r.json.currentStatus === T[type].currentStatus, `A ${type}: the answer itself is untouched`);
      const g = await call('GET', T[type].id, tok.mash, undefined, `?photoId=${ref.id}`);
      assert(g.status === 200 && g.json.photoData === data && g.json.id === ref.id, `A ${type}: GET returns the same bytes (${g.status})`);
      photos[type] = { ref, data };
    }
    out.push('A 4/4 types');
    const after = await docBytes();
    const d = await taskInDoc(T.yes_no.id);
    assert(d.answerPhoto && d.answerPhoto.id === photos.yes_no.ref.id && d.answerPhoto.photoData === undefined, `B: doc task carries only the reference: ${JSON.stringify(d.answerPhoto)}`);
    assert(!JSON.stringify(await ctx.getDoc()).includes('data:image/jpeg;base64,/9j/4AAQSkZJRg'), 'B: no photo bytes anywhere in the shared document');
    assert(after - before < 4096, `B: 1.6 M chars of photos grew the document by ${after - before} bytes (want < 4096)`);
    const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    assert(src.includes('const SIZE_LIMIT_BYTES = 900 * 1024;') && src.includes('throw new DocumentTooLargeError(payloadSize, SIZE_LIMIT_BYTES);'), 'B: the 900 KiB guard is unchanged');
    out.push(`B doc +${after - before} B for 4 photos at the cap`);

    // ---- C: refusals (fail closed), nothing changes ---------------------------
    const small = jpeg(2000, 'c');
    const refusals = [
      ['other venue mashgiach', T.toggle.id, tok.mashv2, 403],
      ['owner without fill', T.toggle.id, tok.owner, 403],
      ['canFillTasks:false', T.toggle.id, tok.nofill, 403],
      ['other agency admin', T.toggle.id, tok.adminb, 403],
      ['private task of someone else', T.priv.id, tok.mash, 403],
      ['no session', T.toggle.id, undefined, 401],
    ];
    for (const [label, taskId, h, want] of refusals) {
      const r = await call('POST', taskId, h, { photoData: small });
      assert(r.status === want, `C ${label}: POST want ${want}, got ${r.status} ${JSON.stringify(r.json)}`);
      const del = await call('DELETE', taskId, h);
      assert(del.status === want, `C ${label}: DELETE want ${want}, got ${del.status}`);
    }
    assert((await taskInDoc(T.toggle.id)).answerPhoto.id === photos.toggle.ref.id, 'C: the toggle photo is unchanged after the refusals');
    assert(!(await taskInDoc(T.priv.id)).answerPhoto, 'C: the private task has no photo');
    // positive twins: the private task's assignee and an admin may attach
    const pc = await call('POST', T.priv.id, tok.coord, { photoData: small });
    assert(pc.status === 200, `C twin: the private task's own coordinator may attach (${pc.status})`);
    const pa = await call('POST', T.v2.id, tok.admin, { photoData: small });
    assert(pa.status === 200, `C twin: the agency admin may attach at any venue (${pa.status})`);
    out.push('C 6 refusals + 2 twins');

    // ---- D: reads follow task visibility ---------------------------------------
    for (const [label, h, want] of [['coordinator', tok.coord, 200], ['owner (no fill)', tok.owner, 200], ['other venue', tok.mashv2, 403], ['other agency', tok.adminb, 403], ['no session', undefined, 401]]) {
      const g = await call('GET', T.toggle.id, h);
      assert(g.status === want, `D ${label}: GET want ${want}, got ${g.status}`);
      if (want === 200) assert(g.json.photoData === photos.toggle.data, `D ${label}: bytes`);
    }
    assert((await call('GET', T.priv.id, tok.mash)).status === 403, 'D: private task of someone else not readable');
    out.push('D reads');

    // ---- E: caps and formats ----------------------------------------------------
    const big = await call('POST', T.checkbox.id, tok.mash, { photoData: jpeg(MAX + 1, 'big') });
    assert(big.status === 413 && big.json?.code === 'MEDIA_TOO_LARGE', `E: over the cap → 413, got ${big.status} ${JSON.stringify(big.json)}`);
    for (const [label, photoData] of [['no data URL', 'hello'], ['svg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='], ['not base64', 'data:image/jpeg;base64,<script>'], ['missing', undefined], ['number', 7]]) {
      const r = await call('POST', T.checkbox.id, tok.mash, { photoData });
      assert(r.status === 400, `E ${label}: want 400, got ${r.status}`);
    }
    const capR = await call('POST', T.checkbox.id, tok.mash, { photoData: small, photoCaption: 'c'.repeat(250) });
    assert(capR.status === 200 && capR.json.answerPhoto.caption === 'c'.repeat(200), `E: caption cut to 200 (${capR.status})`);
    assert((await call('POST', T.checkbox.id, tok.mash, { photoData: small, photoCaption: { x: 1 } })).status === 400, 'E: object caption → 400');
    out.push('E caps');

    // ---- F: check_in unchanged ----------------------------------------------------
    const ci = await call('POST', T.check_in.id, tok.mash, { photoData: small });
    assert(ci.status === 400 && ci.json?.code === 'PHOTO_NOT_ALLOWED', `F: check_in answer-photo → 400, got ${ci.status}`);
    const cin = await fetch(`${baseUrl}/api/tasks/${T.check_in.id}/check-in`, { method: 'POST', headers: tok.mash, body: JSON.stringify({ photoData: small, photoCaption: 'door' }) });
    const cij = await cin.json();
    assert(cin.status === 200 && cij.checkIns?.length === 1 && cij.checkIns[0].photoData === small && cij.checkIns[0].photoCaption === 'door' && !cij.answerPhoto, `F: check-in with photo unchanged (${cin.status})`);
    out.push('F check-in unchanged');

    // ---- G: replace, remove, sweep ---------------------------------------------------
    const old = photos.yes_no.ref;
    const rep = await call('POST', T.yes_no.id, tok.mash2, { photoData: jpeg(5000, 'rep') });
    assert(rep.status === 200 && rep.json.answerPhoto.id !== old.id && rep.json.answerPhoto.byEmail === em('mash2'), `G: replace (${rep.status})`);
    assert((await call('GET', T.yes_no.id, tok.mash, undefined, `?photoId=${old.id}`)).status === 404, 'G: the old photo id no longer answers');
    const noop = await call('DELETE', T.yes_no.id, tok.mash, undefined, `?photoId=${old.id}`);
    assert(noop.status === 200 && noop.json.answerPhoto?.id === rep.json.answerPhoto.id, `G: DELETE of an old id is a no-op (${noop.status})`);
    const del = await call('DELETE', T.yes_no.id, tok.mash, undefined, `?photoId=${rep.json.answerPhoto.id}`);
    assert(del.status === 200 && !del.json.answerPhoto, `G: DELETE removes (${del.status})`);
    assert(!(await taskInDoc(T.yes_no.id)).answerPhoto, 'G: removed in the document');
    assert((await call('GET', T.yes_no.id, tok.mash)).status === 404, 'G: GET after remove → 404');
    const again = await call('DELETE', T.yes_no.id, tok.mash);
    assert(again.status === 200, `G: DELETE again is idempotent (${again.status})`);
    // A deleted task leaves its photo bytes unreferenced: the sweep removes them
    // once past the in-flight grace (10 min), never before.
    const dt = await fetch(`${baseUrl}/api/tasks/${T.checkbox.id}?expectedVersion=${await ctx.getVersion()}`, { method: 'DELETE', headers: tok.admin });
    assert(dt.status === 200, `G: delete task ${dt.status}`);
    const sw0 = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() });
    assert(sw0.status === 200 && sw0.json.removed === 0, `G: a fresh orphan is kept during the grace (removed ${sw0.json?.removed})`);
    const sw = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() + 60 * 60 * 1000 });
    assert(sw.status === 200 && sw.json.removed >= 1, `G: the sweep removes the deleted task's photo (removed ${sw.json?.removed})`);
    const g2 = await call('GET', T.toggle.id, tok.mash);
    assert(g2.status === 200 && g2.json.photoData === photos.toggle.data, 'G: the sweep keeps referenced photos');
    out.push(`G replace/remove, sweep removed ${sw.json.removed}`);

    // ---- H: kiosk ----------------------------------------------------------------------
    const device = await pairDevice(baseUrl, (tok.admin.Authorization || '').replace('Bearer ', ''), v1);
    const kl = await fetch(`${baseUrl}/api/kiosk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': device }, body: JSON.stringify({ userId: id('mash'), pin: PIN }) });
    const klj = await kl.json();
    assert(kl.status === 200 && klj.token, `H: kiosk login ${kl.status}`);
    const K = { ...auth(klj.token), 'X-Kiosk-Device': device };
    const kp = await call('POST', T.yes_no.id, K, { photoData: small });
    assert(kp.status === 200 && kp.json.answerPhoto.byEmail === em('mash'), `H: kiosk attaches on its venue (${kp.status} ${JSON.stringify(kp.json)})`);
    assert((await call('GET', T.yes_no.id, K)).status === 200, 'H: kiosk reads its venue photo');
    const kv2 = await call('POST', T.v2.id, K, { photoData: small });
    assert(kv2.status === 403 && kv2.json?.code === 'KIOSK_SCOPE', `H: kiosk on another venue → 403 KIOSK_SCOPE, got ${kv2.status}`);
    // the toggle photo is mash's own; the status photo too — have mash2 own one
    const m2 = await call('POST', T.status_select.id, tok.mash2, { photoData: small });
    assert(m2.status === 200, 'H: setup');
    const kd = await call('DELETE', T.status_select.id, K);
    assert(kd.status === 403, `H: kiosk cannot remove someone else's photo, got ${kd.status}`);
    const kdo = await call('DELETE', T.yes_no.id, K);
    assert(kdo.status === 200 && !kdo.json.answerPhoto, `H: kiosk removes its own (${kdo.status})`);
    out.push('H kiosk');

    // ---- I (RV1): kiosk replacement, fresh gate, orphans kept for the sweep, retries -----
    // I1: a kiosk may not REPLACE someone else's photo either (it could not remove it).
    const kr = await call('POST', T.status_select.id, K, { photoData: small });
    assert(kr.status === 403 && kr.json?.code === 'KIOSK_SCOPE', `I1: kiosk replacing another's photo → 403 KIOSK_SCOPE, got ${kr.status}`);
    assert((await taskInDoc(T.status_select.id)).answerPhoto?.id === m2.json.answerPhoto.id, 'I1: the other person\'s photo stays');
    assert((await call('GET', T.status_select.id, tok.mash2)).status === 200, 'I1: and its bytes stay');
    // I2: the whole write gate again on FRESH data inside the commit. The
    // stored document changes, the server's cache does not (doc-set-users):
    // the pre-check passes on the cache, the commit must still refuse.
    const storedUsers = (await ctx.getDoc()).users;
    const setUsers = async (users) => {
      const r = await ctx.api('POST', '/api/__test__/doc-set-users', { users });
      assert(r.status === 200, `doc-set-users: ${r.status}`);
    };
    const m2id = id('mash2');
    const keepTask = (await taskInDoc(T.toggle.id)).answerPhoto?.id || null;
    const fresh = [
      ['lost fill permission', storedUsers.map((u) => (u.id === m2id ? { ...u, permissions: { ...(u.permissions || {}), canFillTasks: false } } : u))],
      ['moved to another venue', storedUsers.map((u) => (u.id === m2id ? { ...u, venueId: v2, ...(u.venueAccess ? { venueAccess: [v2] } : {}) } : u))],
      ['removed from the agency', storedUsers.filter((u) => u.id !== m2id)],
    ];
    let refusedWithBytes = 0;
    for (const [why, users] of fresh) {
      await setUsers(users);
      const fp = await call('POST', T.toggle.id, tok.mash2, { photoData: small });
      assert([401, 403, 409].includes(fp.status), `I2 ${why}: POST must be refused on fresh data, got ${fp.status} ${JSON.stringify(fp.json)}`);
      if (fp.status === 409) refusedWithBytes++;
      const fd = await call('DELETE', T.toggle.id, tok.mash2);
      assert([401, 403, 409].includes(fd.status), `I2 ${why}: DELETE must be refused on fresh data, got ${fd.status}`);
      assert(((await taskInDoc(T.toggle.id)).answerPhoto?.id || null) === keepTask, `I2 ${why}: the task's photo is unchanged`);
    }
    await setUsers(storedUsers);
    assert(refusedWithBytes >= 1, `I2: at least one refusal came from the commit itself (409), got ${refusedWithBytes}`);
    // I3: bytes of a save that did not commit are NOT deleted on that path (an
    // unconfirmed commit could reference them); the sweep removes them only
    // when the stored document does not, after the grace.
    const sNow = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() });
    assert(sNow.status === 200 && sNow.json?.removed === 0, `I3: inside the grace nothing is swept (${JSON.stringify(sNow.json)})`);
    const sLate = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() + 60 * 60 * 1000 });
    assert(sLate.status === 200 && sLate.json?.removed >= refusedWithBytes, `I3: after the grace the uncommitted bytes go (${JSON.stringify(sLate.json)} >= ${refusedWithBytes})`);
    for (const type of ['toggle', 'status_select']) { // (the checkbox task was deleted in G)
      const ref = (await taskInDoc(T[type].id))?.answerPhoto;
      if (ref) assert((await call('GET', T[type].id, tok.mash)).status === 200, `I3: a referenced ${type} photo survives the sweep`);
    }
    // I4: a retried save (same operation id) answers the first save: same
    // reference, and its bytes are intact (nothing deleted by the retry).
    const op = `t90-op-${ts}`;
    const r1 = await call('POST', T.yes_no.id, tok.mash, { photoData: jpeg(5000, 'retry'), operationId: op });
    const r2 = await call('POST', T.yes_no.id, tok.mash, { photoData: jpeg(5000, 'retry'), operationId: op });
    assert(r1.status === 200 && r2.status === 200, `I4: both answers 200 (${r1.status}, ${r2.status})`);
    assert(r2.json.answerPhoto?.id === r1.json.answerPhoto?.id, `I4: the retry answers the first save (${r1.json.answerPhoto?.id} vs ${r2.json.answerPhoto?.id})`);
    assert((await taskInDoc(T.yes_no.id)).answerPhoto?.id === r1.json.answerPhoto.id, 'I4: one reference in the document');
    const g4 = await call('GET', T.yes_no.id, tok.mash);
    assert(g4.status === 200 && g4.json.photoData === jpeg(5000, 'retry'), 'I4: the first save\'s bytes are intact');
    // I5: the venue itself is gone from the STORED document (cache unchanged):
    // the kiosk and the phone are refused by the commit; the photo stays.
    const docV = await ctx.getDoc();
    const keepYN = (await taskInDoc(T.yes_no.id)).answerPhoto?.id || null;
    const sv = await ctx.api('POST', '/api/__test__/doc-set-users', { users: docV.users, venues: (docV.venues || []).filter((v) => v.id !== v1) });
    assert(sv.status === 200, `I5 setup: ${sv.status}`);
    const k5 = await call('POST', T.yes_no.id, K, { photoData: small });
    const p5 = await call('POST', T.yes_no.id, tok.mash, { photoData: small });
    const sr = await ctx.api('POST', '/api/__test__/doc-set-users', { users: docV.users, venues: docV.venues });
    assert(sr.status === 200, `I5 restore: ${sr.status}`);
    assert([401, 403, 409].includes(k5.status), `I5: kiosk refused when the venue is gone (got ${k5.status} ${JSON.stringify(k5.json)})`);
    assert([401, 403, 409].includes(p5.status), `I5: phone refused when the venue is gone (got ${p5.status})`);
    assert(((await taskInDoc(T.yes_no.id)).answerPhoto?.id || null) === keepYN, 'I5: the photo is unchanged');
    // I6 (RV2): the kiosk's fresh gate checks the UNMODIFIED fresh row: the
    // tablet user moved away / lost fill permission / removed (stored doc only).
    const mid = id('mash');
    const kFresh = [
      ['moved to another venue', storedUsers.map((u) => (u.id === mid ? { ...u, venueId: v2, ...(u.venueAccess ? { venueAccess: [v2] } : {}) } : u))],
      ['lost fill permission', storedUsers.map((u) => (u.id === mid ? { ...u, permissions: { ...(u.permissions || {}), canFillTasks: false } } : u))],
      ['removed from the agency', storedUsers.filter((u) => u.id !== mid)],
    ];
    const keepYN6 = (await taskInDoc(T.yes_no.id)).answerPhoto?.id || null;
    const kCodes = [];
    for (const [why, users] of kFresh) {
      await setUsers(users);
      const kp6 = await call('POST', T.yes_no.id, K, { photoData: small });
      const kd6 = await call('DELETE', T.yes_no.id, K);
      kCodes.push(`${kp6.status}/${kd6.status}`);
      assert([401, 403, 409].includes(kp6.status), `I6 kiosk ${why}: POST refused on fresh data, got ${kp6.status} ${JSON.stringify(kp6.json)}`);
      assert([401, 403, 409].includes(kd6.status), `I6 kiosk ${why}: DELETE refused on fresh data, got ${kd6.status}`);
      assert(((await taskInDoc(T.yes_no.id)).answerPhoto?.id || null) === keepYN6, `I6 kiosk ${why}: photo unchanged`);
    }
    await setUsers(storedUsers);
    // I7 (RV2): a save that takes longer than the deadline never publishes its
    // reference (the sweep may already have removed bytes past its grace).
    const hk = await ctx.api('POST', '/api/__test__/answer-photo-hooks', { clockSkewMs: 6 * 60 * 1000 });
    assert(hk.status === 200, `I7 hook: ${hk.status}`);
    const slow = await call('POST', T.yes_no.id, tok.mash, { photoData: small });
    await ctx.api('POST', '/api/__test__/answer-photo-hooks', { clockSkewMs: 0 });
    assert(slow.status === 409, `I7: a save past the deadline → 409, got ${slow.status} ${JSON.stringify(slow.json)}`);
    assert(((await taskInDoc(T.yes_no.id)).answerPhoto?.id || null) === keepYN6, 'I7: no reference published');
    const s7 = await ctx.api('POST', '/api/__test__/answer-photo-sweep', { nowMs: Date.now() + 60 * 60 * 1000 });
    assert(s7.status === 200 && s7.json?.removed >= 1, `I7: its bytes are swept after the grace (${JSON.stringify(s7.json)})`);
    assert((await call('GET', T.yes_no.id, tok.mash)).status === 200, 'I7: the published photo is untouched');
    out.push(`I kiosk replace 403; kiosk fresh gate ${kCodes.join(',')}; slow save 409; venue gone → kiosk ${k5.status}/phone ${p5.status}; fresh gate ${fresh.length}x (commit refusals ${refusedWithBytes}); orphans swept only after grace; retry = first save`);

    return out.join('; ');
  },
};
