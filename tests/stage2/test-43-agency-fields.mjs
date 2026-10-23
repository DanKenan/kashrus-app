/**
 * Test 43 (item 8a): agency data fields for branded addresses — DATA ONLY.
 *
 * Agreed plan: files/shutfey-8-plan.txt (8 plan v3, 8a + amendments 1–2).
 * Proves:
 *  1 egress allowlists: an agency's admin gets the admin view (adminEmail,
 *    customDomain, domain status) and NEVER domainVerificationToken; a
 *    coordinator / mashgiach get the public profile only (no adminEmail, no
 *    customDomain, no domain* field) on GET /api/agencies/current and on the
 *    AGENCY_UPDATED WebSocket payload; the token value appears in no response.
 *  2 who may write: coordinator, mashgiach and another agency's admin → 403 /
 *    own-agency only; nothing changes (doc version unchanged).
 *  3 validation: bad slug / domain / logo / brand → 400, nothing written.
 *  4 server-only fields (domainStatus, domainVerificationToken,
 *    domainVerifiedAt, domainLastCheckedAt) sent by a client are ignored.
 *  5 domain lifecycle: new domain → pending + fresh 64-hex token; same domain
 *    again → token unchanged; changed → new token; cleared → status none, no
 *    domain fields.
 *  6 uniqueness, normalised on BOTH sides (case, trailing dot), incl. a legacy
 *    unnormalised value; a PUT carrying a free slug + a taken domain changes
 *    NOTHING (atomic).
 *  7 concurrency: admins of A and B claim one slug at the same instant
 *    (10 rounds) → exactly one wins, exactly one agency holds it, and the
 *    loser's retry on a fresh version is refused as taken; two concurrent
 *    agency registrations with the same short code both succeed with
 *    DIFFERENT slugs.
 *  8 host matching (domains PR A): the 8a customDomain, pending or verified,
 *    never resolves on /api/agencies/by-domain; such a host is UNKNOWN (403
 *    SITE_NOT_SET_UP, no agency named). Sites come only from APP_SITES (test 83).
 */
import http from 'node:http';

const A = 'agency-test43-a';
const B = 'agency-test43-b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const DOMAIN_KEYS = ['customDomain', 'domainStatus', 'domainVerificationToken', 'domainVerifiedAt', 'domainLastCheckedAt'];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function hostGet(baseUrl, path, host) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path, method: 'GET', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json, text: body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      ws, messages,
      waitFor: async (pred, ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); }
        return null;
      },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
  });
}

