/**
 * Test 61 (item 12, "Signed — item 12 logo plan v3", server contract S1–S7):
 * the agency logo. Bytes live outside app-state/main in revision-addressed
 * docs agencyLogos/{agencyId}__{rev}; the agency record carries only logoRev.
 *
 *  A  feature signal: getSafeUser.agencyLogoRev / agency projections logoRev
 *     are ALWAYS present (null before any upload)
 *  B  admin of A uploads a PNG: 200 {logoRev}; doc written outside
 *     app-state/main; the agency list grows < 100 bytes; GET serves it
 *     (admin, staff, kiosk) with Cache-Control private; non-admin
 *     AGENCY_UPDATED carries logoRev but no admin fields
 *  C  who: no auth 401; coordinator / mashgiach / venue owner / kiosk PUT and
 *     DELETE 403, nothing written; agency B cannot read A's (404 no-store) and
 *     its own upload never touches A's
 *  D  refused input (400, nothing written): SVG, GIF, renamed SVG, HTML,
 *     257 px, > 100 KB, bad base64
 *  E  stale expectedVersion: 409, the old logo keeps working; the orphan doc
 *     is never served
 *  F  concurrent uploads: exactly one wins, GET serves the winner; the loser's
 *     doc goes once past the grace
 *  G  replacement: old rev 404 no-store, new rev served; delete then re-upload
 *     the same bytes: a new rev; DELETE clears logoRev everywhere
 *  H  interleavings (test-mode delay hooks): a delayed cleanup never deletes
 *     the current doc (after upload/upload and delete/upload) nor an in-flight
 *     young doc; the in-flight bound answers 503 with nothing committed
 *  I  POST /api/venues certificationDetail: stored, validated, optional
 */
import { png, jpeg, webpLossless, SVG, GIF, HTML, b64 } from './logo-fixtures.mjs';

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REV_RE = /^[0-9a-f]{12}-[0-9a-f]{6}$/;

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

