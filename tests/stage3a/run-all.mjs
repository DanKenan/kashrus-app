/**
 * Runs all Stage 3A media tests.
 * These are unit tests for validation logic and state transitions —
 * they do not require a running server or Storage configuration.
 */
import testValidation from './test-media-validation.mjs';
import testLifecycle from './test-media-lifecycle.mjs';
import testRealFunctions from './test-media-real-functions.mjs';
import testRegressions from './test-media-regressions.mjs';

const tests = [testValidation, testLifecycle, testRealFunctions, testRegressions];

export async function runAll() {
  console.log(`\n=== Stage 3A Media Tests (${tests.length} tests) ===\n`);
  let passed = 0;
  let failed = 0;
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
  if (failed > 0) {
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAll();
}
