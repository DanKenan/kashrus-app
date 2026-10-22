/**
 * Item 10h: invite helpers (unit, pure) + backup scrub of inviteTokenHash.
 */
import crypto from 'node:crypto';
import {
  newInviteToken, hashInviteToken, phaseCEnabled, parseInviteInput, isLiveInvite, inviteListView, pruneInvites,
  INVITE_ROLES, INVITE_TTL_MS, INVITE_RETENTION_MS, parseMemberInvite, defaultPermissionsFor, inviteHashMatches, inviteDisplayName,
} from '../../src/server/invites.ts';
import { enforceIdentityFields } from '../../src/server/identity.ts';
import { scrubSecrets } from '../../src/server/backup.ts';
import { stripServerOnlyAgencyFields, agencyAdminView } from '../../src/server/agency-fields.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

export default {
  name: 'Item 10h: invite helpers (unit)',
  whatItProves: '32-byte base64url tokens with sha256-only storage; phaseC counts only enabled === true and is server-only; the input parser refuses bad emails, roles and foreign venues with one answer per class; live/expired; list view has no hash; retention per last transition (malformed kept); backups redact inviteTokenHash.',
  async run() {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const { raw, hash } = newInviteToken();
      assert(/^[A-Za-z0-9_-]{43}$/.test(raw), `token shape ${raw}`);
      assert(hash === crypto.createHash('sha256').update(raw).digest('hex') && hash === hashInviteToken(raw), 'sha256');
      seen.add(raw);
    }
    assert(seen.size === 500, 'distinct tokens');
    // Invites always on (Don 2026-10-22): every agency record counts, whatever its stored phaseC; no agency -> false.
    assert(phaseCEnabled({ phaseC: { enabled: true } }) && phaseCEnabled({ phaseC: { enabled: false } }) && phaseCEnabled({ phaseC: {} }) && phaseCEnabled({}) && !phaseCEnabled(null) && !phaseCEnabled(undefined) && !phaseCEnabled('agency-x'), 'invites on for every agency record, never for a missing one');
    assert(!('phaseC' in stripServerOnlyAgencyFields({ name: 'x', phaseC: { enabled: true } })), 'phaseC stripped from client bodies');
    assert(!('phaseC' in agencyAdminView({ id: 'a', name: 'A', phaseC: { enabled: true } })), 'phaseC not in the admin view');
    assert(J(INVITE_ROLES) === J(['admin', 'coordinator', 'mashgiach']), 'roles');

    const V = ['v1', 'v2'];
    const ok = parseInviteInput({ email: '  A@B.Co ', role: 'mashgiach', venueIds: ['v2', 'v1', 'v2'] }, V);
    assert(ok.ok && ok.value.email === 'a@b.co' && J(ok.value.venueIds) === J(['v2', 'v1']), `parse ok ${J(ok)}`);
    const adm = parseInviteInput({ email: 'a@b.co', role: 'admin' }, V);
    assert(adm.ok && J(adm.value.venueIds) === '[]', 'admin no venues');
    assert(parseInviteInput({ email: 'a@b.co', role: 'admin', venueIds: [] }, V).ok, 'admin empty list ok');
    const code = (b) => { const r = parseInviteInput(b, V); return r.ok ? 'OK' : r.code; };
    assert(code({ email: 'nope', role: 'mashgiach', venueIds: ['v1'] }) === 'INVITE_EMAIL_INVALID', 'bad email');
    assert(code({ email: 'x'.repeat(250) + '@b.co', role: 'mashgiach', venueIds: ['v1'] }) === 'INVITE_EMAIL_INVALID', 'long email');
    assert(code({ email: 1, role: 'mashgiach', venueIds: ['v1'] }) === 'INVITE_EMAIL_INVALID', 'non-string email');
    for (const role of ['owner', 'worker', 'Admin', '', undefined, 5]) assert(code({ email: 'a@b.co', role, venueIds: ['v1'] }) === 'INVITE_ROLE_INVALID', `role ${role}`);
    assert(code({ email: 'a@b.co', role: 'admin', venueIds: ['v1'] }) === 'INVITE_VENUES_INVALID', 'admin with venues');
    for (const venueIds of [undefined, [], ['vX'], [1], 'v1', Array.from({ length: 51 }, () => 'v1')]) assert(code({ email: 'a@b.co', role: 'coordinator', venueIds }) === 'INVITE_VENUES_INVALID', `venues ${String(J(venueIds)).slice(0, 30)}`);

    const now = Date.parse('2026-10-22T00:00:00.000Z');
    const iso = (t) => new Date(t).toISOString();
    const live = { id: 'i1', status: 'pending', expiresAt: iso(now + 1000), inviteTokenHash: 'h'.repeat(64), email: 'a@b.co', role: 'mashgiach', venueIds: ['v1'], invitedBy: 'u', createdAt: iso(now - 1000), agencyId: 'A' };
    assert(isLiveInvite(live, now) && !isLiveInvite({ ...live, expiresAt: iso(now - 1) }, now) && !isLiveInvite({ ...live, status: 'revoked' }, now) && !isLiveInvite({ ...live, expiresAt: 'garbage' }, now), 'live/expired');
    const view = inviteListView(live);
    assert(J(Object.keys(view).sort()) === J(['createdAt', 'email', 'expiresAt', 'id', 'invitedBy', 'kind', 'name', 'role', 'venueIds']) && !J(view).includes('hhhh'), 'list view without hash/status/agency');
    assert(INVITE_TTL_MS === 7 * 864e5 && INVITE_RETENTION_MS === 30 * 864e5, 'ttl/retention');
    const D = 864e5;
    const list = [
      live,
      { ...live, id: 'r-new', status: 'revoked', revokedAt: iso(now - 29 * D) },
      { ...live, id: 'r-old', status: 'revoked', revokedAt: iso(now - 31 * D) },
      { ...live, id: 'e-new', expiresAt: iso(now - 29 * D) },
      { ...live, id: 'e-old', expiresAt: iso(now - 31 * D) },
      { ...live, id: 'a-old', status: 'accepted', acceptedAt: iso(now - 31 * D) },
      { ...live, id: 'a-new', status: 'accepted', acceptedAt: iso(now - 1 * D) },
      { ...live, id: 'r-bad', status: 'revoked', revokedAt: 'garbage' },
      { ...live, id: 'a-missing', status: 'accepted' },
      null,
    ];
    const kept = pruneInvites(list, now).map((i) => i.id);
    assert(J(kept) === J(['i1', 'r-new', 'e-new', 'a-new', 'r-bad', 'a-missing']), `retention ${J(kept)}`);


    // ---- 10i: parseMemberInvite / defaults / hash compare / first-multi owner writer ----
    const phone = (raw) => (raw === undefined || raw === null || raw === '' ? { ok: true } : /^\+\d{8,15}$/.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false });
    const pm = (b, o = {}) => parseMemberInvite(b, V, { normalizePhone: phone, phoneError: 'bad phone', ...o });
    const m1 = pm({ email: 'a@b.co', role: 'coordinator', venueIds: ['v1'], name: '  Ann  ', phoneNumber: '+12025550123' });
    assert(m1.ok && m1.value.name === 'Ann' && m1.value.phoneNumber === '+12025550123' && J(m1.value.permissions) === J({ canFillTasks: true, canAssignTasks: true }), `member parse ${J(m1)}`);
    const pcode = (b, o) => { const r = pm(b, o); return r.ok ? 'OK' : r.code; };
    assert(pcode({ email: 'a@b.co', role: 'mashgiach', venueIds: ['v1'] }) === 'INVITE_NAME_INVALID', 'name required');
    assert(pcode({ email: 'a@b.co', role: 'mashgiach', venueIds: ['v1'], name: 'x'.repeat(101) }) === 'INVITE_NAME_INVALID', 'name max 100');
    assert(pcode({ email: 'a@b.co', role: 'mashgiach', venueIds: ['v1'], name: 'N', phoneNumber: '12' }) === 'INVITE_PHONE_INVALID', 'phone checked');
    assert(pcode({ email: 'a@b.co', role: 'owner', venueIds: ['v1'], name: 'N' }) === 'INVITE_ROLE_INVALID', 'owner refused without the server flag');
    const ow = pm({ email: 'a@b.co', role: 'owner', venueIds: ['v1'], name: 'N' }, { allowOwner: true });
    assert(ow.ok && ow.value.role === 'owner' && J(ow.value.venueIds) === J(['v1']), 'owner allowed only with allowOwner');
    for (const [role, f, a] of [['admin', true, true], ['coordinator', true, true], ['mashgiach', true, false], ['owner', false, false], ['worker', false, false]]) {
      const d = defaultPermissionsFor(role);
      assert(d.canFillTasks === f && d.canAssignTasks === a, `defaults ${role} ${J(d)}`);
    }
    assert(J(defaultPermissionsFor('mashgiach', { canAssignTasks: 1 })) === J({ canFillTasks: true, canAssignTasks: true }), 'explicit permissions win');
    const tk = newInviteToken();
    assert(inviteHashMatches(tk.hash, tk.raw) && !inviteHashMatches(tk.hash, tk.raw.slice(0, -1) + (tk.raw.endsWith('A') ? 'B' : 'A')) && !inviteHashMatches(undefined, tk.raw) && !inviteHashMatches(tk.hash, ''), 'hash compare');
    assert(inviteDisplayName({ email: 'sam@x.co' }) === 'sam' && inviteDisplayName({ name: ' Sam ', email: 'q@x.co' }) === 'Sam', 'display name fallback');
    const BC = '$2b$10$' + 'a'.repeat(53);
    const before = [{ id: 'p', personId: 'p', email: 'p@x.co', agencyId: 'A', password: BC, credentialOrigin: 'self-registered' }];
    const grown = [...before, { id: 'n', email: 'p@x.co', agencyId: 'B' }];
    const ok1 = enforceIdentityFields(before, grown, [], { newMembership: new Map([['n', 'p']]), firstMultiOwnerIds: new Set(['p']) });
    assert(ok1[0].credentialOwner === true && ok1[1].personId === 'p' && ok1[1].credentialOwner === undefined, 'first-multi owner set with a join');
    const viol = [];
    const noJoin = enforceIdentityFields(before, before, [], { firstMultiOwnerIds: new Set(['p']), onViolation: (r, f) => viol.push(`${r}:${f}`) });
    assert(noJoin[0].credentialOwner === undefined && viol.includes('p:firstMultiOwner'), 'no join -> refused + reported');
    const forged = enforceIdentityFields(before, [{ ...before[0], credentialOwner: true }], [], {});
    assert(forged[0].credentialOwner === undefined, 'a mutator cannot set credentialOwner itself');

    // ---- 10k: credentialPending sanctioned writer ----
    {
      const BC2 = '$2b$10$' + 'b'.repeat(53);
      const m0 = { id: 'm', personId: 'm', email: 'm@x.co', agencyId: 'A', password: BC2, credentialOrigin: 'admin' };
      const v10k = [];
      const onV = (r, f) => v10k.push(`${r}:${f}`);
      const { password: _p, ...noPw } = m0;
      const set1 = enforceIdentityFields([m0], [noPw], [], { credentialPendingWriteById: new Map([['m', 'set']]), onViolation: onV });
      assert(set1[0].credentialPending === 'invite' && set1[0].password === undefined, `10k set ${J(set1[0])}`);
      const setPw = enforceIdentityFields([m0], [m0], [], { credentialPendingWriteById: new Map([['m', 'set']]), onViolation: onV });
      assert(setPw[0].credentialPending === undefined && v10k.includes('m:credentialPending'), '10k set refused while a password remains');
      const multiBefore = [m0, { id: 'm2', personId: 'm', email: 'm@x.co', agencyId: 'B' }];
      const setMulti = enforceIdentityFields(multiBefore, [noPw, multiBefore[1]], [], { credentialPendingWriteById: new Map([['m', 'set']]) });
      assert(setMulti[0].credentialPending === undefined, '10k set refused on a multi person');
      const pend = { ...noPw, credentialPending: 'invite' };
      const forgedClear = enforceIdentityFields([pend], [{ ...pend, credentialPending: null, name: 'x' }], [], {});
      assert(forgedClear[0].credentialPending === 'invite', '10k a body/forged change cannot clear the marker');
      const unrelated = enforceIdentityFields([pend], [{ ...pend, name: 'New Name', phoneNumber: '+12025550123' }], [], {});
      assert(unrelated[0].credentialPending === 'invite' && unrelated[0].name === 'New Name', '10k marker survives an unrelated update');
      const pwNoClear = enforceIdentityFields([pend], [{ ...pend, password: BC2 }], [], { credentialOriginSetById: new Map([['m', 'agency-reset']]) });
      assert(pwNoClear[0].credentialPending === 'invite' && pwNoClear[0].password === undefined, '10k a password written without clear is reverted');
      const clearNoOrigin = enforceIdentityFields([pend], [{ ...pend, password: BC2 }], [], { credentialPendingWriteById: new Map([['m', 'clear']]) });
      assert(clearNoOrigin[0].credentialPending === 'invite' && clearNoOrigin[0].password === undefined, '10k clear needs origin invite-new');
      const clearOk = enforceIdentityFields([pend], [{ ...pend, password: BC2 }], [], { credentialPendingWriteById: new Map([['m', 'clear']]), credentialOriginSetById: new Map([['m', 'invite-new']]) });
      assert(clearOk[0].credentialPending === undefined && clearOk[0].password === BC2 && clearOk[0].credentialOrigin === 'invite-new', '10k clear with password + invite-new');
      const newRow = enforceIdentityFields([], [{ id: 'z', email: 'z@x.co', credentialPending: 'invite' }], [], {});
      assert(newRow[0].credentialPending === undefined, '10k a new row cannot carry the marker');
    }
    // 10j ([10J-DS2] B1, N4): source contracts.
    {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
      const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
      // Invites always on: NO writer of phaseC is left (the 10j route and the test hook are gone).
      const writers = server.split('\n').filter((l) => /phaseC:\s*\{/.test(l) || /\.phaseC\s*=/.test(l));
      assert(writers.length === 0, `phaseC writers: ${writers.length} ${J(writers.map((l) => l.trim().slice(0, 80)))}`);
      assert(!server.includes("'/api/__test__/phase-c'") && !server.includes("'/api/__test__/invites-client-ready'"), 'the phase-c and invites-client-ready test hooks are gone');
      // The retired enable route stays for old clients and writes nothing (no commit in its body).
      const en = server.indexOf("app.post('/api/agency/invites/enable'");
      const enBody = server.slice(en, server.indexOf('\n});\n', en));
      // [IAO-RV1] B1: a fresh admin re-check inside commitOrRespond whose only success returns the fresh doc unchanged (no-op path).
      assert(en > 0 && enBody.includes('alreadyOn: true') && !/phaseC/.test(enBody), 'enable route: answers alreadyOn, never touches phaseC');
      const docReturns = enBody.match(/doc:\s*[^,}]+/g) || [];
      assert(docReturns.length === 1 && /doc:\s*freshDoc\s*$/.test(docReturns[0]), `enable route: the only doc it returns is the unchanged fresh doc: ${J(docReturns)}`);
      assert(/freshCaller\.role !== 'admin'/.test(enBody), 'enable route: fresh admin re-check');
      assert(!/app\.(post|put|delete)\('\/api\/agency\/invites\/disable'/.test(server), 'no disable route');
      // B1: the route ships only with the invite-aware client in the same tree.
      const appTsx = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
      assert(/data\.pending === true/.test(appTsx) && appTsx.includes('fullInviteLink('), '10j B1: App.tsx handles the pending-invite answer');
      assert(fs.existsSync(path.join(root, 'src', 'components', 'InviteLinkCard.tsx')), '10j B1: InviteLinkCard exists');
      for (const f of ['TeamModal.tsx', 'CreateVenueModal.tsx']) {
        const src = fs.readFileSync(path.join(root, 'src', 'components', f), 'utf8');
        assert(src.includes("import { InviteLinkCard } from './InviteLinkCard'"), `10j B1: ${f} shows the invite link`);
      }
      // N2/N5: invitesEnabled is never part of a reusable (broadcast) projection.
      const af = fs.readFileSync(path.join(root, 'src', 'server', 'agency-fields.ts'), 'utf8');
      assert(!af.includes('invitesEnabled'), '10j invitesEnabled is not in agency-fields projections');
      assert(!J(agencyAdminView({ id: 'a', name: 'A', phaseC: { enabled: true, setAt: 'x', setBy: 'y' } })).includes('phaseC'), '10j agencyAdminView never carries phaseC');
    }
    const scrubbed = J(scrubSecrets({ invites: [live] }));
    assert(!scrubbed.includes('h'.repeat(64)) && scrubbed.includes('[REDACTED]'), `backup scrubs inviteTokenHash ${scrubbed.slice(0, 200)}`);
  },
};
