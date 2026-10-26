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
  request = { url, opts, writesAtFetch: writes.length };
  return new Promise((resolve, reject) => { releaseError = () => reject(new TypeError('offline')); release = () => resolve({ status: 200, text: async () => '{}' }); });
};
async function pendingLogout() {
  writes.length = 0;
  const pending = api.endUnusedKioskSignIn(null);
  const sentId = request.opts.headers['X-Shutfey-Logout-Id'];
  assert.match(sentId, /^[0-9a-f]{16}$/, 'header id shape');
  assert.equal(request.url, '/api/auth/logout');
  assert.equal(request.writesAtFetch, 0, 'no cookie write before request');
  assert.equal(writes.length, 0, 'only the server creates an ack');
  assert.match(store.get(prefix + sentId), /^\d+$/, 'plain timestamp, no marker flag');
  return { pending, sentId, key: prefix + sentId };
}
let p = await pendingLogout();
jar.set(`shutfey_lo_${p.sentId}`, '1');
jar.set(`shutfey_logout_ack_${p.sentId}`, '1'); // browser applies the server's answer
release(); await p.pending;
assert.equal(store.has(p.key), false, 'answer removes key');
assert.equal(jar.size, 0, 'answer expires ack');
assert.ok(writes.at(-1).includes('Max-Age=0'), 'cleanup expires ack');
assert.ok(writes.at(-1).endsWith('; Secure'), 'HTTPS cleanup is secure');
p = await pendingLogout();
jar.set(`shutfey_lo_${p.sentId}`, '1');
jar.set(`shutfey_logout_ack_${p.sentId}`, '1');
releaseError(); await p.pending;
assert.equal(store.has(p.key), false, 'network error removes key');
assert.equal(jar.size, 0, 'network error expires ack');
globalThis.location.protocol = 'http:';
p = await pendingLogout();
release(); await p.pending;
assert.ok(!writes.at(-1).includes('; Secure'), 'HTTP cleanup has no Secure');
globalThis.location.protocol = 'https:';
const orphan = (value, keyId = id) => { store.clear(); store.set(prefix + keyId, value); };
for (const suffix of ['', ':m']) {
  jar.set(`shutfey_lo_${id}`, '1');
  jar.set(`shutfey_logout_ack_${id}`, '1');
  orphan(`${Date.now()}${suffix}`);
  assert.equal(await api.signOutsSettled(0), true, 'exact ack settles plain and old :m keys');
  assert.equal(store.size, 0, 'ack removes orphan key');
  assert.equal(jar.size, 0, 'consumed ack expired');
  orphan(`${Date.now()}${suffix}`);
  assert.equal(await api.signOutsSettled(0), false, 'eviction: absent ack keeps plain and old :m keys in flight');
  assert.equal(store.size, 1, 'eviction keeps key');
  orphan(`${Date.now() - api.sessionTiming.logoutUnknownMaxMs - 1}${suffix}`);
  assert.equal(await api.signOutsSettled(0), true, 'eviction settles only after unknown window');
  assert.equal(store.size, 0, 'expired key removed');
}
for (const suffix of ['', ':m']) {
  jar.set(`shutfey_lo_${id}`, '1');
  orphan(`${Date.now()}${suffix}`);
  assert.equal(await api.signOutsSettled(0), false, 'draft marker is not proof');
  assert.equal(store.size, 1, 'draft marker keeps key in flight');
  orphan(`${Date.now() - api.sessionTiming.logoutUnknownMaxMs - 1}${suffix}`);
  assert.equal(await api.signOutsSettled(0), true, 'draft marker waits until the window ends');
  assert.equal(store.size, 0, 'expired draft key removed');
  assert.equal(jar.size, 0, 'expired draft marker cleaned up');
}
for (const value of ['0', '11', '', '1x']) {
  jar.set(`shutfey_logout_ack_${id}`, value);
  orphan(String(Date.now()));
  assert.equal(await api.signOutsSettled(0), false, 'ack value must be exactly 1');
}
jar.clear(); jar.set(`other_shutfey_logout_ack_${id}`, '1');
orphan(String(Date.now()));
assert.equal(await api.signOutsSettled(0), false, 'ack cookie name must match exactly');
jar.clear();
for (const bad of ['bad', '0123456789abcde', '0123456789ABCDEf', '0123456789abcdef0']) {
  jar.set(`shutfey_logout_ack_${bad}`, '1');
  orphan(`${Date.now()}:m`, bad);
  assert.equal(await api.signOutsSettled(0), false, 'bad id with ack fails closed');
}
jar.clear(); jar.set(`shutfey_logout_ack_${id}`, '1');
orphan(String(Date.now())); unreadable = true;
assert.equal(await api.signOutsSettled(0), false, 'unreadable cookies fail closed');
unreadable = false;
orphan(String(Date.now() - api.sessionTiming.logoutUnknownMaxMs - 1));
assert.equal(await api.signOutsSettled(0), true, 'orphan with ack still expires');
assert.equal(jar.size, 0, 'expired orphan ack removed');
for (const mode of ['ignored', 'no document']) {
  blocked = mode === 'ignored';
  if (mode === 'no document') delete globalThis.document;
  p = await pendingLogout();
  release(); await p.pending;
  orphan(String(Date.now()));
  assert.equal(await api.signOutsSettled(0), false, `${mode}: no proof keeps key in flight`);
  globalThis.document = documentFake;
}
blocked = false;
for (const bad of ['NaN', '1:m:x', '', '1:other']) {
  orphan(bad);
  assert.equal(await api.signOutsSettled(0), true, 'malformed value dropped');
  assert.equal(store.size, 0);
}
assert.equal(api.sessionTiming.logoutUnknownMaxMs, 600000, 'unknown window unchanged');
console.log('PASS logout ack client');
