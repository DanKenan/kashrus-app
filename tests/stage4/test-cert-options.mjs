/** Item V1 unit tests: src/server/cert-options.ts (sanitize, fail closed, defaults). */
import { DEFAULT_CERT_OPTIONS, sanitizeCertOptions, effectiveCertOptions, sameCertOptions, CERT_OPTIONS_MAX, CERT_OPTION_MAX_LEN } from '../../src/server/cert-options.ts';
import { agencyPublicProfile, agencyAdminView } from '../../src/server/agency-fields.ts';
let n = 0; const ok = (c, m) => { if (!c) throw new Error(m); n++; };
const J = JSON.stringify;
const run = async function () {
  ok(J(DEFAULT_CERT_OPTIONS) === J(['Glatt meat', 'Dairy', 'DE', 'Parve']), 'defaults');
  let r = sanitizeCertOptions(['  Glatt   meat ', 'Dairy', 'glatt MEAT', 'Yoshon bakery']);
  ok(r.ok && J(r.options) === J(['Glatt meat', 'Dairy', 'Yoshon bakery']), `trim, collapse, case-insensitive de-dupe keeps first: ${J(r)}`);
  ok(sanitizeCertOptions([]).ok && J(sanitizeCertOptions([]).options) === J([]), 'empty list allowed (all removed)');
  for (const [bad, why] of [
    ['Dairy', 'not an array'], [null, 'null'], [{ 0: 'x' }, 'object'], [['ok', 7], 'non-string'], [['ok', ''], 'empty'],
    [['   '], 'blank'], [['x'.repeat(CERT_OPTION_MAX_LEN + 1)], 'too long'], [['a\u0000b'], 'control char'], [['a\nb'], 'newline'],
    [Array.from({ length: CERT_OPTIONS_MAX + 1 }, (_, i) => `opt ${i}`), 'too many'],
  ]) ok(sanitizeCertOptions(bad).ok === false, `refused: ${why}`);
  ok(sanitizeCertOptions(['x'.repeat(CERT_OPTION_MAX_LEN)]).ok, 'max length accepted');
  ok(sanitizeCertOptions(Array.from({ length: CERT_OPTIONS_MAX }, (_, i) => `opt ${i}`)).ok, 'max count accepted');
  // effective list
  ok(J(effectiveCertOptions({ id: 'a' })) === J(DEFAULT_CERT_OPTIONS), 'nothing stored = defaults');
  ok(J(effectiveCertOptions({ certificationOptions: ['Dairy', 'Fish'] })) === J(['Dairy', 'Fish']), 'stored list');
  ok(J(effectiveCertOptions({ certificationOptions: [] })) === J([]), 'stored empty list stays empty');
  ok(J(effectiveCertOptions({ certificationOptions: 'Dairy' })) === J(DEFAULT_CERT_OPTIONS), 'malformed stored = defaults');
  ok(J(effectiveCertOptions({ certificationOptions: ['Dairy', 5] })) === J(DEFAULT_CERT_OPTIONS), 'stored non-string = defaults');
  ok(J(effectiveCertOptions({ certificationOptions: ['Dairy', 'dairy'] })) === J(DEFAULT_CERT_OPTIONS), 'stored duplicates = defaults (fail closed)');
  ok(J(effectiveCertOptions(null)) === J(DEFAULT_CERT_OPTIONS), 'no agency = defaults');
  const e1 = effectiveCertOptions({}); e1.push('mutated');
  ok(J(effectiveCertOptions({})) === J(DEFAULT_CERT_OPTIONS), 'defaults are copied, never shared');
  ok(sameCertOptions(['a', 'b'], ['a', 'b']) && !sameCertOptions(['a', 'b'], ['b', 'a']) && !sameCertOptions(['a'], ['a', 'b']), 'same list, order included');
  // projections carry the computed list, never the raw stored value
  const ag = { id: 'a', name: 'A', certificationSeal: 'S', adminEmail: 'x@y', certificationOptions: 'junk' };
  ok(J(agencyPublicProfile(ag).certificationOptions) === J(DEFAULT_CERT_OPTIONS), 'public profile: malformed stored → defaults');
  ok(J(agencyAdminView({ ...ag, certificationOptions: ['Fish'] }).certificationOptions) === J(['Fish']), 'admin view: stored list');
  ok(!('adminEmail' in agencyPublicProfile(ag)), 'public profile still has no admin field');
  console.log(`cert-options: ${n}/${n} passed`);
};
export default { name: 'cert-options (V1)', whatItProves: 'Certification options are validated whole (malformed refused), normalised and de-duplicated; a missing or malformed stored list projects as the defaults; projections carry the computed list only.', run };
