/**
 * Update bar ("New version ready — Tap to update"): the app never reloads on its own.
 *   R* rule: no automatic switch/reload in any path (open, install, other tab, browser swap, resume).
 *   A* applyUpdate: busy -> nothing changes; safe -> SKIP_WAITING, reload once when the new worker controls.
 *   B* the bar (UpdateBanner).  G* the safety gate (updateSafety).  S* static wiring.
 * Run: npx tsx tests/client/test-update-banner.mjs
 */
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- fake browser: a page opened under an older worker ----
function emitter() { const m = {}; return { on(t, f) { (m[t] ||= []).push(f); }, off(t, f) { m[t] = (m[t] || []).filter((x) => x !== f); }, emit(t, e) { for (const f of [...(m[t] || [])]) f(e || {}); } }; }
const swEv = emitter(); const docEv = emitter(); const winEv = emitter();
const posted = []; let reloads = 0;
function worker(state) { const e = emitter(); const w = { state, addEventListener: e.on, removeEventListener: e.off, postMessage: (m) => posted.push([w, m]), set(s) { w.state = s; e.emit('statechange'); } }; return w; }
const oldWorker = worker('activated');
const sw = { controller: oldWorker, addEventListener: swEv.on, removeEventListener: swEv.off, getRegistration: async () => reg, ready: Promise.resolve() };
let layers = []; let active = null;
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true, writable: true });
globalThis.sessionStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); } };
globalThis.window = { location: { reload: () => { reloads++; } }, addEventListener: winEv.on, removeEventListener: winEv.off };
globalThis.document = { visibilityState: 'visible', addEventListener: docEv.on, removeEventListener: docEv.off, get activeElement() { return active; }, querySelectorAll: () => layers, querySelector: () => null };
const intervals = []; globalThis.setInterval = (f, ms) => { intervals.push([f, ms]); return 1; };
const regEv = emitter();
let updates = 0;
const reg = { waiting: null, installing: null, addEventListener: regEv.on, removeEventListener: regEv.off, update: async () => { updates++; } };

const swu = await import('../../src/lib/swUpdate.ts');
const api = await import('../../src/lib/api.ts');
const { updateBlockedReason } = await import('../../src/lib/updateSafety.ts');
const { UpdateBanner } = await import('../../src/components/UpdateBanner.tsx');
const skips = () => posted.filter(([, m]) => m && m.type === 'SKIP_WAITING').length;

// ---- R: nothing switches or reloads on its own ----
swu.initSwUpdates(reg);
ok('R open, nothing waiting -> no bar', swu.getUpdateState() === 'none');
const w1 = worker('installing'); reg.installing = w1; regEv.emit('updatefound');
reg.installing = null; reg.waiting = w1; w1.set('installed');
ok('R a new version finishes installing while open -> bar', swu.getUpdateState() === 'ready');
ok('R ... and no switch, no reload', skips() === 0 && reloads === 0, `skips=${skips()} reloads=${reloads}`);
docEv.emit('visibilitychange');
ok('R back to the screen with a version waiting (untouched page) -> still no switch/reload', skips() === 0 && reloads === 0);
swEv.emit('controllerchange');
ok('R browser swapped versions under the page -> no reload (bar offers it)', reloads === 0 && swu.getUpdateState() === 'ready');
swu.onNewVersionActivated();
ok('R another tab activated the new version -> no reload, bar stays', reloads === 0 && swu.getUpdateState() === 'ready');
winEv.emit('online'); await tick();
ok('R back online -> a check (download only)', updates >= 1 && skips() === 0 && reloads === 0, `updates=${updates}`);
ok('R hourly check registered (download only)', intervals.some(([, ms]) => ms === 60 * 60_000));
intervals.find(([, ms]) => ms === 60 * 60_000)[0](); await tick();
ok('R hourly tick: no switch, no reload', skips() === 0 && reloads === 0);

// first visit: nothing old to replace -> no bar
swu.__resetSwUpdatesForTest();
sw.controller = null; reg.waiting = worker('installed');
swu.initSwUpdates(reg);
ok('R first visit (no worker controlled the page) -> no bar', swu.getUpdateState() === 'none');
sw.controller = oldWorker;

// ---- A: the tap ----
swu.__resetSwUpdatesForTest();
const w2 = worker('installed'); reg.waiting = w2; reg.installing = null;
swu.initSwUpdates(reg);
ok('A waiting version on open -> bar', swu.getUpdateState() === 'ready');
let r = await swu.applyUpdate(() => 'saving');
ok('A tap while saving -> busy, nothing sent', typeof r === 'object' && r.busy === 'saving' && skips() === 0 && reloads === 0, JSON.stringify(r));
ok('A ... bar still offers the tap', swu.getUpdateState() === 'ready');
const pending = swu.applyUpdate(() => null);
await tick();
ok('A safe tap -> SKIP_WAITING to the waiting worker', skips() === 1 && posted.at(-1)[0] === w2);
ok('A ... no reload before the new worker controls the page', reloads === 0);
ok('A ... bar says updating', swu.getUpdateState() === 'updating');
sw.controller = w2; w2.state = 'activated'; swEv.emit('controllerchange');
r = await pending;
ok('A new worker controls -> exactly one reload', r === 'updating' && reloads === 1, `r=${r} reloads=${reloads}`);
swEv.emit('controllerchange');
ok('A no second reload from the same switch', reloads === 1);

