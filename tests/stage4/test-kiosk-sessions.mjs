/**
 * Item 11, 11a-s3: kiosk session records + the kiosk (K) and device (D) cookies (unit, pure).
 */
import { buildKioskSession as BK, buildUserSession as BU, sessionBacksClaims as OK, KIOSK_SESSION_TTL_MS, SESSION_VIA } from '../../src/server/sessions.ts';
import { classifySessionClaims as C } from '../../src/server/session-token.ts';
import { kioskCookieConfig, deviceCookieConfig, userCookieConfig, setCookieHeader, setDeviceCookieHeader, clearCookieHeader, isDeviceCredentialShape, cookieValues, KIOSK_COOKIE_PROD, DEVICE_COOKIE_PROD, DEVICE_COOKIE_MAX_AGE_SEC } from '../../src/server/session-cookie.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);
const throws = (f) => { try { f(); return false; } catch { return true; } };

export default {
  name: 'Item 11 (11a-s3): kiosk session records + K/D cookies (unit)',
  whatItProves: 'A kiosk record ends exactly 3 h after sign-in (adopt cap only shortens it) and backs only a kiosk token of the same row, agency, venue, tablet and PIN revision; user and kiosk records never back each other; K/D cookie attributes (prod __Host- + Secure, test plain) and the device credential shape.',
  async run() {
    const sid = 'KKKKKKKKKKKKKKKKKKKKKK';
    const now = 1_800_000_000_000;
    assert(KIOSK_SESSION_TTL_MS === 3 * 3600 * 1000, 'kiosk session 3 h (plan 15.1)');
    assert(SESSION_VIA.includes('kiosk-login') && SESSION_VIA.includes('kiosk-adopt'), 'kiosk via labels');
    const base = { sid, row: { id: 'k1', personId: 'p1' }, epoch: 4, agencyId: 'ag1', venueId: 'v1', deviceId: 'kdev-1', pv: '3', via: 'kiosk-login', userAgent: 'y'.repeat(99), nowMs: now };
    const d = BK(base);
    assert(d.kind === 'kiosk' && d.rowId === 'k1' && d.personId === 'p1' && d.agencyId === 'ag1' && d.venueId === 'v1' && d.kioskDeviceId === 'kdev-1' && d.pvAtIssue === '3' && d.epochAtIssue === 4 && d.revokedAt === null && d.userAgentHint.length === 60, 'kiosk record fields');
    assert(d.absoluteExpMs === now + KIOSK_SESSION_TTL_MS, 'ends 3 h after sign-in');
    assert(!('idleExpMs' in d) && !('idleExp' in d), 'no idle limit (plan 15.1)');
    const kc = C({ sub: 'k1', kiosk: true, agencyId: 'ag1', venueId: 'v1', pv: '3', dev: 'kdev-1', sid });
    assert(OK(d, kc, now) && OK(d, kc, now + KIOSK_SESSION_TTL_MS - 60_000) && OK(d, kc, now + KIOSK_SESSION_TTL_MS - 1), 'backs its token until 3 h (2 h 59 min works)');
    assert(!OK(d, kc, now + KIOSK_SESSION_TTL_MS), 'refused AT 3 h');
    assert(!OK({ ...d, revokedAt: 'x' }, kc, now), 'revoked -> refused');
    for (const [k, v] of [['rowId', 'k2'], ['agencyId', 'ag2'], ['venueId', 'v2'], ['kioskDeviceId', 'kdev-2'], ['pvAtIssue', '4'], ['sid', 'LLLLLLLLLLLLLLLLLLLLLL']]) {
      assert(!OK({ ...d, [k]: v }, kc, now), `other ${k} -> refused`);
    }
    for (const k of ['agencyId', 'venueId', 'kioskDeviceId', 'pvAtIssue']) {
      assert(!OK({ ...d, [k]: undefined }, kc, now) && !OK({ ...d, [k]: '' }, kc, now), `record without ${k} -> refused`);
    }
    // a field missing on BOTH sides is still a refusal (never "undefined === undefined")
    for (const [rk, tk] of [['agencyId', 'agencyId'], ['venueId', 'venueId'], ['kioskDeviceId', 'dev'], ['pvAtIssue', 'pv']]) {
      const c3 = C({ sub: 'k1', kiosk: true, agencyId: 'ag1', venueId: 'v1', pv: '3', dev: 'kdev-1', sid, [tk]: undefined });
      assert(!OK({ ...d, [rk]: undefined }, c3, now), `${rk} missing on the record and the token -> refused`);
    }
    for (const k of ['agencyId', 'venueId', 'pv', 'dev']) {
      const c2 = C({ sub: 'k1', kiosk: true, agencyId: 'ag1', venueId: 'v1', pv: '3', dev: 'kdev-1', sid, [k]: undefined });
      assert(!OK(d, c2, now), `token without ${k} -> refused`);
    }
    assert(!OK(d, C({ sub: 'k1', kiosk: true, agencyId: 'ag1', venueId: 'v1', pv: '3', dev: 'kdev-1' }), now), 'kiosk token without sid -> refused');
    // user and kiosk records never back each other's tokens
    const u = BU({ sid, row: { id: 'k1', personId: 'p1', agencyId: 'ag1' }, epoch: 4, via: 'login', nowMs: now });
    assert(!OK(u, kc, now), 'user record never backs a kiosk token');
    assert(!OK(d, C({ v: 2, sub: 'p1', mem: 'k1', ep: 4, sid }), now) && !OK(d, C({ sub: 'k1', sid }), now), 'kiosk record never backs a user token');
    assert(!OK({ ...d, kind: 'user' }, kc, now), 'kind user -> refused for a kiosk token');
    // adopt cap
    const capped = BK({ ...base, via: 'kiosk-adopt', capExpMs: now + 5000 });
    assert(capped.absoluteExpMs === now + 5000 && capped.via === 'kiosk-adopt', 'adopt: ends with the adopted token');
    assert(BK({ ...base, capExpMs: now + KIOSK_SESSION_TTL_MS * 2 }).absoluteExpMs === now + KIOSK_SESSION_TTL_MS, 'a later cap never extends past 3 h');
    for (const bad of [now, now - 1, NaN, Infinity, '5']) assert(throws(() => BK({ ...base, capExpMs: bad })), `bad cap ${J(bad)} refused`);
    for (const bad of [{ sid: 'bad' }, { epoch: -1 }, { epoch: 1.5 }, { agencyId: '' }, { venueId: undefined }, { deviceId: 7 }, { pv: '' }]) {
      assert(throws(() => BK({ ...base, ...bad })), `bad input ${J(bad)} refused`);
    }
    console.log('  ✓ kiosk records');

    // cookies
    const kp = kioskCookieConfig(false), kt = kioskCookieConfig(true), dp = deviceCookieConfig(false), dt = deviceCookieConfig(true);
    assert(kp.name === KIOSK_COOKIE_PROD && kp.name === '__Host-shutfey_ks' && kp.secure === true, 'K prod: __Host-shutfey_ks + Secure');
    assert(dp.name === DEVICE_COOKIE_PROD && dp.name === '__Host-shutfey_kd' && dp.secure === true, 'D prod: __Host-shutfey_kd + Secure');
    assert(kt.name === 'shutfey_ks' && kt.secure === false && dt.name === 'shutfey_kd' && dt.secure === false, 'test mode: plain names, no Secure');
    const names = new Set([kp.name, dp.name, userCookieConfig(false).name, kt.name, dt.name, userCookieConfig(true).name]);
    assert(names.size === 6, 'U, K and D never share a name');
    const tok = 'aaa.bbb.ccc';
    assert(setCookieHeader(kp, tok, 10800) === `__Host-shutfey_ks=${tok}; Path=/; Max-Age=10800; HttpOnly; SameSite=Lax; Secure`, 'K header');
    const cred = 'kdev-0123456789abcdef01.' + 'S'.repeat(43);
    assert(isDeviceCredentialShape(cred), 'device credential shape');
    for (const bad of ['', 'nodot', '.x', 'x.', 'a.b.c', 'a b.c', 'a;b.c', 'a.b;Path=/x', 'x'.repeat(65) + '.y', 'x.' + 'y'.repeat(129), 5, null]) {
      assert(!isDeviceCredentialShape(bad), `bad credential ${J(bad)} refused`);
      assert(throws(() => setDeviceCookieHeader(dp, bad)), `bad credential ${J(bad)} never becomes a cookie`);
    }
    assert(DEVICE_COOKIE_MAX_AGE_SEC === 400 * 24 * 3600, 'D max-age 400 days');
    assert(setDeviceCookieHeader(dp, cred) === `__Host-shutfey_kd=${cred}; Path=/; Max-Age=${400 * 24 * 3600}; HttpOnly; SameSite=Lax; Secure`, 'D header prod');
    assert(setDeviceCookieHeader(dt, cred, 5) === `shutfey_kd=${cred}; Path=/; Max-Age=5; HttpOnly; SameSite=Lax`, 'D header test');
    assert(clearCookieHeader(kp).startsWith('__Host-shutfey_ks=; Path=/; Max-Age=0;') && clearCookieHeader(dt).startsWith('shutfey_kd=; Path=/; Max-Age=0;'), 'clear K / D');
    assert(J(cookieValues(`shutfey_s=a.b.c; shutfey_ks=d.e.f; shutfey_kd=${cred}`, 'shutfey_ks')) === J(['d.e.f']) && J(cookieValues(`shutfey_kd=${cred}`, 'shutfey_kd')) === J([cred]), 'K / D parsed by exact name');
    return { pass: true, detail: 'kiosk record 3 h + matching rule, K/D cookie attributes, device credential shape' };
  },
};
