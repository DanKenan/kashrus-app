/**
 * Test 86 (FACEID2): Face ID / fingerprint (passkeys) for a person in TWO
 * agencies, one of which has its own address (a SITE host = its own WebAuthn
 * RP ID) besides the shared Shutfey address. Real Host headers on 127.0.0.1.
 *  P  shared address: password -> agency chooser -> chosen session keeps the
 *     password's own proof (choose token ra/re copied unchanged), so a passkey
 *     can be added at once (no second password); the proof still ends 5
 *     minutes after the password.
 *  Q  a choose token whose proof is older than 5 minutes, or from the future,
 *     activates with no proof; malformed or tampered ra/re: 401; a signed-in
 *     session switching agency never carries a proof.
 *  R  Face ID on the shared address -> chooser -> the chosen session is a
 *     passkey session with the assertion as its proof.
 *  H  GET /api/passkeys says which passkeys work HERE (rpId = this Host's
 *     name): a passkey made on the shared host is here only there, one made
 *     on the site host only there; hasPasskeyHere follows; an entry with no
 *     rpId counts as here on the shared host only; an unknown host: never.
 *  E  the person's epoch moving between the sign-in and the choice (a passkey
 *     removed elsewhere) leaves the chosen session with a dead proof.
 *  S  a one-agency person is unchanged (password sign-in proof, list shape).
 */