// reload-only case: another tab already switched
swu.__resetSwUpdatesForTest(); sessionStorage._m = {};
reg.waiting = null; sw.controller = w2;
swu.initSwUpdates(reg);
swu.onNewVersionActivated();
ok('A other tab switched -> bar', swu.getUpdateState() === 'ready');
r = await swu.applyUpdate(() => 'open');
ok('A tap while a form is open -> busy, no reload', typeof r === 'object' && r.busy === 'open' && reloads === 1);
r = await swu.applyUpdate(() => null);
ok('A safe tap -> one reload (new code already in control)', r === 'updating' && reloads === 2, `r=${r} reloads=${reloads}`);

// takeover that never completes -> failed, bar back
swu.__resetSwUpdatesForTest(); sessionStorage._m = {};
const w3 = worker('installed'); reg.waiting = w3; sw.controller = oldWorker;
swu.initSwUpdates(reg);
const realST = globalThis.setTimeout;
globalThis.setTimeout = (f, ms) => realST(f, ms >= 10_000 ? 0 : ms);
r = await swu.applyUpdate(() => null);
globalThis.setTimeout = realST;
ok('A takeover never completes -> failed, no reload', r === 'failed' && reloads === 2, `r=${r} reloads=${reloads}`);
ok('A ... bar offers the tap again', swu.getUpdateState() === 'ready');

// ---- B: the bar ----
swu.__resetSwUpdatesForTest(); sessionStorage._m = {};
reg.waiting = null; sw.controller = oldWorker;
swu.initSwUpdates(reg);
const b = mount(UpdateBanner, {});
await b.render();
ok('B nothing new -> renders nothing', b.html() === '');
const w4 = worker('installed'); reg.waiting = w4; docEv.emit('visibilitychange');
await b.render();
const h = b.html();
ok('B ready -> "New version ready" + "Tap to update"', h.includes('New version ready') && h.includes('Tap to update'), h);
ok('B status role for screen readers, 44px tap target', h.includes('role="status"') && h.includes('aria-live="polite"') && /h-11/.test(h));
ok('B marked so the safety gate ignores it', h.includes('data-update-banner'));
ok('B not a full-screen layer (does not block the app)', !/fixed inset-0/.test(h) && h.includes('pointer-events-none'));
layers = [{ closest: () => null }];
const s0 = skips();
await b.click('Tap to update');
ok('B tap with a sheet open -> "Will update when you\'re done", nothing sent', b.html().includes('Will update when you&#x27;re done') && skips() === s0, b.html());
ok('B ... tap is offered again', b.html().includes('Tap to update'));
layers = [];
const tapP = b.click('Tap to update');
await tick(); await tick();
ok('B safe tap -> SKIP_WAITING', skips() === s0 + 1 && posted.at(-1)[0] === w4);
sw.controller = w4; w4.state = 'activated'; swEv.emit('controllerchange');
await tapP;
ok('B ... one reload', reloads === 3, `reloads=${reloads}`);

// ---- G: safety gate ----
layers = []; active = null;
ok('G nothing going on -> safe', updateBlockedReason() === null);
active = { tagName: 'TEXTAREA', getAttribute: () => null, closest: () => null };
ok('G typing a note -> typing', updateBlockedReason() === 'typing');
active = { tagName: 'INPUT', getAttribute: () => 'text', closest: () => null };
ok('G in a text field -> typing', updateBlockedReason() === 'typing');
active = { tagName: 'INPUT', getAttribute: () => 'checkbox', closest: () => null };
ok('G a checkbox has focus -> not typing', updateBlockedReason() === null);
active = { tagName: 'BUTTON', getAttribute: () => null, closest: (s) => (s === '[data-update-banner]' ? {} : null) };
ok('G the bar\'s own button has focus -> safe', updateBlockedReason() === null);
active = null; layers = [{ closest: () => null }];
ok('G a form/sheet is open -> open', updateBlockedReason() === 'open');
layers = [{ closest: (s) => (s === '[data-update-banner]' ? {} : null) }];
ok('G only the bar itself -> safe', updateBlockedReason() === null);
layers = [];
let release; globalThis.fetch = () => new Promise((res) => { release = () => res({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }); });
const wp = api.apiWrite('/api/x', { method: 'POST', body: '{}' });
await tick();
ok('G a write is in flight -> saving', api.writesInFlight() === 1 && updateBlockedReason() === 'saving', String(api.writesInFlight()));
release(); await wp;
ok('G write answered -> safe again', api.writesInFlight() === 0 && updateBlockedReason() === null);
globalThis.fetch = async () => { throw new TypeError('offline'); };
await api.apiWrite('/api/x', { method: 'POST', body: '{}' });
ok('G a failed write does not leave the counter stuck', api.writesInFlight() === 0);

// ---- S: static wiring ----
const src = fs.readFileSync(new URL('../../src/lib/swUpdate.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8');
ok('S bar rendered once next to the app', (main.match(/<UpdateBanner \/>/g) || []).length === 1);
ok('S no startup/untouched auto-switch left', !/stillStarting|STARTUP_WINDOW|interacted/.test(src));
ok('S takeOver only from the two taps (applyUpdate, checkForUpdate)', (src.match(/takeOver\(reg, true\)/g) || []).length === 2 && !/takeOver\(reg, false\)/.test(src));
{
  const all = (src.match(/reloadForUpdate\(/g) || []).length;
  const forced = (src.match(/reloadForUpdate\(true\)/g) || []).length;
  // the definition + the one inside takeOver (reached only from the taps); every other call is a tap's (force=true)
  ok('S every other reload is a tap\'s (force=true)', all - forced === 2 && /if \(ok\) reloadForUpdate\(force\)/.test(src), `all=${all} forced=${forced}`);
}

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
