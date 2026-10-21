/**
 * Test 49 (item 8c): identity migrator + projection repair (no login change).
 *
 * Proves, end to end on the real server and emulator ("8c plan v2"):
 *  1 dry-run is the default and writes nothing (version + projections
 *    unchanged); apply "true" (string) is a dry run too
 *  2 apply migrates 250 legacy rows in 3 bounded batches (version +3), each
 *    row personId = id with its people/emails projections; agency B untouched
 *  3 interruption after batch 1 + resume with the cursor → every row migrated
 *    exactly once (projection _v 1, exact shapes), version bumps = batches
 *    applied, the partial call never reports complete
 *  4 conflicts decided in the transaction: an emails mapping made active for
 *    another person AFTER the dry-run, and an existing RETIRED people doc
 *    whose id equals a legacy row id → reported (id + reason code), row stays
 *    unmigrated, people doc byte-identical, others proceed; stopReason
 *    'blocked', complete false, nextCursor null; once resolved a no-cursor
 *    rerun migrates them → 'done'
 *  5 an all-conflicted agency → 'blocked', 0 writes, version unchanged
 *  6 the dual-write final guard (test hook bypasses the planner in batch 2)
 *    aborts batch 2 whole: batch 1 kept, nextCursor = batch 1's end,
 *    stopReason 'aborted'; a rerun from that cursor completes
 *  7 second apply = 0 changes, version unchanged, complete true
 *  8 repair: a migrated, unchanged row whose people doc was dropped → dry-run
 *    reports 1 and writes nothing; apply repairs it with the monolith version
 *    unchanged; a clean rerun writes nothing; a retired people doc of a bound
 *    row is never revived ('person-doc-retired')
 *  8b repair never overwrites a people doc carrying another identity
 *    ('person-doc-mismatch', byte-identical on dry-run and apply); a bound
 *    person's stale name still repairs in place
 *  R response contract: stopReason only done | batch-cap | blocked | aborted
 *    (dry-run, batch-cap via test hook, blocked, completed, aborted covered);
 *    complete false whenever work or conflicts remain
 *  9 coordinator / mashgiach → 403, kiosk token refused; responses carry ids
 *    and reason codes only (no email addresses); agency slug backfilled once
 */
import crypto from 'crypto';

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const key = (e) => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');
const pad = (n) => String(n).padStart(3, '0');