import http from 'node:http';
import crypto from 'node:crypto';

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
  name: 'Test 86: FACEID2 — Face ID / fingerprint for people in two agencies',
  whatItProves:
    'A two-agency person who signs in through the agency chooser keeps the sign-in proof (never extended) and can add Face ID without typing the password twice; the passkey list says which passkeys work on the address asked from; nothing else about passkeys or the chooser changes.',

  async run(baseUrl, ctx) {
    if (typeof ctx.restartServer !== 'function') throw new Error('Test 86 needs the harness restartServer hook');
    const port = Number(new URL(baseUrl).port);
    const ts = Date.now();
    const SHARED = `127.0.0.1:${port}`, SHARED_O = `http://127.0.0.1:${port}`;
    const SM = `site-f86.test:${port}`, SM_O = `http://${SM}`;
    const UNK = `unmapped-f86.test:${port}`;
    const FIVE_MIN = 5 * 60 * 1000;
    let ipN = 1;
    const ip = () => `10.86.${ts % 200}.${(ipN++ % 250) + 1}`;
    const details = [];
    const call = (method, path, { host = SHARED, bearer, origin, body } = {}) => new Promise((resolve, reject) => {
      const headers = { Host: host, 'X-Forwarded-For': ip() };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (origin !== undefined) headers.Origin = origin;
      let data;
      if (body !== undefined) { data = Buffer.from(J(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
    const O = (host) => (host === SHARED ? SHARED_O : `http://${host}`);
    const hook = (body) => call('POST', '/api/__test__/passkey-hooks', { body });
    const sessionDoc = async (tok) => (await call('POST', '/api/__test__/session-hooks', { body: { action: 'get', sid: claimsOf(tok).sid } })).json?.doc;
    const login = (host, email, password) => call('POST', '/api/auth/login', { host, origin: O(host), body: { email, password } });
    const activate = (host, tok, membershipId) => call('POST', '/api/auth/activate', { host, origin: O(host), bearer: tok, body: { membershipId } });
    const regOptions = (host, tok) => call('POST', '/api/passkeys/register/options', { host, origin: O(host), bearer: tok, body: {} });
    const list = (host, tok) => call('GET', '/api/passkeys', { host, bearer: tok });
    const addPasskey = async (host, tok, pk, label) => {
      const op = await regOptions(host, tok);
      assert(op.status === 200 && op.json?.challengeId, `${label} register options: ${op.status} ${J(op.json && { c: op.json.code, e: op.json.error })}`);
      const v = await call('POST', '/api/passkeys/register/verify', { host, origin: O(host), bearer: tok, body: { challengeId: op.json.challengeId, response: pk.register(op.json.options, O(host)) } });
      assert(v.status === 201 && v.json?.passkey?.id === pk.id, `${label} register verify: ${v.status} ${J(v.json && { c: v.json.code, e: v.json.error })}`);
    };
    const pkSignIn = async (host, pk) => {
      const op = await call('POST', '/api/auth/passkey/options', { host, origin: O(host), body: {} });
      assert(op.status === 200 && op.json?.challengeId, `passkey options: ${op.status}`);
      return call('POST', '/api/auth/passkey/verify', { host, origin: O(host), body: { challengeId: op.json.challengeId, response: pk.assertion(op.json.options, O(host)) } });
    };
    const signClaims = async (claims) => {
      const r = await ctx.api('POST', '/api/__test__/sign-claims', { claims });
      const tok = r.json?.token ?? r.body?.token ?? r.data?.token;
      assert(r.status === 200 && typeof tok === 'string', `sign-claims: ${r.status}`);
      return tok;
    };
    const E = (k) => `t86-${k}-${ts}@test.local`;
    const PW = (k) => `t86-pass-${k}-${ts}`;
    const register = async (k) => {
      const r = await call('POST', '/api/agencies/register', { origin: SHARED_O, body: { agencyName: `T86 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T86 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json)}`);
      return { email: E(k), pw: PW(k), agencyId: r.json.user.agencyId, personId: claimsOf(r.json.token).sub };
    };

    // ---- setup: m = two agencies (MA has its own address SM), s = one agency ----
    const m = await register('m');
    const s = await register('s');
    const rx = await call('POST', '/api/agencies/register-existing', { origin: SHARED_O, body: { agencyName: `T86 m2 ${ts}`, email: m.email, password: m.pw, operationId: `op-${crypto.randomUUID()}` } });
    assert(rx.status === 201 || rx.status === 200, `register-existing m: ${rx.status} ${J(rx.json)}`);
    await ctx.restartServer({ APP_SITES: `${SM}=${m.agencyId}` });
    try {
      // ---- P: shared address, password -> chooser -> proof copied unchanged ----
      const t0 = Date.now();
      const lp = await login(SHARED, m.email, m.pw);
      assert(lp.status === 200 && lp.json?.chooseMembership === true && lp.json.memberships?.length === 2, `P password -> chooser: ${lp.status} ${J(lp.json && Object.keys(lp.json))}`);
      const lc = claimsOf(lp.json.token);
      assert(lc.v === 3 && Number.isSafeInteger(lc.ra) && lc.ra >= t0 - 1000 && lc.ra <= Date.now() && Number.isSafeInteger(lc.re) && lc.re >= 0 && !lc.pk, `P the choose token carries the password proof ${J(lc)}`);
      assert([401, 403].includes((await regOptions(SHARED, lp.json.token)).status), 'P a choose token itself still cannot add a passkey');
      const memMA = lp.json.memberships.find((x) => x.agencyId === m.agencyId);
      const memMB = lp.json.memberships.find((x) => x.agencyId !== m.agencyId);
      assert(memMA && memMB, 'P both memberships listed');
      const ap = await activate(SHARED, lp.json.token, memMB.membershipId);
      assert(ap.status === 200 && ap.json?.token, `P activate: ${ap.status}`);
      const apDoc = await sessionDoc(ap.json.token);
      assert(apDoc.recentAuthAtMs === lc.ra && apDoc.recentAuthEpoch === lc.re && !apDoc.authMethod, `P the chosen session keeps the password's proof, not restarted ${J({ at: apDoc.recentAuthAtMs, ra: lc.ra })}`);
      const pkShared = new SoftPasskey();
      await addPasskey(SHARED, ap.json.token, pkShared, 'P add on the shared address right after choosing (no second password)');
      // the same choose token again (second activation) keeps the SAME moment
      const ap2 = await activate(SHARED, lp.json.token, memMA.membershipId);
      assert(ap2.status === 200 && (await sessionDoc(ap2.json.token)).recentAuthAtMs === lc.ra, 'P a second activation copies the same moment (never extended)');
      // logging out an activated session does not end the choose token (the existing reusable chooser);
      // a replay copies the SAME moment and epoch - never a new or longer proof
      const lo = await call('POST', '/api/auth/logout', { host: SHARED, origin: SHARED_O, bearer: ap2.json.token, body: {} });
      assert(lo.status === 200, `P logout of the 2nd session: ${lo.status}`);
      const ap3 = await activate(SHARED, lp.json.token, memMA.membershipId);
      const ap3Doc = await sessionDoc(ap3.json.token);
      assert(ap3.status === 200 && ap3Doc.recentAuthAtMs === lc.ra && ap3Doc.recentAuthEpoch === lc.re, 'P a replay after logout copies the same moment and epoch');
      assert((await hook({ action: 'age-recent-auth', sid: claimsOf(ap.json.token).sid, ageMs: FIVE_MIN })).json?.ok === true, 'P age');
      assert((await regOptions(SHARED, ap.json.token)).json?.code === 'RECENT_AUTH_REQUIRED', 'P the copied proof still ends 5 minutes after the password');
      details.push('P shared address: password -> chooser -> chosen session keeps the password proof (same moment, also on a 2nd activation) -> passkey added with no second password; ends after 5 min');

      // ---- Q: aged / future / malformed / tampered proofs; agency switch ----
      const base = { v: 3, sub: lc.sub, cr: lc.cr, ep: lc.ep };
      const old = await signClaims({ ...base, ra: Date.now() - FIVE_MIN - 1000, re: lc.re });
      const qo = await activate(SHARED, old, memMB.membershipId);
      assert(qo.status === 200 && (await sessionDoc(qo.json.token)).recentAuthAtMs === undefined, `Q a proof older than 5 min is not copied: ${qo.status}`);
      assert((await regOptions(SHARED, qo.json.token)).json?.code === 'RECENT_AUTH_REQUIRED', 'Q ... and the session must re-enter the password');
      const fourMin = Date.now() - 4 * 60 * 1000;
      const q4 = await activate(SHARED, await signClaims({ ...base, ra: fourMin, re: lc.re }), memMB.membershipId);
      assert(q4.status === 200 && (await sessionDoc(q4.json.token)).recentAuthAtMs === fourMin, 'Q a 4-minute-old proof is copied with its own moment (1 minute left)');
      const qn = await activate(SHARED, await signClaims(base), memMB.membershipId);
      assert(qn.status === 200 && (await sessionDoc(qn.json.token)).recentAuthAtMs === undefined, 'Q a choose token from before this change (no ra/re) activates with no proof');
      const qf = await activate(SHARED, await signClaims({ ...base, ra: Date.now() + 60000, re: lc.re }), memMB.membershipId);
      assert(qf.status === 200 && (await sessionDoc(qf.json.token)).recentAuthAtMs === undefined, 'Q a proof from the future is not copied');
      for (const [label, extra] of [['ra without re', { ra: Date.now() }], ['re without ra', { re: 0 }], ['negative ra', { ra: -1, re: 0 }], ['float ra', { ra: Date.now() + 0.5, re: 0 }], ['string ra', { ra: String(Date.now()), re: 0 }], ['negative re', { ra: Date.now(), re: -1 }], ['unsafe ra', { ra: 2 ** 60, re: 0 }]]) {
        const r = await activate(SHARED, await signClaims({ ...base, ...extra }), memMB.membershipId);
        assert(r.status === 401 && !r.json?.token, `Q malformed proof (${label}) refuses the token: ${r.status}`);
      }
      const [h, p, sig] = lp.json.token.split('.');
      const forged = `${h}.${b64u(J({ ...claimsOf(lp.json.token), ra: Date.now() }))}.${sig}`;
      assert((await activate(SHARED, forged, memMB.membershipId)).status === 401, 'Q a tampered ra (signature) is refused');
      // a signed-in session WITH a live proof switching agency: the new session has none
      const lp2 = await login(SHARED, m.email, m.pw);
      const live = await activate(SHARED, lp2.json.token, memMB.membershipId);
      assert(typeof (await sessionDoc(live.json.token)).recentAuthAtMs === 'number', 'Q the session has a live proof');
      const sw = await activate(SHARED, live.json.token, memMA.membershipId);
      assert(sw.status === 200 && sw.json?.token && (await sessionDoc(sw.json.token)).recentAuthAtMs === undefined, `Q an agency switch from a signed-in session carries no proof: ${sw.status}`);
      details.push('Q older than 5 min / future: activated with no proof; 4 min: copied with its own moment; 7 malformed ra/re shapes + a tampered signature: 401; agency switch from a session: no proof');

      // ---- R: Face ID on the shared address -> chooser -> passkey session with proof ----
      const r1 = await pkSignIn(SHARED, pkShared);
      assert(r1.status === 200 && r1.json?.chooseMembership === true, `R Face ID -> chooser: ${r1.status} ${J(r1.json && { c: r1.json.code })}`);
      const rc = claimsOf(r1.json.token);
      assert(rc.pk === pkShared.id && Number.isSafeInteger(rc.ra) && Number.isSafeInteger(rc.re), `R the choose token names the passkey and carries the assertion proof ${J(rc)}`);
      const ra = await activate(SHARED, r1.json.token, memMA.membershipId);
      const raDoc = await sessionDoc(ra.json.token);
      assert(ra.status === 200 && raDoc.authMethod?.credentialId === pkShared.id && raDoc.recentAuthAtMs === rc.ra && raDoc.recentAuthEpoch === rc.re, `R the chosen session is a passkey session with the proof ${J({ am: raDoc.authMethod, at: raDoc.recentAuthAtMs })}`);
      assert((await regOptions(SHARED, ra.json.token)).status === 200, 'R it may add a passkey without the password');
      details.push('R Face ID -> chooser -> passkey session carrying the assertion proof');

      // ---- H: which passkeys work HERE ----
      const ls = await login(SM, m.email, m.pw);
      assert(ls.status === 200 && ls.json?.token && !ls.json.chooseMembership && ls.json.user?.agencyId === m.agencyId, `H site address: password signs in to the site agency directly: ${ls.status}`);
      const h1 = await list(SM, ls.json.token);
      assert(h1.status === 200 && h1.json.passkeys.length === 1 && h1.json.passkeys[0].here === false && h1.json.hasPasskeyHere === false && h1.json.canAdd === true,
        `H on the site address the shared-address passkey is listed but NOT here ${J(h1.json)}`);
      const h0 = await list(SHARED, ap3.json.token);
      assert(h0.json.passkeys.length === 1 && h0.json.passkeys[0].here === true && h0.json.hasPasskeyHere === true, `H on the shared address it is here ${J(h0.json)}`);
      const pkSite = new SoftPasskey();
      await addPasskey(SM, ls.json.token, pkSite, 'H add on the site address');
      const h2 = await list(SM, ls.json.token);
      const byId = (l, id) => l.json.passkeys.find((x) => x.id === id);
      assert(h2.json.hasPasskeyHere === true && byId(h2, pkSite.id)?.here === true && byId(h2, pkShared.id)?.here === false, `H site: the site passkey is here, the shared one not ${J(h2.json)}`);
      const h3 = await list(SHARED, ap3.json.token);
      assert(h3.json.hasPasskeyHere === true && byId(h3, pkSite.id)?.here === false && byId(h3, pkShared.id)?.here === true, `H shared: the shared passkey is here, the site one not ${J(h3.json)}`);
      // a passkey with no stored rpId (made before rpIds were stored): here on the shared host only
      assert((await hook({ action: 'strip-rpid', personId: m.personId, credentialId: pkShared.id })).json?.ok === true, 'H strip rpId');
      const h4 = await list(SHARED, ap3.json.token);
      assert(byId(h4, pkShared.id)?.here === true && byId(h4, pkShared.id)?.address?.kind === 'earlier', `H an earlier entry is here on the shared address ${J(h4.json)}`);
      const h5 = await list(SM, ls.json.token);
      assert(byId(h5, pkShared.id)?.here === false, `H an earlier entry is not here on a site address ${J(h5.json)}`);
      const hx = await call('GET', '/api/passkeys', { host: SHARED, bearer: ap3.json.token });
      const hxSpoof = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/passkeys', headers: { Host: SHARED, 'X-Forwarded-Host': SM, Authorization: `Bearer ${ap3.json.token}` } }, (res) => {
          const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
        });
        req.on('error', reject); req.end();
      });
      assert(J(hxSpoof.passkeys.map((x) => [x.id, x.here])) === J(hx.json.passkeys.map((x) => [x.id, x.here])), 'H X-Forwarded-Host never changes what "here" means (raw Host only)');
      const h6 = await list(UNK, ls.json.token);
      assert(h6.status !== 200 || (h6.json.hasPasskeyHere === false && h6.json.passkeys.every((x) => x.here === false)), `H an unknown host never says here: ${h6.status}`);
      details.push('H list: here/hasPasskeyHere follow the Host (shared vs site), earlier entries count on the shared host only, unknown host never');

      // ---- E: the epoch moves between sign-in and choice ----
      const le = await login(SHARED, m.email, m.pw);
      const ec = claimsOf(le.json.token);
      const del = await call('DELETE', `/api/passkeys/${encodeURIComponent(pkSite.id)}`, { host: SM, origin: SM_O, bearer: ls.json.token });
      assert(del.status === 200, `E remove the site passkey (bumps the epoch): ${del.status} ${J(del.json)}`);
      const ea = await activate(SHARED, le.json.token, memMB.membershipId);
      const eaDoc = await sessionDoc(ea.json.token);
      assert(ea.status === 200 && eaDoc.recentAuthEpoch === ec.re && (await regOptions(SHARED, ea.json.token)).json?.code === 'RECENT_AUTH_REQUIRED', `E the copied proof is dead once the epoch moved ${J({ re: ec.re, doc: eaDoc && eaDoc.recentAuthEpoch })}`);
      // epoch moving AFTER the choice: the copied proof dies too
      const le2 = await login(SHARED, m.email, m.pw);
      const ea2 = await activate(SHARED, le2.json.token, memMB.membershipId);
      const op2 = await regOptions(SHARED, ea2.json.token);
      assert(op2.status === 200, `E fresh chosen session may add: ${op2.status}`);
      const pkTmp = new SoftPasskey();
      await addPasskey(SHARED, ea2.json.token, pkTmp, 'E add a passkey to remove');
      const del2 = await call('DELETE', `/api/passkeys/${encodeURIComponent(pkTmp.id)}`, { host: SHARED, origin: SHARED_O, bearer: ea2.json.token });
      assert(del2.status === 200, `E remove it (epoch moves): ${del2.status}`);
      const le3 = await login(SHARED, m.email, m.pw);
      const ea3 = await activate(SHARED, le3.json.token, memMA.membershipId);
      assert((await regOptions(SHARED, ea3.json.token)).status === 200, 'E a NEW sign-in after the move works again');
      const lc4 = await login(SHARED, m.email, m.pw);
      const ea4 = await activate(SHARED, lc4.json.token, memMB.membershipId);
      const op4 = await regOptions(SHARED, ea4.json.token);
      assert(op4.status === 200, 'E options before the move');
      const pkTmp2 = new SoftPasskey();
      await addPasskey(SHARED, ea3.json.token, pkTmp2, 'E add a second one');
      assert((await call('DELETE', `/api/passkeys/${encodeURIComponent(pkTmp2.id)}`, { host: SHARED, origin: SHARED_O, bearer: ea3.json.token })).status === 200, 'E remove it from another session (epoch moves after ea4 was chosen)');
      const v4 = await call('POST', '/api/passkeys/register/verify', { host: SHARED, origin: SHARED_O, bearer: ea4.json.token, body: { challengeId: op4.json.challengeId, response: new SoftPasskey().register(op4.json.options, SHARED_O) } });
      assert(v4.status === 403 && v4.json?.code === 'RECENT_AUTH_REQUIRED', `E the epoch moved between options and verify: refused ${v4.status} ${J(v4.json)}`);
      details.push('E a passkey removed before or after the choice (also between options and verify): the chosen session must re-enter the password');

      // ---- S: one-agency person unchanged ----
      const sl = await login(SHARED, s.email, s.pw);
      assert(sl.status === 200 && sl.json?.token && !sl.json.chooseMembership && typeof (await sessionDoc(sl.json.token)).recentAuthAtMs === 'number', `S one agency: session with the password proof as before: ${sl.status}`);
      const sls = await list(SHARED, sl.json.token);
      assert(sls.status === 200 && Array.isArray(sls.json.passkeys) && sls.json.passkeys.length === 0 && sls.json.hasPasskeyHere === false && sls.json.canAdd === true, `S list: ${J(sls.json)}`);
      details.push('S one agency unchanged');
    } finally {
      await ctx.restartServer({});
    }
    return { details };
  },
};
