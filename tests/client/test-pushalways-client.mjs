// PUSHALWAYS client: the banner decision, the menu button's words, and the
// quiet re-sync on app open (never asks; re-subscribes a phone that already
// allowed notifications; re-registers a phone the server lost).
import assert from 'node:assert/strict';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; } else { fail++; console.log('FAIL', name, extra); } };

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const events = [];
const fakeWindow = { dispatchEvent: (e) => { events.push(e.type); return true; }, addEventListener() {}, removeEventListener() {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), PushManager: function () {}, Notification: {} };
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
const perm = { value: 'default', asked: 0, answer: 'granted' };
globalThis.Notification = { get permission() { return perm.value; }, requestPermission: async () => { perm.asked++; if (perm.hold) { const h = perm.hold; perm.hold = null; await h.promise; } perm.value = perm.answer; return perm.value; } };
let browserSub = null; let subscribeCalls = 0;
const mkSub = (endpoint) => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { browserSub = null; } });
const reg = { pushManager: { getSubscription: async () => browserSub, subscribe: async () => { subscribeCalls++; browserSub = mkSub('https://push.example/dev1'); return browserSub; } } };
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { ready: Promise.resolve(reg) }, userAgent: 'x' }, configurable: true, writable: true });

const server = { registered: false, mode: 'all', posts: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const res = (status, j) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j), headers: new Headers() });
  // The server answers status at the moment the request arrives; a hold only delays the reply.
  const snap = { registered: server.registered, mode: server.mode };
  for (const [p, d] of Object.entries(server.hold || {})) if (u.endsWith(p)) { delete server.hold[p]; await d.promise; }
  if (u.endsWith('/api/push/public-key')) return res(200, { publicKey: 'AAAA' });
  if (u.endsWith('/api/push/status')) return res(200, snap);
  if (u.endsWith('/api/push/subscribe')) {
    if (server.failSubscribe) return res(500, { error: 'x' });
    server.posts.push(body); server.registered = true;
    // like the server: an older tap (choiceAt) than the one held is ignored, and no tap time never replaces a chosen setting
    if (body.mode && body.choiceAt && server.modeAt && body.choiceAt < server.modeAt) return res(200, { success: true, mode: server.mode, superseded: true });
    if (body.mode && !body.choiceAt && server.modeAt) return res(200, { success: true, mode: server.mode, superseded: true });
    if (body.mode) { server.mode = body.mode; if (body.choiceAt) server.modeAt = body.choiceAt; }
    return res(200, { success: true, mode: server.mode });
  }
  return res(404, {});
};

const P = await import('../../src/lib/pushPrompt.ts');
const push = await import('../../src/lib/push.ts');

// ---- banner decision ----
const base = { signedIn: true, kiosk: false, phone: true, supported: true, state: 'default', ios: false, standalone: false, snoozed: false, otherCardOpen: false };
ok('B1 a phone that never allowed notifications gets "Turn on"', P.pushPromptKind(base) === 'turn-on');
ok('B1b granted but no subscription -> Turn on', P.pushPromptKind({ ...base, state: 'granted' }) === 'turn-on');
for (const [k, v] of [['signedIn', false], ['kiosk', true], ['phone', false], ['snoozed', true], ['otherCardOpen', true]]) ok(`B2 no banner when ${k}=${v}`, P.pushPromptKind({ ...base, [k]: v }) === null);
ok('B3 no banner once subscribed', P.pushPromptKind({ ...base, state: 'subscribed' }) === null);
ok('B3b no banner while the quiet check runs', P.pushPromptKind({ ...base, state: null }) === null);
ok('B4 blocked phone gets the settings how-to', P.pushPromptKind({ ...base, state: 'denied' }) === 'blocked');
ok('B5 iPhone browser (no push outside the Home-Screen app) gets the install how-to', P.pushPromptKind({ ...base, supported: false, state: 'unsupported', ios: true }) === 'ios-install');
ok('B5b never a Turn-on button there', P.pushPromptKind({ ...base, supported: false, state: 'unsupported', ios: true }) !== 'turn-on');
ok('B6 an unsupported non-iPhone browser gets nothing', P.pushPromptKind({ ...base, supported: false, state: 'unsupported' }) === null);
ok('B6b Home-Screen iPhone without push (old iOS) gets nothing', P.pushPromptKind({ ...base, supported: false, state: 'unsupported', ios: true, standalone: true }) === null);
ok('B7 wording', P.PUSH_PROMPT_TEXT['turn-on'] === "Turn on notifications so you know when you're tagged or assigned.");
const now = 1_000_000;
ok('B8 not snoozed at first', !P.pushPromptSnoozed('u1', now));
P.snoozePushPrompt('u1', now);
ok('B8b "Not now" snoozes for this person', P.pushPromptSnoozed('u1', now + 1000) && !P.pushPromptSnoozed('u2', now + 1000));
ok('B8c the snooze ends after 7 days', !P.pushPromptSnoozed('u1', now + P.PUSH_PROMPT_SNOOZE_MS + 1));
store.set('shutfey_push_prompt_snooze_until:u3', 'garbage');
ok('B8d a corrupt snooze stays quiet', P.pushPromptSnoozed('u3', now));

