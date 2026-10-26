import assert from 'node:assert/strict';
import { LOGOUT_ACK_MAX_AGE_S, logoutAckSetCookie } from '../../src/server/logout-marker.ts';
const id = '0123456789abcdef';
const marker = `shutfey_logout_ack_${id}`;
const expected = `${marker}=1; Path=/; Max-Age=660; SameSite=Strict`;
function helperCases() {
  assert.ok(LOGOUT_ACK_MAX_AGE_S > 600, 'ack outlives unknown-request window');
  assert.equal(logoutAckSetCookie(id, false), expected);
  assert.equal(logoutAckSetCookie(id, true), expected + '; Secure');
  for (const bad of [undefined, null, 123, [id], '../x', '0123456789abcde', '0123456789ABCDEf', '0123456789abcdef0']) {
    assert.equal(logoutAckSetCookie(bad, false), null);
  }
}
helperCases();
export default {
  name: 'Test 87: logout response acknowledgment',
  whatItProves: 'Only logout acknowledges valid marker ids, after all sign-in cookie deletions, even on refused or unavailable requests.',
  async run(baseUrl) {
    helperCases();
    async function call(path, { method = 'POST', token, logoutId = id, body, rawBody, ...headers } = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(logoutId === null ? {} : { 'X-Shutfey-Logout-Id': logoutId }), ...headers },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const text = await res.text();
      assert.ok(!text.includes(id), 'body never echoes logout id');
      assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('shutfey_lo_')), 'server never sets draft marker');
      return { status: res.status, text, cookies: res.headers.getSetCookie(), json: () => JSON.parse(text) };
    }
    const ts = Date.now();
    const registered = await call('/api/agencies/register', { logoutId: null, body: {
      agencyName: `T87 Demo ${ts}`, adminEmail: `t87-${ts}@test.local`, adminPassword: 'Demo-87-password!', adminName: 'T87 Demo',
    } });
    assert.equal(registered.status, 201);
    const token = registered.json().token;
    const checkAck = (r, status) => {
      assert.equal(r.status, status);
      assert.equal(r.cookies.at(-1), expected, 'ack is last');
      assert.equal(r.cookies.filter((c) => c.startsWith(marker + '=')).length, 1, 'ack appended once');
    };
    checkAck(await call('/api/auth/logout', { rawBody: '{' }), 400);
    checkAck(await call('/api/auth/logout', { rawBody: JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }) }), 413);
    checkAck(await call('/api/auth/logout', { Cookie: `shutfey_s=${token}`, 'X-Shutfey-Auth': 'cookie', Origin: 'https://foreign.example' }), 403);
    const hook = (body) => call('/api/__test__/session-hooks', { logoutId: null, body });
    await hook({ action: 'revokeFault', on: true });
    try { checkAck(await call('/api/auth/logout', { token }), 503); }
    finally { await hook({ action: 'revokeFault', on: false }); }
    const signedOut = await call('/api/auth/logout', { token });
    checkAck(signedOut, 200);
    for (const name of ['shutfey_s', 'shutfey_ks']) {
      assert.ok(signedOut.cookies.some((c) => c.startsWith(name + '=;') && c.includes('Max-Age=0')), `${name} deleted`);
    }
    checkAck(await call('/api/auth/logout'), 401);
    checkAck(await call('/api/auth/logout', { token }), 401);
    for (const bad of [null, '../x', '0123456789abcde', '0123456789ABCDEf', '0123456789abcdef0']) {
      const r = await call('/api/auth/logout', { logoutId: bad });
      assert.ok(!r.cookies.some((c) => c.startsWith('shutfey_logout_ack_')), 'bad/missing header adds no cookie');
    }
    const health = await call('/api/health', { method: 'GET' });
    assert.ok(!health.cookies.some((c) => c.startsWith('shutfey_logout_ack_')), 'other route adds no marker');
    return 'helper cases; 200 U/K + ack last; 401 missing/revoked; 400/403/413/503; malformed ids; other route; no body echo';
  },
};
