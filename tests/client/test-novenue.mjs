/**
 * NOVENUE client test (Tab lane, Nov 2 2026). A mashgiach whose venue scope
 * changed while the app was open (main venue Yosi's Kitchen -> Crown Market),
 * or whose venue list failed to load once, saw "Your venue was removed" until
 * he reopened the app. The browser run is files/shutfey-novenue-e2e.mjs.
 *  K*  venueListKey: one key per person + role + own venueRev + venue ids (order-free).
 *  P*  venueListPending: only a non-admin phone whose list is not delivered for this scope.
 *  D*  retry waits 2 s, 4 s, 8 s ... up to 30 s.
 *  W*  the in-app line no longer says "removed"; the sign-in refusal still does.
 *  S*  source checks: the list is fetched again on a scope change and on a retry; a
 *      delivered INITIAL_STATE list counts as loaded; the loading line comes before the
 *      no-venue line; sign-in and sign-out forget the loaded scope.
 * Run: npx tsx tests/client/test-novenue.mjs
 */
import fs from 'node:fs';
import { venueListKey, deliveredVenueListKey, venueListPending, venueRetryDelayMs, VENUE_LOAD_TIMEOUT_MS } from '../../src/lib/venueLoad.ts';
import { noVenueMessage, signInErrorText, VENUE_REMOVED_TEXT, NO_VENUE_TEXT, NO_ACCESS_TEXT } from '../../src/lib/venueRemoved.ts';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, a === b, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const yosi = { id: 'u1', role: 'mashgiach', venueId: 'v-yosi', myVenueRev: 0, myVenueIds: ['v-yosi'] };
const crown = { ...yosi, myVenueRev: 1, myVenueIds: ['v-crown'] };

// K
eq('K nobody', venueListKey(null), '');
ok('K a scope change is a new key', venueListKey(yosi) !== venueListKey(crown));
ok('K a rev change alone is a new key', venueListKey(yosi) !== venueListKey({ ...yosi, myVenueRev: 2 }));
eq('K venue order does not matter', venueListKey({ ...yosi, myVenueIds: ['b', 'a'] }), venueListKey({ ...yosi, myVenueIds: ['a', 'b'] }));
ok('K another person is another key', venueListKey(yosi) !== venueListKey({ ...yosi, id: 'u2' }));
eq('K an admin has one key whatever the scope fields', venueListKey({ id: 'a', role: 'admin', myVenueRev: 3 }), venueListKey({ id: 'a', role: 'admin' }));
eq('K the delivered scope matches the person after taking it', deliveredVenueListKey(yosi, 1, ['v-crown']), venueListKey(crown));
eq('K a delivered list without a rev keeps the person\'s rev', deliveredVenueListKey(yosi, undefined, ['v-yosi']), venueListKey(yosi));

// P
ok('P nothing loaded yet: pending', venueListPending(yosi, false, null));
ok('P loaded for this scope: not pending', !venueListPending(yosi, false, venueListKey(yosi)));
ok('P scope changed after the load (the Crown Market case): pending', venueListPending(crown, false, venueListKey(yosi)));
ok('P admin: never pending (setup screen rules unchanged)', !venueListPending({ id: 'a', role: 'admin' }, false, null));
ok('P kiosk: never pending (kiosk screens unchanged)', !venueListPending(yosi, true, null));
ok('P nobody signed in: not pending', !venueListPending(null, false, null));

// D
eq('D first retry 2 s', venueRetryDelayMs(1), 2000);
eq('D then 4 s', venueRetryDelayMs(2), 4000);
eq('D then 8 s', venueRetryDelayMs(3), 8000);
eq('D capped at 30 s', venueRetryDelayMs(20), 30000);
eq('D a request that never answers is abandoned after 15 s', VENUE_LOAD_TIMEOUT_MS, 15000);

// W
eq('W had a venue, none in view: accurate words', noVenueMessage({ role: 'mashgiach', venueId: 'v-crown' }), NO_ACCESS_TEXT);
eq('W the words', NO_ACCESS_TEXT, "You don't have access to a venue right now. Contact your agency.");
ok('W the in-app line never says removed', !/removed/i.test(NO_ACCESS_TEXT));
eq('W never had a venue: unchanged', noVenueMessage({ role: 'worker' }), NO_VENUE_TEXT);
eq('W sign-in refusal for a deleted venue: unchanged', signInErrorText({ code: 'VENUE_REMOVED' }, 'x'), VENUE_REMOVED_TEXT);

// S
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
ok('S the venue list effect runs again on a scope change and on a retry', app.includes('[currentUser?.id, currentUser?.email, currentUser?.role, ownVenueListKey, venuesRetry]'));
ok('S a successful load records the scope it was loaded for', /setVenues\(data\.venues\);\s*venuesFailures\.current = 0;\s*setVenuesLoadFailed\(false\);\s*setVenuesLoadedKey\(key\);/.test(app));
ok('S a failed load schedules a retry', app.includes('venueRetryDelayMs(venuesFailures.current)') && app.includes(".catch((err) => { console.warn('Could not fetch /api/venues:', err); failed(); })"));
ok('S a request that never answers is aborted at the deadline and counts as failed (RV1 P2-1)', app.includes('apiFetch(url, { signal: abort.signal })') && app.includes('setTimeout(() => abort.abort(), VENUE_LOAD_TIMEOUT_MS)') && app.includes('clearTimeout(deadline); abort.abort();'));
ok('S back online retries', app.includes("window.addEventListener('online', online);"));
ok('S an INITIAL_STATE list counts as loaded for its scope', app.includes('setVenuesLoadedKey(deliveredVenueListKey(currentUser, msg.payload.myVenueRev,'));
const loadingAt = app.indexOf('noVenueMessage(currentUser) ? (venueListLoading ? (');
ok('S the loading line is chosen before the no-venue line', loadingAt > 0 && loadingAt < app.indexOf('<div data-no-venue-notice'));
ok('S the loading line offers Sign out after a failed load', /data-venue-loading[\s\S]{0,600}venuesLoadFailed && \([\s\S]{0,400}onClick=\{handleLogout\}/.test(app));
eq('S sign-in and sign-out forget the loaded scope and the failures (RV1 P3-1)', (app.match(/setVenues\(\[\]\);\n\s*setVenuesLoadedKey\(null\);\n\s*setVenuesLoadFailed\(false\);\n\s*venuesFailures\.current = 0;/g) || []).length, 2);

console.log(failures ? `${passed} passed, ${failures} failed.` : `ALL PASS: ${passed} passed, 0 failed`);
process.exit(failures ? 1 : 0);
