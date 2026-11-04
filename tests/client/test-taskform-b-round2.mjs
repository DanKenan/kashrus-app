import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { saveTaskBatch, detectTimeShiftDay } from '../../src/lib/taskForm.ts';
import { venueShifts } from '../../src/lib/shifts.ts';

const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
const people = [{ id: 'y', email: 'yossi@test', name: 'Yossi' }, { id: 'e', email: 'eli@test', name: 'Eli' }];
const shift = { ...venueShifts([], 'v').find((s) => s.name === 'Afternoon'), userIds: ['y'] };
const task = { id: 't', venueId: 'v', title: 'Check', assignedTo: ['yossi@test'], scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6], targetTime: '2:00 PM', targetTimeMinutes: 840 };
const noop = () => {};
const make = async (props = {}) => { recordFetch({}); const view = mount(TaskModal, { isOpen: true, venueId: 'v', shifts: [shift], timeZone: 'UTC', knownWorkers: people, onClose: noop, onSave: () => false, ...props }); await view.render(); return view; };
const who = async (view) => { if (view.find((e) => e.props['aria-label'] === 'Go to Who').length) await view.click('Go to Who'); else { await view.submit(); await view.submit(); } };
const pick = (name) => (e) => e.props['aria-label'] === `Pick ${name}`;
const save = (view) => view.find((e) => e.props.id === 'save-task-submit-btn')[0];
const expectOn = (view, predicate) => {
  const button = view.find(predicate)[0]; assert.ok(button); assert.equal(button.props['aria-pressed'], true);
  if (!button.props.className.includes('task-people-choice')) { assert.match(button.props.className, /bg-gold-deep/); assert.match(button.props.className, /text-paper/); }
  assert.match(view.buttons().find((b) => b.el === button).label, /✓/);
};

// Both ways of removing the last person stay empty, including a weekday.
let zeroSaves = 0;
const zero = await make({ taskToEdit: { ...task, assignmentMode: 'task' }, onSave: () => { zeroSaves++; return false; } });
await who(zero);
await zero.click((e) => e.type === 'button' && e.props.className === 'task-who-person pressable');
assert.equal(save(zero).props.disabled, true); assert.match(zero.text(), /Pick who does it/);
await zero.submit(); assert.equal(zeroSaves, 0);
assert.equal(zero.find((e) => e.props['aria-label'] === 'Everyone at the venue')[0].props['aria-pressed'], false);
await zero.click('+ Add people'); await zero.click(pick('Yossi')); expectOn(zero, pick('Yossi'));
assert.equal(save(zero).props.disabled, false);
await zero.click(pick('Yossi')); assert.equal(save(zero).props.disabled, true);
await zero.click((e) => e.props['aria-label'] === 'Everyone at the venue'); assert.equal(save(zero).props.disabled, false);
await zero.click(pick('Yossi'));
await zero.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
await zero.click(pick('Yossi')); await zero.click(pick('Eli')); await zero.click(pick('Eli'));
assert.equal(save(zero).props.disabled, true, 'empty weekday cannot silently become Everyone');

// Legacy private shift edits keep their exact privacy value until Who changes.
let saved;
const legacy = await make({ taskToEdit: { ...task, shiftId: shift.id, assignedTo: ['yossi@test'], isPrivate: true }, onSave: (value) => { saved = value; return false; } });
await who(legacy); await legacy.submit();
assert.equal(saved.isPrivate, true); assert.equal(saved.assignmentMode, undefined);
await legacy.find((e) => e.props.id === 'task-team-visibility')[0].props.onChange({ target: { checked: true } }); await legacy.render(); await legacy.submit();
assert.equal(saved.isPrivate, false, 'an explicit Who visibility edit still works');

