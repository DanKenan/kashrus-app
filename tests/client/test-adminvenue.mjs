/**
 * ADMINVENUE client test (Codex lane): an agency admin with a venue picked must
 * see ONLY that venue's records from the realtime socket, as from REST.
 * Don (11:29 AM Oct 27): admin picked Yosi's Kitchen, saw Crown Market's tasks.
 *  A*  socketVenueScope: admin -> the selected venue; staff -> only with 2+ venues; none -> null.
 *  I*  INITIAL_STATE with tasks from 2 venues + a task with no venueId -> only the selected venue's.
 *  C*  TASK_CREATED for another venue / with no venueId -> not added.
 *  U*  TASK_UPDATED for another venue / with no venueId -> removed, never merged in.
 *  E*  events / history / DAILY_RESET / HISTORY_PRUNED / DEMO_RESTORED lists narrowed the same way.
 *  S*  source checks: every App.tsx socket path that sets or merges tasks/events/history uses the scope.
 * Run: npx tsx tests/client/test-adminvenue.mjs
 */
import fs from 'node:fs';
import { socketVenueScope, scopeListToVenue, inVenueScope } from '../../src/lib/socketVenueScope.ts';
import { canSeeTask } from '../../src/lib/permissions.ts';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const YOSI = 'venue-yosis-kitchen';
const CROWN = 'venue-crown-market';
const admin = { id: 'u-admin', role: 'admin', email: 'admin@demo.test', agencyId: 'agency-demo' };
const mash = { id: 'u-m', role: 'mashgiach', email: 'm@demo.test', agencyId: 'agency-demo', venueId: YOSI, myVenueIds: [YOSI, CROWN] };
const worker = { id: 'u-w', role: 'worker', email: 'w@demo.test', agencyId: 'agency-demo', venueId: YOSI };

const tasks = [
  { id: 't1', venueId: YOSI, title: 'Check produce' },
  { id: 't2', venueId: CROWN, title: 'Turn on rice cooker' },
  { id: 't3', venueId: CROWN, title: 'Check kitchen pilots' },
  { id: 't4', title: 'No venue on this task' },
  { id: 't5', venueId: YOSI, title: 'Wash station' },
];

// The exact steps App.tsx runs for each message (same functions, same order).
function applyInitialState(user, selectedVenueId, staffSeveral, payloadTasks) {
  const scope = socketVenueScope(user, selectedVenueId, staffSeveral);
  return scopeListToVenue(payloadTasks, scope).filter((t) => canSeeTask(t, user));
}
function applyCreated(user, selectedVenueId, staffSeveral, prev, created) {
  const scope = socketVenueScope(user, selectedVenueId, staffSeveral);
  if (!canSeeTask(created, user) || !inVenueScope(created, scope)) return prev;
  return prev.some((t) => t.id === created.id) ? prev : [...prev, created];
}
function applyUpdated(user, selectedVenueId, staffSeveral, prev, updated, currentVenueId = selectedVenueId) {
  // App.tsx: the generic payload.venueId guard lets TASK_UPDATED through so a moved task can leave the list.
  const scope = socketVenueScope(user, selectedVenueId, staffSeveral);
  const shownHere = canSeeTask(updated, user) && inVenueScope(updated, scope)
    && !(updated.venueId && currentVenueId && updated.venueId !== currentVenueId);
  return { list: shownHere ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev.filter((t) => t.id !== updated.id), toast: shownHere };
}
const ids = (l) => l.map((t) => t.id);

// A — scope
eq('A admin + Yosi selected -> Yosi', socketVenueScope(admin, YOSI, false), YOSI);
eq('A admin, staffSeveral flag ignored', socketVenueScope(admin, YOSI, true), YOSI);
eq('A admin, no venue picked -> null (whole list as sent)', socketVenueScope(admin, null, false), null);
eq('A staff with 2+ venues -> selected', socketVenueScope(mash, CROWN, true), CROWN);
eq('A staff with 1 venue -> null (server already scopes)', socketVenueScope(worker, YOSI, false), null);
eq('A no user -> null', socketVenueScope(null, YOSI, true), null);
eq('A empty-string venue -> null', socketVenueScope(admin, '', false), null);

