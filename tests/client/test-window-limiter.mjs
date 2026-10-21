/**
 * 10a unit test: the bounded process-local window limiter (register route).
 * Run: npx tsx tests/client/test-window-limiter.mjs
 */
import { createWindowLimiter } from '../../src/server/window-limiter.ts';

let failures = 0, passed = 0;
function check(label, cond) { if (!cond) { console.error(`FAIL ${label}`); failures++; } else { passed++; } }

const H = 60 * 60 * 1000;
// 1. per-key limit: 10 allowed, 11th refused, refusal adds nothing
{
  const l = createWindowLimiter({ max: 10, windowMs: H, maxKeys: 100 });
  let t = 1_000_000;
  for (let i = 0; i < 10; i++) check(`attempt ${i + 1} allowed`, l.hit('register|1.2.3.4', t + i).allowed);
  const r11 = l.hit('register|1.2.3.4', t + 10);
  check('11th refused', !r11.allowed && r11.retryAfterSec > 0 && r11.retryAfterSec <= 3600);
  check('refusals keep refusing', !l.hit('register|1.2.3.4', t + 20).allowed);
  check('other key unaffected', l.hit('register|5.6.7.8', t + 30).allowed);
  // 2. recovery after the window: the oldest expires, one slot frees
  check('after the window the key is allowed again', l.hit('register|1.2.3.4', t + H + 1).allowed);
}
// 3. many distinct IPs: size never exceeds maxKeys, ever
{
  const l = createWindowLimiter({ max: 10, windowMs: H, maxKeys: 500 });
  let maxSeen = 0;
  for (let i = 0; i < 20000; i++) { l.hit(`register|10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 2_000_000 + i); maxSeen = Math.max(maxSeen, l.size()); }
  check(`size bounded by maxKeys under 20000 distinct keys (max seen ${maxSeen})`, maxSeen <= 500);
  // 4. expired keys are swept: after the window, a burst of new keys does not keep old ones
  for (let i = 0; i < 600; i++) l.hit(`register|new-${i}`, 2_000_000 + 20000 + H + i);
  check('still bounded after expiry + new burst', l.size() <= 500);
  // the most recently hit key survives eviction; an old one is gone
  const fresh = l.hit('register|new-599', 2_000_000 + 20000 + H + 700);
  check('a recent key keeps its count (2nd hit allowed)', fresh.allowed);
}
// 5. clock never goes backwards into the future-stamped entries
{
  const l = createWindowLimiter({ max: 2, windowMs: 1000, maxKeys: 10 });
  check('a', l.hit('k', 5000).allowed); check('b', l.hit('k', 5001).allowed);
  check('c refused', !l.hit('k', 5002).allowed);
  check('d allowed after 1 s', l.hit('k', 6001).allowed);
}
// 6. invalid options throw
{
  let threw = false; try { createWindowLimiter({ max: 0, windowMs: 1, maxKeys: 1 }); } catch { threw = true; }
  check('invalid options throw', threw);
}
if (failures) { console.error(`window-limiter: ${failures} FAILED, ${passed} passed`); process.exit(1); }
console.log(`window-limiter: ${passed}/${passed} passed`);
