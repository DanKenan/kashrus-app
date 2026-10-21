/**
 * Test 41 (8h): the admin export is scoped to the caller's agency.
 *
 * Before 8h, GET /api/admin/export returned stateSnapshot() — every agency's
 * data plus the reset pepper, push subscriptions and Airtable API keys — to
 * an admin of ANY agency, and agency registration is public.
 * Proves:
 *  1 an admin of agency B gets exportScope 'agency' and ONLY B's records:
 *    no record of A or of the home agency, none of their ids, names, emails
 *    or titles anywhere in the file (string search over the whole body).
 *  2 the public attack path: a freshly REGISTERED agency's admin exports only
 *    its own agency (not one HKC / A / B string in the body).
 *  3 a non-primary admin of the home agency gets only the home agency.
 *  4 NO cross-agency export for anyone: the home agency's primary admin
 *    (Don) gets the home agency only (whole-database DR = Tier-1 backup job).
 *  5 NO export carries secret material: no jwtSecret, vapidKeys, resetPepper,
 *    passwordResets, passwordResetRateLimits, pushSubscriptions,
 *    kioskPinLockouts, kioskPairings, kioskPairingLimits keys; no user
 *    password / passwordHash / kioskPin / kioskPinHash; Airtable configs
 *    without apiKey (hasApiKey true), and the API key VALUE appears nowhere.
 *  6 coordinator and mashgiach → 403 (positive twin: their admin → 200).
 */
const A = 'agency-test41x-a';
const B = 'agency-test41x-b';
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const SECRET_KEYS = ['jwtSecret', 'vapidKeys', 'resetPepper', 'passwordResets', 'passwordResetRateLimits', 'pushSubscriptions', 'kioskPinLockouts', 'kioskPairings', 'kioskPairingLimits'];

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

