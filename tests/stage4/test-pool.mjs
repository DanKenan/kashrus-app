/** Item 12, 12b-s unit tests: 2-week venue history, move-to-pool, make-main, Pool contacts and in-agency duplicates. */
import { applyGrantOps, retainedHistory, historyNeedsPrune, historyEntryRetained, HISTORY_RETENTION_MS, HISTORY_CAP, moveToPoolFields, makeMainFields, lastVenueOf, closeAllExtras, shedOldestHistory } from '../../src/server/venue-grants.ts';
import { parsePoolContact, poolContactView, findPoolDuplicates, dropContactsForAcceptedInvites, revokeLinkedInvite, isPoolInvite, agencyContacts } from '../../src/server/pool.ts';
import { parseInviteInput, parseMemberInvite } from '../../src/server/invites.ts';
let n = 0; const ok = (c, m) => { if (!c) throw new Error(m); n++; };
const J = JSON.stringify;
const DAY = 86400000;
const T0 = Date.parse('2026-10-23T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const U = '2026-10-24T04:00:00.000Z';
const ctx = (o = {}) => ({ nowMs: T0, actor: 'adm', agencyVenueIds: new Set(['v1', 'v2', 'v3']), zoneFor: () => 'America/New_York', ...o });
const m = (o) => ({ id: 'u1', role: 'mashgiach', agencyId: 'A', venueId: 'v1', personId: 'p1', venueAccess: ['v1', 'v2'], ...o });
const h = (v, toMs, why = 'unticked') => ({ venueId: v, from: null, to: iso(toMs), why, by: null });
const phone = (raw) => { const p = String(raw ?? '').replace(/[\s\-().]/g, ''); if (!p) return { ok: true, value: undefined }; if (/^\d{10}$/.test(p)) return { ok: true, value: '+1' + p }; if (/^\+[1-9]\d{6,14}$/.test(p)) return { ok: true, value: p }; return { ok: false }; };

const run = async function () {
  // ===== 2-week venue history (Don, Oct 23 4:16 AM) =====
  ok(HISTORY_RETENTION_MS === 14 * DAY, 'retention is 14 days');
  ok(historyEntryRetained(h('v2', T0 - 14 * DAY + 1), T0), '14 days minus 1 ms: kept');
  ok(!historyEntryRetained(h('v2', T0 - 14 * DAY), T0), 'exactly 14 days: dropped');
  ok(!historyEntryRetained(h('v2', T0 - 30 * DAY), T0), '30 days: dropped');
  ok(!historyEntryRetained({ venueId: 'v2', to: 'x' }, T0) && !historyEntryRetained(null, T0), 'unparsable / malformed: dropped');
  const mixed = m({ venueGrants: {}, venueRev: 4, venueHistory: [h('v3', T0 - DAY), h('v2', T0 - 13 * DAY), h('v3', T0 - 15 * DAY), h('v2', T0 - 40 * DAY)] });
  ok(J(retainedHistory(mixed, T0).map((e) => e.to)) === J([iso(T0 - DAY), iso(T0 - 13 * DAY)]), 'retainedHistory keeps the last 2 weeks, newest first');
  ok(historyNeedsPrune(mixed, T0) && !historyNeedsPrune(m({ venueHistory: [h('v2', T0 - DAY)] }), T0) && !historyNeedsPrune(m({}), T0), 'historyNeedsPrune');
  ok(historyNeedsPrune(m({ venueHistory: 'junk' }), T0), 'a non-array history is pruned');
  let r = applyGrantOps(mixed, [{ op: 'remove', venueId: 'v2' }], ctx());
  ok(r.ok && r.fields.venueHistory.length === 3 && r.fields.venueHistory[0].why === 'unticked' && r.fields.venueHistory.every((e) => Date.parse(e.to) > T0 - 14 * DAY), `the one writer drops old entries ${J(r.fields.venueHistory)}`);
  r = applyGrantOps(mixed, [], ctx());
  ok(r.ok && r.changed === false && r.fields.venueRev === 4 && r.fields.venueHistory.length === 2, 'normalization alone: history pruned, no venueRev bump');
  const c = closeAllExtras(mixed, 'v3', 'unticked', T0);
  ok(c.venueHistory.length === 3 && c.venueHistory.every((e) => Date.parse(e.to) > T0 - 14 * DAY), 'closeAllExtras drops old entries');
  // a 20-day-old row with nothing recent: history disappears
  ok(retainedHistory(m({ venueHistory: [h('v2', T0 - 20 * DAY), h('v3', T0 - 21 * DAY)] }), T0).length === 0, 'all old -> empty');
  // cap still 10
  const many = m({ venueHistory: Array.from({ length: 15 }, (_, i) => h('v2', T0 - i * 3600000)) });
  ok(retainedHistory(many, T0).length === HISTORY_CAP, 'cap 10 still holds');

  // ===== near the size guard: OLDEST entries go first, only as many as needed (no wipe-all) =====
  const rowsA = [
    { id: 'a', venueHistory: [h('v2', T0 - 1 * DAY), h('v3', T0 - 9 * DAY)] },
    { id: 'b', venueHistory: [h('v2', T0 - 2 * DAY), h('v3', T0 - 10 * DAY), h('v1', T0 - 12 * DAY)] },
    { id: 'c' },
  ];
  const one = JSON.stringify(rowsA[0].venueHistory[0]).length + 1;
  let sh = shedOldestHistory(rowsA, one);
  ok(sh.dropped === 2 && J(sh.users[1].venueHistory.map((e) => e.venueId)) === J(['v2']) && J(sh.users[0].venueHistory.map((e) => e.venueId)) === J(['v2', 'v3']), `the two oldest entries go first ${J(sh.users)}`);
  ok(sh.users[2] === rowsA[2] && sh.users[0] === rowsA[0], 'untouched rows are the same objects');
  sh = shedOldestHistory(rowsA, 10 * one);
  ok(sh.dropped === 5 && !('venueHistory' in sh.users[0]) && !('venueHistory' in sh.users[1]), 'everything only when that much room is needed');
  ok(shedOldestHistory(rowsA, 0).dropped === 0 && shedOldestHistory(rowsA, -5).users === rowsA, 'nothing over -> nothing dropped');
  ok(J(rowsA[1].venueHistory.length) === '3', 'input not mutated');

  // ===== move-to-pool (5.3) =====
  const dated = m({ venueAccess: ['v1', 'v2', 'v3'], venueGrants: { v2: { from: iso(T0 - DAY), until: U, by: 'adm' } }, venueRev: 2 });
  r = moveToPoolFields(dated, ctx());
  ok(r.ok && r.fields.venueId === '' && r.fields.noHomeVenue === true && J(r.fields.venueAccess) === J([]) && !r.fields.venueGrants && r.fields.venueRev === 3 && r.growth === false, `move-to-pool fields ${J(r)}`);
  ok(J(r.fields.venueHistory.map((e) => [e.venueId, e.why])) === J([['v1', 'moved_to_pool'], ['v2', 'moved_to_pool'], ['v3', 'moved_to_pool']]) && r.fields.venueHistory[1].from === iso(T0 - DAY) && r.fields.venueHistory[0].by === 'adm', 'home + every extra closed into history');
  ok(J(r.closed.map((x) => x.venueId).sort()) === J(['v1', 'v2', 'v3']), 'closed lists all three');
  r = moveToPoolFields(m({ venueId: '', noHomeVenue: true, venueAccess: [], venueRev: 1 }), ctx());
  ok(!r.ok && r.code === 'ALREADY_IN_POOL' && r.status === 409, 'already in the Pool -> 409');
  r = moveToPoolFields(m({ venueId: '', noHomeVenue: true, venueAccess: ['v2'], venueGrants: { v2: { from: null, until: U, by: 'x' } }, venueRev: 1 }), ctx());
  ok(r.ok && J(r.fields.venueAccess) === J([]) && r.fields.venueHistory[0].venueId === 'v2', 'a ticked Pool member: the tick closes');
  r = moveToPoolFields(m({ venueAccess: ['v1', 'v2'], venueGrants: { v2: { from: null, until: iso(T0 - 1), by: 'x' } }, venueRev: 1 }), ctx());
  ok(r.ok && r.fields.venueHistory.some((e) => e.venueId === 'v2' && e.why === 'ended') && r.fields.venueHistory.some((e) => e.venueId === 'v1' && e.why === 'moved_to_pool'), 'an already-expired tick is recorded as ended, not moved');

  // ===== make-main (5.4) =====
  r = makeMainFields(dated, 'v2', false, ctx());
  ok(r.ok && r.fields.venueId === 'v2' && J(r.fields.venueAccess) === J(['v2', 'v3']) && !r.fields.venueGrants && !r.fields.noHomeVenue && r.fields.venueRev === 3, `make-main v2 without keeping v1 ${J(r.fields)}`);
  ok(r.fields.venueHistory[0].venueId === 'v2' && r.fields.venueHistory[0].why === 'made_main' && r.fields.venueHistory[1].venueId === 'v1' && r.fields.venueHistory[1].why === 'main_replaced', 'history: made_main + main_replaced');
  ok(r.growth === true, 'a dated tick becoming the (undated) main venue counts as growth');
  r = makeMainFields(dated, 'v2', true, ctx());
  ok(r.ok && J(r.fields.venueAccess) === J(['v2', 'v3', 'v1']) && !(r.fields.venueGrants || {}).v1 && r.fields.venueHistory.length === 1, 'keep old main as an UNDATED extra');
  const dated3 = m({ venueAccess: ['v1', 'v2', 'v3'], venueGrants: { v3: { from: null, until: U, by: 'adm' } }, venueRev: 2 });
  r = makeMainFields(dated3, 'v2', true, ctx());
  ok(r.ok && r.fields.venueGrants.v3.until === U && r.growth === false, 'other extras keep their dates; an undated extra becoming main is not growth');
  r = makeMainFields(dated, 'v1', true, ctx());
  ok(!r.ok && r.code === 'ALREADY_MAIN', 'already main -> 409');
  r = makeMainFields(dated, 'vb', true, ctx());
  ok(!r.ok && r.code === 'VENUE_NOT_IN_AGENCY', 'another agency venue -> 400');
  const pooled = m({ venueId: '', noHomeVenue: true, venueAccess: ['v3'], venueGrants: { v3: { from: null, until: U, by: 'x' } }, venueRev: 5 });
  r = makeMainFields(pooled, 'v3', true, ctx());
  ok(r.ok && r.fields.venueId === 'v3' && J(r.fields.venueAccess) === J(['v3']) && !r.fields.noHomeVenue && r.fields.venueRev === 6 && r.fields.venueHistory[0].why === 'made_main', 'Pool member -> main venue (keep flag ignored, no old main)');
  r = makeMainFields(pooled, 'v1', false, ctx());
  ok(r.ok && J(r.fields.venueAccess) === J(['v1', 'v3']) && r.fields.venueGrants.v3.until === U && r.growth === true, 'Pool member -> a new main, the tick stays');

  // ===== lastVenueOf =====
  ok(J(lastVenueOf(m({ venueHistory: [{ venueId: '', from: null, to: iso(T0 - DAY), why: 'joined_pool', by: null }, h('v2', T0 - 2 * DAY)] }), T0)) === J({ venueId: 'v2', to: iso(T0 - 2 * DAY) }), 'last venue skips the joined_pool marker');
  ok(lastVenueOf(m({ venueHistory: [h('v2', T0 - 20 * DAY)] }), T0) === null, 'last venue respects the 2 weeks');

  // ===== contacts: parsing =====
  let p = parsePoolContact({ name: '  Yossi   Katz ', email: ' Y@Ex.com ', phone: '(860) 555-0101', note: 'nights' }, phone, false);
  ok(p.ok && p.value.name === 'Yossi Katz' && p.value.email === 'y@ex.com' && p.value.phone === '+18605550101' && p.value.note === 'nights', `parse ${J(p)}`);
  ok(parsePoolContact({ name: '' }, phone, false).code === 'POOL_NAME_INVALID', 'name required');
  ok(parsePoolContact({ name: 'x'.repeat(81) }, phone, false).code === 'POOL_NAME_INVALID', 'name <= 80');
  ok(parsePoolContact({ name: 'A', email: 'nope' }, phone, false).code === 'POOL_EMAIL_INVALID', 'bad email');
  ok(parsePoolContact({ name: 'A', phone: '12' }, phone, false).code === 'POOL_PHONE_INVALID', 'bad phone');
  ok(parsePoolContact({ name: 'A', note: 'x'.repeat(141) }, phone, false).code === 'POOL_NOTE_INVALID', 'note <= 140');
  p = parsePoolContact({ email: '', note: null }, phone, true);
  ok(p.ok && p.value.name === undefined && J(p.value.clear.sort()) === J(['email', 'note']), 'PATCH: only sent keys; empty clears');
  // ===== view allowlist =====
  const stored = { id: 'pc1', agencyId: 'A', name: 'Yossi', email: 'y@ex.com', phone: '+18605550101', note: 'n', status: 'invited', inviteId: 'inv1', createdBy: 'adm', createdAt: 'c', updatedAt: 'u', secretish: 'zzz' };
  const live = { id: 'inv1', agencyId: 'A', kind: 'member', status: 'pending', expiresAt: iso(T0 + DAY), email: 'y@ex.com', role: 'mashgiach', venueIds: [] };
  let v = poolContactView(stored, [live], T0);
  ok(J(Object.keys(v).sort()) === J(['createdAt', 'email', 'id', 'name', 'note', 'phone', 'status', 'updatedAt']), `view is an allowlist ${J(v)}`);
  v = poolContactView(stored, [{ ...live, expiresAt: iso(T0 - 1) }], T0);
  ok(v.inviteExpired === true, 'expired invite -> inviteExpired');
  ok(poolContactView(stored, [{ ...live, agencyId: 'B' }], T0).inviteExpired === true, 'an invite of another agency never counts');
  ok(isPoolInvite(live) && !isPoolInvite({ ...live, venueIds: ['v1'] }) && !isPoolInvite({ ...live, role: 'admin' }) && !isPoolInvite({ ...live, kind: 'setup' }), 'isPoolInvite');

  // ===== duplicates (5.7) =====
  const doc = {
    users: [{ id: 'r1', agencyId: 'A', email: 'Row@Ex.com', name: 'Row Person', phoneNumber: '+18605550001' }, { id: 'rb', agencyId: 'B', email: 'other@ex.com', name: 'B person', phoneNumber: '+18605550009' }],
    invites: [live, { id: 'inv2', agencyId: 'A', kind: 'member', status: 'pending', expiresAt: iso(T0 - 1), email: 'old@ex.com', role: 'mashgiach', venueIds: [] }],
    poolContacts: [stored, { id: 'pc2', agencyId: 'A', name: 'Dov', email: 'dov@ex.com', phone: '+18605550002', status: 'details' }, { id: 'pcb', agencyId: 'B', name: 'B c', email: 'bc@ex.com', status: 'details' }],
  };
  let d = findPoolDuplicates(doc, 'A', { email: 'row@ex.com' }, {}, T0);
  ok(d.email?.kind === 'member' && d.email.displayName === 'Row Person', 'email on a row: hard');
  d = findPoolDuplicates(doc, 'A', { email: 'y@ex.com' }, {}, T0);
  ok(d.email?.kind === 'invite', 'email on a live invite: hard');
  d = findPoolDuplicates(doc, 'A', { email: 'y@ex.com' }, { contactId: 'pc1', inviteId: 'inv1' }, T0);
  ok(d.email === null, 'self-exclusion: own contact + own invite never conflict');
  d = findPoolDuplicates(doc, 'A', { email: 'dov@ex.com' }, {}, T0);
  ok(d.email?.kind === 'contact' && d.email.displayName === 'Dov', 'email on another contact: hard');
  ok(findPoolDuplicates(doc, 'A', { email: 'old@ex.com' }, {}, T0).email === null, 'an expired invite is no duplicate');
  ok(findPoolDuplicates(doc, 'A', { email: 'other@ex.com', phone: '+18605550009' }, {}, T0).email === null && findPoolDuplicates(doc, 'A', { phone: '+18605550009' }, {}, T0).phone === null, 'another agency: nothing checked or revealed');
  ok(findPoolDuplicates(doc, 'A', { email: 'bc@ex.com' }, {}, T0).email === null, "another agency's contact: nothing");
  d = findPoolDuplicates(doc, 'A', { phone: '+18605550001' }, {}, T0);
  ok(d.phone?.kind === 'member' && d.email === null, 'phone on a row: soft');
  ok(findPoolDuplicates(doc, 'A', { phone: '+18605550002' }, { contactId: 'pc2' }, T0).phone === null, 'phone self-exclusion');
  ok(findPoolDuplicates(doc, 'A', { phone: '+18605550002' }, {}, T0).phone?.kind === 'contact', 'phone on a contact');
  ok(agencyContacts(doc, 'A').length === 2 && agencyContacts({ poolContacts: [null, { id: 'x' }, ...doc.poolContacts] }, 'B').length === 1, 'agencyContacts scoped + malformed skipped');

  // ===== lifecycle helpers =====
  let rv = revokeLinkedInvite(doc.invites, stored, 'adm', T0, 'contact-edited');
  ok(rv.revoked === 'inv1' && rv.invites[0].status === 'revoked' && rv.invites[0].revokeReason === 'contact-edited' && rv.invites[1].status === 'pending', 'the linked live invite is revoked, others untouched');
  ok(revokeLinkedInvite(doc.invites, { ...stored, agencyId: 'B' }, 'adm', T0, 'x').revoked === null, 'never another agency invite');
  let after = dropContactsForAcceptedInvites({ ...doc, invites: [{ ...live, status: 'accepted' }] });
  ok(after.poolContacts.length === 2 && !after.poolContacts.some((c) => c.id === 'pc1'), 'accept removes the linked contact');
  after = dropContactsForAcceptedInvites({ ...doc, invites: [{ ...live, status: 'accepted', agencyId: 'B' }] });
  ok(after.poolContacts.length === 3, 'an accepted invite of another agency removes nothing');
  ok(dropContactsForAcceptedInvites(doc) === doc, 'nothing accepted -> same object');

  // ===== invites with "pool": true =====
  let ip = parseInviteInput({ email: 'p@ex.com', role: 'mashgiach', pool: true }, ['v1']);
  ok(ip.ok && J(ip.value.venueIds) === J([]), 'pool invite: no venues');
  ok(parseInviteInput({ email: 'p@ex.com', role: 'mashgiach', pool: true, venueIds: ['v1'] }, ['v1']).ok === false, 'pool + venues -> refused');
  ok(parseInviteInput({ email: 'p@ex.com', role: 'coordinator', pool: true }, ['v1']).code === 'POOL_ROLE_INVALID', 'only mashgichim in the Pool');
  ok(parseInviteInput({ email: 'p@ex.com', role: 'mashgiach', venueIds: [] }, ['v1']).ok === false, 'without the flag the old shape stays required');
  ok(parseMemberInvite({ email: 'p@ex.com', name: 'P', role: 'owner', pool: true }, ['v1'], { allowOwner: true, normalizePhone: phone, phoneError: 'x' }).code === 'POOL_ROLE_INVALID', 'no Pool owners');
  console.log(`pool (12b-s): ${n}/${n} passed`);
};
export default { name: 'pool (12b-s)', whatItProves: 'Venue history keeps 2 weeks (exclusive boundary) in every writer; move-to-pool and make-main produce the planned grant fields; contacts validate and leave only through an allowlist; duplicates are in-agency only with self-exclusion (email hard, phone soft); accept/revoke bookkeeping; "pool": true invites.', run };
