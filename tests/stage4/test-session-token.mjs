/**
 * Item 8d: session token classifier + resolver (unit, pure).
 */
import { classifySessionClaims as C, resolveSessionRow as R, sessionClaimsFor as S, tokenEpochOf, resolveChooseOwner, chooseClaimsFor, credentialRowOfPerson } from '../../src/server/session-token.ts';

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
    // ---- 10g: choose token ----
    const ck = (o) => C(o)?.kind ?? null;
    const chooseTable = [
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 0 }, 'choose'],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 4 }, 'choose'],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 0, mem: 'x1' }, null],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 0, kiosk: true }, null],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 0, venueId: 'v' }, null],
      [{ v: 3, sub: 'p1', ep: 0 }, null],
      [{ v: 3, sub: '', cr: 'x1', ep: 0 }, null],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: -1 }, null],
      [{ v: 3, sub: 'p1', cr: 'x1', ep: 1.5 }, null],
      [{ v: 3, sub: 'p1', cr: 'x1' }, null],
      [{ v: '3', sub: 'p1', cr: 'x1', ep: 0 }, null],
      [{ sub: 'p1', cr: 'x1' }, null],
      [{ v: 2, sub: 'p1', mem: 'x1', ep: 0, cr: 'x1' }, 'v2'],
    ];
    for (const [o, want] of chooseTable) assert(ck(o) === want, `choose classify ${JSON.stringify(o)} -> ${want} (got ${ck(o)})`);
    const P = [
      { id: 'x1', personId: 'p1', credentialOwner: true, tokenEpoch: 2, agencyId: 'A' },
      { id: 'y1', personId: 'p1', tokenEpoch: 1, agencyId: 'B' },
      { id: 's1', personId: 's1', agencyId: 'A' },
      { id: 'q1', personId: 'q1', credentialOwner: true, agencyId: 'A' },
      { id: 'q2', personId: 'q1', credentialOwner: true, agencyId: 'B' },
    ];
    const cho = (o) => resolveChooseOwner(C(o), P)?.id ?? null;
    assert(R(C({ v: 3, sub: 'p1', cr: 'x1', ep: 2 }), P) === undefined, 'resolveSessionRow(choose) is ALWAYS undefined');
    assert(cho({ v: 3, sub: 'p1', cr: 'x1', ep: 2 }) === 'x1', 'owner at its epoch');
    assert(cho({ v: 3, sub: 'p1', cr: 'x1', ep: 1 }) === null, 'stale epoch (E1)');
    assert(cho({ v: 3, sub: 'p1', cr: 'y1', ep: 1 }) === null, 'non-owner row (E3: owner moved)');
    assert(cho({ v: 3, sub: 'p2', cr: 'x1', ep: 2 }) === null, 'cross person');
    assert(cho({ v: 3, sub: 'p1', cr: 'gone', ep: 0 }) === null, 'deleted row');
    assert(cho({ v: 3, sub: 's1', cr: 's1', ep: 0 }) === 's1', 'single-row person: its only row is the owner');
    assert(cho({ v: 3, sub: 'q1', cr: 'q1', ep: 0 }) === null, 'two owners: invalid group fails closed');
    assert(resolveChooseOwner(C({ v: 2, sub: 'p1', mem: 'x1', ep: 2 }), P) === undefined, 'a v2 token is not a choose token');
    assert(credentialRowOfPerson(P, 'p1')?.id === 'x1' && credentialRowOfPerson(P, 'nobody') === undefined, 'credentialRowOfPerson');
    assert(JSON.stringify(chooseClaimsFor(P[0])) === JSON.stringify({ v: 3, sub: 'p1', cr: 'x1', ep: 2 }), 'chooseClaimsFor');
    console.log('  ✓ 10g choose token: strict shape, never a session row, owner-now + epoch');

    // ---- 10g: v2 agency check ----
    const ags = [{ id: 'A' }];
    assert(R(C({ v: 2, sub: 'p1', mem: 'x1', ep: 2 }), P, ags)?.id === 'x1', 'v2, agency exists');
    assert(R(C({ v: 2, sub: 'p1', mem: 'y1', ep: 1 }), P, ags) === undefined, 'v2, agency gone -> refused');
    assert(R(C({ v: 2, sub: 'p1', mem: 'y1', ep: 1 }), P)?.id === 'y1', 'no agencies list given -> unchanged');
    assert(R(C({ v: 2, sub: 'n1', mem: 'n1', ep: 0 }), [{ id: 'n1', personId: 'n1' }], ags)?.id === 'n1', 'v2 row without agencyId -> unchanged');
    assert(R(C({ sub: 'l1' }), [{ id: 'l1', agencyId: 'gone' }], ags)?.id === 'l1', 'v1 unchanged by the agency check');
    assert(R(C({ sub: 'k1', kiosk: true }), [{ id: 'k1', agencyId: 'gone' }], ags)?.id === 'k1', 'kiosk unchanged by the agency check');
    console.log('  ✓ 10g v2 agency check (v1 / kiosk unchanged)');
  },
};

