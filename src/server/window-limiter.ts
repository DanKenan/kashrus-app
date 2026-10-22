/**
 * Item 10a: a bounded, process-local sliding-window limiter for PUBLIC
 * routes (POST /api/agencies/register).
 *
 * Why in memory and not in the state document: an unauthenticated route must
 * not write the operational monolith once per request (write amplification,
 * contention, document growth from many distinct IPs). This limiter writes
 * nothing to Firestore. It is per server instance: a speed bump against fast
 * email enumeration, not a complete defence (stated in 10a's PR).
 *
 * Memory is bounded: at most `maxKeys` keys, each holding at most `max`
 * timestamps. Expired timestamps are pruned on every hit of that key; when the
 * map grows past maxKeys, every fully expired key is swept and, if still over,
 * the least recently hit keys are evicted (Map insertion order, refreshed on
 * every hit).
 */
export interface WindowLimiter {
  /** Count one attempt for `key` at `nowMs`. allowed=false when the key already had `max` attempts in the window (nothing is added then). */
  hit(key: string, nowMs: number): { allowed: boolean; retryAfterSec: number };
  /** 10M: is `key` at `max` attempts in the window? Reads only (adds nothing). */
  blocked(key: string, nowMs: number): { blocked: boolean; retryAfterSec: number };
  /** Number of keys currently held (for tests). */
  size(): number;
}

export function createWindowLimiter(opts: { max: number; windowMs: number; maxKeys: number }): WindowLimiter {
  const { max, windowMs, maxKeys } = opts;
  if (!(max >= 1) || !(windowMs > 0) || !(maxKeys >= 1)) throw new Error('createWindowLimiter: invalid options');
  const map = new Map<string, number[]>();
  const live = (arr: number[] | undefined, nowMs: number) =>
    (arr || []).filter((t) => t <= nowMs && nowMs - t < windowMs);
  const sweep = (nowMs: number) => {
    for (const [k, arr] of map) if (live(arr, nowMs).length === 0) map.delete(k);
    while (map.size > maxKeys) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    hit(key: string, nowMs: number) {
      const arr = live(map.get(key), nowMs);
      map.delete(key); // re-insert below: most recently hit = last
      if (arr.length >= max) {
        map.set(key, arr);
        const retryAfterSec = Math.max(1, Math.ceil((arr[0] + windowMs - nowMs) / 1000));
        return { allowed: false, retryAfterSec };
      }
      arr.push(nowMs);
      map.set(key, arr);
      if (map.size > maxKeys) sweep(nowMs);
      return { allowed: true, retryAfterSec: 0 };
    },
    blocked(key: string, nowMs: number) {
      const arr = live(map.get(key), nowMs);
      if (arr.length < max) return { blocked: false, retryAfterSec: 0 };
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - nowMs) / 1000)) };
    },
    size() {
      return map.size;
    },
  };
}