// ---- button words ----
const vOn = P.pushToggleView('subscribed', 'all'), vTag = P.pushToggleView('subscribed', 'tagged'), vOff = P.pushToggleView('default', null);
ok('T1 subscribed + all = On', vOn.value === 'On' && vOn.on && vOn.key === 'on');
ok('T2 subscribed + tagged = Off, with the "still tagged/assigned" line', vTag.value === 'Off' && !vTag.on && /still get alerts when you're tagged or assigned/.test(vTag.note));
ok('T3 not set up = Off, with the turn-on line', vOff.value === 'Off' && vOff.key === 'off' && /Turn on/.test(vOff.note));
ok('T4 blocked', P.pushToggleView('denied', null).value === 'Blocked');

// ---- quiet re-sync ----
perm.value = 'default';
let r = await push.syncPushQuietly('a@x', 'u1');
ok('Q1 never asks for permission', perm.asked === 0 && subscribeCalls === 0 && r.state === 'default', JSON.stringify(r));
perm.value = 'denied';
r = await push.syncPushQuietly('a@x', 'u1');
ok('Q2 blocked: nothing', r.state === 'denied' && subscribeCalls === 0);
perm.value = 'granted';
r = await push.syncPushQuietly('a@x', 'u1');
ok('Q3 allowed but not subscribed (turned off the old way): subscribes quietly as "tagged"', r.state === 'subscribed' && r.mode === 'tagged' && subscribeCalls === 1 && perm.asked === 0, JSON.stringify(r));
ok('Q3b server got mode tagged', server.posts.at(-1)?.mode === 'tagged');
ok('Q3c setting remembered', push.rememberedPushMode('u1') === 'tagged');
server.mode = 'all'; // the person switched to On on another visit
r = await push.syncPushQuietly('a@x', 'u1');
ok('Q4 registered: no new subscribe, the server setting is the truth', r.mode === 'all' && subscribeCalls === 1 && push.rememberedPushMode('u1') === 'all');
ok('Q4b announces the change to the button', events.includes(push.PUSH_CHANGED_EVENT));
server.registered = false; const nPosts = server.posts.length;
r = await push.syncPushQuietly('a@x', 'u1');
ok('Q5 the server lost this phone: registered again with its setting', r.state === 'subscribed' && server.posts.length === nPosts + 1 && server.posts.at(-1).mode === 'all' && subscribeCalls === 1);
// Q5b (review PARV1): a shared phone — the browser subscription belongs to another account here; B has no setting on this phone.
server.registered = false;
r = await push.syncPushQuietly('c@x', 'u7');
ok('Q5b another account\'s subscription is registered for this person as "tagged", never everything unasked', r.mode === 'tagged' && server.posts.at(-1).mode === 'tagged' && server.posts.at(-1).userEmail === 'c@x', JSON.stringify(server.posts.at(-1)));
// Q5c: the server refuses the re-registration -> not shown as on.
server.registered = false; server.failSubscribe = true;
r = await push.syncPushQuietly('d@x', 'u8');
ok('Q5c a failed re-registration reads as not set up (Turn on offered), never "subscribed"', r.state === 'granted' && r.mode === null, JSON.stringify(r));
server.failSubscribe = false;
// getPushSetup: the button's state is server-confirmed.
server.registered = false;
let g = await push.getPushSetup('u8');
ok('G1 browser subscribed but the server has no record -> not set up', g.state === 'granted' && g.mode === null, JSON.stringify(g));
server.registered = true; server.mode = 'tagged';
g = await push.getPushSetup('u8');
ok('G2 server holds it -> subscribed with the server\'s setting', g.state === 'subscribed' && g.mode === 'tagged', JSON.stringify(g));
browserSub = null; store.delete('shutfey_push_mode:u9');
r = await push.syncPushQuietly('b@x', 'u9');
ok('Q6 a person with no remembered setting re-subscribes as "tagged" (never everything unasked)', r.mode === 'tagged' && server.posts.at(-1).mode === 'tagged');

// ---- switching ----
ok('S1 Off keeps the phone subscribed (mode tagged, no unsubscribe)', (await push.setPushMode('tagged', 'u9')) === 'done' && browserSub !== null && server.posts.at(-1).mode === 'tagged');
ok('S2 On again', (await push.setPushMode('all', 'u9')) === 'done' && server.posts.at(-1).mode === 'all' && push.rememberedPushMode('u9') === 'all');
browserSub = null;
ok('S3 no subscription: setPushMode reports failed', (await push.setPushMode('all', 'u9')) === 'failed');
perm.value = 'default'; perm.answer = 'denied';
ok('S4 Turn on asks once; a no is "denied"', (await push.subscribeForPush('b@x', 'all', 'u9')) === 'denied' && perm.asked === 1);
perm.value = 'default'; perm.answer = 'granted';
ok('S5 Turn on -> subscribed with all', (await push.subscribeForPush('b@x', 'all', 'u9')) === 'subscribed' && server.posts.at(-1).mode === 'all');

// R (review PARV2): the person's own tap wins over a quiet sync that started first.
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 20));
perm.value = 'granted';
// R1: a phone subscribed in the browser, not on the server for u20; quiet sync is waiting on the status read; the person taps On.
browserSub = mkSub('https://push.example/dev1'); server.registered = false; server.mode = 'all'; store.delete('shutfey_push_mode:u20');
let hold = deferred(); server.hold = { '/api/push/status': hold };
const quiet1 = push.syncPushQuietly('r@x', 'u20');
await tick();
const tap1 = push.setPushMode('all', 'u20');
ok('R1a the tap writes while the quiet sync still waits', (await tap1) === 'done' && server.posts.at(-1).mode === 'all');
hold.resolve(); const q1 = await quiet1;
ok('R1b the quiet sync stands down: no "tagged" write after the tap', server.posts.at(-1).mode === 'all' && server.mode === 'all', JSON.stringify(server.posts.slice(-2)));
ok('R1c and reports nothing of its own (stale; the tap repaints)', q1.stale === true, JSON.stringify(q1));
// R2: no browser subscription; the quiet subscribe is already writing (key fetch held) when the person taps Turn on.
browserSub = null; server.registered = false; store.delete('shutfey_push_mode:u21');
hold = deferred(); server.hold = { '/api/push/public-key': hold };
const quiet2 = push.syncPushQuietly('s@x', 'u21');
await tick();
const tap2 = push.subscribeForPush('s@x', 'all', 'u21');
await tick();
hold.resolve();
const [q2, t2] = await Promise.all([quiet2, tap2]);
ok('R2a the tap is written last ("all"); the quiet write it interrupted stood down before writing', server.posts.at(-1).mode === 'all' && server.posts.at(-1).userEmail === 's@x' && !server.posts.slice(-3).some((p) => p.userEmail === 's@x' && p.mode === 'tagged') && t2 === 'subscribed', JSON.stringify(server.posts.slice(-2)));
ok('R2b the setting this phone remembers is the tap\'s', push.rememberedPushMode('u21') === 'all');
// R3: a tap before the quiet sync reaches its write -> no quiet write at all.
browserSub = null; const nR3 = server.posts.length; store.delete('shutfey_push_mode:u22');
hold = deferred(); server.hold = { '/api/push/public-key': hold };
const tap3 = push.subscribeForPush('t@x', 'all', 'u22');
await tick();
const quiet3 = push.syncPushQuietly('t@x', 'u22');
hold.resolve();
await Promise.all([tap3, quiet3]);
ok('R3 a quiet sync started after a tap writes nothing of its own', server.posts.length === nR3 + 1 && server.posts.at(-1).mode === 'all', JSON.stringify(server.posts.slice(nR3)));

