/**
 * Test 56 (item 10a, plan v4): non-enumerating public answers.
 *
 * Proves on the real server and emulator (and the mock harness):
 *  1 POST /api/auth/login answers an unknown email and a wrong password with
 *    the SAME status and the SAME body ("Email or password is incorrect.");
 *    the right password still signs in.
 *  2 POST /api/agencies/register refuses a taken email (an admin of another
 *    agency, a staff member of another agency) with one text that names no
 *    account and no agency; every well-formed attempt from one client IP is
 *    counted BEFORE the email is looked at (process-local bounded limiter,
 *    no state-document write): 10 attempts per hour, the 11th is 429 for a
 *    taken AND a fresh email (nothing created, nothing written, a new
 *    operationId does not get past it); another IP is not affected; a body
 *    operationId does not swallow the registration; an identical retry of a
 *    successful registration gets the generic 409 (as before 10a), echoes no
 *    stored result, writes nothing, and the person can sign in.
 *  Limits that remain (not claimed as closed): needsSetup and sign-up
 *  success vs refusal still reveal that an email is taken.
 *  3 POST /api/users: an email used in ANOTHER agency gets "This email can't
 *    be added directly." (no agency, no name); an email of the caller's own
 *    team keeps "A team member with this email already exists"; nothing is
 *    written in either case.
 */
function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

