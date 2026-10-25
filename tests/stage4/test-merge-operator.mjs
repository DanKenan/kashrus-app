/**
 * MERGE-FIX (files/shutfey-mergefix-plan.txt v2, E1/E2): the pure merge
 * origin/operator rules. Pure, no server.
 *  - the pinned operator row may survive with an absent (or linkable) origin
 *    only while it is a valid operator; 'admin' / 'agency-reset' / other never;
 *  - every other absent-origin row stays non-linkable on either side;
 *  - the operator is never on the retired side; on the survivor side only as
 *    the survivor's own credential row.
 */
import { isOperatorSurvivor, mergeOriginOperatorOk } from '../../src/server/account-merge.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const H = '$2b$10$' + 'a'.repeat(53);
const op = (extra = {}) => ({ id: 'usr_admin', personId: 'usr_admin', agencyId: 'agency-hkc', role: 'admin', email: 'owner@demo.test', password: H, ...extra });
const nhk = (extra = {}) => ({ id: 'u-nhk', personId: 'u-nhk', agencyId: 'agency-nhk', role: 'admin', email: 'nhk@demo.test', password: H, credentialOrigin: 'self-registered', ...extra });
const other = (extra = {}) => ({ id: 'u-oth', personId: 'u-oth', agencyId: 'agency-oth', role: 'admin', email: 'oth@demo.test', password: H, credentialOrigin: 'self-registered', ...extra });
const check = (rows, s, r) => mergeOriginOperatorOk(rows, s, r, rows.filter((u) => s && u.personId === s.personId), rows.filter((u) => r && u.personId === r.personId));

export default {
  name: 'MERGE-FIX: merge origin/operator rules (operator may only survive)',
  whatItProves: 'The operator row survives a merge with an absent or linkable origin only while it is a valid operator; it is never retired; every other legacy or non-linkable credential stays refused on both sides.',

  async run() {
    // isOperatorSurvivor
    {
      const o = op(); const rows = [o, nhk()];
      assert(isOperatorSurvivor(rows, o) === true, 'absent origin operator survives');
      for (const origin of [null, 'self-registered', 'invite-new']) { const x = op({ credentialOrigin: origin }); assert(isOperatorSurvivor([x], x) === true, `operator origin ${origin}`); }
      for (const origin of ['admin', 'agency-reset', 'seed', '', 'migrated']) { const x = op({ credentialOrigin: origin }); assert(isOperatorSurvivor([x], x) === false, `operator origin ${J(origin)} refused`); }
      for (const [extra, label] of [[{ role: 'coordinator' }, 'role'], [{ agencyId: 'agency-nhk' }, 'agency'], [{ password: 'plain' }, 'non-bcrypt'], [{ password: undefined }, 'no password']]) {
        const x = op(extra); assert(isOperatorSurvivor([x], x) === false, `not a valid operator (${label})`);
      }
      const legacy = other({ credentialOrigin: undefined }); assert(isOperatorSurvivor([legacy], legacy) === false, 'other legacy row is not the operator');
      // the record must be the one in rows (stale copy of a valid operator, rows say coordinator)
      assert(isOperatorSurvivor([op({ role: 'coordinator' })], op()) === false, 'decided on rows, not on the passed copy');
      assert(isOperatorSurvivor([o], null) === false && isOperatorSurvivor([], o) === false, 'fail closed');
    }
    // mergeOriginOperatorOk
    {
      const o = op(); const n = nhk(); const rows = [o, n];
      assert(check(rows, o, n) === true, 'Don case: operator survivor + self-registered retired');
      assert(check(rows, n, o) === false, 'operator retired refused (absent origin)');
      const oL = op({ credentialOrigin: 'self-registered' }); const rowsL = [oL, n];
      assert(check(rowsL, n, oL) === false, 'operator retired refused (linkable origin)');
      assert(check(rowsL, oL, n) === true, 'linkable operator survivor');
      for (const origin of [undefined, 'admin', 'agency-reset', 'x']) {
        const r = nhk({ credentialOrigin: origin }); if (origin === undefined) delete r.credentialOrigin;
        assert(check([o, r], o, r) === false, `retired origin ${J(origin)} refused even into the operator`);
      }
      for (const origin of ['admin', 'agency-reset']) { const x = op({ credentialOrigin: origin }); assert(check([x, n], x, n) === false, `operator origin ${origin} refused`); }
      const legacyS = other(); delete legacyS.credentialOrigin;
      assert(check([legacyS, n], legacyS, n) === false, 'non-operator legacy survivor refused');
      const s = other(); const r = nhk();
      assert(check([s, r], s, r) === true, 'plain linkable merge unchanged');
      // operator row inside the survivor person but NOT its credential row
      const sOwner = other({ credentialOwner: true });
      const opIn = op({ personId: sOwner.personId, credentialOrigin: undefined });
      assert(check([sOwner, opIn, r], sOwner, r) === false, 'operator membership in survivor person, not the credential row');
      // operator row inside the retired person (as a membership)
      const rOwner = nhk({ credentialOwner: true });
      const opInR = op({ personId: rOwner.personId });
      assert(check([s, rOwner, opInR], s, rOwner) === false, 'operator membership in retired person');
      // the pinned row is never retired, valid operator or not; never an ordinary survivor when invalid
      for (const extra of [{ role: 'coordinator' }, { agencyId: 'agency-nhk2' }, { password: 'plain' }]) {
        const bad = op({ credentialOrigin: 'self-registered', ...extra });
        assert(check([s, bad], s, bad) === false, `invalid pinned row retired refused ${J(extra)}`);
        assert(check([bad, r], bad, r) === false, `invalid pinned row as linkable survivor refused ${J(extra)}`);
      }
      // operator person that already has another membership: still fine as survivor
      const opM = op(); const opExtra = { id: 'u-op-2', personId: 'usr_admin', agencyId: 'agency-x', role: 'mashgiach', email: opM.email };
      assert(check([opM, opExtra, n], opM, n) === true, 'multi operator person survives');
      assert(check([o, n], null, n) === false && check([o, n], o, null) === false, 'fail closed');
    }
  },
};
const J = (o) => JSON.stringify(o);
