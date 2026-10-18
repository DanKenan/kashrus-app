/**
 * Runs Stage 4 PR A tests.
 */
import testConsistency from './test-consistency.mjs';

const tests = [testConsistency];

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
