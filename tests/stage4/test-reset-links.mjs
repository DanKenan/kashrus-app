/**
 * Item 10L: reset-link helpers (unit, pure) + the resetSuspended writer
 * invariant in enforceIdentityFields + backup scrub of the hash and stamp.
 */
import crypto from 'node:crypto';
import {
  newResetToken, hashResetToken, resetTokenMatches, resetLinkForToken, credentialStampHash, stampsEqual, isLiveResetLink,
  resetLinkAdminView, pruneResetLinks, makeRoomForResetLink, mayMakeResetLink, resetSuspensionRecord,
  RESET_LINK_TTL_MS, RESET_LINK_RETENTION_MS,
} from '../../src/server/reset-links.ts';
import { enforceIdentityFields, stripServerOnlyUserFields, SERVER_ONLY_USER_FIELDS } from '../../src/server/identity.ts';
import { scrubSecrets, isSecretKey } from '../../src/server/backup.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

export default {
  name: 'Item 10L: reset-link helpers + resetSuspended writer (unit)',
  whatItProves: '32-byte base64url tokens stored as sha256 only; the credential stamp changes with the owner row or its stored hash; live/expired; the admin view has no hash, stamp or email; retention and the 1000 ceiling never drop live links; P1 matrix (no admin targets, coordinators only for their own existing venues); resetSuspended has two sanctioned writers and every forged change is restored; backups redact resetTokenHash and credentialStampHash.',
  async run() {
    // tokens
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const { raw, hash } = newResetToken();
      assert(/^[A-Za-z0-9_-]{43}$/.test(raw), `token shape ${raw}`);
      assert(hash === crypto.createHash('sha256').update(raw).digest('hex') && hash === hashResetToken(raw), 'sha256');
      seen.add(raw);
    }
    assert(seen.size === 300, 'distinct tokens');
    const tk = newResetToken();
    assert(resetTokenMatches(tk.hash, tk.raw) && !resetTokenMatches(tk.hash, newResetToken().raw) && !resetTokenMatches(undefined, tk.raw) && !resetTokenMatches(tk.hash, ''), 'match');
    const list = [{ id: 'rst_1', resetTokenHash: tk.hash }, { id: 'rst_2', resetTokenHash: hashResetToken('x') }];
    assert(resetLinkForToken(list, tk.raw)?.id === 'rst_1' && resetLinkForToken(list, 'short') === null && resetLinkForToken(list, newResetToken().raw) === null, 'lookup by token');

    // credential stamp [DS1 B3]
    const s1 = credentialStampHash('u1', '$2a$10$abc');
    assert(typeof s1 === 'string' && s1.length === 64, 'stamp hex');
    assert(s1 === credentialStampHash('u1', '$2a$10$abc') && s1 !== credentialStampHash('u2', '$2a$10$abc') && s1 !== credentialStampHash('u1', '$2a$10$abd'), 'stamp depends on owner + hash');
    assert(credentialStampHash('u1', '') === null && credentialStampHash('u1', undefined) === null && credentialStampHash('', 'x') === null, 'no password -> null');
    assert(stampsEqual(s1, s1) && !stampsEqual(s1, credentialStampHash('u1', 'p')) && !stampsEqual(null, null), 'stampsEqual');

    // live + views
    const now = Date.parse('2026-10-22T12:00:00Z');
    const iso = (ms) => new Date(ms).toISOString();
    const live = { id: 'rst_l', status: 'pending', expiresAt: iso(now + 1000), memberId: 'm', createdBy: 'a', createdAt: iso(now - 1000), resetTokenHash: 'h', credentialStampHash: 's', email: 'e@x.y', credentialOwnerId: 'm' };
    assert(isLiveResetLink(live, now) && !isLiveResetLink({ ...live, expiresAt: iso(now - 1) }, now) && !isLiveResetLink({ ...live, status: 'used' }, now) && !isLiveResetLink(null, now), 'live');
    const view = resetLinkAdminView(live);
    assert(J(Object.keys(view).sort()) === J(['createdAt', 'createdBy', 'expiresAt', 'id', 'memberId']), `admin view keys ${J(Object.keys(view))}`);
    assert(!J(view).includes('e@x.y') && !('resetTokenHash' in view) && !('credentialStampHash' in view), 'admin view: no hash, stamp or email');
    assert(RESET_LINK_TTL_MS === 24 * 3600 * 1000 && RESET_LINK_RETENTION_MS === 7 * 24 * 3600 * 1000, 'ttl 24 h, retention 7 d');

    // retention [DS1 N4]
    const used = (id, at) => ({ id, status: 'used', usedAt: iso(at), expiresAt: iso(at + 1000) });
    const kept = pruneResetLinks([live, used('old', now - 8 * 86400000), used('new', now - 86400000), { id: 'bad', status: 'used', usedAt: 'x' }, { id: 'exp', status: 'pending', expiresAt: iso(now - 8 * 86400000) }, { status: 'pending' }], now).map((l) => l.id);
    assert(J(kept) === J(['rst_l', 'new', 'bad']), `prune ${J(kept)}`);
    // ceiling: oldest non-live dropped first; live never
    const many = [];
    for (let i = 0; i < 5; i++) many.push(used(`u${i}`, now - (i + 1) * 1000));
    for (let i = 0; i < 5; i++) many.push({ ...live, id: `l${i}` });
    const r1 = makeRoomForResetLink(many, now, 10);
    assert(r1.ok && r1.list.length === 9 && !r1.list.some((l) => l.id === 'u4') && r1.list.filter((l) => l.id.startsWith('l')).length === 5, `ceiling drop oldest ${J(r1.list.map((l) => l.id))}`);
    const allLive = Array.from({ length: 10 }, (_, i) => ({ ...live, id: `x${i}` }));
    const r2 = makeRoomForResetLink(allLive, now, 10);
    assert(!r2.ok && r2.list.length === 10, 'full of live links -> refused, nothing dropped');
    assert(makeRoomForResetLink([], now, 10).ok, 'empty ok');

    // P1 matrix ([DS1 B2], [DS1 N1], Don 2026-10-22)
    const venues = [{ id: 'v1', agencyId: 'A' }, { id: 'v2', agencyId: 'A' }, { id: 'vb', agencyId: 'B' }];
    const ad = { id: 'ad', role: 'admin', agencyId: 'A' };
    const ad2 = { id: 'ad2', role: 'admin', agencyId: 'A' };
    const prim = { id: 'prim', role: 'admin', agencyId: 'A', isPrimaryAdmin: true };
    const co1 = { id: 'co1', role: 'coordinator', agencyId: 'A', venueId: 'v1' };
    const co2 = { id: 'co2', role: 'coordinator', agencyId: 'A', venueId: 'v2' };
    const coMulti = { id: 'com', role: 'coordinator', agencyId: 'A', venueId: 'v2', personId: 'com', venueAccess: ['v2', 'v1'] };
    const coGone = { id: 'cog', role: 'coordinator', agencyId: 'A', venueId: 'v-deleted' };
    const m1 = { id: 'm1', role: 'mashgiach', agencyId: 'A', venueId: 'v1' };
    const o1 = { id: 'o1', role: 'owner', agencyId: 'A', venueId: 'v1' };
    const m2 = { id: 'm2', role: 'mashgiach', agencyId: 'A', venueId: 'v2' };
    const mGone = { id: 'mg', role: 'mashgiach', agencyId: 'A', venueId: 'v-deleted' };
    const mForeign = { id: 'mf', role: 'mashgiach', agencyId: 'A', venueId: 'vb' };
    const mB = { id: 'mb', role: 'mashgiach', agencyId: 'B', venueId: 'vb' };
    const op = { id: 'usr_admin', role: 'mashgiach', agencyId: 'A', venueId: 'v1' };
    const may = (c, t) => mayMakeResetLink(c, t, venues, { platformOperatorId: 'usr_admin' });
    const cases = [
      [ad, m1, true], [ad, o1, true], [ad, co1, true], [ad, mGone, true],
      [ad, ad2, false], [ad, prim, false], [ad2, prim, false], [prim, ad, false], [ad, ad, false], [ad, mB, false], [ad, op, false],
      [co1, m1, true], [co1, o1, true], [co1, m2, false], [co1, co2, false], [co1, ad, false], [co1, co1, false], [co1, mGone, false], [co1, mForeign, false], [co1, op, false],
      [coMulti, m1, true], [coMulti, m2, true], [coGone, mGone, false], [coGone, m1, false],
      [m1, o1, false], [o1, m1, false], [null, m1, false], [ad, null, false],
      [{ ...co1, agencyId: 'B' }, m1, false],
    ];
    for (const [c, t, want] of cases) assert(may(c, t) === want, `may(${c?.id}, ${t?.id}) = ${!want}`);
    assert(!may(ad, { ...m1, role: 'admin' }) && !may(ad, { ...m1, isPrimaryAdmin: true }) && !may(ad, { ...m1, role: 'superuser' }) && !may(ad, { ...m1, role: undefined }), 'unknown / admin roles never');

    // resetSuspended: server-only, two sanctioned writers, forged changes restored ([DS1 B4], [DS2 N1])
    assert(SERVER_ONLY_USER_FIELDS.includes('resetSuspended') && !('resetSuspended' in stripServerOnlyUserFields({ id: 'x', resetSuspended: { a: 1 } })), 'server-only field');
    const agencies = [{ id: 'A', adminEmail: 'pa@x' }, { id: 'B' }, { id: 'C' }];
    const rowA = { id: 'pA', personId: 'pA', agencyId: 'A', email: 'p@x', role: 'mashgiach', venueId: 'v1', credentialOwner: true, password: '$2a$10$x' };
    const rowB = { id: 'pB', personId: 'pA', agencyId: 'B', email: 'p@x', role: 'mashgiach', venueId: 'vb' };
    const rowC = { id: 'pC', personId: 'pA', agencyId: 'C', email: 'p@x', role: 'mashgiach' };
    const admB = { id: 'admB', personId: 'admB', agencyId: 'B', email: 'ab@x', role: 'admin' };
    const other = { id: 'oth', personId: 'oth', agencyId: 'B', email: 'o@x', role: 'mashgiach' };
    const usedAt = '2026-10-22T12:00:00.000Z';
    const pend = { id: 'rst_A', agencyId: 'A', memberId: 'pA', personId: 'pA', status: 'pending' };
    const usedL = { ...pend, status: 'used', usedAt };
    const rec = resetSuspensionRecord(usedL);
    assert(J(rec) === J({ linkId: 'rst_A', at: usedAt, byAgencyId: 'A' }), 'record shape');
    const before = [rowA, rowB, rowC, admB, other];
    const run = (after, opts) => {
      const v = [];
      const out = enforceIdentityFields(before, after, agencies, { ...opts, onViolation: (id, f) => v.push(`${id}:${f}`) });
      return { out, v, by: (id) => out.find((u) => u.id === id) };
    };
    const setB = before.map((u) => (u.id === 'pB' || u.id === 'pC' ? { ...u, resetSuspended: { ...rec } } : u));
    const okSet = run(setB, { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(['pB', 'pC']), clear: new Set() } });
    assert(J(okSet.by('pB').resetSuspended) === J(rec) && J(okSet.by('pC').resetSuspended) === J(rec) && okSet.v.length === 0, `sanctioned set ${J(okSet.v)}`);
    // forged: no writer (a PUT body / any other commit)
    const forged = run(setB, {});
    assert(forged.by('pB').resetSuspended === undefined && forged.v.includes('pB:resetSuspended'), 'no writer -> restored');
    // forged: link not consumed in this commit
    for (const [label, lb, la] of [['not consumed', [pend], [pend]], ['already used', [usedL], [usedL]], ['missing after', [pend], []], ['identity changed', [pend], [{ ...usedL, personId: 'zz' }]]]) {
      const r = run(setB, { resetLinksBefore: lb, resetLinksAfter: la, resetSuspension: { linkId: 'rst_A', set: new Set(['pB']), clear: new Set() } });
      assert(r.by('pB').resetSuspended === undefined && r.v.includes('pB:resetSuspended'), `forged (${label}) restored`);
    }
    // forged: same agency as the link / wrong person / wrong value
    {
      const sameAg = run(before.map((u) => (u.id === 'pA' ? { ...u, resetSuspended: { ...rec } } : u)), { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(['pA']), clear: new Set() } });
      assert(sameAg.by('pA').resetSuspended === undefined, 'set on the link agency row refused');
      const wrongPerson = run(before.map((u) => (u.id === 'oth' ? { ...u, resetSuspended: { ...rec } } : u)), { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(['oth']), clear: new Set() } });
      assert(wrongPerson.by('oth').resetSuspended === undefined && wrongPerson.v.includes('oth:resetSuspended'), 'other person refused');
      const wrongVal = run(before.map((u) => (u.id === 'pB' ? { ...u, resetSuspended: { ...rec, byAgencyId: 'C' } } : u)), { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(['pB']), clear: new Set() } });
      assert(wrongVal.by('pB').resetSuspended === undefined, 'wrong value refused');
    }
    // overwrite of an existing record is refused ([DS1 B5])
    const recC = { linkId: 'rst_C', at: '2026-10-21T00:00:00.000Z', byAgencyId: 'C' };
    const beforePaused = before.map((u) => (u.id === 'pB' ? { ...u, resetSuspended: { ...recC } } : u));
    {
      const v = [];
      const out = enforceIdentityFields(beforePaused, beforePaused.map((u) => (u.id === 'pB' ? { ...u, resetSuspended: { ...rec } } : u)), agencies, { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(['pB']), clear: new Set() }, onViolation: (id, f) => v.push(`${id}:${f}`) });
      assert(J(out.find((u) => u.id === 'pB').resetSuspended) === J(recC) && v.includes('pB:resetSuspended'), 'overwrite refused, record kept');
      // body without the field keeps it (absence never clears)
      const kept2 = enforceIdentityFields(beforePaused, beforePaused.map((u) => { const { resetSuspended, ...r } = u; return r; }), agencies, {});
      assert(J(kept2.find((u) => u.id === 'pB').resetSuspended) === J(recC), 'absent in the outcome -> kept');
      const nulled = enforceIdentityFields(beforePaused, beforePaused.map((u) => (u.id === 'pB' ? { ...u, resetSuspended: null } : u)), agencies, {});
      assert(J(nulled.find((u) => u.id === 'pB').resetSuspended) === J(recC), 'null in a body -> kept');
    }
    // clear: only the link's own member (accept), or an admin of that agency (confirm)
    {
      const pendB = { id: 'rst_B', agencyId: 'B', memberId: 'pB', personId: 'pA', status: 'pending' };
      const usedB = { ...pendB, status: 'used', usedAt };
      const cleared = beforePaused.map((u) => { if (u.id !== 'pB') return u; const { resetSuspended, ...r } = u; return r; });
      const okClear = enforceIdentityFields(beforePaused, cleared, agencies, { resetLinksBefore: [pendB], resetLinksAfter: [usedB], resetSuspension: { linkId: 'rst_B', set: new Set(), clear: new Set(['pB']) } });
      assert(okClear.find((u) => u.id === 'pB').resetSuspended === undefined, 'accept clears its own row');
      const badClear = enforceIdentityFields(beforePaused, cleared, agencies, { resetLinksBefore: [pend], resetLinksAfter: [usedL], resetSuspension: { linkId: 'rst_A', set: new Set(), clear: new Set(['pB']) } });
      assert(J(badClear.find((u) => u.id === 'pB').resetSuspended) === J(recC), "another agency's link cannot clear B");
      const okConfirm = enforceIdentityFields(beforePaused, cleared, agencies, { resetConfirm: { rowId: 'pB', adminId: 'admB' } });
      assert(okConfirm.find((u) => u.id === 'pB').resetSuspended === undefined, 'B admin confirm clears');
      const confirmByA = enforceIdentityFields(beforePaused, cleared, agencies, { resetConfirm: { rowId: 'pB', adminId: 'pA' } });
      assert(J(confirmByA.find((u) => u.id === 'pB').resetSuspended) === J(recC), 'confirm by a non-admin / other agency refused');
      const demoted = enforceIdentityFields(beforePaused, cleared.map((u) => (u.id === 'admB' ? { ...u, role: 'mashgiach' } : u)), agencies, { resetConfirm: { rowId: 'pB', adminId: 'admB' } });
      assert(J(demoted.find((u) => u.id === 'pB').resetSuspended) === J(recC), 'confirm by an admin demoted in the same commit refused');
      const wrongRow = enforceIdentityFields(beforePaused, cleared, agencies, { resetConfirm: { rowId: 'pC', adminId: 'admB' } });
      assert(J(wrongRow.find((u) => u.id === 'pB').resetSuspended) === J(recC), 'confirm names another row -> B kept');
    }
    // a new row is never born paused
    {
      const v = [];
      const out = enforceIdentityFields(before, [...before, { id: 'new1', agencyId: 'B', email: 'n@x', role: 'mashgiach', resetSuspended: { ...rec } }], agencies, { onViolation: (id, f) => v.push(`${id}:${f}`) });
      assert(out.find((u) => u.id === 'new1').resetSuspended === undefined && v.includes('new1:resetSuspended'), 'new row stripped');
    }

    // backups [DS1 N3]
    assert(isSecretKey('resetTokenHash') && isSecretKey('credentialStampHash'), 'isSecretKey hash + stamp');
    const scrubbed = scrubSecrets({ resetLinks: [{ ...live, resetTokenHash: 'deadbeef', credentialStampHash: 'cafebabe' }] });
    const sj = J(scrubbed);
    assert(!sj.includes('deadbeef') && !sj.includes('cafebabe'), `scrubSecrets removes both: ${sj.slice(0, 200)}`);
  },
};
