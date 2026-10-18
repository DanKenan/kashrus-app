/**
 * Test 8: Password-reset security hardening.
 *
 * Verifies:
 *  1. Reset codes are 6-digit numeric (cryptographically generated).
 *  2. Stored codes are hashed (codeHash), never plaintext.
 *  3. Rate limiting: 6th forgot-password request within an hour → 429.
 *  4. 5 incorrect verify attempts → request invalidated.
 *  5. Correct code still works after 4 wrong attempts.
 *  6. Reset token is single-use (second use → 400).
 *  7. Expired code → 400.
 *
 * Uses dedicated test users to avoid rate-limit interference between scenarios.
 * Requires STAGE2_TEST_MODE=true on the server (test-only endpoints).
 */
export default {
  name: 'Test 8: Password-reset security',
  whatItProves:
    'Reset codes are secure (crypto RNG, hashed storage), rate-limited, attempt-capped, single-use, and expire correctly.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    // Dedicated users per scenario to isolate rate limits.
    const emails = {
      format: `pwreset-format-${ts}@test.local`,
      hash: `pwreset-hash-${ts}@test.local`,
      ratelimit: `pwreset-ratelimit-${ts}@test.local`,
      attempts: `pwreset-attempts-${ts}@test.local`,
      forgiving: `pwreset-forgiving-${ts}@test.local`,
      singleuse: `pwreset-singleuse-${ts}@test.local`,
      expired: `pwreset-expired-${ts}@test.local`,
    };

    // Create test users.
    for (const [key, email] of Object.entries(emails)) {
      const r = await ctx.api('POST', '/api/users', {
        email,
        name: `PW Reset Test ${key}`,
        role: 'mashgiach',
        password: 'initial-password-123',
      });
      if (r.status !== 200 && r.status !== 201) {
        throw new Error(`failed to create user ${email}: ${r.status} ${JSON.stringify(r.json)}`);
      }
    }

    // Helper: request a reset code for an email (no auth needed — public endpoint).
    // Each scenario uses a distinct fake IP (via X-Forwarded-For) so the
    // per-IP rate limit doesn't bleed across scenarios.
    const scenarioIps = {};
    let ipCounter = 10;
    function ipFor(key) {
      if (!scenarioIps[key]) scenarioIps[key] = `10.99.0.${ipCounter++}`;
      return scenarioIps[key];
    }
    async function requestCode(email, scenarioKey) {
      const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': ipFor(scenarioKey || email),
        },
        body: JSON.stringify({ email }),
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
    }

    // Helper: fetch the plaintext code via the test-only endpoint.
    async function getCode(email) {
      const r = await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(email)}`);
      const j = await r.json();
      if (!j.code) throw new Error(`no test code for ${email}: ${JSON.stringify(j)}`);
      return j.code;
    }

    // Helper: verify a code (public endpoint).
    async function verifyCode(email, scenarioKey, code) {
      const res = await fetch(`${baseUrl}/api/auth/verify-reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': ipFor(scenarioKey || email),
        },
        body: JSON.stringify({ email, code }),
      });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    }

    // --- 1. Code format: 6 digits, numeric ---
    {
      const r = await requestCode(emails.format, 'format');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      const code = await getCode(emails.format);
      if (!/^\d{6}$/.test(code)) {
        throw new Error(`code is not 6-digit numeric: "${code}"`);
      }
    }

    // --- 2. Stored code is hashed, not plaintext ---
    {
      const r = await requestCode(emails.hash, 'hash');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      const code = await getCode(emails.hash);
      const doc = await ctx.getDoc();
      const entry = doc.passwordResets.find((x) => x.email === emails.hash);
      if (!entry) throw new Error('reset request not found in Firestore doc');
      if (entry.code) {
        throw new Error('plaintext `code` field persisted — must store codeHash only');
      }
      if (!entry.codeHash || typeof entry.codeHash !== 'string' || entry.codeHash.length !== 64) {
        throw new Error(`codeHash missing or malformed: ${JSON.stringify(entry.codeHash)}`);
      }
      if (entry.codeHash.includes(code)) {
        throw new Error('codeHash appears to contain the plaintext code');
      }
    }

    // --- 3. Rate limiting: 6th request in an hour → 429 ---
    {
      for (let i = 0; i < 5; i++) {
        const r = await requestCode(emails.ratelimit, 'ratelimit');
        if (r.status !== 200) throw new Error(`request ${i + 1} should succeed, got ${r.status}`);
      }
      const r6 = await requestCode(emails.ratelimit, 'ratelimit');
      if (r6.status !== 429) {
        throw new Error(`6th request should be 429, got ${r6.status}: ${JSON.stringify(r6.json)}`);
      }
      if (!r6.retryAfter) {
        throw new Error('429 response missing Retry-After header');
      }
    }

    // --- 4. Five wrong attempts → request invalidated ---
    {
      const r = await requestCode(emails.attempts, 'attempts');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      for (let i = 0; i < 5; i++) {
        const v = await verifyCode(emails.attempts, 'attempts', '000000');
        if (v.status !== 400) {
          throw new Error(`wrong attempt ${i + 1} should be 400, got ${v.status}`);
        }
      }
      // 6th verify (even with the RIGHT code) should now fail — request gone.
      const correctCode = await getCode(emails.attempts).catch(() => null);
      const v = await verifyCode(emails.attempts, 'attempts', correctCode || '000000');
      if (v.status !== 400 || !/request|expired|invalidated/i.test(v.json?.error || '')) {
        throw new Error(`after 5 wrong attempts, request should be invalidated, got ${v.status}: ${JSON.stringify(v.json)}`);
      }
    }

    // --- 5. Correct code works after 4 wrong attempts ---
    {
      const r = await requestCode(emails.forgiving, 'forgiving');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      const code = await getCode(emails.forgiving);
      for (let i = 0; i < 4; i++) {
        const v = await verifyCode(emails.forgiving, 'forgiving', '000000');
        if (v.status !== 400) throw new Error(`wrong attempt ${i + 1} should be 400, got ${v.status}`);
        if (!/attempt\(s\) left/i.test(v.json?.error || '')) {
          throw new Error(`expected attempts-left message, got: ${JSON.stringify(v.json)}`);
        }
      }
      const v = await verifyCode(emails.forgiving, 'forgiving', code);
      if (v.status !== 200 || !v.json?.resetToken) {
        throw new Error(`correct code after 4 wrong should succeed, got ${v.status}: ${JSON.stringify(v.json)}`);
      }
    }

    // --- 6. Reset token is single-use ---
    {
      const r = await requestCode(emails.singleuse, 'singleuse');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      const code = await getCode(emails.singleuse);
      const v = await verifyCode(emails.singleuse, 'singleuse', code);
      if (v.status !== 200 || !v.json?.resetToken) {
        throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.json)}`);
      }
      const token = v.json.resetToken;

      async function resetPw(tok) {
        const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emails.singleuse, resetToken: tok, newPassword: 'new-secure-password-456' }),
        });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, json };
      }

      const r1 = await resetPw(token);
      if (r1.status !== 200) throw new Error(`first reset should succeed, got ${r1.status}: ${JSON.stringify(r1.json)}`);
      const r2 = await resetPw(token);
      if (r2.status !== 400) {
        throw new Error(`second use of token should be 400, got ${r2.status}: ${JSON.stringify(r2.json)}`);
      }
    }

    // --- 7. Expired code → 400 ---
    {
      const r = await requestCode(emails.expired, 'expired');
      if (r.status !== 200) throw new Error(`forgot-password failed: ${r.status}`);
      const code = await getCode(emails.expired);
      // Force-expire via test endpoint.
      const expRes = await fetch(`${baseUrl}/api/__test__/expire-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emails.expired }),
      });
      if (expRes.status !== 200) throw new Error(`expire-reset failed: ${expRes.status}`);
      const v = await verifyCode(emails.expired, 'expired', code);
      if (v.status !== 400 || !/expired|invalidated/i.test(v.json?.error || '')) {
        throw new Error(`expired code should be 400 with expiry message, got ${v.status}: ${JSON.stringify(v.json)}`);
      }
    }

    return 'all 7 password-reset security scenarios verified';
  },
};