export default {
  name: 'Test 49: identity migrator + projection repair (8c)',
  whatItProves:
    'Agency-scoped, dry-run-by-default, bounded and resumable identity migration that re-decides every row in its transaction, never takes over another identity\'s people doc or email mapping, never revives a retired person, aborts a batch whole at the final guard, and repairs projections without touching the monolith.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = (k) => `agency-t49-${k}-${ts}`;
    const uid = (k, i) => `user-t49-${k}-${pad(i)}-${ts}`;
    const em = (k, i) => `t49-${k}-${pad(i)}-${ts}@test.local`;
    const call = async (method, path, headers, body) => {
      const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const mint = async (userId) => {
      const r = await call('POST', '/api/__test__/mint-token', { 'Content-Type': 'application/json' }, { userId });
      assert(r.status === 200, `mint-token ${r.status}`);
      return r.json.token;
    };
    const hook = async (path, body) => {
      const r = await ctx.api('POST', `/api/__test__/${path}`, body);
      assert(r.status === 200, `${path} ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const bulk = (peopleIds, emails) => hook('identity-docs-bulk', { peopleIds, emails });
    const legacy = (k, i, agencyId) => ({ id: uid(k, i), email: em(k, i), name: `T49 ${k} ${i}`, role: 'mashgiach', agencyId, venueId: `venue-t49-${k}-${ts}`, avatarColor: '#fff', password: '' });

    // ---- setup: agencies A (interrupted), C (uninterrupted twin), D (conflicts),
    // E (final guard), F (all conflicted), B (bystander); legacy rows written
    // directly (pre-8b data), then one commit hydrates the cache.
    const admins = {};
    const fixtureAgencies = [], fixtureVenues = [], fixtureUsers = [];
    for (const k of ['a', 'b', 'd', 'e', 'f']) {
      fixtureAgencies.push({ id: AG(k), name: `T49 ${k.toUpperCase()} ${ts}`, shortCode: `T49${k.toUpperCase()}`, adminEmail: em(k, 900) });
      fixtureVenues.push({ id: `venue-t49-${k}-${ts}`, name: `T49 ${k} venue`, agencyId: AG(k) });
      fixtureUsers.push({ id: uid(k, 900), email: em(k, 900), name: `T49 admin ${k}`, role: 'admin', agencyId: AG(k) });
    }
    fixtureUsers.push({ id: uid('a', 901), email: em('a', 901), name: 'T49 coord', role: 'coordinator', agencyId: AG('a'), venueId: `venue-t49-a-${ts}` });
    fixtureUsers.push({ id: uid('a', 902), email: em('a', 902), name: 'T49 mash', role: 'mashgiach', agencyId: AG('a'), venueId: `venue-t49-a-${ts}` });
    let r = await ctx.api('POST', '/api/__test__/inject-fixture', { agencies: fixtureAgencies, venues: fixtureVenues, users: fixtureUsers });
    assert(r.status === 200, `inject-fixture ${r.status}`);
    const cur = await ctx.getDoc();
    const legacyRows = [];
    for (let i = 1; i <= 250; i++) legacyRows.push(legacy('a', i, AG('a')));
    for (let i = 1; i <= 6; i++) legacyRows.push(legacy('d', i, AG('d')));
    for (let i = 1; i <= 120; i++) legacyRows.push(legacy('e', i, AG('e')));
    for (let i = 1; i <= 3; i++) legacyRows.push(legacy('f', i, AG('f')), legacy('b', i, AG('b')));
    r = await ctx.api('POST', '/api/__test__/doc-set-users', { users: [...(cur.users || []), ...legacyRows] });
    assert(r.status === 200, `doc-set-users ${r.status}`);
    r = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: `venue-t49-h-${ts}`, name: 'T49 hydrate', agencyId: AG('b') }] });
    assert(r.status === 200, `hydrate ${r.status}`);
    for (const k of ['a', 'd', 'e', 'f']) admins[k] = auth(await mint(uid(k, 900)));
    const migrate = (k, body) => call('POST', '/api/admin/identity-migration', admins[k], body);
    const rowOf = (doc, id) => (doc.users || []).find((u) => u.id === id);
    const noEmails = (res, where) => assert(!res.text.includes('@'), `${where}: response carries an email address`);

    // ---- 1. dry-run default / string "true" ----
    let v0 = await ctx.getVersion();
    r = await migrate('a', { step: 'rows' });
    assert(r.status === 200, `dry-run ${r.status} ${r.text}`);
    noEmails(r, 'dry-run');
    // signed contract: a dry-run that walked to the end is 'done'; complete is
    // false because work remains (pending > 0).
    assert(r.json.apply === false && r.json.stopReason === 'done' && r.json.complete === false && r.json.nextCursor === null, `dry-run shape ${r.text}`);
    assert(['done', 'batch-cap', 'blocked', 'aborted'].includes(r.json.stopReason), 'stopReason outside the signed four');
    assert(r.json.counts.rowsMigrated === 250 && r.json.pending === 250 && r.json.blocked === 0 && r.json.batches === 3, `dry-run counts ${r.text}`);
    assert(r.json.slugBackfill === 'would-set', `slug dry-run ${r.json.slugBackfill}`);
    // batch-cap (test hook lowers the 10-batch cap to 1 for one call): stops
    // after batch 1 with the cursor, complete false, nothing written.
    await hook('identity-migration-batch-cap', { maxBatches: 1 });
    r = await migrate('a', { step: 'rows' });
    assert(r.status === 200 && r.json.stopReason === 'batch-cap' && r.json.complete === false && r.json.batches === 1 && r.json.nextCursor === uid('a', 99) && r.json.counts.rowsMigrated === 99, `batch-cap dry-run ${r.text}`);
    r = await migrate('a', { step: 'rows', cursor: uid('a', 99) });
    assert(r.status === 200 && r.json.stopReason === 'done' && r.json.batches === 2 && r.json.counts.rowsMigrated === 151 && r.json.complete === false, `batch-cap resume ${r.text}`);
    r = await migrate('a', { step: 'rows', apply: 'true' });
    assert(r.status === 200 && r.json.apply === false, `apply "true" must be a dry run ${r.text}`);
    assert((await ctx.getVersion()) === v0, 'dry-run changed the version');
    let b = await bulk([uid('a', 1), uid('a', 250)], [em('a', 1)]);
    assert(b.people[uid('a', 1)] === null && b.people[uid('a', 250)] === null && b.emails[em('a', 1)] === null, 'dry-run wrote projections');

    // ---- 9. roles ----
    for (const who of [901, 902]) {
      const t = await mint(uid('a', who));
      const rr = await call('POST', '/api/admin/identity-migration', auth(t), { step: 'rows', apply: true });
      assert(rr.status === 403, `role ${who} must get 403, got ${rr.status}`);
    }
    {
      const kr = await call('POST', '/api/__test__/mint-kiosk-token', { 'Content-Type': 'application/json' }, { userId: uid('a', 900), agencyId: AG('a'), venueId: `venue-t49-a-${ts}` });
      assert(kr.status === 200, `mint-kiosk-token ${kr.status}`);
      const rr = await call('POST', '/api/admin/identity-migration', auth(kr.json.token), { step: 'rows', apply: true });
      assert(rr.status === 401 || rr.status === 403, `kiosk token must be refused, got ${rr.status}`);
    }
    assert((await ctx.getVersion()) === v0, 'refused calls changed the version');

    // ---- 2/3. A interrupted after batch 1, then resumed (the uninterrupted
    // path is E's batch 1 and D/F; the final state is checked row by row) ----
    v0 = await ctx.getVersion();
    await hook('identity-migration-interrupt', { afterBatches: 1 });
    r = await migrate('a', { step: 'rows', apply: true });
    assert(r.status === 500 && r.json.nextCursor === uid('a', 99) && r.json.batches === 1, `interrupt ${r.status} ${r.text}`);
    assert((await ctx.getVersion()) === v0 + 1, 'interrupted call must have committed exactly batch 1');
    let doc = await ctx.getDoc();
    assert(rowOf(doc, uid('a', 99)).personId === uid('a', 99) && !rowOf(doc, uid('a', 100)).personId, 'batch 1 boundary');
    r = await migrate('a', { step: 'rows', apply: true, cursor: uid('a', 99) });
    assert(r.status === 200 && r.json.stopReason === 'done' && r.json.complete === true && r.json.batches === 2 && r.json.counts.rowsMigrated === 151, `resume ${r.text}`);
    assert((await ctx.getVersion()) === v0 + 3, `A version bumps ${(await ctx.getVersion()) - v0} != 3`);
    doc = await ctx.getDoc();
    for (let i = 1; i <= 250; i++) {
      const ra = rowOf(doc, uid('a', i));
      assert(ra.personId === ra.id, `row ${i} not migrated`);
      assert(JSON.stringify(ra.venueAccess) === JSON.stringify([ra.venueId]) && ra.isPrimaryAdmin === false, `row ${i} derived`);
    }
    const sample = [1, 99, 100, 198, 199, 250];
    b = await bulk(sample.map((i) => uid('a', i)), sample.map((i) => em('a', i)));
    for (const i of sample) {
      const pa = b.people[uid('a', i)];
      // exactly one write per doc (_v 1), exact 8b shapes: no double writes across the interruption
      assert(pa && pa.status === 'active' && pa._v === 1 && pa.primaryEmail === em('a', i) && Object.keys(pa).sort().join() === '_v,createdAt,id,name,primaryEmail,status', `people ${i} ${JSON.stringify(pa)}`);
      const ea = b.emails[em('a', i)];
      assert(ea && ea.personId === uid('a', i) && ea.verified === false && ea.source === 'admin-entered' && !ea.previousPersonIds && Object.keys(ea).sort().join() === 'addedAt,personId,source,status,verified', `emails ${i} ${JSON.stringify(ea)}`);
    }
    assert((doc.agencies || []).find((a) => a.id === AG('a')).slug, 'agency A slug backfilled');
    for (let i = 1; i <= 3; i++) assert(!rowOf(doc, uid('b', i)).personId, 'agency B touched');

    // ---- 7. second apply = no change ----
    v0 = await ctx.getVersion();
    r = await migrate('a', { step: 'rows', apply: true });
    assert(r.status === 200 && r.json.stopReason === 'done' && r.json.complete && r.json.counts.rowsMigrated === 0 && r.json.slugBackfill === 'present', `second apply ${r.text}`);
    assert((await ctx.getVersion()) === v0, 'second apply changed the version');

    // ---- 4. conflicts decided in the transaction (D) ----
    r = await migrate('d', { step: 'rows' });
    assert(r.json.counts.rowsMigrated === 6 && r.json.blocked === 0, `D dry-run ${r.text}`);
    await hook('identity-doc', { collection: 'emails', id: key(em('d', 2)), data: { personId: 'someone-else', status: 'active', verified: false, source: 'admin-entered', addedAt: 'x' } });
    const retiredP = { id: uid('d', 3), name: 'Old identity', primaryEmail: 'old@elsewhere.test', status: 'retired', retiredAt: 'x', createdAt: 'x', _v: 4 };
    await hook('identity-doc', { collection: 'people', id: uid('d', 3), data: retiredP });
    r = await migrate('d', { step: 'rows', apply: true });
    noEmails(r, 'D apply');
    assert(r.status === 200 && r.json.stopReason === 'blocked' && r.json.complete === false && r.json.nextCursor === null && r.json.blocked === 2, `D apply ${r.text}`);
    assert(r.json.counts.rowsMigrated === 4, `D migrated ${r.json.counts.rowsMigrated}`);
    const dc = Object.fromEntries(r.json.conflicts.map((c) => [c.userId, c.reason]));
    assert(dc[uid('d', 2)] === 'email-active-other-person' && dc[uid('d', 3)] === 'person-doc-exists', `D conflicts ${JSON.stringify(r.json.conflicts)}`);
    doc = await ctx.getDoc();
    assert(!rowOf(doc, uid('d', 2)).personId && !rowOf(doc, uid('d', 3)).personId && rowOf(doc, uid('d', 4)).personId, 'D rows');
    b = await bulk([uid('d', 2), uid('d', 3)], [em('d', 2)]);
    assert(JSON.stringify(b.people[uid('d', 3)]) === JSON.stringify(retiredP), 'retired people doc must be byte-identical');
    assert(b.people[uid('d', 2)] === null && b.emails[em('d', 2)].personId === 'someone-else', 'nothing written for conflicted rows');
    // resolve, then a no-cursor rerun finishes
    await hook('identity-doc', { collection: 'emails', id: key(em('d', 2)), data: { personId: 'someone-else', status: 'retired', verified: false, source: 'admin-entered', addedAt: 'x' } });
    await hook('identity-doc', { collection: 'people', id: uid('d', 3), data: null });
    r = await migrate('d', { step: 'rows', apply: true });
    assert(r.json.stopReason === 'done' && r.json.complete && r.json.counts.rowsMigrated === 2, `D rerun ${r.text}`);
    b = await bulk([], [em('d', 2)]);
    assert(b.emails[em('d', 2)].personId === uid('d', 2) && JSON.stringify(b.emails[em('d', 2)].previousPersonIds) === '["someone-else"]', 'retired mapping reassigned with history');

    // ---- 5. all conflicted (F) ----
    for (let i = 1; i <= 3; i++) await hook('identity-doc', { collection: 'people', id: uid('f', i), data: { id: uid('f', i), status: 'retired', name: 'x', primaryEmail: 'x', createdAt: 'x', _v: 1 } });
    v0 = await ctx.getVersion();
    r = await migrate('f', { step: 'rows', apply: true });
    assert(r.json.stopReason === 'blocked' && r.json.complete === false && r.json.blocked === 3 && r.json.counts.rowsMigrated === 0 && r.json.nextCursor === null, `F ${r.text}`);
    // (the slug backfill may write once; no row may change)
    doc = await ctx.getDoc();
    for (let i = 1; i <= 3; i++) assert(!rowOf(doc, uid('f', i)).personId, 'F row migrated');
    r = await migrate('f', { step: 'rows', apply: true });
    const vF = await ctx.getVersion();
    r = await migrate('f', { step: 'rows', apply: true });
    assert((await ctx.getVersion()) === vF && r.json.stopReason === 'blocked', 'all-conflicted rerun wrote');

    // ---- 6. final guard aborts batch 2 whole (E) ----
    await hook('identity-doc', { collection: 'people', id: uid('e', 110), data: { id: uid('e', 110), status: 'active', name: 'other', primaryEmail: 'o@elsewhere.test', createdAt: 'x', _v: 1 } });
    await hook('identity-migration-bypass-plan', { atBatch: 2 });
    v0 = await ctx.getVersion();
    r = await migrate('e', { step: 'rows', apply: true });
    assert(r.status === 200 && r.json.stopReason === 'aborted' && r.json.abortReason === 'identity-guard' && r.json.complete === false, `E abort ${r.text}`);
    assert(r.json.nextCursor === uid('e', 99) && r.json.batches === 1 && r.json.counts.rowsMigrated === 99, `E cursor ${r.text}`);
    assert((await ctx.getVersion()) === v0 + 1, 'aborted batch must not bump the version');
    doc = await ctx.getDoc();
    assert(rowOf(doc, uid('e', 99)).personId && !rowOf(doc, uid('e', 100)).personId && !rowOf(doc, uid('e', 120)).personId, 'batch 2 partially applied');
    await hook('identity-doc', { collection: 'people', id: uid('e', 110), data: null });
    r = await migrate('e', { step: 'rows', apply: true, cursor: uid('e', 99) });
    assert(r.json.stopReason === 'done' && r.json.complete && r.json.counts.rowsMigrated === 21, `E rerun ${r.text}`);

    // ---- 8. repair (A) ----
    await hook('identity-doc', { collection: 'people', id: uid('a', 7), data: null });
    v0 = await ctx.getVersion();
    r = await migrate('a', { step: 'repair' });
    assert(r.status === 200 && r.json.counts.projectionsRepaired === 1 && r.json.pending === 1 && r.json.stopReason === 'done' && r.json.complete === false, `repair dry-run ${r.text}`);
    b = await bulk([uid('a', 7)], []);
    assert(b.people[uid('a', 7)] === null, 'repair dry-run wrote');
    r = await migrate('a', { step: 'repair', apply: true });
    assert(r.json.stopReason === 'done' && r.json.complete && r.json.counts.projectionsRepaired === 1, `repair apply ${r.text}`);
    assert((await ctx.getVersion()) === v0, 'repair must never write the monolith');
    b = await bulk([uid('a', 7)], [em('a', 7)]);
    assert(b.people[uid('a', 7)]?.status === 'active' && b.people[uid('a', 7)].primaryEmail === em('a', 7) && b.emails[em('a', 7)]?.personId === uid('a', 7), 'repaired docs');
    r = await migrate('a', { step: 'repair', apply: true });
    assert(r.json.counts.projectionsRepaired === 0 && r.json.stopReason === 'done' && (await ctx.getVersion()) === v0, `clean repair rerun ${r.text}`);
    const pRet = { ...b.people[uid('a', 7)], status: 'retired', retiredAt: 'x' };
    await hook('identity-doc', { collection: 'people', id: uid('a', 7), data: pRet });
    r = await migrate('a', { step: 'repair', apply: true });
    assert(r.json.stopReason === 'blocked' && r.json.conflicts.some((c) => c.userId === uid('a', 7) && c.reason === 'person-doc-retired'), `retired bound person ${r.text}`);
    b = await bulk([uid('a', 7)], []);
    assert(b.people[uid('a', 7)].status === 'retired', 'retired person revived by repair');
    await hook('identity-doc', { collection: 'people', id: uid('a', 7), data: { ...pRet, status: 'active', retiredAt: undefined } });

    // repair never overwrites a people doc that carries ANOTHER identity
    // (active, embedded id of someone else) → 'person-doc-mismatch', byte-identical.
    const foreign = { id: `person-other-${ts}`, name: 'Someone Else', primaryEmail: 'someone@else.test', status: 'active', createdAt: 'y', _v: 4 };
    await hook('identity-doc', { collection: 'people', id: uid('a', 8), data: foreign });
    const before8 = JSON.stringify((await bulk([uid('a', 8)], [])).people[uid('a', 8)]);
    for (const apply of [false, true]) {
      r = await migrate('a', { step: 'repair', apply });
      assert(r.status === 200 && r.json.stopReason === 'blocked' && r.json.complete === false && r.json.conflicts.some((c) => c.userId === uid('a', 8) && c.reason === 'person-doc-mismatch'), `mismatch ${apply} ${r.text}`);
      noEmails(r, `mismatch ${apply}`);
      assert(JSON.stringify((await bulk([uid('a', 8)], [])).people[uid('a', 8)]) === before8, `foreign people doc changed by repair (apply ${apply})`);
    }
    assert((await ctx.getVersion()) === v0, 'mismatch repair wrote the monolith');
    // ordinary stale fields on a correctly bound person still repair
    await hook('identity-doc', { collection: 'people', id: uid('a', 8), data: { id: uid('a', 8), name: 'old name', primaryEmail: em('a', 8), status: 'active', createdAt: 'z', _v: 2 } });
    r = await migrate('a', { step: 'repair', apply: true });
    assert(r.json.stopReason === 'done' && r.json.complete === true && r.json.counts.projectionsRepaired === 1, `bound stale repair ${r.text}`);
    b = await bulk([uid('a', 8)], []);
    assert(b.people[uid('a', 8)].name === rowOf(await ctx.getDoc(), uid('a', 8)).name && b.people[uid('a', 8)]._v === 3 && b.people[uid('a', 8)].createdAt === 'z', 'bound stale person not repaired in place');

    // bad input
    r = await migrate('a', { step: 'everything', apply: true });
    assert(r.status === 400, `bad step ${r.status}`);
    doc = await ctx.getDoc();
    for (let i = 1; i <= 3; i++) assert(!rowOf(doc, uid('b', i)).personId, 'agency B touched at the end');
  },
};
