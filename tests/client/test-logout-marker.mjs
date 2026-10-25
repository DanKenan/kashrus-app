import assert from 'node:assert/strict';
const store = new Map(), jar = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.location = { protocol: 'https:' };
let blocked = false, unreadable = false;
const writes = [];
const documentFake = {
  get cookie() { if (unreadable) throw Error('unreadable'); return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  set cookie(v) {
    writes.push(v);
    if (blocked) return;
    const [nv] = v.split(';'), [k, value] = nv.split('=');
    if (v.includes('Max-Age=0')) jar.delete(k); else jar.set(k, value);
  },
};
globalThis.document = documentFake;
const api = await import('../../src/lib/api.ts');
const prefix = 'shutfey_logout_in_flight:', id = '0123456789abcdef';
let release, releaseError, request;
globalThis.fetch = (url, opts) => {
  request = { url, opts, markerAtFetch: documentFake.cookie };
  return new Promise((resolve, reject) => { releaseError = () => reject(new TypeError('offline')); release = () => resolve({ status: 200, text: async () => '{}' }); });
};
async function pendingLogout() {
  const pending = api.endUnusedKioskSignIn(null);
  const sentId = request.opts.headers['X-Shutfey-Logout-Id'];
  assert.match(sentId, /^[0-9a-f]{16}$/, 'header id shape');
  assert.equal(request.url, '/api/auth/logout');
  return { pending, sentId, key: prefix + sentId };
}
let p = await pendingLogout();
assert.equal(request.markerAtFetch, `shutfey_lo_${p.sentId}=1`, 'marker exists before fetch');
assert.match(store.get(p.key), /^\d+:m$/, 'timestamp has marker flag');
assert.ok(writes.at(-1).endsWith('; Secure'), 'HTTPS marker is secure');
assert.ok(Number(/Max-Age=(\d+)/.exec(writes.at(-1))?.[1]) > api.sessionTiming.logoutUnknownMaxMs / 1000, 'marker outlives the unknown-request window');
release(); await p.pending;
assert.equal(store.has(p.key), false, 'answer removes key');
assert.equal(jar.has(`shutfey_lo_${p.sentId}`), false, 'answer removes marker');
assert.ok(writes.at(-1).includes('Max-Age=0'), 'cleanup expires marker');
p = await pendingLogout();
releaseError(); await p.pending;
assert.equal(store.has(p.key), false, 'network error removes key');
assert.equal(jar.size, 0, 'network error removes marker');
globalThis.location.protocol = 'http:';
p = await pendingLogout();
assert.ok(!writes.at(-1).includes('; Secure'), 'HTTP marker has no Secure');
release(); await p.pending;
globalThis.location.protocol = 'https:';
const orphan = (value, keyId = id) => { store.clear(); store.set(prefix + keyId, value); };
jar.set(`shutfey_lo_${id}`, '1');
orphan(`${Date.now()}:m`);
assert.equal(await api.signOutsSettled(0), false, 'present marker blocks');
assert.equal(store.size, 1, 'present marker keeps key');
jar.clear();
assert.equal(await api.signOutsSettled(0), true, 'absent marker settles immediately');
assert.equal(store.size, 0, 'absent marker removes orphan');
orphan(String(Date.now()));
assert.equal(await api.signOutsSettled(0), false, 'old page without marker flag blocks');
orphan(String(Date.now() - api.sessionTiming.logoutUnknownMaxMs - 1));
assert.equal(await api.signOutsSettled(0), true, 'old page expires after unknown window');
assert.equal(store.size, 0, 'expired key removed');
for (const mode of ['ignored', 'no document']) {
  blocked = mode === 'ignored';
  if (mode === 'no document') delete globalThis.document;
  p = await pendingLogout();
  assert.match(store.get(p.key), /^\d+$/, `${mode}: no marker flag, header still sent`);
  release(); await p.pending;
  globalThis.document = documentFake;
}
blocked = false;
for (const bad of ['bad', '0123456789abcde', '0123456789ABCDEf', '0123456789abcdef0']) {
  orphan(`${Date.now()}:m`, bad);
  assert.equal(await api.signOutsSettled(0), false, 'bad id fails closed');
}
orphan(`${Date.now()}:m`); unreadable = true;
assert.equal(await api.signOutsSettled(0), false, 'unreadable cookies fail closed');
unreadable = false;
jar.set(`shutfey_lo_${id}`, '1');
orphan(`${Date.now() - api.sessionTiming.logoutUnknownMaxMs - 1}:m`);
assert.equal(await api.signOutsSettled(0), true, 'marked orphan still expires');
assert.equal(jar.size, 0, 'expired orphan marker removed');
for (const bad of ['NaN', '1:m:x', '', '1:other']) {
  orphan(bad);
  assert.equal(await api.signOutsSettled(0), true, 'malformed value dropped');
  assert.equal(store.size, 0);
}
assert.equal(api.sessionTiming.logoutUnknownMaxMs, 600000, 'unknown window unchanged');
console.log('PASS logout marker client');
