// QA2 batch C2: #22 team title, #25 one overdue rule, #26 no fake "Defaults loaded", #29 undo sign-off confirm, #30 shift notes.
import fs from 'node:fs';
import { signoffUndoBy, signoffUndoTitle } from '../../src/lib/signoffUndo.ts';
import { formatNoteTime, shiftForHour } from '../../src/lib/dateText.ts';
import { isTaskOverdue, targetMinutesOf } from '../../src/lib/overdue.ts';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + d : '')); } };
const rd = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

// #29
const me = { email: 'mash@x.org', name: 'Moshe Mash' };
const signedByAdmin = { isCompleted: true, updatedByEmail: 'Rivka@x.org', updatedByName: 'Rivka Admin' };
ok('#29 undo someone else\'s sign-off -> confirm names them', signoffUndoBy(signedByAdmin, me, false) === 'Rivka Admin');
ok('#29 title', signoffUndoTitle('Rivka Admin') === "Undo Rivka Admin's sign-off?");
ok('#29 my own sign-off -> one tap', signoffUndoBy({ isCompleted: true, updatedByEmail: 'MASH@x.org', updatedByName: 'x' }, me, false) === null);
ok('#29 signing (not undoing) -> no confirm', signoffUndoBy(signedByAdmin, me, true) === null);
ok('#29 task not signed -> no confirm', signoffUndoBy({ ...signedByAdmin, isCompleted: false }, me, false) === null);
ok('#29 no signer recorded -> no confirm', signoffUndoBy({ isCompleted: true, updatedByEmail: null, updatedByName: null }, me, false) === null);
ok('#29 name only, not me -> confirm', signoffUndoBy({ isCompleted: true, updatedByEmail: null, updatedByName: 'Eli' }, me, false) === 'Eli');
const app = rd('src/App.tsx');
ok('#29 board views use the confirming handler, kiosk unchanged', (app.match(/onUpdateStatus=\{handleBoardUpdateStatus\}/g) || []).length === 2 && (app.match(/onUpdateStatus=\{handleUpdateStatus\}/g) || []).length === 1);
ok('#29 confirm wording', app.includes("confirmText: 'Undo sign-off'") && app.includes("cancelText: 'Keep it'"));
const card = rd('src/components/TaskCardView.tsx'), table = rd('src/components/TaskTableView.tsx');
ok('#29 no "Click" wording on the board', !/Click to cancel/.test(card + table) && card.includes('(tap to undo)'));

// #30
const now = new Date(2026, 9, 21, 23, 55);
ok('#30 today', formatNoteTime(new Date(2026, 9, 21, 23, 51, 49).toISOString(), now) === 'Today 11:51 PM', formatNoteTime(new Date(2026, 9, 21, 23, 51, 49).toISOString(), now));
ok('#30 yesterday', formatNoteTime(new Date(2026, 9, 20, 9, 5).toISOString(), now) === 'Yesterday 9:05 AM');
ok('#30 older, no seconds', formatNoteTime(new Date(2026, 9, 13, 14, 30).toISOString(), now) === 'Tue, Oct 13, 2:30 PM', formatNoteTime(new Date(2026, 9, 13, 14, 30).toISOString(), now));
ok('#30 other year shows the year', /2025/.test(formatNoteTime(new Date(2025, 0, 3, 8, 0).toISOString(), now)));
ok('#30 bad date -> empty', formatNoteTime('nope', now) === '');
ok('#30 shift from the clock', shiftForHour(23) === 'Evening' && shiftForHour(2) === 'Evening' && shiftForHour(7) === 'Morning' && shiftForHour(13) === 'Afternoon' && shiftForHour(17) === 'Evening');
const hn = rd('src/components/HandoffNotes.tsx'), us = rd('src/components/UpdatesSheet.tsx');
ok('#30 notes use them', hn.includes('shiftForHour(new Date().getHours())') && hn.includes('formatNoteTime(note.createdAt)') && !hn.includes("useState('Morning')") && !/toLocaleString\(\)/.test(hn));
ok('#30 handle has no box', /aria-label=\{expanded \? 'Shrink panel' : 'Expand panel'\}[\s\S]{0,120}className="pressable sm:hidden self-center w-11 h-11 flex items-center justify-center rounded-lg text-ink cursor-pointer shrink-0"/.test(us));

// #25
const t = (o) => ({ isCompleted: false, targetTime: '8:00 AM', ...o });
ok('#25 8:00 AM at 11:43 PM -> overdue', isTaskOverdue(t({}), 23 * 60 + 43));
ok('#25 done -> not overdue', !isTaskOverdue(t({ isCompleted: true }), 1400));
ok('#25 before the time -> not overdue', !isTaskOverdue(t({}), 7 * 60));
ok('#25 End of Day / no time / any time -> never', !isTaskOverdue(t({ targetTime: 'End of Day' }), 1439) && !isTaskOverdue(t({ targetTime: '' }), 1439) && !isTaskOverdue(t({ targetTime: 'Any time' }), 1439));
ok('#25 picker minutes win', isTaskOverdue(t({ targetTime: 'Morning rounds', targetTimeMinutes: 600 }), 601) && targetMinutesOf({ targetTime: '14:30' }) === 870 && targetMinutesOf({ targetTime: '12:15 AM' }) === 15);
ok('#25 no zone -> no chip', !isTaskOverdue(t({}), null));
ok('#25 both board views show the chip in the venue zone', [card, table].every((s) => s.includes('isTaskOverdue(task, nowMinutes)') && s.includes('minutesIn(timeZone)') && /\n\s+Overdue\n/.test(s)) && (app.match(/timeZone=\{currentVenueTimeZone\}/g) || []).length >= 2);

// #26
const ce = rd('src/components/CreateEventModal.tsx');
ok('#26 "Defaults loaded" only when there are some', /customTasks\.length > 0 \? \([\s\S]{0,140}Defaults loaded/.test(ce) && ce.includes('No default tasks yet — set them up') && ce.includes('No default tasks yet</span>'));

// #22
const tm = rd('src/components/TeamModal.tsx');
ok('#22 header says the whole team, no venue chip', tm.includes('All team · {users.length}') && !/\{users\.length\} members/.test(tm) && !/\{currentVenue\.name\}/.test(tm));
ok('#22 no-venue person flagged', tm.includes('No venue — tap to set'));

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
