/**
 * 10b (plan v4 10b/C6): the READ-ONLY identity invariant check inside the
 * existing consistency check (perEntityStatus). No server.
 *
 * Proves:
 *  - single rows (today's data) report 0 person groups and no identity issue;
 *  - a person group (rows sharing a personId) breaking the invariants is
 *    reported with row ids and codes only (no email), counted, and makes the
 *    run not-ok; a valid person group is counted and reports nothing;
 *  - legacy shared-email rows without personId are left to the existing
 *    duplicate-email check (no identity issue);
 *  - nothing is written (the mock database has no write method at all).
 */
import { runConsistencyCheck, issueTypeForReason } from '../../src/server/consistency.ts';
import { createMockDb, venue, user } from './test-consistency.mjs';

function assert(c, m) { if (!c) throw new Error(m); }
const H = '$2b$10$' + 'a'.repeat(53);
const idIssues = (r) => (r.status?.mismatches || []).filter((m) => String(m.reason).startsWith('identity invariant:'));

export default {
  name: '10b: read-only identity invariant check (consistency)',
  whatItProves: 'The consistency check reports person groups that break the identity invariants (row ids + codes, no emails), counts person groups, leaves legacy duplicates to the duplicate-email check, and writes nothing.',

  async run() {
    assert(issueTypeForReason('identity invariant: owner-count') === 'identity-invariant', 'issue type mapping');

    // 1. today's shape: single rows only
    {
      const monolith = { _v: 3, venues: [venue], agencies: [{ id: 'agency-hkc' }], users: [{ ...user('u1', 'a@x.com'), personId: 'u1' }, { ...user('u2', 'b@x.com'), personId: 'u2' }], tasks: [] };
      const r = await runConsistencyCheck(createMockDb(monolith, {}));
      assert(r.status, 'status present');
      assert(r.status.identity.multiGroups === 0 && r.status.identity.invalidGroups === 0, `counts ${JSON.stringify(r.status.identity)}`);
      assert(idIssues(r).length === 0, 'no identity issue on single rows');
      console.log('  ✓ single rows: 0 person groups, no identity issue');
    }

    // 2. an invalid person group: same person twice in one agency, no owner
    {
      const monolith = {
        _v: 3, venues: [venue], agencies: [{ id: 'agency-hkc' }, { id: 'ag-y' }], tasks: [],
        users: [
          { ...user('p1', 'p@x.com'), personId: 'P', password: H },
          { ...user('p2', 'P@x.com'), personId: 'P', password: H },
        ],
      };
      const r = await runConsistencyCheck(createMockDb(monolith, {}));
      const codes = idIssues(r).map((m) => m.reason.replace('identity invariant: ', '')).sort();
      assert(codes.includes('agency-duplicate') && codes.includes('owner-count') && codes.includes('non-owner-credential'), `codes ${codes}`);
      assert(r.status.identity.multiGroups === 1 && r.status.identity.invalidGroups === 1, `counts ${JSON.stringify(r.status.identity)}`);
      assert(!r.ok && r.status.match === false, 'an invalid group makes the run not ok');
      assert(!JSON.stringify(idIssues(r)).includes('@'), 'identity issues carry no email');
      assert(idIssues(r).every((m) => /^p[12](,p[12])?$/.test(m.id)), `row ids only: ${JSON.stringify(idIssues(r))}`);
      console.log('  ✓ invalid person group reported with row ids + codes, counted, run not ok');
    }

    // 3. a valid person group (the shape 10i creates): counted, no identity issue
    {
      const monolith = {
        _v: 3, venues: [venue], agencies: [{ id: 'agency-hkc' }, { id: 'ag-y' }], tasks: [],
        users: [
          { ...user('p1', 'p@x.com'), personId: 'P', password: H, credentialOwner: true, credentialOrigin: 'self-registered' },
          { ...user('p2', 'p@x.com'), agencyId: 'ag-y', personId: 'P' },
        ],
      };
      const r = await runConsistencyCheck(createMockDb(monolith, {}));
      assert(idIssues(r).length === 0, `no identity issue: ${JSON.stringify(idIssues(r))}`);
      assert(r.status.identity.multiGroups === 1 && r.status.identity.invalidGroups === 0, `counts ${JSON.stringify(r.status.identity)}`);
      console.log('  ✓ valid person group counted, nothing reported');
    }

    // 4. legacy shared email without personId: the existing duplicate check, not this one
    {
      const monolith = { _v: 3, venues: [venue], agencies: [{ id: 'agency-hkc' }], tasks: [], users: [user('l1', 'd@x.com'), { ...user('l2', 'D@x.com'), agencyId: 'ag-y' }] };
      const r = await runConsistencyCheck(createMockDb(monolith, {}));
      assert(idIssues(r).length === 0 && r.status.identity.multiGroups === 0, 'legacy pair is not an identity group issue');
      assert((r.status.mismatches || []).some((m) => m.reason === 'Duplicate normalized email in monolith'), 'duplicate-email check still reports it');
      console.log('  ✓ legacy duplicate left to the duplicate-email check');
    }
  },
};
