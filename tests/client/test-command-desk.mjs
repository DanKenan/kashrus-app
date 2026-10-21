/**
 * D6 client test: Command Desk (Venues hub cards + History ledger).
 *
 * Server-renders VenuesDirectoryModal and HistoryLogModal with a messy set
 * and checks (P*) that every piece of information shown today is still in
 * the output, in the same order, and (D*) the D6 shape: one card per venue
 * with a progress ring, ledger rows with a Time / Person / What happened /
 * Notes header, rings in the day list, mixed-direction text marked dir="auto".
 * P* pass on main and on the PR; D* fail on main.
 *
 * Run: npx tsx tests/client/test-command-desk.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VenuesDirectoryModal } from '../../src/components/VenuesDirectoryModal.tsx';
import { HistoryLogModal } from '../../src/components/HistoryLogModal.tsx';
import { formatExactTime } from '../../src/lib/utils.ts';

let passed = 0;
let failures = 0;
const failed = [];
function ok(label, cond, info = '') {
  if (cond) passed++;
  else { failures++; failed.push(label); console.error(`FAIL ${label}${info ? ': ' + info : ''}`); }
}
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (html) => decode(html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (html, needle) => html.split(needle).length - 1;
function inOrder(text, items) {
  let at = -1;
  for (const it of items) { const i = text.indexOf(it, at + 1); if (i < 0 || i <= at) return `${it} @${i} after ${at}`; at = i; }
  return true;
}

// ---------------- Venues hub ----------------
const LONG = "The Grand Ballroom at Congregation Beth Israel's Community Center — Main Kitchen & Bakery";
const venues = [
  { id: 'v1', name: 'Crown Market', category: 'Supermarket', address: '2471 Albany Ave, West Hartford, CT 06117', certification: 'HKC Glatt — Meat & Pareve', createdAt: '', totalTasksToday: 5, completedTasksToday: 3, completionRate: 60, workerCount: 4 },
  { id: 'v2', name: LONG, category: 'Catering hall', address: '701 Farmington Ave, West Hartford, CT 06119, Lower Level Service Entrance B', certification: 'HKC Cholov Yisroel, Pas Yisroel, Bishul Yisroel — full-time mashgiach on site', createdAt: '', timeZone: 'America/Chicago', totalTasksToday: 2, completedTasksToday: 1, completionRate: 50, workerCount: 2 },
  { id: 'v3', name: 'מאפיית כתר — Keter Bakery', category: 'Bakery', certification: 'HKC Pareve · פרווה', createdAt: '', timeZone: 'Asia/Jerusalem', totalTasksToday: 1, completedTasksToday: 1, completionRate: 100, workerCount: 1 },
  { id: 'v4', name: 'New Venue (no tasks yet)', category: 'Restaurant', createdAt: '', totalTasksToday: 0, completedTasksToday: 0, completionRate: 0, workerCount: 0 },
];
const noop = () => {};
const renderVenues = (list, isAdmin, current = list[0]) => renderToStaticMarkup(React.createElement(VenuesDirectoryModal, {
  isOpen: true, onClose: noop, venues: list, currentVenue: current, onSelectVenue: noop, onOpenCreateVenue: noop,
  onDeleteVenue: isAdmin ? noop : undefined, isAdmin, agencyTimeZone: 'America/New_York', onVenueUpdated: noop,
}));
for (const isAdmin of [true, false]) {
  const who = isAdmin ? 'admin' : 'non-admin';
  const html = renderVenues(venues, isAdmin);
  const text = textOf(html);
  // P: page-level labels kept
  for (const s of ['Kosher Venues & Restaurants Platform Hub', `${venues.length} Facilities`, 'Switch between venues or establish a new certified kosher restaurant, bakery, or caterer platform.', 'All Establishments', 'Supermarket', 'Catering hall', 'Bakery', 'Restaurant', 'Close Hub',
    isAdmin ? 'All establishments are isolated with dedicated tasks, mashgichim, and history.' : 'You have access to this certified venue platform.']) ok(`P.venues.label ${who}: ${s}`, text.includes(s));
  ok(`P.venues.search ${who}`, decode(html).includes('placeholder="Search by venue, address, or hashgacha..."'));
  ok(`P.venues.newVenue ${who}`, text.includes('New Venue') === isAdmin || (!isAdmin && !/New Venue(?! \(no)/.test(text)));
  // P: every card's fields
  for (const v of venues) {
    for (const s of [v.name, v.category, v.address, v.certification].filter(Boolean)) ok(`P.venues.field ${who} ${v.id}: ${s.slice(0, 24)}`, text.includes(s));
    ok(`P.venues.done ${who} ${v.id}`, text.includes(`${v.completedTasksToday}/${v.totalTasksToday}`));
    ok(`P.venues.rate ${who} ${v.id}`, text.includes(`${v.completionRate}%`));
    ok(`P.venues.staff ${who} ${v.id}`, text.includes(`${v.workerCount} staff members`));
  }
  ok(`P.venues.shiftLabel ${who}`, count(text, 'Shift Completion') === venues.length, `${count(text, 'Shift Completion')}`);
  ok(`P.venues.current ${who}`, count(text, 'Active Platform') === 1 && count(text, 'Viewing Now') === 1);
  ok(`P.venues.switch ${who}`, count(text, 'Switch to Platform') === venues.length - 1);
  ok(`P.venues.delete ${who}`, count(html, 'title="Delete Venue Platform"') === (isAdmin ? venues.length : 0));
  ok(`P.venues.tzRow ${who}`, count(html, 'data-venue-timezone-row') === venues.length);
  // P: the existing order (no new sort)
  const ord = inOrder(text, venues.map((v) => v.name));
  ok(`P.venues.order ${who}`, ord === true, String(ord));
  // D: one card per venue, each with a progress ring, no truncation of name/address/cert
  ok(`D.venues.cards ${who}`, count(html, 'data-desk-venue-card') === venues.length, `${count(html, 'data-desk-venue-card')}`);
  ok(`D.venues.rings ${who}`, count(html, 'data-desk-ring') === venues.length, `${count(html, 'data-desk-ring')}`);
  ok(`D.venues.ringSvg ${who}`, count(html, '<svg') >= venues.length && /data-desk-ring[^>]*>[\s\S]*?<svg/.test(html));
  ok(`D.venues.noBar ${who}`, !/style="width:\s*\d+%"/.test(html), 'the thin bar is replaced by the ring');
  for (const v of venues) for (const s of [v.address, v.certification].filter(Boolean)) {
    ok(`D.venues.noTruncate ${who} ${v.id}: ${s.slice(0, 16)}`, !decode(html).includes(`class="truncate">${s}`));
  }
  ok(`D.venues.dirAuto ${who}`, count(html, 'dir="auto"') >= venues.length);
}
// P: reorder input -> same order out (proves no internal sort)
{
  const rev = [...venues].reverse();
  const ord = inOrder(textOf(renderVenues(rev, true, rev[0])), rev.map((v) => v.name));
  ok('P.venues.orderReversed', ord === true, String(ord));
  const empty = textOf(renderVenues([], true, undefined));
  ok('P.venues.empty', empty.includes('No venues match your search criteria.') && empty.includes('0 Facilities'));
}

// ---------------- History ledger ----------------
const E = (id, taskTitle, category, status, isCompleted, completedByName, completedByEmail, completedAt, notes) => ({ id, taskId: 't' + id, taskTitle, category, status, isCompleted, completedByName, completedByEmail, completedAt, notes });
const snap1 = { id: 's1', date: '2026-10-20', totalTasks: 5, completedTasks: 3, completionRate: 60, resetAt: '2026-10-21T04:01:00Z', resetBy: 'system', entries: [
  E('e1', 'Light the pilot lights (bishul Yisrael)', 'Bishul', 'completed', true, 'Moshe Friedman', 'm@x', '2026-10-20T10:42:00Z', ''),
  E('e2', 'Verify meat deliveries: every case sealed, simanim intact, invoice matches the hechsher list on file', 'Meat', 'Needs attention', false, 'Yossi Abramowitz-Goldberger', 'y@x', '2026-10-20T13:05:00Z', 'Two cases arrived with the plumba torn; set aside, called the supplier.\nWaiting for the rav.'),
  E('e3', 'בדיקת ירקות — חסה ופטרוזיליה', 'Produce', 'completed', true, 'יוסף חיים', null, '2026-10-20T15:30:00Z', 'נבדק, נקי. Checked under the light box.'),
  E('e4', 'Check produce for insects', 'Produce', 'pending', false, null, null, null, ''),
  E('e5', 'Old task that was deleted', 'Opening', 'removed', false, null, 'eli@test.local', '2026-10-20T18:02:00Z', ''),
] };
const snap2 = { id: 's2', date: '2026-10-19', totalTasks: 0, completedTasks: 0, completionRate: 0, resetAt: '', resetBy: 'admin@test.local', entries: [] };
const snap3 = { id: 's3', date: '2026-10-18', totalTasks: 2, completedTasks: 2, completionRate: 100, resetAt: '', resetBy: 'system', entries: [] };
const logs = [snap1, snap2, snap3];
const renderHistory = (h) => renderToStaticMarkup(React.createElement(HistoryLogModal, { isOpen: true, onClose: noop, historyLogs: h }));
{
  const html = renderHistory(logs);
  const text = textOf(html);
  for (const s of ['Daily Task History & Audit Log', 'Review retained past daily board records, mashgiach sign-offs, and compliance notes.', 'Archived Board Days', 'Close']) ok(`P.history.label: ${s}`, text.includes(s));
  for (const sn of logs) {
    ok(`P.history.day ${sn.date}`, text.includes(sn.date));
    ok(`P.history.dayRate ${sn.date}`, text.includes(`${sn.completionRate}%`));
    ok(`P.history.dayDone ${sn.date}`, text.includes(`${sn.completedTasks}/${sn.totalTasks} completed`));
  }
  ok('P.history.dayOrder', inOrder(text, logs.map((l) => l.date)) === true);
  ok('P.history.archive', text.includes(`Archive: ${snap1.date}`) && text.includes('(Reset by system)'));
  ok('P.history.search', decode(html).includes('placeholder="Search logs..."'));
  ok('P.history.export', text.includes('Export CSV') && html.includes('id="export-csv-btn"'));
  for (const e of snap1.entries) {
    ok(`P.history.title ${e.id}`, text.includes(e.taskTitle));
    ok(`P.history.cat ${e.id}`, text.includes(e.category));
    ok(`P.history.status ${e.id}`, text.toLowerCase().includes(e.status.toLowerCase()));
    if (e.completedByName || e.completedByEmail) {
      ok(`P.history.person ${e.id}`, text.includes(e.completedByName || e.completedByEmail));
      ok(`P.history.time ${e.id}`, text.includes(formatExactTime(e.completedAt)), formatExactTime(e.completedAt));
    }
    if (e.notes) for (const line of e.notes.split('\n')) ok(`P.history.notes ${e.id}`, text.includes(line));
  }
  ok('P.history.unassigned', count(text, 'Unassigned') === snap1.entries.filter((e) => !e.completedByName && !e.completedByEmail).length);
  ok('P.history.noNotes', count(text, 'No notes') === snap1.entries.filter((e) => !e.notes).length);
  ok('P.history.entryOrder', inOrder(text, snap1.entries.map((e) => e.taskTitle)) === true, 'array order kept (no sort by time)');
  // D: ledger shape
  ok('D.history.rows', count(html, 'data-ledger-row') === snap1.entries.length, `${count(html, 'data-ledger-row')}`);
  const hdr = inOrder(text, ['Time', 'Person', 'What happened', 'Notes']);
  ok('D.history.header', hdr === true && text.includes('What happened'), String(hdr));
  ok('D.history.dayRings', count(html, 'data-ledger-day-ring') === logs.length, `${count(html, 'data-ledger-day-ring')}`);
  ok('D.history.dirAuto', count(html, 'dir="auto"') >= snap1.entries.length);
  ok('D.history.noCards', !/data-ledger-row[^>]*class="[^"]*\brounded-xl\b/.test(html), 'rows are ruled lines, not cards');
}
{
  const empty = textOf(renderHistory([]));
  ok('P.history.emptyList', empty.includes('No archives recorded yet.') && empty.includes('Select a date archive to view details.'));
  const emptyDay = textOf(renderHistory([snap2]));
  ok('P.history.emptyDay', emptyDay.includes('No log entries found.') && emptyDay.includes(`Archive: ${snap2.date}`) && emptyDay.includes(`(Reset by ${snap2.resetBy})`));
}

console.log(`\n${passed} passed, ${failures} failed.`);
if (failures) { console.log('Failed:', failed.join(' | ')); process.exit(1); }
