/**
 * Test 57 (item 10b, plan v4 10b / C1 / C2 / C6): identity invariants, no
 * behaviour change.
 *
 * Proves on the real server and emulator (and the mock harness):
 *  1 every production route that creates or edits users rows refuses an email
 *    used elsewhere and writes nothing (doc version unchanged, no new row):
 *    POST /api/users (other agency / own agency), POST /api/agencies/register,
 *    POST /api/venues with ownerEmail, PUT /api/users/:id and
 *    PUT /api/users/:id/venues (no email can be changed through them: a body
 *    email is ignored).
 *  2 the checker itself, in the real commit path (through test hooks that go
 *    through commitState): a new row with an email used in another agency, an
 *    existing row changed to another row's email, two new rows with one email
 *    — each refused with 409 / "This email can't be used here.", nothing
 *    written, the people/emails projections untouched (refused inside the
 *    transaction before the dual-write). A forged personId on a new row is
 *    reverted (the row stays its own person).
 *  3 tolerance: a stored invalid person group (planted raw, "impossible
 *    today") never freezes writes — unrelated commits and a name edit of a
 *    member still succeed; a credential change inside it and a THIRD row
 *    joining it are refused. (A stored shared-email pair already stops every
 *    commit at the 8b usersByEmail dual-write guard; unchanged by 10b.) The
 *    identity migration route (apply) still migrates a legacy row to
 *    personId = its own id.
 *  4 credentialOrigin (server-only): register -> 'self-registered'; add-member
 *    and a new venue owner -> 'admin'; the person's own change-password keeps
 *    it; an agency-assisted reset -> 'agency-reset'; any other password write
 *    drops it; a request body can never set or change it (nor credentialOwner,
 *    recoveryCodeHashes, recoveryFailures, joinedAt); it never appears in a
 *    login, roster or update response.
 */
