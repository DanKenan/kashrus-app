/**
 * Test 42 (8i): platform-wide routes are the pinned platform operator's only;
 * restore-demo is retired; public first-run setup is closed.
 *
 * Before 8i any agency admin — including a freshly SELF-REGISTERED agency's
 * admin (registration is public) — could run platform jobs, read
 * cross-agency migration status, page Don with test alerts, wipe their own
 * agency through restore-demo (which also re-created the seed admin with an
 * empty password), and the public setup route set a password on any admin
 * without one.
 * Proves:
 *  1 each platform route → 403 for: agency B's admin, a self-registered
 *    agency's admin, a second home-agency admin, a home-agency coordinator;
 *    a kiosk-claimed token of the pinned account is refused too (401/403);
 *    none of these calls writes (app-state _v unchanged) or produces output.
 *  2 the pinned operator (usr_admin) passes the gate on every route (not 403).
 *  3 operator authority is decided on the CURRENT stored record: the same
 *    usr_admin token is refused once a home admin demotes the account, and
 *    works again when the role is restored.
 *  4 restore-demo → 410 for every caller, no write, no user created.
 *  5 auth/setup → 403 for a passwordless admin (the post-restore state) and
 *    for the seed admin's email — the chain "another agency's admin calls
 *    restore-demo, then setup claims usr_admin" fails at both steps; the
 *    passwordless admin stays passwordless, usr_admin's hash is unchanged.
 */
const B = 'agency-test42-b';
const OPERATOR = 'usr_admin';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

const ROUTES = [
  ['GET', '/api/admin/per-entity-status'],
  ['POST', '/api/admin/migrate-copy'],
  ['POST', '/api/internal/consistency-check'],
  ['POST', '/api/media/sweep'],
  ['POST', '/api/internal/test-alert'],
  ['GET', '/api/media/check-indexes'],
];

