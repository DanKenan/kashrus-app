/**
 * 10M part 2 ("Agreed — 10M part 2"): the identity writer's personMerge and
 * the checker's mergePersons. Pure, no server.
 *  - every B row gets A's personId + email and loses every credential field;
 *    A's rows keep theirs; a single-row A's credential row becomes owner;
 *  - without personMerge the same change is reverted / refused;
 *  - the checker accepts the merged group only when it is exactly A ∪ B with
 *    no new row and every invariant holds.
 */
import { enforceIdentityFields, checkMembershipInvariants, personMergeOf } from '../../src/server/identity.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const H = '$2b$10$' + 'a'.repeat(53);
const H2 = '$2b$10$' + 'b'.repeat(53);
const ag = [{ id: 'ag-a' }, { id: 'ag-b' }, { id: 'ag-c' }];
const CRED = ['password', 'credentialOwner', 'credentialOrigin', 'credentialPending', 'recoveryCodeHashes', 'recoveryFailures'];

export default {
  name: '10M part 2: personMerge (identity writer + checker)',
  whatItProves: 'A sanctioned person merge moves every B row to A with A\'s email and no credential, makes a single-row A the owner, and the checker accepts exactly A ∪ B; the same edit without the merge is reverted or refused.',

  async run() {
    assert(personMergeOf({ fromPersonId: 'b', toPersonId: 'a', email: ' A@x.io ' })?.email === 'a@x.io', 'personMergeOf normalises');
    assert(personMergeOf({ fromPersonId: 'a', toPersonId: 'a', email: 'a@x.io' }) === null, 'personMergeOf refuses same person');
    assert(personMergeOf({ fromPersonId: 'b', toPersonId: 'a', email: '' }) === null, 'personMergeOf refuses empty email');

    // single A, multi B (owner b1 + plain b2)
    const before = [
      { id: 'a1', personId: 'a1', email: 'a@x.io', agencyId: 'ag-a', role: 'admin', password: H, credentialOrigin: 'self-registered', tokenEpoch: 2 },
      { id: 'b1', personId: 'b1', email: 'b@x.io', agencyId: 'ag-b', role: 'admin', password: H2, credentialOrigin: 'self-registered', credentialOwner: true, recoveryCodeHashes: ['h'], tokenEpoch: 1 },
      { id: 'b2', personId: 'b1', email: 'b@x.io', agencyId: 'ag-c', role: 'mashgiach' },
    ];
    const edited = before.map((u) => (u.personId === 'b1' ? { ...u, personId: 'a1', email: 'a@x.io' } : u));
    const pm = personMergeOf({ fromPersonId: 'b1', toPersonId: 'a1', email: 'a@x.io' });
    const out = enforceIdentityFields(before, edited, ag, { personMerge: pm, firstMultiOwnerIds: new Set(['a1']) });
    const by = (id) => out.find((u) => u.id === id);
    for (const id of ['b1', 'b2']) {
      assert(by(id).personId === 'a1' && by(id).email === 'a@x.io', `${id} moved`);
      for (const f of CRED) assert(by(id)[f] === undefined, `${id} keeps ${f}`);
    }
    assert(by('a1').credentialOwner === true && by('a1').password === H && by('a1').credentialOrigin === 'self-registered', 'a1 becomes owner, keeps its credential');
    assert(by('b1').tokenEpoch === 1 && by('a1').tokenEpoch === 2, 'epochs unchanged without bump ids');
    const chk = checkMembershipInvariants(before, out, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
    assert(chk.refused.length === 0, `merged group accepted: ${JSON.stringify(chk.refused)}`);
    console.log('  ✓ single A <- multi B: rows moved, credentials stripped, A owner, checker accepts');

    // without personMerge: personId reverted, checker refuses the email-joined group
    {
      const viol = [];
      const o2 = enforceIdentityFields(before, edited, ag, { onViolation: (id, f) => viol.push(`${id}:${f}`) });
      assert(o2.find((u) => u.id === 'b1').personId === 'b1', 'personId reverted without merge');
      assert(viol.includes('b1:personId'), `violation reported: ${viol}`);
      const c2 = checkMembershipInvariants(before, o2, ag, {});
      assert(c2.refused.some((i) => i.code === 'group-created'), `refused without mergePersons: ${JSON.stringify(c2.refused)}`);
      const c3 = checkMembershipInvariants(before, out, ag, {});
      assert(c3.refused.some((i) => i.code === 'group-created'), 'the merged doc is refused without mergePersons');
      console.log('  ✓ the same edit without personMerge is reverted / refused');
    }

    // merge must cover exactly A ∪ B: an extra new row, or a third person, is refused
    {
      const withNew = [...out, { id: 'n1', personId: 'a1', email: 'a@x.io', agencyId: 'ag-c', role: 'mashgiach' }];
      const c = checkMembershipInvariants(before, withNew, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
      assert(c.refused.length > 0, 'a new row is not covered by the merge');
      const before3 = [...before, { id: 'c1', personId: 'c1', email: 'c@x.io', agencyId: 'ag-c', role: 'admin', password: H, credentialOrigin: 'self-registered' }];
      const edited3 = before3.map((u) => (u.personId === 'b1' || u.personId === 'c1' ? { ...u, personId: 'a1', email: 'a@x.io' } : u));
      const o3 = enforceIdentityFields(before3, edited3, ag, { personMerge: pm, firstMultiOwnerIds: new Set(['a1']) });
      assert(o3.find((u) => u.id === 'c1').personId === 'c1', 'a third person is not moved by the merge');
      const c3 = checkMembershipInvariants(before3, o3, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
      assert(c3.refused.length > 0, `a third person joining is refused: ${JSON.stringify(c3.refused)}`);
      console.log('  ✓ only exactly A ∪ B is accepted');
    }

    // shared agency -> (personId, agencyId) duplicate refused even with the merge
    {
      const b4 = [
        { id: 'a1', personId: 'a1', email: 'a@x.io', agencyId: 'ag-a', role: 'admin', password: H, credentialOrigin: 'self-registered' },
        { id: 'b1', personId: 'b1', email: 'b@x.io', agencyId: 'ag-a', role: 'mashgiach', password: H2, credentialOrigin: 'self-registered' },
      ];
      const e4 = b4.map((u) => (u.id === 'b1' ? { ...u, personId: 'a1', email: 'a@x.io' } : u));
      const o4 = enforceIdentityFields(b4, e4, ag, { personMerge: pm, firstMultiOwnerIds: new Set(['a1']) });
      const c4 = checkMembershipInvariants(b4, o4, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
      assert(c4.refused.some((i) => i.code === 'agency-duplicate'), `shared agency refused: ${JSON.stringify(c4.refused)}`);
      console.log('  ✓ a shared agency is refused by the checker (agency-duplicate)');
    }

    // the identity writer sets the survivor's email itself (an edit that only moves personId)
    {
      const e6 = before.map((u) => (u.personId === 'b1' ? { ...u, personId: 'a1' } : u));
      const o6 = enforceIdentityFields(before, e6, ag, { personMerge: pm, firstMultiOwnerIds: new Set(['a1']) });
      assert(o6.filter((u) => u.id === 'b1' || u.id === 'b2').every((u) => u.email === 'a@x.io'), 'email set by personMerge');
      console.log('  ✓ personMerge sets the survivor email itself');
    }

    // a stored B group that loses a legacy row (no personId, same email) is not exactly A ∪ B -> refused
    {
      const b7 = [...before, { id: 'bL', email: 'b@x.io', agencyId: 'ag-c', role: 'mashgiach' }];
      const e7 = b7.map((u) => (u.personId === 'b1' ? { ...u, personId: 'a1', email: 'a@x.io' } : u));
      const o7 = enforceIdentityFields(b7, e7, ag, { personMerge: pm, firstMultiOwnerIds: new Set(['a1']) });
      assert(o7.find((u) => u.id === 'bL').email === 'b@x.io' && !o7.find((u) => u.id === 'bL').personId, 'legacy row untouched by personMerge');
      const c7 = checkMembershipInvariants(b7, o7, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
      assert(c7.refused.length > 0, `a partial B group is refused: ${JSON.stringify(c7)}`);
      console.log('  ✓ a merge that leaves part of B\'s stored group behind is refused');
    }

    // multi A: A's owner stays the only owner; no firstMulti needed
    {
      const b5 = [
        { id: 'a1', personId: 'a1', email: 'a@x.io', agencyId: 'ag-a', role: 'admin', password: H, credentialOrigin: 'self-registered', credentialOwner: true },
        { id: 'a2', personId: 'a1', email: 'a@x.io', agencyId: 'ag-c', role: 'admin' },
        { id: 'b1', personId: 'b1', email: 'b@x.io', agencyId: 'ag-b', role: 'admin', password: H2, credentialOrigin: 'invite-new' },
      ];
      const e5 = b5.map((u) => (u.id === 'b1' ? { ...u, personId: 'a1', email: 'a@x.io' } : u));
      const o5 = enforceIdentityFields(b5, e5, ag, { personMerge: pm });
      assert(o5.filter((u) => u.credentialOwner === true).map((u) => u.id).join() === 'a1', 'one owner');
      const c5 = checkMembershipInvariants(b5, o5, ag, { mergePersons: { fromPersonId: 'b1', toPersonId: 'a1' } });
      assert(c5.refused.length === 0, `multi A accepted: ${JSON.stringify(c5.refused)}`);
      console.log('  ✓ multi A <- single B accepted, one owner');
    }
  },
};
