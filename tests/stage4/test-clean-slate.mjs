/**
 * Item 8k: Clean Slate planner (unit, pure).
 */
import { planCleanSlate, agencyIsCleared } from '../../src/server/clean-slate.ts';
function assert(c, m) { if (!c) throw new Error(m); }
export default {
  name: 'Item 8k: Clean Slate planner (unit)',
  whatItProves: 'Ownership on the fresh doc: A-owned records removed, B untouched, untagged/unattributable records kept and counted, caller and admins kept, the legacy global flag never written.',
  async run() {
    const doc = {
      isDemoCleared: false,
      agencies: [{ id: 'A' }, { id: 'B' }],
      venues: [{ id: 'va', agencyId: 'A' }, { id: 'vb', agencyId: 'B' }, { id: 'vh' }],
      users: [
        { id: 'adm', agencyId: 'A', role: 'admin', email: 'adm@a' },
        { id: 'me', agencyId: 'A', role: 'coordinator', email: 'Me@A' },
        { id: 'm1', agencyId: 'A', role: 'mashgiach', email: 'M1@a ' },
        { id: 'b1', agencyId: 'B', role: 'mashgiach', email: 'b1@b' },
      ],
      tasks: [{ id: 't1', agencyId: 'A' }, { id: 't2', agencyId: 'B' }, { id: 't3' }],
      handoffNotes: [{ id: 'n1', venueId: 'va' }, { id: 'n2', venueId: 'vb' }, { id: 'n3', agencyId: 'B', venueId: 'va' }],
      incidents: [{ id: 'i1', agencyId: 'A' }, { id: 'i2' }],
      kioskDevices: [{ id: 'da', agencyId: 'A' }, { id: 'db', agencyId: 'B' }],
      kioskPairings: { p1: { venueId: 'va' }, p2: { deviceId: 'da' }, p3: { venueId: 'vb' }, p4: { status: 'pending' } },
      kioskPinLockouts: { users: { m1: {}, b1: {} }, tablets: { 'va|1': {}, 'vb|1': {}, junk: {} } },
      kioskPairingLimits: { 'caller|m1': [], 'caller|b1': [], 'start|1': [] },
      pushSubscriptions: [{ userId: 'm1', userEmail: 'm1@a' }, { userEmail: 'M1@A' }, { userEmail: 'b1@b' }],
      passwordResets: [{ email: 'm1@a' }, { email: 'b1@b' }],
      passwordResetRateLimits: { emailRequests: { 'm1@a': [], 'b1@b': [] }, ipRequests: { x: [] } },
      venueWorkDates: { va: 'd', vb: 'd' },
    };
    const p = planCleanSlate(JSON.parse(JSON.stringify(doc)), 'A', { id: 'me', email: 'me@a' }, '2026-10-21T00:00:00Z').patch;
    assert(J(p.users.map((u) => u.id)) === J(['adm', 'me', 'b1']), `users ${J(p.users.map((u) => u.id))}`);
    assert(J(p.venues.map((v) => v.id)) === J(['vb', 'vh']), 'venues (untagged = agency-hkc, not A)');
    assert(J(p.tasks.map((t) => t.id)) === J(['t2', 't3']), 'tasks');
    assert(J(p.handoffNotes.map((n) => n.id)) === J(['n2', 'n3']), 'notes: tagged B kept even at an A venue');
    assert(J(p.incidents.map((n) => n.id)) === J(['i2']), 'untagged incident kept');
    assert(J(p.kioskDevices.map((d) => d.id)) === J(['db']), 'devices');
    assert(J(Object.keys(p.kioskPairings)) === J(['p3', 'p4']), 'pairings');
    assert(J(Object.keys(p.kioskPinLockouts.users)) === J(['b1']) && J(Object.keys(p.kioskPinLockouts.tablets)) === J(['vb|1', 'junk']), 'lockouts');
    assert(J(Object.keys(p.kioskPairingLimits)) === J(['caller|b1', 'start|1']), 'limits');
    assert(J(p.pushSubscriptions) === J([{ userEmail: 'b1@b' }]), 'push (incl legacy, case-insensitive)');
    assert(J(p.passwordResets) === J([{ email: 'b1@b' }]) && J(Object.keys(p.passwordResetRateLimits.emailRequests)) === J(['b1@b']) && 'x' in p.passwordResetRateLimits.ipRequests, 'resets');
    assert(J(p.venueWorkDates) === J({ vb: 'd' }), 'work dates');
    assert(!('isDemoCleared' in p), 'global flag never written');
    assert(p.agencies.find((a) => a.id === 'A').cleanSlateAt === '2026-10-21T00:00:00Z' && !p.agencies.find((a) => a.id === 'B').cleanSlateAt, 'cleanSlateAt');
    const k = planCleanSlate(doc, 'A', { id: 'me', email: 'me@a' }, 'x').keptUnattributed;
    assert(k.incidents === 1 && k.kioskPairings === 1 && k['kioskPinLockouts.tablets'] === 1, `kept ${J(k)}`);
    assert(agencyIsCleared([{ id: 'A', cleanSlateAt: 'x' }], 'A') && !agencyIsCleared([{ id: 'A' }], 'A'), 'agencyIsCleared');
    console.log('  ✓ planner: A removed, B kept, unattributable kept + counted, global flag untouched');
  },
};
const J = (x) => JSON.stringify(x);
