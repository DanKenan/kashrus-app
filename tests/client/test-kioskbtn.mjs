/**
 * KIOSKBTN (Don, Oct 26): the "Set up this device as a venue kiosk" button on the sign-in screen of the
 * shared address AND an agency's own address (the installed app has no address bar for ?kiosk=1), and
 * the kiosk-entry clean slate: ?kiosk=1 never opens as the person signed in before.
 * Run: npx tsx tests/client/test-kioskbtn.mjs
 */
import React from 'react';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; }
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { location: { hostname: 'app.valley.test', host: 'app.valley.test', origin: 'https://app.valley.test', protocol: 'https:', pathname: '/', search: '', hash: '', href: 'https://app.valley.test/' }, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: function CustomEventStub(type, init) { return { type, detail: init?.detail }; } });
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, cookie: '' };
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}', clone() { return this; } });

const K = await import('../../src/lib/kioskSetup.ts');
const { LoginPage } = await import('../../src/components/LoginPage.tsx');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ---- the button: shared + agency address, plain login only, never on a kiosk ----
const base = { onLoginSuccess() {}, darkMode: false, onToggleDarkMode() {} };
const agency = { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null };
const BTN = 'data-kiosk-setup=""';
const render = (props) => renderToStaticMarkup(React.createElement(LoginPage, { ...base, ...props }));
store.clear();
const shared = render({ onBack() {} });
check('shared address, login: button shows', shared.includes(BTN) && shared.includes('Set up this device as a venue kiosk'));
const branded = render({ site: agency });
check('agency address, login: button shows (same words)', branded.includes(BTN) && branded.includes('Set up this device as a venue kiosk') && branded.includes('Powered by Shutfey'));
const sharedBtn = shared.slice(shared.lastIndexOf('<button', shared.indexOf(BTN)), shared.indexOf('</button>', shared.indexOf(BTN)));
const brandedBtn = branded.slice(branded.lastIndexOf('<button', branded.indexOf(BTN)), branded.indexOf('</button>', branded.indexOf(BTN)));
check('same button markup (style, icon, text) on both addresses', sharedBtn.length > 50 && sharedBtn === brandedBtn);
check('agency address: button sits below the sign-in card', branded.indexOf(BTN) > branded.indexOf('type="password"'));
const signup = render({ onBack() {}, initialMode: 'signup' });
check('shared address, signup (agency registration): no button', !signup.includes(BTN) && signup.includes('Kosher Agency Registration'));
const brandedSignup = render({ site: agency, initialMode: 'signup' });
check('agency address asked for signup stays sign-in (no registration there), button shows', brandedSignup.includes(BTN) && !brandedSignup.includes('Kosher Agency Registration'));
store.set('kiosk_mode', '1');
check('in kiosk mode: no button (shared)', !render({ onBack() {} }).includes(BTN));
check('in kiosk mode: no button (agency address)', !render({ site: agency }).includes(BTN));
store.clear();
const login = read('src/components/LoginPage.tsx');
check('chooser / first-run password setup: no button (condition)', /\{authMode === 'login' && !chooser && !needsSetup && !isKioskModeOn\(\) && \(\s*<button[\s\S]*?data-kiosk-setup=""/.test(login));
check('the button is the only kiosk entry on LoginPage and uses enterKioskSetup', login.split('data-kiosk-setup').length === 2 && /data-kiosk-setup=""\s*onClick=\{enterKioskSetup\}/.test(login));

// ---- kiosk entry helpers ----
check('isKioskEntryUrl: ?kiosk=1', K.isKioskEntryUrl('?kiosk=1') && K.isKioskEntryUrl('?a=b&kiosk=1'));
check('isKioskEntryUrl: not ?kiosk=0, empty, other', !K.isKioskEntryUrl('?kiosk=0') && !K.isKioskEntryUrl('') && !K.isKioskEntryUrl('?kiosk=true'));
check('isKioskModeOn follows the stored flag', (store.set('kiosk_mode', '1'), K.isKioskModeOn()) && (store.delete('kiosk_mode'), !K.isKioskModeOn()));
for (const k of ['shutfey_session_token', 'shutfey_user', 'current_user', 'selected_venue_id', 'shutfey_agency_logo']) store.set(k, 'x');
store.set('kiosk_device', 'dev1.secret'); store.set('kiosk_mode', '1'); store.set('theme_mode', 'dark');
K.forgetSignedInUserForKiosk();
check('kiosk entry forgets every signed-in key (current_user too)', ['shutfey_session_token', 'shutfey_user', 'current_user', 'selected_venue_id', 'shutfey_agency_logo'].every((k) => !store.has(k)));
check('kiosk entry keeps the kiosk keys and settings', store.get('kiosk_device') === 'dev1.secret' && store.get('kiosk_mode') === '1' && store.get('theme_mode') === 'dark');
const saveLS = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
let threw = false;
try { K.forgetSignedInUserForKiosk(); K.isKioskModeOn(); } catch { threw = true; }
check('blocked storage: no throw', !threw && K.isKioskModeOn() === false);
globalThis.localStorage = saveLS;
store.clear();
window.location.pathname = '/';
K.enterKioskSetup();
check('enterKioskSetup: kiosk flag + ?kiosk=1 on the same address', store.get('kiosk_mode') === '1' && window.location.href === '/?kiosk=1');

// ---- ?kiosk=1 leaves the address once handled ----
const hist = [];
window.history = { state: { k: 1 }, replaceState: (s, _t, url) => { hist.push({ s, url }); } };
window.location.search = '?kiosk=1'; window.location.pathname = '/'; window.location.hash = '';
K.stripKioskEntryFromUrl();
check('strip: ?kiosk=1 -> / (history state kept)', hist.length === 1 && hist[0].url === '/' && hist[0].s.k === 1);
window.location.search = '?a=b&kiosk=1'; window.location.hash = '#x';
K.stripKioskEntryFromUrl();
check('strip: other parameters and the hash are kept', hist[1]?.url === '/?a=b#x');
window.location.search = '?kiosk=0'; K.stripKioskEntryFromUrl(); window.location.search = ''; K.stripKioskEntryFromUrl();
check('strip: nothing to do for ?kiosk=0 or no parameter', hist.length === 2);
window.history = { replaceState() { throw new Error('blocked'); } }; window.location.search = '?kiosk=1';
let threw2 = false; try { K.stripKioskEntryFromUrl(); } catch { threw2 = true; }
check('strip: a history error does not throw', !threw2);
window.location.search = ''; window.location.hash = '';

// ---- App: kiosk entry starts signed out, and a kiosk never shows a signed-in person without a device ----
const app = read('src/App.tsx');
const cuInit = app.slice(app.indexOf('const [currentUser, setCurrentUser] = useState<User | null>(() => {'), app.indexOf("const [authView, setAuthView]"));
check('App: currentUser starts null on ?kiosk=1 (before reading current_user)', cuInit.indexOf('if (isKioskEntryUrl(window.location.search)) return null;') > 0 && cuInit.indexOf('isKioskEntryUrl') < cuInit.indexOf("localStorage.getItem('current_user')"));
const kInit = app.slice(app.indexOf("if (params.get('kiosk') === '1') {"), app.indexOf("return localStorage.getItem('kiosk_mode') === '1';"));
check('App: ?kiosk=1 ends the server session, then forgets every signed-in key, then leaves the address', kInit.indexOf('endSessionForKioskEntry();') > 0 && kInit.indexOf('forgetSignedInUserForKiosk();') > kInit.indexOf('endSessionForKioskEntry();') && kInit.indexOf('stripKioskEntryFromUrl();') > kInit.indexOf('forgetSignedInUserForKiosk();'));
check('App: the kiosk init runs before anything else reads current_user at start', app.indexOf("if (params.get('kiosk') === '1') {") < app.indexOf("const saved = typeof window !== 'undefined' ? localStorage.getItem('current_user') : null;"));
check('App: an unpaired kiosk with a person signs them out quietly', /const kioskUnpairedUser = isKiosk && !kioskDevice && !!currentUser;\s*useEffect\(\(\) => \{\s*if \(!kioskUnpairedUser\) return;\s*quietLogoutRef\.current = true;\s*handleLogout\(\);/.test(app));
check('App: an unpaired kiosk never renders a signed-in screen, even before that runs', /if \(kioskUnpairedUser\) \{\s*return <div data-kiosk-clearing className="min-h-screen bg-paper" \/>;\s*\}\s*if \(!currentUser\) \{\n    \/\/ Kiosk tablets pair once/.test(app) && app.indexOf('if (kioskUnpairedUser) {') > app.indexOf('const kioskUnpairedUser'));
const body = app.slice(app.indexOf('{/* Main Body */}'));
check('App: never the admin setup screen on a kiosk', body.indexOf('venues.length === 0 && isKiosk ? (') > 0 && body.indexOf('venues.length === 0 && isKiosk ? (') < body.indexOf('Establish First Kosher Venue') && body.includes('data-kiosk-no-venue'));

const pairing = read('src/components/KioskPairing.tsx');
check('pairing code fits a phone (smaller below sm, box never wider than the screen)', /data-pairing-code=""[\s\S]{0,200}?max-w-full/.test(pairing) && pairing.includes('text-5xl sm:text-6xl font-black tracking-[0.12em] sm:tracking-[0.18em]'));

console.log(`test-kioskbtn: ${passed} checks passed`);
