/**
 * ADMINALL client test (Codex lane): an "All" task is the venue team's, not the
 * agency admin's. Don (Oct 27): the admin oversees every venue but must not be
 * counted in each venue's "All". For an admin, "Mine" = tasks that name him;
 * everyone else keeps "All" as theirs. Visibility and control do not change.
 *  M*  isMyTask: admin + "All" -> not mine; admin named -> mine; mashgiach/worker/owner/coordinator + "All" -> mine.
 *  B*  the App's Mine list and "Assigned to Me" count for an admin and a mashgiach at the same venue.
 *  V*  visibility unchanged: the admin's main list (All tab) still has every task.
 *  S*  source checks: App.tsx (count + Mine filter), KioskTaskPanel, TeamModal use isMyTask; no "all counts as mine" left.
 * Run: npx tsx tests/client/test-adminall.mjs
 */
import fs from 'node:fs';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

let isMyTask = null;
try {
  ({ isMyTask } = await import('../../src/lib/myTasks.ts'));
} catch (e) {
  ok('M0 src/lib/myTasks.ts exports isMyTask', false, String(e && e.message || e).split('\n')[0]);
}

const VENUE = 'venue-park-deli';
const admin = { id: 'u-admin', role: 'admin', email: 'admin@demo.test', agencyId: 'agency-demo' };
const mash = { id: 'u-m', role: 'mashgiach', email: 'mash@demo.test', agencyId: 'agency-demo', venueId: VENUE };
const worker = { id: 'u-w', role: 'worker', email: 'worker@demo.test', agencyId: 'agency-demo', venueId: VENUE };
const owner = { id: 'u-o', role: 'owner', email: 'owner@demo.test', agencyId: 'agency-demo', venueId: VENUE };
const coord = { id: 'u-c', role: 'coordinator', email: 'coord@demo.test', agencyId: 'agency-demo', venueId: VENUE };
const manager = { id: 'u-mg', role: 'manager', email: 'manager@demo.test', agencyId: 'agency-demo', venueId: VENUE };

const tasks = [
  { id: 'all1', venueId: VENUE, title: 'Check pilots', assignedTo: ['all'], isCompleted: false },
  { id: 'all2', venueId: VENUE, title: 'Rice cooker on', assignedTo: ['all'], isCompleted: true },
  { id: 'adm', venueId: VENUE, title: 'Sign the certificate', assignedTo: ['admin@demo.test'], isCompleted: false },
  { id: 'both', venueId: VENUE, title: 'Inspect delivery', assignedTo: ['mash@demo.test', 'admin@demo.test'], isCompleted: true },
  { id: 'msh', venueId: VENUE, title: 'Check produce', assignedTo: ['mash@demo.test'], isCompleted: false },
];

if (isMyTask) {
  // M: the rule itself
  ok('M1 admin + "All" task is NOT mine', isMyTask(tasks[0], admin) === false);
  ok('M2 admin named on a task IS mine', isMyTask(tasks[2], admin) === true);
  ok('M3 admin named with others IS mine', isMyTask(tasks[3], admin) === true);
  ok('M4 admin not named, not "All" -> not mine', isMyTask(tasks[4], admin) === false);
  ok('M5 mashgiach + "All" task IS still mine', isMyTask(tasks[0], mash) === true);
  ok('M6 mashgiach named IS mine', isMyTask(tasks[4], mash) === true);
  ok('M7 mashgiach not named (admin task) -> not mine', isMyTask(tasks[2], mash) === false);
  ok('M8 worker + "All" IS mine', isMyTask(tasks[0], worker) === true);
  ok('M9 owner + "All" IS mine (unchanged)', isMyTask(tasks[0], owner) === true);
  ok('M10 coordinator + "All" IS mine (unchanged)', isMyTask(tasks[0], coord) === true);
  ok('M11 manager + "All" IS mine (unchanged)', isMyTask(tasks[0], manager) === true);
  ok('M12 "All" alongside the admin\'s email -> mine (he is named)', isMyTask({ assignedTo: ['all', 'admin@demo.test'] }, admin) === true);
  ok('M13 no user: "All" counts as before', isMyTask(tasks[0], null) === true);
  ok('M14 no user: named task -> not mine', isMyTask(tasks[2], null) === false);

  // B: what App.tsx computes (myTasks / myTotal / myCompleted and the Mine filter)
  const mine = (u) => tasks.filter((t) => isMyTask(t, u));
  const adminMine = mine(admin);
  eq('B1 admin Mine = only tasks naming him', adminMine.map((t) => t.id), ['adm', 'both']);
  eq('B2 admin "Assigned to Me" count = 1/2', [adminMine.filter((t) => t.isCompleted).length, adminMine.length], [1, 2]);
  const mashMine = mine(mash);
  eq('B3 mashgiach Mine = "All" tasks + his own', mashMine.map((t) => t.id), ['all1', 'all2', 'both', 'msh']);
  eq('B4 mashgiach count = 2/4', [mashMine.filter((t) => t.isCompleted).length, mashMine.length], [2, 4]);
  eq('B5 TeamModal count for the admin row = 2', mine(admin).length, 2);
  eq('B6 TeamModal count for the mashgiach row = 4', mine(mash).length, 4);
}

// V: visibility — the All tab filter is not touched; the admin's list is every task.
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const kiosk = fs.readFileSync(new URL('../../src/components/KioskTaskPanel.tsx', import.meta.url), 'utf8');
const team = fs.readFileSync(new URL('../../src/components/TeamModal.tsx', import.meta.url), 'utf8');
const filterBlock = (app.match(/const filteredTasks = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/) || [''])[0];
ok('V1 filteredTasks block found', filterBlock.length > 0);
ok('V2 only the Mine tab narrows by assignee (no isMyTask outside activeTabFilter === \'mine\')',
  (filterBlock.match(/isMyTask\(/g) || []).length === 1 && /activeTabFilter === 'mine'\) \{\s*if \(!isMyTask\(task, currentUser\)\) return false;/.test(filterBlock));
ok('V3 filteredTasks re-runs when the role changes', /currentUser\?\.role[^\]]*\]\);\s*$/.test(filterBlock) || /currentUser\?\.email, currentUser\?\.role/.test(filterBlock));

// S: every "assigned to me" place uses the one rule
ok('S1 App myTasks uses isMyTask', /const myTasks = tasks\.filter\(\(t\) => isMyTask\(t, currentUser\)\);/.test(app));
ok('S2 App imports isMyTask', /import \{ isMyTask \} from '\.\/lib\/myTasks';/.test(app));
ok('S3 Kiosk savingMine uses isMyTask', /savingMine\.current\[taskId\] = !!task && isMyTask\(task, currentUser\);/.test(kiosk));
ok('S4 TeamModal assignedCount uses isMyTask', /const assignedCount = tasks\.filter\(\(t\) => isMyTask\(t, user\)\)\.length;/.test(team));
const leftover = /assignedTo\.includes\('all'\)\s*\|\|/;
for (const [name, src] of [['App.tsx', app], ['KioskTaskPanel.tsx', kiosk], ['TeamModal.tsx', team]]) {
  ok(`S5 no "'all' || mine" shortcut left in ${name}`, !leftover.test(src));
}

console.log(`ADMINALL client: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
