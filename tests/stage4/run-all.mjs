/**
 * Runs Stage 4 PR A + PR B + PR R tests.
 */
import testConsistency from './test-consistency.mjs';
import testBackup from './test-backup.mjs';
import testRestore from './test-restore.mjs';
import testLogging from './test-logging.mjs';
import testStaticCache from './test-static-cache.mjs';
import testWorkday from './test-workday.mjs';
import testIdentity from './test-identity.mjs';
import testHistoryRetention from './test-history-retention.mjs';
import testMigrateIdentity from './test-migrate-identity.mjs';
import testSessionToken from './test-session-token.mjs';
import testVenueScope from './test-venue-scope.mjs';
import testCertOptions from './test-cert-options.mjs';
import testIdentityInvariants from './test-identity-invariants.mjs';
import testIdentityProjection from './test-identity-projection.mjs';
import testAgencyLogo from './test-agency-logo.mjs';
import testRecoveryCodes from './test-recovery-codes.mjs';
import testInvites from './test-invites.mjs';
import testResetLinks from './test-reset-links.mjs';

const tests = [testConsistency, testBackup, testRestore, testLogging, testStaticCache, testWorkday, testIdentity, testHistoryRetention, testMigrateIdentity, testSessionToken, testVenueScope, testCertOptions, testIdentityInvariants, testIdentityProjection, testAgencyLogo, testRecoveryCodes, testInvites, testResetLinks];

export async function runAll() {
  console.log(`\n=== Stage 4 PR A Tests (${tests.length} tests) ===\n`);
  let passed = 0, failed = 0;
  for (const test of tests) {
    try {
      console.log(`Running: ${test.name}`);
      console.log(`  Proves: ${test.whatItProves}`);
      await test.run();
      console.log(`  ✅ PASSED\n`);
      passed++;
    } catch (e) {
      console.log(`  ❌ FAILED: ${e.message}\n`);
      console.error(e.stack);
      failed++;
    }
  }
  console.log(`=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
