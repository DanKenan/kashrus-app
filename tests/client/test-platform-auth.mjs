/**
 * 8i unit test: the pinned platform-operator check.
 * Run: npx tsx tests/client/test-platform-auth.mjs
 */
import { isPlatformOperator } from '../../src/server/platform-auth.ts';

let failures = 0;
function check(label, actual, expected) {
  if (actual !== expected) { console.error(`FAIL ${label}: expected ${expected}, got ${actual}`); failures++; } else console.log(`ok ${label}`);
}
const HASH = '$2a$10$' + 'a'.repeat(53);
const op = { id: 'usr_admin', agencyId: 'agency-hkc', role: 'admin', password: HASH };
const others = [{ id: 'u2', agencyId: 'agency-b', role: 'admin', password: HASH }, { id: 'u3', agencyId: 'agency-hkc', role: 'admin', password: HASH }];
const users = [op, ...others];

check('operator', isPlatformOperator('usr_admin', false, users), true);
check('kiosk session of the operator', isPlatformOperator('usr_admin', true, users), false);
check('other agency admin', isPlatformOperator('u2', false, users), false);
check('second home admin', isPlatformOperator('u3', false, users), false);
check('no session', isPlatformOperator(undefined, false, users), false);
check('operator record missing', isPlatformOperator('usr_admin', false, others), false);
check('operator demoted', isPlatformOperator('usr_admin', false, [{ ...op, role: 'coordinator' }]), false);
check('operator moved agency', isPlatformOperator('usr_admin', false, [{ ...op, agencyId: 'agency-b' }]), false);
check('operator without password', isPlatformOperator('usr_admin', false, [{ ...op, password: '' }]), false);
check('operator with legacy plaintext password', isPlatformOperator('usr_admin', false, [{ ...op, password: 'hunter22' }]), false);
check('operator with missing agency (legacy)', isPlatformOperator('usr_admin', false, [{ ...op, agencyId: undefined }]), false);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall platform-auth checks passed');
