/**
 * Item 11, 11a-s2: the user session cookie and the trusted-origin rule (unit, pure).
 */
import { userCookieConfig, cookieValues, setCookieHeader, clearCookieHeader, normalizeOrigin, trustedOrigins, originTrusted, DEFAULT_APP_ORIGINS, USER_COOKIE_PROD } from '../../src/server/session-cookie.ts';
import { buildUserSession, USER_SESSION_TTL_MS } from '../../src/server/sessions.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);
const throws = (f) => { try { f(); return false; } catch { return true; } };

export default {
  name: 'Item 11 (11a-s2): session cookie + trusted origins (unit)',
  whatItProves: 'Production uses __Host-shutfey_s with Secure (test mode alone drops both); the cookie is HttpOnly, SameSite=Lax, Path=/, host-only; trusted origins come only from APP_ORIGINS or the default production origin (https only outside test mode; loopback only in test mode); Origin matching is exact; an adopted record never outlives the adopted token.',
  async run() {
    const prod = userCookieConfig(false);
    const test = userCookieConfig(true);
    assert(prod.name === '__Host-shutfey_s' && prod.name === USER_COOKIE_PROD && prod.secure === true, `production cookie: ${J(prod)}`);
    assert(test.name === 'shutfey_s' && test.secure === false, `test-mode cookie: ${J(test)}`);
    const tok = 'aaa.bbb.ccc';
    const sp = setCookieHeader(prod, tok, 100);
    assert(sp === '__Host-shutfey_s=aaa.bbb.ccc; Path=/; Max-Age=100; HttpOnly; SameSite=Lax; Secure', `production Set-Cookie: ${sp}`);
    assert(!/domain=/i.test(sp), 'host-only (no Domain)');
    assert(setCookieHeader(test, tok, 5.9) === 'shutfey_s=aaa.bbb.ccc; Path=/; Max-Age=5; HttpOnly; SameSite=Lax', 'test-mode Set-Cookie (no Secure), Max-Age floored');
    assert(setCookieHeader(test, tok, -3).includes('Max-Age=0'), 'negative Max-Age clamps to 0');
    for (const bad of ['a;b.c.d', 'a.b', 'a.b.c d', 'a.b.c\r\nX: y', '']) assert(throws(() => setCookieHeader(prod, bad, 10)), `refuses a cookie value ${J(bad)}`);
    const cl = clearCookieHeader(prod);
    assert(cl.startsWith('__Host-shutfey_s=;') && cl.includes('Max-Age=0') && cl.includes('Secure') && cl.includes('Path=/'), `clear: ${cl}`);

    assert(J(cookieValues('a=1; shutfey_s=x.y.z; b=2', 'shutfey_s')) === J(['x.y.z']), 'one value');
    assert(J(cookieValues('shutfey_s=1; shutfey_s=2', 'shutfey_s')) === J(['1', '2']), 'duplicates are all returned (the caller refuses them)');
    assert(J(cookieValues('xshutfey_s=1; shutfey_sx=2', 'shutfey_s')) === J([]), 'exact name only');
    assert(J(cookieValues('shutfey_s="q.w.e"', 'shutfey_s')) === J(['q.w.e']), 'quoted value');
    assert(J(cookieValues(undefined, 'shutfey_s')) === J([]) && J(cookieValues('x'.repeat(20000), 'x')) === J([]), 'missing / oversized header');

    assert(normalizeOrigin('https://A.example') === 'https://a.example' && normalizeOrigin('https://a.example/x') === null && normalizeOrigin('ftp://a') === null && normalizeOrigin('https://u:p@a.example') === null && normalizeOrigin('null') === null, 'normalizeOrigin');
    const p0 = trustedOrigins({ appOrigins: undefined, testMode: false, port: 3000 });
    assert(J(p0) === J(DEFAULT_APP_ORIGINS) && p0[0].startsWith('https://') && p0.length === 1, `production default: ${J(p0)}`);
    const p1 = trustedOrigins({ appOrigins: 'https://app.example.org, http://insecure.example, https://two.example/', testMode: false, port: 3000 });
    assert(J(p1) === J(['https://app.example.org', 'https://two.example']), `APP_ORIGINS parsed, http dropped in production: ${J(p1)}`);
    assert(!p1.some((o) => o.includes('127.0.0.1') || o.includes('localhost')), 'no loopback in production');
    const p2 = trustedOrigins({ appOrigins: 'garbage, ,', testMode: false, port: 3000 });
    assert(J(p2) === J(DEFAULT_APP_ORIGINS), 'unparsable APP_ORIGINS falls back to the default');
    const t0 = trustedOrigins({ appOrigins: undefined, testMode: true, port: 3470 });
    assert(t0.includes('http://127.0.0.1:3470') && t0.includes('http://localhost:3470') && !t0.includes('http://127.0.0.1:3471'), `test mode adds this port's loopback only: ${J(t0)}`);

    const T = ['https://app.example.org', 'http://127.0.0.1:3470'];
    assert(originTrusted('https://app.example.org', T) && originTrusted('http://127.0.0.1:3470', T), 'exact match');
    for (const o of ['https://app.example.org/', 'https://APP.example.org', 'https://evil.example', 'null', '', undefined, ' https://app.example.org', 'https://app.example.org:443', 'http://app.example.org', 'https://app.example.org.evil.example', ['https://app.example.org']]) {
      assert(!originTrusted(o, T), `not trusted: ${J(o)}`);
    }

    const now = 1_000_000_000_000;
    const row = { id: 'u1', personId: 'p1', agencyId: 'ag' };
    const sid = 'AAAAAAAAAAAAAAAAAAAAAA';
    const full = buildUserSession({ sid, row, epoch: 0, via: 'adopt', nowMs: now });
    assert(full.absoluteExpMs === now + USER_SESSION_TTL_MS, 'no cap: 30 days');
    const capped = buildUserSession({ sid, row, epoch: 0, via: 'adopt', nowMs: now, capExpMs: now + 5000 });
    assert(capped.absoluteExpMs === now + 5000 && capped.via === 'adopt', 'cap: the record ends with the adopted token');
    assert(buildUserSession({ sid, row, epoch: 0, via: 'adopt', nowMs: now, capExpMs: now + USER_SESSION_TTL_MS * 2 }).absoluteExpMs === now + USER_SESSION_TTL_MS, 'a later cap never extends past 30 days');
    for (const bad of [now, now - 1, NaN, Infinity, '5']) assert(throws(() => buildUserSession({ sid, row, epoch: 0, via: 'adopt', nowMs: now, capExpMs: bad })), `bad cap ${J(bad)} refused`);
    return { pass: true, detail: 'cookie attrs prod/test, parsing, origins, adopt cap' };
  },
};
