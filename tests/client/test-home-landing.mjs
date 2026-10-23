/**
 * Home page on the shared address (landing-on-app): which screen opens first, when the home page is
 * allowed on a host, the scoped CSS, the chunk-reload guard, and the "no Adler / demo data" rule.
 * Run: npx tsx tests/client/test-home-landing.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; }

// ---- installed app -> sign-in form; a browser tab -> home page ----
const R = await import('../../src/lib/homeRoute.ts');
const mm = (modes) => (q) => ({ matches: modes.some((m) => q === `(display-mode: ${m})`) });
check('browser tab: not installed', R.isInstalledApp({ matchMedia: mm(['browser']), navigator: {} }) === false);
for (const m of ['standalone', 'fullscreen', 'minimal-ui']) check(`display-mode ${m}: installed`, R.isInstalledApp({ matchMedia: mm([m]), navigator: {} }) === true);
check('iOS navigator.standalone: installed', R.isInstalledApp({ matchMedia: mm([]), navigator: { standalone: true } }) === true);
check('no matchMedia: not installed', R.isInstalledApp({ navigator: {} }) === false);
check('matchMedia throws: not installed', R.isInstalledApp({ matchMedia: () => { throw new Error('x'); }, navigator: {} }) === false);
check('initialAuthView: tab -> landing', R.initialAuthView({ matchMedia: mm([]), navigator: {} }) === 'landing');
check('initialAuthView: installed -> auth', R.initialAuthView({ matchMedia: mm(['standalone']), navigator: {} }) === 'auth');

// ---- home page only on an address known to be the shared one ----
globalThis.window = { location: { hostname: 'app.example.test' } };
const S = await import('../../src/lib/site.ts');
const answer = (status, body) => async () => ({ ok: status < 300, status, json: async () => (typeof body === 'function' ? body() : body) });
check('Cloud Run host: allowed without an answer', S.homePageAllowed('workers-collaborative-dashboard-1.us-east1.run.app') && S.homePageAllowed('localhost') && S.homePageAllowed('127.0.0.1'));
const cases = [
  ['answer shared', answer(200, { site: 'shared' }), true],
  ['answer agency', answer(200, { site: 'agency', agency: { name: 'Valley Vaad', shortCode: 'VV' }, sharedOrigin: null }), false],
  ['answer unknown', answer(200, { site: 'unknown', sharedOrigin: null }), false],
  ['HTTP 500', answer(500, { site: 'shared' }), false],
  ['malformed JSON', answer(200, () => { throw new SyntaxError('bad'); }), false],
  ['unreadable answer', answer(200, { nope: 1 }), false],
  ['fetch throws (offline / aborted after the wait)', async () => { throw new TypeError('offline'); }, false],
];
for (const [label, impl, want] of cases) {
  S.resetSiteForTests();
  const info = await S.loadSite(impl);
  check(`custom host, ${label}: home page ${want ? 'allowed' : 'not allowed'} (site=${info.site})`, S.homePageAllowed('app.example.test') === want);
}
S.resetSiteForTests();
check('custom host before any answer: not allowed', S.homePageAllowed('app.example.test') === false);

// ---- scoped CSS: nothing applies outside the page ----
const css = read('src/components/home/home.css');
const tree = postcss.parse(css);
const kf = new Set();
tree.walkAtRules(/keyframes$/, (r) => kf.add(r.params.trim()));
check('keyframes exist and are all namespaced shf-home-*', kf.size >= 5 && [...kf].every((k) => k.startsWith('shf-home-')));
let bad = [];
tree.walkRules((rule) => {
  if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
  for (const s of rule.selectors) {
    const t = s.trim();
    if (!(t === '.shf-home' || t.startsWith('.shf-home ') || t.startsWith('.shf-home.') || t.startsWith(':where(.shf-home)') || t === 'body.shf-home-on::before')) bad.push(t);
  }
});
check(`every selector is scoped under .shf-home (unscoped: ${bad.slice(0, 5).join(' | ')})`, bad.length === 0);
bad = [];
tree.walkDecls(/^animation(-name)?$/, (d) => {
  for (const w of d.value.split(/[\s,]+/)) if (/^[a-z][\w-]*$/i.test(w) && !kf.has(w) && !/^(infinite|alternate|forwards|backwards|both|none|ease|ease-in|ease-out|ease-in-out|linear|reverse|normal|paused|running|alternate-reverse|step-start|step-end)$/.test(w) && !/^\d/.test(w)) bad.push(w);
});
check(`every animation names a page keyframe (others: ${bad.join(',')})`, bad.length === 0);
check('no @import and no global font-family override', !/@import/.test(css) && !/(^|})\s*(html|body|:root)\s*\{/.test(css));
check('page sets its own colour scheme', /\.shf-home\{color-scheme:light/.test(css));
check('Tailwind .ring box-shadow neutralised inside the page', css.includes('.shf-home .ring{box-shadow:none}'));
check('fonts/images are local assets of the lazy chunk', css.includes('url(./assets/home-landing-serif.woff2)') && css.includes('url(./assets/home-landing-mark.png)') && !/url\((?!\.\/assets\/|"data:|'data:|data:)/.test(css));

// ---- markup + content rules ----
const html = read('src/components/home/home.html');
check('top bar "Sign in" is wired (data-signin)', /<a class="pill" href="\/" data-signin>Sign in<\/a>/.test(html));
check('contact links as on the preview', html.includes('href="mailto:Kenan@hartfordkashrut.org?subject=Shutfey"') && html.includes('href="tel:+13476700381"') && html.includes('href="sms:+13476700381"') && html.includes('href="mailto:Kenan@hartfordkashrut.org"'));
check('no "Preview." in the footer; demo-data note kept', !html.includes('Preview.') && html.includes('All screens show demo data.'));
check('markup has no scripts, images or external URLs', !/<script|<img|<iframe|src=|https?:\/\//i.test(html));
const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
check(`only in-page, sign-in and contact links (${hrefs.filter((h) => !/^(#[\w-]+|\/|mailto:|tel:|sms:)/.test(h)).join(',')})`, hrefs.every((h) => /^(#[\w-]+|\/|mailto:|tel:|sms:)/.test(h)));
for (const f of ['src/components/home/home.html', 'src/components/home/home.css', 'src/components/home/HomeLanding.tsx', 'src/components/home/homeDemos.ts', 'index.html']) check(`no "Adler" in ${f}`, !/adler/i.test(read(f)));
const tsx = read('src/components/home/HomeLanding.tsx');
const ksrc = read('src/lib/kioskSetup.ts');
check('kiosk setup kept (same code as the old home screen)', ksrc.includes("localStorage.setItem('kiosk_mode', '1')") && ksrc.includes('?kiosk=1') && tsx.includes('Set up this device as a venue kiosk') && tsx.includes("from '../../lib/kioskSetup'"));
const login = read('src/components/LoginPage.tsx');
check('sign-in screen (shared address, login mode) also has the kiosk setup button; not on an agency address', /\{!branded && authMode === 'login' && !chooser && \(\s*<button[\s\S]*?data-kiosk-setup=""[\s\S]*?onClick=\{enterKioskSetup\}[\s\S]*?Set up this device as a venue kiosk/.test(login) && login.includes("from '../lib/kioskSetup'"));
check('LoginPage does not import the lazy home page', !/components\/home|\.\/home\//.test(login));
check('HomeLanding: demos stopped and grain class removed on unmount', /return \(\) => \{[\s\S]*stopDemos\(\);[\s\S]*classList\.remove\('shf-home-on'\)/.test(tsx));

// ---- App wiring (source) ----
const app = read('src/App.tsx');
check('HomeLanding is a lazy import', /const HomeLanding = lazy\(\(\) => import\('\.\/components\/home\/HomeLanding'\)\)/.test(app) && !/from '\.\/components\/home\/HomeLanding'/.test(app));
check('old hub component no longer imported', !/import \{ LandingPage \}/.test(app));
check('landing only when not an agency site and allowed on this host', app.includes("if (authView === 'landing' && !siteAgency && homePageAllowed()) {"));
check('installed app opens on the sign-in form', app.includes('useState<\'landing\' | \'auth\'>(initialAuthView)'));
check('sign-out -> sign-in form; leaving kiosk -> sign-in form; only LoginPage "Home" opens the home page (or, on an agency address outside the installed app, its welcome page)', app.includes("if (!kioskMode) setAuthView('auth');") && app.includes("// Leaving kiosk mode opens the sign-in form (not the home page).\n    setAuthView('auth');") && app.split("setAuthView('landing')").length === 2 && app.includes("onBack={siteAgency && isInstalledApp() ? undefined : () => setAuthView('landing')}"));
check('landing wrapped in its error boundary + Suspense', /<HomeLandingBoundary onSignIn=\{openSignInFromHome\}>\s*<Suspense fallback=/.test(app));
const vite = read('vite.config.ts');
// The home page's files ARE precached (like every other built file): a new version takes over only on a tap,
// so a tab still on the old version must find its own home-page file in the old precache after a deploy.
check('home-page files stay in the service worker precache (no globIgnores for them)', !vite.includes('globIgnores') && vite.includes("globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']"));
check('Tailwind does not scan the page markup', read('src/index.css').includes('@source not "./components/home";'));

// ---- chunk reload guard (rule BO) ----
const listeners = {};
let reloads = 0;
const ss = new Map();
let storageThrows = false;
globalThis.sessionStorage = { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return ss.get(k) ?? null; }, setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); ss.set(k, String(v)); } };
globalThis.window = { addEventListener: (t, fn) => { listeners[t] = fn; }, location: { reload: () => { reloads++; } } };
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get onLine() { return online; } } });
const { installChunkReload } = await import('../../src/lib/chunkReload.ts');
installChunkReload();
const fire = () => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; listeners['vite:preloadError'](ev); return ev; };
let ev = fire();
check('online, first failure: reload once (event handled)', reloads === 1 && ev.prevented);
ev = fire();
check('second failure within 30 s: no reload, error surfaces', reloads === 1 && !ev.prevented);
ss.clear(); online = false; ev = fire();
check('offline: no reload (boundary shows Sign in / Try again)', reloads === 1 && !ev.prevented);
online = true; storageThrows = true; ev = fire();
check('storage unavailable: no reload', reloads === 1 && !ev.prevented);
storageThrows = false; ss.set('shutfey-chunk-reload-at', String(Date.now() - 31_000)); ev = fire();
check('after 30 s: one more reload allowed', reloads === 2 && ev.prevented);

console.log(`home-landing: ${passed} checks passed`);
