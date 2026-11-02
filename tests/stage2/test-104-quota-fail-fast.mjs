import assert from 'node:assert/strict';

export default {
  name: 'Test 104: Write quota fails fast',
  whatItProves: 'Quota thrown inside the SDK transaction callback stops password/PIN sign-in and task saves within 5 seconds; no token, cookie or unreserved PIN compare; recovery works.',
  async run(baseUrl, ctx) {
    const suffix = Date.now();
    const userId = `user-writecut-${suffix}`;
    const email = `writecut-${suffix}@test.local`;
    const venueId = `venue-writecut-${suffix}`;
    const password = 'writecut-test-password';
    // Keep this fixture out of pairing/PIN IP buckets used by earlier tests.
    const ip = `10.104.${suffix % 200}.7`;
    const call = async (path, body, headers = {}) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: res.status, json: await res.json(), cookies: res.headers.get('set-cookie') };
    };
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', {
      venues: [{ id: venueId, name: 'Writecut test venue', agencyId: 'agency-hkc' }],
      users: [{ id: userId, email, name: 'Writecut test user', role: 'mashgiach', agencyId: 'agency-hkc', venueId, kioskPin: '2345' }],
    })).status, 200);
    assert.equal((await call('/api/__test__/set-password', { userId, password })).status, 200);
    const login = () => call('/api/auth/login', { email, password });
    assert.equal((await login()).status, 200);
    const start = await call('/api/kiosk/pairing/start', {});
    assert.equal(start.status, 200, `pairing/start: ${JSON.stringify(start.json)}`);
    const paired = await ctx.api('POST', '/api/kiosk/devices/pair', { code: start.json.code, venueId, name: 'Writecut tablet' });
    assert.equal(paired.status, 201);
    const pairing = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Forwarded-For': ip, 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } });
    const device = (await pairing.json()).device;
    assert(device?.id);
    const pinLogin = () => call('/api/kiosk/login', { userId, pin: '2345' }, { 'X-Kiosk-Device': `${device.id}.${start.json.deviceSecret}` });
    const hook = async (commits) => {
      const r = await ctx.api('POST', '/api/__test__/write-quota', { commits });
      assert.equal(r.status, 200);
      return r.json;
    };
    const fastQuota = async (action, daily = true) => {
      // Login may first read optional recent-auth proof in a transaction.
      // Keep quota exhausted through that read AND the mandatory session write.
      await hook(10);
      const begin = Date.now();
      const r = await action();
      assert(Date.now() - begin < 5000, 'quota response took 5 seconds');
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert(!r.json.token, 'no credential before stored session');
      assert(!r.cookies, 'no sign-in cookie before stored session');
      if (daily) assert.deepEqual(r.json, { error: 'The app is over its daily limit. Try again after 3 AM.', code: 'DAILY_LIMIT' });
      else assert.match(r.json.error, /over its daily limit/i);
      const cleared = await hook(0);
      assert(cleared.remaining >= 8, 'quota transactions must not be retried');
    };
    try {
      await fastQuota(login);
      const before = await ctx.getDoc();
      const compares = (await hook(0)).pinCompares;
      await fastQuota(pinLogin);
      assert.equal((await hook(0)).pinCompares, compares, 'failed reservation must not compare a PIN');
      assert.deepEqual((await ctx.getDoc()).kioskPinLockouts, before.kioskPinLockouts, 'failed reservation must not change counters');
      await fastQuota(() => call('/api/tasks', { venueId, title: `Writecut ${suffix}`, createdByEmail: 'kenan@hartfordkashrut.org' }, ctx.authHeaders), false);
      const recovered = await login();
      assert.equal(recovered.status, 200);
      assert(recovered.json.token, 'sign-in recovers after quota clears');
      const pinRecovered = await pinLogin();
      assert.equal(pinRecovered.status, 200, JSON.stringify(pinRecovered.json));
      assert(pinRecovered.json.token);
      assert.equal((await hook(0)).pinCompares, compares + 1);
    } finally {
      await hook(0);
    }
    return 'callback quota: password/PIN/task <5s; no token/cookie/compare on failure; password and PIN recover';
  },
};