export default {
  name: 'Test 56: non-enumerating login / register / add-member answers (10a)',
  whatItProves:
    'Login gives one answer for unknown email and wrong password; register and add-member never say that an email exists in another agency; register is limited per client IP (10/h) counting taken and fresh emails alike.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t56a-${ts}`, B = `agency-t56b-${ts}`;
    const VA = `venue-t56a-${ts}`, VB = `venue-t56b-${ts}`;
    const U = (k) => `user-t56-${k}-${ts}`;
    const E = (k) => `t56-${k}-${ts}@test.local`;
    const PW = 'stage2-t56-password';
    const NAME_B = `T56 Bravo Agency ${ts}`;
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const jsonH = { 'Content-Type': 'application/json' };
    const ipH = (ip) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip });
    const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

    let r = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: A, name: `T56 Alpha ${ts}`, shortCode: 'T56A', adminEmail: E('adminA') },
        { id: B, name: NAME_B, shortCode: 'T56B', adminEmail: E('adminB') },
      ],
      venues: [{ id: VA, name: 'T56 A venue', agencyId: A }, { id: VB, name: 'T56 B venue', agencyId: B }],
      users: [
        { id: U('adminA'), email: E('adminA'), name: 'T56 Admin A', role: 'admin', agencyId: A },
        { id: U('mashA'), email: E('mashA'), name: 'T56 Mash A', role: 'mashgiach', agencyId: A, venueId: VA },
        { id: U('adminB'), email: E('adminB'), name: 'T56 Admin B', role: 'admin', agencyId: B },
        { id: U('mashB'), email: E('mashB'), name: 'T56 Mash B', role: 'mashgiach', agencyId: B, venueId: VB },
      ],
    });
    assert(r.status === 200, `inject-fixture ${r.status} ${J(r.json)}`);
    for (const k of ['adminA', 'mashA', 'adminB', 'mashB']) {
      const h = await ctx.api('POST', '/api/__test__/set-password', { userId: U(k), password: PW });
      assert(h.status === 200, `set-password ${k} ${h.status}`);
    }
    const leakWords = /exist|platform|not found|registered|another agency|other agency/i;

    // ---- 1. login: one answer ----
    const unknown = await call('POST', '/api/auth/login', jsonH, { email: `t56-nobody-${ts}@test.local`, password: PW });
    const wrong = await call('POST', '/api/auth/login', jsonH, { email: E('mashB'), password: 'not-the-password-56' });
    assert(unknown.status === 401 && wrong.status === 401, `login refusals must be 401/401, got ${unknown.status}/${wrong.status}`);
    assert(unknown.text === wrong.text, `unknown email and wrong password must give the same body: ${unknown.text} vs ${wrong.text}`);
    assert(unknown.json?.error === 'Email or password is incorrect.', `login text: ${unknown.text}`);
    assert(!leakWords.test(unknown.text), `login refusal must not hint at existence: ${unknown.text}`);
    const okLogin = await call('POST', '/api/auth/login', jsonH, { email: E('adminA'), password: PW });
    assert(okLogin.status === 200 && okLogin.json?.token, `right password must still sign in: ${okLogin.status}`);
    const tAdminA = okLogin.json.token;

    // ---- 2. register: generic refusal + per-IP limit ----
    const ipX = `10.56.${ts % 200}.1`, ipY = `10.56.${ts % 200}.2`;
    const regBody = (email, n, extra = {}) => ({ agencyName: `T56 Reg ${n} ${ts}`, shortCode: `T56R${n}`, adminName: `T56 Reg ${n}`, adminEmail: email, adminPassword: 'stage2-t56-regpass', initialVenueName: `T56 Reg Venue ${n}`, ...extra });
    // attempt 1 (fresh email, with a body operationId): created
    const fresh1 = await call('POST', '/api/agencies/register', ipH(ipX), regBody(E('reg1'), 1, { operationId: `op-t56-${ts}` }));
    assert(fresh1.status === 201 && fresh1.json?.agency?.id, `fresh registration with an operationId must be created: ${fresh1.status} ${fresh1.text.slice(0, 200)}`);
    const reg1Login = await call('POST', '/api/auth/login', jsonH, { email: E('reg1'), password: 'stage2-t56-regpass' });
    assert(reg1Login.status === 200, `the registered admin can sign in (registration really happened): ${reg1Login.status}`);
    // attempt 2: an identical retry of that successful registration (same
    // operationId, same body) -> the same generic refusal as before 10a (the
    // email is taken now), no second agency, no stored result echoed back.
    const vRetry = await ctx.getVersion();
    const retry = await call('POST', '/api/agencies/register', ipH(ipX), regBody(E('reg1'), 1, { operationId: `op-t56-${ts}` }));
    assert(retry.status === 409, `identical retry of a successful registration: 409 like before 10a, got ${retry.status} ${retry.text.slice(0, 160)}`);
    assert(!/\$2[aby]\$|password|token/i.test(retry.text), `the retry answer must carry no stored result: ${retry.text.slice(0, 160)}`);
    assert((await ctx.getVersion()) === vRetry, 'the retry writes nothing (no second agency)');
    const reg1Again = await call('POST', '/api/auth/login', jsonH, { email: E('reg1'), password: 'stage2-t56-regpass' });
    assert(reg1Again.status === 200, 'after a lost response the person signs in with the password they chose');
    // attempts 3..10 (taken emails: other agency's admin, other agency's staff, the one just registered)
    const taken = [E('adminB'), E('mashB'), E('reg1')];
    const refusals = [retry];
    for (let n = 3; n <= 10; n++) {
      const g = await call('POST', '/api/agencies/register', ipH(ipX), regBody(taken[n % taken.length], n));
      refusals.push(g);
      assert(g.status === 409, `taken email attempt ${n} must be 409, got ${g.status} ${g.text.slice(0, 160)}`);
    }
    const t0 = refusals[0].text;
    for (const g of refusals) assert(g.text === t0, `every taken-email refusal must be identical: ${g.text} vs ${t0}`);
    assert(refusals[0].json?.error === "This email can't be used to register a new agency.", `register text: ${t0}`);
    assert(!leakWords.test(t0) && !t0.includes(NAME_B) && !t0.includes(B), `register refusal must name nothing: ${t0}`);
    // attempt 11 and 12 from ipX: limited, for a taken AND a fresh email (and
    // a random operationId does not get past the limiter)
    const lim1 = await call('POST', '/api/agencies/register', ipH(ipX), regBody(E('adminB'), 11));
    const lim2 = await call('POST', '/api/agencies/register', ipH(ipX), regBody(E('reg12'), 12, { operationId: `op-t56-other-${ts}` }));
    assert(lim1.status === 429 && lim2.status === 429, `11th/12th attempts from one IP must be 429/429, got ${lim1.status}/${lim2.status}`);
    assert(lim1.json?.code === 'RATE_LIMITED' && lim2.json?.code === 'RATE_LIMITED', 'limited answers carry RATE_LIMITED');
    const reg12Login = await call('POST', '/api/auth/login', jsonH, { email: E('reg12'), password: 'stage2-t56-regpass' });
    assert(reg12Login.status === 401, `a limited registration must create nothing (login ${reg12Login.status})`);
    // the limiter writes nothing to the state document
    const vLim = await ctx.getVersion();
    const lim3 = await call('POST', '/api/agencies/register', ipH(ipX), regBody(E('adminB'), 14));
    assert(lim3.status === 429 && (await ctx.getVersion()) === vLim, 'a limited attempt writes nothing');
    // another IP is not affected
    const otherIp = await call('POST', '/api/agencies/register', ipH(ipY), regBody(E('mashB'), 13));
    assert(otherIp.status === 409 && otherIp.text === t0, `another IP is not limited (taken -> same 409): ${otherIp.status} ${otherIp.text.slice(0, 120)}`);

    // ---- 3. POST /api/users ----
    const vBefore = await ctx.getVersion();
    const cross = await call('POST', '/api/users', auth(tAdminA), { email: E('mashB'), name: 'Someone', role: 'mashgiach', venueId: VA });
    assert(cross.status === 409, `other-agency email must be refused 409, got ${cross.status} ${cross.text.slice(0, 160)}`);
    assert(cross.json?.error === "This email can't be added directly.", `cross-agency add text: ${cross.text}`);
    assert(!leakWords.test(cross.text) && !cross.text.includes(NAME_B) && !cross.text.includes(B) && !cross.text.includes('T56 Mash B'), `cross-agency refusal must name nothing: ${cross.text}`);
    const crossAdmin = await call('POST', '/api/users', auth(tAdminA), { email: E('adminB'), name: 'Someone', role: 'coordinator', venueId: VA });
    assert(crossAdmin.status === 409 && crossAdmin.text === cross.text, `other agency's admin email: same refusal (${crossAdmin.status} ${crossAdmin.text})`);
    const own = await call('POST', '/api/users', auth(tAdminA), { email: E('mashA'), name: 'Dup', role: 'mashgiach', venueId: VA });
    assert(own.status === 409 && /already exists/.test(own.json?.error || ''), `own-team email keeps its text: ${own.status} ${own.text}`);
    assert((await ctx.getVersion()) === vBefore, 'refused add-member attempts must write nothing');
    const ok = await call('POST', '/api/users', auth(tAdminA), { email: E('newA'), name: 'T56 New', role: 'mashgiach', venueId: VA });
    assert(ok.status === 201, `a new email is still added directly (unchanged): ${ok.status} ${ok.text.slice(0, 160)}`);
  },
};
