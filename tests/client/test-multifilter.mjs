/**
 * MULTIFILTER client test (Codex lane). Don (Oct 27): the category chips on the
 * task board take several picks at once, with AND logic — "Opening Procedures"
 * + "Bakery & Deli" shows only tasks that carry BOTH. "All" clears every pick;
 * tapping a picked chip unpicks it; nothing picked = every task, as before.
 *  H*  pure helpers (src/lib/categoryFilter.ts): toggle, AND match, prune.
 *  F*  a tap sequence run through the same helpers the App uses, on demo tasks.
 *  R*  TaskFilterBar render: every picked chip is marked (aria-pressed), All is not.
 *  S*  source checks: App keeps an array and filters with matchesCategories; the kiosk chips use the same picks.
 * Run: npx tsx tests/client/test-multifilter.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

let H = null;
try { H = await import('../../src/lib/categoryFilter.ts'); }
catch (e) { ok('H0 src/lib/categoryFilter.ts loads', false, String(e && e.message || e).split('\n')[0]); }

const OPEN = 'Opening Procedures';
const BAKERY = 'Bakery & Deli';
const MEAT = 'Meat Room';
const tasks = [
  { id: 'both', title: 'Light the bakery ovens', categories: [OPEN, BAKERY] },
  { id: 'open', title: 'Turn on rice cooker', categories: [OPEN] },
  { id: 'bake', title: 'Check flour bins', categories: [BAKERY] },
  { id: 'three', title: 'Morning deli walk-through', categories: [BAKERY, MEAT, OPEN] },
  { id: 'legacy', title: 'Check kitchen pilots', category: OPEN },
  { id: 'none', title: 'Sign the log' },
];
const shown = (sel) => tasks.filter((t) => H.matchesCategories(t, sel)).map((t) => t.id);

if (H) {
  // H: helpers
  eq('H1 tap a chip adds it', H.toggleCategory([], OPEN), [OPEN]);
  eq('H2 tap a second chip adds it too', H.toggleCategory([OPEN], BAKERY), [OPEN, BAKERY]);
  eq('H3 tap a picked chip unpicks it', H.toggleCategory([OPEN, BAKERY], OPEN), [BAKERY]);
  eq('H4 All clears every pick', H.toggleCategory([OPEN, BAKERY], 'all'), []);
  eq('H5 All with nothing picked stays empty', H.toggleCategory([], 'all'), []);
  ok('H6 nothing picked matches every task', tasks.every((t) => H.matchesCategories(t, [])));
  ok('H7 a task with one of two picks is hidden', !H.matchesCategories(tasks[1], [OPEN, BAKERY]));
  ok('H8 a task with both picks is shown', H.matchesCategories(tasks[0], [OPEN, BAKERY]));
  ok('H9 legacy single category still matches', H.matchesCategories(tasks[4], [OPEN]) && !H.matchesCategories(tasks[4], [OPEN, BAKERY]));
  ok('H10 untagged task hidden once a chip is picked', !H.matchesCategories(tasks[5], [OPEN]));
  const same = [OPEN, BAKERY];
  ok('H11 prune keeps the same array when all picks still exist', H.pruneCategories(same, [OPEN, BAKERY, MEAT]) === same);
  eq('H12 prune drops a pick that left the board', H.pruneCategories([OPEN, 'Gone'], [OPEN, BAKERY]), [OPEN]);

  // F: a tap sequence, as on the phone
  let sel = [];
  eq('F1 nothing picked: everything', shown(sel), ['both', 'open', 'bake', 'three', 'legacy', 'none']);
  sel = H.toggleCategory(sel, OPEN);
  eq('F2 one chip (Opening Procedures)', shown(sel), ['both', 'open', 'three', 'legacy']);
  sel = H.toggleCategory(sel, BAKERY);
  eq('F3 two chips = AND: only tasks with BOTH', shown(sel), ['both', 'three']);
  ok('F4 Opening-only and Bakery-only tasks are hidden', !shown(sel).includes('open') && !shown(sel).includes('bake'));
  sel = H.toggleCategory(sel, MEAT);
  eq('F5 three chips narrow further', shown(sel), ['three']);
  sel = H.toggleCategory(sel, MEAT);
  eq('F6 unpick the third chip widens again', shown(sel), ['both', 'three']);
  sel = H.toggleCategory(sel, OPEN);
  eq('F7 unpick Opening leaves Bakery only', [sel, shown(sel)], [[BAKERY], ['both', 'bake', 'three']]);
  sel = H.toggleCategory(H.toggleCategory(sel, OPEN), 'all');
  eq('F8 All clears: everything again', [sel, shown(sel)], [[], ['both', 'open', 'bake', 'three', 'legacy', 'none']]);
}

// R: TaskFilterBar marks every picked chip
try {
  const { TaskFilterBar } = await import('../../src/components/TaskFilterBar.tsx');
  const base = {
    searchQuery: '', onSearchChange() {}, onCategoryChange() {},
    categories: [OPEN, BAKERY, MEAT], categoryCounts: { [OPEN]: 4, [BAKERY]: 3, [MEAT]: 1 },
    viewMode: 'cards', onViewModeChange() {}, showOnlyTodaySchedule: false, onToggleScheduleFilter() {},
    onOpenTaskModal() {}, isAdmin: false,
  };
  const render = (selectedCategories) => renderToStaticMarkup(React.createElement(TaskFilterBar, { ...base, selectedCategories }));
  const pressed = (html) => [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g)]
    .map((m) => (m[0].match(/<span class="max-w-\[140px\] truncate">([^<]*)<\/span>/) || [null, 'All'])[1].replace(/&amp;/g, '&'));
  eq('R1 nothing picked: only All is marked', pressed(render([])), ['All']);
  eq('R2 one picked: that chip is marked, All is not', pressed(render([OPEN])), [OPEN]);
  eq('R3 two picked: both chips are marked', pressed(render([OPEN, BAKERY])), [OPEN, BAKERY]);
  const html2 = render([OPEN, BAKERY]);
  ok('R4 picked chips keep the chip look (cat-chip ring)', (html2.match(/cat-chip cat-ring cat-text ring-2/g) || []).length === 2);
} catch (e) {
  ok('R0 TaskFilterBar renders with selectedCategories', false, String(e && e.message || e).split('\n')[0]);
}

// S: source checks
const app = read('src/App.tsx');
ok('S1 App keeps the picks as an array', /useState<string\[\]>\(\[\]\)/.test(app) && /selectedCategories/.test(app));
ok('S2 App filters with matchesCategories (AND)', /matchesCategories\(task, selectedCategories\)/.test(app));
ok('S3 no single-category state left in App', !/\bselectedCategory\b/.test(app));
const kiosk = read('src/components/KioskTaskPanel.tsx');
ok('S4 kiosk chips are marked from the same picks', /selectedCategories\.includes\(c\)/.test(kiosk) && /aria-pressed=\{selectedCategories\.length === 0\}/.test(kiosk));
ok('S5 kiosk "Show all" clears the picks', /if \(selectedCategories\.length > 0\) onCategoryChange\('all'\)/.test(kiosk));
ok('S6 no single-category prop left on the kiosk', !/\bselectedCategory\b/.test(kiosk));
ok('S7 a chip tap toggles (no "active ? all : c" left)', !/onCategoryChange\(active \? 'all' : c\)/.test(kiosk + read('src/components/TaskFilterBar.tsx')));

console.log(`MULTIFILTER client: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