async function exportAs(baseUrl, headers) {
  const res = await fetch(`${baseUrl}/api/admin/export`, { headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function checkNoSecrets(label, exp, apiKeyValue) {
  for (const k of SECRET_KEYS) assert(!(k in exp.json), `${label}: export must not carry ${k}`);
  for (const u of exp.json.users || []) {
    for (const k of ['password', 'passwordHash', 'kioskPin', 'kioskPinHash']) {
      assert(!(k in u), `${label}: user ${u.id} carries ${k}`);
    }
  }
  for (const c of exp.json.airtableConfigs || []) {
    assert(!('apiKey' in c), `${label}: airtable config ${c.id} carries apiKey`);
  }
  for (const d of exp.json.kioskDevices || []) {
    assert(!d.secretHash, `${label}: kiosk device ${d.id} carries secretHash`);
  }
  assert(!exp.text.includes(apiKeyValue), `${label}: the Airtable key value leaked`);
  assert(!/LEAK-(NESTED|FUTURE)-/.test(exp.text), `${label}: a nested or future secret-looking field leaked`);
  assert(!/\$2[aby]\$/.test(exp.text), `${label}: a bcrypt hash leaked`);
}

export default {
  name: 'Test 41: admin export is scoped to the caller agency, secret-free (8h)',
  whatItProves:
    "Every admin (including a freshly self-registered agency's admin and the home agency's primary admin) exports only their own agency's data, by verified ownership; no export carries secrets or credential material, nested or future-named.",

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA = `venue-t41xa-${ts}`;
    const vB = `venue-t41xb-${ts}`;
    const vH = `venue-t41xh-${ts}`; // a home-agency venue of this test's own (no dependence on earlier tests)
    const ids = {
      adminA: `user-t41x-admina-${ts}`, adminB: `user-t41x-adminb-${ts}`,
      coordB: `user-t41x-coordb-${ts}`, mashB: `user-t41x-mashb-${ts}`,
      hkcAdmin2: `user-t41x-hkc2-${ts}`,
    };
    const marks = {
      aTask: `T41X-A-SECRET-TASK-${ts}`, aName: `T41X Alice A ${ts}`, aEmail: `alice41x-${ts}@a.test`,
      bTask: `T41X-B-TASK-${ts}`, hkcTask: `T41X-HKC-TASK-${ts}`,
    };
    const apiKeyValue = `patT41XSECRET${ts}`;

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T41X Agency A ${ts}`, shortCode: 'TXA', adminEmail: marks.aEmail },
        { id: B, name: `T41X Agency B ${ts}`, shortCode: 'TXB', adminEmail: `bob41x-${ts}@b.test` },
      ],
      venues: [
        { id: vA, name: `T41X Venue A ${ts}`, agencyId: A },
        { id: vB, name: `T41X Venue B ${ts}`, agencyId: B },
        { id: vH, name: `T41X Venue HKC ${ts}`, agencyId: 'agency-hkc' },
      ],
      users: [
        { id: ids.adminA, email: marks.aEmail, name: marks.aName, role: 'admin', agencyId: A, phoneNumber: '+18605550141', password: '$2a$10$abcdefghijklmnopqrstuuJ2ZbYh0G2b3d4e5f6g7h8i9j0k1l2m3' },
        { id: ids.adminB, email: `bob41x-${ts}@b.test`, name: `T41X Bob B ${ts}`, role: 'admin', agencyId: B, emailVerificationToken: `LEAK-FUTURE-${ts}` },
        { id: ids.coordB, email: `carol41x-${ts}@b.test`, name: 'T41X Coord B', role: 'coordinator', agencyId: B, venueId: vB },
        { id: ids.mashB, email: `dan41x-${ts}@b.test`, name: 'T41X Mash B', role: 'mashgiach', agencyId: B, venueId: vB },
        { id: ids.hkcAdmin2, email: `hkc2-41x-${ts}@hkc.test`, name: 'T41X HKC second admin', role: 'admin', agencyId: 'agency-hkc' },
      ],
      tasks: [
        { id: `task-t41xa-${ts}`, title: marks.aTask, venueId: vA, agencyId: A, status: 'pending' },
        { id: `task-t41xb-${ts}`, title: marks.bTask, venueId: vB, agencyId: B, status: 'pending', extra: [{ clientSecret: `LEAK-NESTED-${ts}`, note: 'kept' }] },
        // Orphan: no agencyId and a venue that does not exist. (A record with NO
        // owner fields at all is normalised to the home agency + its default venue
        // when the server hydrates from Firestore — the app-wide legacy rule — so
        // the fail-closed case worth proving end to end is the unknown venue.)
        { id: `task-t41xo-${ts}`, title: `T41X-ORPHAN-${ts}`, venueId: `venue-t41x-ghost-${ts}`, status: 'pending' },
        { id: `task-t41xm-${ts}`, title: `T41X-MISMATCH-${ts}`, agencyId: B, venueId: vA, status: 'pending' },
        { id: `task-t41xh-${ts}`, title: marks.hkcTask, venueId: vH, agencyId: 'agency-hkc', status: 'pending' },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);

    const tok = {
      adminA: await mintToken(baseUrl, ids.adminA), adminB: await mintToken(baseUrl, ids.adminB),
      coordB: await mintToken(baseUrl, ids.coordB), mashB: await mintToken(baseUrl, ids.mashB),
      hkc2: await mintToken(baseUrl, ids.hkcAdmin2),
    };
    // Agency A stores an Airtable key (real admin API) so the strip check is not vacuous.
    const cfg = await fetch(`${baseUrl}/api/airtable/config`, {
      method: 'POST', headers: auth(tok.adminA),
      body: JSON.stringify({ apiKey: apiKeyValue, baseId: `app${ts}`, tableName: 'Approved Ingredients', expectedVersion: await ctx.getVersion() }),
    });
    assert(cfg.status === 200 || cfg.status === 201, `airtable config: ${cfg.status}`);

    // 1. admin of B → B only.
    const eB = await exportAs(baseUrl, auth(tok.adminB));
    assert(eB.status === 200 && eB.json?.exportScope === 'agency' && eB.json.exportAgencyId === B, `admin B export scope: ${eB.status} ${eB.json?.exportScope}`);
    for (const coll of ['agencies', 'venues', 'tasks', 'users', 'events', 'historyLogs', 'handoffNotes', 'incidents', 'announcements', 'taskTemplates', 'eventTaskTemplates', 'approvedIngredients', 'factoryReports', 'airtableConfigs', 'kioskDevices']) {
      for (const x of eB.json[coll] || []) {
        const owner = coll === 'agencies' ? x.id : (x.agencyId || 'agency-hkc');
        assert(owner === B, `admin B export: ${coll} item ${x.id} belongs to ${owner}`);
      }
    }
    assert((eB.json.tasks || []).some((t) => t.title === marks.bTask), "admin B export misses B's own task (positive twin)");
    const bTask = (eB.json.tasks || []).find((t) => t.title === marks.bTask);
    assert(Array.isArray(bTask.extra) && bTask.extra[0]?.note === 'kept' && !('clientSecret' in bTask.extra[0]), 'nested secret inside an array must be scrubbed, data kept');
    for (const m of [`T41X-ORPHAN-${ts}`, `T41X-MISMATCH-${ts}`]) assert(!eB.text.includes(m), `ambiguous/inconsistent ownership must be omitted: "${m}"`);
    assert(eB.json.restorable === false && !('_v' in eB.json) && !('currentWorkDate' in eB.json) && !('isDemoCleared' in eB.json), 'agency export must not look like a whole app-state backup');
    for (const m of [marks.aTask, marks.aName, marks.aEmail, marks.hkcTask, 'kenan@hartfordkashrut.org', A, vA, vH, 'venue-crown-market']) {
      assert(!eB.text.includes(m), `admin B export leaks "${m}"`);
    }
    for (const vid of Object.keys(eB.json.venueWorkDates || {})) assert(vid === vB, `admin B export leaks work date of ${vid}`);
    checkNoSecrets('admin B', eB, apiKeyValue);

    // 6. coordinator / mashgiach → 403.
    for (const who of ['coordB', 'mashB']) {
      const r = await exportAs(baseUrl, auth(tok[who]));
      assert(r.status === 403, `${who} export must be 403, got ${r.status}`);
    }

    // 2. the public attack path: register an agency, export with its token.
    const reg = await fetch(`${baseUrl}/api/agencies/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agencyName: `T41X Intruder ${ts}`, adminName: 'Intruder', adminEmail: `intruder41x-${ts}@evil.test`, adminPassword: 'intruder-pass-123', initialVenueName: 'Intruder Kitchen' }),
    });
    const regJson = await reg.json().catch(() => ({}));
    assert(reg.status === 201 && regJson.token, `register: ${reg.status}`);
    const eI = await exportAs(baseUrl, auth(regJson.token));
    assert(eI.status === 200 && eI.json?.exportScope === 'agency' && eI.json.exportAgencyId === regJson.agency?.id, 'intruder export must be agency-scoped');
    for (const m of [marks.aTask, marks.aName, marks.aEmail, marks.bTask, marks.hkcTask, 'kenan@hartfordkashrut.org', A, B, vH, 'agency-hkc', 'venue-crown-market']) {
      assert(!eI.text.includes(m), `self-registered agency export leaks "${m}"`);
    }
    checkNoSecrets('intruder', eI, apiKeyValue);

    // 3. a second (non-primary) admin of the home agency → home agency only.
    const eH2 = await exportAs(baseUrl, auth(tok.hkc2));
    assert(eH2.status === 200 && eH2.json?.exportScope === 'agency' && eH2.json.exportAgencyId === 'agency-hkc', `second HKC admin scope: ${eH2.json?.exportScope}`);
    assert(eH2.text.includes(marks.hkcTask), 'second HKC admin sees HKC data (positive twin)');
    for (const m of [marks.aTask, marks.bTask, A, B]) assert(!eH2.text.includes(m), `second HKC admin export leaks "${m}"`);
    checkNoSecrets('hkc admin 2', eH2, apiKeyValue);

    // 4. NO cross-agency export for anyone: the home agency's primary admin
    //    (the suite's admin) gets the home agency only (ChatGPT 8h-op: A).
    const eOp = await exportAs(baseUrl, ctx.authHeaders);
    assert(eOp.status === 200 && eOp.json?.exportScope === 'agency' && eOp.json.exportAgencyId === 'agency-hkc', `home primary admin scope: ${eOp.json?.exportScope}`);
    assert(eOp.text.includes(marks.hkcTask), 'home primary admin sees home data (positive twin)');
    for (const m of [marks.aTask, marks.bTask, marks.aEmail, A, B, `T41X-ORPHAN-${ts}`]) assert(!eOp.text.includes(m), `home primary admin export leaks "${m}"`);
    assert(!('_v' in eOp.json) && eOp.json.restorable === false, 'home export is not a whole-database backup');
    checkNoSecrets('home primary admin', eOp, apiKeyValue);
    // Airtable: the key holder (A) sees its config with hasApiKey and no key.
    const eA0 = await exportAs(baseUrl, auth(tok.adminA));
    const cfgA = (eA0.json.airtableConfigs || []).find((c) => c.agencyId === A);
    assert(cfgA && cfgA.hasApiKey === true && !('apiKey' in cfgA), 'airtable config present with hasApiKey true, no key');
    checkNoSecrets('admin A', eA0, apiKeyValue);

    // A's own admin: twin of 1 from the other side.
    const eA = await exportAs(baseUrl, auth(tok.adminA));
    assert(eA.json?.exportAgencyId === A && eA.text.includes(marks.aTask) && !eA.text.includes(marks.bTask), 'admin A export: own data yes, B no');

    return 'every admin (self-registered agency, non-primary and primary home admin, A, B) exports only their own agency; orphan/mismatched records omitted; no secret keys, hashes or Airtable key value in any export; coordinator/mashgiach 403';
  },
};