export default {
  name: 'Test 61: agency logo (item 12 server)',
  whatItProves:
    'Admin-only, own-agency logo upload stored outside app-state/main by revision; strict type/size/dimension checks; revision-specific GET (401/404 no-store/private cache); 409 keeps the old logo; concurrent uploads, replacement, delete and re-upload; revision-safe cleanup under delayed interleavings; in-flight bound 503; logoRev always present on user/agency projections; venue certificationDetail validated.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t61a-${ts}`, B = `agency-t61b-${ts}`, A1 = `venue-t61-a1-${ts}`, B1 = `venue-t61-b1-${ts}`;
    const U = (k) => `user-t61-${k}-${ts}`, E = (k) => `t61-${k}-${ts}@test.local`;
    const jsonH = { 'Content-Type': 'application/json' };
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, cache: r.headers.get('cache-control') };
    };
    const opId = () => `op-t61-${Math.random().toString(36).slice(2)}`;
    const write = async (method, path, token, body = {}, version) => call(method, path, auth(token), { expectedVersion: version ?? await ctx.getVersion(), operationId: opId(), ...body });
    const hook = async (path, body) => { const r = await ctx.api('POST', `/api/__test__/${path}`, body); assert(r.status === 200, `hook ${path}: ${r.status} ${J(r.json)}`); return r.json; };
    const docs = async (agencyId) => (await ctx.api('GET', `/api/__test__/logo-docs?agencyId=${encodeURIComponent(agencyId)}`)).json.docs;
    const agencyOf = async (id) => ((await ctx.getDoc()).agencies || []).find((a) => a.id === id);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const getLogo = (token, rev) => call('GET', `/api/agency/logo?rev=${encodeURIComponent(rev)}`, token ? auth(token) : jsonH);
    const put = (token, buf, version) => write('PUT', '/api/agency/logo', token, { data: typeof buf === 'string' ? buf : b64(buf) }, version);
    const del = (token) => write('DELETE', '/api/agency/logo', token);

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T61 A ${ts}`, adminEmail: E('ada'), createdAt: new Date(ts).toISOString() }, { id: B, name: `T61 B ${ts}` }],
      venues: [{ id: A1, name: `T61 A1 ${ts}`, agencyId: A }, { id: B1, name: `T61 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adA'), email: E('ada'), name: 'T61 Admin A', role: 'admin', agencyId: A },
        { id: U('adB'), email: E('adb'), name: 'T61 Admin B', role: 'admin', agencyId: B },
        { id: U('coA'), email: E('coa'), name: 'T61 Coord A', role: 'coordinator', agencyId: A, venueId: A1 },
        { id: U('maA'), email: E('maa'), name: 'T61 Mash A', role: 'mashgiach', agencyId: A, venueId: A1 },
        { id: U('owA'), email: E('owa'), name: 'T61 Owner A', role: 'owner', agencyId: A, venueId: A1 },
      ],
    });
    assert(inj.status === 200, `inject ${inj.status}`);
    const T = {};
    for (const k of ['adA', 'adB', 'coA', 'maA', 'owA']) T[k] = await mintToken(baseUrl, U(k));
    await hook('set-password', { userId: U('maA'), password: 'stage2-t61-password' });
    const selfRev = async () => {
      const lg = await call('POST', '/api/auth/login', { ...jsonH, 'X-Forwarded-For': `10.61.${ts % 200}.${Math.floor(Math.random() * 250)}` }, { email: E('maa'), password: 'stage2-t61-password' });
      assert(lg.status === 200 && lg.json?.user, `login ${lg.status}`);
      assert('agencyLogoRev' in lg.json.user, `getSafeUser carries agencyLogoRev ${J(Object.keys(lg.json.user))}`);
      return lg.json.user.agencyLogoRev;
    };
    const agencyView = async (token) => (await call('GET', '/api/agencies/current', auth(token))).json?.agency;

    try {
      // ---- A: feature signal ----
      assert((await selfRev()) === null, 'A: agencyLogoRev null before any upload');
      for (const k of ['adA', 'maA']) {
        const v = await agencyView(T[k]);
        assert(v && 'logoRev' in v && v.logoRev === null, `A: ${k} agency view logoRev null ${J(v)}`);
      }
      console.log('  ✓ A agencyLogoRev / logoRev present and null before any upload');

      // ---- B: upload, storage, GET ----
      const img1 = png(64, 32, { seed: 1 });
      const lenBefore = J((await ctx.getDoc()).agencies).length;
      const wsM = await connectWs(baseUrl, T.maA);
      let rev1;
      try {
        const mark = wsM.messages.length;
        const r = await put(T.adA, img1);
        assert(r.status === 200 && REV_RE.test(r.json?.logoRev || ''), `B upload: ${r.status} ${r.text.slice(0, 160)}`);
        rev1 = r.json.logoRev;
        await sleep(800);
        const upd = wsM.messages.slice(mark).filter((m) => m.type === 'AGENCY_UPDATED');
        assert(upd.length >= 1 && upd[upd.length - 1].payload?.agency?.logoRev === rev1, `B non-admin AGENCY_UPDATED carries logoRev ${J(upd)}`);
        const ag = upd[upd.length - 1].payload.agency;
        assert(!('adminEmail' in ag) && !('createdAt' in ag), `B non-admin payload has no admin fields ${J(ag)}`);
      } finally { wsM.close(); }
      const doc = await ctx.getDoc();
      assert(!J(doc).includes(b64(img1).slice(0, 40)), 'B the bytes are not in app-state/main');
      assert((await agencyOf(A)).logoRev === rev1, 'B agency.logoRev set');
      assert(J(doc.agencies).length - lenBefore < 100, `B the agency list grew ${J(doc.agencies).length - lenBefore} bytes`);
      let d = await docs(A);
      assert(d.length === 1 && d[0].id === `${A}__${rev1}` && d[0].rev === rev1 && d[0].agencyId === A && d[0].mime === 'image/png' && d[0].width === 64 && d[0].height === 32 && d[0].createdBy === U('adA'), `B logo doc ${J(d)}`);
      for (const k of ['adA', 'maA', 'coA', 'owA']) {
        const g = await getLogo(T[k], rev1);
        assert(g.status === 200 && g.json?.rev === rev1 && g.json.mime === 'image/png' && g.json.data === b64(img1), `B GET as ${k}: ${g.status} ${g.text.slice(0, 120)}`);
        assert(/private/.test(g.cache || '') && /max-age=86400/.test(g.cache || ''), `B cache header ${g.cache}`);
      }
      assert((await selfRev()) === rev1, 'B getSafeUser carries the rev');
      assert((await agencyView(T.maA)).logoRev === rev1 && (await agencyView(T.adA)).logoRev === rev1, 'B projections carry the rev');
      // kiosk session (paired at A1) reads it; may not write
      let kioskTok, kioskH;
      {
        let w = await write('PUT', `/api/users/${U('maA')}`, T.adA, { kioskPin: '6161' });
        assert(w.status === 200, `PIN ${w.status} ${w.text.slice(0, 120)}`);
        const start = await call('POST', '/api/kiosk/pairing/start', jsonH, {});
        const p = await call('POST', '/api/kiosk/devices/pair', auth(T.adA), { code: start.json.code, venueId: A1 });
        assert(p.status === 201, `pair ${p.status} ${p.text.slice(0, 120)}`);
        const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } }).then((x) => x.json());
        const k = await call('POST', '/api/kiosk/login', { ...jsonH, 'X-Kiosk-Device': `${st.device.id}.${start.json.deviceSecret}`, 'X-Forwarded-For': `10.61.${ts % 200}.252` }, { userId: U('maA'), pin: '6161' });
        assert(k.status === 200 && k.json?.token, `kiosk login ${k.status} ${k.text.slice(0, 120)}`);
        kioskTok = k.json.token;
        kioskH = { ...auth(kioskTok), 'X-Kiosk-Device': `${st.device.id}.${start.json.deviceSecret}` };
        const g = await call('GET', `/api/agency/logo?rev=${encodeURIComponent(rev1)}`, kioskH);
        assert(g.status === 200 && g.json?.data === b64(img1), `B kiosk GET ${g.status} ${g.text.slice(0, 120)}`);
      }
      console.log('  ✓ B upload stored outside app-state/main; GET for admin, staff, owner, kiosk; non-admin AGENCY_UPDATED carries logoRev only');

      // ---- C: who ----
      {
        let g = await getLogo(null, rev1);
        assert(g.status === 401, `C no auth GET: ${g.status}`);
        g = await getLogo(T.adB, rev1);
        assert(g.status === 404 && /no-store/.test(g.cache || '') && !g.text.includes(b64(img1).slice(0, 40)), `C agency B GET of A's rev: ${g.status} ${g.cache}`);
        for (const k of ['coA', 'maA', 'owA']) {
          const v0 = await ctx.getVersion();
          let w = await put(T[k], png(10, 10));
          assert(w.status === 403, `C ${k} PUT: ${w.status}`);
          w = await del(T[k]);
          assert(w.status === 403, `C ${k} DELETE: ${w.status}`);
          await unchanged(v0, `C ${k}`);
        }
        const v0 = await ctx.getVersion();
        let w = await call('PUT', '/api/agency/logo', kioskH, { data: b64(png(10, 10)), expectedVersion: v0, operationId: opId() });
        assert(w.status === 403, `C kiosk PUT: ${w.status}`);
        w = await call('DELETE', '/api/agency/logo', kioskH, { expectedVersion: v0, operationId: opId() });
        assert(w.status === 403, `C kiosk DELETE: ${w.status}`);
        await unchanged(v0, 'C kiosk');
        assert((await docs(A)).length === 1, 'C no new doc for A');
        // agency B's own upload never touches A
        w = await put(T.adB, png(20, 20, { seed: 9 }));
        assert(w.status === 200, `C B upload ${w.status}`);
        const revB = w.json.logoRev;
        assert((await agencyOf(A)).logoRev === rev1 && (await agencyOf(B)).logoRev === revB, 'C B upload sets only B');
        g = await getLogo(T.adA, revB);
        assert(g.status === 404, `C A cannot read B's rev: ${g.status}`);
        assert((await getLogo(T.adB, revB)).status === 200, 'C B reads its own');
        console.log('  ✓ C 401 without auth; non-admins and kiosk 403 with nothing written; agencies isolated');
      }

      // ---- D: refused input ----
      {
        const cases = [
          ['svg', b64(SVG), /PNG, JPEG or WebP/], ['gif', b64(GIF), /PNG, JPEG or WebP/], ['html', b64(HTML), /PNG, JPEG or WebP/],
          ['renamed svg', b64(Buffer.concat([Buffer.from('<?xml version="1.0"?>'), SVG])), /PNG, JPEG or WebP/],
          ['257 px', b64(png(257, 8)), /256/], ['> 100 KB', b64(png(200, 200, { noisy: true })), /100 KB/],
          ['bad base64', 'not*base64!', /could not be read/], ['data: prefix', `data:image/png;base64,${b64(png(8, 8))}`, /could not be read/],
        ];
        for (const [label, data, re] of cases) {
          const v0 = await ctx.getVersion();
          const w = await put(T.adA, data);
          assert(w.status === 400 && re.test(w.json?.error || ''), `D ${label}: ${w.status} ${w.text.slice(0, 120)}`);
          await unchanged(v0, `D ${label}`);
        }
        assert((await docs(A)).length === 1 && (await agencyOf(A)).logoRev === rev1, 'D no doc written, logo unchanged');
        // JPEG and WebP are accepted types (then restored below by later uploads)
        console.log('  ✓ D SVG/GIF/HTML/renamed SVG/257 px/>100 KB/bad base64 refused, nothing written');
      }

      // ---- E: stale version keeps the old logo; orphan never served ----
      let orphanRev;
      {
        const stale = (await ctx.getVersion()) - 1;
        const w = await put(T.adA, jpeg(40, 40), stale);
        assert(w.status === 409, `E stale: ${w.status} ${w.text.slice(0, 120)}`);
        assert((await agencyOf(A)).logoRev === rev1, 'E logoRev unchanged');
        const g = await getLogo(T.maA, rev1);
        assert(g.status === 200 && g.json.data === b64(img1), 'E the old logo keeps working');
        const ds = await docs(A);
        const orphan = ds.find((x) => x.rev !== rev1);
        assert(ds.length === 2 && orphan && orphan.mime === 'image/jpeg', `E the orphan doc exists ${J(ds)}`);
        orphanRev = orphan.rev;
        const go = await getLogo(T.adA, orphanRev);
        assert(go.status === 404 && /no-store/.test(go.cache || ''), `E orphan never served: ${go.status}`);
        console.log('  ✓ E stale version 409, old logo still served, orphan never served');
      }

      // ---- F: concurrent uploads ----
      let winRev;
      {
        const v = await ctx.getVersion();
        const imgX = webpLossless(100, 50), imgY = png(50, 100, { seed: 3 });
        const [rx, ry] = await Promise.all([put(T.adA, imgX, v), put(T.adA, imgY, v)]);
        const st = [rx.status, ry.status].sort();
        assert(J(st) === J([200, 409]), `F exactly one wins: ${rx.status} ${ry.status} ${rx.text.slice(0, 80)} ${ry.text.slice(0, 80)}`);
        const win = rx.status === 200 ? { r: rx, img: imgX, mime: 'image/webp' } : { r: ry, img: imgY, mime: 'image/png' };
        winRev = win.r.json.logoRev;
        assert((await agencyOf(A)).logoRev === winRev, 'F agency points at the winner');
        const g = await getLogo(T.maA, winRev);
        assert(g.status === 200 && g.json.data === b64(win.img) && g.json.mime === win.mime, `F GET serves the winner ${g.status}`);
        const loser = (await docs(A)).find((x) => x.rev !== winRev && x.rev !== rev1 && x.rev !== orphanRev);
        assert(loser, 'F the loser left a doc');
        // past the grace, cleanup removes the loser, the old rev and the orphan — never the winner
        for (const x of await docs(A)) if (x.rev !== winRev) await hook('logo-doc-backdate', { agencyId: A, rev: x.rev, minutes: 16 });
        await hook('logo-doc-backdate', { agencyId: A, rev: winRev, minutes: 16 });
        const c = await hook('logo-cleanup', { agencyId: A });
        const left = await docs(A);
        assert(left.length === 1 && left[0].rev === winRev && c.deleted >= 3, `F cleanup kept only the current doc ${J(left)} ${J(c)}`);
        console.log('  ✓ F concurrent uploads: one 200, one 409; winner served; loser/old/orphan docs cleaned past the grace, current kept');
      }

      // ---- G: replacement, delete, re-upload ----
      {
        const imgR = png(30, 30, { seed: 5 });
        let w = await put(T.adA, imgR);
        assert(w.status === 200, `G replace ${w.status}`);
        const revR = w.json.logoRev;
        let g = await getLogo(T.maA, winRev);
        assert(g.status === 404 && /no-store/.test(g.cache || ''), `G old rev 404 no-store: ${g.status} ${g.cache}`);
        g = await getLogo(T.maA, revR);
        assert(g.status === 200 && g.json.data === b64(imgR), 'G new rev served');
        const wsM = await connectWs(baseUrl, T.maA);
        try {
          const mark = wsM.messages.length;
          w = await del(T.adA);
          assert(w.status === 200 && w.json && w.json.logoRev === null, `G delete ${w.status} ${w.text.slice(0, 120)}`);
          await sleep(800);
          const upd = wsM.messages.slice(mark).filter((m) => m.type === 'AGENCY_UPDATED');
          assert(upd.length >= 1 && upd[upd.length - 1].payload.agency.logoRev === null, `G AGENCY_UPDATED logoRev null ${J(upd)}`);
        } finally { wsM.close(); }
        assert(!('logoRev' in (await agencyOf(A))), 'G logoRev removed from the agency');
        assert((await selfRev()) === null && (await agencyView(T.adA)).logoRev === null, 'G projections back to null');
        assert((await getLogo(T.maA, revR)).status === 404, 'G removed rev not served');
        w = await put(T.adA, imgR);
        assert(w.status === 200 && w.json.logoRev !== revR && w.json.logoRev.slice(0, 12) === revR.slice(0, 12), `G re-upload same bytes: new rev ${w.json?.logoRev} vs ${revR}`);
        const revR2 = w.json.logoRev;
        assert((await getLogo(T.maA, revR2)).status === 200 && (await getLogo(T.maA, revR)).status === 404, 'G new rev served, old 404');
        console.log('  ✓ G replacement 404s the old rev; delete clears logoRev everywhere; re-upload of the same bytes gets a new rev');
      }

      // ---- H: interleavings ----
      {
        // (1) upload P commits; upload Q commits; P's delayed cleanup runs → Q (current) survives
        await hook('logo-hooks', { cleanupDelayMs: 1500 });
        let w = await put(T.adA, png(12, 12, { seed: 11 }));
        assert(w.status === 200, `H1 P ${w.status}`);
        const revP = w.json.logoRev;
        await hook('logo-hooks', { cleanupDelayMs: 0 });
        w = await put(T.adA, png(13, 13, { seed: 12 }));
        assert(w.status === 200, `H1 Q ${w.status}`);
        const revQ = w.json.logoRev;
        await hook('logo-doc-backdate', { agencyId: A, rev: revQ, minutes: 16 });
        await hook('logo-doc-backdate', { agencyId: A, rev: revP, minutes: 16 });
        await sleep(2500); // P's delayed cleanup has run
        let ds = await docs(A);
        assert(ds.some((x) => x.rev === revQ) && !ds.some((x) => x.rev === revP), `H1 P's cleanup kept Q (current), removed P ${J(ds.map((x) => x.rev))}`);
        assert((await getLogo(T.maA, revQ)).status === 200, 'H1 Q served');
        // (2) DELETE commits; upload S commits; DELETE's delayed cleanup runs → S survives
        await hook('logo-hooks', { cleanupDelayMs: 1500 });
        w = await del(T.adA);
        assert(w.status === 200, `H2 delete ${w.status}`);
        await hook('logo-hooks', { cleanupDelayMs: 0 });
        w = await put(T.adA, png(14, 14, { seed: 13 }));
        assert(w.status === 200, `H2 S ${w.status}`);
        const revS = w.json.logoRev;
        await hook('logo-doc-backdate', { agencyId: A, rev: revS, minutes: 16 });
        await sleep(2500);
        ds = await docs(A);
        assert(ds.some((x) => x.rev === revS), `H2 the delete's cleanup kept S ${J(ds.map((x) => x.rev))}`);
        assert((await getLogo(T.maA, revS)).status === 200, 'H2 S served');
        // (3) an in-flight upload's young doc is never deleted by a cleanup that runs meanwhile
        await hook('logo-hooks', { preCommitDelayMs: 2000 });
        const imgF = png(15, 15, { seed: 14 });
        const pending = put(T.adA, imgF);
        await sleep(700);
        const inflight = (await docs(A)).find((x) => x.rev !== revS && x.width === 15);
        assert(inflight, 'H3 the in-flight doc exists');
        await hook('logo-cleanup', { agencyId: A });
        assert((await docs(A)).some((x) => x.rev === inflight.rev), 'H3 cleanup kept the in-flight young doc');
        w = await pending;
        await hook('logo-hooks', { preCommitDelayMs: 0 });
        assert(w.status === 200 && w.json.logoRev === inflight.rev, `H3 the in-flight upload committed ${w.status}`);
        assert((await getLogo(T.maA, inflight.rev)).status === 200, 'H3 served');
        // (4) the in-flight bound: commit refused (503), nothing committed
        await hook('logo-hooks', { preCommitDelayMs: 600, inflightMaxMs: 200 });
        const v0 = await ctx.getVersion();
        w = await put(T.adA, png(16, 16, { seed: 15 }), v0);
        await hook('logo-hooks', { preCommitDelayMs: 0, inflightMaxMs: null });
        assert(w.status === 503 && /took too long/.test(w.json?.error || ''), `H4 in-flight bound: ${w.status} ${w.text.slice(0, 120)}`);
        await unchanged(v0, 'H4');
        assert((await agencyOf(A)).logoRev === inflight.rev, 'H4 logoRev unchanged');
        console.log('  ✓ H delayed cleanups keep the current doc (upload/upload, delete/upload) and the in-flight doc; in-flight bound 503 with nothing committed');
      }

      // ---- I: certificationDetail ----
      {
        let r = await write('POST', '/api/venues', T.adA, { name: `T61 V1 ${ts}`, certification: `T61 A ${ts} — Glatt meat`, certificationDetail: '  Glatt   meat ' });
        assert(r.status === 200 || r.status === 201, `I create ${r.status} ${r.text.slice(0, 120)}`);
        let v = ((await ctx.getDoc()).venues || []).find((x) => x.name === `T61 V1 ${ts}`);
        assert(v && v.certificationDetail === 'Glatt meat' && v.certification === `T61 A ${ts} — Glatt meat`, `I stored, normalised ${J(v)}`);
        r = await write('POST', '/api/venues', T.adA, { name: `T61 V2 ${ts}`, certification: 'x' });
        v = ((await ctx.getDoc()).venues || []).find((x) => x.name === `T61 V2 ${ts}`);
        assert(v && !('certificationDetail' in v), `I absent: not stored ${J(v)}`);
        for (const [label, bad] of [['control char', 'a\u0000b'], ['too long', 'x'.repeat(61)], ['not text', 7]]) {
          const v0 = await ctx.getVersion();
          r = await write('POST', '/api/venues', T.adA, { name: `T61 bad ${label} ${ts}`, certification: 'x', certificationDetail: bad });
          assert(r.status === 400, `I ${label}: ${r.status}`);
          await unchanged(v0, `I ${label}`);
        }
        console.log('  ✓ I certificationDetail stored (normalised), optional, validated');
      }
    } finally {
      await ctx.api('POST', '/api/__test__/logo-hooks', { cleanupDelayMs: 0, preCommitDelayMs: 0, inflightMaxMs: null });
      for (const k of ['adA', 'adB']) { try { await del(T[k]); } catch {} }
    }
    return 'logo: feature signal always present; admin-only own-agency upload outside app-state/main; strict input checks; revision-specific GET with 401/404/cache rules; 409 keeps old logo; concurrency, replacement, delete/re-upload; revision-safe cleanup under interleavings; 503 in-flight bound; certificationDetail';
  },
};
