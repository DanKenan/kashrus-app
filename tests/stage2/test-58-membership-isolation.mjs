/**
 * Test 58 (item 10c, plan v4 10c B7/N4; inventory files/shutfey-10-email-inventory.txt v2,
 * "Agreed — 10c inventory v2"): membership isolation of the email-keyed paths
 * that span agencies. Two-membership rows cannot be stored before 10d (the
 * usersByEmail dual-write refuses every commit while two rows share an email),
 * so each path is proven with a FOREIGN BOUND subscription: a device record
 * carrying this person's email but another agency's row id — exactly what a
 * second membership's device looks like. The full two-row matrix runs after 10d.
 *
 *  A1 alert, announcement, event-assignment and reset-code pushes reach only the
 *     recipient ROW's own bound devices (+ its legacy no-userId record, the email
 *     being unique), never the foreign bound record with the same email
 *  Q3 one endpoint follows the most recent subscriber: re-subscribing an endpoint
 *     as another agency's user replaces the record whole (userId + agencyId + email)
 *  A2 unsubscribe removes only the caller row's record (or its unambiguous legacy
 *     one); a foreign bound record with the caller's email and another user's
 *     endpoint are untouched
 *  A4 deleting a user removes their bound + legacy records in the same commit and
 *     keeps a foreign bound record that carries their email
 *  A5 a new venue's owner email that exists only in ANOTHER agency → an owner
 *     invite (invites always on: the unknown-email answer), no row written, that row not moved; an owner of the caller's agency
 *     is still reused
 *  D  kiosk: X's PIN typed on Y's tile at Y's tablet (other agency) is a counted
 *     wrong PIN on Y's row only; X's lockout untouched; generic text, no hint of X
 *  G  the extended test hook (seed-legacy-push-sub with subUserId) is 404 outside
 *     test mode (covered with the other push hooks by Test 46 G; re-checked here)
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
  name: 'Test 58: membership isolation of cross-agency email paths (10c)',
  whatItProves:
    'Pushes go to the recipient row (never to a device bound to another agency under the same email); unsubscribe and delete cleanup act on the row, not the email; a venue owner email is resolved inside the caller\'s agency only; a kiosk wrong PIN counts only on the tile\'s own row.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const A = `agency-t58a-${ts}`, B = `agency-t58b-${ts}`;
    const A1 = `venue-t58-a1-${ts}`, B1 = `venue-t58-b1-${ts}`;
    const id = (k) => `user-t58-${k}-${ts}`;
    const em = (k) => `t58-${k.toLowerCase()}-${ts}@test.local`;
    const ep = (k) => `https://push.test.invalid/t58-${k}-${ts}`;
    let ipN = 1;
    const ipH = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': `10.58.${ts % 200}.${ipN++}` });
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const write = async (method, path, token, body) => call(method, path, auth(token), { expectedVersion: await ctx.getVersion(), operationId: `op-t58-${Math.random().toString(36).slice(2)}`, ...body });
    const people = [
      { id: id('adminA'), email: em('adminA'), name: 'T58 Admin A', role: 'admin', agencyId: A },
      { id: id('mashA'), email: em('mashA'), name: 'T58 Mash A', role: 'mashgiach', agencyId: A, venueId: A1 },
      { id: id('victim'), email: em('victim'), name: 'T58 Victim', role: 'mashgiach', agencyId: A, venueId: A1 },
      { id: id('ownerA'), email: em('ownerA'), name: 'T58 Owner A', role: 'owner', agencyId: A, venueId: A1 },
      { id: id('adminB'), email: em('adminB'), name: 'T58 Admin B', role: 'admin', agencyId: B },
      { id: id('mashB'), email: em('mashB'), name: 'T58 Mash B', role: 'mashgiach', agencyId: B, venueId: B1 },
      { id: id('ownerB'), email: em('ownerB'), name: 'T58 Owner B', role: 'owner', agencyId: B, venueId: B1 },
    ];
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: A, name: `T58 A ${ts}` }, { id: B, name: `T58 B ${ts}` }],
      venues: [{ id: A1, name: `T58 A1 ${ts}`, agencyId: A }, { id: B1, name: `T58 B1 ${ts}`, agencyId: B }],
      users: people,
    });
    assert(inj.status === 200, `inject-fixture: ${inj.status}`);
    const tok = {};
    for (const p of people) tok[p.id] = await mintToken(baseUrl, p.id);
    const T = (k) => tok[id(k)];
    const subscribe = async (k, endpoint) => {
      const r = await call('POST', '/api/push/subscribe', auth(T(k)), { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
      assert(r.status === 200, `subscribe ${k}: ${r.status} ${r.text.slice(0, 120)}`);
    };
    const seed = async (body) => {
      const r = await ctx.api('POST', '/api/__test__/seed-legacy-push-sub', body);
      assert(r.status === 200, `seed sub: ${r.status} ${J(r.json)}`);
    };
    const subs = async () => ((await ctx.getDoc()).pushSubscriptions || []).filter((s) => String(s.endpoint).includes(`-${ts}`));
    const subAt = async (endpoint) => (await subs()).filter((s) => s.endpoint === endpoint);
    // Each of these rows: own bound device, a FOREIGN bound record with the
    // row's email (bound to mashB in agency B = "another membership's device"),
    // and a legacy (no userId) record under the row's email.
    for (const k of ['adminA', 'mashA', 'victim']) {
      await subscribe(k, ep(k));
      await seed({ subEmail: em(k), endpoint: ep(`${k}-foreign`), subUserId: id('mashB'), subAgencyId: B });
      await seed({ subEmail: em(k), endpoint: ep(`${k}-legacy`) });
    }
    await subscribe('mashB', ep('mashB'));
    {
      const f = (await subAt(ep('mashA-foreign')))[0];
      assert(f && f.userId === id('mashB') && f.agencyId === B && f.userEmail === em('mashA'), `foreign bound record seeded ${J(f)}`);
      const l = (await subAt(ep('mashA-legacy')))[0];
      assert(l && !l.userId && l.userEmail === em('mashA'), `legacy record seeded ${J(l)}`);
    }
    const log = async () => {
      const r = await ctx.api('GET', '/api/__test__/push-log');
      assert(r.status === 200, `push-log: ${r.status}`);
      return (r.json.log || []).filter((e) => String(e.endpoint).includes(`-${ts}`));
    };
    const clear = async () => { await ctx.api('POST', '/api/__test__/push-log/clear', {}); };
    const eps = (entries) => [...new Set(entries.map((e) => e.endpoint))].sort();
    const expectRowOnly = (entries, k, label) => {
      const want = [ep(k), ep(`${k}-legacy`)].sort();
      const got = eps(entries);
      assert(J(got) === J(want), `${label}: endpoints must be ${k}'s own device + its legacy record only, got ${J(got)}`);
      for (const e of entries) {
        assert(e.recipientUserId === id(k), `${label}: recipient ${e.recipientUserId} is not ${k}`);
        assert(e.path === (e.endpoint === ep(k) ? 'identity' : 'legacy-email'), `${label}: path ${e.path} for ${e.endpoint}`);
      }
    };
    const noForeign = (entries, label) => {
      const bad = entries.filter((e) => String(e.endpoint).endsWith(`-foreign-${ts}`));
      assert(bad.length === 0, `${label}: a device bound to another agency under the same email was targeted: ${J(eps(bad))}`);
    };

    // ---- A1: four push paths -------------------------------------------------
    {
      await clear();
      const title = `T58 alert ${ts}`;
      const r = await write('POST', '/api/incidents', T('mashA'), { severity: 'high', venueId: A1, title });
      assert(r.status === 200, `raise alert: ${r.status} ${r.text.slice(0, 160)}`);
      const e = (await log()).filter((x) => String(x.title).includes(title));
      noForeign(e, 'A1 alert');
      expectRowOnly(e.filter((x) => x.recipientUserId === id('adminA')), 'adminA', 'A1 alert');
      assert(e.every((x) => x.recipientUserId === id('adminA')), `A1 alert recipients ${J(e.map((x) => x.recipientUserId))}`);
    }
    {
      await clear();
      const title = `T58 ann ${ts}`;
      const r = await write('POST', '/api/announcements', T('adminA'), { title, body: 'hello', targetRoles: ['all'] });
      assert(r.status === 200 || r.status === 201, `announce: ${r.status} ${r.text.slice(0, 160)}`);
      const e = (await log()).filter((x) => String(x.title).includes(title));
      noForeign(e, 'A1 announcement');
      expectRowOnly(e.filter((x) => x.recipientUserId === id('mashA')), 'mashA', 'A1 announcement');
      assert(!e.some((x) => x.recipientUserId === id('adminA')), 'A1 announcement: the author is not notified');
      assert(!e.some((x) => x.endpoint === ep('mashB')), 'A1 announcement: no agency-B device');
    }
    {
      await clear();
      const r = await call('POST', '/api/events', auth(T('adminA')), { venueId: A1, title: `T58 ev ${ts}`, location: 'Hall', date: '2026-11-05', mashgiachType: 'assigned_user', assignedMashgiachEmail: em('mashA'), operationId: `op-t58-ev-${ts}` });
      assert(r.status === 201, `event create: ${r.status} ${r.text.slice(0, 160)}`);
      const e = (await log()).filter((x) => x.title === '⭐ New event assignment');
      noForeign(e, 'A1 event assignment');
      expectRowOnly(e, 'mashA', 'A1 event assignment');
    }
    {
      await clear();
      const r = await call('POST', '/api/auth/forgot-password', ipH(), { email: em('mashA') });
      assert(r.status === 200, `forgot: ${r.status}`);
      const e = (await log()).filter((x) => String(x.title).startsWith('🔑 Password reset code for T58 Mash A'));
      noForeign(e, 'A1 reset code');
      expectRowOnly(e, 'adminA', 'A1 reset code');
    }

    // ---- Q3: one endpoint follows the most recent subscriber -------------------
    {
      const shared = ep('switch');
      await subscribe('mashA', shared);
      let at = await subAt(shared);
      assert(at.length === 1 && at[0].userId === id('mashA') && at[0].agencyId === A, `Q3 first owner ${J(at)}`);
      await subscribe('mashB', shared);
      at = await subAt(shared);
      assert(at.length === 1 && at[0].userId === id('mashB') && at[0].agencyId === B && at[0].userEmail === em('mashB'), `Q3 the record is replaced whole (no stale userId/agency/email) ${J(at)}`);
      await clear();
      const title = `T58 ann2 ${ts}`;
      const r = await write('POST', '/api/announcements', T('adminA'), { title, body: 'x', targetRoles: ['all'] });
      assert(r.status === 200 || r.status === 201, `announce 2: ${r.status}`);
      const e = (await log()).filter((x) => String(x.title).includes(title));
      assert(!e.some((x) => x.endpoint === shared), 'Q3: an A push never reaches the endpoint now held by agency B');
    }

    // ---- A2: unsubscribe acts on the caller's row ------------------------------
    {
      const un = async (endpoint) => {
        const r = await call('POST', '/api/push/unsubscribe', auth(T('mashA')), { endpoint });
        assert(r.status === 200, `unsubscribe ${endpoint}: ${r.status}`);
      };
      await un(ep('mashA-foreign'));
      assert((await subAt(ep('mashA-foreign'))).length === 1, 'A2: a device bound to another agency under the caller\'s email is NOT removed');
      await un(ep('mashB'));
      assert((await subAt(ep('mashB'))).length === 1, 'A2: another user\'s device is not removed');
      await un(ep('mashA-legacy'));
      assert((await subAt(ep('mashA-legacy'))).length === 0, 'A2: the caller\'s unambiguous legacy record is removed');
      await un(ep('mashA'));
      assert((await subAt(ep('mashA'))).length === 0, 'A2: the caller\'s own bound record is removed');
    }

    // ---- A4: delete cleanup by row ----------------------------------------------
    {
      const v0 = await ctx.getVersion();
      const del = await call('DELETE', `/api/users/${id('victim')}`, auth(T('adminA')), { expectedVersion: v0 });
      assert(del.status === 200, `delete victim: ${del.status} ${del.text.slice(0, 120)}`);
      assert((await ctx.getVersion()) === v0 + 1, 'A4: one commit');
      assert((await subAt(ep('victim'))).length === 0, 'A4: bound record removed');
      assert((await subAt(ep('victim-legacy'))).length === 0, 'A4: unambiguous legacy record removed');
      const f = await subAt(ep('victim-foreign'));
      assert(f.length === 1 && f[0].userId === id('mashB'), `A4: the record bound to another agency's row is kept ${J(f)}`);
    }

    // ---- A5: venue-owner email resolved inside the caller's agency ------------
    {
      const before = J(((await ctx.getDoc()).users || []).find((u) => u.id === id('ownerB')));
      // Invites always on: an email that is not a row of the caller's agency
      // gets an owner INVITE (the unknown-email answer, 10i V2/W1): no row is
      // written, moved or reused, and the answer names nothing of agency B.
      const u0 = ((await ctx.getDoc()).users || []).length;
      const r = await call('POST', '/api/venues', auth(T('adminA')), { name: `T58 V ${ts}`, ownerEmail: em('ownerB').toUpperCase(), ownerName: 'Nope' });
      assert(r.status === 201 && r.json?.owner === null && r.json?.ownerInvite, `A5: other-agency owner email → an owner invite, no row, got ${r.status} ${r.text.slice(0, 160)}`);
      assert(!r.text.includes(id('ownerB')) && !r.text.includes(B), 'A5: the answer names nothing of agency B');
      assert(((await ctx.getDoc()).users || []).length === u0, 'A5: no user row written');
      const nv = ((await ctx.getDoc()).venues || []).find((x) => x.id === r.json.venue?.id);
      assert(nv && nv.agencyId === A && !nv.ownerId, 'A5: the new venue has no owner yet (not the agency-B row)');
      const after = J(((await ctx.getDoc()).users || []).find((u) => u.id === id('ownerB')));
      assert(after === before, 'A5: the other agency\'s row is not moved or changed');
      const ok = await call('POST', '/api/venues', auth(T('adminA')), { name: `T58 V2 ${ts}`, ownerEmail: em('ownerA') });
      assert(ok.status === 201 || ok.status === 200, `A5: an owner of the caller's agency is reused: ${ok.status} ${ok.text.slice(0, 160)}`);
      const oa = ((await ctx.getDoc()).users || []).filter((u) => String(u.email).toLowerCase() === em('ownerA'));
      assert(oa.length === 1 && oa[0].id === id('ownerA') && oa[0].agencyId === A, `A5: same row reused, still agency A ${J(oa.map((u) => [u.id, u.agencyId]))}`);
    }

    // ---- D: kiosk wrong PIN counts on the tile's own row only ------------------
    {
      let r = await write('PUT', `/api/users/${id('mashA')}`, T('adminA'), { kioskPin: '5811' });
      assert(r.status === 200, `PIN X: ${r.status} ${r.text.slice(0, 120)}`);
      r = await write('PUT', `/api/users/${id('mashB')}`, T('adminB'), { kioskPin: '5822' });
      assert(r.status === 200, `PIN Y: ${r.status} ${r.text.slice(0, 120)}`);
      const start = await call('POST', '/api/kiosk/pairing/start', { 'Content-Type': 'application/json' }, {});
      assert(start.status === 200, `pairing/start ${start.status}`);
      const p = await call('POST', '/api/kiosk/devices/pair', auth(T('adminB')), { code: start.json.code, venueId: B1 });
      assert(p.status === 201, `devices/pair ${p.status} ${p.text.slice(0, 120)}`);
      const st = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${start.json.pairingId}.${start.json.deviceSecret}` } }).then((x) => x.json());
      assert(st.status === 'approved', `claim ${J(st).slice(0, 120)}`);
      const dev = `${st.device.id}.${start.json.deviceSecret}`;
      const lk0 = (await ctx.getDoc()).kioskPinLockouts || { users: {} };
      const xBefore = J((lk0.users || {})[id('mashA')] || null);
      const yBefore = (((lk0.users || {})[id('mashB')] || {}).fails || []).length;
      r = await call('POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev, 'X-Forwarded-For': `10.58.${ts % 200}.250` }, { userId: id('mashB'), pin: '5811' });
      assert(r.status === 401, `D: X's PIN on Y's tile must be a wrong PIN, got ${r.status} ${r.text.slice(0, 120)}`);
      assert(r.json?.error === 'Wrong code. Try again.', `D: generic text ${r.text.slice(0, 120)}`);
      assert(!r.text.includes(em('mashA')) && !r.text.includes('T58 Mash A') && !r.text.includes(id('mashA')), 'D: no hint about X');
      const lk1 = (await ctx.getDoc()).kioskPinLockouts || { users: {} };
      const yAfter = (((lk1.users || {})[id('mashB')] || {}).fails || []).length;
      assert(yAfter === yBefore + 1, `D: counted once on Y's row (${yBefore} → ${yAfter})`);
      assert(J((lk1.users || {})[id('mashA')] || null) === xBefore, 'D: X\'s lockout untouched');
      r = await call('POST', '/api/kiosk/login', { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev, 'X-Forwarded-For': `10.58.${ts % 200}.251` }, { userId: id('mashB'), pin: '5822' });
      assert(r.status === 200 && r.json?.token && r.json.user?.id === id('mashB'), `D: Y's own PIN still works on Y's tablet: ${r.status} ${r.text.slice(0, 120)}`);
    }

    // ---- G: the extended hook is test-mode only ---------------------------------
    if (typeof ctx.restartServer === 'function') {
      await ctx.restartServer({ STAGE2_TEST_MODE: 'false' });
      try {
        const r = await fetch(`${baseUrl}/api/__test__/seed-legacy-push-sub`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ subEmail: 'x@y', endpoint: 'https://push.test.invalid/g58', subUserId: 'u', subAgencyId: 'a' }) });
        assert(r.status === 404, `G: seed hook must be 404 outside test mode, got ${r.status}`);
      } finally {
        await ctx.restartServer();
      }
    }
    return 'alert/announcement/assignment/reset-code pushes → the recipient row\'s own device + unambiguous legacy only, never a device bound to another agency under the same email; one endpoint follows the latest subscriber (replaced whole); unsubscribe and delete act on the row; other-agency owner email → generic 409, row not moved, own-agency owner reused; kiosk wrong PIN counted on the tile\'s row only, X untouched; hook 404 outside test mode';
  },
};
