/**
 * Test 80 (item 11, PR 11b-s, plan v8 11b-s + 9.4 / 9.5 / 10.3 / 10.4 / 10.7 /
 * 10.8 / 11.2): passkey ("Face ID / fingerprint") server routes, driven by a
 * software authenticator (an ES256 key in node building 'none' attestations
 * and assertions).
 *  A  add: a fresh password sign-in is a 5-minute proof on its own session;
 *     options are discoverable + userVerification 'required' with an opaque
 *     user id (never the person id or the email); verify stores the passkey in
 *     personCredentials (not in users[]) and the index; the list shows names
 *     only. Refused: foreign Origin, a stale proof (then a password re-entry
 *     opens it again; a wrong password is 403, never 401), a replayed or
 *     expired challenge, wrong origin / RP ID in the response, no user
 *     verification, the same passkey twice, more than 10; a choose token, a
 *     token from before item 11 and a kiosk token cannot add one.
 *  B  every credential origin may enroll with a fresh proof, including absent;
 *     stale proof needs password re-entry; verify rechecks credential readiness.
 *  C  sign-in: same answer as a password sign-in (token + user; the cookie when
 *     opted in); the person comes only from the index (an email in the body is
 *     ignored); refused (generic 401): replay, expired challenge, a register
 *     challenge, wrong user handle, unknown credential, counter going back,
 *     wrong origin, no user verification, foreign Origin (403); a synced
 *     passkey (counter always 0) works every time.
 *  D  multi-agency: a passkey sign-in gives the choose token; the chosen
 *     session is a passkey session; a fresh password sign-in still chooses.
 *     FACEID2: the chosen session keeps the sign-in's own proof (password or
 *     Face ID), unchanged, so it may add a passkey without a second password
 *     for the rest of those 5 minutes.
 *  E  removal: needs a fresh proof; sessions from that passkey are refused at
 *     once (HTTP, socket 4401, and on a re-read as another instance would),
 *     password sessions keep working but lose their proof; the id can never be
 *     added again; sign-in with it is refused; rename works.
 *  F  fail closed: a person whose last membership is gone cannot sign in with a
 *     passkey even though the credential doc is still there.
 *  G  races (test hook pausing a transaction between its reads and writes):
 *     sign-in vs removal in both orders never leaves a usable session; two
 *     parallel assertions with the same counter: one wins.
 *  H  store outage: 503, never 401; afterwards it works.
 *  I  nothing about passkeys is in the app-state document; restart keeps
 *     passkeys; the passkey test hook is 404 outside test mode.
 *  J  a fresh email+password sign-in (single + multi-agency) and a kiosk entry
 *     and exit still work afterwards.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
const J = (o) => JSON.stringify(o);
function assert(c, m) { if (!c) throw new Error(m); }
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- minimal CBOR encoder (maps, ints, byte and text strings) ---
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/** A software passkey: ES256, 'none' attestation, UP + UV unless told otherwise. counterMode 'inc' or 'zero' (synced passkey). */
class SoftPasskey {
  constructor(counterMode = 'inc') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey; this.jwk = publicKey.export({ format: 'jwk' });
    this.credId = crypto.randomBytes(32); this.id = b64u(this.credId);
    this.counter = counterMode === 'zero' ? 0 : 5; this.mode = counterMode; this.userHandle = null;
  }
  register(options, origin, o = {}) {
    const clientData = Buffer.from(J({ type: 'webauthn.create', challenge: o.challenge || options.challenge, origin: o.origin || origin, crossOrigin: false }));
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const flags = o.noUV ? 0x41 : 0x45; // UP | AT (| UV)
    const authData = Buffer.concat([sha256(o.rpId || options.rp.id), Buffer.from([flags]), cnt, Buffer.alloc(16), len, this.credId, cose]);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.userHandle = options.user.id;
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
  }
  assertion(options, origin, o = {}) {
    if (this.mode === 'inc' && !o.keepCounter) this.counter += 1;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(o.counter ?? this.counter);
    const flags = o.noUV ? 0x01 : 0x05;
    const authData = Buffer.concat([sha256(o.rpId || options.rpId), Buffer.from([flags]), cnt]);
    const clientData = Buffer.from(J({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin || origin, crossOrigin: false }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.priv);
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: o.userHandle ?? this.userHandle }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
  }
}

async function call(baseUrl, method, path, { bearer, cookies, origin, optIn, device, ip, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (cookies && cookies.length) headers.Cookie = cookies.join('; ');
  if (origin !== undefined) headers.Origin = origin;
  if (optIn) headers['X-Shutfey-Auth'] = 'cookie';
  if (device !== undefined) headers['X-Kiosk-Device'] = device;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, setCookies };
}
function wsOpen(baseUrl, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
    let closeCode = null; let initial = false; const waiters = [];
    const conn = { get initial() { return initial; }, get closeCode() { return closeCode; }, close: () => { try { ws.close(); } catch {} },
      waitClose: (ms = 5000) => new Promise((r) => { if (closeCode !== null) return r(closeCode); const t = setTimeout(() => r(closeCode), ms); waiters.push((c) => { clearTimeout(t); r(c); }); }) };
    const timer = setTimeout(() => resolve(conn), 7000);
    ws.on('message', (d) => { let m = null; try { m = JSON.parse(String(d)); } catch {} if (m?.type === 'INITIAL_STATE' && !initial) { initial = true; clearTimeout(timer); resolve(conn); } });
    ws.on('error', () => {});
    ws.on('close', (c) => { closeCode = c; waiters.splice(0).forEach((w) => w(c)); clearTimeout(timer); resolve(conn); });
  });
}

