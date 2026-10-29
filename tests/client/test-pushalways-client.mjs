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
globalThis.Notification = { get permission() { return perm.value; }, requestPermission: async () => { perm.asked++; perm.value = perm.answer; return perm.value; } };
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
  if (u.endsWith('/api/push/subscribe')) { if (server.failSubscribe) return res(500, { error: 'x' }); server.posts.push(body); server.registered = true; if (body.mode) server.mode = body.mode; return res(200, { success: true, mode: server.mode }); }
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
ok('S1 Off keeps the phone subscribed (mode tagged, no unsubscribe)', (await push.setPushMode('tagged', 'u9')) && browserSub !== null && server.posts.at(-1).mode === 'tagged');
ok('S2 On again', (await push.setPushMode('all', 'u9')) && server.posts.at(-1).mode === 'all' && push.rememberedPushMode('u9') === 'all');
browserSub = null;
ok('S3 no subscription: setPushMode reports false', (await push.setPushMode('all', 'u9')) === false);
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
ok('R1a the tap writes while the quiet sync still waits', (await tap1) === true && server.posts.at(-1).mode === 'all');
hold.resolve(); const q1 = await quiet1;
ok('R1b the quiet sync stands down: no "tagged" write after the tap', server.posts.at(-1).mode === 'all' && server.mode === 'all', JSON.stringify(server.posts.slice(-2)));
ok('R1c and reports the tap\'s result', q1.state === 'subscribed' && q1.mode === 'all', JSON.stringify(q1));
// R2: no browser subscription; the quiet subscribe is already writing (key fetch held) when the person taps Turn on.
browserSub = null; server.registered = false; store.delete('shutfey_push_mode:u21');
hold = deferred(); server.hold = { '/api/push/public-key': hold };
const quiet2 = push.syncPushQuietly('s@x', 'u21');
await tick();
const tap2 = push.subscribeForPush('s@x', 'all', 'u21');
await tick();
hold.resolve();
const [q2, t2] = await Promise.all([quiet2, tap2]);
ok('R2a the tap is written last ("all"), after the quiet write it waited for', server.posts.at(-1).mode === 'all' && server.posts.at(-2)?.mode === 'tagged' && t2 === 'subscribed', JSON.stringify(server.posts.slice(-2)));
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