// Per-day choices survive main-person changes and can explicitly be cleared.
const days = await make({ taskToEdit: { ...task, assignmentMode: 'task', dayAssignees: { '5': ['eli@test'] } }, onSave: (value) => { saved = value; return false; } });
await who(days); await days.click('+ Add people'); await days.click(pick('Yossi')); await days.click(pick('Eli'));
await days.click(pick('Yossi')); await days.click(pick('Eli'));
assert.match(days.text(), /Fri: Eli/);
await days.click('Use Yossi every day'); await days.submit(); assert.deepEqual(saved.dayAssignees, {});

// Batch validation sees the real envelope and one stable ID per unchanged retry.
const batch = await make({ onSaveMany: (tasks, operationId) => saveTaskBatch(tasks, 'v', 'yossi@test', operationId).then((r) => r.ok) });
await batch.type('task-title-input', 'One'); await batch.click('+ Add another task');
await batch.find((e) => e.props['aria-label'] === 'Task 2 name')[0].props.onChange({ target: { value: 'Two' } }); await batch.render();
await who(batch); await batch.click((e) => e.props['aria-label'] === 'Everyone at the venue');
const envelopes = [];
globalThis.fetch = async (_url, init) => { envelopes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error: 'Try again' }), { status: 400 }); };
await batch.submit(); await batch.submit();
assert.equal(envelopes.length, 2);
for (const body of envelopes) { assert.equal(body.venueId, 'v'); assert.ok(body.operationId); assert.equal(body.tasks.length, 2); assert.ok(body.tasks.every((t) => t.title && t.venueId === body.venueId)); }
assert.equal(envelopes[0].operationId, envelopes[1].operationId);
await batch.type('task-title-input', 'Changed'); await batch.submit();
assert.notEqual(envelopes[2].operationId, envelopes[1].operationId);

// The failed draft rolls back visually, remains retryable, and never writes on move.
let lastSaved;
const bar = mount(ShiftHoursBar, { shift, onSaved: (value) => { lastSaved = value; } }); await bar.render();
const range = (label) => bar.find((e) => e.props['aria-label'] === label)[0];
let writes = [];
globalThis.fetch = async (_url, init) => { writes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error: 'Try again' }), { status: 400 }); };
range('Shift start').props.onPointerDown(); range('Shift start').props.onChange({ target: { value: 900 } }); await bar.render();
assert.equal(writes.length, 0); range('Shift start').props.onPointerUp(); await bar.render();
assert.match(bar.text(), /Try again/); assert.ok(bar.buttons().some((b) => b.label === 'Try again'));
assert.equal(range('Shift start').props.value, shift.startMinutes); assert.match(bar.text(), /2:00 PM/);
range('Shift start').props.onBlur(); await bar.render(); assert.equal(writes.length, 1);
globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); writes.push(body); return new Response(JSON.stringify({ ...shift, ...body }), { status: 200 }); };
await bar.click('Try again'); assert.equal(writes.length, 2); assert.equal(lastSaved.startMinutes, 900);
assert.equal(range('Shift start').props.value, 900); assert.match(bar.text(), /3:00 PM/);
range('Shift end').props.onPointerDown(); range('Shift end').props.onChange({ target: { value: 1350 } }); await bar.render();
assert.equal(writes.length, 2); range('Shift end').props.onPointerUp(); await bar.render();
assert.equal(writes.length, 3); assert.equal(lastSaved.endMinutes, 1350); assert.match(bar.text(), /10:30 PM/);
range('Shift end').props.onBlur(); await bar.render(); assert.equal(writes.length, 3);
range('Shift start').props.onFocus(); range('Shift start').props.onChange({ target: { value: 930 } }); await bar.render();
range('Shift start').props.onChange({ target: { value: 960 } }); await bar.render(); assert.equal(writes.length, 3);
range('Shift start').props.onBlur(); await bar.render(); assert.equal(writes.length, 4); assert.match(bar.text(), /4:00 PM/);
globalThis.fetch = async (_url, init) => { writes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error: 'Try again' }), { status: 400 }); };
range('Shift start').props.onPointerDown(); range('Shift start').props.onChange({ target: { value: 990 } }); await bar.render(); range('Shift start').props.onPointerUp(); await bar.render();
assert.equal(range('Shift start').props.value, 960); assert.equal(writes.length, 5);
globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); writes.push(body); return new Response(JSON.stringify({ ...shift, ...body }), { status: 200 }); };
range('Shift end').props.onPointerDown(); range('Shift end').props.onChange({ target: { value: 1380 } }); await bar.render(); range('Shift end').props.onPointerUp(); await bar.render();
assert.equal(writes.length, 6); assert.equal(lastSaved.startMinutes, 960); assert.equal(lastSaved.endMinutes, 1380);
assert.match(bar.text(), /4:00 PM – 11:00 PM/);
assert.ok(bar.find((e) => e.props.type === 'range').every((e) => !e.props.className.includes('absolute')));

