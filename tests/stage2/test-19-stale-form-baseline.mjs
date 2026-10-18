/**
 * Test 19: Stale-form baseline regression (round 5).
 *
 * The bug: apiWrite() auto-injected the highest document version the browser
 * had observed (via X-State-Version headers / WebSocket). But an OPEN FORM
 * may render older data — user A opens the notes editor at v1, a WebSocket
 * update bumps the browser's tracked version to v2, and A's save went out
 * with expectedVersion=v2, SILENTLY overwriting user B's v2 change with A's
 * stale v1-based text.
 *
 * The fix: forms capture their write baseline when they LOAD/OPEN
 * (captureEditBaseline() in src/lib/api.ts — the version the form rendered
 * from), and the save carries THAT version, never the later-heard one.
 *
 * Method (faithful to the real flow, no hard-coded versions):
 *   1. Create a task. User A "opens the form": GET the task and capture the
 *      X-State-Version response header — this is the actual form-baseline
 *      mechanism (same header the form code reads).
 *   2. User B updates the notes with expectedVersion=<baseline> → 200.
 *      Document is now at v2.
 *   3. A's browser receives the v2 WebSocket broadcast (real WS client —
 *      proves the browser *heard* v2 while the form still shows v1 data).
 *   4. A "saves the stale form": PUT with A's stale notes and
 *      expectedVersion=<form baseline v1> → MUST be 409 VERSION_CONFLICT.
 *      B's work must be intact.
 *   5. Control: on a second task, demonstrate that sending the LATEST-heard
 *      version (v2 — what the old auto-inject did) with stale data SUCCEEDS
 *      and silently overwrites. This proves the test actually guards the
 *      regression: under the old client behavior the overwrite happens.
 */

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WS error: ${e?.message || 'unknown'}`));
    };
  });
}

/** Wait until a WS message with version >= target appears. */
function waitForVersion(messages, target, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const hit = messages.find((m) => typeof m.version === 'number' && m.version >= target);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        const seen = messages.map((m) => `${m.type}:v${m.version}`).join(', ');
        return reject(new Error(`timed out waiting for WS version >= ${target}; seen: ${seen || '(none)'}`));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

export default {
  name: 'Test 19: Stale-form baseline (no silent overwrite)',
  whatItProves:
    'A save carrying the version the FORM rendered from (not the latest version heard over WebSocket) is rejected with 409 when stale — B\'s work is never silently overwritten.',

  async run(baseUrl, ctx) {
    const ts = Date.now();

    // --- 1. Canary task ---
    const cr = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test19 Notes ${ts}`,
      notes: 'original notes',
      createdByEmail: ADMIN_EMAIL,
    });
    if (cr.status !== 201 && cr.status !== 200) throw new Error(`canary create failed: ${cr.status}`);
    const taskId = (cr.json.task || cr.json).id;

    // --- 2. A's browser session: setup (post-test-18 restore) + login + WS.
    // NOTE: test 18 (restore cycle) runs before this test and strips
    // passwords — re-establish via setup, mirroring the real post-restore
    // flow and the harness startup. This MUST happen before capturing the
    // form baseline: setup is a version-bumping write.
    await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, newPassword: 'stage2-test-password' }),
    });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'stage2-test-password' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.token) throw new Error('admin login failed');
    const connA = await connectWs(baseUrl, loginJson.token);
    connA.messages.length = 0;

    // --- 3. User A "opens the form": GET the task list and capture the
    // X-State-Version header — the ACTUAL form-baseline mechanism, not a
    // hard-coded version. This is what captureEditBaseline() snapshots. ---
    const formLoad = await fetch(`${baseUrl}/api/tasks`, { headers: ctx.authHeaders });
    if (formLoad.status !== 200) throw new Error(`form-load GET failed: ${formLoad.status}`);
    const formBaselineHeader = formLoad.headers.get('X-State-Version');
    const formBaseline = formBaselineHeader === null ? undefined : Number(formBaselineHeader);
    if (!Number.isFinite(formBaseline)) {
      throw new Error(`form load did not carry X-State-Version: ${formBaselineHeader}`);
    }
    // Sanity: the header must match the document version.
    const docV = await ctx.getVersion();
    if (formBaseline !== docV) throw new Error(`header v${formBaseline} != doc v${docV}`);

    // --- 4. User B changes the notes (fresh baseline → 200). Doc moves on. ---
    const bText = `B's update ${ts}`;
    const bRes = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      notes: bText,
      userEmail: ADMIN_EMAIL,
      expectedVersion: formBaseline,
    });
    if (bRes.status !== 200) throw new Error(`B's write failed: ${bRes.status} ${JSON.stringify(bRes.json)}`);
    const v2 = await ctx.getVersion();
    if (v2 === formBaseline) throw new Error('version did not advance after B\'s write');

    // --- 5. A's browser HEARS v2 over WebSocket (but the open form still
    // shows v1 data — the form baseline does NOT move). ---
    await waitForVersion(connA.messages, v2);
    try { connA.ws.close(); } catch {}

    // --- 6. A "saves the stale form": stale notes + FORM baseline (v1).
    // MUST be rejected — 409 VERSION_CONFLICT. ---
    const staleSave = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      notes: `A's stale edit ${ts}`,
      userEmail: ADMIN_EMAIL,
      expectedVersion: formBaseline, // <-- the form's baseline, not the heard v2
    });
    if (staleSave.status !== 409) {
      throw new Error(
        `STALE FORM SAVE NOT REJECTED: got ${staleSave.status} (expected 409). ` +
        `A's stale write would have silently overwritten B. body=${JSON.stringify(staleSave.json)}`
      );
    }

    // --- 7. B's work must be intact. ---
    const after = await ctx.api('GET', `/api/tasks`);
    if (after.status !== 200) throw new Error(`verify GET failed: ${after.status}`);
    const taskAfter = (after.json.tasks || after.json).find((t) => t.id === taskId);
    const notesAfter = taskAfter ? taskAfter.notes : undefined;
    if (notesAfter !== bText) {
      throw new Error(`B's notes corrupted: expected "${bText}", found "${notesAfter}"`);
    }

    // --- 8. Control: prove the OLD client behavior (send latest-heard v2
    // with stale data) WOULD silently overwrite — i.e. this test guards a
    // real regression, not a tautology. Separate task so B's data stays clean. ---
    const cr2 = await ctx.api('POST', '/api/tasks', {
      venueId: 'venue-crown-market',
      title: `Test19 Control ${ts}`,
      notes: 'control original',
      createdByEmail: ADMIN_EMAIL,
    });
    const controlId = (cr2.json.task || cr2.json).id;
    const cv1 = await ctx.getVersion();
    await ctx.api('PUT', `/api/tasks/${controlId}`, {
      notes: `control B ${ts}`, userEmail: ADMIN_EMAIL, expectedVersion: cv1,
    });
    const cv2 = await ctx.getVersion();
    // Old behavior: browser heard cv2, auto-injected it, stale data sails through.
    const oldBehavior = await ctx.api('PUT', `/api/tasks/${controlId}`, {
      notes: `control STALE overwrite ${ts}`, userEmail: ADMIN_EMAIL, expectedVersion: cv2,
    });
    if (oldBehavior.status !== 200) {
      throw new Error(`control unexpected: old-behavior write got ${oldBehavior.status}, expected 200 (silent overwrite)`);
    }
    const ctrlAfter = await ctx.api('GET', '/api/tasks');
    const ctrlTask = (ctrlAfter.json.tasks || ctrlAfter.json).find((t) => t.id === controlId);
    const overwritten = ctrlTask && ctrlTask.notes === `control STALE overwrite ${ts}`;
    if (!overwritten) throw new Error('control did not demonstrate the overwrite');

    // --- Cleanup ---
    for (const id of [taskId, controlId]) {
      const v = await ctx.getVersion();
      await ctx.api('DELETE', `/api/tasks/${id}`, { expectedVersion: v });
    }

    return (
      `stale form save (baseline v${formBaseline}) → 409, B's notes intact; ` +
      `control confirmed old behavior (send heard v${cv2}) would silently overwrite`
    );
  },
};
