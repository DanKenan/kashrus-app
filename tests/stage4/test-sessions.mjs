/**
 * Item 11, 11a-s1: server session record rules + sid claims (unit, pure).
 */
import { buildUserSession as B, sessionBacksClaims as OK, cachePut, cacheFresh, isSid, USER_SESSION_TTL_MS, SESSION_CACHE_FRESH_MS } from '../../src/server/sessions.ts';
import { classifySessionClaims as C, sessionClaimsFor as S } from '../../src/server/session-token.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);

export default {
  name: 'Item 11 (11a-s1): server session records + sid claims (unit)',
  whatItProves: 'A sid token is backed only by a matching, unrevoked, unexpired record (row, person, epoch, kind); sid is accepted only well-formed and only on v1/v2; the 30-day end never moves; the cache freshness bound is 15 s.',
  async run() {
    const sid = 'AAAAAAAAAAAAAAAAAAAAAA';
    const sid2 = 'BBBBBBBBBBBBBBBBBBBBB_';
    assert(isSid(sid) && isSid(sid2) && !isSid(sid + 'A') && !isSid(sid.slice(1)) && !isSid('AAAAAAAAAAAAAAAAAAAAA=') && !isSid(null), 'sid shape: exactly 22 base64url chars');

    // ---- classifier: sid on v1/v2 only, well-formed only
    assert(J(C({ v: 2, sub: 'p1', mem: 'u1', ep: 0, sid })) === J({ kind: 'v2', userId: 'u1', personId: 'p1', ep: 0, sid }), 'v2 + sid');
    assert(J(C({ sub: 'u1', sid })) === J({ kind: 'v1', userId: 'u1', sid }), 'v1 + sid');
    assert(J(C({ v: 2, sub: 'p1', mem: 'u1', ep: 0 })) === J({ kind: 'v2', userId: 'u1', personId: 'p1', ep: 0 }), 'v2 without sid unchanged (no sid key)');
    for (const [o, label] of [
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0, sid: 'short' }, 'malformed sid'],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0, sid: 12345 }, 'numeric sid'],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0, sid: '' }, 'empty sid'],
      [{ sub: 'u1', sid: null }, 'null sid on v1'],
      [{ sub: 'k1', kiosk: true, agencyId: 'a', venueId: 'v', pv: '1', dev: 'd', sid }, 'kiosk + sid'],
      [{ v: 3, sub: 'p1', cr: 'u1', ep: 0, sid }, 'choose + sid'],
    ]) assert(C(o) === null, `${label} -> null`);
    assert(J(S({ id: 'u1', personId: 'p1', tokenEpoch: 2 }, sid)) === J({ v: 2, sub: 'p1', mem: 'u1', ep: 2, sid }), 'sessionClaimsFor v2 + sid');
    assert(J(S({ id: 'u1' }, sid)) === J({ sub: 'u1', sid }), 'sessionClaimsFor v1 + sid');
    assert(J(S({ id: 'u1', personId: 'p1' })) === J({ v: 2, sub: 'p1', mem: 'u1', ep: 0 }), 'sessionClaimsFor without sid unchanged');
    let threw = false; try { S({ id: 'u1' }, 'bad'); } catch { threw = true; }
    assert(threw, 'sessionClaimsFor refuses a malformed sid');
    console.log('  ✓ sid claims');

    // ---- record + the one rule
    const now = 1_800_000_000_000;
    const d = B({ sid, row: { id: 'u1', personId: 'p1', agencyId: 'ag1' }, epoch: 2, via: 'login', userAgent: 'x'.repeat(100), nowMs: now });
    assert(d.kind === 'user' && d.rowId === 'u1' && d.personId === 'p1' && d.agencyId === 'ag1' && d.epochAtIssue === 2 && d.revokedAt === null, 'record fields');
    assert(d.absoluteExpMs === now + USER_SESSION_TTL_MS && USER_SESSION_TTL_MS === 30 * 24 * 3600 * 1000, '30 days from sign-in');
    assert(d.userAgentHint.length === 60, 'user agent hint capped at 60');
    assert(!('idleExpMs' in d) && !('idleExp' in d), 'no idle limit (plan 15.1)');
    const c2 = C(S({ id: 'u1', personId: 'p1', tokenEpoch: 2 }, sid));
    assert(OK(d, c2, now) && OK(d, c2, now + USER_SESSION_TTL_MS - 1), 'backs its own claims until the end');
    assert(!OK(d, c2, now + USER_SESSION_TTL_MS), 'refused AT absoluteExp');
    assert(!OK({ ...d, revokedAt: new Date(now).toISOString() }, c2, now), 'revoked -> refused');
    assert(!OK({ ...d, rowId: 'u2' }, c2, now), 'other row -> refused');
    assert(!OK({ ...d, personId: 'p2' }, c2, now), 'other person -> refused');
    assert(!OK({ ...d, epochAtIssue: 1 }, c2, now), 'other epoch -> refused');
    assert(!OK({ ...d, sid: sid2 }, c2, now), 'other sid -> refused');
    assert(!OK({ ...d, kind: 'kiosk' }, c2, now), 'kind kiosk -> refused');
    assert(!OK({ ...d, absoluteExpMs: undefined }, c2, now) && !OK({ ...d, absoluteExpMs: 'x' }, c2, now) && !OK({ ...d, absoluteExpMs: NaN }, c2, now), 'missing / bad end -> refused');
    assert(!OK(null, c2, now) && !OK(d, null, now) && !OK(d, C({ v: 2, sub: 'p1', mem: 'u1', ep: 2 }), now), 'no record / no claims / claims without sid -> refused');
    const dv1 = B({ sid, row: { id: 'l1' }, epoch: 0, via: 'login', nowMs: now });
    assert(dv1.personId === null && OK(dv1, C({ sub: 'l1', sid }), now), 'v1 record backs v1 claims');
    assert(!OK({ ...dv1, personId: 'p1' }, C({ sub: 'l1', sid }), now) && !OK({ ...dv1, epochAtIssue: 1 }, C({ sub: 'l1', sid }), now), 'v1: a person or non-zero epoch on the record -> refused');
    assert(!OK(dv1, C({ v: 2, sub: 'l1', mem: 'l1', ep: 0, sid }), now), 'v1 record never backs v2 claims');
    for (const bad of [{ sid: 'bad' }, { epoch: -1 }, { epoch: 1.5 }]) {
      let t = false; try { B({ sid, row: { id: 'u1' }, epoch: 0, via: 'login', nowMs: now, ...bad }); } catch { t = true; }
      assert(t, `buildUserSession refuses ${J(bad)}`);
    }
    console.log('  ✓ record rule');

    // ---- cache
    assert(SESSION_CACHE_FRESH_MS === 15000, 'fresh bound 15 s');
    assert(cacheFresh({ doc: d, readAtMs: now - 14999 }, now) && !cacheFresh({ doc: d, readAtMs: now - 15000 }, now), 'fresh < 15 s only');
    assert(!cacheFresh(undefined, now) && !cacheFresh({ doc: d, readAtMs: now + 5 }, now), 'missing / future read -> not fresh');
    const m = new Map();
    for (let i = 0; i < 5; i++) cachePut(m, `s${i}`, { doc: null, readAtMs: i }, 3);
    assert(J([...m.keys()]) === J(['s2', 's3', 's4']), 'cap drops the oldest');
    cachePut(m, 's2', { doc: null, readAtMs: 9 }, 3);
    cachePut(m, 's5', { doc: null, readAtMs: 9 }, 3);
    assert(J([...m.keys()]) === J(['s4', 's2', 's5']), 're-put moves to newest');
    console.log('  ✓ cache');
  },
};
