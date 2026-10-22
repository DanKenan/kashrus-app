/**
 * Item 10h: invite helpers (unit, pure) + backup scrub of inviteTokenHash.
 */
import crypto from 'node:crypto';
import {
  newInviteToken, hashInviteToken, phaseCEnabled, parseInviteInput, isLiveInvite, inviteListView, pruneInvites,
  INVITE_ROLES, INVITE_TTL_MS, INVITE_RETENTION_MS,
} from '../../src/server/invites.ts';
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
    assert(phaseCEnabled({ phaseC: { enabled: true } }) && !phaseCEnabled({ phaseC: { enabled: 'true' } }) && !phaseCEnabled({ phaseC: {} }) && !phaseCEnabled({}) && !phaseCEnabled(null), 'phaseC only exactly true');
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
    assert(J(Object.keys(view).sort()) === J(['createdAt', 'email', 'expiresAt', 'id', 'invitedBy', 'role', 'venueIds']) && !J(view).includes('hhhh'), 'list view without hash/status/agency');
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

    const scrubbed = J(scrubSecrets({ invites: [live] }));
    assert(!scrubbed.includes('h'.repeat(64)) && scrubbed.includes('[REDACTED]'), `backup scrubs inviteTokenHash ${scrubbed.slice(0, 200)}`);
  },
};
