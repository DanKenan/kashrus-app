/**
 * QA1 (Oct 22): saving a venue's time zone in the Venues list must not zero the card's live
 * counts. PUT /api/venues/:id answers the stored venue without the live fields GET /api/venues adds
 * (totalTasksToday, completedTasksToday, completionRate, workerCount); the row keeps the card's.
 * Run: npx tsx tests/client/test-venue-tz-live-counts.mjs
 */
import { mount, recordFetch } from './lib/mini-render.mjs';
import { VenueTimeZoneRow } from '../../src/components/VenuesDirectoryModal.tsx';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const LIVE = { totalTasksToday: 2, completedTasksToday: 1, completionRate: 50, workerCount: 2 };
const venue = { id: 'v1', name: 'Crown Market', agencyId: 'a', category: 'Restaurant', ...LIVE };
const stored = (b) => ({ id: 'v1', name: 'Crown Market', agencyId: 'a', category: 'Restaurant', ...(b.timeZone ? { timeZone: b.timeZone } : {}) });

async function row(routes) {
  const updated = [];
  const calls = recordFetch(routes);
  const m = mount(VenueTimeZoneRow, { venue, agencyTimeZone: 'America/New_York', isAdmin: true, onVenueUpdated: (v) => updated.push(v) });
  await m.render();
  const select = () => m.find((e) => e.type === 'select')[0];
  const choose = async (tz) => { await select().props.onChange({ target: { value: tz }, stopPropagation() {} }); await m.render(); };
  return { m, calls, updated, select, choose };
}
{
  const r = await row({ 'PUT /api/venues/': (p, b) => ({ venue: stored(b), effectiveTimeZone: b.timeZone || 'America/New_York', nextResetDate: '2026-10-23' }) });
  ok('admin sees the select', !!r.select());
  await r.choose('America/Chicago');
  const put = r.calls.filter(([m]) => m === 'PUT');
  ok('one PUT /api/venues/v1 with { timeZone } only', put.length === 1 && put[0][1] === '/api/venues/v1' && JSON.stringify(Object.keys(put[0][2]).filter((k) => k !== 'expectedVersion')) === '["timeZone"]' && put[0][2].timeZone === 'America/Chicago', JSON.stringify(put));
  const v = r.updated[0] || {};
  ok('onVenueUpdated gets the server venue (new zone)', r.updated.length === 1 && v.timeZone === 'America/Chicago', JSON.stringify(r.updated));
  ok('live counts kept: shift completion 1/2, 50 %, 2 staff', v.totalTasksToday === 2 && v.completedTasksToday === 1 && v.completionRate === 50 && v.workerCount === 2, JSON.stringify(v));
  ok('saved note shows', /Saved\./.test(r.m.text()), r.m.text());
}
{
  // Back to the agency default ("" clears the venue's own zone): counts still kept.
  const r = await row({ 'PUT /api/venues/': (p, b) => ({ venue: stored(b), effectiveTimeZone: 'America/New_York' }) });
  await r.choose('');
  const v = r.updated[0] || {};
  ok('agency default: no own zone, counts kept', r.updated.length === 1 && v.timeZone === undefined && v.workerCount === 2 && v.totalTasksToday === 2, JSON.stringify(v));
}
{
  // If a server answer ever carries live counts, the server's win.
  const r = await row({ 'PUT /api/venues/': (p, b) => ({ venue: { ...stored(b), totalTasksToday: 3, completedTasksToday: 3, completionRate: 100, workerCount: 4 } }) });
  await r.choose('America/Denver');
  const v = r.updated[0] || {};
  ok('server counts win when present', v.totalTasksToday === 3 && v.completedTasksToday === 3 && v.completionRate === 100 && v.workerCount === 4, JSON.stringify(v));
}
{
  // Refusal: nothing passed up, the reason shows.
  const r = await row({ 'PUT /api/venues/': () => ({}) });
  await r.choose('America/Denver');
  ok('no venue in the answer: nothing updated, error shown', r.updated.length === 0 && /time zone/i.test(r.m.text()), r.m.text());
}
console.log(`${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
