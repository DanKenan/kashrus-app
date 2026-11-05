import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { ShiftsPanel } from '../../src/components/ShiftsPanel.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { personAvatar } from '../../src/lib/personAvatar.ts';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { venueShifts, sortShiftsByStart } from '../../src/lib/shifts.ts';
import { sortTasksByTime } from '../../src/lib/taskDay.ts';
import { shiftSortProjection } from '../../src/lib/shiftTaskDay.ts';

const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-06T09:00:00Z'])); }
  static now() { return new RealDate('2026-11-06T09:00:00Z').getTime(); }
};
try {
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const calls = recordFetch({});
  const noop = () => {};
  const defaults = venueShifts([], 'v');
  const morning = defaults[0], night = defaults[2];
  const custom = (id, startMinutes, more = {}) => ({ ...morning, id, name: id, startMinutes, endMinutes: startMinutes + 30, ...more });
  // Stored custom records arrive ahead of the defaults and in creation order.
  const shifts = [custom('Late custom', 1200), custom('Early custom', 300), custom('Equal first', 600), custom('Equal second', 600),
    custom('Later date', 60, { oneTimeDate: '2026-11-08' }), custom('Earlier date', 1200, { oneTimeDate: '2026-11-07' }),
    custom('Earlier date early', 60, { oneTimeDate: '2026-11-07' })];
  const expected = ['Early custom', 'Morning', 'Equal first', 'Equal second', 'Afternoon', 'Late custom', 'Night', 'Earlier date early', 'Earlier date', 'Later date'];
  assert.deepEqual(sortShiftsByStart(venueShifts(shifts, 'v')).map((s) => s.name), expected);
  const panel = mount(ShiftsPanel, { shifts, venueId: 'v', timeZone: 'UTC', people: [], onChange: noop });
  await panel.render();
  assert.deepEqual(panel.buttons().map((b) => expected.find((name) => b.label.replace(/^✓ /, '').startsWith(name))).filter(Boolean), expected);
  assert.equal(panel.buttons().at(-1).label, '+ New shift');
  await panel.click('Early custom');
  const checkEditor = (view) => {
    const header = view.find((e) => e.props.className === 'shift-editor-header')[0];
    assert.ok(header, 'actions remain at top while the sheet scrolls');
    assert.match(view.html(), /shift-editor-sheet/);
    assert.match(view.html(), /task-people-grabber/);
    assert.match(view.html(), /task-form-current-card task-form-what/);
    assert.match(view.find((e) => e.type === 'fieldset')[0].props.className, /\bmin-w-0\b/);
    assert.match(view.html(), /shift-editor-footer task-form-footer/);
    const remove = view.buttons().find((b) => b.label === 'Delete shift');
    assert.ok(remove); assert.match(remove.el.props.className, /min-h-11/);
    assert.ok(header.props.children.flat(Infinity).includes(remove.el));
    const controls = view.find((e) => e.type === 'button');
    assert.ok(controls.indexOf(remove.el) < controls.findIndex((e) => e.props['aria-label'] === 'Sun shift'), 'Delete precedes the day rows');
    assert.ok(view.buttons().some((b) => b.aria === 'Close'));
  };
  checkEditor(panel);
  await panel.click('Delete shift');
  assert.equal(panel.tree().props.children.at(-1).props.isOpen, true, 'Delete still asks for confirmation');
  const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: noop, knownWorkers: [], venueId: 'v', timeZone: 'UTC', shifts });
  await form.render(); await form.click((e) => e.props['aria-label'] === 'A shift');
  const chipNames = (view) => view.buttons().filter((b) => b.el.props.className?.includes('task-when-shift-pick')).map((b) => expected.find((name) => b.label.replace(/^✓ /, '').startsWith(name)));
  assert.deepEqual(chipNames(form), expected);
  assert.ok(form.buttons().findIndex((b) => b.label === '+ New') > form.buttons().findIndex((b) => b.label.startsWith('Later date')));

  const tombstone = { ...morning, id: `${morning.id}:deleted`, deleted: true, name: '', days: morning.days.map(() => ({ on: false })), userIds: [], overrides: [] };
  const wire = [...defaults.slice(1), tombstone];
  await form.render({ shifts: wire });
  await form.click((e) => e.props['aria-label'] === 'A shift');
  assert.equal(form.buttons().some((b) => b.label.startsWith('Morning')), false, '9 AM selection never restores deleted Morning');
  await panel.render({ shifts: wire }); await panel.click((e) => e.props['aria-label'] === 'Close');
  assert.equal(panel.buttons().some((b) => b.label.startsWith('Morning')), false);

  // The nested editor receives records, not a resolved array that loses markers.
  await form.click('+ New');
  const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
  const editor = walk(form.tree()).find((e) => e.type === ShiftsPanel);
  assert.ok(editor.props.shifts.some((s) => s.deleted));
  const inline = mount(ShiftsPanel, { ...editor.props, initialShift: defaults[1] });
  await inline.render(); checkEditor(inline);
  assert.equal(calls.length, 0, 'sorting, opening and confirmation add no requests');

  // Deleting a code default also sticks before the parent receives a broadcast.
  const local = mount(TaskModal, { isOpen: true, onClose: noop, onSave: noop, knownWorkers: [], venueId: 'v', timeZone: 'UTC', shifts: [] });
  await local.render(); await local.click((e) => e.props['aria-label'] === 'A shift');
  await local.click((e) => e.props['aria-label'] === 'Edit Morning shift');
  const localEditor = walk(local.tree()).find((e) => e.type === ShiftsPanel);
  await localEditor.props.onChange(morning, true); await local.render();
  await local.click((e) => e.props['aria-label'] === 'A shift');
  assert.equal(local.buttons().some((b) => b.label.includes('Morning')), false);
  await local.click('+ New');
  assert.equal(venueShifts(walk(local.tree()).find((e) => e.type === ShiftsPanel).props.shifts, 'v').some((s) => s.id === morning.id), false);

  // Confirming deletion of the picked shift requires an explicit replacement.
  for (const [resolution, editing] of [['shift', false], ['time', false], ['shift', true], ['time', true]]) {
    let savedDraft;
    const draft = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (task) => { savedDraft = task; }, knownWorkers: [], venueId: 'v', timeZone: 'UTC', shifts: [], taskToEdit: editing ? { id: 'existing', title: 'Check kitchen', venueId: 'v', shiftId: morning.id, assignedTo: ['all'] } : undefined });
    await draft.render(); await draft.type('task-title-input', 'Check kitchen');
    if (editing) await draft.click('Go to When'); else await draft.submit();
    await draft.click((e) => e.props['aria-label'] === 'A shift');
    await draft.click((e) => e.props['aria-label'] === 'Edit Morning shift');
    const child = walk(draft.tree()).find((e) => e.type === ShiftsPanel);
    const deletion = mount(ShiftsPanel, child.props);
    await deletion.render(); await deletion.click('Delete shift');
    const beforeDelete = calls.length;
    await deletion.tree().props.children.at(-1).props.onConfirm(); await draft.render();
    assert.deepEqual(calls.slice(beforeDelete).map(([method, path]) => [method, path]), [['DELETE', '/api/shifts/builtin-morning%3Av']]);
    assert.equal(draft.find((e) => e.props['aria-label'] === 'A shift')[0].props['aria-pressed'], true);
    assert.equal(draft.find((e) => e.props.className === 'task-when-shift-pick pressable' && e.props['aria-pressed']).length, 0);
    assert.match(draft.find((e) => e.type === 'p' && e.props['aria-live'] === 'polite')[0].props.children[1].props.children.join(''), /Morning was deleted. Choose another shift or switch to a set time\./);
    assert.equal(draft.find((e) => e.props.id === 'save-task-submit-btn')[0].props.disabled, true);
    await draft.submit();
    assert.equal(draft.find((e) => e.props['data-task-form-current-step'])[0].props['data-task-form-current-step'], 'When');
    assert.equal(savedDraft, undefined);
    await draft.click((e) => e.props['aria-label'] === 'A shift');
    assert.equal(draft.find((e) => e.props.className === 'task-when-shift-pick pressable' && e.props['aria-pressed']).length, 0, 'mode button does not auto-pick a replacement');
    if (resolution === 'shift') await draft.click((e) => e.props.className === 'task-when-shift-pick pressable' && e.props.children[0].props.children.at(-1) === 'Afternoon');
    else await draft.click((e) => e.props['aria-label'] === 'A time');
    assert.equal(draft.find((e) => e.type === 'p' && e.props['aria-live'] === 'polite').length, 0);
    if (editing) await draft.click('Go to Who'); else await draft.submit();
    await draft.click((e) => e.props['aria-label'] === 'Everyone at the venue'); await draft.submit();
    assert.equal(savedDraft.shiftId, resolution === 'shift' ? defaults[1].id : null);
    assert.equal(calls.length, beforeDelete + 1, 'no requests beyond the confirmed deletion');
  }

  const deleteRequests = calls.length;

  // Both entry points share the sketch's header, day strip and disclosures.
  const people = [{ id: 'u', name: 'Alex', email: 'alex@test.local' }];
  const headerTasks = [{ id: 'one', venueId: 'v', shiftId: morning.id }, { id: 'old-id', venueId: 'v', shiftId: 'builtin-morning' }, { id: 'elsewhere', venueId: 'elsewhere', shiftId: morning.id }];
  const sheet = mount(ShiftsPanel, { shifts: [], tasks: headerTasks, venueId: 'v', timeZone: 'UTC', people, createOnly: true, initialShift: morning, onChange: noop });
  await sheet.render(); checkEditor(sheet);
  assert.match(sheet.text(), /Edit Morning shift/);
  assert.match(sheet.text(), /Built in · used by 2 tasks/);
  await sheet.render({ tasks: headerTasks.slice(0, 1) });
  assert.match(sheet.text(), /Built in · used by 1 task\b/);
  assert.doesNotMatch(sheet.text(), /used by 1 tasks/);
  assert.equal(sheet.find((e) => e.type === 'details' && e.props.className === 'shift-editor-differences')[0].props.open, false);
  const dayStrip = sheet.find((e) => e.props.className === 'shift-editor-days')[0];
  assert.deepEqual(dayStrip.props.children.map((e) => e.props.children), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  await sheet.click((e) => e.props['aria-label'] === 'Mon shift');
  assert.equal(sheet.find((e) => e.props['aria-label'] === 'Mon shift')[0].props['aria-checked'], false);
  assert.match(sheet.text(), /Repeats every week/);
  assert.match(sheet.text(), /Type exact times/);
  const alex = sheet.buttons().find((b) => b.label.includes('Alex'));
  assert.deepEqual(alex.el.props.children[0].props.style, personAvatar(people[0].email));
  await sheet.click('Alex');
  assert.equal(sheet.buttons().find((b) => b.label.includes('Alex')).el.props['aria-pressed'], true);
  assert.ok(sheet.buttons().find((b) => b.label === '✓ Save shift'));
  await sheet.render({ initialShift: { ...morning, days: morning.days.map((day, i) => i === 1 ? { ...day, userIds: [] } : day) } });
  assert.equal(sheet.find((e) => e.type === 'details' && e.props.className === 'shift-editor-differences')[0].props.open, true);
  await sheet.render({ initialShift: { ...morning, overrides: [{ date: '2026-11-07', userIds: [] }] } });
  assert.equal(sheet.find((e) => e.type === 'details' && e.props.className === 'shift-editor-differences')[0].props.open, true);
  await sheet.render({ initialShift: undefined });
  assert.match(sheet.text(), /New shift/); assert.match(sheet.text(), /Custom · used by 0 tasks/);
  assert.equal(sheet.buttons().some((b) => b.label === 'Delete shift'), false);
  // Hours in this editor are a draft, not the task form bar's release-save.
  const walkSheet = walk(sheet.tree());
  const barProps = walkSheet.find((e) => e.type === ShiftHoursBar).props;
  const bar = mount(ShiftHoursBar, barProps);
  await bar.render();
  const slider = bar.find((e) => e.props['aria-label'] === 'Shift start')[0];
  slider.props.onPointerDown(); slider.props.onChange({ target: { value: '570' } });
  await bar.render(); bar.find((e) => e.props['aria-label'] === 'Shift start')[0].props.onPointerUp();
  await sheet.render();
  assert.equal(sheet.find((e) => e.type === 'input' && e.props.type === 'time')[0].props.value, '09:30');
  assert.equal(calls.length, deleteRequests, 'sheet draft edits never issue requests');

  const namedShifts = [
    custom('david-long', 450, { name: 'David Aguirre', endMinutes: 1175 }),
    custom('david-short', 435, { name: 'David Aguirre', endMinutes: 445 }),
    { ...morning, name: 'Morning Kitchen' },
    custom('deli', 420, { name: 'Deli Morning', endMinutes: 840 }),
    ...defaults.slice(1).map((shift) => ({ ...shift, deleted: true })),
  ];
  const chips = mount(TaskModal, { isOpen: true, onClose: noop, onSave: noop, knownWorkers: [], venueId: 'v', timeZone: 'UTC', shifts: namedShifts });
  await chips.render(); await chips.click((e) => e.props['aria-label'] === 'A shift');
  const checkNames = () => {
    const names = chips.find((e) => e.props.className === 'task-when-shift-name');
    assert.deepEqual(names.map((e) => e.props.children.at(-1)), ['Morning Kitchen', 'Deli Morning', 'David Aguirre', 'David Aguirre']);
    for (const name of names) assert.doesNotMatch(name.props.className, /truncate|nowrap|ellipsis|line-clamp/);
    assert.deepEqual(chips.find((e) => e.props.className === 'task-when-shift-hours').map((e) => e.props.children), ['6 AM–2 PM', '7 AM–2 PM', '7:15–7:25 AM', '7:30 AM–7:35 PM']);
    const picked = chips.find((e) => e.props.className === 'task-when-shift is-picked')[0];
    const [label, pencil] = picked.props.children;
    assert.match(label.props.className, /task-when-shift-pick/);
    assert.equal(pencil.props['aria-label'], `Edit ${label.props.children[0].props.children.at(-1)} shift`);
    assert.match(pencil.props.className, /task-when-pencil/);
  };
  await chips.click((e) => e.props.className === 'task-when-shift-pick pressable' && e.props.children[0].props.children.at(-1) === 'Morning Kitchen');
  checkNames();
  await chips.click((e) => e.props.className === 'task-when-shift-pick pressable' && e.props.children[1].props.children === '7:30 AM–7:35 PM');
  checkNames();
  // Entering When and picking another shift scroll only the list, using the
  // whole card's bounds rather than the label's bounds or page scrolling.
  const scroller = { scrollLeft: 100, clientLeft: 0, getBoundingClientRect: () => ({ left: 20 }) };
  let chipLeft = 171;
  const card = { parentElement: scroller, getBoundingClientRect: () => ({ left: chipLeft }), scrollIntoView() { throw new Error('must not scroll the page'); } };
  chips.find((e) => e.props['aria-pressed'] === true && e.props.className === 'task-when-shift-pick pressable')[0].props.ref.current = { parentElement: card };
  await chips.type('task-title-input', 'Check selected shift'); await chips.submit();
  assert.equal(scroller.scrollLeft, 251, 'auto-picked card aligns with the list start on entering When');
  chipLeft = -80;
  await chips.click((e) => e.props.className === 'task-when-shift-pick pressable' && e.props.children[0].props.children.at(-1) === 'Morning Kitchen');
  assert.equal(scroller.scrollLeft, 151, 'picking to the left also aligns the whole card');
  const chipCss = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
  assert.match(chipCss, /\.task-shift-scroll \{[^}]*padding-inline-end: 10%/);
  assert.match(chipCss, /\.task-shift-scroll > \* \{ scroll-snap-align: start/);
  assert.match(chipCss, /\.task-when-shift-name \{[^}]*white-space: normal/);
  assert.match(chipCss, /\.task-when-pencil \{[^}]*position: static/);
  assert.doesNotMatch(chipCss, /\.task-when-shift-pick[^{}]*\{[^}]*(?:nowrap|ellipsis|overflow: hidden)/);

  const task = (id, more = {}) => ({ id, createdAt: '2026-11-05T10:00:00Z', sortOrder: 0, venueId: 'v', ...more });
  const tasks = [task('2 PM', { targetTime: '2:00 PM' }),
    task('7 AM', { targetTime: '7:00 AM', createdAt: '2026-11-06T10:00:00Z' }),
    task('Morning any time', { shiftId: morning.id, targetTime: '', createdAt: '2026-11-06T11:00:00Z' }),
    task('Night any time', { shiftId: night.id, targetTime: '' })];
  const byId = new Map(defaults.map((s) => [s.id, s]));
  const sorted = sortTasksByTime(shiftSortProjection(tasks, byId));
  assert.deepEqual(sorted.map((t) => t.id), ['Morning any time', '7 AM', '2 PM', 'Night any time']);
  assert.equal(sorted.at(-1).targetTimeMinutes, 1320, 'Night sorts at its 10 PM start');
  const ties = [task('latest', { targetTime: '7:00 AM', sortOrder: 2, createdAt: '2026-11-06' }),
    task('earliest order', { targetTime: '7:00 AM', sortOrder: 1 }),
    task('earlier creation', { targetTime: '7:00 AM', sortOrder: 2, createdAt: '2026-11-04' })];
  assert.deepEqual(sortTasksByTime(shiftSortProjection(ties, byId)).map((t) => t.id), ['earliest order', 'earlier creation', 'latest']);
  const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /--task-form-field-height: 46px/);
  assert.match(css, /\.task-form-what input[^{}]+[\s\S]*?min-height: var\(--task-form-field-height\)/);
  console.log('SHIFTDEL-SORT: chip/panel clock order, stable ties/date order, deletion persistence, shared visible Delete/confirm/editor styling, no client I/O, task-time regression passed');
} finally { globalThis.Date = RealDate; }
