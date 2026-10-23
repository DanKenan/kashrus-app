/**
 * Test 83 (domains plan v4, PR A, 2a-2g): per-agency custom addresses, server.
 * The SITE hosts are real Host headers (site-a.test:<port>, site-m.test:<port>)
 * sent to this server on 127.0.0.1 (the raw Host header is what the server
 * reads). Cookies are host-only, so each Host keeps its own cookie jar here.
 *  U  APP_SITES unset = today: /api/health has no "sites", /api/site says
 *     shared, the shared host signs in (single + multi chooser) exactly as
 *     before, X-Forwarded-Host never selects a site, and an unknown Host gets
 *     403 SITE_NOT_SET_UP for sign-in, session use, sockets and kiosks while
 *     /api/health and /api/site still answer.
 *  P  APP_SITES parsing: a host listed twice, an entry naming a shared host
 *     and an entry for a missing agency are refused (health ok:false, the
 *     host UNKNOWN / SHARED), the valid ones are live with their agency name.
 *  S  /api/site + /api/site/logo + by-domain come from the raw Host only.
 *  O  same-site POST rule: on a SITE host every mutation needs exactly the
 *     site's Origin (none, the shared origin, the other site: 403 CSRF_ORIGIN),
 *     with or without a credential; a shared-host cookie mutation from a site
 *     Origin is refused.
 *  L  password sign-in: own agency in, another agency 403 WRONG_SITE with no
 *     session and no cookie (a wrong password stays the generic 401); a
 *     multi-agency person gets the site agency's membership, no chooser; the
 *     legacy hash upgrade does not run for a wrong-site sign-in.
 *  A  sessions: another agency's token on a site host 403 WRONG_SITE (HTTP
 *     and session adopt), memberships lists only the site agency, activate of
 *     another agency's membership is refused; the token on an unknown host
 *     is SITE_NOT_SET_UP.
 *  W  /ws: unknown host 4403; site host needs the site Origin; another
 *     agency's phone or kiosk token 4403; own agency gets INITIAL_STATE.
 *  K  kiosk: a pairing started on a site host carries the site; polled from
 *     another host it is refused (and the reverse); a site pairing is approved
 *     only by that agency for its venue; device / unpair / login of another
 *     agency's tablet on a site host 403 and nothing changes; PIN sign-in on a
 *     site host for its own tablet works.
 *  I  invites: preview of another agency's invite shows nothing about it;
 *     accept refused before anything is consumed; own agency accepts.
 *  R  reset links, forgot/verify/reset-password and recovery codes: refused
 *     for another agency before anything is written (recovery: the hint only
 *     after the code is proven, code not burned); own agency works.
 *  G  agency registration refused on a site host.
 *  F  passkeys: a passkey made on a site host stores its rpId and lists as
 *     that site; older entries list as "earlier"; sign-in on a site host with
 *     another agency's passkey is refused inside the transaction (no session,
 *     no counter write, challenge consumed); own agency signs in.
 *  Z  back to APP_SITES unset: everything is as in U again.
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const J = (o) => JSON.stringify(o);
function assert(c, m) { if (!c) throw new Error(m); }
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}
class SoftPasskey {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey; this.jwk = publicKey.export({ format: 'jwk' });
    this.credId = crypto.randomBytes(32); this.id = b64u(this.credId); this.counter = 5; this.userHandle = null;
  }
  register(options, origin) {
    const clientData = Buffer.from(J({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([0x45]), cnt, Buffer.alloc(16), len, this.credId, cose]);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.userHandle = options.user.id;
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
  }
  assertion(options, origin) {
    this.counter += 1;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([0x05]), cnt]);
    const clientData = Buffer.from(J({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.priv);
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: this.userHandle }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
  }
}

export default {
  name: 'Test 83: per-agency custom addresses (domains PR A, server)',
  whatItProves: 'With APP_SITES unset the shared host is exactly today and unknown hosts are refused; with APP_SITES set each site host admits only its own agency for password/passkey sign-in, sessions, adopt, memberships, sockets, kiosks, invites, reset links, assisted reset and recovery, checks before writes, and mutations need the site\'s own Origin.',
  async run(baseUrl, ctx) {
    if (typeof ctx.restartServer !== 'function') throw new Error('Test 83 needs the harness restartServer hook');
    const port = Number(new URL(baseUrl).port);
    const ts = Date.now();
    const SHARED = `127.0.0.1:${port}`;
    const SHARED_O = `http://127.0.0.1:${port}`;
    const SA = `site-a.test:${port}`, SA_O = `http://${SA}`;
    const SM = `site-m.test:${port}`, SM_O = `http://${SM}`;
    const UNK = `unmapped.test:${port}`;
    let ipN = 1;
    const ip = () => `10.83.${ts % 200}.${(ipN++ % 250) + 1}`;

    /** One request with an explicit Host header (node:http keeps it as sent). */
    const call = (method, path, { host = SHARED, bearer, cookies, origin, optIn, device, body, headers: extra } = {}) => new Promise((resolve, reject) => {
      const headers = { Host: host, 'X-Forwarded-For': ip(), ...(extra || {}) };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (cookies && cookies.length) headers.Cookie = cookies.join('; ');
      if (origin !== undefined) headers.Origin = origin;
      if (optIn) headers['X-Shutfey-Auth'] = 'cookie';
      if (device !== undefined) headers['X-Kiosk-Device'] = device;
      let data;
      if (body !== undefined) { data = Buffer.from(J(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch {}
          const sc = res.headers['set-cookie'] || [];
          resolve({ status: res.status || res.statusCode, json, text, setCookies: sc, names: sc.map((c) => c.split('=')[0]), headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
    const openWs = (host, token, origin, credential) => new Promise((resolve) => {
      const headers = { Host: host };
      if (origin) headers.Origin = origin;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers });
      const out = { initial: false, code: null };
      const done = () => { try { ws.terminate(); } catch {} resolve(out); };
      const timer = setTimeout(done, 4000);
      ws.on('open', () => { if (credential) ws.send(J({ type: 'KIOSK_DEVICE', credential })); });
      ws.on('message', (m) => { try { if (JSON.parse(String(m)).type === 'INITIAL_STATE') { out.initial = true; clearTimeout(timer); done(); } } catch {} });
      ws.on('close', (code) => { out.code = code; clearTimeout(timer); done(); });
      ws.on('error', () => {});
    });
    const version = () => ctx.getVersion();
    const unchanged = async (v, label) => assert((await version()) === v, `${label}: nothing may be written`);
    const login = (host, email, password, o = {}) => call('POST', '/api/auth/login', { host, origin: o.origin ?? (host === SHARED ? SHARED_O : `http://${host}`), body: { email, password }, ...o });
    const E = (k) => `t83-${k}-${ts}@test.local`;
    const PW = (k) => `t83-pass-${k}-${ts}`;
    const register = async (k) => {
      const r = await call('POST', '/api/agencies/register', { origin: SHARED_O, body: { agencyName: `T83 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T83 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      return { id: r.json.user.id, email: E(k), pw: PW(k), agencyId: r.json.user.agencyId, token: r.json.token };
    };

    // V: every invite-making route's link origin (agency invite, setup invite, pool invite, venue-owner invite).
    const inviteOrigins = async (tok, k, setupTarget, venueId) => {
      const o = {};
      const ag = await call('POST', '/api/agency/invites', { origin: SHARED_O, bearer: tok, body: { name: `T83 ${k} Ag`, email: `t83-${k}-ag-${ts}@test.local`, role: 'mashgiach', venueIds: [venueId], expectedVersion: await version() } });
      assert(ag.status === 201 && /^\/invite#t=/.test(ag.json?.link || ''), `${k} agency invite: ${ag.status} ${J(ag.json && ag.json.error)}`);
      o.agency = ag.json.linkOrigin;
      const su = await call('POST', `/api/users/${setupTarget}/invite`, { origin: SHARED_O, bearer: tok, body: { expectedVersion: await version() } });
      assert(su.status === 201 && /^\/invite#t=/.test(su.json?.link || ''), `${k} setup invite: ${su.status} ${J(su.json && su.json.error)}`);
      o.setup = su.json.linkOrigin;
      const pcA = await call('POST', '/api/pool/contacts', { origin: SHARED_O, bearer: tok, body: { name: `T83 ${k} Pool`, email: `t83-${k}-pool-${ts}@test.local`, expectedVersion: await version() } });
      const pcR = pcA.json?.contact || {};
      assert((pcA.status === 201 || pcA.status === 200) && pcR.id, `${k} pool contact: ${pcA.status} ${J(pcA.json && pcA.json.error)}`);
      const pi = await call('POST', `/api/pool/contacts/${pcR.id}/invite`, { origin: SHARED_O, bearer: tok, body: { expectedUpdatedAt: pcR.updatedAt, expectedEmail: `t83-${k}-pool-${ts}@test.local`, expectedVersion: await version() } });
      assert(pi.status === 201 && /^\/invite#t=/.test(pi.json?.link || ''), `${k} pool invite: ${pi.status} ${J(pi.json && pi.json.error)}`);
      o.pool = pi.json.linkOrigin;
      const vn = await call('POST', '/api/venues', { origin: SHARED_O, bearer: tok, body: { name: `T83 ${k} venue ${ts}`, ownerEmail: `t83-${k}-owner-${ts}@test.local`, ownerName: 'T83 Owner', operationId: `op-t83-${crypto.randomUUID()}` } });
      assert(vn.status === 201 && /^\/invite#t=/.test(vn.json?.ownerInviteLink || ''), `${k} venue owner invite: ${vn.status} ${J(vn.json && vn.json.error)}`);
      o.owner = vn.json.ownerInviteLinkOrigin;
      return o;
    };
    // ---- setup on the shared host (APP_SITES unset) ----
    const a = await register('a');
    const b = await register('b');
    const m = await register('m');
    // V (invite links): c and d are single-agency people who join agency A by invite.
    const c = await register('c');
    const d = await register('d');
    const rx = await call('POST', '/api/agencies/register-existing', { origin: SHARED_O, body: { agencyName: `T83 m2 ${ts}`, email: m.email, password: m.pw, operationId: `op-${crypto.randomUUID()}` } });
    assert(rx.status === 201 || rx.status === 200, `register-existing m: ${rx.status} ${J(rx.json)}`);
    const MB = rx.json?.agency?.id || rx.json?.user?.agencyId;
    assert(MB && MB !== m.agencyId, `m's second agency: ${J(rx.json)}`);
    const A = a.agencyId, B = b.agencyId, MA = m.agencyId;
    const vA = `venue-t83-a-${ts}`, vB = `venue-t83-b-${ts}`, vM = `venue-t83-m-${ts}`;
    const mashA = `usr-t83-mash-a-${ts}`, mashB = `usr-t83-mash-b-${ts}`;
    const PIN = '2468';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      venues: [{ id: vA, name: `T83 Venue A ${ts}`, agencyId: A }, { id: vB, name: `T83 Venue B ${ts}`, agencyId: B }, { id: vM, name: `T83 Venue M ${ts}`, agencyId: MA }],
      users: [
        { id: mashA, email: `t83-mash-a-${ts}@test.local`, name: 'T83 Mash A', role: 'mashgiach', agencyId: A, venueId: vA, kioskPin: PIN },
        { id: mashB, email: `t83-mash-b-${ts}@test.local`, name: 'T83 Mash B', role: 'mashgiach', agencyId: B, venueId: vB, kioskPin: PIN },
      ],
    });
    assert(inj.status === 200, `inject: ${inj.status}`);
    const clear = await call('POST', '/api/__test__/kiosk-clear-lockouts', { bearer: a.token, origin: SHARED_O });
    assert(clear.status === 200, `clear lockouts: ${clear.status}`);

    // ---- U: APP_SITES unset = today ----
    const h0 = await call('GET', '/api/health');
    assert(h0.status === 200 && !('sites' in h0.json), `U health has no sites when unset: ${J(Object.keys(h0.json || {}))}`);
    assert(J((await call('GET', '/api/site')).json) === J({ site: 'shared' }), 'U /api/site on the shared host');
    assert((await call('GET', '/api/site', { headers: { 'X-Forwarded-Host': 'site-a.test' } })).json?.site === 'shared', 'U X-Forwarded-Host does not select a site');
    const la0 = await login(SHARED, a.email, a.pw, { headers: { 'X-Forwarded-Host': 'unmapped.test' } });
    assert(la0.status === 200 && la0.json.token && la0.json.user?.agencyId === A, `U single sign-in on the shared host (X-Forwarded-Host ignored): ${la0.status}`);
    const lm0 = await login(SHARED, m.email, m.pw);
    assert(lm0.status === 200 && lm0.json.chooseMembership === true && lm0.json.memberships.length === 2, `U multi sign-in chooses on the shared host: ${J(lm0.json && Object.keys(lm0.json))}`);
    const u1 = await call('GET', '/api/site', { host: UNK });
    assert(u1.status === 200 && u1.json?.site === 'unknown' && typeof u1.json.sharedOrigin === 'string' && /no-store/.test(String(u1.headers['cache-control'])), `U /api/site on an unknown host: ${J(u1.json)}`);
    assert((await call('GET', '/api/health', { host: UNK })).status === 200, 'U /api/health answers on an unknown host');
    const unkLogin = await login(UNK, a.email, a.pw);
    assert(unkLogin.status === 403 && unkLogin.json?.code === 'SITE_NOT_SET_UP' && unkLogin.names.length === 0, `U unknown host sign-in refused: ${unkLogin.status} ${J(unkLogin.json)}`);
    const unkUse = await call('GET', '/api/agencies/current', { host: UNK, bearer: la0.json.token });
    assert(unkUse.status === 403 && unkUse.json?.code === 'SITE_NOT_SET_UP', `U unknown host session use refused: ${unkUse.status}`);
    for (const [method, path] of [['POST', '/api/kiosk/pairing/start'], ['GET', '/api/kiosk/pairing/status'], ['GET', '/api/kiosk/device'], ['POST', '/api/kiosk/device/unpair'], ['POST', '/api/kiosk/login'],
      ['GET', '/api/invites/preview'], ['POST', '/api/invites/accept'], ['GET', '/api/reset-links/preview'], ['POST', '/api/reset-links/accept'], ['POST', '/api/auth/forgot-password'],
      ['POST', '/api/auth/verify-reset-code'], ['POST', '/api/auth/reset-password'], ['POST', '/api/auth/recover'], ['POST', '/api/auth/passkey/options'], ['POST', '/api/auth/session/adopt'], ['GET', '/api/agencies/by-domain']]) {
      const r = await call(method, path, { host: UNK, origin: `http://${UNK}`, body: method === 'POST' ? {} : undefined });
      assert(r.status === 403 && r.json?.code === 'SITE_NOT_SET_UP', `U unknown host ${method} ${path}: ${r.status} ${J(r.json)}`);
    }
    const wsUnk = await openWs(UNK, la0.json.token, `http://${UNK}`);
    assert(!wsUnk.initial && wsUnk.code === 4403, `U socket on an unknown host closes 4403: ${J(wsUnk)}`);
    const wsShared0 = await openWs(SHARED, la0.json.token, undefined);
    assert(wsShared0.initial, 'U shared-host socket works as today');
    const invU = await call('POST', '/api/users', { origin: SHARED_O, bearer: la0.json.token, body: { name: 'T83 U Invitee', email: `t83-uinv-${ts}@test.local`, role: 'mashgiach', venueId: vA, expectedVersion: await version() } });
    assert(invU.status === 201 && /^\/invite#t=[A-Za-z0-9_-]{43}$/.test(invU.json?.link || '') && invU.json.linkOrigin === null, `U invite link as today, no own address: ${invU.status} ${J(invU.json && { link: !!invU.json.link, linkOrigin: invU.json.linkOrigin })}`);

    // A password hash that needs the legacy upgrade, for L below (a person of agency B).
    // (The upgrade must not run when B signs in on A's site.)
    const legacyRow = `usr-t83-legacy-${ts}`;
    const legacyEmail = `t83-legacy-${ts}@test.local`;
    const legacy2Row = `usr-t83-legacy2-${ts}`;
    const legacy2Email = `t83-legacy2-${ts}@test.local`;
    const injL = await ctx.api('POST', '/api/__test__/inject-fixture', { users: [
      { id: legacyRow, email: legacyEmail, name: 'T83 Legacy', role: 'admin', agencyId: B, password: 'legacy-pass-83' },
      { id: legacy2Row, email: legacy2Email, name: 'T83 Legacy 2', role: 'admin', agencyId: A, password: 'legacy2-pass-83' },
      { id: `usr-t83-setu-${ts}`, personId: `usr-t83-setu-${ts}`, email: `t83-setu-${ts}@test.local`, name: 'T83 Setup U', role: 'mashgiach', agencyId: A, venueId: vA, credentialOrigin: 'admin', password: 'setup-u-pass-83' },
      { id: `usr-t83-sets-${ts}`, personId: `usr-t83-sets-${ts}`, email: `t83-sets-${ts}@test.local`, name: 'T83 Setup S', role: 'mashgiach', agencyId: A, venueId: vA, credentialOrigin: 'admin', password: 'setup-s-pass-83' },
    ] });
    assert(injL.status === 200, `legacy fixture: ${injL.status}`);
    const oU = await inviteOrigins(la0.json.token, 'u', `usr-t83-setu-${ts}`, vA);
    assert(oU.agency === null && oU.setup === null && oU.pool === null && oU.owner === null, `U APP_SITES unset: every invite route answers linkOrigin null: ${J(oU)}`);

    // ---- restart with APP_SITES ----
    const appSites = [`${SA}=${A}`, `${SM}=${MA}`, `dup.test:${port}=${A}`, `dup.test:${port}=${B}`, `ghost.test:${port}=agency-t83-missing`, `${SHARED}=${B}`, 'not an entry'].join(';');
    await ctx.restartServer({ APP_SITES: appSites });
    try {
      // ---- P ----
      const h1 = await call('GET', '/api/health');
      const sites = h1.json?.sites || [];
      const siteOf = (h) => sites.filter((s) => s.host === h);
      assert(siteOf(SA).length === 1 && siteOf(SA)[0].ok === true && siteOf(SA)[0].agencyName === `T83 a ${ts}`, `P site A listed ok: ${J(sites)}`);
      assert(siteOf(`dup.test:${port}`).length === 2 && siteOf(`dup.test:${port}`).every((s) => s.ok === false), 'P duplicate host refused');
      assert(siteOf(`ghost.test:${port}`)[0]?.ok === false && siteOf(`ghost.test:${port}`)[0]?.agencyName === null, 'P missing agency not live');
      assert(siteOf(SHARED)[0]?.ok === false, 'P shared host cannot be a site');
      assert(!J(sites).includes(A) && !J(sites).includes(B), 'P health shows no agency ids');
      assert((await call('GET', '/api/site', { host: `dup.test:${port}` })).json?.site === 'unknown', 'P duplicate host is unknown');
      assert((await call('GET', '/api/site', { host: `ghost.test:${port}` })).json?.site === 'unknown', 'P missing-agency host is unknown');
      assert((await call('GET', '/api/site')).json?.site === 'shared', 'P shared host stays shared');

      // ---- S ----
      const sa = await call('GET', '/api/site', { host: SA });
      assert(sa.status === 200 && sa.json?.site === 'agency' && sa.json.agency?.name === `T83 a ${ts}` && sa.json.sharedOrigin && !J(sa.json).includes(A), `S /api/site on site A: ${J(sa.json)}`);
      assert(/no-store/.test(String(sa.headers['cache-control'])), 'S /api/site is no-store');
      assert('contactPhone' in (sa.json.agency || {}) && (sa.json.agency.contactPhone === null || (typeof sa.json.agency.contactPhone === 'string' && sa.json.agency.contactPhone.length <= 40)), `S /api/site carries contactPhone (string or null): ${J(sa.json.agency)}`);
      assert((await call('GET', '/api/site', { host: SA, headers: { 'X-Forwarded-Host': SM } })).json?.agency?.name === `T83 a ${ts}`, 'S X-Forwarded-Host cannot switch the site');
      const lg = await call('GET', `/api/site/logo?rev=nope`, { host: SA });
      assert(lg.status === 404 && /no-store/.test(String(lg.headers['cache-control'])), `S logo with a wrong rev: ${lg.status}`);
      assert((await call('GET', '/api/site/logo?rev=nope')).status === 404, 'S no logo on the shared host');
      const bd = await call('GET', '/api/agencies/by-domain', { host: SA });
      assert(bd.status === 200 && bd.json?.agency?.name === `T83 a ${ts}`, `S by-domain from the raw Host: ${J(bd.json)}`);
      assert(J((await call('GET', '/api/agencies/by-domain', { headers: { 'X-Forwarded-Host': SA } })).json) === J({ agency: null }), 'S by-domain ignores X-Forwarded-Host');
      const dupHost = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET /api/site HTTP/1.1\r\nHost: ${SA}\r\nHost: ${SA}\r\nConnection: close\r\n\r\n`));
        let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => resolve(d)); s.on('error', () => resolve(d));
      });
      assert(!dupHost.includes('"site":"agency"'), `S two Host headers never select a site: ${dupHost.slice(0, 120)}`);

      // ---- O ----
      for (const origin of [undefined, SHARED_O, SM_O, 'null', `${SA_O}/`]) {
        const r = await call('POST', '/api/auth/login', { host: SA, origin, body: { email: a.email, password: a.pw } });
        assert(r.status === 403 && r.json?.code === 'CSRF_ORIGIN' && r.names.length === 0, `O login on site A with Origin ${J(origin)}: ${r.status}`);
      }
      const la = await login(SA, a.email, a.pw, { optIn: true });
      assert(la.status === 200 && la.json.user?.agencyId === A && la.names.includes('shutfey_s'), `O/L own agency signs in on site A (cookie when opted in): ${la.status} ${J(la.json && la.json.error)}`);
      const aCookie = la.setCookies.find((c) => c.startsWith('shutfey_s=')).split(';')[0];
      const bearerNoOrigin = await call('POST', '/api/updates/seen', { host: SA, bearer: la.json.token, body: { announcementIds: [], noteIds: [], alertIds: [] } });
      assert(bearerNoOrigin.status === 403 && bearerNoOrigin.json?.code === 'CSRF_ORIGIN', `O a Bearer mutation on a site host needs the site Origin too: ${bearerNoOrigin.status}`);
      const bearerOk = await call('POST', '/api/updates/seen', { host: SA, origin: SA_O, bearer: la.json.token, body: { announcementIds: [], noteIds: [], alertIds: [] } });
      assert(![401, 403, 503].includes(bearerOk.status), `O with the site Origin it passes the gate: ${bearerOk.status}`);
      const cookieOk = await call('POST', '/api/updates/seen', { host: SA, origin: SA_O, cookies: [aCookie], optIn: true, body: { announcementIds: [], noteIds: [], alertIds: [] } });
      assert(![401, 403, 503].includes(cookieOk.status), `O cookie mutation on site A with its Origin: ${cookieOk.status}`);
      const la2 = await login(SHARED, a.email, a.pw, { optIn: true });
      const sharedCookie = la2.setCookies.find((c) => c.startsWith('shutfey_s=')).split(';')[0];
      const crossCookie = await call('POST', '/api/updates/seen', { origin: SA_O, cookies: [sharedCookie], optIn: true, body: { announcementIds: [], noteIds: [], alertIds: [] } });
      assert(crossCookie.status === 403 && crossCookie.json?.code === 'CSRF_ORIGIN', `O a site page cannot use shared-host cookies: ${crossCookie.status}`);
      assert((await call('POST', '/api/updates/seen', { origin: SHARED_O, cookies: [sharedCookie], optIn: true, body: { announcementIds: [], noteIds: [], alertIds: [] } })).status !== 403, 'O shared-host cookie mutation as today');

      // ---- L ----
      let v = await version();
      const lb = await login(SA, b.email, b.pw, { optIn: true });
      assert(lb.status === 403 && lb.json?.code === 'WRONG_SITE' && typeof lb.json.sharedOrigin === 'string' && !lb.json.token && lb.names.length === 0, `L another agency refused on site A: ${lb.status} ${J(lb.json)}`);
      const lbBad = await login(SA, b.email, 'wrong-password-83');
      assert(lbBad.status === 401 && lbBad.json?.code !== 'WRONG_SITE', `L a wrong password stays the generic failure: ${lbBad.status}`);
      await unchanged(v, 'L wrong-site sign-in');
      const storedPw = async () => ((await ctx.getDoc()).users || []).find((u) => u.id === legacyRow)?.password;
      assert((await storedPw()) === 'legacy-pass-83', `L legacy fixture holds a plain (pre-bcrypt) password: ${J(await storedPw())}`);
      v = await version();
      const ll = await login(SA, legacyEmail, 'legacy-pass-83');
      assert(ll.status === 403 && ll.json?.code === 'WRONG_SITE', `L legacy-hash person of agency B refused on site A: ${ll.status} ${J(ll.json)}`);
      await unchanged(v, 'L no legacy hash upgrade on a wrong-site sign-in');
      assert((await storedPw()) === 'legacy-pass-83', 'L the legacy password is not upgraded by a wrong-site sign-in');
      const llS = await login(SHARED, legacyEmail, 'legacy-pass-83');
      assert(llS.status === 200 && /^\$2[aby]\$/.test(String(await storedPw())), `L control: a shared-host sign-in upgrades it (as today): ${llS.status} ${J(await storedPw())}`);
      // [DOMA-RV1] P2: the upgrade transaction re-makes the site decision on the
      // FRESH rows. Staged race: the cache still has legacy person L2 in agency A,
      // the stored doc already has L2 in agency B; a site-A sign-in must not write the hash.
      const docR = await ctx.getDoc();
      const l2Row = (docR.users || []).find((u) => u.id === legacy2Row);
      assert(l2Row && l2Row.password === 'legacy2-pass-83' && l2Row.agencyId === A, `L race fixture: ${J(l2Row && { p: l2Row.password, a: l2Row.agencyId })}`);
      const staged = (docR.users || []).map((u) => (u.id === legacy2Row ? { ...u, agencyId: B } : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: staged })).status === 200, 'L race: stage the stored doc');
      v = await version();
      const lRace = await login(SA, legacy2Email, 'legacy2-pass-83');
      const l2After = ((await ctx.getDoc()).users || []).find((u) => u.id === legacy2Row);
      assert(l2After && l2After.password === 'legacy2-pass-83', `L race: no hash upgrade when the fresh row is no longer the site agency's (${lRace.status}): ${J(l2After && l2After.password)}`);
      // [DOMA-RV2] P2: the transaction's refusal is the answer — no session, token or cookie.
      assert(lRace.status === 403 && lRace.json?.code === 'WRONG_SITE' && !lRace.json?.token && !lRace.json?.user && lRace.setCookies.length === 0, `L race: refused WRONG_SITE with no session: ${lRace.status} ${J(lRace.json)} ${J(lRace.names)}`);
      await unchanged(v, 'L race: no session record or other write');
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: docR.users })).status === 200, 'L race: restore the stored doc');
      const lmA = await login(SA, m.email, m.pw);
      assert(lmA.status === 403 && lmA.json?.code === 'WRONG_SITE', `L multi person with no site-A membership refused: ${lmA.status}`);
      const lmM = await login(SM, m.email, m.pw);
      assert(lmM.status === 200 && !lmM.json.chooseMembership && lmM.json.token && lmM.json.user?.agencyId === MA && claimsOf(lmM.json.token).kind !== 'choose', `L multi person on site M gets the MA membership, no chooser: ${lmM.status} ${J(lmM.json && Object.keys(lmM.json))}`);
      const lm2 = await login(SHARED, m.email, m.pw);
      assert(lm2.status === 200 && lm2.json.chooseMembership === true, 'L the shared host still offers the chooser');

      // ---- A ----
      const lbShared = await login(SHARED, b.email, b.pw);
      assert(lbShared.status === 200, 'A b signs in on the shared host');
      const bOnA = await call('GET', '/api/agencies/current', { host: SA, bearer: lbShared.json.token });
      assert(bOnA.status === 403 && bOnA.json?.code === 'WRONG_SITE', `A another agency's session refused on site A: ${bOnA.status}`);
      assert((await call('GET', '/api/agencies/current', { host: SA, bearer: la2.json.token })).status === 200, 'A own agency session (from the shared host) works on site A');
      assert((await call('GET', '/api/agencies/current', { bearer: lbShared.json.token })).status === 200, 'A b on the shared host as today');
      const adoptB = await call('POST', '/api/auth/session/adopt', { host: SA, origin: SA_O, optIn: true, bearer: lbShared.json.token, body: {} });
      assert(adoptB.status === 403 && adoptB.json?.code === 'WRONG_SITE' && adoptB.names.length === 0, `A session adopt of another agency refused: ${adoptB.status} ${J(adoptB.json)}`);
      const adoptA = await call('POST', '/api/auth/session/adopt', { host: SA, origin: SA_O, optIn: true, bearer: la2.json.token, body: {} });
      assert(adoptA.status === 200, `A own-agency adopt on site A: ${adoptA.status} ${J(adoptA.json)}`);
      const chooseTok = lm2.json.token;
      const mems = await call('GET', '/api/auth/memberships', { host: SM, bearer: chooseTok });
      assert(mems.status === 200 && mems.json.memberships.length === 1 && mems.json.memberships[0].agencyId === MA, `A memberships on site M list only MA: ${J(mems.json)}`);
      const memAll = await call('GET', '/api/auth/memberships', { bearer: chooseTok });
      assert(memAll.json?.memberships?.length === 2, 'A the shared host lists both memberships');
      const mbRow = memAll.json.memberships.find((x) => x.agencyId === MB).membershipId;
      const maRow = memAll.json.memberships.find((x) => x.agencyId === MA).membershipId;
      const actB = await call('POST', '/api/auth/activate', { host: SM, origin: SM_O, bearer: chooseTok, body: { membershipId: mbRow } });
      assert(actB.status === 403 && !actB.json?.token, `A activate MB on site M refused: ${actB.status} ${J(actB.json)}`);
      const actA = await call('POST', '/api/auth/activate', { host: SM, origin: SM_O, bearer: chooseTok, body: { membershipId: maRow } });
      assert(actA.status === 200 && actA.json?.token, `A activate MA on site M: ${actA.status}`);
      const dupUse = await call('GET', '/api/agencies/current', { host: `dup.test:${port}`, bearer: la2.json.token });
      assert(dupUse.status === 403 && dupUse.json?.code === 'SITE_NOT_SET_UP', 'A a misconfigured host is SITE_NOT_SET_UP');

      // ---- W ----
      const w1 = await openWs(SA, la.json.token, SA_O);
      assert(w1.initial, `W own agency socket on site A: ${J(w1)}`);
      const w2 = await openWs(SA, la.json.token, undefined);
      assert(!w2.initial && w2.code === 4403, `W site socket without Origin: ${J(w2)}`);
      const w3 = await openWs(SA, la.json.token, SHARED_O);
      assert(!w3.initial && w3.code === 4403, `W site socket with the shared Origin: ${J(w3)}`);
      const w4 = await openWs(SA, lbShared.json.token, SA_O);
      assert(!w4.initial && w4.code === 4403, `W another agency's phone socket: ${J(w4)}`);
      const w5 = await openWs(`ghost.test:${port}`, la.json.token, `http://ghost.test:${port}`);
      assert(!w5.initial && w5.code === 4403, `W misconfigured host socket: ${J(w5)}`);
      assert((await openWs(SHARED, lbShared.json.token, undefined)).initial, 'W shared-host socket as today');

      // ---- K ----
      const startOn = async (host) => {
        const r = await call('POST', '/api/kiosk/pairing/start', { host, origin: host === SHARED ? SHARED_O : `http://${host}`, body: {} });
        assert(r.status === 200 && r.json?.code, `pairing/start on ${host}: ${r.status} ${J(r.json)}`);
        return r.json;
      };
      const approve = (host, token, code, venueId) => call('POST', '/api/kiosk/devices/pair', { host, origin: host === SHARED ? SHARED_O : `http://${host}`, bearer: token, body: { code, venueId } });
      const status = (host, p) => call('GET', '/api/kiosk/pairing/status', { host, headers: { 'X-Kiosk-Pairing': `${p.pairingId}.${p.deviceSecret}` } });
      const pA = await startOn(SA);
      const docP = await ctx.getDoc();
      assert(docP.kioskPairings?.[pA.pairingId]?.pairingSite === A, `K a site pairing stores its agency: ${J(docP.kioskPairings?.[pA.pairingId] && Object.keys(docP.kioskPairings[pA.pairingId]))}`);
      assert((await status(SHARED, pA)).status === 404, 'K a site pairing polled from the shared host is refused');
      assert((await status(SM, pA)).status === 404, 'K a site pairing polled from another site is refused');
      assert((await status(SA, pA)).json?.status === 'pending', 'K the site polls its own pairing');
      const wrongApprover = await approve(SHARED, lbShared.json.token, pA.code, vB);
      assert(wrongApprover.status === 404, `K another agency cannot approve a site pairing: ${wrongApprover.status}`);
      const okApprove = await approve(SA, la.json.token, pA.code, vA);
      assert(okApprove.status === 201, `K the site agency approves its pairing: ${okApprove.status} ${J(okApprove.json)}`);
      const stA = await status(SA, pA);
      assert(stA.status === 200 && stA.json?.status === 'approved', `K approved on the site: ${stA.status}`);
      assert((await status(SHARED, pA)).status === 404, 'K an approved site pairing is still refused from the shared host');
      const devA = `${stA.json.device.id}.${pA.deviceSecret}`;
      const pS = await startOn(SHARED);
      assert(!(await ctx.getDoc()).kioskPairings?.[pS.pairingId]?.pairingSite, 'K a shared-host pairing has no pairingSite');
      assert((await approve(SHARED, lbShared.json.token, pS.code, vB)).status === 201, 'K shared-host pairing approved as today');
      assert((await status(SA, pS)).status === 404, 'K a shared-host pairing polled from a site host is refused');
      const stS = await status(SHARED, pS);
      assert(stS.json?.status === 'approved', 'K shared-host pairing polled from the shared host as today');
      const devB = `${stS.json.device.id}.${pS.deviceSecret}`;
      assert((await call('GET', '/api/kiosk/device', { host: SA, device: devA })).status === 200, 'K own tablet on site A');
      const devBonA = await call('GET', '/api/kiosk/device', { host: SA, device: devB });
      assert(devBonA.status === 403 && devBonA.json?.code === 'WRONG_SITE', `K another agency's tablet on site A: ${devBonA.status}`);
      assert((await call('GET', '/api/kiosk/device', { device: devB })).status === 200, 'K the shared-host tablet on the shared host as today');
      v = await version();
      const unpBonA = await call('POST', '/api/kiosk/device/unpair', { host: SA, origin: SA_O, device: devB, body: {} });
      assert(unpBonA.status === 403 && unpBonA.json?.code === 'WRONG_SITE', `K unpair of another agency's tablet on site A: ${unpBonA.status}`);
      const kbOnA = await call('POST', '/api/kiosk/login', { host: SA, origin: SA_O, device: devB, body: { userId: mashB, pin: PIN } });
      assert(kbOnA.status === 403 && kbOnA.json?.code === 'WRONG_SITE', `K kiosk login of another agency's tablet on site A: ${kbOnA.status}`);
      await unchanged(v, 'K refused kiosk calls');
      assert((await call('GET', '/api/kiosk/device', { device: devB })).status === 200, 'K the refused tablet is still paired');
      const kA = await call('POST', '/api/kiosk/login', { host: SA, origin: SA_O, device: devA, body: { userId: mashA, pin: PIN } });
      assert(kA.status === 200 && kA.json?.token, `K PIN sign-in on site A with its own tablet: ${kA.status} ${J(kA.json)}`);
      const kTasks = await call('GET', '/api/tasks', { host: SA, bearer: kA.json.token, device: devA });
      assert(kTasks.status === 200, `K kiosk session on site A works: ${kTasks.status}`);
      const kOnM = await call('GET', '/api/tasks', { host: SM, bearer: kA.json.token, device: devA });
      assert(kOnM.status === 403 && kOnM.json?.code === 'WRONG_SITE', `K the A kiosk session on site M: ${kOnM.status}`);
      const wk = await openWs(SA, kA.json.token, SA_O, devA);
      assert(wk.initial, `W/K kiosk socket on its own site: ${J(wk)}`);
      const wk2 = await openWs(SM, kA.json.token, SM_O, devA);
      assert(!wk2.initial && wk2.code === 4403, `W/K kiosk socket on another site: ${J(wk2)}`);
      const pM = await startOn(SM);
      assert((await approve(SHARED, la2.json.token, pM.code, vA)).status === 404, 'K a site-M pairing cannot be approved by agency A');
      const kBs = await call('POST', '/api/kiosk/login', { device: devB, origin: SHARED_O, body: { userId: mashB, pin: PIN } });
      assert(kBs.status === 200, `K shared-host kiosk sign-in as today: ${kBs.status}`);
      assert((await call('POST', '/api/kiosk/device/unpair', { host: SA, origin: SA_O, device: devA, body: {} })).status === 200, 'K own tablet unpairs on its site');

      // ---- I ----
      const inv = await call('POST', '/api/users', { origin: SHARED_O, bearer: la2.json.token, body: { name: 'T83 Invitee', email: `t83-inv-${ts}@test.local`, role: 'mashgiach', venueId: vA, expectedVersion: await version() } });
      const invToken = /#t=([A-Za-z0-9_-]+)/.exec(inv.json?.link || '')?.[1];
      assert((inv.status === 201 || inv.status === 200) && typeof invToken === 'string', `I invite created: ${inv.status} ${J(inv.json && Object.keys(inv.json))}`);
      const pvM = await call('GET', '/api/invites/preview', { host: SM, headers: { 'X-Invite-Token': invToken } });
      assert(pvM.status === 403 && J(pvM.json) === J({ available: false, code: 'WRONG_SITE', sharedOrigin: pvM.json.sharedOrigin }) && !pvM.text.includes('T83 Invitee') && !pvM.text.includes(`T83 a ${ts}`), `I preview of another agency's invite shows nothing: ${pvM.text}`);
      assert((await call('GET', '/api/invites/preview', { host: SA, headers: { 'X-Invite-Token': invToken } })).json?.name === 'T83 Invitee', 'I preview on the own site');
      v = await version();
      const accM = await call('POST', '/api/invites/accept', { host: SM, origin: SM_O, body: { token: invToken, mode: 'new', password: 'invitee-pass-83' } });
      assert(accM.status === 403 && accM.json?.code === 'WRONG_SITE' && !accM.json.token, `I accept on another site refused: ${accM.status}`);
      await unchanged(v, 'I refused accept (nothing consumed or counted)');
      const accA = await call('POST', '/api/invites/accept', { host: SA, origin: SA_O, body: { token: invToken, mode: 'new', password: 'invitee-pass-83' } });
      assert(accA.status === 200 && accA.json?.token && accA.json.user?.agencyId === A, `I accept on the own site: ${accA.status} ${J(accA.json && accA.json.error)}`);
      const invitee = accA.json.user;

      // ---- V: invite links point at the agency's own address; redeem on it ----
      assert(inv.json.linkOrigin === SA_O && /^\/invite#t=[A-Za-z0-9_-]{43}$/.test(inv.json.link), `V team invite made on the shared host for site agency A: link path as today + linkOrigin = site A: ${J({ link: inv.json.link && inv.json.link.slice(0, 10), linkOrigin: inv.json.linkOrigin })}`);
      const vLb = await login(SHARED, b.email, b.pw);
      assert(vLb.status === 200 && vLb.json.token && vLb.json.user?.agencyId === B, `V b signs in on the shared host: ${vLb.status}`);
      const invB = await call('POST', '/api/agency/invites', { origin: SHARED_O, bearer: vLb.json.token, body: { name: 'T83 B Invitee', email: `t83-binv-${ts}@test.local`, role: 'mashgiach', venueIds: [vB], expectedVersion: await version() } });
      assert(invB.status === 201 && /^\/invite#t=/.test(invB.json?.link || '') && invB.json.linkOrigin === null, `V agency without its own address: linkOrigin null: ${invB.status} ${J(invB.json && { linkOrigin: invB.json.linkOrigin, err: invB.json.error })}`);
      const invA2 = await call('POST', '/api/agency/invites', { host: SA, origin: SA_O, bearer: la2.json.token, body: { name: 'T83 A Invitee 2', email: `t83-ainv2-${ts}@test.local`, role: 'mashgiach', venueIds: [vA], expectedVersion: await version() } });
      assert(invA2.status === 201 && invA2.json.linkOrigin === SA_O, `V invite made on the site host itself: linkOrigin = site A: ${invA2.status} ${J(invA2.json && { linkOrigin: invA2.json.linkOrigin, err: invA2.json.error })}`);
      const vnA = await call('POST', '/api/venues', { origin: SHARED_O, bearer: la2.json.token, body: { name: `T83 V owner ${ts}`, ownerEmail: `t83-owner-${ts}@test.local`, ownerName: 'T83 Owner', operationId: `op-t83-${crypto.randomUUID()}` } });
      assert(vnA.status === 201 && /^\/invite#t=/.test(vnA.json?.ownerInviteLink || '') && vnA.json.ownerInviteLinkOrigin === SA_O, `V venue owner invite: ownerInviteLinkOrigin = site A: ${vnA.status} ${J(vnA.json && { o: vnA.json.ownerInviteLinkOrigin, err: vnA.json.error })}`);
      const pc = await call('POST', '/api/pool/contacts', { origin: SHARED_O, bearer: la2.json.token, body: { name: 'T83 Pool Yossi', email: `t83-pool-${ts}@test.local`, expectedVersion: await version() } });
      const pcRec = pc.json?.contact || pc.json || {};
      const pcId = pcRec.id;
      assert((pc.status === 201 || pc.status === 200) && pcId, `V pool contact: ${pc.status} ${J(pc.json && Object.keys(pc.json))}`);
      const pci = await call('POST', `/api/pool/contacts/${pcId}/invite`, { origin: SHARED_O, bearer: la2.json.token, body: { expectedUpdatedAt: pcRec.updatedAt, expectedEmail: `t83-pool-${ts}@test.local`, expectedVersion: await version() } });
      assert(pci.status === 201 && /^\/invite#t=/.test(pci.json?.link || '') && pci.json.linkOrigin === SA_O, `V pool invite: linkOrigin = site A: ${pci.status} ${J(pci.json && { o: pci.json.linkOrigin, err: pci.json.error })}`);
      const oS = await inviteOrigins(la2.json.token, 's', `usr-t83-sets-${ts}`, vA);
      assert(oS.agency === SA_O && oS.setup === SA_O && oS.pool === SA_O && oS.owner === SA_O, `V site agency A: every invite route answers linkOrigin = site A: ${J(oS)}`);
      // Existing person of another agency joins A on A's own address: a session for the A membership, no chooser.
      const invC = await call('POST', '/api/users', { origin: SHARED_O, bearer: la2.json.token, body: { name: 'T83 C', email: c.email, role: 'mashgiach', venueId: vA, expectedVersion: await version() } });
      const tokC = /#t=([A-Za-z0-9_-]+)/.exec(invC.json?.link || '')?.[1];
      assert(invC.status === 201 && tokC && invC.json.linkOrigin === SA_O, `V invite for c (agency ${c.agencyId}): ${invC.status} ${J(invC.json && invC.json.error)}`);
      const accC = await call('POST', '/api/invites/accept', { host: SA, origin: SA_O, body: { token: tokC, mode: 'existing', password: c.pw } });
      assert(accC.status === 200 && accC.json?.token && !accC.json.chooseMembership && accC.json.user?.agencyId === A, `V existing other-agency person joins on site A: A session, no chooser: ${accC.status} ${J(accC.json && { keys: Object.keys(accC.json), agencyId: accC.json.user?.agencyId, err: accC.json.error })}`);
      const meC = await call('GET', '/api/agencies/current', { host: SA, bearer: accC.json.token });
      assert(meC.status === 200, `V c's new session works on site A: ${meC.status} ${J(meC.json && meC.json.error)}`);
      const memC = await call('GET', '/api/auth/memberships', { host: SA, bearer: accC.json.token });
      assert(memC.status === 200 && (memC.json?.memberships || []).length === 1 && memC.json.memberships[0].agencyId === A, `V c's memberships on site A list only A: ${J(memC.json)}`);
      const lcS = await login(SHARED, c.email, c.pw);
      assert(lcS.status === 200 && lcS.json.chooseMembership === true && lcS.json.memberships.length === 2, `V c is now in two agencies (shared host chooses): ${J(lcS.json && Object.keys(lcS.json))}`);
      const lcA = await login(SA, c.email, c.pw);
      assert(lcA.status === 200 && !lcA.json.chooseMembership && lcA.json.user?.agencyId === A, `V c signs in on site A: A, no chooser: ${lcA.status}`);
      // The same accept on the shared host (an old shared link) is exactly today: the chooser.
      const invD = await call('POST', '/api/users', { origin: SHARED_O, bearer: la2.json.token, body: { name: 'T83 D', email: d.email, role: 'mashgiach', venueId: vA, expectedVersion: await version() } });
      const tokD = /#t=([A-Za-z0-9_-]+)/.exec(invD.json?.link || '')?.[1];
      assert(invD.status === 201 && tokD, `V invite for d: ${invD.status}`);
      const accD = await call('POST', '/api/invites/accept', { origin: SHARED_O, body: { token: tokD, mode: 'existing', password: d.pw } });
      assert(accD.status === 200 && accD.json?.chooseMembership === true && accD.json.memberships.length === 2 && (await call('GET', '/api/agencies/current', { bearer: accD.json.token })).status === 401, `V old shared link: accept on the shared host still chooses as today: ${accD.status} ${J(accD.json && Object.keys(accD.json))}`);
      // A new person with an A invite on the shared host (old link) still joins there as today.
      const invN = await call('POST', '/api/users', { origin: SHARED_O, bearer: la2.json.token, body: { name: 'T83 N', email: `t83-ninv-${ts}@test.local`, role: 'mashgiach', venueId: vA, expectedVersion: await version() } });
      const tokN = /#t=([A-Za-z0-9_-]+)/.exec(invN.json?.link || '')?.[1];
      const accN = await call('POST', '/api/invites/accept', { origin: SHARED_O, body: { token: tokN, mode: 'new', password: 'invitee-n-pass-83' } });
      assert(accN.status === 200 && accN.json?.token && accN.json.user?.agencyId === A, `V old shared link, new person, joins on the shared host: ${accN.status} ${J(accN.json && accN.json.error)}`);

      // ---- R ----
      const mk = await call('POST', `/api/users/${invitee.id}/reset-link`, { origin: SHARED_O, bearer: la2.json.token, body: { expectedVersion: await version() } });
      const rawReset = /#t=([A-Za-z0-9_-]+)$/.exec(mk.json?.link || '')?.[1];
      assert(mk.status === 200 || mk.status === 201, `R reset link made: ${mk.status} ${J(mk.json && Object.keys(mk.json))}`);
      assert(typeof rawReset === 'string', `R reset token: ${J(mk.json)}`);
      const rpM = await call('GET', '/api/reset-links/preview', { host: SM, headers: { 'X-Reset-Token': rawReset } });
      assert(rpM.status === 403 && rpM.json?.code === 'WRONG_SITE' && !rpM.text.includes('T83'), `R reset preview on another site: ${rpM.text}`);
      v = await version();
      const raM = await call('POST', '/api/reset-links/accept', { host: SM, origin: SM_O, headers: { 'X-Reset-Token': rawReset }, body: { newPassword: 'reset-pass-83-new' } });
      assert(raM.status === 403 && raM.json?.code === 'WRONG_SITE', `R reset accept on another site: ${raM.status}`);
      await unchanged(v, 'R refused reset-link accept');
      assert((await call('GET', '/api/reset-links/preview', { host: SA, headers: { 'X-Reset-Token': rawReset } })).status === 200, 'R the link still works on its own site');
      // Assisted reset (forgot / verify / reset-password) for a single-agency person of A.
      const fpM = await call('POST', '/api/auth/forgot-password', { host: SM, origin: SM_O, body: { email: a.email } });
      assert(fpM.status === 200 && fpM.json?.success === true, `R forgot-password on another site: same generic answer: ${fpM.status}`);
      assert(!((await ctx.getDoc()).passwordResets || []).some((r) => r.email === a.email), 'R no reset request created on another site');
      const fpS = await call('POST', '/api/auth/forgot-password', { origin: SHARED_O, body: { email: a.email } });
      assert(fpS.status === 200 && ((await ctx.getDoc()).passwordResets || []).some((r) => r.email === a.email), 'R forgot-password on the shared host creates the request (as today)');
      const codeRes = await call('GET', `/api/__test__/last-reset-code?email=${encodeURIComponent(a.email)}`, { bearer: la2.json.token });
      const code = codeRes.json?.code;
      assert(typeof code === 'string', `R test code: ${codeRes.status}`);
      const vrM = await call('POST', '/api/auth/verify-reset-code', { host: SM, origin: SM_O, body: { email: a.email, code } });
      assert(vrM.status !== 200 || !vrM.json?.resetToken, `R verify on another site gives no reset token: ${vrM.status} ${J(vrM.json)}`);
      const reqAfter = ((await ctx.getDoc()).passwordResets || []).find((r) => r.email === a.email);
      assert(reqAfter && !reqAfter.verified && !reqAfter.attempts, `R the request is untouched after a wrong-site verify: ${J(reqAfter && { v: reqAfter.verified, a: reqAfter.attempts })}`);
      const vrS = await call('POST', '/api/auth/verify-reset-code', { origin: SHARED_O, body: { email: a.email, code } });
      assert(vrS.status === 200 && vrS.json?.resetToken, `R verify on the shared host: ${vrS.status}`);
      v = await version();
      const rpw = await call('POST', '/api/auth/reset-password', { host: SM, origin: SM_O, body: { email: a.email, resetToken: vrS.json.resetToken, newPassword: 'a-new-pass-83' } });
      assert(rpw.status === 400, `R reset-password on another site: ${rpw.status}`);
      await unchanged(v, 'R refused reset-password');
      assert((await login(SA, a.email, a.pw)).status === 200, 'R a\'s password unchanged');
      // Recovery codes (m, self-registered): on site A m has no membership.
      const lmMs = await login(SM, m.email, m.pw);
      const rcodes = await call('POST', '/api/auth/recovery-codes', { host: SM, origin: SM_O, bearer: lmMs.json.token, body: { currentPassword: m.pw } });
      assert(rcodes.status === 200 && Array.isArray(rcodes.json?.codes), `R recovery codes issued: ${rcodes.status} ${J(rcodes.json && rcodes.json.error)}`);
      const rc = rcodes.json.codes[0];
      v = await version();
      const recA = await call('POST', '/api/auth/recover', { host: SA, origin: SA_O, body: { email: m.email, code: rc, newPassword: 'm-recovered-83' } });
      assert(recA.status === 401 && recA.json?.code === 'WRONG_SITE' && !recA.json.token, `R recovery on another site: hint after a valid code: ${recA.status} ${J(recA.json)}`);
      await unchanged(v, 'R refused recovery (code not burned)');
      const recBad = await call('POST', '/api/auth/recover', { host: SA, origin: SA_O, body: { email: m.email, code: 'AAAA-BBBB-CCCC', newPassword: 'm-recovered-83' } });
      assert(recBad.status === 401 && recBad.json?.code !== 'WRONG_SITE', 'R a wrong code gets no hint');
      // [DOMA-RV1] P2: the recovery site check reads the transaction's FRESH rows.
      // Staged race: the cache still has m's MA membership eligible, the stored doc
      // has it paused; recovery on site M must burn nothing and change nothing.
      const docQ = await ctx.getDoc();
      const stagedQ = (docQ.users || []).map((u) => (u.id === maRow ? { ...u, resetSuspended: { at: new Date().toISOString(), reason: 't83-race' } } : u));
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: stagedQ })).status === 200, 'R race: stage the stored doc');
      const credBefore = J((docQ.users || []).find((u) => u.personId && u.email === m.email && u.recoveryCodeHashes)?.recoveryCodeHashes);
      const recRace = await call('POST', '/api/auth/recover', { host: SM, origin: SM_O, body: { email: m.email, code: rcodes.json.codes[1], newPassword: 'm-race-83' } });
      const docQ2 = await ctx.getDoc();
      const credAfter = J((docQ2.users || []).find((u) => u.personId && u.email === m.email && u.recoveryCodeHashes)?.recoveryCodeHashes);
      assert(recRace.status === 401 && recRace.json?.code === 'WRONG_SITE' && !recRace.json.token, `R race: refused on the fresh rows: ${recRace.status} ${J(recRace.json)}`);
      assert(typeof credBefore === 'string' && credBefore.length > 2 && credAfter === credBefore, `R race: no recovery code burned (${typeof credBefore})`);
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: docQ.users })).status === 200, 'R race: restore the stored doc');
      assert((await login(SM, m.email, m.pw)).status === 200, 'R race: m\'s password unchanged');
      const recM = await call('POST', '/api/auth/recover', { host: SM, origin: SM_O, body: { email: m.email, code: rc, newPassword: 'm-recovered-83' } });
      assert(recM.status === 200 && recM.json?.token && recM.json.user?.agencyId === MA, `R the same code works on m's own site (session for MA): ${recM.status} ${J(recM.json && recM.json.error)}`);
      m.pw = 'm-recovered-83';

      // ---- G ----
      const regA = await call('POST', '/api/agencies/register', { host: SA, origin: SA_O, body: { agencyName: `T83 x ${ts}`, adminEmail: E('x'), adminPassword: PW('x'), adminName: 'T83 x' } });
      assert(regA.status === 403 && regA.json?.code === 'WRONG_SITE', `G registration refused on a site host: ${regA.status}`);
      const regEx = await call('POST', '/api/agencies/register-existing', { host: SA, origin: SA_O, body: { agencyName: `T83 y ${ts}`, email: a.email, password: a.pw, operationId: `op-${crypto.randomUUID()}` } });
      assert(regEx.status === 403 && regEx.json?.code === 'WRONG_SITE', `G register-existing refused on a site host: ${regEx.status}`);

      // ---- F ----
      const addPk = async (host, origin, token, pw) => {
        await call('POST', '/api/auth/recent-auth', { host, origin, bearer: token, body: { password: pw } });
        const op = await call('POST', '/api/passkeys/register/options', { host, origin, bearer: token, body: {} });
        assert(op.status === 200 && op.json?.options?.rp?.id === new URL(origin).hostname, `F register options on ${host}: ${op.status} ${J(op.json && op.json.options && op.json.options.rp)}`);
        const pk = new SoftPasskey();
        const vv = await call('POST', '/api/passkeys/register/verify', { host, origin, bearer: token, body: { challengeId: op.json.challengeId, response: pk.register(op.json.options, origin) } });
        assert(vv.status === 201, `F register verify on ${host}: ${vv.status} ${J(vv.json)}`);
        return { pk, entry: vv.json.passkey };
      };
      const laF = await login(SA, a.email, a.pw);
      const pkA = await addPk(SA, SA_O, laF.json.token, a.pw);
      assert(J(pkA.entry.address) === J({ kind: 'site', agencyName: `T83 a ${ts}` }), `F site passkey lists as that site: ${J(pkA.entry)}`);
      const pcA = await ctx.api('POST', '/api/__test__/passkey-hooks', { action: 'get-person', personId: laF.json.user.personId || claimsOf(laF.json.token).personId || claimsOf(laF.json.token).sub });
      const storedA = (pcA.json?.doc?.passkeys || []).find((p) => p.credentialId === pkA.pk.id);
      assert(pcA.status === 200 && storedA && storedA.rpId === 'site-a.test', `F the stored entry carries its rpId: ${pcA.status} ${J(storedA && storedA.rpId)}`);
      const storedOld = (pcA.json.doc.passkeys || []).filter((p) => p.credentialId !== pkA.pk.id);
      assert(storedOld.length === 0, 'F only the new entry so far');
      const laS = await login(SHARED, a.email, a.pw);
      const pkS = await addPk(SHARED, SHARED_O, laS.json.token, a.pw);
      assert(pkS.entry.address?.kind === 'shared', `F shared passkey lists as shared: ${J(pkS.entry)}`);
      const list = await call('GET', '/api/passkeys', { host: SA, bearer: laF.json.token });
      assert(list.status === 200 && list.json.passkeys.length === 2 && !J(list.json).includes('rpId'), `F list: ${J(list.json)}`);
      const pkSign = async (host, origin, pk) => {
        const op = await call('POST', '/api/auth/passkey/options', { host, origin, body: {} });
        assert(op.status === 200 && op.json.options?.rpId === new URL(origin).hostname, `F sign-in options on ${host}: ${op.status} ${J(op.json && op.json.options)}`);
        const r = await call('POST', '/api/auth/passkey/verify', { host, origin, body: { challengeId: op.json.challengeId, response: pk.assertion(op.json.options, origin) } });
        return { r, challengeId: op.json.challengeId };
      };
      const fA = await pkSign(SA, SA_O, pkA.pk);
      assert(fA.r.status === 200 && fA.r.json?.token && fA.r.json.user?.agencyId === A, `F own-agency passkey sign-in on site A: ${fA.r.status} ${J(fA.r.json)}`);
      // b's passkey (made on the shared host) presented on site A (a software
      // authenticator signs for any RP ID; the server's site gate still refuses).
      const lbF = await login(SHARED, b.email, b.pw);
      const pkB = await addPk(SHARED, SHARED_O, lbF.json.token, b.pw);
      const fB = await pkSign(SA, SA_O, pkB.pk);
      assert(fB.r.status === 403 && fB.r.json?.code === 'WRONG_SITE' && !fB.r.json.token, `F another agency's passkey refused on site A: ${fB.r.status} ${J(fB.r.json)}`);
      const again = await call('POST', '/api/auth/passkey/verify', { host: SA, origin: SA_O, body: { challengeId: fB.challengeId, response: pkB.pk.assertion({ challenge: 'x', rpId: 'site-a.test' }, SA_O) } });
      assert(again.status === 401, 'F the refused challenge was consumed');
      const lbList = await call('GET', '/api/passkeys', { bearer: lbF.json.token });
      assert(lbList.json.passkeys[0].lastUsedAt === null, `F no counter / lastUsed write on a wrong-site passkey sign-in: ${J(lbList.json.passkeys[0])}`);
      const fBs = await pkSign(SHARED, SHARED_O, pkB.pk);
      assert(fBs.r.status === 200 && fBs.r.json.user?.agencyId === B, `F b's passkey on the shared host as today: ${fBs.r.status}`);
      // multi person on site M: passkey sign-in gives the MA membership, no chooser.
      const actM = await call('POST', '/api/auth/activate', { origin: SHARED_O, bearer: (await login(SHARED, m.email, m.pw)).json.token, body: { membershipId: maRow } });
      const pkM = await addPk(SM, SM_O, actM.json.token, m.pw);
      const fM = await pkSign(SM, SM_O, pkM.pk);
      assert(fM.r.status === 200 && !fM.r.json.chooseMembership && fM.r.json.user?.agencyId === MA, `F multi person's passkey on site M: ${fM.r.status} ${J(fM.r.json && Object.keys(fM.r.json))}`);
      const fMs = await pkSign(SHARED, SHARED_O, pkM.pk);
      assert(fMs.r.status === 200 && fMs.r.json.chooseMembership === true, 'F the same passkey on the shared host still chooses');
    } finally {
      // ---- Z: back to APP_SITES unset ----
      await ctx.restartServer({});
    }
    const h2 = await call('GET', '/api/health');
    assert(h2.status === 200 && !('sites' in h2.json), 'Z health without sites again');
    assert((await call('GET', '/api/site', { host: SA })).json?.site === 'unknown', 'Z the former site host is unknown again');
    assert((await login(SA, a.email, a.pw)).json?.code === 'SITE_NOT_SET_UP', 'Z sign-in on the former site host is SITE_NOT_SET_UP');
    assert((await login(SHARED, b.email, b.pw)).status === 200, 'Z shared host sign-in as today');
    return 'unset=today; unknown hosts refused; site hosts admit only their agency (sign-in, passkey, sessions, adopt, memberships, sockets, kiosks, invites, reset links, assisted reset, recovery, registration); checks before writes; same-site POST rule';
  },
};
