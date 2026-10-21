/**
 * Item 8d: session token classifier + resolver (unit, pure).
 */
import { classifySessionClaims as C, resolveSessionRow as R, sessionClaimsFor as S, tokenEpochOf } from '../../src/server/session-token.ts';

function assert(c, m) { if (!c) throw new Error(m); }

export default {
  name: 'Item 8d: session token classification (unit)',
  whatItProves: 'Exactly kiosk / v1 / v2 shapes accepted; every hybrid or malformed shape is null; the resolver enforces membership + personId + epoch (v2) and epoch 0 (v1); invalid stored epochs fail closed; v2 is issued only for migrated rows.',
  async run() {
    const k = (o) => C(o)?.kind ?? null;
    const table = [
      [{ sub: 'u1' }, 'v1'],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0 }, 'v2'],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 3 }, 'v2'],
      [{ sub: 'u1', kiosk: true, agencyId: 'a', venueId: 'v', pv: '1', dev: 'd' }, 'kiosk'],
      [{ sub: 'u1', kiosk: true }, 'kiosk'], // claims checked by kioskSessionStillValid as today
      [{ v: 3, sub: 'p1', mem: 'u1', ep: 0 }, null],
      [{ v: '2', sub: 'p1', mem: 'u1', ep: 0 }, null],
      [{ v: 2, sub: 'p1', mem: 'u1' }, null],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: '0' }, null],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: -1 }, null],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 1.5 }, null],
      [{ v: 2, sub: '', mem: 'u1', ep: 0 }, null],
      [{ v: 2, sub: 'p1', mem: '', ep: 0 }, null],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0, kiosk: true }, null],
      [{ v: 2, sub: 'p1', mem: 'u1', ep: 0, venueId: 'v' }, null],
      [{ sub: 'u1', kiosk: true, v: 2 }, null],
      [{ sub: 'u1', kiosk: true, mem: 'u1' }, null],
      [{ sub: 'u1', mem: 'u1' }, null],
      [{ sub: 'u1', ep: 0 }, null],
      [{ sub: 'u1', venueId: 'v' }, null],
      [{ sub: 'u1', kiosk: 'true' }, null],
      [{ sub: 'u1', kiosk: false }, null],
      [{}, null],
      [{ sub: 42 }, null],
      [null, null],
      [[], null],
    ];
    for (const [claims, want] of table) assert(k(claims) === want, `classify ${JSON.stringify(claims)} → ${k(claims)}, want ${want}`);
    console.log(`  ✓ classifier: ${table.length} shapes (kiosk / v1 / v2 / null)`);

    const users = [
      { id: 'u1', personId: 'u1' },
      { id: 'u2', personId: 'u2', tokenEpoch: 2 },
      { id: 'u3' },
      { id: 'u4', personId: 'u4', tokenEpoch: '0' },
      { id: 'u5', personId: 'u5', tokenEpoch: -1 },
    ];
    const id = (claims) => R(C(claims), users)?.id ?? null;
    assert(id({ v: 2, sub: 'u1', mem: 'u1', ep: 0 }) === 'u1', 'v2 ok');
    assert(id({ v: 2, sub: 'u2', mem: 'u1', ep: 0 }) === null, 'v2 sub must equal row.personId');
    assert(id({ v: 2, sub: 'u1', mem: 'u1', ep: 1 }) === null, 'v2 epoch must match');
    assert(id({ v: 2, sub: 'u2', mem: 'u2', ep: 2 }) === 'u2' && id({ v: 2, sub: 'u2', mem: 'u2', ep: 0 }) === null, 'v2 bumped epoch');
    assert(id({ sub: 'u1' }) === 'u1' && id({ sub: 'u3' }) === 'u3', 'v1 at epoch 0');
    assert(id({ sub: 'u2' }) === null, 'a bumped epoch kills v1');
    assert(id({ v: 2, sub: 'u3', mem: 'u3', ep: 0 }) === null, 'unmigrated row has no person binding');
    assert(id({ sub: 'u4' }) === null && id({ v: 2, sub: 'u4', mem: 'u4', ep: 0 }) === null, 'string epoch fails closed');
    assert(id({ sub: 'u5' }) === null, 'negative epoch fails closed');
    assert(id({ sub: 'gone' }) === null, 'deleted row');
    assert(id({ sub: 'u2', kiosk: true }) === 'u2', 'kiosk resolves by id; epoch not part of the kiosk path');
    assert(tokenEpochOf({}) === 0 && tokenEpochOf({ tokenEpoch: 3 }) === 3 && tokenEpochOf({ tokenEpoch: '3' }) === null && tokenEpochOf({ tokenEpoch: NaN }) === null, 'tokenEpochOf');
    console.log('  ✓ resolver: membership + personId + epoch (v2), epoch 0 (v1), invalid epochs fail closed');

    assert(JSON.stringify(S({ id: 'u1', personId: 'u1' })) === JSON.stringify({ v: 2, sub: 'u1', mem: 'u1', ep: 0 }), 'issue v2 migrated');
    assert(JSON.stringify(S({ id: 'u2', personId: 'u2', tokenEpoch: 2 })) === JSON.stringify({ v: 2, sub: 'u2', mem: 'u2', ep: 2 }), 'issue v2 with epoch');
    assert(JSON.stringify(S({ id: 'u3' })) === JSON.stringify({ sub: 'u3' }), 'issue v1 unmigrated');
    assert(JSON.stringify(S({ id: 'u9', personId: 'other', tokenEpoch: 1 })) === JSON.stringify({ v: 2, sub: 'other', mem: 'u9', ep: 1 }), '10e: membership row (personId ≠ id) → v2');
    assert(JSON.stringify(S({ id: 'u8', personId: '' })) === JSON.stringify({ sub: 'u8' }), 'empty personId → v1');
    console.log('  ✓ issuing: v2 only when personId === id');
  },
};
