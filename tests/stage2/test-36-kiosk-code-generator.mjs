/**
 * Test 36 (D3c): generateKioskCode fails loudly instead of using a fixed code.
 *
 * ChatGPT's #46 review: after 50 rejected random picks the generator must
 * FAIL with an error, not fall back to a fixed code ('4821' before D3c).
 * The client module is compiled in memory (esbuild, already a dependency)
 * and run against a forced weak RNG and the real one.
 *  1 a CSPRNG that only ever yields weak codes (0000, 1234, …) → throws
 *    KioskCodeGenerationError with the user-facing message, after exactly
 *    50 draws; nothing is returned.
 *  2 the real CSPRNG → 200 codes, each 4 digits, none weak.
 *  3 the source has no fixed fallback code left.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  name: 'Test 36: generateKioskCode throws after 50 rejected picks (D3c)',
  whatItProves:
    'The kiosk code generator never hands out a fixed fallback code: with an RNG that only yields weak codes it throws a clear error after 50 draws; with the real RNG it returns 4-digit non-weak codes.',

  async run() {
    const srcPath = join(here, '..', '..', 'src', 'lib', 'kioskCodeShare.ts');
    const src = readFileSync(srcPath, 'utf8');
    if (/return\s+'\d{4}'/.test(src)) throw new Error('kioskCodeShare.ts still returns a fixed 4-digit code');
    const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
    const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
    const weak = (c) => /^(\d)\1{3}$/.test(c) || '0123456789'.includes(c) || '9876543210'.includes(c);

    const real = globalThis.crypto;
    const weakValues = [0, 1111, 1234, 9876, 5555, 4567, 3210, 8888];
    let draws = 0;
    const fake = {
      getRandomValues(buf) { buf[0] = weakValues[draws % weakValues.length] + 10000 * draws; draws += 1; return buf; },
    };
    let thrown = null;
    let returned = null;
    Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true, writable: true });
    try {
      returned = mod.generateKioskCode();
    } catch (e) {
      thrown = e;
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true, writable: true });
    }
    if (returned !== null) throw new Error(`a weak-only RNG still produced a code: ${returned}`);
    if (!thrown) throw new Error('generateKioskCode did not throw');
    if (!(thrown instanceof mod.KioskCodeGenerationError)) throw new Error(`wrong error type: ${thrown && thrown.name}`);
    if (!/Couldn.t make a code/.test(thrown.message)) throw new Error(`error message not user-facing: ${thrown.message}`);
    if (draws !== 50) throw new Error(`expected exactly 50 draws before failing, got ${draws}`);

    for (let i = 0; i < 200; i++) {
      const c = mod.generateKioskCode();
      if (!/^\d{4}$/.test(c)) throw new Error(`not 4 digits: ${c}`);
      if (weak(c)) throw new Error(`weak code returned: ${c}`);
    }
    return 'weak-only RNG → KioskCodeGenerationError after 50 draws, no code; real RNG → 200 good 4-digit codes; no fixed fallback in the source';
  },
};
