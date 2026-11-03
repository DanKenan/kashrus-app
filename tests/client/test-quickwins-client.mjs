import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { filterChipClass } from '../../src/lib/filterChip.tsx';
import { activeFilterChips, clearActiveFilter } from '../../src/lib/activeFilters.ts';
import { whoSeesLabel } from '../../src/lib/whoSees.ts';
import { nextFullHour } from '../../src/lib/nextFullHour.ts';
import { TaskFilterBar } from '../../src/components/TaskFilterBar.tsx';
import { StatsProgressBar } from '../../src/components/StatsProgressBar.tsx';
import { OwnerAuditBanner } from '../../src/components/OwnerAuditBanner.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';
import { KioskTaskPanel } from '../../src/components/KioskTaskPanel.tsx';
import { TaskModal } from '../../src/components/TaskModal.tsx';

let passed = 0, failures = 0;
const ok = (label, condition, info = '') => { if (condition) passed++; else { failures++; console.error(`FAIL ${label}: ${info}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const noop = () => {};
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const buttons = (html) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
const checkChip = (label, html, on) => {
  ok(`${label} pressed`, html.includes(`aria-pressed="${on}"`));
  eq(`${label} solid`, html.includes('chip-on'), on);
  eq(`${label} check svg`, /<svg[^>]*lucide-check(?:\s|\")/.test(html), on);
  if (!on) ok(`${label} neutral`, html.includes('bg-surface') && html.includes('text-ink-soft') && !/gold/.test(html));
};
ok('shared ON uses solid gold', /chip-on bg-gold-deep/.test(filterChipClass(true)));
ok('shared OFF is neutral', !/gold|chip-on/.test(filterChipClass(false)));
const filterProps = { searchQuery: '', onSearchChange: noop, selectedCategories: [], onCategoryChange: noop, categories: ['Temperature'], categoryCounts: { Temperature: 2 }, viewMode: 'cards', onViewModeChange: noop, dayView: 'today', onDayViewChange: noop, onOpenTaskModal: noop, isAdmin: true };
for (const dayView of ['today', 'all']) for (const viewMode of ['cards', 'table']) for (const selectedCategories of [[], ['Temperature']]) {
  const html = render(TaskFilterBar, { ...filterProps, dayView, viewMode, selectedCategories });
  const list = buttons(html);
  for (const day of ['today', 'all']) checkChip(`day ${day} ${dayView}`, list.find((b) => b.includes(`id="day-view-${day}"`)), day === dayView);
  for (const mode of ['cards', 'table']) {
    const chip = list.find((b) => b.includes(`id="view-${mode}-btn"`));
    checkChip(`layout ${mode} ${viewMode}`, chip, mode === viewMode);
    ok(`layout ${mode} word`, chip.includes(mode === 'cards' ? 'Cards' : 'Table'));
  }
  const categoryHtml = html.slice(html.indexOf('aria-label="Filter by category"'));
  const cats = buttons(categoryHtml);
  checkChip('All category', cats[0], selectedCategories.length === 0);
  checkChip('Temperature category', cats[1], selectedCategories.length > 0);
  ok('category count stays visible', cats[1].includes('>2</span>'));
  eq('OFF category keeps colored dot', cats[1].includes('cat-dot'), selectedCategories.length === 0);
}
for (const activeFilter of ['all', 'mine', 'pending']) {
  const list = buttons(render(StatsProgressBar, { totalTasks: 5, completedTasks: 2, completionRate: 40, myTotal: 3, myCompleted: 1, activeFilter, onSelectFilter: noop }));
  for (const key of ['all', 'mine', 'pending']) checkChip(`stats ${key} ${activeFilter}`, list.find((b) => b.includes(`id="filter-${key}-btn"`)), key === activeFilter);
  const owner = buttons(render(OwnerAuditBanner, { totalTasks: 5, completedTasks: 2, completionRate: 40, activeFilter, onSelectFilter: noop, onOpenHistoryModal: noop, ownerName: 'David' }));
  if (activeFilter !== 'mine') ok(`owner ${activeFilter} showing pill and ring`, owner.some((b) => b.includes('aria-pressed="true"') && b.includes('ring-gold') && b.includes('Showing')));
}
const defaults = { dayView: 'today', quickFilter: 'all' };
const base = { ...defaults, categories: [], search: '' };
eq('default filters hidden', activeFilterChips(base, defaults), []);
eq('admin All days differs from real Today default', activeFilterChips({ ...base, dayView: 'all' }, defaults), [{ key: 'day', label: 'All days' }]);
eq('Today differs when default is All days', activeFilterChips(base, { ...defaults, dayView: 'all' }), [{ key: 'day', label: 'Today' }]);
let state = { ...base, quickFilter: 'pending', categories: ['Temperature'] };
eq('Pending and category labels', activeFilterChips(state, defaults), [{ key: 'quick', label: 'Pending' }, { key: 'category:Temperature', label: 'Temperature' }]);
state = clearActiveFilter(state, defaults, 'quick');
eq('clear quick leaves category', state, { ...base, categories: ['Temperature'] });
eq('clear category returns default', clearActiveFilter(state, defaults, 'category:Temperature'), base);
eq('clear all returns default', clearActiveFilter({ ...state, dayView: 'all', search: 'milk' }, defaults, 'all'), base);
eq('search label', activeFilterChips({ ...base, search: 'milk' }, defaults), [{ key: 'search', label: 'Search: "milk"' }]);
eq('clear search only', clearActiveFilter({ ...state, search: 'milk' }, defaults, 'search'), state);
eq('clear day only', clearActiveFilter({ ...base, dayView: 'all' }, defaults, 'day'), base);
const ownDefaults = { dayView: 'today', quickFilter: 'mine' };
eq('own default hidden', activeFilterChips({ ...base, quickFilter: 'mine' }, ownDefaults), []);
eq('clear own uses role default', clearActiveFilter(state, ownDefaults, 'all'), { ...base, quickFilter: 'mine' });
const roster = [{ id: 'y', name: 'Yossi', email: 'yossi@example.com' }, { id: 'e', name: 'Eli', email: 'eli@example.com' }, { id: 's', name: 'Sara', email: 'sara@example.com' }];
const shift = { id: 'evening', venueId: 'crown', name: 'Evening', startMinutes: 900, endMinutes: 1380, days: Array.from({ length: 7 }, () => ({ on: true })), userIds: ['y', 'e'], overrides: [] };
const ctx = { viewer: { id: 'y', email: 'YOSSI@example.com' }, mode: 'editor', shiftsById: new Map([[shift.id, shift]]), roster, todayYmd: null, todayWeekday: null, nowMinutes: null };
const label = (task, mode = 'editor', extra = {}) => whoSeesLabel(task, { ...ctx, mode, ...extra });
eq('editor shift', label({ shiftId: shift.id }).text, 'Evening shift');
eq('own shift without occurrence is neutral', label({ shiftId: shift.id }, 'own').text, 'Evening shift');
eq('kiosk shift', label({ shiftId: shift.id }, 'kiosk').text, 'Evening shift');
eq('shift preserves today names', label({ shiftId: shift.id }, 'editor', { todayYmd: '2026-11-03', todayWeekday: 2, nowMinutes: 1000 }).text, 'Evening shift · today: Yossi, Eli');
for (const assignedTo of [[], ['all'], ['ALL']]) {
  eq('editor everyone', label({ assignedTo }).text, 'Everyone');
  eq('own everyone', label({ assignedTo }, 'own').text, 'For everyone');
  eq('kiosk everyone', label({ assignedTo }, 'kiosk').text, 'Everyone');
}
eq('one person case insensitive', label({ assignedTo: ['YOSSI@example.com'] }).text, 'Assigned to Yossi');
eq('own direct', label({ assignedTo: ['yossi@example.com'] }, 'own').text, 'Assigned to you');
eq('two people', label({ assignedTo: ['yossi@example.com', 'eli@example.com'] }).text, 'Assigned to Yossi, Eli');
eq('three people', label({ assignedTo: roster.map((p) => p.email) }).text, 'Assigned to Yossi, Eli +1');
eq('kiosk person', label({ assignedTo: ['yossi@example.com'] }, 'kiosk').text, 'Yossi');
eq('unknown email local part', label({ assignedTo: ['moshe@example.com'] }).text, 'Assigned to moshe');
ok('unknown never full email', !JSON.stringify(label({ assignedTo: ['moshe@example.com'] })).includes('@'));
eq('private icon and title', label({ assignedTo: ['yossi@example.com'], isPrivate: true }), { text: 'Only Yossi', icon: 'private', title: 'Private: only them, admins and coordinators' });
for (const [minutes, hour, ampm] of [[0, 1, 'AM'], [840, 3, 'PM'], [841, 3, 'PM'], [1410, 12, 'AM'], [719, 12, 'PM']]) eq(`next hour ${minutes}`, nextFullHour(minutes), { hour, minute: 0, ampm });
const user = { id: 'y', email: 'yossi@example.com', name: 'Yossi', role: 'mashgiach' };
const viewProps = { tasks: [], currentUser: user, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop };
for (const component of [TaskCardView, TaskTableView]) {
  for (const onOpenTaskModal of [undefined, noop]) {
    const html = render(component, { ...viewProps, onOpenTaskModal });
    ok('non assigner empty words', html.includes('Nothing for you right now.') && html.includes('New tasks show up here.'));
    ok('non assigner no create button', !buttons(html).some((b) => /New task|Create/.test(b)));
  }
  const html = render(component, { ...viewProps, currentUser: { ...user, role: 'admin' }, onOpenTaskModal: noop });
  ok('assigner empty explanation and button', html.includes('If the list looks short, a filter is on.') && buttons(html).some((b) => b.includes('New task')));
}
const task = { id: 'check', venueId: 'crown', title: 'Crown Market', category: 'Temperature', assignedTo: ['yossi@example.com'], inputType: 'yes_no', currentStatus: 'pending', isCompleted: false, createdAt: '2026-11-03T12:00:00Z', updatedAt: '2026-11-03T12:00:00Z', notes: '' };
for (const component of [TaskCardView, TaskTableView]) {
  const html = render(component, { ...viewProps, tasks: [task], roster });
  ok('own rendered tag', html.includes('Assigned to you') && !html.includes('yossi@example.com'));
  ok('rendered Photo word', html.includes('>Photo</span>'));
}
const modal = read('src/components/TaskModal.tsx');
for (const old of ['Completion Input Type', 'Global Task', 'Visible to the rest of the team']) ok(`modal removes ${old}`, !modal.includes(old));
const card = read('src/components/TaskCardView.tsx');
for (const old of ['Yes (Verified)', 'register a new kosher assignment']) ok(`card removes ${old}`, !card.includes(old));
ok('initial time uses venue clock', /useState<PickerTime>\(\(\) => nextFullHour\(minutesIn\(timeZone, new Date\(\)\)\)\)/.test(modal));
ok('new task reset uses venue clock', /setInputType\('yes_no'\);\s*setTime1\(nextFullHour\(minutesIn\(timeZone, new Date\(\)\)\)\)/.test(modal));
ok('editing preserves stored time', modal.includes('setTime1(t1)'));
ok('alert state wording', modal.includes("On: a push alert when it's late") && modal.includes("Off: no alert if it's late"));
ok('visibility wording', modal.includes('Owner and managers can see it too') && modal.includes('Off: only the people you picked, admins and coordinators see it.'));
const modalHtml = render(TaskModal, { isOpen: true, onClose: noop, onSave: noop, knownWorkers: roster, timeZone: 'America/New_York' });
ok('new task shows off alert hint', modalHtml.includes('Off: no alert if it&#x27;s late'));
ok('everyone clock hint rendered', modalHtml.includes('People with a shift today'));
const app = read('src/App.tsx');
ok('board and kiosk share clear controls', app.includes('<ActiveFilters state={filterState}') && app.includes('filterSummary={showingFilters}') && app.includes('{showingFilters}'));
ok('App preserves Cards/Table when clearing', !/setViewMode|changeViewMode|setKioskView/.test(app.split('const changeFilters =')[1]?.split('const showingFilters')[0] || ''));
const { mount, recordFetch } = await import('./lib/mini-render.mjs');
recordFetch({});
const RealDate = globalThis.Date;
try {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-03T20:01:00Z'])); }
    static now() { return new RealDate('2026-11-03T20:01:00Z').getTime(); }
  };
  let saved;
  const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (value) => { saved = value; }, knownWorkers: roster, timeZone: 'America/New_York' });
  await form.render();
  ok('new form alert initially off', form.text().includes("Off: no alert if it's late"));
  const alert = form.find((e) => e.type === 'input' && e.props.type === 'checkbox' && e.props.checked === false && e.props.disabled === false)[0];
  await alert.props.onChange({ target: { checked: true } });
  await form.render();
  ok('new form alert on hint', form.text().includes("On: a push alert when it's late"));
  const title = form.find((e) => e.type === 'input' && e.props.required)[0];
  await title.props.onChange({ target: { value: 'Crown Market' } });
  await form.render();
  await form.submit();
  eq('new form saves next venue hour', [saved.targetTime, saved.targetTimeMinutes], ['4:00 PM', 960]);
  await form.render({ taskToEdit: { ...task, targetTime: '9:30 AM', targetTimeMinutes: 570 } });
  await form.submit();
  eq('editing saves stored time', [saved.targetTime, saved.targetTimeMinutes], ['9:30 AM', 570]);
  await form.render({ taskToEdit: null, isOpen: false });
  await form.render({ isOpen: true });
  await form.click('Any time');
  ok('Any time hides shift-hour hint', !form.text().includes('People with a shift today'));
} finally { globalThis.Date = RealDate; }
// RV1: behavior-level comparisons use existing components, so failures are
// assertions on the pre-review implementation rather than missing helper imports.
const occurrence = { todayYmd: '2026-11-03', todayWeekday: 2, nowMinutes: 1000 };
const shiftTask = { venueId: 'crown', shiftId: shift.id, assignedTo: ['yossi@example.com'] };
eq('own member on current occurrence', label(shiftTask, 'own', occurrence).text, "Because you're on Evening");
eq('own nonmember does not claim membership', label(shiftTask, 'own', { ...occurrence, viewer: { id: 's', email: 'sara@example.com' } }).text, 'Evening shift');
eq('no occurrence does not claim membership', label(shiftTask, 'own', { ...occurrence, shiftsById: new Map([[shift.id, { ...shift, days: Array.from({ length: 7 }, () => ({ on: false })) }]]) }).text, 'Evening shift');
for (const mode of ['editor', 'kiosk']) {
  eq(`${mode} missing shift`, label({ ...shiftTask, shiftId: 'removed' }, mode).text, 'Shift (removed)');
  const wrongVenue = label({ ...shiftTask, venueId: 'elsewhere' }, mode, occurrence);
  eq(`${mode} wrong venue`, wrongVenue.text, 'Shift (removed)');
  ok(`${mode} wrong venue exposes no people`, !JSON.stringify(wrongVenue).includes('Yossi'));
}
for (const badTask of [{ ...shiftTask, shiftId: 'removed' }, { ...shiftTask, venueId: 'elsewhere' }]) {
  eq('own invalid shift assigned fallback', label(badTask, 'own', occurrence).text, 'Assigned to you');
  eq('own invalid shift everyone fallback', label({ ...badTask, assignedTo: ['all'] }, 'own', occurrence).text, 'For everyone');
  eq('own invalid shift other person fallback', label({ ...badTask, assignedTo: ['eli@example.com'] }, 'own', occurrence).text, 'Assigned to Eli');
}
for (const assignedTo of [['yossi@example.com'], ['yossi@example.com', 'eli@example.com']]) {
  const ordinary = label({ assignedTo });
  const privateLabel = label({ assignedTo, isPrivate: true });
  ok('non-private says Assigned to, User icon', ordinary.text.startsWith('Assigned to ') && ordinary.icon === 'person' && ordinary.title === undefined);
  ok('private says Only, lock and exact title', privateLabel.text.startsWith('Only ') && privateLabel.icon === 'private' && privateLabel.title === 'Private: only them, admins and coordinators');
  eq('own private still assigned to you', label({ assignedTo, isPrivate: true }, 'own').text, 'Assigned to you');
  ok('kiosk private has lock but no prefix', label({ assignedTo, isPrivate: true }, 'kiosk').icon === 'private' && !/Only|Assigned to/.test(label({ assignedTo, isPrivate: true }, 'kiosk').text));
}
for (const activeFilter of ['all', 'completed', 'pending']) {
  const cards = buttons(render(OwnerAuditBanner, { totalTasks: 5, completedTasks: 2, completionRate: 40, activeFilter, onSelectFilter: noop, onOpenHistoryModal: noop, ownerName: 'David' })).filter((b) => b.includes('aria-pressed='));
  eq('owner exactly one selected card', cards.filter((b) => b.includes('aria-pressed="true"')).length, 1);
  for (const card of cards) {
    const opening = card.slice(0, card.indexOf('>') + 1);
    const selected = opening.includes('aria-pressed="true"');
    eq('owner entire selected card filled', opening.includes('chip-on') && opening.includes('bg-gold-deep'), selected);
    if (selected) ok('owner selected card has check', /lucide-check/.test(card));
  }
  ok('owner preserves status words', cards.some((b) => b.includes('Verified')) && cards.some((b) => b.includes('Needs Attention')));
}
ok('owner selected descendants inherit white text', /\.owner-metric-on :where\(div, span, p, svg\)\s*\{\s*color: inherit;/.test(read('src/index.css')));
const kioskProps = { ...filterProps, tasks: [], currentUser: user, activeFilter: 'all', onSelectFilter: noop, totalTasks: 0, completedTasks: 0, myTotal: 0, myCompleted: 0, onUpdateStatus: async () => true, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop, onEndShift: noop, view: 'list', onViewChange: noop };
const kiosk = mount(KioskTaskPanel, kioskProps);
await kiosk.render();
await kiosk.click('Find a task');
for (const selectedCategories of [[], ['Temperature']]) {
  await kiosk.render({ selectedCategories });
  const group = kiosk.html().split('aria-label="Filter by category"')[1]?.split('</div>')[0] || '';
  const chips = buttons(group);
  ok('kiosk category controls render', chips.length === 2);
  for (const [i, on] of [selectedCategories.length === 0, selectedCategories.length > 0].entries()) {
    checkChip(`kiosk category ${i}`, chips[i], on);
    ok(`kiosk category ${i} large target and type`, /min-h-16/.test(chips[i]) && /text-base/.test(chips[i]));
  }
}
try {
  const { ActiveFilters } = await import('../../src/components/ActiveFilters.tsx');
  for (const role of ['admin', 'owner', 'mashgiach', 'kiosk']) {
    const defaults = { dayView: 'today', quickFilter: role === 'mashgiach' ? 'mine' : 'all' };
    let emitted;
    const state = { dayView: 'today', quickFilter: 'pending', categories: ['Temperature'], search: 'milk' };
    const summary = mount(ActiveFilters, { state, defaults, kiosk: role === 'kiosk', onChange: (next) => { emitted = next; } });
    await summary.render();
    ok(`${role} summary has active labels`, /Pending/.test(summary.text()) && /Temperature/.test(summary.text()) && /Search: "milk"/.test(summary.text()));
    await summary.click((e) => e.props['aria-label'] === 'Turn off Temperature');
    eq(`${role} clear one callback`, emitted, { ...state, categories: [] });
    await summary.click('Clear all');
    eq(`${role} clear all callback`, emitted, { ...defaults, categories: [], search: '' });
    await summary.render({ state: emitted });
    eq(`${role} default summary hidden`, summary.html(), '');
  }
} catch (e) { ok('shared clear controls mount', false, e.message); }
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
