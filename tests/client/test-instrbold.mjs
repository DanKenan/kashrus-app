// INSTRBOLD (Don, Oct 27): "Inspection Instructions & Halachic Notes" stand out on the task card / table row,
// and nothing shows when a task has no instructions.
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + String(d).slice(0, 400) : '')); } };
const rd = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const h = React.createElement;
// Dynamic import so the board-view checks still run (and fail) on main, where the box does not exist yet.
let TaskInstructions = () => null, INSTRUCTIONS_HEADING = '', isLongInstructions = () => false;
try { ({ TaskInstructions, INSTRUCTIONS_HEADING, isLongInstructions } = await import('../../src/components/TaskInstructions.tsx')); } catch (e) { ok('TaskInstructions module exists', false, e.message); }
const html = (el) => renderToStaticMarkup(el);
const esc = (s) => s.replace(/&/g, '&amp;');
const HEAD = esc('Inspection Instructions & Halachic Notes');

// The box itself
ok('heading text unchanged', INSTRUCTIONS_HEADING === 'Inspection Instructions & Halachic Notes');
const box = html(h(TaskInstructions, { text: 'Check the hechsher on every delivery.\nBishul Yisroel: light the oven.' }));
ok('box renders with the heading', box.includes('data-task-instructions') && box.includes(HEAD), box);
ok('box: the instructions are shown without a tap', box.includes('Check the hechsher on every delivery.') && box.includes('Bishul Yisroel: light the oven.'));
const cls = (box.match(/<section[^>]*class="([^"]*)"/) || [])[1] || '';
ok('box: tinted with a left accent bar', /\bbg-sunken\b/.test(cls) && /\bborder-l-4\b/.test(cls) && /\bborder-l-ink\b/.test(cls), cls);
ok('box: no gold decoration (spec 1d)', !/gold/.test(box), box);
ok('heading is bold ink with an icon', /<h4 class="[^"]*\bfont-bold\b[^"]*\btext-ink\b[^"]*"><svg/.test(box), box);
const pcls = (box.match(/<p[^>]*class="([^"]*)"/) || [])[1] || '';
ok('body text is larger (text-sm) and dark (text-ink), not the old faint text-xs', /\btext-sm\b/.test(pcls) && /\btext-ink\b/.test(pcls) && !/\btext-xs\b|\btext-ink-soft\b|\btext-ink-faint\b/.test(pcls), pcls);
ok('body follows the text direction (Hebrew)', /<p dir="auto"/.test(box));
ok('short notes: no clamp and no "Show all"', !/line-clamp/.test(box) && !/Show all/.test(box));
ok('empty -> nothing', html(h(TaskInstructions, { text: '' })) === '');
ok('only spaces/newlines -> nothing', html(h(TaskInstructions, { text: '  \n\t ' })) === '');
ok('undefined / null -> nothing', html(h(TaskInstructions, {})) === '' && html(h(TaskInstructions, { text: null })) === '');
const longText = 'Step one. '.repeat(30);
const lbox = html(h(TaskInstructions, { text: longText }));
ok('long notes: clamped to 4 lines with a "Show all" button (aria-expanded=false)', isLongInstructions(longText) && /line-clamp-4/.test(lbox) && /aria-expanded="false"[^>]*>[\s\S]*Show all/.test(lbox), lbox.slice(0, 600));
ok('boundary: 180 characters is short, 181 is long', !isLongInstructions('x'.repeat(180)) && isLongInstructions('x'.repeat(181)));
ok('spacing on the 4 px grid (SPEC 3: no new half-steps)', !/\b(?:p|px|py|pt|pb|m|mt|mb|gap)-\d\.5\b/.test(rd('src/components/TaskInstructions.tsx')));
ok('many lines count as long', isLongInstructions('a\nb\nc\nd\ne') && !isLongInstructions('a\nb\nc\nd'));

// On the real board views
const me = { id: 'u1', email: 'dana@demo.test', name: 'Dana Demo', role: 'admin' };
const base = { venueId: 'v1', category: 'Opening Procedures', categories: ['Opening Procedures'], inputType: 'checkbox', assignedTo: ['all'], scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: '8:00 AM', currentStatus: 'pending', isCompleted: false, notes: '', checkIns: [] };
const tasks = [
  { ...base, id: 't1', title: 'Light the bakery ovens', description: 'Mashgiach lights the pilot; Pas Yisroel.' },
  { ...base, id: 't2', title: 'Unlock the walk-in', description: '' },
  { ...base, id: 't3', title: 'Wipe the deli counter', description: '   ' },
];
const noop = () => {};
const props = { tasks, currentUser: me, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop };
for (const [name, View] of [['card view (phone)', TaskCardView], ['table view (desk)', TaskTableView]]) {
  let out = '';
  try { out = html(h(View, props)); } catch (e) { out = 'RENDER ERROR ' + e; }
  const boxes = out.split('data-task-instructions').length - 1;
  ok(`${name}: renders`, out.includes('Light the bakery ovens') && out.includes('Unlock the walk-in'), out.slice(0, 300));
  ok(`${name}: exactly one instructions box (task with notes), none for empty/blank`, boxes === 1, `boxes=${boxes}`);
  ok(`${name}: the notes are visible without a tap`, out.includes('Mashgiach lights the pilot; Pas Yisroel.'));
  ok(`${name}: the old small toggle is gone`, !/View instructions|Hide instructions/.test(out));
}
ok('both board views use the shared box', ['src/components/TaskCardView.tsx', 'src/components/TaskTableView.tsx'].every((f) => rd(f).includes('<TaskInstructions text={task.description} />')));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
