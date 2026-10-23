/**
 * Item 11b-c client: Face ID / passkeys (src/lib/passkeys.ts) against fakes of the
 * server answers (#138) and of the phone (navigator.credentials).
 *  T  every visible word lives in PASSKEY_TEXT; never "WebAuthn".
 *  O  the offer: set by a completed password sign-in FOR THAT ACCOUNT, read once, only
 *     inside the 5-minute proof window; phones only; "Not now" is remembered per account.
 *  G  every step of add / remove / sign-in stops (silently) once the dialog closed or the
 *     browser is signed in as someone else; the phone is not asked, nothing more is sent.
 *  S  support: no PublicKeyCredential = no button; the platform check.
 *  E  errors -> plain words: 5xx = try again (never a sign-out), RECENT_AUTH_REQUIRED,
 *     PASSKEY_UNAVAILABLE, PASSKEY_LIMIT, WRONG_PASSWORD; phone cancel / already / unsupported.
 *  A  add: options -> phone -> verify {challengeId, response, name?}; nothing sent to verify
 *     when the phone says no; bad options refused.
 *  I  sign in: options -> phone -> verify; the answer is returned as is (session or chooser);
 *     401 PASSKEY_FAILED -> plain words.
 *  L  list / rename / remove / recent-auth requests and answers.
 * Run: npx tsx tests/client/test-11bc-passkeys-client.mjs
 */
const store = new Map(); const sstore = new Map();
const mkStore = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] ?? null });
globalThis.localStorage = mkStore(store); globalThis.sessionStorage = mkStore(sstore);
globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
const ab = (s) => new TextEncoder().encode(s).buffer;
let phone = { create: null, get: null, uvpaa: true };
function FakePKC() {}
FakePKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => phone.uvpaa;
globalThis.PublicKeyCredential = FakePKC;
const fakeCred = (kind) => ({
  id: 'Y3JlZA', rawId: ab('cred'), type: 'public-key', authenticatorAttachment: 'platform',
  getClientExtensionResults: () => ({}),
  response: kind === 'create'
    ? { clientDataJSON: ab('{}'), attestationObject: ab('att'), getTransports: () => ['internal'], getPublicKeyAlgorithm: () => -7, getPublicKey: () => ab('pk'), getAuthenticatorData: () => ab('ad') }
    : { clientDataJSON: ab('{}'), authenticatorData: ab('ad'), signature: ab('sig'), userHandle: ab('uh') },
});
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', credentials: {
  create: async (o) => { phone.lastCreate = o; if (phone.create) return phone.create(o); return fakeCred('create'); },
  get: async (o) => { phone.lastGet = o; if (phone.get) return phone.get(o); return fakeCred('get'); },
} }, configurable: true });
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' };

