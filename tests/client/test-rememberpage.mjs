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
  const { screenFromStored, defaultScreen, readSavedScreen, saveScreen, forgetSavedScreens, sheetAllowed, screenStorageKey } = mod;
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
for (const [name, sheet] of [['VenuesDirectory', 'venues'], ['HistoryModal', 'history'], ['TeamModal', 'team'], ['EventsModal', 'events']]) {
  has(`${name} opens from the saved sheet`, new RegExp(`\\[is${name}Open, setIs${name}Open\\] = useState\\(restoredScreen\\.sheet === '${sheet}'\\)`));
}
has('screen saved on change, never on the kiosk', /if \(isKiosk \|\| !currentUser\) return;\s*saveScreen\(currentUser, \{ view: screenView, sheet: screenSheet \}\)/);
has('a sheet the role cannot see is closed', /if \(isKiosk \|\| !screenSheet \|\| sheetAllowed\(currentUser, screenSheet\)\) return;/);
has('sign-out forgets saved screens', /localStorage\.removeItem\('selected_venue_id'\);\s*forgetSavedScreens\(\);\s*\}\s*clearSession\(\);/);
has('kiosk entry forgets saved screens', /forgetSignedInUserForKiosk\(\);\s*forgetSavedScreens\(\);/);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