// I — INITIAL_STATE (the bug): admin + Yosi, payload from 2 venues + a venueless task
eq('I admin Yosi: only Yosi tasks', ids(applyInitialState(admin, YOSI, false, tasks)), ['t1', 't5']);
ok('I admin Yosi: no Crown Market task', !applyInitialState(admin, YOSI, false, tasks).some((t) => t.venueId === CROWN));
ok('I admin Yosi: no venueless task', !applyInitialState(admin, YOSI, false, tasks).some((t) => !t.venueId));
eq('I admin Crown: only Crown tasks', ids(applyInitialState(admin, CROWN, false, tasks)), ['t2', 't3']);
eq('I admin, no venue picked: list as sent', ids(applyInitialState(admin, null, false, tasks)), ['t1', 't2', 't3', 't4', 't5']);
eq('I staff 2 venues at Crown: only Crown', ids(applyInitialState(mash, CROWN, true, tasks)), ['t2', 't3']);
eq('I staff 1 venue: unchanged (canSeeTask only)', ids(applyInitialState(worker, YOSI, false, tasks)), ['t1', 't4', 't5']);

// C — TASK_CREATED
const start = applyInitialState(admin, YOSI, false, tasks);
eq('C admin Yosi: Crown task not added', ids(applyCreated(admin, YOSI, false, start, { id: 't9', venueId: CROWN, title: 'Turn on rice cooker' })), ['t1', 't5']);
eq('C admin Yosi: venueless task not added', ids(applyCreated(admin, YOSI, false, start, { id: 't10', title: 'x' })), ['t1', 't5']);
eq('C admin Yosi: Yosi task added', ids(applyCreated(admin, YOSI, false, start, { id: 't11', venueId: YOSI, title: 'y' })), ['t1', 't5', 't11']);
eq('C duplicate id not added twice', ids(applyCreated(admin, YOSI, false, start, { id: 't1', venueId: YOSI })), ['t1', 't5']);

// U — TASK_UPDATED
eq('U admin Yosi: Crown update does not merge', ids(applyUpdated(admin, YOSI, false, start, { id: 't2', venueId: CROWN, title: 'Turn on rice cooker' }).list), ['t1', 't5']);
ok('U admin Yosi: Crown update -> no toast', !applyUpdated(admin, YOSI, false, start, { id: 't2', venueId: CROWN, title: 'Turn on rice cooker' }).toast);
eq('U admin Yosi: task moved to Crown is removed', ids(applyUpdated(admin, YOSI, false, start, { id: 't5', venueId: CROWN, title: 'Wash station' }).list), ['t1']);
eq('U admin Yosi: venueless update removes, never shows', ids(applyUpdated(admin, YOSI, false, start, { id: 't1', title: 'Check produce' }).list), ['t5']);
ok('U admin Yosi: venueless update -> no toast', !applyUpdated(admin, YOSI, false, start, { id: 't1', title: 'Check produce' }).toast);
eq('U admin Yosi: Yosi update merges', applyUpdated(admin, YOSI, false, start, { id: 't1', venueId: YOSI, title: 'Done' }).list[0].title, 'Done');
ok('U admin Yosi: Yosi update -> toast', applyUpdated(admin, YOSI, false, start, { id: 't1', venueId: YOSI, title: 'Done' }).toast);
const wStart = [{ id: 'w1', venueId: YOSI, title: 'a' }];
eq('U one-venue staff: task moved to another venue leaves the list', ids(applyUpdated(worker, YOSI, false, wStart, { id: 'w1', venueId: CROWN, title: 'a' }).list), []);
eq('U one-venue staff: own-venue update merges', applyUpdated(worker, YOSI, false, wStart, { id: 'w1', venueId: YOSI, title: 'b' }).list[0].title, 'b');

// E — other per-venue lists
const events = [{ id: 'e1', venueId: YOSI }, { id: 'e2', venueId: CROWN }, { id: 'e3' }];
const logs = [{ id: 'h1', venueId: CROWN }, { id: 'h2', venueId: YOSI }, { id: 'h3' }];
eq('E events admin Yosi', ids(scopeListToVenue(events, socketVenueScope(admin, YOSI, false))), ['e1']);
eq('E history admin Yosi', ids(scopeListToVenue(logs, socketVenueScope(admin, YOSI, false))), ['h2']);
ok('E EVENT_CREATED Crown for admin Yosi -> out', !inVenueScope({ id: 'e9', venueId: CROWN }, YOSI));
ok('E EVENT_CREATED venueless for admin Yosi -> out', !inVenueScope({ id: 'e9' }, YOSI));
ok('E no scope -> in', inVenueScope({ id: 'e9' }, null));
ok('E null item scoped -> out', !inVenueScope(null, YOSI));
ok('E scopeListToVenue no scope returns same list', scopeListToVenue(events, null) === events);