async function call(baseUrl, method, path, headers, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

export default {
  name: 'Test 42: platform routes = pinned operator only; restore-demo retired; public setup closed (8i)',
  whatItProves:
    "Platform-wide routes refuse every agency admin (incl. a self-registered one), other home-agency staff and kiosk sessions, decided on the current stored record; restore-demo writes nothing and creates no user; public setup cannot claim any account.",

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vB = `venue-t42b-${ts}`;
    const ids = {
      adminB: `user-t42-adminb-${ts}`, hkc2: `user-t42-hkc2-${ts}`, coordH: `user-t42-coordh-${ts}`,
      bare: `user-t42-bare-${ts}`,
    };
    const bareEmail = `bare42-${ts}@hkc.test`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: B, name: `T42 Agency B ${ts}`, shortCode: 'T4B' }],
      venues: [{ id: vB, name: `T42 Venue B ${ts}`, agencyId: B }],
      users: [
        { id: ids.adminB, email: `adminb42-${ts}@b.test`, name: 'T42 Admin B', role: 'admin', agencyId: B },
        { id: ids.hkc2, email: `hkc2-42-${ts}@hkc.test`, name: 'T42 HKC admin 2', role: 'admin', agencyId: 'agency-hkc' },
        { id: ids.coordH, email: `coord42-${ts}@hkc.test`, name: 'T42 HKC coord', role: 'coordinator', agencyId: 'agency-hkc' },
        // The post-restore shape: an admin with NO password.
        { id: ids.bare, email: bareEmail, name: 'T42 passwordless admin', role: 'admin', agencyId: 'agency-hkc' },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);

    const reg = await fetch(`${baseUrl}/api/agencies/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agencyName: `T42 Intruder ${ts}`, adminName: 'Intruder', adminEmail: `intruder42-${ts}@evil.test`, adminPassword: 'intruder-pass-123', initialVenueName: 'Intruder Kitchen' }),
    });
    const regJson = await reg.json().catch(() => ({}));
    assert(reg.status === 201 && regJson.token, `register: ${reg.status}`);

    const op = auth(await mintToken(baseUrl, OPERATOR));
    const callers = {
      'agency B admin': auth(await mintToken(baseUrl, ids.adminB)),
      'self-registered admin': auth(regJson.token),
      'second home admin': auth(await mintToken(baseUrl, ids.hkc2)),
      'home coordinator': auth(await mintToken(baseUrl, ids.coordH)),
    };
    // A kiosk-claimed token naming the pinned account.
    const kt = await fetch(`${baseUrl}/api/__test__/mint-kiosk-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: OPERATOR, agencyId: 'agency-hkc', venueId: vB }),
    });
    const kioskToken = kt.status === 200 ? (await kt.json()).token : null;

    // 1. Everyone but the operator → 403 (kiosk: 401/403), no writes.
    const v0 = await ctx.getVersion();
    for (const [method, path] of ROUTES) {
      for (const [who, headers] of Object.entries(callers)) {
        const r = await call(baseUrl, method, path, headers, path.endsWith('test-alert') ? { mode: 'demo' } : {});
        assert(r.status === 403, `${who} ${method} ${path} must be 403, got ${r.status}`);
        assert(!r.json?.sentAt && !r.json?.summary && !r.json?.runId && !r.json?.ok, `${who} ${path}: no output on refusal`);
      }
      if (kioskToken) {
        const r = await call(baseUrl, method, path, auth(kioskToken), {});
        assert(r.status === 401 || r.status === 403, `kiosk token of the operator ${method} ${path} must be refused, got ${r.status}`);
      }
    }
    assert((await ctx.getVersion()) === v0, 'refused platform calls must not write');

    // 2. The operator passes the gate on every route (the jobs themselves may
    //    answer 5xx/503 where storage is not configured in the test env).
    for (const [method, path] of ROUTES) {
      const r = await call(baseUrl, method, path, op, path.endsWith('test-alert') ? { mode: 'demo' } : {});
      assert(r.status !== 403 && r.status !== 401, `operator ${method} ${path} must pass the gate, got ${r.status}`);
    }

    // 3. Decided on the CURRENT stored record: a home-agency admin demotes the
    //    operator's account through the normal API; the SAME token is refused
    //    on its next request, and accepted again after the role is restored.
    const doc0 = await ctx.getDoc();
    const opRec0 = (doc0.users || []).find((u) => u.id === OPERATOR);
    assert(opRec0 && /^\$2[aby]\$/.test(opRec0.password || ''), 'operator has a stored bcrypt hash (precondition)');
    const hkc2 = callers['second home admin'];
    const setRole = async (role) => {
      const r = await fetch(`${baseUrl}/api/users/${OPERATOR}`, {
        method: 'PUT', headers: hkc2, body: JSON.stringify({ role, expectedVersion: await ctx.getVersion() }),
      });
      return r.status;
    };
    let demoted = false;
    try {
      const st = await setRole('coordinator');
      assert(st === 200, `demote operator via PUT /api/users: ${st}`);
      demoted = true;
      const r = await call(baseUrl, 'GET', '/api/admin/per-entity-status', op);
      assert(r.status === 403, `same operator token must be refused once the stored record is demoted, got ${r.status}`);
    } finally {
      if (demoted) {
        const st2 = await setRole('admin');
        assert(st2 === 200, `restore operator role: ${st2}`);
      }
    }
    {
      const r = await call(baseUrl, 'GET', '/api/admin/per-entity-status', op);
      assert(r.status !== 403 && r.status !== 401, `operator authority returns with the restored record, got ${r.status}`);
    }

    // 4. restore-demo → 410 for everyone, no write, no user created.
    const v1 = await ctx.getVersion();
    const users1 = ((await ctx.getDoc()).users || []).length;
    for (const [who, headers] of [...Object.entries(callers), ['operator', op]]) {
      const r = await call(baseUrl, 'POST', '/api/admin/restore-demo', headers, {});
      assert(r.status === 410, `${who} restore-demo must be 410, got ${r.status}`);
    }
    const doc2 = await ctx.getDoc();
    assert((await ctx.getVersion()) === v1, 'restore-demo must not write');
    assert((doc2.users || []).length === users1, 'restore-demo must not create users');

    // 5. Public setup cannot claim anything — THE CHAIN ends here.
    const hash0 = ((doc2.users || []).find((u) => u.id === OPERATOR) || {}).password;
    for (const email of [bareEmail, 'kenan@hartfordkashrut.org']) {
      const r = await fetch(`${baseUrl}/api/auth/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, newPassword: 'attacker-pass-123' }),
      });
      const j = await r.json().catch(() => ({}));
      assert(r.status === 403 && !j.token, `setup for ${email} must be 403 with no token, got ${r.status}`);
    }
    const doc3 = await ctx.getDoc();
    const bare3 = (doc3.users || []).find((u) => u.id === ids.bare);
    assert(bare3 && !bare3.password, 'the passwordless admin stays passwordless');
    assert(((doc3.users || []).find((u) => u.id === OPERATOR) || {}).password === hash0, "the operator's hash is unchanged");
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: bareEmail, password: 'attacker-pass-123' }),
    });
    const loginJson = await login.json().catch(() => ({}));
    assert(!loginJson.token && loginJson.success !== true, `no session with the attacker password (got ${login.status} ${JSON.stringify(loginJson).slice(0, 80)})`);

    // 6. Clean-slate mode keeps working after restore-demo's retirement.
    //    restore-demo used to be the only thing that turned the app-wide
    //    isDemoCleared flag back off; any agency's clean-slate turns it on.
    //    Hydration's clean-slate branch must still normalise users (the
    //    in-transaction "access changed" check compares normalised records)
    //    and load event task templates.
    const vH = `venue-t42h-${ts}`;
    const mashH = `user-t42-mashh-${ts}`;
    const evtH = `evt-t42h-${ts}`;
    const etplH = `etpl-t42h-${ts}`;
    const cs = await fetch(`${baseUrl}/api/admin/clean-slate`, { method: 'POST', headers: callers['agency B admin'], body: JSON.stringify({}) });
    assert(cs.status === 200, `agency B clean-slate: ${cs.status}`);
    const inj6 = await ctx.api('POST', '/api/__test__/inject-fixture', {
      venues: [{ id: vH, name: `T42 Venue H ${ts}`, agencyId: 'agency-hkc' }],
      // A stored record without permissions (legacy shape) — hydration must normalise it.
      users: [{ id: mashH, email: `mashh42-${ts}@hkc.test`, name: 'T42 HKC mash', role: 'mashgiach', agencyId: 'agency-hkc', venueId: vH }],
      events: [{ id: evtH, agencyId: 'agency-hkc', venueId: vH, title: `T42 Event ${ts}`, location: 'Hall', date: '2026-11-02', tasks: [] }],
      eventTaskTemplates: [{ id: etplH, agencyId: 'agency-hkc', title: `T42 ETpl ${ts}`, sortOrder: 0 }],
    });
    assert(inj6.status === 200, `inject-fixture (6): ${inj6.status}`);
    assert((await ctx.getDoc()).isDemoCleared === true, 'precondition: clean-slate mode is on');
    {
      const r = await call(baseUrl, 'GET', '/api/event-task-templates', op);
      assert(r.status === 200 && (r.json?.templates || []).some((t) => t.id === etplH), `clean-slate mode: own event task template must be listed (got ${r.status})`);
    }
    {
      const tM = auth(await mintToken(baseUrl, mashH));
      const er = await call(baseUrl, 'GET', '/api/events', tM);
      const ev = (er.json?.events || []).find((e) => e.id === evtH);
      assert(ev, 'clean-slate mode: the mashgiach can read the venue event');
      const body = { ...ev, tasks: [...(ev.tasks || []), { id: `etask-t42h-${ts}`, title: `Added ${ts}`, isCompleted: false }], expectedVersion: await ctx.getVersion(), operationId: `op-t42h-${ts}` };
      const pr = await call(baseUrl, 'PUT', `/api/events/${evtH}`, tM, body);
      assert(pr.status === 200, `clean-slate mode: mashgiach tasks-only event save must be 200, got ${pr.status} ${JSON.stringify(pr.json).slice(0, 120)}`);
    }

    return `platform routes: 4 non-operator callers ×${ROUTES.length} routes → 403 (kiosk token refused${kioskToken ? '' : ': not minted'}), no writes; operator passes the gate; demoted stored record refuses the same token, restore re-allows; restore-demo 410 for all, no write/user; public setup 403 for the passwordless admin and the seed admin, nothing changed; clean-slate mode: templates listed, legacy-shape mashgiach event save 200`;
  },
};
