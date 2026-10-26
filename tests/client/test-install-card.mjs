import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Execute the first imports without browser globals, including Node's navigator.
const browserGlobals = ['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
for (const [key] of browserGlobals) delete globalThis[key];
await import('../../src/lib/installCard.ts');
await import('../../src/hooks/usePWAInstall.ts');
for (const [key, descriptor] of browserGlobals) if (descriptor) Object.defineProperty(globalThis, key, descriptor);
const values = new Map();
globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) };
const P = await import('../../src/lib/installCard.ts');
const base = { fresh: true, kiosk: false, phone: true, standalone: false, installedMark: false, snoozed: false, hasPrompt: true, ios: false, iosSafari: false };
assert.equal(P.installCardPath(base), 'prompt');
for (const [key, value] of [['fresh', false], ['phone', false], ['kiosk', true], ['standalone', true], ['installedMark', true], ['snoozed', true]]) {
  assert.equal(P.installCardPath({ ...base, [key]: value }), null, key);
}
assert.equal(P.installCardPath({ ...base, hasPrompt: false }), null);
const safari17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const safari18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const phonePrefix = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ';
const cases = [
  [safari17, true, true], [safari18, true, true],
  [phonePrefix + 'CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1', true, false],
  [phonePrefix + 'FxiOS/131.0 Mobile/15E148 Safari/605.1.15', true, false],
  [phonePrefix + 'EdgiOS/129.0.2792.65 Mobile/15E148 Safari/605.1.15', true, false],
  [phonePrefix + 'OPiOS/4.0 Mobile/15E148 Safari/604.1', true, false],
  [phonePrefix + 'Mobile/15E148 Instagram 350.0.0.27.93', true, false],
  [phonePrefix + 'Mobile/15E148 Safari/604.1 [FBAN/FBIOS;FBAV/480.0.0.0.0]', true, false],
  [phonePrefix + 'Mobile/15E148', true, false],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', false, false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', false, false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', false, false],
];
for (const [ua, ios, safari] of cases) {
  assert.equal(P.isIOSDevice(ua), ios, ua);
  assert.equal(P.isIOSSafari(ua), safari, ua);
  assert.equal(P.installCardPath({ ...base, hasPrompt: false, ios, iosSafari: safari }), ios ? safari ? 'ios-safari' : 'ios-other' : null);
}
assert.equal(P.isIOSDevice(undefined), false);
assert.equal(P.isIOSSafari(undefined), false);
assert.equal(P.isStandalone({}), false);
assert.equal(P.isStandalone({ navigator: {} }), false);
assert.equal(P.isStandalone({ matchMedia() { throw Error('blocked'); } }), false);
assert.equal(P.isStandalone({ matchMedia: () => ({ matches: true }), navigator: {} }), true);
assert.equal(P.isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }), true);
assert.equal(P.isStandalone({ matchMedia: () => ({ matches: false }), navigator: {} }), false);
const t = 1_800_000_000_000;
P.snoozeInstallCard(t);
assert.equal(P.installCardSnoozed(t + (13 * 24 + 23) * 3600000), true);
assert.equal(P.installCardSnoozed(t + P.INSTALL_CARD_SNOOZE_MS + 1), false);
for (const bad of ['garbage', '', 'Infinity', String(t + P.INSTALL_CARD_SNOOZE_MS + 1)]) {
  values.set('shutfey_install_card_snooze_until', bad);
  assert.equal(P.installCardSnoozed(t), true); // Invalid dates fail closed.
}
P.markAppInstalled();
assert.equal(P.appMarkedInstalled(), true);
globalThis.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
P.snoozeInstallCard(t); P.markAppInstalled();
assert.equal(P.installCardSnoozed(t), true);
assert.equal(P.appMarkedInstalled(), true);
assert.equal(P.installCardPath({ ...base, snoozed: P.installCardSnoozed(t), installedMark: P.appMarkedInstalled() }), null);
const read = file => readFileSync(new URL('../../src/' + file, import.meta.url), 'utf8');
const app = read('App.tsx'), card = read('components/InstallCard.tsx'), hook = read('hooks/usePWAInstall.ts');
assert.match(app, /const handleLoginSuccess = \(user: User\) => \{\s*setFreshInstallFor\(!isKiosk \? user.id : null\)/);
assert.match(app, /!isKiosk && !passkeyOfferFor && !passkeyOfferPending[^\n]+installCardOpenFor === currentUser\?\.id && \(\s*<InstallCard/);
assert.match(app, /finally\(\(\) => \{\s*if \(live\) \{ setPasskeyOfferPending\(false\); setPasskeyCheckFor\(userId\);/);
assert.ok(hook.indexOf("window.addEventListener('beforeinstallprompt'") < hook.indexOf('export function usePWAInstall'));
assert.ok(!hook.includes('useEffect'));
assert.ok(app.includes('if (!installGate) return null;'));
assert.ok(app.includes('until: Date.now() + 60_000'));
assert.ok(app.includes('if (installCardOpenFor === freshInstallFor) return;'));
assert.ok(app.includes('if (remaining <= 0) { setFreshInstallFor(null); return; }'));
for (const source of [card, read('lib/installCard.ts')]) assert.doesNotMatch(source, /React\.lazy|import\(/);
assert.doesNotMatch(card, /text-white|text-\[1\dpx\]/);
for (const attr of ['data-install-card', 'data-install-card-view', 'data-install-card-install', 'data-install-card-notnow', 'data-install-card-done', 'data-install-card-copy']) assert.ok(card.includes(attr));
assert.ok(card.includes("document.getElementById('root')"));
assert.ok(card.includes("appRoot?.setAttribute('inert', '')"));
assert.ok(card.includes("appRoot?.removeAttribute('inert')"));
assert.ok(card.includes("appRoot?.setAttribute('inert', previousInert)"));
assert.match(card, /<h2[^>]+tabIndex={-1}/);
assert.match(card, /useEffect\(\(\) => {[^}]*title\.current\?\.focus\(\);\s*}, \[view, busy\]\)/);
assert.ok(card.includes('document.contains(previous)'));
assert.match(card, /const visible = !!path \|\| busy;/);
assert.match(card, /useEffect\(\(\) => \{\s*if \(!visible\) return;[\s\S]*?appRoot\?\.setAttribute\('inert', ''\)[\s\S]*?\}, \[visible\]\)/);
assert.match(card, /useEffect\(\(\) => \{\s*if \(path === null && !busy\) onClose\(\);\s*\}, \[path, busy, onClose\]\)/);
console.log('Install card rules, UA, storage and source checks passed');