// S — source checks on App.tsx (each path uses the scope; the admin exclusion is gone from the data paths)
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('realtimeSocket.onMessage('), app.indexOf("showToast('Demo facilities and checklists have been restored.')"));
const block = (start, end) => { const a = handler.indexOf(start); const b = end ? handler.indexOf(end, a + 1) : -1; return a < 0 ? '' : handler.slice(a, b > a ? b : a + 1500); };
ok('S handler found', handler.length > 1000);
ok('S scope computed for admins from the selected venue', /socketVenueScope\(currentUser,\s*currentVenue\?\.id \|\| \(currentUser\.role === 'admin' \? currentVenueId : null\)/.test(handler));
const init = block("msg.type === 'INITIAL_STATE' && msg.payload", "msg.type === 'TASK_UPDATED'");
ok('S INITIAL_STATE tasks scoped', /setTasks\(scopeListToVenue<Task>\(msg\.payload\.tasks, venueScope\)/.test(init));
ok('S INITIAL_STATE history scoped', /setHistoryLogs\(scopeListToVenue\(msg\.payload\.historyLogs, venueScope\)\)/.test(init));
ok('S INITIAL_STATE events scoped', /setEvents\(scopeListToVenue\(msg\.payload\.events, eventScope\)\)/.test(init));
const upd = block("msg.type === 'TASK_UPDATED'", "msg.type === 'TASK_CREATED'");
ok('S TASK_UPDATED scoped', /inVenueScope\(updated, venueScope\)/.test(upd) && /updated\.venueId !== currentVenue\.id/.test(upd));
ok('S TASK_UPDATED toast only when shown here', /if \(shownHere && msg\.senderEmail/.test(upd));
ok('S generic venueId guard lets TASK_UPDATED through (moved task leaves the list)', /msgVenueId !== currentVenue\.id && msg\.type !== 'TASK_UPDATED'\) \{\s*return;/.test(handler));
const cre = block("msg.type === 'TASK_CREATED'", "msg.type === 'TASK_DELETED'");
ok('S TASK_CREATED scoped', /!inVenueScope\(created, venueScope\)\) return;/.test(cre));
const reset = block("msg.type === 'DAILY_RESET'", "msg.type === 'HISTORY_PRUNED'");
ok('S DAILY_RESET tasks scoped', /setTasks\(scopeListToVenue<Task>\(msg\.payload\.tasks, venueScope\)/.test(reset));
ok('S DAILY_RESET history scoped', /setHistoryLogs\(scopeListToVenue\(msg\.payload\.historyLogs, venueScope\)\)/.test(reset));
const pruned = block("msg.type === 'HISTORY_PRUNED'", "msg.type === 'AGENCY_UPDATED'");
ok('S HISTORY_PRUNED scoped', /setHistoryLogs\(scopeListToVenue\(msg\.payload\.historyLogs, venueScope\)\)/.test(pruned));
const ec = block("msg.type === 'EVENT_CREATED'", "msg.type === 'EVENT_UPDATED'");
ok('S EVENT_CREATED scoped', /if \(!inVenueScope\(newEvt, eventScope\)\) return;/.test(ec));
const eu = block("msg.type === 'EVENT_UPDATED'", "msg.type === 'EVENT_DELETED'");
ok('S EVENT_UPDATED scoped (out-of-scope removed)', /inVenueScope\(updatedEvt, eventScope\)/.test(eu) && /prev\.filter\(\(e\) => e\.id !== updatedEvt\.id\)/.test(eu));
const demo = handler.slice(handler.indexOf("msg.type === 'DEMO_RESTORED'"));
ok('S DEMO_RESTORED tasks/events scoped', /setTasks\(scopeListToVenue<Task>\(msg\.payload\.tasks, restoredScope\)\)/.test(demo) && /setEvents\(scopeListToVenue<KosherEvent>\(msg\.payload\.events, restoredEventScope\)\)/.test(demo));
// The only raw list left is HISTORY_PRUNED's unscoped branch (no venue scope = the list as sent;
// tests/stage4/test-history-retention.mjs checks that literal).
const rawSets = handler.match(/set(Tasks|Events|HistoryLogs)\(msg\.payload\.(tasks|events|historyLogs)\)/g) || [];
ok('S no raw payload list reaches setTasks/setEvents/setHistoryLogs (except the unscoped HISTORY_PRUNED branch)', rawSets.length === 1 && /if \(!venueScope\) setHistoryLogs\(msg\.payload\.historyLogs\);/.test(pruned), JSON.stringify(rawSets));
ok('S no admin-excluding ternary left on data paths', !/filterStaffVenue \? filterToVenue/.test(handler));

console.log(`test-adminvenue: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
