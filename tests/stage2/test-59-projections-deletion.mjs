/**
 * Test 59 (item 10d, plan v4 10d B8/B4 part; "Agreed — 10d design v2"):
 * projections from whole person groups + the deletion lifecycle of a
 * multi-row person. Multi-row persons cannot be created by any production
 * route before 10i; this test builds one with the isTestMode-only hook
 * POST /api/__test__/identity-build-person, which commits through the normal
 * checked path (the group may grow only by the join the enforcement accepts).
 *
 *  B  build P = X (credential owner, agency A, password) + Y (agency B):
 *     Y gets X's personId + email, no credential; people/emails unchanged;
 *     consistency clean for P
 *  G  an unrelated growth (a new row with X's email, no join) is refused 409,
 *     nothing written
 *  N  delete the NON-owner Y: only Y goes; X untouched; same admin response;
 *     retry = same 200 answer with no commit; consistency clean
 *  O  delete the OWNER X (Y rebuilt): Y becomes the owner with X's password
 *     hash and origin (membership fields its own); Y logs in with the same
 *     password; the pending reset request for the email is cleared; people/P
 *     follows the new owner row; consistency clean; retry = same answer, no commit
 *  L  delete the LAST row: people + emails retired, as today
 *  T  tolerance: a stored shared-email person group with no owner (planted
 *     raw) no longer freezes unrelated commits (before 10d the usersByEmail
 *     dual-write refused every commit); a credential change inside it is
 *     refused; the read-only check reports it
 *  H  the builder hook is 404 outside test mode
 */
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const J = (x) => JSON.stringify(x);

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

