/**
 * FACEID2 client (two-agency Face ID): src/lib/passkeys.ts reads the server's
 * per-passkey "works on this address" word (#156) and the offer asks for Face ID
 * when none of the person's passkeys works HERE; an older server = today's rule.
 *  P  listPasskeys parses here / hasPasskeyHere (present, absent, wrong type -> undefined).
 *  H  hasPasskeyForThisAddress: the server's word when given; else any passkey at all.
 *  A  App.tsx: the offer condition uses hasPasskeyForThisAddress; the menu row rule,
 *     the offer-dismissed key and the 5-minute mark are unchanged; no new words.
 * Run: npx tsx tests/client/test-faceid2-client.mjs
 */
const mkStore = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] ?? null });
globalThis.localStorage = mkStore(new Map()); globalThis.sessionStorage = mkStore(new Map());
globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' };
let answer = [200, {}];
globalThis.fetch = async () => { const [status, json] = answer; return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } }); };
const P = await import('../../src/lib/passkeys.ts');
const fs = await import('node:fs');

let pass = 0, fail = 0;
const ok = (label, cond, info = '') => { if (cond) pass++; else { fail++; console.log('FAIL ' + label + (info ? ' :: ' + info : '')); } };
const row = (id, extra = {}) => ({ id, name: id, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, ...extra });

// P: parsing
{
  answer = [200, { passkeys: [row('a', { here: true, address: { kind: 'shared' } }), row('b', { here: false, address: { kind: 'site', agencyName: 'Hartford Kashrus Council' } })], canAdd: true, hasPasskeyHere: true }];
  const l = await P.listPasskeys();
  ok('P here true / false kept per row', l.passkeys[0].here === true && l.passkeys[1].here === false);
  ok('P hasPasskeyHere true kept', l.hasPasskeyHere === true);
  ok('P address labels still read', P.passkeyAddressLabel(l.passkeys[1].address) === 'Hartford Kashrus Council address');
  answer = [200, { passkeys: [row('a', { here: false })], canAdd: true, hasPasskeyHere: false }];
  const l0 = await P.listPasskeys();
  ok('P hasPasskeyHere false kept (not mistaken for absent)', l0.hasPasskeyHere === false && l0.passkeys[0].here === false);
  answer = [200, { passkeys: [row('a')], canAdd: true }];
  const l2 = await P.listPasskeys();
  ok('P older server: no here, no hasPasskeyHere', l2.passkeys[0].here === undefined && l2.hasPasskeyHere === undefined);
  answer = [200, { passkeys: [row('a', { here: 'yes' }), row('b', { here: 1 }), row('c', { here: null })], canAdd: true, hasPasskeyHere: 'true' }];
  const l3 = await P.listPasskeys();
  ok('P wrong types -> undefined (row)', l3.passkeys.every((p) => p.here === undefined));
  ok('P wrong type -> undefined (top)', l3.hasPasskeyHere === undefined);
  answer = [200, { passkeys: [], canAdd: true, hasPasskeyHere: 0 }];
  ok('P 0 is not false', (await P.listPasskeys()).hasPasskeyHere === undefined);
}

// H: the decision
{
  const H = P.hasPasskeyForThisAddress;
  ok('H server says here -> has one', H({ passkeys: [row('a')], canAdd: true, hasPasskeyHere: true }) === true);
  ok('H F1/F2: passkeys elsewhere only -> none here (offer may show)', H({ passkeys: [row('a', { here: false })], canAdd: true, hasPasskeyHere: false }) === false);
  ok('H server word wins even with an empty list', H({ passkeys: [], canAdd: true, hasPasskeyHere: true }) === true);
  ok('H F5 older server, a passkey -> has one (today)', H({ passkeys: [row('a')], canAdd: true }) === true);
  ok('H F5 older server, none -> none (today)', H({ passkeys: [], canAdd: true }) === false);
  ok('H F4 one agency, none, new server -> none', H({ passkeys: [], canAdd: true, hasPasskeyHere: false }) === false);
}

// A: App.tsx wiring
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const i = app.indexOf('listPasskeys().then(');
  const eff = app.slice(i, app.indexOf('return () => { live = false; };', i));
  ok('A effect found', i > 0 && eff.length > 0 && eff.length < 2000);
  ok('A offer uses hasPasskeyForThisAddress', /if \(offerUntil !== null && isPhoneLike\(\) && l\.canAdd && !hasPasskeyForThisAddress\(l\) && !offerDismissed\(userId\) && await platformPasskeyAvailable\(\)\)/.test(eff));
  ok('A offer no longer counts every passkey', !/passkeys\.length === 0/.test(eff));
  ok('A menu row rule unchanged', eff.includes('setPasskeyMenu(l.canAdd || l.passkeys.length > 0);'));
  ok('A still offered only inside the window, to this account', eff.includes('Date.now() < offerUntil && currentAccountId() === userId'));
  const lib = fs.readFileSync(new URL('../../src/lib/passkeys.ts', import.meta.url), 'utf8');
  ok('A offer-dismissed key unchanged (phones keep "Not now")', lib.includes('`shutfey_passkey_offer_off:${userId}`'));
  ok('A password mark key unchanged', lib.includes("'shutfey_password_signin_at'"));
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
