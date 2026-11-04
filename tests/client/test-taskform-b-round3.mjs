import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { apiWrite } from '../../src/lib/api.ts';
import { venueShifts } from '../../src/lib/shifts.ts';

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T18:00:00Z'])); }
  static now() { return new RealDate('2026-11-03T18:00:00Z').getTime(); }
};
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
const people = [{ id: 'y', name: 'Yossi', email: 'yossi@test' }, { id: 'e', name: 'Eli', email: 'eli@test' }, { id: 'm', name: 'Moshe', email: 'moshe@test' }];
const shifts = venueShifts([], 'v');
const afternoon = shifts.find((s) => s.name === 'Afternoon');
const task = { id: 't', venueId: 'v', title: 'Check', assignedTo: ['yossi@test'], assignmentMode: 'task', daysOfWeek: [0,1,2,3,4,5,6], scheduleType: 'recurring', targetTime: '12:00 PM', targetTimeMinutes: 720 };
const noop = () => {};
const make = async (props = {}) => { recordFetch({}); const view = mount(TaskModal, { isOpen: true, onClose: noop, onSave: () => false, knownWorkers: people, shifts, venueId: 'v', timeZone: 'UTC', ...props }); await view.render(); return view; };
const who = async (view) => { if (view.find((e) => e.props['aria-label'] === 'Go to Who').length) await view.click('Go to Who'); else { await view.submit(); await view.submit(); } };
const pick = (name) => (e) => e.props['aria-label'] === `Pick ${name}`;
const friday = (view) => view.find((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri')[0];
const timeFields = (body) => Object.fromEntries(['shiftTime','targetTime','targetTimeMinutes','targetTime2','targetTime2Minutes'].map((key) => [key, body[key]]));

try {
  // Inspect serialized requests, including an edit opened from projected shift hours.
  const form = await make({ taskToEdit: { ...task, shiftId: afternoon.id, shiftTime: false, targetTime: '2:00 PM', targetTimeMinutes: 840, targetTime2: '10:00 PM', targetTime2Minutes: 1320 }, onSave: async (payload) => { await apiWrite('/api/tasks/t', { method: 'PUT', body: JSON.stringify(payload) }); return false; } });
  await who(form);
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  await form.submit();
  assert.deepEqual(timeFields(bodies.at(-1)), { shiftTime: false, targetTime: '', targetTimeMinutes: null, targetTime2: '', targetTime2Minutes: null });
  await form.click('Back'); await form.click((e) => e.props['aria-label'] === 'By a set time'); await form.submit(); await form.submit();
  assert.deepEqual(timeFields(bodies.at(-1)), { shiftTime: true, targetTime: '2:00 PM', targetTimeMinutes: 840, targetTime2: '', targetTime2Minutes: null });
  await form.click('Back'); await form.click((e) => e.props['aria-label'] === 'Any time during the shift'); await form.submit(); await form.submit();
  assert.deepEqual(timeFields(bodies.at(-1)), { shiftTime: false, targetTime: '', targetTimeMinutes: null, targetTime2: '', targetTime2Minutes: null });

  const created = await make({ onSave: async (payload) => { await apiWrite('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }); return false; } });
  await created.type('task-title-input', 'Check'); await created.submit(); await created.click((e) => e.props['aria-label'] === 'A shift'); await created.submit();
  await created.click((e) => e.props['aria-label'] === 'Everyone at the venue');
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  await created.submit();
  assert.deepEqual(timeFields(bodies.at(-1)), { shiftTime: false, targetTime: '', targetTimeMinutes: null, targetTime2: '', targetTime2Minutes: null });
  await created.click('Back'); await created.click((e) => e.props['aria-label'] === 'By a set time'); await created.submit(); await created.submit();
  assert.deepEqual(timeFields(bodies.at(-1)), { shiftTime: true, targetTime: '7:00 PM', targetTimeMinutes: 1140, targetTime2: '', targetTime2Minutes: null });

  const legacyTime = { ...task, assignmentMode: undefined, assignedTo: ['all'], shiftId: null };
  const everyone = await make({ taskToEdit: legacyTime }); await who(everyone);
  assert.doesNotMatch(everyone.text(), /Usual for/);
  assert.equal(everyone.find((e) => e.props['aria-label'] === 'People by day').length, 0);
  await everyone.click('+ Add people'); await everyone.click(pick('Yossi'));
  assert.equal(everyone.find((e) => e.props['aria-label'] === 'People by day').length, 1);
  assert.doesNotMatch(everyone.text(), /Usual for/);

  const everyoneSwap = await make({ taskToEdit: { ...legacyTime, assigneeSwaps: [{ date: '2026-11-06', assignedTo: ['moshe@test'] }] } }); await who(everyoneSwap);
  assert.equal(everyoneSwap.find((e) => e.props['aria-label'] === 'People by day').length, 0);
  assert.match(everyoneSwap.text(), /Swaps for single dates stay: Fri Nov 6 Moshe/);

  let saved;
  const recurring = { ...task, dayAssignees: { '5': ['eli@test'] } };
  const swap = await make({ taskToEdit: recurring, onSave: (payload) => { saved = payload; return false; } }); await who(swap);
  await swap.click((e) => e === friday(swap)); await swap.click('Just this Friday, Nov 6');
  await swap.click(pick('Eli')); await swap.click(pick('Moshe'));
  const row = friday(swap);
  assert.equal(row.props.children[0].props.className, 'w-10 shrink-0');
  assert.equal(row.props.children[1].props.children, 'M');
  const rowHtml = renderToStaticMarkup(row);
  assert.match(rowHtml, /Moshe.*just Nov 6/); assert.match(rowHtml, /usually Eli/);
  assert.match(swap.text(), /Fri: Moshe · just Nov 6 \(usually Eli\)/);
  const picked = swap.find(pick('Moshe'))[0];
  assert.match(picked.props.children[0].props.className, /bg-paper text-gold-deep/);
  assert.match(swap.find(pick('Eli'))[0].props.children[0].props.className, /bg-sunken text-ink/);
  await swap.submit(); assert.deepEqual(saved.assigneeSwaps, [{ date: '2026-11-06', assignedTo: ['moshe@test'] }]);

  const retained = await make({ taskToEdit: { ...recurring, assigneeSwaps: saved.assigneeSwaps }, onSave: (payload) => { saved = payload; return false; } }); await who(retained);
  await retained.click((e) => e === friday(retained));
  await retained.click('Use Yossi every day');
  await retained.click((e) => e.props.className === 'task-people-done pressable');
  assert.match(retained.text(), /Swaps for single dates stay: Fri Nov 6 Moshe/);
  assert.equal(friday(retained).props.children[1].props.children, 'M');
  assert.match(renderToStaticMarkup(friday(retained)), /usually Yossi/);
  await retained.submit(); assert.deepEqual(saved.dayAssignees, {}); assert.equal(saved.assigneeSwaps.length, 1);
  await retained.click((e) => e.props['aria-label'] === 'Remove swap for 2026-11-06'); await retained.submit();
  assert.deepEqual(saved.assigneeSwaps, []); assert.equal(friday(retained).props.children[1].props.children, 'Y');
  assert.doesNotMatch(retained.text(), /just Nov 6|Swaps for single dates stay:/);
  const cancel = retained.buttons().find((b) => b.label === 'Cancel');
  assert.match(cancel.el.props.className, /min-h-12/); assert.match(cancel.el.props.className, /text-base/);

  for (const [name, intervals] of [['Afternoon', [[480,960]]], ['Night', [[960,1440]]]]) {
    const bar = mount(ShiftHoursBar, { shift: shifts.find((s) => s.name === name), onSaved: noop }); await bar.render();
    const track = bar.find((e) => e.props['data-shift-track'])[0]; assert.ok(track);
    const bands = bar.find((e) => e.props['data-shift-band']); assert.equal(bands.length, intervals.length);
    bands.forEach((band, i) => { const [a,b] = intervals[i]; assert.equal(band.props.style.left, `${a / 1440 * 100}%`); assert.equal(band.props.style.width, `${(b / 1440 - a / 1440) * 100}%`); assert.match(band.props.className, /bg-gold-deep/); });
    assert.match(bar.text(), /6a 10a 2p 6p 10p 2a 6a/);
    const handles = bar.find((e) => e.props.type === 'range'); assert.equal(handles.length, 2);
    assert.ok(handles.every((e) => e.props.className.includes('min-h-11') && !e.props.className.includes('absolute')));
  }
  console.log('TASKFORM-B round 3: exact timing request fields, legacy time/Everyone, dated swap avatar and summary, retain/remove swaps, track/Night wrap, contrast and Cancel passed');
} finally { globalThis.Date = RealDate; }
