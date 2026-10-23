/** Item 12, 12a-s unit tests: src/server/venue-grants.ts + the date-aware venueScope + identity grant enforcement. */
import { grantContainer, grantStateFor, extraActive, resolveUntil, nextLocalMidnightAfter, applyGrantOps, endDatedGrants, activeUntilMap, withGrantFields, isHomeless, HISTORY_CAP } from '../../src/server/venue-grants.ts';
import { venueScope, mayManageEventAt, configureVenueScope } from '../../src/server/venue-scope.ts';
import { enforceIdentityFields, stripServerOnlyUserFields, SERVER_ONLY_USER_FIELDS } from '../../src/server/identity.ts';
let n = 0; const ok = (c, m) => { if (!c) throw new Error(m); n++; };
const J = JSON.stringify;
const V = [{ id: 'v1', agencyId: 'A' }, { id: 'v2', agencyId: 'A' }, { id: 'v3', agencyId: 'A' }, { id: 'vb', agencyId: 'B' }];
const T0 = Date.parse('2026-10-23T12:00:00.000Z');
const U = '2026-10-24T04:00:00.000Z'; // midnight after Oct 23 in New York (EDT)
const UMS = Date.parse(U);
const m = (o) => ({ id: 'u1', role: 'mashgiach', agencyId: 'A', venueId: 'v1', personId: 'p1', venueAccess: ['v1', 'v2'], ...o });
const ctx = (o = {}) => ({ nowMs: T0, actor: 'adm', agencyVenueIds: new Set(['v1', 'v2', 'v3']), zoneFor: () => 'America/New_York', ...o });
const run = async function () {
  // ---- 4.2 container + five entry representations ----
  ok(grantContainer(m({})) === 'legacy', 'absent = legacy');
  ok(grantContainer(m({ venueGrants: undefined })) === 'legacy', 'undefined = legacy');
  for (const bad of [null, [], 'x', 7]) ok(grantContainer(m({ venueGrants: bad })) === 'malformed', `container ${J(bad)} malformed`);
  const big = {}; for (let i = 0; i < 51; i++) big['k' + i] = { until: null };
  ok(grantContainer(m({ venueGrants: big })) === 'malformed', '51 keys malformed');
  ok(grantStateFor(m({ venueGrants: {} }), 'v2').kind === 'undated', 'no entry = undated');
  ok(grantStateFor(m({ venueGrants: { v2: { from: null } } }), 'v2').kind === 'undated', 'no until key = undated');
  ok(grantStateFor(m({ venueGrants: { v2: { until: null } } }), 'v2').kind === 'undated', 'until null = undated');
  ok(grantStateFor(m({ venueGrants: { v2: { until: U } } }), 'v2').kind === 'dated', 'valid until = dated');
  for (const bad of ['2026-10-24', 'tomorrow', 12345, '2026-13-40T00:00:00Z', '']) ok(grantStateFor(m({ venueGrants: { v2: { until: bad } } }), 'v2').kind === 'denied', `until ${J(bad)} denied`);
  for (const bad of [null, 'x', [], 5]) ok(grantStateFor(m({ venueGrants: { v2: bad } }), 'v2').kind === 'denied', `entry ${J(bad)} denied`);
  ok(grantStateFor(m({ venueGrants: [] }), 'v2').kind === 'denied', 'malformed container denies');
  // ---- until is exclusive (boundary) ----
  const dated = m({ venueGrants: { v2: { from: null, until: U, by: 'adm' } } });
  ok(extraActive(dated, 'v2', UMS - 1) === true, 'until-1 ms active');
  ok(extraActive(dated, 'v2', UMS) === false, 'at until: ended');
  ok(extraActive(dated, 'v2', UMS + 1) === false, 'until+1 ms ended');
  // ---- venueScope date-aware (explicit nowMs), stale denies extras, home unaffected ----
  ok(J(venueScope(dated, V, { nowMs: UMS - 1 })) === J(['v1', 'v2']), 'scope before end');
  ok(J(venueScope(dated, V, { nowMs: UMS })) === J(['v1']), 'scope at end: home only');
  ok(J(venueScope(m({}), V, { nowMs: UMS + 1e12 })) === J(['v1', 'v2']), 'legacy undated extra never expires');
  ok(J(venueScope(m({ venueGrants: { v2: { until: 'garbage' } } }), V, { nowMs: T0 })) === J(['v1']), 'malformed until denies');
  ok(J(venueScope(m({ venueGrants: null }), V, { nowMs: T0 })) === J(['v1']), 'malformed container: home keeps working, extras denied');
  ok(J(venueScope(m({}), V, { nowMs: T0, denyExtras: true })) === J(['v1']), 'STALE: extras denied, home kept');
  ok(venueScope({ role: 'admin', agencyId: 'A' }, V, { denyExtras: true }) === 'agency', 'STALE: admin unchanged');
  // configured clock (server injects serverNow / freshness)
  configureVenueScope({ nowMs: () => UMS, denyExtras: () => false });
  ok(J(venueScope(dated, V)) === J(['v1']), 'configured clock used by default');
  ok(mayManageEventAt({ ...dated, role: 'coordinator' }, 'v2', V) === false, 'coordinator loses rights at an ended extra (9.14)');
  configureVenueScope({ nowMs: () => T0 });
  ok(mayManageEventAt({ ...dated, role: 'coordinator' }, 'v2', V) === true, 'coordinator rights while active');
  configureVenueScope({ nowMs: () => Date.now(), denyExtras: () => false });
  // ---- noHomeVenue ----
  const pool = { id: 'p2', role: 'mashgiach', agencyId: 'A', venueId: '', noHomeVenue: true, personId: 'p2', venueAccess: ['v2'] };
  ok(isHomeless(pool), 'marker row is homeless');
  ok(J(venueScope(pool, V, { nowMs: T0 })) === J(['v2']), 'noHome: scope = granted list, no home');
  ok(J(venueScope({ ...pool, venueAccess: [] }, V, { nowMs: T0 })) === J([]), 'noHome + nothing ticked = empty scope');
  ok(!isHomeless({ ...pool, role: 'admin' }), 'admin ignores the marker');
  ok(!isHomeless({ ...pool, noHomeVenue: undefined }), 'legacy falsy home is not homeless');
  // ---- dates: next local midnight AFTER the date, DST-correct ----
  ok(new Date(nextLocalMidnightAfter('2026-10-23', 'America/New_York')).toISOString() === U, 'EDT midnight');
  ok(new Date(nextLocalMidnightAfter('2026-12-01', 'America/New_York')).toISOString() === '2026-12-02T05:00:00.000Z', 'EST midnight');
  ok(new Date(nextLocalMidnightAfter('2026-03-07', 'America/New_York')).toISOString() === '2026-03-08T05:00:00.000Z', 'day before DST start');
  ok(new Date(nextLocalMidnightAfter('2026-03-08', 'America/New_York')).toISOString() === '2026-03-09T04:00:00.000Z', 'DST start day (23 h)');
  ok(new Date(nextLocalMidnightAfter('2026-11-01', 'America/New_York')).toISOString() === '2026-11-02T05:00:00.000Z', 'DST end day (25 h)');
  ok(new Date(nextLocalMidnightAfter('2026-10-23', 'Asia/Jerusalem')).toISOString() === '2026-10-23T21:00:00.000Z', 'venue zone Jerusalem');
  ok(new Date(nextLocalMidnightAfter('2026-10-23', 'Europe/London')).toISOString() === '2026-10-23T23:00:00.000Z', 'venue zone London (BST)');
  ok(new Date(nextLocalMidnightAfter('2026-09-05', 'America/Santiago')).toISOString() === '2026-09-06T04:00:00.000Z', 'skipped local midnight -> first instant of next day');
  const r1 = resolveUntil('2026-10-23', 'America/New_York', T0);
  ok(r1.ok && r1.until === U, 'today allowed');
  ok(resolveUntil(null, 'America/New_York', T0).ok, 'null = undated');
  ok(!resolveUntil('2026-10-22', 'America/New_York', T0).ok && resolveUntil('2026-10-22', 'America/New_York', T0).code === 'UNTIL_IN_PAST', 'past refused');
  ok(resolveUntil('2027-10-24', 'America/New_York', T0).ok, '366 days allowed');
  ok(resolveUntil('2027-10-25', 'America/New_York', T0).code === 'UNTIL_TOO_FAR', '367 days refused');
  for (const bad of ['2026-02-30', '2026-1-5', 'x', 20261023, '2026-10-23T00:00']) ok(resolveUntil(bad, 'America/New_York', T0).code === 'UNTIL_INVALID', `malformed ${J(bad)}`);
  ok(resolveUntil('2026-10-23', 'Not/AZone', T0).ok, 'invalid zone falls back to the default');
  // ---- applyGrantOps ----
  let r = applyGrantOps(m({ venueAccess: ['v1'] }), [{ op: 'add', venueId: 'v2', until: '2026-10-23' }], ctx());
  ok(r.ok && J(r.fields.venueAccess) === J(['v1', 'v2']) && r.fields.venueGrants.v2.until === U && r.fields.venueGrants.v2.by === 'adm' && r.fields.venueRev === 1 && r.growth, 'add dated');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'v2', until: null }], ctx()).code === 'ALREADY_TICKED', 'add on active = ALREADY_TICKED');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'v1', until: null }], ctx()).code === 'MAIN_VENUE_LOCKED', 'home locked (add)');
  ok(applyGrantOps(m({}), [{ op: 'remove', venueId: 'v1' }], ctx()).code === 'MAIN_VENUE_LOCKED', 'home locked (remove)');
  ok(applyGrantOps(m({}), [{ op: 'set_until', venueId: 'v1', until: null }], ctx()).code === 'MAIN_VENUE_LOCKED', 'home locked (set_until)');
  ok(applyGrantOps(m({}), [{ op: 'remove', venueId: 'v3' }], ctx()).code === 'NOT_TICKED', 'remove not ticked');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'vb', until: null }], ctx()).code === 'VENUE_NOT_IN_AGENCY', 'foreign venue');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'v3', until: '2026-10-01' }], ctx()).code === 'UNTIL_IN_PAST', 'past');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'v3', until: '2026-10-30' }], ctx({ datedFrozen: true })).code === 'DATED_GRANTS_FROZEN', 'frozen refuses dates');
  ok(applyGrantOps(m({}), [{ op: 'add', venueId: 'v3', until: null }], ctx({ datedFrozen: true })).ok, 'frozen allows undated');
  r = applyGrantOps(m({}), [{ op: 'remove', venueId: 'v2' }], ctx());
  ok(r.ok && J(r.fields.venueAccess) === J(['v1']) && r.fields.venueHistory[0].why === 'unticked' && r.fields.venueHistory[0].by === 'adm' && r.fields.venueRev === 1, 'remove -> history');
  r = applyGrantOps(dated, [{ op: 'set_until', venueId: 'v2', until: null }], ctx());
  ok(r.ok && r.fields.venueGrants.v2.until === null && r.growth, 'extend to undated = growth');
  r = applyGrantOps(dated, [{ op: 'set_until', venueId: 'v2', until: '2026-10-23' }], ctx());
  ok(r.ok && !r.changed && r.fields.venueRev === 0, 'same date: no change, no rev bump');
  r = applyGrantOps(m({ venueGrants: { v2: { from: null, until: '2026-10-30T04:00:00.000Z', by: 'a' } } }), [{ op: 'set_until', venueId: 'v2', until: '2026-10-23' }], ctx());
  ok(r.ok && r.changed && !r.growth, 'shortening is not growth');
  // normalization: expired, deleted venue, invalid data; re-tick after expiry is a NEW grant (9.12)
  r = applyGrantOps(dated, [], ctx({ nowMs: UMS }));
  ok(r.ok && r.closed.length === 1 && r.closed[0].why === 'ended' && J(r.fields.venueAccess) === J(['v1']) && r.fields.venueHistory[0].to === U && !r.fields.venueGrants, 'normalize closes expired at its own instant');
  ok(applyGrantOps(dated, [], ctx({ nowMs: UMS - 1 })).closed.length === 0, 'not yet expired: nothing closed');
  r = applyGrantOps(dated, [{ op: 'add', venueId: 'v2', until: null }], ctx({ nowMs: UMS + 5 }));
  ok(r.ok && r.fields.venueGrants.v2.until === null && r.fields.venueHistory[0].why === 'ended', 're-tick after expiry: old closed first, new grant undated');
  r = applyGrantOps(m({ venueAccess: ['v1', 'v2', 'v3'] }), [], ctx({ agencyVenueIds: new Set(['v1', 'v2']) }));
  ok(r.ok && r.closed[0].why === 'venue_deleted' && J(r.fields.venueAccess) === J(['v1', 'v2']), 'deleted venue closes');
  r = applyGrantOps(m({ venueGrants: 'broken' }), [], ctx());
  ok(r.ok && r.closed[0].why === 'invalid_data' && J(r.fields.venueAccess) === J(['v1']) && !r.fields.venueGrants, 'malformed container: extras closed AND removed (never revived as undated)');
  r = applyGrantOps(m({ venueGrants: { v2: { until: 'nope' } } }), [], ctx());
  ok(r.ok && r.closed[0].why === 'invalid_data' && J(r.fields.venueAccess) === J(['v1']), 'malformed entry closed and removed');
  r = applyGrantOps(m({ venueGrants: { v9: { until: null } } }), [], ctx());
  ok(r.ok && r.changed && !r.fields.venueGrants && r.closed.length === 0, 'orphan key dropped, nothing closed');
  // history cap 10, newest first
  let row = m({ venueAccess: ['v1'] });
  for (let i = 0; i < 12; i++) {
    const a = applyGrantOps(row, [{ op: 'add', venueId: 'v2', until: null }], ctx({ nowMs: T0 + i * 1000 }));
    row = withGrantFields(row, a.fields);
    const b = applyGrantOps(row, [{ op: 'remove', venueId: 'v2' }], ctx({ nowMs: T0 + i * 1000 + 500 }));
    row = withGrantFields(row, b.fields);
  }
  ok(row.venueHistory.length === HISTORY_CAP && Date.parse(row.venueHistory[0].to) > Date.parse(row.venueHistory[1].to) && row.venueRev === 24, 'history cap 10, newest first, rev counts every change');
  // homeless storage format
  r = applyGrantOps({ ...pool, venueAccess: [] }, [{ op: 'add', venueId: 'v2', until: '2026-10-23' }], ctx());
  ok(r.ok && r.fields.venueId === '' && r.fields.noHomeVenue === true && J(r.fields.venueAccess) === J(['v2']), 'homeless: plain list, marker kept');
  // endDatedGrants (5.9)
  r = endDatedGrants(m({ venueAccess: ['v1', 'v2', 'v3'], venueGrants: { v2: { from: null, until: U, by: 'a' } } }), ctx());
  ok(r.ok && J(r.fields.venueAccess) === J(['v1', 'v3']) && r.fields.venueHistory[0].why === 'ended' && !r.fields.venueGrants, 'end-dated: dated closed, undated kept');
  ok(J(activeUntilMap(dated, ['v1', 'v2'], T0)) === J({ v2: U }) && J(activeUntilMap(dated, ['v1', 'v2'], UMS)) === J({}), 'activeUntilMap');
  // ---- identity enforcement: only grantSetById writes; home change / promotion closes ----
  for (const f of ['venueGrants', 'venueHistory', 'venueRev', 'noHomeVenue']) ok(SERVER_ONLY_USER_FIELDS.includes(f), `${f} is server-only`);
  ok(stripServerOnlyUserFields({ a: 1, venueGrants: {}, noHomeVenue: true, venueRev: 3, venueHistory: [] }).venueGrants === undefined, 'stripped from bodies');
  const ag = [{ id: 'A' }];
  const prev = [{ ...dated, venueRev: 2, venueHistory: [] }];
  let out = enforceIdentityFields(prev, [{ ...prev[0], venueGrants: { v2: { until: null } }, venueRev: 9, noHomeVenue: true }], ag, {});
  ok(out[0].venueGrants.v2.until === U && out[0].venueRev === 2 && out[0].noHomeVenue === undefined, 'a mutator cannot write grant fields');
  const gf = applyGrantOps(prev[0], [{ op: 'set_until', venueId: 'v2', until: null }], ctx()).fields;
  out = enforceIdentityFields(prev, [prev[0]], ag, { grantSetById: new Map([['u1', gf]]) });
  ok(out[0].venueGrants.v2.until === null && out[0].venueRev === 3, 'grantSetById writes');
  out = enforceIdentityFields(prev, [{ ...prev[0], venueId: 'v3' }], ag, { nowMs: T0 });
  ok(J(out[0].venueAccess) === J(['v3']) && !out[0].venueGrants && out[0].venueHistory[0].venueId === 'v2' && out[0].venueRev === 3, 'home change closes extras into history');
  out = enforceIdentityFields(prev, [{ ...prev[0], role: 'admin' }], ag, { nowMs: T0 });
  ok(!out[0].venueGrants && out[0].noHomeVenue === undefined && out[0].venueRev === 3 && J(out[0].venueAccess) === J(['v1']), 'promotion to admin closes grants');
  const legacy = [m({})];
  out = enforceIdentityFields(legacy, [{ ...legacy[0], name: 'x' }], ag, {});
  ok(!('venueRev' in out[0]) && !('venueGrants' in out[0]) && !('venueHistory' in out[0]) && !('noHomeVenue' in out[0]), 'legacy row: no new fields appear');
  out = enforceIdentityFields([], [{ id: 'n1', role: 'mashgiach', agencyId: 'A', venueId: '', noHomeVenue: true, venueRev: 5 }], ag, {});
  ok(out[0].noHomeVenue === undefined && out[0].venueRev === undefined, 'a new row cannot set the marker itself');
  out = enforceIdentityFields([], [{ id: 'n2', role: 'mashgiach', agencyId: 'A' }], ag, { grantSetById: new Map([['n2', { venueId: '', noHomeVenue: true, venueAccess: [], venueRev: 1 }]]) });
  ok(out[0].noHomeVenue === true && out[0].venueId === '' && J(out[0].venueAccess) === J([]) && out[0].venueRev === 1, 'grantSetById creates a noHome row');
  const pr = [{ ...pool, venueRev: 1 }];
  out = enforceIdentityFields(pr, [{ ...pr[0], name: 'y' }], ag, {});
  ok(out[0].noHomeVenue === true && J(out[0].venueAccess) === J(['v2']) && out[0].venueId === '', 'noHome row survives an unrelated commit');
  console.log(`venue-grants: ${n}/${n} passed`);
};
export default { name: 'venue-grants (12a-s)', whatItProves: 'End dates fail closed (5 entry forms, malformed containers), until is exclusive, DST-correct local midnight, one canonical writer (normalize then ops, history cap, homeless format), identity layer lets only grantSetById write grant fields.', run };