// When controls expose selection through aria-pressed; Who keeps its solid ON appearance.
const choices = await make({ taskToEdit: { ...task, assignmentMode: 'task' } });
await choices.click('Go to When');
assert.equal(choices.find((e) => e.props['aria-label'] === 'A time')[0].props['aria-pressed'], true);
await choices.click((e) => e.props['aria-label'] === 'A shift'); assert.equal(choices.find((e) => e.props['aria-label'] === 'A shift')[0].props['aria-pressed'], true);
assert.equal(choices.find((e) => e.props['aria-label'] === 'Any time during the shift')[0].props['aria-pressed'], true);
await choices.click('By a set time'); assert.equal(choices.find((e) => e.props['aria-label'] === 'By a set time')[0].props['aria-pressed'], true);
await choices.click('Some days'); assert.ok(choices.find((e) => e.props['aria-pressed'] === true && e.props.children?.includes?.('Some days')).length);
await choices.click('Go to Who'); await choices.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
assert.ok(choices.find((e) => e.props['aria-pressed'] === true && e.props.children?.includes?.('Every ')).length);
await choices.click('Just this'); assert.ok(choices.find((e) => e.props['aria-pressed'] === true && e.props.children?.includes?.('Just this ')).length);
expectOn(choices, pick('Yossi'));
assert.doesNotMatch(choices.text(), /Yossi \(yossi\)/);
const varying = { ...shift, days: shift.days.map((d, day) => ({ ...d, startMinutes: day === 5 ? 900 : 840, endMinutes: day === 5 ? 1290 : 1320 })) };
const when = await make({ taskToEdit: { ...task, targetTime: '4:00 PM', targetTimeMinutes: 960, daysOfWeek: [5] }, shifts: [varying] }); await when.click('Go to When');
assert.match(when.text(), /During the Afternoon shift on Fri \(3:00 PM – 9:30 PM\)/);

const night = venueShifts([], 'v').find((s) => s.name === 'Night');
assert.equal(detectTimeShiftDay(night, 60, 5), 4, 'Friday after midnight belongs to Thursday Night');
const overnight = await make({ taskToEdit: { ...task, targetTime: '1:00 AM', targetTimeMinutes: 60, daysOfWeek: [5] }, shifts: [night] }); await overnight.click('Go to When');
assert.match(overnight.text(), /During the Night shift on Thu/);

// Footer is a sibling of the one scrolling body inside the submitting form.
const form = choices.find((e) => e.type === 'form')[0];
const children = form.props.children.flat(Infinity).filter((e) => e && typeof e === 'object');
const body = children.find((e) => e.props['data-task-form-body']);
assert.ok(body); assert.match(body.props.className, /min-h-0 flex-1 overflow-y-auto/);
const footer = children.find((e) => e.props.className?.includes('shrink-0'));
assert.ok(footer); assert.ok(footer.props.children.flat(Infinity).some((e) => e?.props?.type === 'submit'));
const source = readFileSync(new URL('../../src/components/TaskModal.tsx', import.meta.url), 'utf8');
assert.ok(!source.includes('<p className="text-base text-ink">{namesFor(mainPeople)}</p>'));
console.log('TASKFORM-B round 2: envelope/retry ID, zero people, privacy, day reset, selections, handles/failure/retry/keyboard, and footer containment passed');
