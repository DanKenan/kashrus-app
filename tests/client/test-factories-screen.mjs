import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { sourceStatus } from '../../src/lib/sources.ts';
const originalFetch = globalThis.fetch;
const OriginalDate = globalThis.Date;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-11T01:00:00Z'])); }
};
// Keep mini-render's zero-delay settling ticks real; control only polling timers.
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay !== 3000) return originalSetTimeout(fn, delay, ...args);
  const id = ++timerId; timers.set(id, fn); return id;
};
globalThis.clearTimeout = id => { if (!timers.delete(id)) originalClearTimeout(id); };
async function poll() {
  const [id, fn] = timers.entries().next().value;
  timers.delete(id); await fn();
}
const connected = { sourceType: 'airtable', status: 'ok', refreshedAt: '2026-11-10T09:00:00Z', calls: 6 };
try {
  assert.equal(sourceStatus({ sourceType: null }, 'America/Chicago'), 'Not connected');
  assert.equal(sourceStatus(connected, 'America/Chicago'), 'Connected to Airtable · updated 3:00 AM · 6 calls');
  assert.equal(sourceStatus({ ...connected, status: 'never', refreshedAt: null }, 'UTC'), 'Connected to Airtable · reading your database…');
  assert.equal(sourceStatus(connected, 'UTC'), 'Connected to Airtable · updated Nov 10, 2026, 9:00 AM · 6 calls');
  assert.match(sourceStatus({ ...connected, refreshedAt: '2026-11-10T05:00:00Z' }, 'America/Chicago'), /updated Nov 9, 2026, 11:00 PM/);
  assert.match(sourceStatus({ ...connected, status: 'stale' }, 'UTC'), /Out of date/);
  assert.equal(sourceStatus({ ...connected, status: 'error', error: 'Offline' }, 'UTC'), "Couldn't reach Airtable: Offline");
  assert.match(sourceStatus({ ...connected, status: 'backup', error: 'Offline', backupTakenAt: '2026-11-10T09:00:00Z' }, 'America/Chicago'), /Couldn't reach Airtable: Offline · showing the copy saved Nov 10, 2026, 3:00 AM/);
  for (const missing of [404, 200]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ sourceType: null }), { status: missing });
    const screen = mount(FactoriesScreen, { isOpen: true, onClose() {}, timeZone: 'UTC' }); await screen.render();
    assert.match(screen.text(), /Not connected/);
    assert.match(screen.text(), /Connect your database to see your factories here\./);
    assert.equal(screen.find(e => e.type === 'button' && e.props.className.includes('bg-gold-deep')).length, 1);
    assert.equal(screen.find(e => e.props['aria-label'] === 'Close').length, 1);
  }
  for (const state of [connected, { ...connected, status: 'never', refreshedAt: null }, { ...connected, status: 'stale' }, { ...connected, status: 'error', error: 'Offline' }, { ...connected, status: 'backup', error: 'Offline', backupTakenAt: '2026-11-10T09:00:00Z' }]) {
    globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/connection') ? state : { status: state, companies: [] }));
    const screen = mount(FactoriesScreen, { isOpen: true, onClose() {}, timeZone: 'America/Chicago' }); await screen.render();
    assert.ok(screen.text().includes(sourceStatus(state, 'America/Chicago')));
    await screen.render({ isOpen: false });
    for (const fn of timers.values()) await fn();
    timers.clear();
  }
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    if (url === '/api/sources/refresh') return new Response(JSON.stringify({ error: 'Please wait before refreshing again.' }), { status: 429 });
    return new Response(JSON.stringify(url === '/api/sources/connection' ? connected : { status: connected, companies: [
      { id: 'z', name: 'Zebra', ingredientCount: 0, productCount: 0 },
      { id: 'a', name: 'Alpha מפעל with a long name', brand: 'Brand', plant: 'Plant', ingredientCount: 42, productCount: 18 },
    ] }));
  };
  const screen = mount(FactoriesScreen, { isOpen: true, onClose() {}, timeZone: 'America/Chicago' }); await screen.render();
  assert.match(screen.text(), /Connected to Airtable · updated 3:00 AM · 6 calls/);
  await screen.render({ timeZone: 'UTC' });
  assert.match(screen.text(), /Connected to Airtable · updated Nov 10, 2026, 9:00 AM · 6 calls/);
  await screen.render({ timeZone: 'America/Chicago' });
  assert.ok(screen.text().indexOf('Alpha') < screen.text().indexOf('Zebra'));
  assert.match(screen.text(), /Brand \/ Plant 42 ingredients · 18 products/);
  assert.match(screen.text(), /Last visit — Next due — Overdue —/);
  assert.equal(screen.find(e => e.type === 'dd' && e.props['aria-label'] === 'Not scheduled yet').length, 6);
  await screen.click('Refresh now');
  assert.equal(calls.filter(([url, method]) => url === '/api/sources/refresh' && method === 'POST').length, 1);
  assert.match(screen.text(), /Please wait before refreshing again\./);
  assert.equal(screen.find(e => e.props.role === 'alert').length, 1);
  await screen.render({ isOpen: false }); assert.equal(screen.text(), '');
  for (const stop of ['ready', 'closed', 'limit']) {
    timers.clear();
    const requests = [];
    let status = 'never';
    globalThis.fetch = async (url, options = {}) => {
      requests.push([url, options.method || 'GET']);
      return new Response(JSON.stringify(url.endsWith('/connection') ? { ...connected, status } : {
        status: { ...connected, status }, companies: status === 'ok' ? [{ id: 'ready', name: 'Ready factory', ingredientCount: 1, productCount: 2 }] : [],
      }));
    };
    const waiting = mount(FactoriesScreen, { isOpen: true, onClose() {}, timeZone: 'America/Chicago' }); await waiting.render();
    assert.match(waiting.text(), /Connected to Airtable · reading your database…/);
    assert.doesNotMatch(waiting.text(), /0 calls/);
    assert.equal(requests.length, 2);
    assert.equal(timers.size, 1);
    if (stop === 'closed') {
      await waiting.render({ isOpen: false });
      await poll(); // mini-render omits effect cleanup: also verify the generation guard.
      assert.equal(requests.length, 2);
    } else if (stop === 'ready') {
      await poll(); await waiting.render();
      assert.equal(timers.size, 1);
      status = 'ok';
      await poll(); await waiting.render();
      assert.match(waiting.text(), /updated 3:00 AM · 6 calls/);
      assert.match(waiting.text(), /Ready factory/);
      assert.equal(requests.length, 4);
    } else {
      for (let i = 0; i < 10; i++) { await poll(); await waiting.render(); }
      assert.equal(requests.filter(([url]) => url === '/api/factories').length, 11);
    }
    assert.equal(timers.size, 0);
    assert.ok(requests.every(([, method]) => method === 'GET'));
  }
  console.log('factories screen: OK');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.Date = OriginalDate;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