let routes = {}; const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  sent.push({ method, url, body, headers: new Headers(init.headers || {}) });
  const h = routes[`${method} ${url}`];
  if (!h) return new Response(JSON.stringify({ error: 'no route', code: 'NO_ROUTE' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  if (h === 'offline') throw new TypeError('Failed to fetch');
  const [status, json] = typeof h === 'function' ? h(body) : h;
  return new Response(json === undefined ? '' : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
};
const P = await import('../../src/lib/passkeys.ts');
const api = await import('../../src/lib/api.ts');
const fs = await import('node:fs');

let pass = 0, fail = 0;
const ok = (label, cond, info = '') => { if (cond) pass++; else { fail++; console.log('FAIL ' + label + (info ? ' :: ' + info : '')); } };
const throwsKind = async (label, fn, kind, text) => {
  try { await fn(); ok(label + ' (should throw)', false); }
  catch (e) { ok(label, e instanceof P.PasskeyError && e.kind === kind && (!text || e.message === text), `${e?.name} ${e?.kind} ${e?.message}`); }
};
const reset = () => { routes = {}; sent.length = 0; phone = { create: null, get: null, uvpaa: true }; store.clear(); sstore.clear(); };
const OPTS_R = { challenge: 'Y2hhbA', rp: { name: 'Shutfey', id: 'localhost' }, user: { id: 'dXNlcg', name: 'a@b', displayName: 'A' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none', excludeCredentials: [], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } };
const OPTS_A = { challenge: 'Y2hhbA', rpId: 'localhost', timeout: 60000, userVerification: 'required', allowCredentials: [] };
const CID = 'abcdefghijklmnopqrstuv';

// T: words
{
  const vals = Object.values(P.PASSKEY_TEXT).map((v) => (typeof v === 'function' ? v('X') : v));
  ok('T no "WebAuthn" in any visible word', vals.every((v) => !/webauthn/i.test(v)));
  ok('T Don\'s pick: the button says "Quick sign-in", Face ID or fingerprint under it', P.PASSKEY_TEXT.signInButton === 'Quick sign-in' && P.PASSKEY_TEXT.signInSubline === 'Face ID or fingerprint');
  ok('T no label says just "Face ID" (always "Face ID or fingerprint" / "your fingerprint")', vals.every((v) => !/Face ID(?! or (your )?fingerprint)/.test(v)));
  ok('T every value is non-empty text', vals.every((v) => typeof v === 'string' && v.trim().length > 0));
  const src = ['src/components/PasskeyOffer.tsx', 'src/components/PasskeysModal.tsx'].map((f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8')).join('\n');
  ok('T the two screens hold no hard-coded "Face ID"', !/Face ID/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  const strip = (t) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const login = fs.readFileSync(new URL('../../src/components/LoginPage.tsx', import.meta.url), 'utf8');
  const hdr = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
  ok('T sign-in and menu words come from PASSKEY_TEXT', /PASSKEY_TEXT\.signInButton/.test(login) && /PASSKEY_TEXT\.signInSubline/.test(login) && /PASSKEY_TEXT\.waiting/.test(login) && (hdr.match(/PASSKEY_TEXT\.menuRow/g) || []).length === 2 && !/>[^<{]*Face ID[^<{]*</.test(strip(login + hdr)));
}

// O: the offer mark (bound to the account its password sign-in opened) and "Not now"
{
  reset();
  const now = Date.now();
  const put = (v) => sstore.set('shutfey_password_signin_at', typeof v === 'string' ? v : JSON.stringify(v));
  ok('O no mark = no offer', P.takePasswordSignInMark('u1') === null);
  P.markPasswordSignIn('u1', now);
  ok('O this account, just now = offer until +5 min', P.takePasswordSignInMark('u1', now) === now + P.PASSWORD_PROOF_MS);
  ok('O read once', P.takePasswordSignInMark('u1', now) === null);
  P.markPasswordSignIn('u1', now);
  ok('O another account never gets it', P.takePasswordSignInMark('u2', now) === null);
  ok('O ... and the mark is gone after that read', P.takePasswordSignInMark('u1', now) === null);
  put({ u: 'u1', at: now - P.PASSWORD_PROOF_MS + 1000 });
  ok('O inside the 5-minute window', P.takePasswordSignInMark('u1', now) === now + 1000);
  put({ u: 'u1', at: now - P.PASSWORD_PROOF_MS });
  ok('O at 5 minutes: no offer', P.takePasswordSignInMark('u1', now) === null);
  ok('O after the window the mark is gone too', sstore.has('shutfey_password_signin_at') === false);
  put({ u: 'u1', at: now + 60000 });
  ok('O a mark from the future: no offer', P.takePasswordSignInMark('u1', now) === null);
  put('junk'); ok('O a broken mark: no offer', P.takePasswordSignInMark('u1', now) === null);
  put(String(now)); ok('O an old bare timestamp mark: no offer', P.takePasswordSignInMark('u1', now) === null);
  put({ u: 'u1' }); ok('O a mark without a time: no offer', P.takePasswordSignInMark('u1', now) === null);
  P.markPasswordSignIn('', now); ok('O no account id = no mark', !sstore.has('shutfey_password_signin_at'));
  P.markPasswordSignIn('u1', now); ok('O an empty reader id never matches', P.takePasswordSignInMark('', now) === null);
  put({ u: '', at: now }); ok('O an empty id on both sides never matches', P.takePasswordSignInMark('', now) === null);
  P.markPasswordSignIn('u1'); P.clearPasswordSignInMark();
  ok('O a Face ID sign-in clears an older password mark', P.takePasswordSignInMark('u1') === null);
  ok('O not dismissed at first', P.offerDismissed('u1') === false);
  P.dismissOffer('u1');
  ok('O "Not now" remembered for that account', P.offerDismissed('u1') === true);
  ok('O ... and only that account', P.offerDismissed('u2') === false);
  store.set('current_user', JSON.stringify({ id: 'u7', name: 'x' }));
  ok('O current account read from the shared sign-in', P.currentAccountId() === 'u7');
  store.set('current_user', 'junk'); ok('O broken current user = none', P.currentAccountId() === null);
  store.set('current_user', JSON.stringify({ id: 5 })); ok('O a non-text id = none', P.currentAccountId() === null);
  store.delete('current_user'); ok('O signed out = none', P.currentAccountId() === null);
  // phone only
  const mm = (coarse) => (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false });
  globalThis.matchMedia = mm(true); globalThis.screen = { width: 390, height: 844 };
  ok('O a phone (touch, short side 390) = phone', P.isPhoneLike() === true);
  globalThis.screen = { width: 1280, height: 800 };
  ok('O a big touch screen is not a phone', P.isPhoneLike() === false);
  globalThis.matchMedia = mm(false); globalThis.screen = { width: 390, height: 844 };
  ok('O no touch = not a phone', P.isPhoneLike() === false);
  delete globalThis.matchMedia; ok('O no matchMedia = not a phone', P.isPhoneLike() === false);
  globalThis.matchMedia = mm(true); globalThis.screen = { width: 0, height: 0 };
  ok('O unknown screen = not a phone', P.isPhoneLike() === false);
  globalThis.screen = { width: 599, height: 900 }; ok('O short side 599 = phone', P.isPhoneLike() === true);
  globalThis.screen = { width: 600, height: 900 }; ok('O short side 600 = not a phone', P.isPhoneLike() === false);
}

// G: a step-by-step action stops when it is no longer valid (dialog closed, another account)
{
  reset();
  let calls = 0; let valid = true;
  routes['POST /api/passkeys/register/options'] = () => { calls++; return [200, { challengeId: CID, options: OPTS_R }]; };
  routes['POST /api/passkeys/register/verify'] = () => { calls++; return [201, { ok: true, passkey: { id: 'k1' } }]; };
  await throwsKind('G add: invalid before the start sends nothing', () => P.addPasskey({ stillValid: () => false }), 'stale');
  ok('G ... nothing sent', calls === 0 && sent.length === 0);
  phone.lastCreate = null;
  routes['POST /api/passkeys/register/options'] = () => { calls++; valid = false; return [200, { challengeId: CID, options: OPTS_R }]; };
  await throwsKind('G add: invalid after options = the phone is not asked', () => P.addPasskey({ stillValid: () => valid }), 'stale');
  ok('G ... phone not asked, no verify', phone.lastCreate === null && !sent.some((x) => x.url.endsWith('/verify')));
  valid = true; routes['POST /api/passkeys/register/options'] = [200, { challengeId: CID, options: OPTS_R }];
  phone.create = async () => { valid = false; return fakeCred('create'); };
  sent.length = 0;
  await throwsKind('G add: invalid after the phone = no verify', () => P.addPasskey({ stillValid: () => valid }), 'stale');
  ok('G ... no verify sent', !sent.some((x) => x.url.endsWith('/verify')));
  valid = true; phone.create = async () => { valid = false; throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  await throwsKind('G add: a phone error after the dialog closed is silent', () => P.addPasskey({ stillValid: () => valid }), 'stale');
  phone.create = null;
  // remove
  sent.length = 0; routes['DELETE /api/passkeys/a'] = [200, { ok: true }];
  await throwsKind('G remove: invalid = no DELETE', () => P.removePasskey('a', () => false), 'stale');
  ok('G ... nothing sent', sent.length === 0);
  // sign-in
  valid = true; let vcalls = 0;
  routes['POST /api/auth/passkey/options'] = () => { valid = false; return [200, { challengeId: CID, options: OPTS_A }]; };
  routes['POST /api/auth/passkey/verify'] = () => { vcalls++; return [200, { token: 't', user: { id: 'u' } }]; };
  phone.lastGet = null;
  await throwsKind('G sign-in: page closed after options = phone not asked', () => P.signInWithPasskey(() => valid), 'stale');
  ok('G ... no prompt, no verify', phone.lastGet === null && vcalls === 0);
  valid = true; routes['POST /api/auth/passkey/options'] = [200, { challengeId: CID, options: OPTS_A }];
  phone.get = async () => { valid = false; return fakeCred('get'); };
  await throwsKind('G sign-in: closed during the prompt = no verify', () => P.signInWithPasskey(() => valid), 'stale');
  ok('G ... no verify', vcalls === 0);
  valid = true; phone.get = null;
  routes['POST /api/auth/passkey/verify'] = () => { vcalls++; valid = false; return [200, { token: 't', user: { id: 'u' } }]; };
  await throwsKind('G sign-in: a late answer is not used', () => P.signInWithPasskey(() => valid), 'stale');
  phone.get = async () => { valid = false; throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }; valid = true;
  await throwsKind('G sign-in: a phone error after close is silent', () => P.signInWithPasskey(() => valid), 'stale');
  phone.get = null;
  let n = 0; P.cancelPasskeyPrompt(); ok('G cancel with no prompt is harmless', n === 0);
}

// S: support
{
  reset();
  ok('S browser with passkeys', P.passkeysInBrowser() === true);
  ok('S platform Face ID available', (await P.platformPasskeyAvailable()) === true);
  phone.uvpaa = false;
  ok('S no platform authenticator', (await P.platformPasskeyAvailable()) === false);
  FakePKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => { throw new Error('boom'); };
  ok('S a failing check = not available', (await P.platformPasskeyAvailable()) === false);
  FakePKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => phone.uvpaa;
  const saved = globalThis.PublicKeyCredential; delete globalThis.PublicKeyCredential;
  ok('S no PublicKeyCredential = no button', P.passkeysInBrowser() === false);
  ok('S ... and not available', (await P.platformPasskeyAvailable()) === false);
  await throwsKind('S add on an unsupported browser asks nothing of the server', () => P.addPasskey(), 'unsupported', P.PASSKEY_TEXT.unsupported);
  await throwsKind('S sign-in on an unsupported browser', () => P.signInWithPasskey(), 'unsupported');
  ok('S ... nothing was sent', sent.length === 0);
  globalThis.PublicKeyCredential = saved;
}

// E: words for answers and for the phone
{
  const fb = new P.PasskeyError('failed', 'fb');
  const e = (s, d) => P.errorFromAnswer(s, d, fb);
  ok('E 503 = try again', e(503, { code: 'SESSION_STORE_UNAVAILABLE' }).kind === 'offline');
  ok('E 500 = try again', e(500, {}).kind === 'offline');
  ok('E 499 is not "try again"', e(499, {}).kind === 'failed');
  ok('E RECENT_AUTH_REQUIRED', e(403, { code: 'RECENT_AUTH_REQUIRED' }).kind === 'needPassword');
  ok('E PASSKEY_UNAVAILABLE', e(403, { code: 'PASSKEY_UNAVAILABLE' }).kind === 'unavailable');
  ok('E PASSKEY_LIMIT', e(409, { code: 'PASSKEY_LIMIT' }).kind === 'limit');
  ok('E WRONG_PASSWORD', e(403, { code: 'WRONG_PASSWORD' }).kind === 'wrongPassword');
  ok('E unknown = fallback', e(400, { code: 'PASSKEY_FAILED' }) === fb && e(400, null) === fb && e(400, 'x') === fb);
  const b = (name) => P.errorFromBrowser(Object.assign(new Error('x'), { name }), P.PASSKEY_TEXT.cancelled);
  ok('E phone: cancelled', b('NotAllowedError').kind === 'cancelled' && b('NotAllowedError').message === P.PASSKEY_TEXT.cancelled);
  ok('E phone: aborted = cancelled', b('AbortError').kind === 'cancelled');
  ok('E phone: already on this phone', b('InvalidStateError').kind === 'already');
  ok('E phone: not supported', b('NotSupportedError').kind === 'unsupported' && b('SecurityError').kind === 'unsupported');
  ok('E phone: other = could not be saved', b('UnknownError').kind === 'failed' && b('UnknownError').message === P.PASSKEY_TEXT.saveFailed);
  ok('E phone: other at sign-in = sign-in words', P.errorFromBrowser(new Error('x'), P.PASSKEY_TEXT.signInCancelled).message === P.PASSKEY_TEXT.signInFailed);
  const pe = new P.PasskeyError('limit', 'l');
  ok('E a PasskeyError passes through', P.errorFromBrowser(pe, P.PASSKEY_TEXT.cancelled) === pe);
}

// A: add
{
  reset();
  let verifyBody = null;
  routes['POST /api/passkeys/register/options'] = [200, { challengeId: CID, options: OPTS_R }];
  routes['POST /api/passkeys/register/verify'] = (b) => { verifyBody = b; return [201, { ok: true, passkey: { id: 'k1', name: 'iPhone', createdAt: 'x', lastUsedAt: null } }]; };
  const row = await P.addPasskey();
  ok('A add returns the new passkey', row?.id === 'k1');
  ok('A options were given to the phone', phone.lastCreate?.publicKey?.rp?.id === 'localhost' && phone.lastCreate.publicKey.challenge instanceof ArrayBuffer);
  ok('A verify carries the challengeId and the phone answer, no name by default', verifyBody?.challengeId === CID && verifyBody?.response?.id === 'Y3JlZA' && verifyBody?.response?.response?.attestationObject && !('name' in verifyBody));
  const opt = sent.find((s) => s.url === '/api/passkeys/register/options');
  ok('A requests opt in to the cookie', opt?.headers.get('X-Shutfey-Auth') === 'cookie');
  await P.addPasskey({ name: 'Work phone' });
  ok('A a given name is sent', verifyBody?.name === 'Work phone');
  // the phone says no -> nothing goes to verify
  sent.length = 0; phone.create = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  await throwsKind('A cancelled on the phone', () => P.addPasskey(), 'cancelled', P.PASSKEY_TEXT.cancelled);
  ok('A ... nothing sent to verify', !sent.some((s) => s.url.endsWith('/verify')));
  phone.create = async () => { throw Object.assign(new Error('x'), { name: 'InvalidStateError' }); };
  await throwsKind('A already on this phone', () => P.addPasskey(), 'already', P.PASSKEY_TEXT.alreadyOnPhone);
  phone.create = null;
  routes['POST /api/passkeys/register/options'] = [403, { error: 'x', code: 'RECENT_AUTH_REQUIRED' }];
  sent.length = 0;
  await throwsKind('A proof too old -> ask the password', () => P.addPasskey(), 'needPassword');
  ok('A ... the phone was not asked', !sent.some((s) => s.url.endsWith('/verify')));
  routes['POST /api/passkeys/register/options'] = [409, { error: 'x', code: 'PASSKEY_LIMIT' }];
  await throwsKind('A limit', () => P.addPasskey(), 'limit', P.PASSKEY_TEXT.limit);
  routes['POST /api/passkeys/register/options'] = [403, { error: 'x', code: 'PASSKEY_UNAVAILABLE' }];
  await throwsKind('A password-only account', () => P.addPasskey(), 'unavailable');
  routes['POST /api/passkeys/register/options'] = [503, { error: 'x' }];
  await throwsKind('A store down = try again', () => P.addPasskey(), 'offline', P.PASSKEY_TEXT.offline);
  routes['POST /api/passkeys/register/options'] = 'offline';
  await throwsKind('A no network = try again', () => P.addPasskey(), 'offline');
  routes['POST /api/passkeys/register/options'] = [200, { options: OPTS_R }];
  await throwsKind('A options without challengeId refused', () => P.addPasskey(), 'failed');
  routes['POST /api/passkeys/register/options'] = [200, { challengeId: CID }];
  sent.length = 0; phone.lastCreate = null;
  await throwsKind('A challengeId without options refused', () => P.addPasskey(), 'failed');
  ok('A ... the phone was not asked', phone.lastCreate === null);
  routes['POST /api/passkeys/register/options'] = [200, { challengeId: CID, options: OPTS_R }];
  routes['POST /api/passkeys/register/verify'] = [400, { error: 'x', code: 'PASSKEY_FAILED' }];
  await throwsKind('A verify refused = could not be saved', () => P.addPasskey(), 'failed', P.PASSKEY_TEXT.saveFailed);
  routes['POST /api/passkeys/register/verify'] = [503, { error: 'x' }];
  await throwsKind('A verify store down = try again', () => P.addPasskey(), 'offline');
}

// I: sign in
{
  reset();
  let vb = null;
  const loginBody = { token: 'tok', user: { id: 'u1', name: 'Sam', agencyName: 'Solo Vaad' } };
  routes['POST /api/auth/passkey/options'] = [200, { challengeId: CID, options: OPTS_A }];
  routes['POST /api/auth/passkey/verify'] = (b) => { vb = b; return [200, loginBody]; };
  const ans = await P.signInWithPasskey();
  ok('I the sign-in answer comes back as is', JSON.stringify(ans) === JSON.stringify(loginBody));
  ok('I verify carries challengeId + phone answer', vb?.challengeId === CID && vb?.response?.response?.signature);
  ok('I the phone was asked with the server options', phone.lastGet?.publicKey?.rpId === 'localhost');
  const chooser = { choose: true, token: 'c', memberships: [{ id: 'm1' }, { id: 'm2' }] };
  routes['POST /api/auth/passkey/verify'] = [200, chooser];
  ok('I a chooser answer comes back as is', (await P.signInWithPasskey()).choose === true);
  routes['POST /api/auth/passkey/verify'] = [401, { error: 'x', code: 'PASSKEY_FAILED' }];
  await throwsKind('I unknown passkey -> plain words', () => P.signInWithPasskey(), 'failed', P.PASSKEY_TEXT.signInFailed);
  routes['POST /api/auth/passkey/verify'] = [503, { error: 'x' }];
  await throwsKind('I store down -> try again', () => P.signInWithPasskey(), 'offline');
  phone.get = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  sent.length = 0;
  await throwsKind('I cancelled on the phone', () => P.signInWithPasskey(), 'cancelled', P.PASSKEY_TEXT.signInCancelled);
  ok('I ... nothing sent to verify', !sent.some((s) => s.url.endsWith('/verify')));
  phone.get = null;
  routes['POST /api/auth/passkey/options'] = [200, {}];
  await throwsKind('I empty options refused', () => P.signInWithPasskey(), 'failed');
  routes['POST /api/auth/passkey/options'] = [429, { error: 'x', code: 'RATE_LIMITED' }];
  await throwsKind('I other refusal -> sign-in words', () => P.signInWithPasskey(), 'failed', P.PASSKEY_TEXT.signInFailed);
}

// L: list / rename / remove / recent-auth
{
  reset();
  routes['GET /api/passkeys'] = [200, { passkeys: [{ id: 'a', name: 'iPhone', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null }, null, { name: 'no id' }, { id: 'b', name: '', createdAt: 'x' }], canAdd: true }];
  const l = await P.listPasskeys();
  ok('L list keeps rows with an id', l.passkeys.length === 2 && l.passkeys[0].id === 'a' && l.passkeys[1].id === 'b');
  ok('L an empty name shows as "Passkey"', l.passkeys[1].name === 'Passkey');
  ok('L canAdd only when true', l.canAdd === true);
  routes['GET /api/passkeys'] = [200, { passkeys: 'x', canAdd: 'yes' }];
  const l2 = await P.listPasskeys();
  ok('L junk = empty, cannot add', l2.passkeys.length === 0 && l2.canAdd === false);
  routes['GET /api/passkeys'] = [404, { error: 'x' }];
  await throwsKind('L an older server (404) = not shown', () => P.listPasskeys(), 'offline');
  let renameBody = null;
  routes['PATCH /api/passkeys/a%2Fb'] = (b) => { renameBody = b; return [200, { ok: true }]; };
  await P.renamePasskey('a/b', 'Work');
  ok('L rename: id encoded, name sent', renameBody?.name === 'Work');
  routes['PATCH /api/passkeys/a'] = [400, { error: 'x' }];
  await throwsKind('L rename refused', () => P.renamePasskey('a', 'x'), 'failed', P.PASSKEY_TEXT.renameFailed);
  routes['DELETE /api/passkeys/a'] = [200, { ok: true }];
  await P.removePasskey('a');
  ok('L remove sends DELETE', sent.some((s) => s.method === 'DELETE' && s.url === '/api/passkeys/a'));
  routes['DELETE /api/passkeys/a'] = [403, { error: 'x', code: 'RECENT_AUTH_REQUIRED' }];
  await throwsKind('L remove without fresh proof asks the password', () => P.removePasskey('a'), 'needPassword');
  routes['DELETE /api/passkeys/a'] = [503, { error: 'x' }];
  await throwsKind('L remove store down = try again', () => P.removePasskey('a'), 'offline');
  let raBody = null;
  routes['POST /api/auth/recent-auth'] = (b) => { raBody = b; return [200, { ok: true, recentAuthUntil: 'x' }]; };
  await P.confirmPassword('pw1');
  ok('L recent-auth sends the password', raBody?.password === 'pw1');
  routes['POST /api/auth/recent-auth'] = [403, { error: 'x', code: 'WRONG_PASSWORD' }];
  await throwsKind('L wrong password', () => P.confirmPassword('x'), 'wrongPassword', P.PASSKEY_TEXT.wrongPassword);
  routes['POST /api/auth/recent-auth'] = [429, { error: 'x', code: 'RATE_LIMITED' }];
  await throwsKind('L other refusal = wrong password words', () => P.confirmPassword('x'), 'wrongPassword');
  routes['POST /api/auth/recent-auth'] = [503, { error: 'x' }];
  await throwsKind('L recent-auth store down', () => P.confirmPassword('x'), 'offline');
  // a 503 never signs out: a stored token survives every failure above
  api.setSessionToken('keep-me');
  routes['GET /api/passkeys'] = [503, { error: 'x' }];
  await throwsKind('L list store down', () => P.listPasskeys(), 'offline');
  ok('L ... still signed in', api.getSessionToken() === 'keep-me');
  const now = Date.parse('2026-10-22T12:00:00Z');
  ok('L when: today / yesterday / date / never', P.describeWhen('2026-10-22T08:00:00Z', now) === 'today' && P.describeWhen('2026-10-21T08:00:00Z', now) === 'yesterday' && P.describeWhen('2026-10-01T08:00:00Z', now) === 'Oct 1' && P.describeWhen(null, now) === 'never' && P.describeWhen('junk', now) === 'never');
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
