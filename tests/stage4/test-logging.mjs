/**
 * Stage 4 PR L: structured logging tests.
 *
 * Proves: on Cloud Run (K_SERVICE set) log.error() writes EXACTLY ONE line of
 * JSON to stderr that parses to severity "ERROR", keeps the alert message
 * prefix verbatim, and carries the Error's message+stack in a structured
 * `error` field (JSON.stringify(new Error()) is {} — so this must be explicit).
 * Locally (no K_SERVICE) the same call stays plain human-readable console
 * output, not JSON.
 */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function captureWrites(fn) {
  const out = { stdout: [], stderr: [] };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { out.stderr.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return out;
}

const testLogging = {
  name: 'structured-logging',
  whatItProves:
    'log.error on Cloud Run emits one JSON line with real severity ERROR, ' +
    'verbatim alert prefix, and error.message+stack; locally it stays plain text',

  async run() {
    // --- Case 1: Cloud Run (K_SERVICE set) -> structured JSON on stderr ---
    process.env.K_SERVICE = 'test-service';
    const { log } = await import('../../src/server/log.ts?gcp=1');

    const out = await captureWrites(() => {
      log.error('[alert-test] x', new Error('boom'));
    });
    assert(out.stderr.length === 1, `expected exactly 1 stderr write, got ${out.stderr.length}`);
    assert(out.stdout.length === 0, `expected 0 stdout writes, got ${out.stdout.length}`);
    const line = out.stderr[0].trim();
    assert(!line.includes('\n'), 'log call must write exactly one line');
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`stderr line is not valid JSON: ${line.slice(0, 120)}`);
    }
    assert(entry.severity === 'ERROR', `severity should be "ERROR", got ${JSON.stringify(entry.severity)}`);
    assert(
      typeof entry.message === 'string' && entry.message.startsWith('[alert-test] x'),
      `message must keep the alert prefix verbatim, got ${JSON.stringify(entry.message)}`
    );
    assert(entry.component === 'shutfey-server', 'component field must be present');
    assert(
      entry.error && typeof entry.error.message === 'string' && entry.error.message === 'boom',
      'error.message must be present (Error objects must not be dropped)'
    );
    assert(
      typeof entry.error.stack === 'string' && entry.error.stack.includes('boom'),
      'error.stack must be present'
    );

    // warn() -> WARNING severity on stdout (not stderr)
    const out2 = await captureWrites(() => {
      log.warn('[consistency] WARNING: w', { attempt: 2 });
    });
    assert(out2.stdout.length === 1, `warn: expected 1 stdout write, got ${out2.stdout.length}`);
    assert(out2.stderr.length === 0, `warn: expected 0 stderr writes, got ${out2.stderr.length}`);
    const e2 = JSON.parse(out2.stdout[0]);
    assert(e2.severity === 'WARNING', `warn severity should be "WARNING", got ${JSON.stringify(e2.severity)}`);
    assert(
      e2.message.includes('[consistency] WARNING: w') && e2.message.includes('"attempt":2'),
      `warn message must fold extra args in, got ${JSON.stringify(e2.message)}`
    );
    assert(!('error' in e2), 'no error field when no Error argument is passed');

    // Sensitive keys in object args are redacted, never dumped (nested too)
    const out3 = await captureWrites(() => {
      log.error('[x] context', {
        apiToken: 'abc123',
        attempt: 2,
        nested: { resetPepper: 'pepper-secret', vapidKeys: { public: 'pub', private: 'priv' } },
      });
    });
    const e3 = JSON.parse(out3.stderr[0]);
    assert(
      e3.message.includes('[redacted]') && !e3.message.includes('abc123'),
      `sensitive values must be redacted, got ${JSON.stringify(e3.message)}`
    );
    assert(!e3.message.includes('pepper-secret'), 'nested resetPepper must be redacted');
    assert(!e3.message.includes('"private":"priv"'), 'nested vapid private key must be redacted');
    assert(e3.message.includes('"attempt":2'), 'non-sensitive fields must survive redaction');

    // Raw strings carrying credential shapes are scrubbed
    const out4 = await captureWrites(() => {
      log.error('[x] auth failed', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    });
    const e4 = JSON.parse(out4.stderr[0]);
    assert(
      !e4.message.includes('Bearer eyJ') && e4.message.includes('[redacted]'),
      `Bearer token in raw string must be scrubbed, got ${JSON.stringify(e4.message)}`
    );

    // Error stacks carrying credential shapes are scrubbed (message+stack kept)
    const errWithSecret = new Error('connect failed: password=hunter2');
    errWithSecret.stack = 'Error: connect failed: password=hunter2\n    at https://example.com/?apiKey=sekret123';
    const out5 = await captureWrites(() => {
      log.error('[x] boom', errWithSecret);
    });
    const e5 = JSON.parse(out5.stderr[0]);
    assert(
      !e5.error.message.includes('hunter2') && e5.error.message.includes('[redacted]'),
      `error.message must be scrubbed, got ${JSON.stringify(e5.error.message)}`
    );
    assert(
      !e5.error.stack.includes('sekret123') && e5.error.stack.includes('[redacted]'),
      `error.stack must be scrubbed, got ${JSON.stringify(e5.error.stack).slice(0, 120)}`
    );
    assert(
      e5.error.stack.includes('Error: connect failed'),
      'scrubbed stack must keep the useful frame text'
    );

    // scrubText coverage matches SENSITIVE_KEY: session/cookie/PIN/JWT/
    // verification-code assignments and Basic auth in free text
    const out6 = await captureWrites(() => {
      log.error(
        '[x] session',
        'sessionId=example123 cookie: example123 pin=1234 verificationCode: 123456 ' +
          'Authorization: Basic Zm9vOmJhcg== token=shh'
      );
    });
    const e6 = JSON.parse(out6.stderr[0]);
    for (const secret of ['example123', '1234', '123456', 'Zm9vOmJhcg==', 'shh']) {
      assert(
        !e6.message.includes(secret),
        `free-text secret must be scrubbed, found "${secret}" in ${JSON.stringify(e6.message)}`
      );
    }
    assert(
      (e6.message.match(/\[redacted\]/g) || []).length >= 5,
      `expected >=5 redactions, got ${JSON.stringify(e6.message)}`
    );

    // Quoted credential values are redacted (single, double, JSON-style)
    const out7 = await captureWrites(() => {
      log.error(
        '[x] quoted',
        'password: "example123" jwtSecret="example123" {"apiKey":\'example123\'}'
      );
    });
    const e7 = JSON.parse(out7.stderr[0]);
    assert(
      !e7.message.includes('example123'),
      `quoted secrets must be redacted, got ${JSON.stringify(e7.message)}`
    );
    assert(
      (e7.message.match(/\[redacted\]/g) || []).length === 3,
      `expected 3 redactions, got ${JSON.stringify(e7.message)}`
    );

    // The four alert prefixes must survive scrubText byte-for-byte
    for (const prefix of [
      '[alert-test] TEST ALERT',
      '[consistency] ERROR',
      '[commitOrRespond:save-task]',
      '[getJwtSecret] Persist failed',
    ]) {
      const outP = await captureWrites(() => {
        log.error(`${prefix} details here`);
      });
      const eP = JSON.parse(outP.stderr[0]);
      assert(
        eP.message.startsWith(prefix),
        `prefix must survive scrubbing: ${JSON.stringify(prefix)} got ${JSON.stringify(eP.message)}`
      );
    }

    // --- Case 1b: Cloud Run JOB (CLOUD_RUN_JOB only, no K_SERVICE) ---
    // Jobs don't set K_SERVICE — the logger must still emit structured JSON.
    delete process.env.K_SERVICE;
    process.env.CLOUD_RUN_JOB = 'shutfey-backup-tier1';
    const { log: jobLog } = await import('../../src/server/log.ts?job=1');
    const outJob = await captureWrites(() => {
      jobLog.error('[backup-job] FAILED: boom');
    });
    assert(outJob.stderr.length === 1, `job: expected 1 stderr write, got ${outJob.stderr.length}`);
    const eJob = JSON.parse(outJob.stderr[0]);
    assert(eJob.severity === 'ERROR', `job: severity should be "ERROR", got ${JSON.stringify(eJob.severity)}`);
    assert(
      eJob.message.startsWith('[backup-job] FAILED: boom'),
      `job: message must be structured, got ${JSON.stringify(eJob.message)}`
    );
    delete process.env.CLOUD_RUN_JOB;

    // --- Case 2: local (no K_SERVICE/CLOUD_RUN_JOB) -> plain text ---
    delete process.env.K_SERVICE;
    delete process.env.CLOUD_RUN_JOB;
    const localMod = await import('../../src/server/log.ts?local=1');
    const seen = [];
    const origConsoleError = console.error;
    console.error = (...a) => { seen.push(a); };
    try {
      localMod.log.error('[alert-test] y', new Error('boom'));
    } finally {
      console.error = origConsoleError;
    }
    assert(seen.length === 1, `local: expected 1 console.error call, got ${seen.length}`);
    assert(
      typeof seen[0][0] === 'string' && seen[0][0].startsWith('[alert-test] y'),
      'local: first arg must stay the plain prefix string'
    );
    let parsed = null;
    try {
      parsed = JSON.parse(seen[0][0]);
    } catch {
      /* expected: plain text, not JSON */
    }
    assert(parsed === null, 'local: output must be plain text, not JSON');
  },
};

export default testLogging;
