/**
 * REMEMBERPAGE client test (Don 2026-10-27): a refresh keeps the main screen
 * the person was on; a screen the role cannot see, or an unknown/broken one,
 * falls back to the default. Kiosk never reads or writes it.
 * Run: npx tsx tests/client/test-rememberpage.mjs
 */
import { readFileSync } from 'node:fs';

let failures = 0; let passes = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: expected ${e}, got ${a}`); failures++; }
  else { console.log(`ok ${label}`); passes++; }
}

// Fake browser storage; localStorage must stay untouched (per-tab memory only).
const session = new Map(); const local = new Map();
const fake = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
});
globalThis.window = { sessionStorage: fake(session), localStorage: fake(local) };

let mod = null;
try { mod = await import('../../src/lib/screenMemory.ts'); } catch (e) { console.error(`FAIL lib/screenMemory.ts missing: ${e.message.split('\n')[0]}`); failures++; }

const admin = { id: 'u-admin', role: 'admin', agencyId: 'ag-1' };
const coord = { id: 'u-coord', role: 'coordinator', agencyId: 'ag-1' };
const mash = { id: 'u-mash', role: 'mashgiach', agencyId: 'ag-1' };
const owner = { id: 'u-owner', role: 'owner', agencyId: 'ag-1' };
const otherAgencyAdmin = { id: 'u-admin', role: 'admin', agencyId: 'ag-2' };
const S = (view, sheet = null) => ({ view, sheet });

if (mod) {
  const { screenFromStored, defaultScreen, readSavedScreen, saveScreen, forgetSavedScreens, sheetAllowed, screenStorageKey, isRestrictedSheet, restoreConfirmed, startPendingRestore, pendingOnScreen, pendingOnAnswer } = mod;
  const J = (o) => JSON.stringify(o);

  // Defaults (today's landing)
  check('default admin = agency home', defaultScreen(admin), S('home'));
  check('default mashgiach = board', defaultScreen(mash), S('board'));
  check('default no user = board', defaultScreen(null), S('board'));

  // Saved screen restored when allowed
  check('admin board+team restored', screenFromStored(admin, J(S('board', 'team'))), S('board', 'team'));
  check('admin home+venues restored', screenFromStored(admin, J(S('home', 'venues'))), S('home', 'venues'));
  check('admin board+history restored', screenFromStored(admin, J(S('board', 'history'))), S('board', 'history'));
  check('admin board (no sheet) restored', screenFromStored(admin, J(S('board'))), S('board'));
  check('coordinator board+team restored', screenFromStored(coord, J(S('board', 'team'))), S('board', 'team'));
  check('mashgiach board+events restored', screenFromStored(mash, J(S('board', 'events'))), S('board', 'events'));
  check('mashgiach board+history restored', screenFromStored(mash, J(S('board', 'history'))), S('board', 'history'));

  // Fail closed: not allowed for the role -> default
  check('mashgiach team -> board', screenFromStored(mash, J(S('board', 'team'))), S('board'));
  check('mashgiach venues -> board', screenFromStored(mash, J(S('board', 'venues'))), S('board'));
  check('mashgiach agency home -> board', screenFromStored(mash, J(S('home'))), S('board'));
  check('coordinator venues -> board', screenFromStored(coord, J(S('board', 'venues'))), S('board'));
  check('coordinator agency home -> board', screenFromStored(coord, J(S('home', 'team'))), S('board'));
  check('owner team -> board', screenFromStored(owner, J(S('board', 'team'))), S('board'));
  check('admin factory (hidden) -> home', screenFromStored(admin, J(S('board', 'factory'))), S('home'));
  // Unknown / broken -> default
  check('unknown view -> admin home', screenFromStored(admin, J(S('kiosk'))), S('home'));
  check('unknown sheet -> admin home', screenFromStored(admin, J(S('board', 'taskEditor'))), S('home'));
  check('broken JSON -> admin home', screenFromStored(admin, '{oops'), S('home'));
  check('array -> admin home', screenFromStored(admin, '[1]'), S('home'));
  check('nothing stored -> admin home', screenFromStored(admin, null), S('home'));
  check('no user -> board', screenFromStored(null, J(S('board', 'team'))), S('board'));
  check('sheetAllowed no user', sheetAllowed(null, 'history'), false);
  // The admin's agency-wide Events screen (from the dashboard)
  check('admin home+agency events restored', screenFromStored(admin, J(S('home', 'agency-events'))), S('home', 'agency-events'));
  check('coordinator agency events -> board', screenFromStored(coord, J(S('board', 'agency-events'))), S('board'));
  check('mashgiach agency events -> board', screenFromStored(mash, J(S('board', 'agency-events'))), S('board'));

  // Restricted sheets wait for the server's word on the role (stale cached role)
  check('Team is restricted', isRestrictedSheet('team'), true);
  check('Venues is restricted', isRestrictedSheet('venues'), true);
  check('agency Events is restricted', isRestrictedSheet('agency-events'), true);
  check('History is not restricted', isRestrictedSheet('history'), false);
  check('Events is not restricted', isRestrictedSheet('events'), false);
  check('server confirms admin -> Team reopens', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'admin' } }, 'team'), true);
  check('server confirms admin -> Venues reopens', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'admin' } }, 'venues'), true);
  check('server confirms coordinator -> Team reopens', restoreConfirmed(coord, { user: { id: 'u-coord', role: 'coordinator' } }, 'team'), true);
  check('cached admin, server says mashgiach -> no Team', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'mashgiach' } }, 'team'), false);
  check('cached admin, server says coordinator -> no Venues', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'coordinator' } }, 'venues'), false);
  check('cached admin, server says coordinator -> no agency Events', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'coordinator' } }, 'agency-events'), false);
  check('server names another person -> no Team', restoreConfirmed(admin, { user: { id: 'u-other', role: 'admin' } }, 'team'), false);
  check('server answers as a kiosk -> no Team', restoreConfirmed(admin, { user: { id: 'u-admin', role: 'admin' }, kiosk: { venueId: 'v' } }, 'team'), false);
  check('no answer (401/offline) -> no Team', restoreConfirmed(admin, null, 'team'), false);
  check('answer without a role -> no Team', restoreConfirmed(admin, { user: { id: 'u-admin' } }, 'team'), false);
  check('no cached user -> no Team', restoreConfirmed(null, { user: { id: 'u-admin', role: 'admin' } }, 'team'), false);

  // Pending restore: the page lifecycle while the server's answer is on its way (App.tsx drives these in this order).
  const meAdmin = { user: { id: 'u-admin', role: 'admin' } };
  const admin2 = { id: 'u-admin2', role: 'admin', agencyId: 'ag-1' };
  check('nothing restricted -> no pending', startPendingRestore(admin, S('board', 'history'), false), null);
  check('kiosk -> no pending', startPendingRestore(admin, S('board', 'team'), true), null);
  check('no user -> no pending', startPendingRestore(null, S('board', 'team'), false), null);
  {
    // Normal: load with saved Team, first save waits (target kept), server confirms -> open, then Team is saved.
    let pend = startPendingRestore(admin, S('board', 'team'), false);
    let r = pendingOnScreen(pend, admin, S('board')); pend = r.pending;
    check('first render while waiting: no save (stored Team kept)', r.save, false);
    r = pendingOnScreen(pend, { ...admin }, S('board')); pend = r.pending;
    check('same person, same screen (fresh object): still waiting, no save', [r.save, !!pend], [false, true]);
    const a = pendingOnAnswer(pend, admin, meAdmin, 'team');
    check('server confirms -> open, nothing pending', [a.open, a.pending, a.saveDefault], [true, null, false]);
    r = pendingOnScreen(a.pending, admin, S('board', 'team'));
    check('Team now on show -> saved', r.save, true);
  }
  {
    // Two reloads while the answer is pending: the stored target survives the first page.
    session.clear(); globalThis.window = { sessionStorage: fake(session), localStorage: fake(local) };
    saveScreen(admin, S('board', 'team'));
    const restored = readSavedScreen(admin);
    let pend = startPendingRestore(admin, restored, false);
    const r = pendingOnScreen(pend, admin, S(restored.view));
    if (r.save) saveScreen(admin, S(restored.view));
    check('reload again before the answer: Team still remembered', readSavedScreen(admin), S('board', 'team'));
  }
  {
    // A late answer after switching to another person (also allowed Team): never opens.
    let pend = startPendingRestore(admin, S('board', 'team'), false);
    pend = pendingOnScreen(pend, admin, S('board')).pending;
    const r = pendingOnScreen(pend, admin2, S('home'));
    check('switch to another person drops the pending restore', [r.pending, r.save], [null, true]);
    check('late answer for the first person after the switch -> no open', pendingOnAnswer(r.pending, admin, meAdmin, 'team').open, false);
    const so = pendingOnScreen(pendingOnScreen(startPendingRestore(admin, S('board', 'team'), false), admin, S('board')).pending, null, S('board'));
    check('sign-out drops the pending restore', so.pending, null);
    const ag = pendingOnScreen(pendingOnScreen(startPendingRestore(admin, S('board', 'team'), false), admin, S('board')).pending, otherAgencyAdmin, S('home'));
    check('agency switch (same id, other agency) drops it', ag.pending, null);
  }
  {
    // The person opens and closes History before the answer: their navigation wins.
    let pend = startPendingRestore(admin, S('board', 'team'), false);
    pend = pendingOnScreen(pend, admin, S('board')).pending;
    let r = pendingOnScreen(pend, admin, S('board', 'history')); pend = r.pending;
    check('opening History drops the pending restore and saves History', [pend, r.save], [null, true]);
    r = pendingOnScreen(pend, admin, S('board')); pend = r.pending;
    check('closing History: nothing pending, board saved', [pend, r.save], [null, true]);
    check('late confirm after that navigation -> no open', pendingOnAnswer(pend, admin, meAdmin, 'team').open, false);
  }
  {
    // Server answers: failed call keeps waiting; a definite no drops the target.
    let pend = pendingOnScreen(startPendingRestore(admin, S('board', 'team'), false), admin, S('board')).pending;
    const f = pendingOnAnswer(pend, admin, null, 'team');
    check('failed call: not opened, still pending, target kept', [f.open, !!f.pending, f.saveDefault], [false, true, false]);
    const no = pendingOnAnswer(pend, admin, { user: { id: 'u-admin', role: 'mashgiach' } }, 'team');
    check('server says mashgiach: not opened, dropped, default saved', [no.open, no.pending, no.saveDefault], [false, null, true]);
    check('answer for a different sheet -> ignored', pendingOnAnswer(pend, admin, meAdmin, 'venues').open, false);
  }
  session.clear();

  // Storage: per tab (sessionStorage), per agency + user
  check('nothing remembered yet', readSavedScreen(admin), S('home'));
  saveScreen(admin, S('board', 'team'));
  check('saved screen read back', readSavedScreen(admin), S('board', 'team'));
  check('stored in sessionStorage', session.has(screenStorageKey(admin)), true);
  check('localStorage untouched', local.size, 0);
  check('another user does not get it', readSavedScreen(coord), S('board'));
  check('same id in another agency does not get it', readSavedScreen(otherAgencyAdmin), S('home'));
  saveScreen(mash, S('board', 'team'));
  check('disallowed screen never stored', JSON.parse(session.get(screenStorageKey(mash))), S('board'));
  session.set(screenStorageKey(coord), J(S('board', 'venues')));
  check('tampered stored value falls back', readSavedScreen(coord), S('board'));
  // A demoted person: stored as admin, read as mashgiach -> default
  const demoted = { ...admin, role: 'mashgiach' };
  check('demoted admin -> board', readSavedScreen(demoted), S('board'));
  forgetSavedScreens();
  check('sign-out forgets every screen', [...session.keys()].filter((k) => k.startsWith('shutfey_screen:')).length, 0);
  check('after forget -> default', readSavedScreen(admin), S('home'));
  // Blocked storage never throws
  globalThis.window = { get sessionStorage() { throw new Error('blocked'); } };
  check('blocked storage read -> default', readSavedScreen(admin), S('home'));
  saveScreen(admin, S('board', 'team')); check('blocked storage save does not throw', true, true);
}

// App wiring (source): restored on load, saved on change, never on the kiosk.
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const has = (label, re) => check(label, re.test(app), true);
has('App reads the saved screen, kiosk excluded', /useState<SavedScreen>\(\(\) => \(isKiosk \? defaultScreen\(null\) : readSavedScreen\(currentUser\)\)\)/);
has('admin home follows the saved view', /useState\(\(\) => !isKiosk && currentUser\?\.role === 'admin' && restoredScreen\.view === 'home'\)/);
for (const [name, sheet] of [['HistoryModal', 'history'], ['EventsModal', 'events']]) {
  has(`${name} opens at once from the saved sheet`, new RegExp(`\\[is${name}Open, setIs${name}Open\\] = useState\\(restoredScreen\\.sheet === '${sheet}'\\)`));
}
for (const name of ['VenuesDirectory', 'TeamModal', 'AgencyEvents']) {
  has(`${name} never opens from the cached role at load`, new RegExp(`\\[is${name}Open, setIs${name}Open\\] = useState\\(false\\)`));
}
has('restricted sheets reopen only after the server confirms (GET /api/auth/me)', /if \(isKiosk \|\| !cached \|\| !isRestrictedSheet\(sheet\)\) return;\s*let live = true;\s*apiFetch\('\/api\/auth\/me', \{ cache: 'no-store' \}\)/);
has('the answer goes through pendingOnAnswer and opens only when it says so', /const answer = pendingOnAnswer\(pending, cached, me, sheet\);[\s\S]{0,200}if \(!answer\.open\) return;/);
has('Team renders only for a role that may see it', /isOpen=\{isTeamModalOpen && sheetAllowed\(currentUser, 'team'\)\}/);
has('Venues renders only for a role that may see it', /isOpen=\{isVenuesDirectoryOpen && sheetAllowed\(currentUser, 'venues'\)\}/);
has('agency Events renders only for an admin', /isOpen=\{isAgencyEventsOpen && currentUser\?\.role === 'admin'\}/);
has('screen saved on change (unless a restore waits), never on the kiosk', /pendingOnScreen\(pendingRestore\.current, isKiosk \? null : currentUser, screen\);[\s\S]{0,80}if \(isKiosk \|\| !currentUser \|\| !next\.save\) return;\s*saveScreen\(currentUser, screen\)/);
has('pending restore starts from the loaded screen, not on a kiosk', /useRef<PendingRestore \| null>\(startPendingRestore\(currentUser, restoredScreen, isKiosk\)\)/);
has('a sheet the role cannot see is closed', /if \(isKiosk \|\| !screenSheet \|\| sheetAllowed\(currentUser, screenSheet\)\) return;/);
has('sign-out forgets saved screens', /localStorage\.removeItem\('selected_venue_id'\);\s*forgetSavedScreens\(\);\s*\}\s*clearSession\(\);/);
has('kiosk entry forgets saved screens', /forgetSignedInUserForKiosk\(\);\s*forgetSavedScreens\(\);/);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