export default {
  name: 'Test 43: agency data fields — allowlisted egress, admin-only writes, transactional slug/domain uniqueness, customDomain never selects an agency (domains PR A)',
  whatItProves:
    'Admins of their own agency alone set slug/brand/logo/domain; staff never see admin or domain data; the DNS proof value never leaves the server; slug and domain are unique under concurrent writes and legacy values; unverified domains never resolve.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA = `venue-t41a-${ts}`;
    const vB = `venue-t41b-${ts}`;
    const adminA = `user-t41-admina-${ts}`;
    const coordA = `user-t41-coorda-${ts}`;
    const mashA = `user-t41-masha-${ts}`;
    const adminB = `user-t41-adminb-${ts}`;
    const legacyAgency = `agency-test43-legacy-${ts}`;
    const legacyDomain = `Legacy-T41-${ts}.Example.COM.`;
    const legacySlugNorm = `legacy-t43-${ts}`;
    const verifiedAgency = `agency-test43-verified-${ts}`;
    const verifiedDomain = `verified-t41-${ts}.example.org`;
    const dupeDomain = `dupe-t41-${ts}.example.org`;
    const seen = []; // every response text, to prove no token ever leaves

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: 'Test41 A', shortCode: 'T41A', adminEmail: `admina41-${ts}@test.local`, certificationSeal: 'T41 Seal', region: 'R', createdAt: new Date().toISOString() },
        { id: B, name: 'Test41 B', shortCode: 'T41B', adminEmail: `adminb41-${ts}@test.local`, certificationSeal: 'T41 B Seal', region: 'R', createdAt: new Date().toISOString() },
        { id: legacyAgency, name: 'Test41 Legacy', shortCode: 'T41L', customDomain: legacyDomain, slug: `  ${legacySlugNorm.toUpperCase()}  ` },
        { id: verifiedAgency, name: 'Test41 Verified', shortCode: 'T41V', adminEmail: `v41-${ts}@test.local`, customDomain: verifiedDomain, domainStatus: 'verified', domainVerificationToken: 'f'.repeat(64) },
        { id: `agency-test43-dupe1-${ts}`, name: 'Dupe 1', shortCode: 'D1', customDomain: dupeDomain, domainStatus: 'verified' },
        { id: `agency-test43-dupe2-${ts}`, name: 'Dupe 2', shortCode: 'D2', customDomain: dupeDomain.toUpperCase() + '.', domainStatus: 'verified' },
      ],
      venues: [
        { id: vA, name: `T41 A ${ts}`, agencyId: A },
        { id: vB, name: `T41 B ${ts}`, agencyId: B },
      ],
      users: [
        { id: adminA, email: `admina41-${ts}@test.local`, name: 'T41 Admin A', role: 'admin', agencyId: A },
        { id: coordA, email: `coorda41-${ts}@test.local`, name: 'T41 Coord A', role: 'coordinator', agencyId: A, venueId: vA },
        { id: mashA, email: `masha41-${ts}@test.local`, name: 'T41 Mash A', role: 'mashgiach', agencyId: A, venueId: vA },
        { id: adminB, email: `adminb41-${ts}@test.local`, name: 'T41 Admin B', role: 'admin', agencyId: B },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);

    const tok = {
      adminA: await mintToken(baseUrl, adminA),
      coordA: await mintToken(baseUrl, coordA),
      mashA: await mintToken(baseUrl, mashA),
      adminB: await mintToken(baseUrl, adminB),
    };
    const call = async (who, method, path, body) => {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: auth(tok[who]), body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      seen.push(text);
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text };
    };
    const put = async (who, body) => call(who, 'PUT', '/api/agencies/current', { ...body, expectedVersion: await ctx.getVersion() });
    const agencyInDoc = async (id) => ((await ctx.getDoc()).agencies || []).find((a) => a.id === id);

    // --- 1. GET /api/agencies/current per role -----------------------------
    const gA = await call('adminA', 'GET', '/api/agencies/current');
    assert(gA.status === 200 && gA.json?.agency?.id === A, `admin GET current: ${gA.status}`);
    assert(gA.json.agency.adminEmail === `admina41-${ts}@test.local`, 'admin keeps adminEmail');
    assert(!('domainVerificationToken' in gA.json.agency), 'admin view must not carry the token');
    for (const who of ['coordA', 'mashA']) {
      const g = await call(who, 'GET', '/api/agencies/current');
      assert(g.status === 200 && g.json?.agency?.id === A && g.json.agency.name === 'Test41 A', `${who} GET current: ${g.status}`);
      for (const k of ['adminEmail', 'createdAt', ...DOMAIN_KEYS]) {
        assert(!(k in g.json.agency), `${who} must not receive ${k}: ${JSON.stringify(g.json.agency)}`);
      }
    }

    // --- 2. who may write ----------------------------------------------------
    const v0 = await ctx.getVersion();
    for (const who of ['coordA', 'mashA']) {
      const r = await put(who, { slug: `nope-${ts}`, brandName: 'X' });
      assert(r.status === 403, `${who} PUT must be 403, got ${r.status}`);
    }
    assert((await ctx.getVersion()) === v0, 'refused writes must not change the doc');
    const rB0 = await put('adminB', { brandName: 'B brand' });
    assert(rB0.status === 200 && rB0.json?.agency?.id === B, `admin B writes only B: ${rB0.status}`);
    assert(!(await agencyInDoc(A)).brandName, "admin B's write must not touch A");

    // --- 3. validation -------------------------------------------------------
    const bad = [
      { slug: 'ab' }, { slug: '-abc-' }, { slug: 'a--b' }, { slug: 'api' }, { slug: 'has space' },
      { customDomain: 'https://x.example.com' }, { customDomain: 'localhost' }, { customDomain: 'nodot' },
      { customDomain: 'x.example.com/path' }, { customDomain: 'svc-123.us-east1.run.app' }, { customDomain: 'hkc.shutfey.com' },
      { customDomain: '10.0.0.1' }, { logoUrl: 'http://x.example.com/logo.png' }, { logoUrl: 'javascript:alert(1)' },
      { brandName: 'x'.repeat(81) },
    ];
    const vBad = await ctx.getVersion();
    for (const b of bad) {
      const r = await put('adminA', b);
      assert(r.status === 400, `invalid ${JSON.stringify(b)} must be 400, got ${r.status}`);
    }
    assert((await ctx.getVersion()) === vBad, 'invalid input must not write');

    // --- 4/5. set fields; server-only fields ignored; domain lifecycle --------
    const slugA = `t41a-${ts}`;
    const domA = `app.t41a-${ts}.example.org`;
    const set = await put('adminA', {
      slug: slugA.toUpperCase(), brandName: '  Test41 Brand  ', logoUrl: 'https://cdn.example.org/l.png', customDomain: `${domA.toUpperCase()}.`,
      domainStatus: 'verified', domainVerificationToken: 'evil', domainVerifiedAt: '2026-01-01T00:00:00Z', domainLastCheckedAt: 'x',
    });
    assert(set.status === 200, `admin A set: ${set.status} ${set.text}`);
    const ag = set.json.agency;
    assert(ag.slug === slugA && ag.brandName === 'Test41 Brand' && ag.customDomain === domA, `normalised values: ${JSON.stringify(ag)}`);
    assert(ag.domainStatus === 'pending', `client cannot verify: ${ag.domainStatus}`);
    assert(!('domainVerificationToken' in ag) && !('domainVerifiedAt' in ag), 'response must not carry token / verifiedAt');
    let dA = await agencyInDoc(A);
    assert(/^[0-9a-f]{64}$/.test(dA.domainVerificationToken || ''), 'server minted a 64-hex token');
    assert(!dA.domainVerifiedAt && !dA.domainLastCheckedAt, 'client-sent verifiedAt/lastCheckedAt ignored');
    const token1 = dA.domainVerificationToken;
    const same = await put('adminA', { customDomain: domA });
    assert(same.status === 200 && (await agencyInDoc(A)).domainVerificationToken === token1, 'same domain must not rotate the token');
    const dom2 = `portal.t41a-${ts}.example.org`;
    const chg = await put('adminA', { customDomain: dom2 });
    dA = await agencyInDoc(A);
    assert(chg.status === 200 && dA.customDomain === dom2 && dA.domainStatus === 'pending' && dA.domainVerificationToken !== token1, 'changed domain → pending + new token');
    const clr = await put('adminA', { customDomain: '' });
    dA = await agencyInDoc(A);
    assert(clr.status === 200 && !dA.customDomain && !dA.domainVerificationToken && dA.domainStatus === 'none', `cleared domain: ${JSON.stringify(dA)}`);
    const back = await put('adminA', { customDomain: domA });
    assert(back.status === 200, 're-set domain');
    dA = await agencyInDoc(A);
    const liveToken = dA.domainVerificationToken;

    // --- 6. uniqueness (normalised both sides, legacy value, atomic) ----------
    const takenSlug = await put('adminB', { slug: `  ${slugA.toUpperCase()} ` });
    assert(takenSlug.status === 409, `B taking A's slug must be 409, got ${takenSlug.status}`);
    const takenDom = await put('adminB', { customDomain: `${domA.toUpperCase()}.` });
    assert(takenDom.status === 409, `B taking A's domain (case/dot variant) must be 409, got ${takenDom.status}`);
    const takenLegacy = await put('adminB', { customDomain: legacyDomain.toLowerCase().replace(/\.$/, '') });
    assert(takenLegacy.status === 409, `B taking a LEGACY unnormalised domain must be 409, got ${takenLegacy.status}`);
    const takenLegacySlug = await put('adminB', { slug: legacySlugNorm });
    assert(takenLegacySlug.status === 409, `B taking a LEGACY unnormalised slug (spaces + uppercase) must be 409, got ${takenLegacySlug.status}`);
    const freeSlugB = `t41b-${ts}`;
    const vAtomic = await ctx.getVersion();
    const atomic = await put('adminB', { slug: freeSlugB, customDomain: domA });
    assert(atomic.status === 409, `free slug + taken domain must be 409, got ${atomic.status}`);
    assert((await agencyInDoc(B)).slug !== freeSlugB && (await ctx.getVersion()) === vAtomic, 'atomic: the free slug must NOT have been applied');

    // --- 7. concurrency --------------------------------------------------------
    for (let round = 0; round < 10; round++) {
      const s = `race-${round}-${ts}`;
      const v = await ctx.getVersion();
      const send = (who) => call(who, 'PUT', '/api/agencies/current', { slug: s, expectedVersion: v });
      const [ra, rb] = await Promise.all([send('adminA'), send('adminB')]);
      const wins = [ra, rb].filter((r) => r.status === 200).length;
      assert(wins === 1, `round ${round}: exactly one claim may win (got ${ra.status}/${rb.status})`);
      assert([ra, rb].every((r) => r.status === 200 || r.status === 409), `round ${round}: loser must be 409 (got ${ra.status}/${rb.status})`);
      const holders = ((await ctx.getDoc()).agencies || []).filter((a) => a.slug === s);
      assert(holders.length === 1, `round ${round}: ${holders.length} agencies hold ${s}`);
      const loser = ra.status === 200 ? 'adminB' : 'adminA';
      const retry = await put(loser, { slug: s });
      assert(retry.status === 409, `round ${round}: loser retry on a fresh version must be refused as taken (got ${retry.status})`);
    }
    // Two registrations with one short code at the same instant → distinct slugs.
    const reg = (n) => fetch(`${baseUrl}/api/agencies/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agencyName: `Race Agency ${n} ${ts}`, shortCode: `RC${ts}`.slice(0, 12), adminName: `Race ${n}`, adminEmail: `race${n}-${ts}@test.local`, adminPassword: 'race-password-123', initialVenueName: `Race Venue ${n}` }),
    }).then(async (r) => { const t = await r.text(); seen.push(t); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j }; });
    const [g1, g2] = await Promise.all([reg(1), reg(2)]);
    assert(g1.status === 201 && g2.status === 201, `both registrations must succeed: ${g1.status}/${g2.status}`);
    const s1 = g1.json.agency?.slug; const s2 = g2.json.agency?.slug;
    assert(s1 && s2 && s1 !== s2, `registrations need distinct slugs: ${s1} / ${s2}`);

    // --- 1b. WebSocket egress ------------------------------------------------
    const wsMash = await connectWs(baseUrl, tok.mashA);
    const wsAdmin = await connectWs(baseUrl, tok.adminA);
    const bump = await put('adminA', { brandName: `Brand ${ts}` });
    assert(bump.status === 200, 'brand update for WS check');
    const mMash = await wsMash.waitFor((m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.brandName === `Brand ${ts}`);
    const mAdmin = await wsAdmin.waitFor((m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.brandName === `Brand ${ts}`);
    assert(mMash && mAdmin, 'both sockets receive AGENCY_UPDATED');
    for (const k of ['adminEmail', 'createdAt', ...DOMAIN_KEYS]) {
      assert(!(k in mMash.payload.agency), `mashgiach socket must not receive ${k}`);
    }
    assert(!('adminEmail' in mMash.payload), 'no top-level adminEmail on the staff socket');
    assert(mAdmin.payload.agency.customDomain === domA && !('domainVerificationToken' in mAdmin.payload.agency), 'admin socket: settings yes, token no');
    for (const m of [...wsMash.messages, ...wsAdmin.messages]) seen.push(JSON.stringify(m));
    wsMash.close(); wsAdmin.close();

    // --- 8. host matching: the 8a customDomain is never read --------------------
    // Domains PR A (plan v4 2a/2c/2g): the agency of an address comes ONLY from
    // APP_SITES (server config) by the raw Host; the 8a customDomain field,
    // pending or verified, no longer resolves anything. A host that is not one
    // of this service's own addresses is UNKNOWN: /api/agencies/by-domain answers
    // 403 SITE_NOT_SET_UP there and names no agency (the positive by-domain case
    // on a configured site is in test 83).
    for (const [label, host] of [['pending domain', domA], ['verified domain', verifiedDomain.toUpperCase()], ['two agencies on one verified domain', dupeDomain]]) {
      const r = await hostGet(baseUrl, '/api/agencies/by-domain', host);
      seen.push(r.text);
      assert(r.status === 403 && r.json?.code === 'SITE_NOT_SET_UP' && !('agency' in (r.json || {})), `${label} must not resolve: ${r.status} ${r.text}`);
      assert(!r.text.includes(verifiedAgency) && !r.text.includes(A) && !r.text.includes(B), `${label}: no agency named`);
    }
    // The DNS proof values never appeared in any response or socket message.
    const all = seen.join('\n');
    assert(!all.includes(liveToken) && !all.includes('f'.repeat(64)), 'a domainVerificationToken value leaked to a client');
    return 'egress allowlists (HTTP + WS), admin-only writes, validation, server-only fields, domain lifecycle, normalised + atomic uniqueness, 10/10 concurrent races, register race, customDomain never selects an agency';
  },
};