function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 57: identity invariants — no multi-membership row can be created; credentialOrigin (10b)',
  whatItProves:
    'Every route that creates or edits users refuses an email used elsewhere and writes nothing; the commit-time checker refuses any new group of rows sharing an email or personId before any write (projections untouched), tolerates stored legacy duplicates without freezing writes, and credentialOrigin is set only by register / add-member / owner creation / agency reset, kept by change-password, dropped by any other password write, never accepted from a body, never sent out.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t57a-${ts}`, B = `agency-t57b-${ts}`;
    const VA = `venue-t57a-${ts}`, VA2 = `venue-t57a2-${ts}`, VB = `venue-t57b-${ts}`;
    const U = (k) => `user-t57-${k}-${ts}`;
    const E = (k) => `t57-${k}-${ts}@test.local`;
    const PW = 'stage2-t57-password';
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const jsonH = { 'Content-Type': 'application/json' };
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.57.${ts % 200}.${ipN++}` });
    const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
    const hook = (path, body) => ctx.api('POST', `/api/__test__/${path}`, body);
    const rows = async () => (await ctx.getDoc()).users || [];
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const withEmail = async (e) => (await rows()).filter((u) => String(u.email || '').trim().toLowerCase() === e.toLowerCase());
    const SERVER_ONLY = ['credentialOrigin', 'credentialOwner', 'recoveryCodeHashes', 'recoveryFailures', 'joinedAt', 'personId', 'tokenEpoch'];
    const noServerOnly = (obj, where) => {
      const s = J(obj);
      for (const f of SERVER_ONLY) assert(!s.includes(`"${f}"`), `${where}: carries server-only field ${f}`);
    };
    const docs = async (q) => {
      const qs = new URLSearchParams(q).toString();
      const r = await ctx.api('GET', `/api/__test__/identity-docs?${qs}`);
      assert(r.status === 200, `identity-docs ${r.status}`);
      return r.json;
    };
    const unchanged = async (v0, where) => assert((await ctx.getVersion()) === v0, `${where}: the doc version changed (something was written)`);

    // ---- fixture ----
    let r = await hook('inject-fixture', {
      agencies: [
        { id: A, name: `T57 Alpha ${ts}`, shortCode: 'T57A', adminEmail: E('adminA') },
        { id: B, name: `T57 Bravo ${ts}`, shortCode: 'T57B', adminEmail: E('adminB') },
      ],
      venues: [{ id: VA, name: 'T57 A venue', agencyId: A }, { id: VA2, name: 'T57 A venue 2', agencyId: A }, { id: VB, name: 'T57 B venue', agencyId: B }],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T57 Admin A', role: 'admin', agencyId: A },
        { id: U('mashA'), email: E('mashA'), name: 'T57 Mash A', role: 'mashgiach', agencyId: A, venueId: VA },
        { id: U('adminB'), email: E('adminB'), name: 'T57 Admin B', role: 'admin', agencyId: B },
        { id: U('mashB'), email: E('mashB'), name: 'T57 Mash B', role: 'mashgiach', agencyId: B, venueId: VB },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'adminB', 'mashA']) {
      const h = await hook('set-password', { userId: U(k), password: PW });
      assert(h.status === 200, `set-password ${k} ${h.status}`);
    }
    const login = async (email, pw = PW) => {
      const x = await call('POST', '/api/auth/login', jsonH, { email, password: pw });
      assert(x.status === 200 && x.json?.token, `login ${email} ${x.status} ${x.text.slice(0, 160)}`);
      return x;
    };
    const tA = (await login(E('adminA'))).json.token;
    const mashBPid = (await rowOf(U('mashB'))).personId;
    assert(mashBPid === U('mashB'), `fixture rows are born migrated (personId = id): ${mashBPid}`);
    const projB0 = await docs({ userId: U('mashB'), email: E('mashB') });

    // ---- 1. production routes: an email used elsewhere is refused, nothing written ----
    let v0 = await ctx.getVersion();
    r = await call('POST', '/api/users', auth(tA), { email: E('mashB'), name: 'T57 Dup', role: 'mashgiach', venueId: VA, password: 'stage2-t57-x', operationId: `op-t57-u1-${ts}` });
    assert(r.status === 409, `POST /api/users with another agency's email: 409, got ${r.status} ${r.text.slice(0, 160)}`);
    r = await call('POST', '/api/users', auth(tA), { email: E('mashA').toUpperCase(), name: 'T57 Dup2', role: 'mashgiach', venueId: VA, password: 'stage2-t57-x', operationId: `op-t57-u2-${ts}` });
    assert(r.status === 409, `POST /api/users with an own-team email (other case): 409, got ${r.status}`);
    r = await call('POST', '/api/agencies/register', ipH(), { agencyName: `T57 Reg X ${ts}`, shortCode: 'T57X', adminName: 'T57 X', adminEmail: E('mashB'), adminPassword: 'stage2-t57-regpass', initialVenueName: 'T57 X venue' });
    assert(r.status === 409, `register with a used email: 409, got ${r.status}`);
    r = await call('POST', '/api/venues', auth(tA), { name: `T57 Owner venue ${ts}`, ownerEmail: E('mashB'), ownerName: 'Whoever', ownerPassword: 'stage2-t57-owner', operationId: `op-t57-v1-${ts}` });
    assert(r.status === 409, `POST /api/venues with another agency's email as owner: 409, got ${r.status} ${r.text.slice(0, 160)}`);
    await unchanged(v0, 'refused creates');
    assert((await withEmail(E('mashB'))).length === 1 && (await withEmail(E('mashA'))).length === 1, 'refused creates wrote a row');

    // PUT /api/users/:id and /venues: no email change path (a body email is ignored)
    v0 = await ctx.getVersion();
    r = await call('PUT', `/api/users/${U('mashA')}`, auth(tA), { name: 'T57 Mash A renamed', email: E('mashB'), expectedVersion: v0 });
    assert(r.status === 200, `PUT /api/users/:id ${r.status} ${r.text.slice(0, 160)}`);
    noServerOnly(r.json, 'update-user response');
    let mA = await rowOf(U('mashA'));
    assert(mA.email === E('mashA') && mA.name === 'T57 Mash A renamed', `PUT must not change the email: ${mA.email}`);
    v0 = await ctx.getVersion();
    r = await call('PUT', `/api/users/${U('mashA')}/venues`, auth(tA), { venueIds: [VA, VA2], email: E('mashB'), expectedVersion: v0 });
    assert(r.status === 200, `PUT /api/users/:id/venues ${r.status} ${r.text.slice(0, 160)}`);
    mA = await rowOf(U('mashA'));
    assert(mA.email === E('mashA'), `PUT /venues must not change the email: ${mA.email}`);
    assert((await withEmail(E('mashB'))).length === 1, 'an edit created a shared email');

    // ---- 2. the checker in the real commit path ----
    v0 = await ctx.getVersion();
    r = await hook('inject-fixture', { users: [{ id: U('dupB'), email: E('mashB'), name: 'T57 Dup B', role: 'mashgiach', agencyId: A, venueId: VA }] });
    assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `a new row with another agency's email must be refused by the checker: ${r.status} ${J(r.json)}`);
    await unchanged(v0, 'checker: new row');
    assert(!(await rowOf(U('dupB'))), 'checker: refused row was written');
    r = await hook('inject-fixture', { users: [{ id: U('dupB2'), email: ` ${E('mashB').toUpperCase()} `, name: 'T57 Dup B2', role: 'mashgiach', agencyId: A, venueId: VA }] });
    assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `the same email in another case/spacing is refused: ${r.status}`);
    r = await hook('identity-set-email', { userId: U('mashA'), email: E('mashB') });
    assert(r.status === 409 && r.json?.error === "This email can't be used here.", `an existing row changed to another row's email: 409, got ${r.status} ${J(r.json)}`);
    await unchanged(v0, 'checker: email change');
    assert((await rowOf(U('mashA'))).email === E('mashA'), 'checker: email change was written');
    r = await hook('inject-fixture', { users: [
      { id: U('twin1'), email: E('twin'), name: 'T57 Twin 1', role: 'mashgiach', agencyId: A, venueId: VA },
      { id: U('twin2'), email: E('twin'), name: 'T57 Twin 2', role: 'mashgiach', agencyId: B, venueId: VB },
    ] });
    assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `two new rows with one email: refused, got ${r.status}`);
    await unchanged(v0, 'checker: twins');
    assert((await withEmail(E('twin'))).length === 0, 'checker: twins written');
    // projections untouched by every refusal (refused before the dual-write)
    const projB1 = await docs({ userId: U('mashB'), email: E('mashB') });
    assert(J(projB1.people) === J(projB0.people) && J(projB1.emails) === J(projB0.emails), `projections changed: ${J(projB0.emails)} -> ${J(projB1.emails)}`);
    assert((await docs({ email: E('twin') })).emails === null, 'a refused commit wrote an emails projection');
    // a forged personId on a new row: reverted, the row is its own person (no group)
    r = await hook('inject-fixture', { users: [{ id: U('forge'), email: E('forge'), name: 'T57 Forge', role: 'mashgiach', agencyId: A, venueId: VA, personId: mashBPid, credentialOwner: true, credentialOrigin: 'self-registered' }] });
    assert(r.status === 200, `forged new row (own email) commits: ${r.status} ${J(r.json)}`);
    const forged = await rowOf(U('forge'));
    assert(forged.personId === U('forge') && forged.credentialOwner === undefined && forged.credentialOrigin === undefined, `forged server-only fields must be reverted: ${J({ p: forged.personId, o: forged.credentialOwner, c: forged.credentialOrigin })}`);

    // ---- 3. tolerance: a stored invalid group never freezes unrelated writes ----
    // (A stored SHARED-EMAIL pair cannot be tested here: since 8b the
    // usersByEmail dual-write already refuses every commit while two rows
    // share an email — unchanged by 10b. So the stored group planted here is
    // a person group: two rows with one personId and different emails.)
    const cur = await ctx.getDoc();
    const pg = (k, agencyId, venueId) => ({ id: U(k), email: E(k), name: `T57 ${k}`, role: 'mashgiach', agencyId, venueId, avatarColor: '#fff', password: '', personId: U('pg1') });
    r = await hook('doc-set-users', { users: [...(cur.users || []), pg('pg1', A, VA), pg('pg2', B, VB)] });
    assert(r.status === 200, `doc-set-users ${r.status}`);
    try {
      r = await hook('inject-fixture', { venues: [{ id: `venue-t57-h-${ts}`, name: 'T57 hydrate', agencyId: A }] });
      assert(r.status === 200, `an unrelated commit with a stored invalid group must succeed: ${r.status} ${J(r.json)}`);
      let lv = await ctx.getVersion();
      r = await call('PUT', `/api/users/${U('pg1')}`, auth(tA), { name: 'T57 pg1 renamed', expectedVersion: lv });
      assert(r.status === 200, `a name edit of a member (identity unchanged) must succeed: ${r.status} ${r.text.slice(0, 160)}`);
      assert((await rowOf(U('pg1'))).name === 'T57 pg1 renamed', 'name edit stored');
      lv = await ctx.getVersion();
      r = await hook('set-password', { userId: U('pg2'), password: 'stage2-t57-pg2pass' });
      assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `a credential change inside the invalid group must be refused: ${r.status} ${J(r.json)}`);
      await unchanged(lv, 'invalid group changed');
      r = await hook('inject-fixture', { users: [{ id: U('pg3'), email: E('pg1'), name: 'T57 pg3', role: 'mashgiach', agencyId: A, venueId: VA2 }] });
      assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `a third row joining the stored group must be refused: ${r.status}`);
      await unchanged(lv, 'stored group grown');
    } finally {
      // remove the planted rows (raw, like they were planted) so later tests see clean data
      const after = await ctx.getDoc();
      const clean = (after.users || []).filter((u) => u.id !== U('pg1') && u.id !== U('pg2'));
      const c = await hook('doc-set-users', { users: clean });
      assert(c.status === 200, `cleanup ${c.status}`);
      const h = await hook('inject-fixture', { venues: [{ id: `venue-t57-h2-${ts}`, name: 'T57 hydrate 2', agencyId: A }] });
      assert(h.status === 200, `rehydrate ${h.status} ${J(h.json)}`);
    }
    // the identity migration route (apply) still works and creates no group:
    // a legacy row gains personId = its own id
    {
      const c2 = await ctx.getDoc();
      r = await hook('doc-set-users', { users: [...(c2.users || []), { id: U('leg'), email: E('leg'), name: 'T57 leg', role: 'mashgiach', agencyId: A, venueId: VA, avatarColor: '#fff', password: '' }] });
      assert(r.status === 200, `doc-set-users legacy ${r.status}`);
      r = await hook('inject-fixture', { venues: [{ id: `venue-t57-h3-${ts}`, name: 'T57 hydrate 3', agencyId: A }] });
      assert(r.status === 200, `rehydrate ${r.status}`);
      r = await call('POST', '/api/admin/identity-migration', auth(tA), { step: 'rows', apply: true });
      assert(r.status === 200, `identity migration (apply, agency A) ${r.status} ${r.text.slice(0, 200)}`);
      assert((await rowOf(U('leg'))).personId === U('leg'), `migration: personId = own id, got ${(await rowOf(U('leg'))).personId}`);
    }

    // ---- 4. credentialOrigin ----
    // register -> self-registered
    const regEmail = E('reg');
    r = await call('POST', '/api/agencies/register', ipH(), { agencyName: `T57 Reg ${ts}`, shortCode: 'T57R', adminName: 'T57 Reg', adminEmail: regEmail, adminPassword: 'stage2-t57-regpass', initialVenueName: 'T57 Reg venue' });
    assert(r.status === 201, `register ${r.status} ${r.text.slice(0, 160)}`);
    noServerOnly(r.json, 'register response');
    let reg = (await withEmail(regEmail))[0];
    assert(reg && reg.credentialOrigin === 'self-registered', `register must record 'self-registered': ${reg?.credentialOrigin}`);
    const regLogin = await login(regEmail, 'stage2-t57-regpass');
    noServerOnly(regLogin.json, 'login response');
    const tReg = regLogin.json.token;
    // add-member -> admin
    r = await call('POST', '/api/users', auth(tA), { email: E('added'), name: 'T57 Added', role: 'mashgiach', venueId: VA, password: 'stage2-t57-added', operationId: `op-t57-add-${ts}` });
    assert(r.status === 201, `add-member ${r.status} ${r.text.slice(0, 160)}`);
    noServerOnly(r.json, 'add-member response');
    const addedId = r.json.user.id;
    assert((await rowOf(addedId)).credentialOrigin === 'admin', `add-member must record 'admin': ${(await rowOf(addedId)).credentialOrigin}`);
    // new venue owner -> admin
    r = await call('POST', '/api/venues', auth(tA), { name: `T57 Owner venue 2 ${ts}`, ownerEmail: E('owner'), ownerName: 'T57 Owner', ownerPassword: 'stage2-t57-owner', operationId: `op-t57-v2-${ts}` });
    assert(r.status === 201 || r.status === 200, `venue with a new owner ${r.status} ${r.text.slice(0, 160)}`);
    noServerOnly(r.json, 'create-venue response');
    const owner = (await withEmail(E('owner')))[0];
    assert(owner && owner.credentialOrigin === 'admin', `a new venue owner must record 'admin': ${owner?.credentialOrigin}`);
    // a body can never set or change the credential fields
    let lv = await ctx.getVersion();
    r = await call('PUT', `/api/users/${addedId}`, auth(tA), { name: 'T57 Added 2', credentialOrigin: 'self-registered', credentialOwner: true, recoveryCodeHashes: ['x'], recoveryFailures: 0, joinedAt: 1, expectedVersion: lv });
    assert(r.status === 200, `PUT with forged credential fields ${r.status}`);
    const added2 = await rowOf(addedId);
    assert(added2.credentialOrigin === 'admin' && added2.credentialOwner === undefined && added2.recoveryCodeHashes === undefined && added2.recoveryFailures === undefined && added2.joinedAt === undefined, `forged credential fields stored: ${J(added2)}`.replace(/\$2[aby]\$[^"]*/g, '<hash>'));
    r = await call('POST', '/api/users', auth(tA), { email: E('added3'), name: 'T57 Added 3', role: 'mashgiach', venueId: VA, password: 'stage2-t57-added', credentialOrigin: 'self-registered', credentialOwner: true, operationId: `op-t57-add3-${ts}` });
    assert(r.status === 201, `add-member with forged fields ${r.status}`);
    const added3 = await rowOf(r.json.user.id);
    assert(added3.credentialOrigin === 'admin' && added3.credentialOwner === undefined, `add-member body must not set the origin: ${added3.credentialOrigin}`);
    // the roster never carries them
    r = await call('GET', '/api/users', auth(tA));
    assert(r.status === 200, `roster ${r.status}`);
    noServerOnly(r.json, 'GET /api/users');
    // the person's own change-password keeps it
    r = await call('POST', '/api/auth/change-password', auth(tReg), { currentPassword: 'stage2-t57-regpass', newPassword: 'stage2-t57-regpass-2' });
    assert(r.status === 200, `change-password ${r.status} ${r.text.slice(0, 160)}`);
    reg = (await withEmail(regEmail))[0];
    assert(reg.credentialOrigin === 'self-registered', `change-password must keep the origin: ${reg.credentialOrigin}`);
    await login(regEmail, 'stage2-t57-regpass-2');
    // an agency-assisted reset -> agency-reset (the code went to the agency's admins)
    r = await call('POST', '/api/auth/forgot-password', ipH(), { email: regEmail });
    assert(r.status === 200, `forgot ${r.status}`);
    const code = (await (await fetch(`${baseUrl}/api/__test__/last-reset-code?email=${encodeURIComponent(regEmail)}`)).json()).code;
    r = await call('POST', '/api/auth/verify-reset-code', ipH(), { email: regEmail, code });
    assert(r.status === 200 && r.json?.resetToken, `verify ${r.status}`);
    r = await call('POST', '/api/auth/reset-password', jsonH, { email: regEmail, resetToken: r.json.resetToken, newPassword: 'stage2-t57-regpass-3' });
    assert(r.status === 200, `reset ${r.status} ${r.text.slice(0, 160)}`);
    noServerOnly(r.json, 'reset response');
    reg = (await withEmail(regEmail))[0];
    assert(reg.credentialOrigin === 'agency-reset', `an agency-assisted reset must record 'agency-reset': ${reg.credentialOrigin}`);
    // change-password after the reset keeps the downgrade (no upgrade path)
    const tReg2 = (await login(regEmail, 'stage2-t57-regpass-3')).json.token;
    r = await call('POST', '/api/auth/change-password', auth(tReg2), { currentPassword: 'stage2-t57-regpass-3', newPassword: 'stage2-t57-regpass-4' });
    assert(r.status === 200, `change-password 2 ${r.status}`);
    assert((await withEmail(regEmail))[0].credentialOrigin === 'agency-reset', 'change-password must not upgrade an agency-reset origin');
    // any other password write drops it (fail closed)
    r = await hook('set-password', { userId: addedId, password: 'stage2-t57-other' });
    assert(r.status === 200, `set-password ${r.status}`);
    assert((await rowOf(addedId)).credentialOrigin === undefined, `a password write outside the C1 paths must drop the origin: ${(await rowOf(addedId)).credentialOrigin}`);
    // legacy / fixture rows keep no origin at all (absent = legacy-unverified)
    assert((await rowOf(U('adminB'))).credentialOrigin === undefined, 'a fixture row must carry no origin');
  },
};
