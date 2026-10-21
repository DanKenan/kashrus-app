/**
 * D4b client test: which task view the Tasks screen opens on, and when a pick is stored.
 * Run: npx tsx tests/client/test-task-view-pref.mjs
 */
import { initialTaskView, rememberPhoneTaskView, readPhoneTaskView, TASK_VIEW_STORAGE_KEY } from '../../src/lib/taskViewPref.ts';

let failures = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok ${label}`);
  }
}

// Opening view by width (phone < 640; 640–767 cards as before; 768+ table as before)
check('390 no pick -> cards', initialTaskView(390, null), 'cards');
check('639 no pick -> cards', initialTaskView(639, null), 'cards');
check('390 picked table -> table', initialTaskView(390, 'table'), 'table');
check('639 picked table -> table', initialTaskView(639, 'table'), 'table');
check('390 picked cards -> cards', initialTaskView(390, 'cards'), 'cards');
check('390 junk pick -> cards', initialTaskView(390, 'grid'), 'cards');
check('640 picked table -> cards (not a phone, unchanged)', initialTaskView(640, 'table'), 'cards');
check('767 no pick -> cards (unchanged)', initialTaskView(767, null), 'cards');
check('768 no pick -> table (unchanged)', initialTaskView(768, null), 'table');
check('1280 picked cards -> table (desktop ignores phone pick)', initialTaskView(1280, 'cards'), 'table');

// Storing: only on a phone, never on wider screens; blocked storage never throws
const store = new Map();
globalThis.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
check('nothing stored at start', readPhoneTaskView(), null);
rememberPhoneTaskView('table', 1280);
check('desktop pick not stored', store.has(TASK_VIEW_STORAGE_KEY), false);
rememberPhoneTaskView('table', 700);
check('640–767 pick not stored', store.has(TASK_VIEW_STORAGE_KEY), false);
rememberPhoneTaskView('table', 390);
check('phone pick stored', readPhoneTaskView(), 'table');
rememberPhoneTaskView('cards', 639);
check('phone pick updated', readPhoneTaskView(), 'cards');
globalThis.window = { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } };
let threw = false;
try { rememberPhoneTaskView('table', 390); check('blocked storage read -> null', readPhoneTaskView(), null); } catch { threw = true; }
check('blocked storage does not throw', threw, false);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('all task-view-pref checks passed');