// F (review PARV3 F1): a failed Turn on with a browser subscription the server does not hold is never shown as on.
browserSub = mkSub('https://push.example/dev1'); server.registered = false; server.failSubscribe = true; perm.value = 'granted';
let to = await push.turnOnPush('f@x', 'u30');
ok('F1 failed Turn on -> result failed, shown as not set up (Turn on offered again)', to.result === 'failed' && to.setup.state === 'granted' && to.setup.mode === null, JSON.stringify(to));
server.failSubscribe = false;
to = await push.turnOnPush('f@x', 'u30');
ok('F2 retry works -> subscribed, all', to.result === 'subscribed' && to.setup.state === 'subscribed' && server.posts.at(-1).mode === 'all');
// F3: the menu button itself (mini-render): not set up -> tap -> server refuses -> still "Off" with a retry hint, never "On".
{
  const { mount } = await import('./lib/mini-render.mjs');
  const { PushNotificationToggle } = await import('../../src/components/PushNotificationToggle.tsx');
  browserSub = mkSub('https://push.example/dev1'); server.registered = false; server.failSubscribe = true;
  const vm = mount(PushNotificationToggle, { userEmail: 'g@x', userId: 'u31' });
  await vm.render(); await new Promise((r) => setTimeout(r, 50)); await vm.render();
  const btn = () => vm.find((e) => e.type === 'button' && e.props['data-push-toggle'])[0];
  ok('F3a the button reads not set up (server has no record)', btn()?.props['data-push-toggle'] === 'off', btn()?.props['data-push-toggle']);
  await btn().props.onClick(); await new Promise((r) => setTimeout(r, 50)); await vm.render();
  ok('F3b after a refused Turn on it still reads not set up, never On', btn()?.props['data-push-toggle'] === 'off', btn()?.props['data-push-toggle']);
  ok('F3c with a retry hint', /try again/.test(JSON.stringify(vm.tree?.() ?? vm.out ?? '')) || vm.html().includes('try again'));
  server.failSubscribe = false;
  await btn().props.onClick(); await new Promise((r) => setTimeout(r, 50)); await vm.render();
  ok('F3d the retry turns it On', btn()?.props['data-push-toggle'] === 'on', btn()?.props['data-push-toggle']);
}
// A (review PARV3 F2): a quiet sync that started for A writes nothing once the session is B's.
{
  const api = await import('../../src/lib/api.ts');
  api.setSessionToken('token-A');
  browserSub = mkSub('https://push.example/dev1'); server.registered = false; store.set('shutfey_push_mode:uA', 'all');
  const nA = server.posts.length;
  const holdA = deferred(); server.hold = { '/api/push/status': holdA };
  const qa = push.syncPushQuietly('a@x', 'uA');
  await tick();
  api.setSessionToken('token-B'); // A signed out, B signed in on this phone
  holdA.resolve(); await qa;
  ok('A1 A\'s paused quiet sync makes no write under B\'s session', server.posts.length === nA, JSON.stringify(server.posts.slice(nA)));
  let live = true;
  const holdB = deferred(); server.hold = { '/api/push/status': holdB };
  const qb = push.syncPushQuietly('b@x', 'uB', () => live);
  await tick(); live = false; holdB.resolve(); await qb;
  ok('A2 a quiet sync whose screen is gone (isCurrent false) writes nothing', server.posts.length === nA);
  server.modeAt = 0; // B's record is a different record (the mock keeps one)
  const qb2 = await push.syncPushQuietly('b@x', 'uB');
  ok('A3 B\'s own sync then sets B\'s own setting ("tagged", not A\'s "all")', qb2.mode === 'tagged' && server.posts.at(-1).mode === 'tagged');
  // A4 (review PARV4): the no-subscription path — A's quiet subscribe is paused on the key fetch, B signs in.
  api.setSessionToken('token-A2');
  browserSub = null; server.registered = false; store.set('shutfey_push_mode:uA2', 'all'); store.delete('shutfey_push_mode:uB2');
  const nA4 = server.posts.length;
  const holdK = deferred(); server.hold = { '/api/push/public-key': holdK };
  const qa4 = push.syncPushQuietly('a2@x', 'uA2');
  await tick();
  api.setSessionToken('token-B2');
  holdK.resolve(); await qa4;
  ok('A4 A\'s paused quiet subscribe writes nothing under B\'s session', server.posts.length === nA4, JSON.stringify(server.posts.slice(nA4)));
  ok('A4b nothing recorded for B from A\'s run', push.rememberedPushMode('uB2') === null);
  // A5: same, paused inside the write slot after the browser subscription is created (status branch not involved).
  browserSub = null; const nA5 = server.posts.length;
  api.setSessionToken('token-A3');
  let liveA5 = true;
  const holdK2 = deferred(); server.hold = { '/api/push/public-key': holdK2 };
  const qa5 = push.syncPushQuietly('a3@x', 'uA3', () => liveA5);
  await tick(); liveA5 = false; holdK2.resolve(); await qa5;
  ok('A5 a quiet subscribe whose screen is gone writes nothing', server.posts.length === nA5);
  // E (review PARV5): an explicit tap is bound to the session that tapped.
  // E1: A taps Turn on; the permission prompt is still open; A signs out and B signs in; A's prompt is answered.
  api.setSessionToken('token-E-A');
  browserSub = null; perm.value = 'default'; perm.answer = 'granted'; store.delete('shutfey_push_mode:uEB');
  const nE1 = server.posts.length;
  const holdP = deferred(); perm.hold = holdP;
  const e1 = push.subscribeForPush('ea@x', 'all', 'uEA');
  await tick();
  api.setSessionToken('token-E-B');
  holdP.resolve();
  ok('E1 A\'s Turn on answered after B signed in writes nothing', (await e1) === 'superseded' && server.posts.length === nE1, JSON.stringify(server.posts.slice(nE1)));
  ok('E1b and records nothing for A', push.rememberedPushMode('uEA') === null);
  // E2: A's On/Off is queued behind a running write; B signs in before it runs.
  perm.value = 'granted';
  api.setSessionToken('token-E-A2');
  browserSub = mkSub('https://push.example/dev1');
  const holdW = deferred(); server.hold = { '/api/push/public-key': holdW };
  const running = push.subscribeForPush('ea2@x', 'tagged', 'uEA2'); // a write in progress (held on the key fetch)
  await tick();
  const nE2 = server.posts.length;
  const queued = push.setPushMode('all', 'uEA2');
  await tick();
  api.setSessionToken('token-E-B2');
  holdW.resolve();
  const [rRun, rQ] = await Promise.all([running, queued]);
  ok('E2 the running write stops too (session changed mid-write)', rRun === 'superseded', rRun);
  ok('E2b A\'s queued On/Off does not run under B\'s session', rQ === 'superseded' && server.posts.length === nE2, JSON.stringify(server.posts.slice(nE2)));
  // E4: the banner/menu Turn on across a switch shows nothing for the person who left and files nothing under them.
  api.setSessionToken('token-E-A4'); browserSub = null; perm.value = 'default'; store.delete('shutfey_push_mode:uEA4');
  const holdP4 = deferred(); perm.hold = holdP4;
  const e4 = push.turnOnPush('ea4@x', 'uEA4');
  await tick(); api.setSessionToken('token-E-B4'); holdP4.resolve();
  const r4 = await e4;
  ok('E4 turnOnPush across a switch: superseded, nothing shown, nothing remembered', r4.result === 'superseded' && r4.setup.state === 'default' && r4.setup.stale === true && push.rememberedPushMode('uEA4') === null, JSON.stringify(r4));
  perm.value = 'granted';
  // E3: the same session -> the tap still works.
  api.setSessionToken('token-E-C'); browserSub = mkSub('https://push.example/dev1');
  ok('E3 in the same session the tap writes', (await push.setPushMode('all', 'uEC')) === 'done' && server.posts.at(-1).mode === 'all');
  // Y (review PARV7): a stood-down quiet sync never reads under the next person's session and files it under the first.
  const setupB = () => { server.registered = true; server.mode = 'tagged'; }; // B registered the shared endpoint as "tagged"
  // Y1 (no-subscription branch, canceled in its write slot)
  api.setSessionToken('token-Y1-A'); browserSub = null; server.registered = false; store.set('shutfey_push_mode:uYA', 'all');
  let hY = deferred(); server.hold = { '/api/push/public-key': hY };
  let qY = push.syncPushQuietly('ya@x', 'uYA');
  await tick(); api.setSessionToken('token-Y1-B'); browserSub = mkSub('https://push.example/dev1'); setupB(); hY.resolve();
  let rY = await qY;
  ok('Y1 canceled quiet subscribe: stale, and A\'s remembered setting is still "all"', rY.stale === true && push.rememberedPushMode('uYA') === 'all', `${JSON.stringify(rY)} ${push.rememberedPushMode('uYA')}`);
  // Y2 (after the status read)
  api.setSessionToken('token-Y2-A'); server.registered = false; store.set('shutfey_push_mode:uYA', 'all');
  hY = deferred(); server.hold = { '/api/push/status': hY };
  qY = push.syncPushQuietly('ya@x', 'uYA');
  await tick(); api.setSessionToken('token-Y2-B'); setupB(); hY.resolve();
  rY = await qY;
  ok('Y2 stood down after its status read: stale, A\'s setting untouched', rY.stale === true && push.rememberedPushMode('uYA') === 'all', `${JSON.stringify(rY)} ${push.rememberedPushMode('uYA')}`);
  // Y3 (inside the re-register write slot, queued behind another write)
  api.setSessionToken('token-Y3-A'); browserSub = null; server.registered = false; store.set('shutfey_push_mode:uYA', 'all');
  hY = deferred(); server.hold = { '/api/push/public-key': hY };
  const qFirst = push.syncPushQuietly('ya@x', 'uYA'); // holds the write slot
  await tick();
  browserSub = mkSub('https://push.example/dev1');
  const nY3 = server.posts.length;
  const qSecond = push.syncPushQuietly('ya@x', 'uYA'); // status says not registered -> waits for the slot
  await tick(); await tick();
  api.setSessionToken('token-Y3-B'); setupB(); hY.resolve();
  const [rF, rS] = await Promise.all([qFirst, qSecond]);
  ok('Y3 both stood down in their slots: no write, both stale, A\'s setting untouched', server.posts.length === nY3 && rF.stale === true && rS.stale === true && push.rememberedPushMode('uYA') === 'all', `${server.posts.length - nY3} ${JSON.stringify([rF, rS])} ${push.rememberedPushMode('uYA')}`);

  // Z (review PARV8)
  // Z1: a failed registration leaves the browser subscription in place (it may be the one the next person / another tab registered).
  api.setSessionToken('token-Z'); perm.value = 'granted'; browserSub = null; server.failSubscribe = true;
  const z1 = await push.subscribeForPush('z@x', 'all', 'uZ');
  ok('Z1 failed registration: result failed, browser subscription kept', z1 === 'failed' && browserSub !== null, `${z1} ${!!browserSub}`);
  server.failSubscribe = false;
  // Z2: explicit writes carry increasing tap times; quiet writes carry none.
  server.modeAt = 0; server.registered = true;
  await push.setPushMode('tagged', 'uZ'); const c1 = server.posts.at(-1).choiceAt;
  await push.setPushMode('all', 'uZ'); const c2 = server.posts.at(-1).choiceAt;
  ok('Z2 explicit writes carry increasing tap times', typeof c1 === 'number' && c2 > c1, `${c1} ${c2}`);
  // Z3: another tab's NEWER tap is what the server holds -> this tab's older write is superseded and keeps nothing.
  server.modeAt = Date.now() + 60_000; server.mode = 'tagged'; store.set('shutfey_push_mode:uZ', 'tagged');
  const z3 = await push.setPushMode('all', 'uZ');
  ok('Z3 server says superseded -> superseded, remembered setting unchanged', z3 === 'superseded' && push.rememberedPushMode('uZ') === 'tagged' && server.mode === 'tagged', `${z3} ${push.rememberedPushMode('uZ')}`);
  // Z4: a quiet re-register that meets another tab's choice takes the server's setting.
  server.registered = false; server.mode = 'tagged'; store.delete('shutfey_push_mode:uZ4');
  const z4 = await push.syncPushQuietly('z4@x', 'uZ4');
  ok('Z4 quiet re-register: no tap time sent; the server\'s chosen setting wins', server.posts.at(-1).choiceAt === undefined && z4.mode === 'tagged' && push.rememberedPushMode('uZ4') === 'tagged', JSON.stringify(z4));
  server.modeAt = 0;

  // X (review PARV6): the newest explicit choice wins, and an old read never undoes it.
  // X1: an older Turn on waits on its permission prompt; a newer Off is written; then the prompt is answered.
  api.setSessionToken('token-X');
  browserSub = mkSub('https://push.example/dev1'); server.registered = true; server.mode = 'all'; perm.value = 'default'; perm.answer = 'granted';
  const holdX = deferred(); perm.hold = holdX;
  const older = push.subscribeForPush('x@x', 'all', 'uX');
  await tick();
  const newer = await push.setPushMode('tagged', 'uX');
  holdX.resolve();
  const olderR = await older;
  ok('X1 the newer Off is written; the older Turn on is superseded and writes nothing', newer === 'done' && olderR === 'superseded' && server.mode === 'tagged' && server.posts.at(-1).mode === 'tagged', `${newer} ${olderR} ${server.mode}`);
  ok('X1b the remembered setting is the newer one', push.rememberedPushMode('uX') === 'tagged');
  // X2: a status read started before a tap reports stale and keeps nothing.
  perm.value = 'granted'; server.registered = true; server.mode = 'tagged';
  const holdS = deferred(); server.hold = { '/api/push/status': holdS };
  const oldRead = push.getPushSetup('uX');
  await tick();
  ok('X2a the tap writes On', (await push.setPushMode('all', 'uX')) === 'done' && push.rememberedPushMode('uX') === 'all');
  holdS.resolve();
  const or = await oldRead;
  ok('X2b the older read ("tagged") comes back stale and is not kept', or.stale === true && push.rememberedPushMode('uX') === 'all', JSON.stringify(or));
  // X3: the menu button: its first read is slow (server says "tagged"); the person taps Turn on meanwhile -> stays On.
  {
    const { mount } = await import('./lib/mini-render.mjs');
    const { PushNotificationToggle } = await import('../../src/components/PushNotificationToggle.tsx');
    browserSub = mkSub('https://push.example/dev1'); server.registered = false; server.mode = 'tagged'; store.delete('shutfey_push_mode:uX3');
    const holdR = deferred(); server.hold = { '/api/push/status': holdR };
    const vm = mount(PushNotificationToggle, { userEmail: 'x3@x', userId: 'uX3' });
    await vm.render(); await tick();
    const btn = () => vm.find((e) => e.type === 'button' && e.props['data-push-toggle'])[0];
    await btn().props.onClick(); await tick(); await vm.render();
    ok('X3a the tap turns it On', btn()?.props['data-push-toggle'] === 'on', btn()?.props['data-push-toggle']);
    holdR.resolve(); await tick(); await tick(); await vm.render();
    ok('X3b the slow first read (not registered, from before the tap) does not repaint it', btn()?.props['data-push-toggle'] === 'on', btn()?.props['data-push-toggle']);
    ok('X3c remembered setting stays the tap\'s', push.rememberedPushMode('uX3') === 'all');
  }
  api.setSessionToken(null);
}

// W (review PARV1 P3): no service worker ever becomes ready -> bounded, nothing hangs.
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { ready: new Promise(() => {}) }, userAgent: 'x' }, configurable: true, writable: true });
perm.value = 'granted';
let t0 = Date.now();
const gs = await push.getPushState();
ok('W1 getPushState settles without a service worker', gs === 'granted' && Date.now() - t0 < 9000, `${gs} ${Date.now() - t0}ms`);
t0 = Date.now();
const sf = await push.subscribeForPush('e@x', 'all', 'u10');
ok('W2 Turn on settles as failed without a service worker', sf === 'failed' && Date.now() - t0 < 9000, `${sf} ${Date.now() - t0}ms`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
