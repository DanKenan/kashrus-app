/**
 * Runs Stage 4 PR A + PR B + PR R tests.
 */
import testConsistency from './test-consistency.mjs';
import testBackup from './test-backup.mjs';
import testRestore from './test-restore.mjs';
import testLogging from './test-logging.mjs';
import testStaticCache from './test-static-cache.mjs';

const tests = [testConsistency, testBackup, testRestore, testLogging, testStaticCache];

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
