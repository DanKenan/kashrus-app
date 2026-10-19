/**
 * Client regression test: roster entries without email must not crash renders.
 *
 * Server roster payloads omit `email` for recipients who cannot assign tasks
 * (PR 1 privacy). These tests pin the null-safe display helpers used by
 * TaskModal, CreateEventModal, TeamModal and AgencyDashboard.
 *
 * Run: npx tsx tests/client/test-roster-nullsafe.mjs
 */
import { rosterDisplayHandle, rosterKey, rosterEmailLower } from '../../src/lib/rosterDisplay.ts';

let failures = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok ${label}`);
  }
}
function checkNoThrow(label, fn) {
  try {
    fn();
    console.log(`ok ${label} (no throw)`);
  } catch (e) {
    console.error(`FAIL ${label}: threw ${e.message}`);
    failures++;
  }
}

// rosterDisplayHandle
check('handle with email', rosterDisplayHandle({ email: 'alex@shutfey.com', name: 'Alex' }), 'alex');
check('handle without email falls back to name', rosterDisplayHandle({ name: 'Alex' }), 'Alex');
check('handle with undefined email falls back to name', rosterDisplayHandle({ email: undefined, name: 'Alex' }), 'Alex');
check('handle with null email falls back to name', rosterDisplayHandle({ email: null, name: 'Alex' }), 'Alex');
checkNoThrow('handle with missing email object shape', () => rosterDisplayHandle({ name: 'Alex' }));

// rosterKey
check('key with email', rosterKey({ email: 'a@b.c', id: 'u1', name: 'A' }), 'a@b.c');
check('key without email falls back to id', rosterKey({ id: 'u1', name: 'A' }), 'u1');
check('key with neither falls back to name', rosterKey({ name: 'A' }), 'A');
checkNoThrow('key with email-less entry', () => rosterKey({ id: 'u1', name: 'A' }));

// rosterEmailLower
check('emailLower with email', rosterEmailLower({ email: 'Alex@Shutfey.COM' }), 'alex@shutfey.com');
check('emailLower without email', rosterEmailLower({ name: 'Alex' }), '');
checkNoThrow('emailLower with undefined email', () => rosterEmailLower({ email: undefined }));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All roster null-safety checks passed.');