export default {
  name: 'Test 59: projections + deletion lifecycle of a multi-row person (10d)',
  whatItProves:
    'A person with two memberships projects from its credential owner; deleting a non-owner removes only that membership; deleting the owner moves the credential to the M4 successor in the same commit (same password still logs in) and clears pending resets; deleting the last row retires the person; retries are idempotent; an untouched stored invalid group no longer blocks unrelated writes.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t59a-${ts}`, B = `agency-t59b-${ts}`, Z = `agency-t59z-${ts}`;
    const A1 = `venue-t59-a1-${ts}`, B1 = `venue-t59-b1-${ts}`;
    const U = (k) => `user-t59-${k}-${ts}`;
    const E = (k) => `t59-${k.toLowerCase()}-${ts}@test.local`;
    const PW = 'stage2-t59-password';
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.59.${ts % 200}.${ipN++}` });
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const hook = async (path, body) => {
      const r = await ctx.api('POST', `/api/__test__/${path}`, body);
      return { status: r.status, json: r.json };
    };
    const rows = async () => ((await ctx.getDoc()).users || []);
    const rowOf = async (id) => (await rows()).find((u) => u.id === id);
    const personRows = async (pid) => (await rows()).filter((u) => u.personId === pid);
    const unchanged = async (v, label) => assert((await ctx.getVersion()) === v, `${label}: nothing may be written`);
    const docs = async (pid, email) => {
      const r = await ctx.api('POST', '/api/__test__/identity-docs-bulk', { peopleIds: [pid], emails: [email] });
      assert(r.status === 200, `identity-docs-bulk ${r.status}`);
      return { people: r.json.people[pid], emails: r.json.emails[email] };
    };
    const opTok = await mintToken(baseUrl, 'usr_admin');
    const consistency = async (label) => {
      const r = await call('POST', '/api/internal/consistency-check', auth(opTok), {});
      const ours = (r.json?.issues || []).filter((i) => J(i).includes(String(ts)));
      assert(ours.length === 0, `${label}: consistency must report nothing for this test's rows, got ${J(ours).slice(0, 400)}`);
      return r;
    };

    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T59 A ${ts}` }, { id: B, name: `T59 B ${ts}` }, { id: Z, name: `T59 Z ${ts}` }],
      venues: [{ id: A1, name: `T59 A1 ${ts}`, agencyId: A }, { id: B1, name: `T59 B1 ${ts}`, agencyId: B }],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T59 Admin A', role: 'admin', agencyId: A },
        { id: U('adminA2'), email: E('adminA2'), name: 'T59 Admin A2', role: 'admin', agencyId: A },
        { id: U('adminB'), email: E('adminB'), name: 'T59 Admin B', role: 'admin', agencyId: B },
        { id: U('adminB2'), email: E('adminB2'), name: 'T59 Admin B2', role: 'admin', agencyId: B },
        { id: U('x'), email: E('x'), name: 'T59 X', role: 'mashgiach', agencyId: A, venueId: A1 },
      ],
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tA = await mintToken(baseUrl, U('adminA'));
    const tB = await mintToken(baseUrl, U('adminB'));
    let r = await hook('set-password', { userId: U('x'), password: PW });
    assert(r.status === 200, `set-password X ${r.status}`);
    // X becomes the person's credential owner (10i's accept handler is the
    // production writer of credentialOwner; planted raw here, then rehydrated).
    const plantOwner = async () => {
      const cur = await ctx.getDoc();
      const users = (cur.users || []).map((u) => (u.id === U('x') ? { ...u, credentialOwner: true, credentialOrigin: 'self-registered' } : u));
      const p = await hook('doc-set-users', { users });
      assert(p.status === 200, `plant owner ${p.status}`);
      const h = await hook('inject-fixture', { venues: [{ id: `venue-t59-h-${ts}-${Math.random().toString(36).slice(2, 6)}`, name: 'T59 hydrate', agencyId: A }] });
      assert(h.status === 200, `rehydrate ${h.status} ${J(h.json)}`);
    };
    await plantOwner();
    const pid = (await rowOf(U('x'))).personId;
    assert(pid === U('x'), `X is its own person ${pid}`);
    const xHash = (await rowOf(U('x'))).password;
    assert(typeof xHash === 'string' && xHash.startsWith('$2'), 'X has a bcrypt password');
    const build = async () => {
      const b = await hook('identity-build-person', { ownerUserId: U('x'), agencyId: B, role: 'coordinator', venueId: B1, name: 'T59 Y' });
      assert(b.status === 200 && typeof b.json?.id === 'string', `build Y ${b.status} ${J(b.json)}`);
      return b.json.id;
    };
    const del = async (tok, id) => call('DELETE', `/api/users/${id}`, auth(tok), { expectedVersion: await ctx.getVersion() });

    // ---- B ----
    let Y = await build();
    {
      const y = await rowOf(Y);
      assert(y && y.personId === pid && y.email === E('x') && y.agencyId === B, `Y joined P ${J(y)}`);
      assert(y.password === undefined && y.credentialOwner === undefined && y.credentialOrigin === undefined, 'Y holds no credential');
      const d = await docs(pid, E('x'));
      assert(d.people?.status === 'active' && d.people.name === 'T59 X' && d.emails?.status === 'active' && d.emails.personId === pid, `projections from the owner ${J(d)}`);
      await consistency('B');
      console.log('  ✓ B built P = X (owner) + Y through the checked path');
    }
    // ---- G ----
    {
      const v = await ctx.getVersion();
      r = await hook('inject-fixture', { users: [{ id: U('intruder'), email: E('x'), name: 'T59 intruder', role: 'mashgiach', agencyId: Z }] });
      assert(r.status !== 200 && r.json?.error === "This email can't be used here.", `unrelated growth must be refused: ${r.status} ${J(r.json)}`);
      await unchanged(v, 'G');
      console.log('  ✓ G growth without an accepted join refused');
    }
    // ---- N ----
    {
      const xBefore = J(await rowOf(U('x')));
      r = await del(tB, Y);
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: Y }), `delete non-owner: ${r.status} ${r.text.slice(0, 160)}`);
      assert(!(await rowOf(Y)), 'Y gone');
      assert(J(await rowOf(U('x'))) === xBefore, 'X untouched');
      const d = await docs(pid, E('x'));
      assert(d.people?.status === 'active' && d.emails?.status === 'active' && d.emails.personId === pid, `P still active ${J(d)}`);
      const v = await ctx.getVersion();
      r = await del(tB, Y);
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: Y }), `retry: ${r.status} ${r.text.slice(0, 120)}`);
      await unchanged(v, 'N retry');
      await consistency('N');
      console.log('  ✓ N non-owner delete removes only that membership; retry idempotent');
    }
    // ---- O ----
    {
      Y = await build();
      r = await call('POST', '/api/auth/forgot-password', ipH(), { email: E('x') });
      assert(r.status === 200, `forgot ${r.status}`);
      assert(((await ctx.getDoc()).passwordResets || []).some((x) => x.email === E('x')), 'a pending reset exists for the email');
      const yBefore = await rowOf(Y);
      const v0 = await ctx.getVersion();
      r = await del(tA, U('x'));
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: U('x') }), `delete owner: ${r.status} ${r.text.slice(0, 200)}`);
      assert((await ctx.getVersion()) === v0 + 1, 'O: one commit');
      const y = await rowOf(Y);
      assert(!(await rowOf(U('x'))), 'X gone');
      assert(y.credentialOwner === true && y.password === xHash && y.credentialOrigin === 'self-registered', `Y holds X's credential ${J({ owner: y.credentialOwner, origin: y.credentialOrigin, same: y.password === xHash })}`);
      assert(y.role === yBefore.role && y.agencyId === B && y.venueId === B1 && y.personId === pid && (y.tokenEpoch ?? null) === (yBefore.tokenEpoch ?? null), 'Y membership fields (role, agency, venue, person, epoch) unchanged');
      assert(!((await ctx.getDoc()).passwordResets || []).some((x) => x.email === E('x')), 'pending reset for the email cleared');
      const lg = await call('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { email: E('x'), password: PW });
      assert(lg.status === 200 && lg.json?.token && lg.json.user?.id === Y, `Y logs in with the same password: ${lg.status} ${lg.text.slice(0, 160)}`);
      const d = await docs(pid, E('x'));
      assert(d.people?.status === 'active' && d.people.name === 'T59 Y' && d.emails?.status === 'active' && d.emails.personId === pid, `people/P follows the new owner ${J(d)}`);
      const v = await ctx.getVersion();
      r = await del(tA, U('x'));
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: U('x') }), `retry: ${r.status}`);
      await unchanged(v, 'O retry (no second transfer)');
      assert(J(await rowOf(Y)) === J(y), 'retry changed nothing on Y');
      await consistency('O');
      console.log('  ✓ O owner delete moves the credential to the successor; same password logs in; resets cleared; retry idempotent');
    }
    // ---- L ----
    {
      r = await del(tB, Y);
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: Y }), `delete last row: ${r.status} ${r.text.slice(0, 160)}`);
      const d = await docs(pid, E('x'));
      assert(d.people?.status === 'retired' && d.emails?.status === 'retired', `last row retires P ${J(d)}`);
      const v = await ctx.getVersion();
      r = await del(tB, Y);
      assert(r.status === 200 && J(r.json) === J({ success: true, deletedId: Y }), 'retry');
      await unchanged(v, 'L retry');
      await consistency('L');
      console.log('  ✓ L last row retires the person');
    }
    // ---- T ----
    {
      const cur = await ctx.getDoc();
      const q = (k, agencyId) => ({ id: U(k), email: E('q'), name: `T59 ${k}`, role: 'mashgiach', agencyId, avatarColor: '#fff', personId: U('q1') });
      r = await hook('doc-set-users', { users: [...(cur.users || []), q('q1', A), q('q2', B)] });
      assert(r.status === 200, `plant ${r.status}`);
      try {
        r = await hook('inject-fixture', { venues: [{ id: `venue-t59-t-${ts}`, name: 'T59 tolerance', agencyId: A }] });
        assert(r.status === 200, `an unrelated commit with a stored shared-email group (no owner) must succeed: ${r.status} ${J(r.json)}`);
        const lv = await ctx.getVersion();
        r = await hook('set-password', { userId: U('q2'), password: 'stage2-t59-q2pass' });
        assert(r.status !== 200, `a credential change inside the invalid group must be refused: ${r.status} ${J(r.json)}`);
        await unchanged(lv, 'T credential change');
        const c = await call('POST', '/api/internal/consistency-check', auth(opTok), {});
        const ours = (c.json?.issues || []).filter((i) => J(i).includes(String(ts)));
        assert(ours.some((i) => /identity/.test(J(i))), `the read-only check reports the group: ${J(ours).slice(0, 300)}`);
      } finally {
        const after = await ctx.getDoc();
        const c = await hook('doc-set-users', { users: (after.users || []).filter((u) => u.id !== U('q1') && u.id !== U('q2')) });
        assert(c.status === 200, `cleanup ${c.status}`);
        const h = await hook('inject-fixture', { venues: [{ id: `venue-t59-t2-${ts}`, name: 'T59 rehydrate', agencyId: A }] });
        assert(h.status === 200, `rehydrate ${h.status}`);
      }
      console.log('  ✓ T untouched stored invalid group tolerated; credential change refused; reported');
    }
    // ---- H ----
    if (typeof ctx.restartServer === 'function') {
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        const h = await fetch(`${baseUrl}/api/__test__/identity-build-person`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ ownerUserId: 'x', agencyId: 'y' }) });
        assert(h.status === 404, `H: builder hook must be 404 outside test mode, got ${h.status}`);
      } finally {
        await ctx.restartServer();
      }
    }
    return 'P = X(owner)+Y built through the checked path; unrelated growth refused; non-owner delete removes only Y (retry idempotent); owner delete moves the credential to Y in one commit, same password logs in as Y, resets cleared, people follows the new owner (retry idempotent, no second transfer); last row retires P; stored shared-email group without owner tolerated for unrelated commits, credential change refused, reported; builder 404 outside test mode';
  },
};