export default {
  name: 'Test 80: item 11 (11b-s) — passkey (Face ID / fingerprint) server routes',
  whatItProves:
    'Passkeys can be added only with a fresh proof regardless of credential origin, sign in exactly like a password (single or choose), never alone (an active membership is required), are single-use per challenge with counter and user-handle checks, die with every session they made when removed, are stored outside the app-state document, and leave password sign-in and kiosks unchanged.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    let ipN = 1;
    const ip = () => `10.80.${(ts % 200) + 1}.${(ipN++ % 250) + 1}`;
    const E = (k) => `t80-${k}-${ts}@test.local`;
    const PW = (k) => `Pass-80-${k}!`;
    const ORIGIN = baseUrl.replace(/\/$/, '');
    const RP = new URL(ORIGIN).hostname;
    const EVIL = 'https://evil.example';
    const details = [];
    const opened = [];
    let reloadN = 0;
    const hook = (body) => call(baseUrl, 'POST', '/api/__test__/passkey-hooks', { body });
    const shook = (body) => call(baseUrl, 'POST', '/api/__test__/session-hooks', { body });
    const sessionDoc = async (sid) => (await shook({ action: 'get', sid })).json?.doc;
    const personDoc = async (personId) => (await hook({ action: 'get-person', personId })).json?.doc;
    const login = (email, password, o = {}) => call(baseUrl, 'POST', '/api/auth/login', { ip: ip(), origin: ORIGIN, body: { email, password }, ...o });
    const postProbe = (bearer) => call(baseUrl, 'POST', '/api/updates/seen', { bearer, origin: ORIGIN, body: { announcementIds: [], noteIds: [], alertIds: [] } });
    const getProbe = (bearer) => call(baseUrl, 'GET', '/api/agencies/current', { bearer });
    const okPost = (r) => r.status !== 401 && r.status !== 503 && r.status !== 403;
    const register = async (k) => {
      const r = await call(baseUrl, 'POST', '/api/agencies/register', { ip: ip(), origin: ORIGIN, body: { agencyName: `T80 ${k} ${ts}`, adminEmail: E(k), adminPassword: PW(k), adminName: `T80 ${k}` } });
      assert(r.status === 201 && r.json?.token, `register ${k}: ${r.status} ${J(r.json && { c: r.json.code, e: r.json.error })}`);
      return { id: r.json.user.id, personId: r.json.user.personId || claimsOf(r.json.token).sub, email: E(k), pw: PW(k), agencyId: r.json.user.agencyId };
    };
    const signIn = async (who, o = {}) => {
      const r = await login(who.email, who.pw, o);
      assert(r.status === 200 && typeof r.json?.token === 'string' && !r.json.chooseMembership, `sign-in ${who.email}: ${r.status} ${J(r.json && r.json.error)}`);
      return { token: r.json.token, sid: claimsOf(r.json.token).sid, res: r };
    };
    const regOptions = (token, o = {}) => call(baseUrl, 'POST', '/api/passkeys/register/options', { bearer: token, origin: ORIGIN, body: {}, ...o });
    const regVerify = (token, body, o = {}) => call(baseUrl, 'POST', '/api/passkeys/register/verify', { bearer: token, origin: ORIGIN, body, ...o });
    const addPasskey = async (token, pk, label, name) => {
      const op = await regOptions(token);
      assert(op.status === 200 && op.json?.challengeId && op.json.options?.challenge, `${label} register options: ${op.status} ${J(op.json && { c: op.json.code, e: op.json.error })}`);
      const v = await regVerify(token, { challengeId: op.json.challengeId, response: pk.register(op.json.options, ORIGIN), ...(name ? { name } : {}) });
      assert(v.status === 201 && v.json?.passkey?.id === pk.id, `${label} register verify: ${v.status} ${J(v.json && { c: v.json.code, e: v.json.error })}`);
      return { op, v };
    };
    const pkOptions = (o = {}) => call(baseUrl, 'POST', '/api/auth/passkey/options', { ip: ip(), origin: ORIGIN, body: {}, ...o });
    const pkVerify = (body, o = {}) => call(baseUrl, 'POST', '/api/auth/passkey/verify', { ip: ip(), origin: ORIGIN, body, ...o });
    const pkSignIn = async (pk, o = {}, label = 'passkey sign-in') => {
      const op = await pkOptions();
      assert(op.status === 200 && op.json?.challengeId && op.json.options?.challenge, `${label} options: ${op.status}`);
      return pkVerify({ challengeId: op.json.challengeId, response: pk.assertion(op.json.options, ORIGIN, o) }, o.req || {});
    };
    const recentAuth = (token, password) => call(baseUrl, 'POST', '/api/auth/recent-auth', { bearer: token, origin: ORIGIN, body: { password } });
    let reloadCommit = async () => assert((await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: `agency-t80-reload-${ts}-${reloadN++}`, name: 'T80 reload' }] })).status === 200, 'reload commit');
    /** Patches stored rows (undefined removes a field), then a real commit loads them (a no-op commit is skipped). */
    const plantFields = async (patches) => {
      const doc = await ctx.getDoc();
      const users = (doc?.users || []).map((u) => {
        if (!patches[u.id]) return u;
        const n = { ...u };
        for (const [k, v] of Object.entries(patches[u.id])) { if (v === undefined) delete n[k]; else n[k] = v; }
        return n;
      });
      for (const id of Object.keys(patches)) assert(users.some((u) => u.id === id), `plant: row ${id} found`);
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users })).status === 200, 'plant doc-set-users');
      await reloadCommit();
    };
    const PAUSE = () => ({ linkId: `link-t80-${ts}`, at: new Date().toISOString(), byAgencyId: 'agency-t80-other' });
    const plantOrigin = (rowId, origin) => plantFields({ [rowId]: { credentialOrigin: origin } });

    try {
      // ---- A: add a passkey
      const a = await register('a');
      const s0 = await signIn(a);
      const d0 = await sessionDoc(s0.sid);
      assert(d0 && d0.via === 'login' && typeof d0.recentAuthAtMs === 'number' && Date.now() - d0.recentAuthAtMs < 60000 && d0.recentAuthEpoch === 0 && !d0.authMethod, `A a password sign-in is a fresh proof on its own session ${J(d0 && { via: d0.via, ra: d0.recentAuthAtMs, ep: d0.recentAuthEpoch })}`);
      const foreign = await regOptions(s0.token, { origin: EVIL });
      assert(foreign.status === 403 && foreign.json?.code === 'CSRF_ORIGIN', `A options from a foreign Origin: ${foreign.status}`);
      const noOrigin = await regOptions(s0.token, { origin: undefined });
      assert(noOrigin.status === 403 && noOrigin.json?.code === 'CSRF_ORIGIN', `A options with no Origin: ${noOrigin.status}`);
      const pkA = new SoftPasskey();
      const op = await regOptions(s0.token);
      assert(op.status === 200, `A options: ${op.status} ${J(op.json && { c: op.json.code, e: op.json.error })}`);
      const o = op.json.options;
      assert(o.rp?.id === RP && o.authenticatorSelection?.residentKey === 'required' && o.authenticatorSelection?.userVerification === 'required' && o.attestation === 'none', `A options shape ${J({ rp: o.rp, sel: o.authenticatorSelection, att: o.attestation })}`);
      const uid = Buffer.from(o.user.id, 'base64url');
      assert(uid.length === 32 && o.user.id !== a.personId && !uid.toString('utf8').includes(a.personId) && o.user.id !== b64u(a.email), 'A user id is an opaque 32-byte handle (not the person id or email)');
      const ch0 = (await hook({ action: 'get-challenge', challengeId: op.json.challengeId })).json?.doc;
      assert(ch0 && ch0.purpose === 'register' && ch0.personId === a.personId && ch0.sid === s0.sid && ch0.rpId === RP && ch0.origin === ORIGIN && ch0.expMs - ch0.createdAtMs === 120000 && ch0.consumedAt === null, `A challenge record ${J(ch0 && { p: ch0.purpose, s: ch0.sid === s0.sid })}`);
      const regResp = pkA.register(o, ORIGIN);
      // a different signed-in session cannot finish this challenge (it belongs to s0)
      const s0b = await signIn(a);
      const otherSid = await regVerify(s0b.token, { challengeId: op.json.challengeId, response: regResp });
      assert(otherSid.status === 400, `A another session cannot use the challenge: ${otherSid.status}`);
      const op1 = await regOptions(s0.token);
      const v1 = await regVerify(s0.token, { challengeId: op1.json.challengeId, response: pkA.register(op1.json.options, ORIGIN), name: '  My\u0007 iPhone  ' });
      assert(v1.status === 201 && v1.json?.passkey?.id === pkA.id && v1.json.passkey.name === 'My iPhone' && !('publicKey' in v1.json.passkey) && !('counter' in v1.json.passkey), `A verify: ${v1.status} ${J(v1.json && { c: v1.json.code, e: v1.json.error })}`);
      const replay = await regVerify(s0.token, { challengeId: op1.json.challengeId, response: pkA.register(op1.json.options, ORIGIN) });
      assert(replay.status === 400, `A replayed challenge refused: ${replay.status}`);
      const pd = await personDoc(a.personId);
      assert(pd && pd.passkeys?.length === 1 && pd.passkeys[0].credentialId === pkA.id && pd.passkeys[0].createdBySid === s0.sid && typeof pd.passkeys[0].publicKey === 'string' && pd.passkeyUserHandle === o.user.id && pd.credVersion === 0, `A personCredentials doc ${J(pd && { n: pd.passkeys?.length })}`);
      const ix = (await hook({ action: 'get-index', credentialId: pkA.id })).json?.doc;
      assert(ix && ix.personId === a.personId && ix.removedAt === null, 'A index entry');
      const list = await call(baseUrl, 'GET', '/api/passkeys', { bearer: s0.token });
      assert(list.status === 200 && list.json?.passkeys?.length === 1 && list.json.passkeys[0].name === 'My iPhone' && list.json.canAdd === true && !list.text.includes(pd.passkeys[0].publicKey) && !list.text.includes(pd.passkeyUserHandle), `A list: names only ${list.status}`);
      // the same passkey twice (new challenge) is refused
      const op2 = await regOptions(s0.token);
      assert(op2.json.options.excludeCredentials?.some((c) => c.id === pkA.id), 'A options exclude the existing passkey');
      const twice = await regVerify(s0.token, { challengeId: op2.json.challengeId, response: pkA.register(op2.json.options, ORIGIN) });
      assert(twice.status === 400, `A the same passkey twice: ${twice.status}`);
      // response errors: wrong origin, wrong RP ID, no user verification, expired challenge, foreign Origin on verify
      for (const [label, ro] of [['wrong origin', { origin: EVIL }], ['wrong RP ID', { rpId: 'evil.example' }], ['no user verification', { noUV: true }]]) {
        const opx = await regOptions(s0.token);
        const vx = await regVerify(s0.token, { challengeId: opx.json.challengeId, response: new SoftPasskey().register(opx.json.options, ORIGIN, ro) });
        assert(vx.status === 400, `A ${label} refused: ${vx.status}`);
      }
      const ope = await regOptions(s0.token);
      assert((await hook({ action: 'expire-challenge', challengeId: ope.json.challengeId })).json?.ok, 'A expire hook');
      const ve = await regVerify(s0.token, { challengeId: ope.json.challengeId, response: new SoftPasskey().register(ope.json.options, ORIGIN) });
      assert(ve.status === 400, `A expired challenge: ${ve.status}`);
      const opf = await regOptions(s0.token);
      const vf = await regVerify(s0.token, { challengeId: opf.json.challengeId, response: new SoftPasskey().register(opf.json.options, ORIGIN) }, { origin: EVIL });
      assert(vf.status === 403 && vf.json?.code === 'CSRF_ORIGIN', `A verify from a foreign Origin: ${vf.status}`);
      // stale proof -> 403 RECENT_AUTH_REQUIRED; wrong password 403 (not 401); right password opens it again
      assert((await hook({ action: 'age-recent-auth', sid: s0.sid, ageMs: 5 * 60 * 1000 + 1000 })).json?.ok, 'A age hook');
      const stale = await regOptions(s0.token);
      assert(stale.status === 403 && stale.json?.code === 'RECENT_AUTH_REQUIRED', `A stale proof: ${stale.status} ${J(stale.json && { c: stale.json.code, e: stale.json.error })}`);
      const wrong = await recentAuth(s0.token, 'not-the-password');
      assert(wrong.status === 403 && wrong.json?.code === 'WRONG_PASSWORD', `A wrong password re-entry: ${wrong.status}`);
      assert((await getProbe(s0.token)).status === 200, 'A a wrong re-entry does not sign out');
      const right = await recentAuth(s0.token, a.pw);
      assert(right.status === 200 && right.json?.ok === true, `A right password re-entry: ${right.status}`);
      assert((await regOptions(s0.token)).status === 200, 'A options open again after the re-entry');
      // the proof is checked again at verify (it may run out between options and verify)
      const opK = await regOptions(s0.token);
      await hook({ action: 'age-recent-auth', sid: s0.sid, ageMs: 5 * 60 * 1000 + 1000 });
      const vK = await regVerify(s0.token, { challengeId: opK.json.challengeId, response: new SoftPasskey().register(opK.json.options, ORIGIN) });
      assert(vK.status === 403 && vK.json?.code === 'RECENT_AUTH_REQUIRED', `A proof ran out before verify: ${vK.status}`);
      assert((await recentAuth(s0.token, a.pw)).status === 200, 'A re-entry again');
      // the proof is per session: s0b's proof is its own; a pre-item-11 token and a kiosk token cannot add
      const old = await call(baseUrl, 'POST', '/api/__test__/mint-token', { body: { userId: a.id } });
      const oldOp = await regOptions(old.json.token);
      assert(oldOp.status === 403 && oldOp.json?.code === 'PASSKEY_UNAVAILABLE', `A a token from before item 11 cannot add: ${oldOp.status}`);
      const oldRa = await recentAuth(old.json.token, a.pw);
      assert(oldRa.status === 403, `A no proof on a token without a session: ${oldRa.status}`);
      // the response id must be the credential in the attestation
      const opm = await regOptions(s0.token);
      const mis = new SoftPasskey().register(opm.json.options, ORIGIN);
      mis.id = mis.rawId = new SoftPasskey().id;
      assert((await regVerify(s0.token, { challengeId: opm.json.challengeId, response: mis })).status === 400, 'A response id != attested credential refused');
      // a failed verify uses the challenge up too
      const opc = await regOptions(s0.token);
      const pkC = new SoftPasskey();
      assert((await regVerify(s0.token, { challengeId: opc.json.challengeId, response: pkC.register(opc.json.options, ORIGIN, { origin: EVIL }) })).status === 400, 'A bad response');
      assert((await regVerify(s0.token, { challengeId: opc.json.challengeId, response: pkC.register(opc.json.options, ORIGIN) })).status === 400, 'A the challenge of a failed verify is used up');
      // ...also when the response is malformed (refused before the ceremony runs)
      for (const junk of [undefined, { id: '!!' }, { id: 'x'.repeat(2000) }]) {
        const opj = await regOptions(s0.token);
        const pkJ = new SoftPasskey();
        assert((await regVerify(s0.token, { challengeId: opj.json.challengeId, response: junk })).status === 400, 'A malformed response');
        const after = await regVerify(s0.token, { challengeId: opj.json.challengeId, response: pkJ.register(opj.json.options, ORIGIN) });
        assert(after.status === 400, `A the challenge of a malformed verify is used up: ${after.status}`);
        assert((await hook({ action: 'get-challenge', challengeId: opj.json.challengeId })).json?.doc?.consumedAt, 'A consumed');
      }
      // at most 10 (also when two challenges were fetched at 9)
      for (let i = 2; i <= 9; i++) await addPasskey(s0.token, new SoftPasskey('zero'), `A #${i}`);
      const opL1 = await regOptions(s0.token);
      const opL2 = await regOptions(s0.token);
      assert(opL1.status === 200 && opL2.status === 200, 'A two challenges at 9');
      assert((await regVerify(s0.token, { challengeId: opL1.json.challengeId, response: new SoftPasskey('zero').register(opL1.json.options, ORIGIN) })).status === 201, 'A the 10th');
      const l11 = await regVerify(s0.token, { challengeId: opL2.json.challengeId, response: new SoftPasskey('zero').register(opL2.json.options, ORIGIN) });
      assert(l11.status === 409 && l11.json?.code === 'PASSKEY_LIMIT', `A an 11th on an earlier challenge: ${l11.status}`);
      const op11 = await regOptions(s0.token);
      assert(op11.status === 409 && op11.json?.code === 'PASSKEY_LIMIT', `A an 11th passkey: ${op11.status}`);
      assert((await call(baseUrl, 'GET', '/api/passkeys', { bearer: s0.token })).json?.canAdd === false, 'A canAdd false at 10');
      details.push('A add: fresh proof, options shape, single use, origin/RP/UV/expiry/duplicate/10 limits, stale proof + re-entry, old token refused');

      // ---- B: every credential origin (Don decision A, Oct 25)
      // Separate people keep A's cap and the later pkA/count assumptions unchanged.
      const b = await register('b');
      for (const origin of ['admin', 'agency-reset', undefined, 'invite-new', 'self-registered']) {
        const label = origin ?? 'absent';
        const person = await register(`b-${label}`);
        await plantOrigin(person.id, origin);
        const sb = await signIn(person);
        const list = await call(baseUrl, 'GET', '/api/passkeys', { bearer: sb.token });
        assert(list.status === 200 && list.json?.canAdd === true, `B ${label} canAdd`);
        const op = await regOptions(sb.token);
        assert(op.status === 200, `B ${label} fresh options: ${op.status}`);
        const pk = new SoftPasskey();
        const v = await regVerify(sb.token, { challengeId: op.json.challengeId, response: pk.register(op.json.options, ORIGIN) });
        assert(v.status === 201 && v.json?.passkey?.id === pk.id, `B ${label} verifies: ${v.status}`);
        const added = await call(baseUrl, 'GET', '/api/passkeys', { bearer: sb.token });
        assert(added.status === 200 && added.json?.passkeys?.some((p) => p.id === pk.id), `B ${label} passkey listed`);
        if (origin === undefined) {
          const signed = await pkSignIn(pk);
          assert(signed.status === 200 && signed.json?.success === true && signed.json.user?.id === person.id && typeof signed.json.token === 'string', `B absent-origin passkey signs in: ${signed.status}`);
        }
        if (origin === 'admin' || origin === 'agency-reset' || origin === undefined) {
          assert((await hook({ action: 'age-recent-auth', sid: sb.sid, ageMs: 5 * 60 * 1000 + 1000 })).json?.ok, `B ${label} age proof`);
          const stale = await regOptions(sb.token);
          assert(stale.status === 403 && stale.json?.code === 'RECENT_AUTH_REQUIRED', `B ${label} stale proof: ${stale.status}`);
          assert((await recentAuth(sb.token, person.pw)).status === 200, `B ${label} password re-entry`);
          assert((await regOptions(sb.token)).status === 200, `B ${label} re-entry opens options`);
        }
      }
      const sbv = await signIn(b);
      const opB = await regOptions(sbv.token);
      assert(opB.status === 200, 'B options before origin changes');
      await plantOrigin(b.id, 'agency-reset');
      const vB = await regVerify(sbv.token, { challengeId: opB.json.challengeId, response: new SoftPasskey().register(opB.json.options, ORIGIN) });
      assert(vB.status === 201, `B origin changed to agency-reset before verify succeeds: ${vB.status}`);
      // Readiness still gets checked between options and verify.
      const opPending = await regOptions(sbv.token);
      assert(opPending.status === 200, 'B options before credential becomes pending');
      await plantFields({ [b.id]: { credentialPending: 'invite' } });
      try {
        const pending = await regVerify(sbv.token, { challengeId: opPending.json.challengeId, response: new SoftPasskey().register(opPending.json.options, ORIGIN) });
        assert(pending.status === 403 && pending.json?.code === 'PASSKEY_UNAVAILABLE', `B pending credential before verify: ${pending.status}`);
      } finally {
        await plantFields({ [b.id]: { credentialPending: undefined, credentialOrigin: 'invite-new' } });
      }
      details.push('B all origins enroll with fresh proof; absent-origin passkey signs in; stale proof needs re-entry; origin changes allowed, pending credential refused at verify');

      // ---- C: sign in with a passkey
      const c1 = await pkSignIn(pkA, { req: { optIn: true }, origin: ORIGIN });
      assert(c1.status === 200 && c1.json?.success === true && typeof c1.json.token === 'string' && c1.json.user?.id === a.id && !('password' in c1.json.user), `C sign-in: ${c1.status} ${J(c1.json && { c: c1.json.code, e: c1.json.error })}`);
      assert(c1.setCookies.some((c) => c.startsWith(`shutfey_s=${c1.json.token};`)) && c1.setCookies.every((c) => c.startsWith('shutfey_s=') || /Max-Age=0/i.test(c)), `C opted in: the user cookie is set (and nothing else but deletions) ${J(c1.setCookies.map((c) => c.split('=')[0]))}`);
      const cs = claimsOf(c1.json.token);
      const cd = await sessionDoc(cs.sid);
      assert(cd && cd.via === 'passkey' && cd.authMethod?.type === 'passkey' && cd.authMethod.credentialId === pkA.id && cd.authMethod.personId === a.personId && typeof cd.recentAuthAtMs === 'number' && cd.absoluteExpMs - cd.createdAtMs === 30 * 24 * 3600 * 1000, `C session record ${J(cd && { via: cd.via, am: cd.authMethod })}`);
      assert(okPost(await postProbe(c1.json.token)), 'C the passkey session works');
      const pd2 = await personDoc(a.personId);
      const e2 = pd2.passkeys.find((p) => p.credentialId === pkA.id);
      assert(e2.counter === pkA.counter && typeof e2.lastUsedAt === 'string', 'C counter + last used stored');
      // the body's email/personId is ignored: the index decides
      const other = await register('o');
      const opE = await pkOptions();
      const cE = await pkVerify({ challengeId: opE.json.challengeId, response: pkA.assertion(opE.json.options, ORIGIN), email: other.email, personId: other.personId });
      assert(cE.status === 200 && cE.json.user?.id === a.id, `C email in the body ignored: ${cE.status} ${cE.json?.user?.id}`);
      // refusals
      const opR = await pkOptions();
      const goodResp = pkA.assertion(opR.json.options, ORIGIN);
      assert((await pkVerify({ challengeId: opR.json.challengeId, response: goodResp })).status === 200, 'C one more sign-in');
      const rep = await pkVerify({ challengeId: opR.json.challengeId, response: goodResp });
      assert(rep.status === 401 && rep.json?.code === 'PASSKEY_FAILED', `C replay: ${rep.status}`);
      const opX = await pkOptions();
      await hook({ action: 'expire-challenge', challengeId: opX.json.challengeId });
      assert((await pkVerify({ challengeId: opX.json.challengeId, response: pkA.assertion(opX.json.options, ORIGIN) })).status === 401, 'C expired challenge');
      const regCh = await regOptions((await signIn(b)).token);
      assert(regCh.status === 200, `C register options for b: ${regCh.status}`);
      const crossP = await pkVerify({ challengeId: regCh.json.challengeId, response: pkA.assertion({ challenge: regCh.json.options.challenge, rpId: RP }, ORIGIN) });
      assert(crossP.status === 401, `C a register challenge cannot sign in: ${crossP.status}`);
      const before = (await personDoc(a.personId)).passkeys.find((p) => p.credentialId === pkA.id).counter;
      const back = await pkSignIn(pkA, { counter: before - 1 });
      assert(back.status === 401, `C counter going back: ${back.status}`);
      const same = await pkSignIn(pkA, { counter: before });
      assert(same.status === 401, `C counter staying the same (non-zero): ${same.status}`);
      assert((await personDoc(a.personId)).passkeys.find((p) => p.credentialId === pkA.id).counter === before, 'C a refused counter changes nothing');
      const uh = await pkSignIn(pkA, { userHandle: b64u(crypto.randomBytes(32)) });
      assert(uh.status === 401, `C wrong user handle: ${uh.status}`);
      assert((await pkSignIn(new SoftPasskey())).status === 401, 'C unknown passkey');
      assert((await pkSignIn(pkA, { origin: EVIL })).status === 401, 'C wrong origin in the response');
      assert((await pkSignIn(pkA, { rpId: 'evil.example' })).status === 401, 'C wrong RP ID in the response');
      assert((await pkSignIn(pkA, { noUV: true })).status === 401, 'C no user verification');
      const fo = await pkOptions({ origin: EVIL });
      assert(fo.status === 403 && fo.json?.code === 'CSRF_ORIGIN', `C options from a foreign Origin: ${fo.status}`);
      const opF = await pkOptions();
      const fv = await pkVerify({ challengeId: opF.json.challengeId, response: pkA.assertion(opF.json.options, ORIGIN) }, { origin: EVIL });
      assert(fv.status === 403 && fv.json?.code === 'CSRF_ORIGIN' && fv.setCookies.length === 0, `C verify from a foreign Origin: ${fv.status}`);
      assert((await pkSignIn(pkA)).status === 200, 'C after all the refusals the passkey still works');
      // a synced passkey (counter always 0) works every time
      const z = await register('z');
      const sz = await signIn(z);
      const pkZ = new SoftPasskey('zero');
      await addPasskey(sz.token, pkZ, 'C synced');
      assert((await pkSignIn(pkZ)).status === 200 && (await pkSignIn(pkZ)).status === 200, 'C synced passkey (counter 0) twice');
      // a malformed sign-in response uses the challenge up too
      for (const junk of [undefined, { id: '!!' }]) {
        const opJ = await pkOptions();
        assert((await pkVerify({ challengeId: opJ.json.challengeId, response: junk })).status === 401, 'C malformed response');
        const afterJ = await pkVerify({ challengeId: opJ.json.challengeId, response: pkZ.assertion(opJ.json.options, ORIGIN) });
        assert(afterJ.status === 401 && !afterJ.json?.token, `C the challenge of a malformed verify is used up: ${afterJ.status}`);
      }
      // single use does not lean on the counter: a synced passkey's assertion replayed is refused
      const opZ = await pkOptions();
      const respZ = pkZ.assertion(opZ.json.options, ORIGIN);
      assert((await pkVerify({ challengeId: opZ.json.challengeId, response: respZ })).status === 200, 'C synced sign-in');
      const repZ = await pkVerify({ challengeId: opZ.json.challengeId, response: respZ });
      assert(repZ.status === 401, `C a replayed counter-0 assertion: ${repZ.status}`);
      // per-IP limits on the public routes and on password re-entry
      const FIX = `10.80.250.${(ts % 200) + 1}`;
      let lastO = null;
      for (let i = 0; i < 31; i++) lastO = await pkOptions({ ip: FIX });
      assert(lastO.status === 429 && lastO.json?.code === 'RATE_LIMITED', `C options per-IP limit: ${lastO.status}`);
      let lastV = null;
      for (let i = 0; i < 31; i++) lastV = await pkVerify({ challengeId: 'x' }, { ip: FIX });
      assert(lastV.status === 429, `C verify per-IP limit: ${lastV.status}`);
      let lastR = null;
      for (let i = 0; i < 11; i++) lastR = await recentAuth(sz.token, 'wrong-password');
      assert(lastR.status === 429 && (await getProbe(sz.token)).status === 200, `C re-entry limit (still signed in): ${lastR.status}`);
      details.push('C sign-in: token+user+cookie, index decides, replay/expiry/purpose/counter/handle/unknown/origin/RP/UV/foreign refused, synced counter 0 ok');

      // ---- D: multi-agency
      const m = await register('m');
      const rx = await call(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), origin: ORIGIN, body: { agencyName: `T80 m2 ${ts}`, email: m.email, password: m.pw, operationId: `op-${crypto.randomUUID()}` } });
      assert(rx.status === 201 && rx.json?.token, `D register-existing: ${rx.status} ${J(rx.json && { c: rx.json.code, e: rx.json.error })}`);
      const ml = await login(m.email, m.pw);
      assert(ml.status === 200 && ml.json?.chooseMembership === true && ml.json.memberships?.length === 2, `D password -> chooser: ${ml.status}`);
      const chooseOp = await regOptions(ml.json.token);
      assert(chooseOp.status === 401 || chooseOp.status === 403, `D a choose token cannot add a passkey: ${chooseOp.status}`);
      const act = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: ml.json.token, origin: ORIGIN, body: { membershipId: ml.json.memberships[0].membershipId } });
      assert(act.status === 200 && act.json?.token, `D activate: ${act.status}`);
      const actDoc = await sessionDoc(claimsOf(act.json.token).sid);
      // FACEID2: the password typed at sign-in is carried by the choose token (ra/re) and copied, unchanged, to the chosen session.
      const mlc = claimsOf(ml.json.token);
      assert(Number.isSafeInteger(mlc.ra) && Number.isSafeInteger(mlc.re), `D the password choose token carries the sign-in proof ${J({ ra: mlc.ra, re: mlc.re })}`);
      assert(actDoc && actDoc.recentAuthAtMs === mlc.ra && actDoc.recentAuthEpoch === mlc.re && !actDoc.authMethod, `D a chosen session carries the sign-in proof, not restarted ${J({ at: actDoc && actDoc.recentAuthAtMs, ra: mlc.ra })}`);
      assert((await regOptions(act.json.token)).status === 200, 'D the chosen session may add a passkey right after the password (no second password)');
      assert((await hook({ action: 'age-recent-auth', sid: claimsOf(act.json.token).sid, ageMs: 5 * 60 * 1000 + 1000 })).json?.ok === true, 'D age the proof');
      assert((await regOptions(act.json.token)).json?.code === 'RECENT_AUTH_REQUIRED', 'D after the 5 minutes it needs a password re-entry');
      assert((await recentAuth(act.json.token, m.pw)).status === 200, 'D re-entry');
      const pkM = new SoftPasskey();
      await addPasskey(act.json.token, pkM, 'D');
      const mp = await pkSignIn(pkM);
      assert(mp.status === 200 && mp.json?.chooseMembership === true && mp.json.memberships?.length === 2 && !mp.json.user && mp.setCookies.length === 0, `D passkey -> chooser: ${mp.status} ${J(mp.json && { c: mp.json.code, e: mp.json.error })}`);
      const mc = claimsOf(mp.json.token);
      assert(mc.v === 3 && mc.pk === pkM.id && !mc.sid, 'D the choose token names the passkey');
      const mact = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: mp.json.token, origin: ORIGIN, body: { membershipId: mp.json.memberships[1].membershipId } });
      assert(mact.status === 200 && mact.json?.token, `D activate after passkey: ${mact.status}`);
      const mDoc = await sessionDoc(claimsOf(mact.json.token).sid);
      assert(Number.isSafeInteger(mc.ra) && Number.isSafeInteger(mc.re), 'D the passkey choose token carries the assertion as the sign-in proof');
      assert(mDoc.via === 'activate' && mDoc.authMethod?.credentialId === pkM.id && mDoc.recentAuthAtMs === mc.ra && mDoc.recentAuthEpoch === mc.re, `D the chosen session is a passkey session with the sign-in proof ${J({ via: mDoc.via, am: mDoc.authMethod })}`);
      details.push('D multi: passkey -> choose token (pk + proof) -> activated passkey session; choose token cannot add; activate copies the sign-in proof unchanged (FACEID2), and it still ends after 5 minutes');

      // ---- E: removal
      const sp = await pkSignIn(pkA); // a passkey session
      const spTok = sp.json.token;
      const sock = await wsOpen(baseUrl, spTok); opened.push(sock);
      assert(sock.initial, 'E the passkey session socket opens');
      const s3 = await signIn(a); // a password session with a fresh proof
      await hook({ action: 'age-recent-auth', sid: s3.sid, ageMs: 6 * 60 * 1000 });
      const delStale = await call(baseUrl, 'DELETE', `/api/passkeys/${pkA.id}`, { bearer: s3.token, origin: ORIGIN });
      assert(delStale.status === 403 && delStale.json?.code === 'RECENT_AUTH_REQUIRED', `E removal needs a proof: ${delStale.status}`);
      const ren = await call(baseUrl, 'PATCH', `/api/passkeys/${pkA.id}`, { bearer: s3.token, origin: ORIGIN, body: { name: 'Old phone' } });
      assert(ren.status === 200 && ren.json?.passkey?.name === 'Old phone', `E rename: ${ren.status}`);
      assert((await call(baseUrl, 'PATCH', `/api/passkeys/${pkA.id}`, { bearer: s3.token, origin: ORIGIN, body: { name: '   ' } })).status === 400, 'E empty name refused');
      assert((await recentAuth(s3.token, a.pw)).status === 200, 'E re-entry');
      const s4 = await signIn(a); // another password session with a proof (must lose it)
      const del = await call(baseUrl, 'DELETE', `/api/passkeys/${pkA.id}`, { bearer: s3.token, origin: ORIGIN });
      assert(del.status === 200 && del.json?.ok === true, `E remove: ${del.status} ${J(del.json && { c: del.json.code, e: del.json.error })}`);
      assert((await postProbe(spTok)).status === 401 && (await getProbe(spTok)).status === 401, 'E the passkey session is refused at once (POST and GET)');
      assert((await sock.waitClose(4000)) === 4401, `E its socket closes 4401 (${sock.closeCode})`);
      const cE1 = claimsOf(c1.json.token);
      await hook({ action: 'drop-cache', personId: a.personId });
      await shook({ action: 'cache-age', sid: cE1.sid, ageMs: 60000 });
      assert((await getProbe(c1.json.token)).status === 401, 'E an older passkey session, re-read as another instance would: refused');
      assert(okPost(await postProbe(s3.token)) && okPost(await postProbe(s4.token)), 'E password sessions keep working');
      const s4op = await regOptions(s4.token);
      assert(s4op.status === 403 && s4op.json?.code === 'RECENT_AUTH_REQUIRED', `E every proof of the person ended: ${s4op.status}`);
      const pd3 = await personDoc(a.personId);
      assert(pd3.passkeys.length === 9 && !pd3.passkeys.some((p) => p.credentialId === pkA.id) && pd3.credVersion === 1 && pd3.recentAuthEpoch === 1, `E one write: passkey gone, versions moved ${J({ n: pd3.passkeys.length, cv: pd3.credVersion, ep: pd3.recentAuthEpoch })}`);
      const ix2 = (await hook({ action: 'get-index', credentialId: pkA.id })).json?.doc;
      assert(ix2 && typeof ix2.removedAt === 'string' && ix2.personId === a.personId, 'E the index entry is a tombstone');
      assert((await pkSignIn(pkA)).status === 401, 'E sign-in with the removed passkey refused');
      assert((await recentAuth(s3.token, a.pw)).status === 200, 'E re-entry after removal');
      const delAgain = await call(baseUrl, 'DELETE', `/api/passkeys/${pkA.id}`, { bearer: s3.token, origin: ORIGIN });
      assert(delAgain.status === 404, `E removing it again: ${delAgain.status}`);
      const pdLast = (await personDoc(a.personId)).passkeys[0].credentialId;
      await call(baseUrl, 'DELETE', `/api/passkeys/${pdLast}`, { bearer: s3.token, origin: ORIGIN });
      assert((await recentAuth(s3.token, a.pw)).status === 200, 'E re-entry 2');
      const readd = await regOptions(s3.token);
      const readdV = await regVerify(s3.token, { challengeId: readd.json.challengeId, response: pkA.register(readd.json.options, ORIGIN) });
      assert(readdV.status === 400, `E a removed passkey can never be added again: ${readdV.status}`);
      // the activated multi-agency passkey session dies with pkM's removal; a choose token from before cannot activate
      const mp2 = await pkSignIn(pkM);
      assert(mp2.status === 200 && mp2.json?.chooseMembership, 'E m passkey -> chooser');
      assert((await recentAuth(act.json.token, m.pw)).status === 200, 'E m re-entry');
      assert((await call(baseUrl, 'DELETE', `/api/passkeys/${pkM.id}`, { bearer: act.json.token, origin: ORIGIN })).status === 200, 'E remove pkM');
      assert((await postProbe(mact.json.token)).status === 401, 'E the chosen passkey session ends with its passkey');
      assert(okPost(await postProbe(act.json.token)), 'E the password-chosen session keeps working');
      const late = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: mp2.json.token, origin: ORIGIN, body: { membershipId: mp2.json.memberships[0].membershipId } });
      assert(late.status === 401 && !late.json?.token, `E a choose token from a removed passkey cannot activate: ${late.status}`);
      details.push('E removal: proof needed, passkey sessions refused (HTTP, WS 4401, re-read, chosen), password sessions kept, proofs ended, tombstone, rename');

      // ---- F: a passkey alone never signs in (no active membership)
      const f = await register('f');
      const sf = await signIn(f);
      const pkF = new SoftPasskey();
      await addPasskey(sf.token, pkF, 'F');
      assert((await pkSignIn(pkF)).status === 200, 'F works while the membership exists');
      const docF = await ctx.getDoc();
      const usersF = (docF?.users || []).filter((u) => u.id !== f.id);
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: usersF })).status === 200 && (await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: [{ id: `agency-t80-reload-${ts}-${reloadN++}`, name: 'T80 reload' }] })).status === 200, 'F remove the row');
      assert((await personDoc(f.personId))?.passkeys?.length === 1, 'F the credential doc is still there');
      const fz = await pkSignIn(pkF);
      assert(fz.status === 401, `F no membership -> refused: ${fz.status}`);
      // the agency is gone: the row is no active membership
      const f2 = await register('f2');
      const sf2 = await signIn(f2);
      const pkF2 = new SoftPasskey();
      await addPasskey(sf2.token, pkF2, 'F2');
      const docA = await ctx.getDoc();
      assert((await ctx.api('POST', '/api/__test__/doc-set-users', { users: docA.users, agencies: (docA.agencies || []).filter((x) => x.id !== f2.agencyId) })).status === 200, 'F2 remove the agency');
      await reloadCommit();
      const f2p = await pkSignIn(pkF2);
      assert(f2p.status === 401 || f2p.status === 403, `F2 agency gone -> refused: ${f2p.status}`);
      assert(!f2p.json?.token, 'F2 no token');
      // paused membership: the same 403 a password sign-in gives (single and multi); a pending-invite credential: refused
      await plantFields({ [z.id]: { resetSuspended: PAUSE() } });
      const zp = await pkSignIn(pkZ);
      assert(zp.status === 403 && zp.json?.code === 'RESET_CONFIRM_NEEDED' && !zp.json.token, `F paused single membership: ${zp.status} ${J(zp.json && { c: zp.json.code, e: zp.json.error })}`);
      await plantFields({ [z.id]: { resetSuspended: undefined, credentialPending: 'invite' } });
      assert((await pkSignIn(pkZ)).status === 401, 'F a credential pending an invite: refused');
      const m2 = await register('m2');
      const rx2 = await call(baseUrl, 'POST', '/api/agencies/register-existing', { ip: ip(), origin: ORIGIN, body: { agencyName: `T80 m2b ${ts}`, email: m2.email, password: m2.pw, operationId: `op-${crypto.randomUUID()}` } });
      assert(rx2.status === 201, `F m2 second agency: ${rx2.status}`);
      const m2l = await login(m2.email, m2.pw);
      const m2a = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: m2l.json.token, origin: ORIGIN, body: { membershipId: m2l.json.memberships[0].membershipId } });
      assert((await recentAuth(m2a.json.token, m2.pw)).status === 200, 'F m2 re-entry');
      const pkM2 = new SoftPasskey();
      await addPasskey(m2a.json.token, pkM2, 'F m2');
      await plantFields(Object.fromEntries(m2l.json.memberships.map((x) => [x.membershipId, { resetSuspended: PAUSE() }])));
      const m2p = await pkSignIn(pkM2);
      assert(m2p.status === 403 && m2p.json?.code === 'RESET_CONFIRM_NEEDED' && !m2p.json.token, `F every membership paused (multi): ${m2p.status} ${J(m2p.json && { c: m2p.json.code, e: m2p.json.error })}`);
      details.push('F fail closed: no active membership refused; paused -> same 403 as password (single + multi); pending invite refused');

      // ---- G: races (real Firestore transactions only: the stage2 mock detects
      // conflicts only on documents carrying _v, i.e. app-state, so these
      // multi-document races run on the emulator - locally and in CI)
      const g = await register('g');
      const sg = await signIn(g);
      const pkP = new SoftPasskey();
      await addPasskey(sg.token, pkP, 'G');
      if (process.env.FIRESTORE_EMULATOR_HOST) {
      for (const order of ['login-paused', 'removal-paused']) {
        const pkG = new SoftPasskey();
        assert((await recentAuth(sg.token, g.pw)).status === 200, `G ${order} re-entry`);
        await addPasskey(sg.token, pkG, `G ${order}`);
        assert((await recentAuth(sg.token, g.pw)).status === 200, `G ${order} re-entry 2`);
        const opG = await pkOptions();
        const resp = pkG.assertion(opG.json.options, ORIGIN);
        await hook({ action: 'pause-once', ms: 1200 });
        let lg, rm;
        if (order === 'login-paused') {
          const lp = pkVerify({ challengeId: opG.json.challengeId, response: resp });
          await sleep(300);
          rm = await call(baseUrl, 'DELETE', `/api/passkeys/${pkG.id}`, { bearer: sg.token, origin: ORIGIN });
          lg = await lp;
        } else {
          const rp = call(baseUrl, 'DELETE', `/api/passkeys/${pkG.id}`, { bearer: sg.token, origin: ORIGIN });
          await sleep(300);
          lg = await pkVerify({ challengeId: opG.json.challengeId, response: resp });
          rm = await rp;
        }
        assert(rm.status === 200, `G ${order}: removal ok (${rm.status})`);
        if (lg.status === 200) assert((await postProbe(lg.json.token)).status === 401 && (await getProbe(lg.json.token)).status === 401, `G ${order}: the session that raced the removal is not usable`);
        else assert(lg.status === 401, `G ${order}: sign-in refused (${lg.status})`);
        details.push(`G ${order}: sign-in ${lg.status}, no usable session`);
      }
      const [o1, o2] = [await pkOptions(), await pkOptions()];
      const r1 = pkP.assertion(o1.json.options, ORIGIN);
      const r2 = pkP.assertion(o2.json.options, ORIGIN, { keepCounter: true });
      const [p1, p2] = await Promise.all([pkVerify({ challengeId: o1.json.challengeId, response: r1 }), pkVerify({ challengeId: o2.json.challengeId, response: r2 })]);
      assert([p1.status, p2.status].filter((x) => x === 200).length === 1, `G two assertions with the same counter: exactly one wins (${p1.status}, ${p2.status})`);
      assert((await personDoc(g.personId)).passkeys.find((p) => p.credentialId === pkP.id).counter === pkP.counter, 'G the stored counter is that value');
      details.push('G same counter in parallel: one wins');
      } else details.push('G races: skipped on the mock (emulator only)');

      // ---- H: store outage
      await shook({ action: 'fault', on: true });
      try {
        const ho = await pkOptions();
        assert(ho.status === 503 && ho.json?.code === 'SESSION_STORE_UNAVAILABLE', `H options 503: ${ho.status}`);
        const hl = await call(baseUrl, 'GET', '/api/passkeys', { bearer: sg.token });
        assert(hl.status === 503, `H list 503 (never 401): ${hl.status}`);
        const hr = await recentAuth(sg.token, g.pw);
        assert(hr.status === 503, `H re-entry 503: ${hr.status}`);
      } finally {
        await shook({ action: 'fault', on: false });
      }
      assert((await pkSignIn(pkP)).status === 200, 'H after the outage the passkey works');
      details.push('H outage: 503 never 401, then works');

      // ---- I: nothing in app-state; restart keeps passkeys; hook 404 outside test mode
      const stateText = J(await ctx.getDoc());
      const pdG = await personDoc(g.personId);
      assert(!stateText.includes(pkP.id) && !stateText.includes(pdG.passkeyUserHandle) && !stateText.includes(pdG.passkeys[0].publicKey) && !/passkey/i.test(stateText), 'I the app-state document carries no passkey data');
      const usersList = await call(baseUrl, 'GET', '/api/users', { bearer: sg.token });
      assert(!usersList.text.includes(pdG.passkeyUserHandle) && !/passkey/i.test(usersList.text), 'I the roster carries no passkey data');
      if (typeof ctx.restartServer === 'function') {
        await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
        try {
          const h = await call(baseUrl, 'POST', '/api/__test__/passkey-hooks', { bearer: sg.token, origin: ORIGIN, body: { action: 'get-person', personId: g.personId } });
          assert(h.status === 404, `I passkey-hooks 404 outside test mode: ${h.status}`);
        } finally {
          await ctx.restartServer();
        }
        assert((await pkSignIn(pkP)).status === 200, 'I a restart keeps passkeys');
        details.push('I hook 404 outside test mode; restart keeps passkeys');
      }

      // ---- K: passkeys are never merged
      const r = await register('r');
      const s2 = await register('s');
      const sr = await signIn(r);
      const pkR = new SoftPasskey();
      await addPasskey(sr.token, pkR, 'K');
      const mergeInto = () => call(baseUrl, 'POST', '/api/account/merge-into', { bearer: sr.token, ip: ip(), origin: ORIGIN, body: { email: s2.email, password: s2.pw, currentPassword: r.pw, confirm: true, operationId: `op-${crypto.randomUUID()}` } });
      const mg1 = await mergeInto();
      assert(mg1.status === 409 && mg1.json?.code === 'MERGE_HAS_PASSKEYS', `K merging away a person with a passkey is refused: ${mg1.status} ${J(mg1.json && { c: mg1.json.code, e: mg1.json.error })}`);
      assert((await personDoc(r.personId)).passkeys.length === 1 && (await pkSignIn(pkR)).status === 200, 'K nothing changed');
      assert((await call(baseUrl, 'DELETE', `/api/passkeys/${pkR.id}`, { bearer: sr.token, origin: ORIGIN })).status === 200, 'K remove the passkey');
      const mg2 = await mergeInto();
      assert(mg2.status === 200, `K then the merge works: ${mg2.status} ${J(mg2.json && mg2.json.error)}`);
      details.push('K merge refused while the merged-away person has a passkey; works after removing it');

      // ---- J: fresh password sign-ins and a kiosk entry/exit still work
      const fresh = await signIn(b, { optIn: true });
      assert(fresh.res.setCookies.some((c) => c.startsWith(`shutfey_s=${fresh.token};`)) && okPost(await postProbe(fresh.token)), 'J fresh single-agency password sign-in (cookie) works');
      const fm = await login(m.email, m.pw);
      assert(fm.status === 200 && fm.json?.chooseMembership === true, 'J fresh multi-agency password sign-in chooses');
      const fma = await call(baseUrl, 'POST', '/api/auth/activate', { bearer: fm.json.token, origin: ORIGIN, body: { membershipId: fm.json.memberships[1].membershipId } });
      assert(fma.status === 200 && okPost(await postProbe(fma.json.token)), 'J multi-agency activate works');
      // kiosk entry/exit on b's agency
      const venueId = `venue-t80-${ts}`;
      const mashId = `user-t80-mash-${ts}`;
      const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
        venues: [{ id: venueId, name: `T80 Venue ${ts}`, agencyId: b.agencyId }],
        users: [{ id: mashId, email: `mash80-${ts}@test.local`, name: 'T80 Mash', role: 'mashgiach', agencyId: b.agencyId, venueId, kioskPin: '8080' }],
      });
      assert(inj.status === 200, `J kiosk fixture: ${inj.status}`);
      const bAdmin = (await call(baseUrl, 'POST', '/api/__test__/mint-token', { body: { userId: b.id } })).json.token;
      await call(baseUrl, 'POST', '/api/__test__/kiosk-clear-lockouts', { bearer: bAdmin });
      const start = await call(baseUrl, 'POST', '/api/kiosk/pairing/start', { ip: ip(), body: {} });
      assert(start.status === 200, `J pairing start: ${start.status}`);
      const pair = await call(baseUrl, 'POST', '/api/kiosk/devices/pair', { bearer: bAdmin, body: { code: start.json.code, venueId } });
      assert(pair.status === 201, `J pair: ${pair.status} ${J(pair.json && { c: pair.json.code, e: pair.json.error })}`);
      const claimRes = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } });
      const claim = await claimRes.json();
      assert(claim?.status === 'approved', 'J pairing approved');
      const cred = `${claim.device.id}.${start.json.deviceSecret}`;
      const kl = await call(baseUrl, 'POST', '/api/kiosk/login', { ip: ip(), device: cred, origin: ORIGIN, body: { userId: mashId, pin: '8080' } });
      assert(kl.status === 200 && kl.json?.token, `J kiosk entry: ${kl.status}`);
      const kpk = await call(baseUrl, 'GET', '/api/passkeys', { bearer: kl.json.token, device: cred });
      assert(kpk.status === 403, `J a kiosk session has no passkey routes: ${kpk.status}`);
      const kout = await call(baseUrl, 'POST', '/api/auth/logout', { bearer: kl.json.token, device: cred, origin: ORIGIN, body: {} });
      assert(kout.status === 200 && (await call(baseUrl, 'GET', '/api/tasks', { bearer: kl.json.token, device: cred })).status === 401, `J kiosk exit ends the session: ${kout.status}`);
      details.push('J fresh password sign-in (single + multi) and kiosk entry/exit work');
      return details.join(' | ');
    } finally {
      for (const s of opened) s.close();
      await shook({ action: 'fault', on: false }).catch(() => {});
    }
  },
};
