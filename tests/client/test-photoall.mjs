// PHOTOALL (Don, Oct 27): every answer-type check (toggle, yes/no, status, checkbox) can take ONE optional photo.
// Fails on main (no TaskAnswerPhoto, no add-photo control on those types).
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + String(d).slice(0, 400) : '')); } };
const rd = (f) => { try { return fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8'); } catch { return ''; } }; // '' on main: the checks fail, not crash
const h = React.createElement;
const html = (el) => { try { return renderToStaticMarkup(el); } catch (e) { return 'RENDER ERROR ' + e; } };
let mod = {};
try { mod = await import('../../src/components/TaskAnswerPhoto.tsx'); } catch (e) { ok('TaskAnswerPhoto module exists', false, e.message); }
const { TaskAnswerPhoto = () => null, takesAnswerPhoto = () => false, ANSWER_PHOTO_MAX_CHARS = 0, ANSWER_PHOTO_TYPES = [] } = mod;

const filler = { id: 'u1', email: 'dana@demo.test', name: 'Dana Demo', role: 'mashgiach', venueId: 'v1' };
const viewer = { id: 'u2', email: 'olive@demo.test', name: 'Olive Owner', role: 'owner', venueId: 'v1' }; // no fill permission
const base = { venueId: 'v1', category: 'Opening Procedures', categories: ['Opening Procedures'], assignedTo: ['all'], scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: '8:00 AM', currentStatus: 'pending', isCompleted: false, notes: '', checkIns: [], description: '' };
const types = ['toggle', 'yes_no', 'status_select', 'checkbox'];
const photo = { id: 'aph-1', byName: 'Dana Demo', byEmail: 'dana@demo.test', at: '2026-10-27T23:40:00.000Z', caption: 'Seal on the walk-in' };
const mk = (inputType, extra = {}) => ({ ...base, id: `t-${inputType}`, title: `Check ${inputType}`, inputType, ...extra });
const count = (s, needle) => s.split(needle).length - 1;

// The rule itself
ok('the 4 answer types take a photo; check_in does not', types.every((t) => takesAnswerPhoto({ inputType: t })) && !takesAnswerPhoto({ inputType: 'check_in' }) && ANSWER_PHOTO_TYPES.length === 4);
const server = rd('server.ts');
const serverCap = Number((server.match(/const ANSWER_PHOTO_MAX_CHARS = ([\d_]+);/) || [])[1]?.replace(/_/g, ''));
ok('client cap = server cap (400 000 base64 chars)', ANSWER_PHOTO_MAX_CHARS === 400000 && serverCap === 400000, `${ANSWER_PHOTO_MAX_CHARS} vs ${serverCap}`);
const src = rd('src/components/TaskAnswerPhoto.tsx');
ok('same compression as the check-in photo first (800 px, JPEG 0.7)', /STEPS[^=]*=\s*\[\[800, 0\.7\]/.test(src) && /toDataURL\('image\/jpeg', q\)/.test(src));
ok('saves with POST, removes only its own photo id, reads the bytes on demand', /method: 'POST'/.test(src) && /answer-photo\?photoId=\$\{encodeURIComponent\(shown\.id\)\}`,\s*\{ method: 'DELETE' \}/.test(src) && /apiFetch\(`\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/answer-photo\?photoId=/.test(src));
ok('camera or gallery (image/*, no forced capture)', /accept="image\/\*"/.test(src) && !/capture=/.test(src));
ok('no raw palette colours in the new component', !/\b(?:bg|text|border|from|to)-(?:white|black|red|green|blue|gray|slate|emerald|rose|amber)\b/.test(src));
ok('spacing on the 4 px grid (no half-steps)', !/\b(?:p|px|py|pt|pb|m|mt|mb|gap)-\d\.5\b/.test(src));
ok('full-size view is a portal over the page (not window.open)', /createPortal\(/.test(src) && !/window\.open/.test(src));

// The component alone
for (const t of types) {
  const out = html(h(TaskAnswerPhoto, { task: mk(t), canAttach: true }));
  ok(`${t}: "Add photo" for someone who may answer`, out.includes('data-answer-photo-add') && out.includes('Add photo') && /type="file"/.test(out), out.slice(0, 300));
}
ok('check_in: no answer-photo control (its own photo flow stays)', html(h(TaskAnswerPhoto, { task: mk('check_in'), canAttach: true })) === '');
ok('read-only viewer, no photo: nothing at all', html(h(TaskAnswerPhoto, { task: mk('yes_no'), canAttach: false })) === '');
const withPhoto = html(h(TaskAnswerPhoto, { task: mk('yes_no', { answerPhoto: photo }), canAttach: true }));
ok('saved photo: a thumbnail that opens full size', withPhoto.includes('data-answer-photo-thumb') && withPhoto.includes('aria-label="Open the photo full size"'), withPhoto.slice(0, 400));
ok('saved photo: who and when, and the caption', withPhoto.includes('Photo by <span class="font-semibold text-ink">Dana Demo</span>') && withPhoto.includes('Seal on the walk-in'), withPhoto);
ok('saved photo: the person may remove or change it', withPhoto.includes('aria-label="Remove the photo"') && withPhoto.includes('Change photo'));
const roPhoto = html(h(TaskAnswerPhoto, { task: mk('yes_no', { answerPhoto: photo }), canAttach: false }));
ok('read-only viewer sees the photo, cannot add or remove', roPhoto.includes('data-answer-photo-thumb') && !roPhoto.includes('Remove the photo') && !roPhoto.includes('data-answer-photo-add'));
const kiosk = html(h(TaskAnswerPhoto, { task: mk('toggle'), canAttach: true, size: 'kiosk' }));
ok('kiosk: 64 px targets, larger text', /<label data-answer-photo-add="true" class="[^"]*\bmin-h-16\b[^"]*\btext-base\b/.test(kiosk), kiosk.slice(0, 400));
ok('phone: 44 px targets', withPhoto.includes('min-h-11') && withPhoto.includes('w-11 h-11'));
ok('the photo row never asks for a photo before answering (optional)', !/required/.test(html(h(TaskAnswerPhoto, { task: mk('checkbox'), canAttach: true }))));

// On the real board views
const tasks = [...types.map((t) => mk(t)), mk('check_in'), mk('yes_no', { id: 't-yes-photo', title: 'Yes with photo', answerPhoto: photo })];
const noop = () => {};
for (const [name, View] of [['card view (phone)', TaskCardView], ['table view (desk)', TaskTableView]]) {
  const out = html(h(View, { tasks, currentUser: filler, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop }));
  ok(`${name}: renders`, out.includes('Check yes_no') && !out.startsWith('RENDER ERROR'), out.slice(0, 200));
  ok(`${name}: one photo row per answer-type task (5), none for check_in`, count(out, 'data-answer-photo="true"') === 5, `rows=${count(out, 'data-answer-photo="true"')}`);
  ok(`${name}: "Add photo" on the 4 types without a photo, thumbnail on the one with`, count(out, 'data-answer-photo-add') === 5 && count(out, 'data-answer-photo-thumb') === 1);
  ok(`${name}: the answer controls are still there`, /Yes \(Verified\)/.test(out));
  const ro = html(h(View, { tasks, currentUser: viewer, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop }));
  ok(`${name}: read-only viewer sees only the saved thumbnail`, count(ro, 'data-answer-photo-thumb') === 1 && count(ro, 'data-answer-photo-add') === 0 && !ro.includes('Remove the photo'));
}
const kp = rd('src/components/KioskTaskPanel.tsx');
ok('kiosk panel shows the photo row (kiosk size) for the answer types', /<TaskAnswerPhoto task=\{task\} canAttach=\{canFill\} size="kiosk" \/>/.test(kp));

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
