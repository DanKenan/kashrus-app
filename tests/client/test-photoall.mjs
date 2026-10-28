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
ok('kiosk: 64 px targets, larger text', /<button type="button" data-answer-photo-add="true"[^>]*class="[^"]*\bmin-h-16\b[^"]*\bmin-w-16\b/.test(kiosk) && kiosk.includes('class="mt-2 flex flex-col gap-2 text-base"'), kiosk.slice(0, 400));
ok('phone: 44 px targets', withPhoto.includes('min-h-11') && withPhoto.includes('w-11 h-11'));
ok('the photo row never asks for a photo before answering (optional)', !/required/.test(html(h(TaskAnswerPhoto, { task: mk('checkbox'), canAttach: true }))));


// RV1 review fixes
const addOut = html(h(TaskAnswerPhoto, { task: mk('yes_no'), canAttach: true }));
ok('RV1 keyboard: "Add photo" is a real button (reachable with Tab), the file input is out of the tab order', /<button type="button" data-answer-photo-add="true"/.test(addOut) && /<input[^>]*type="file"[^>]*tabindex="-1"|<input[^>]*tabindex="-1"[^>]*type="file"/i.test(addOut) && !/<label[^>]*data-answer-photo-add/.test(addOut), addOut.slice(0, 500));
const { reconcileAnswerPhotoOverride = null } = mod;
ok('RV1 override: helper exported', typeof reconcileAnswerPhotoOverride === 'function');
if (typeof reconcileAnswerPhotoOverride === 'function') {
  const P = { id: 'aph-P', byName: 'Dana Demo', byEmail: 'dana@demo.test', at: '2026-10-27T23:40:00.000Z' };
  // null -> save P (server answer kept while the task still shows null)
  let ov = { basis: null, ref: P };
  ok('RV1 override: the save shows at once while the task has not caught up', reconcileAnswerPhotoOverride(ov, null)?.ref?.id === 'aph-P');
  // live update arrives: task now P -> the local answer is dropped
  ov = reconcileAnswerPhotoOverride(ov, 'aph-P');
  ok('RV1 override: dropped once the task shows the photo', ov === null);
  // daily reset / someone else removes it: task back to null -> nothing comes back
  ok('RV1 override: null -> saved -> null does not bring the old photo back', reconcileAnswerPhotoOverride(ov, null) === null);
  ok('RV1 override: a remove answered while the task moved on is ignored', reconcileAnswerPhotoOverride({ basis: 'aph-P', ref: null }, 'aph-Q') === null);
}
ok('RV1 component drops a stale override in an effect and only sets one while the task is unchanged', /if \(override && !effective\) setOverride\(null\)/.test(src) && /if \(liveRef\.current === basis\) setOverride/.test(src));
ok('RV1 save retries reuse ONE operation id (new photo or caption = new id)', /operationId: opId/.test(src) && /setCaption\(e\.target\.value\); setOpId\(newActionId\(\)\)/.test(src));
ok('RV1 full size is modal: focus to Close, Escape closes, Tab stays, focus returns', /closeRef\.current\?\.focus\(\)/.test(src) && /e\.key === 'Escape'/.test(src) && /e\.key === 'Tab'/.test(src) && /thumbRef\.current\?\.focus\(\)/.test(src));
ok('RV1 kiosk Close button is a 64 px target', /ref=\{closeRef\}[\s\S]{0,200}k \? 'min-h-16 text-base'/.test(src));


// RV3 review fixes
ok('RV3 a retried save keeps the basis of its first attempt', /opBasisRef\.current\?\.opId !== opId\) opBasisRef\.current = \{ opId, basis: live\?\.id \?\? null \}/.test(src) && /const basis = opBasisRef\.current\.basis;/.test(src));
if (typeof reconcileAnswerPhotoOverride === 'function') {
  // save A (basis null) lost; B replaces it; the retry answers A with the ORIGINAL basis null -> not shown over B
  ok('RV3 a retry answering a superseded photo never shows over the newer one', reconcileAnswerPhotoOverride({ basis: null, ref: { id: 'aph-A' } }, 'aph-B') === null);
}
ok('RV3 the full-size view is tied to one photo id and closes when it goes', /const full = !!fullId && !!shown && shown\.id === fullId && !!src;/.test(src) && /if \(!full\) \{ if \(fullId\) setFullId\(null\); return; \}/.test(src) && /\}, \[full, fullId\]\);/.test(src));

// On the real board views
const tasks = [...types.map((t) => mk(t)), mk('check_in'), mk('yes_no', { id: 't-yes-photo', title: 'Yes with photo', answerPhoto: photo })];
const noop = () => {};
for (const [name, View] of [['card view (phone)', TaskCardView], ['table view (desk)', TaskTableView]]) {
  const out = html(h(View, { tasks, currentUser: filler, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop }));
  ok(`${name}: renders`, out.includes('Check yes_no') && !out.startsWith('RENDER ERROR'), out.slice(0, 200));
  ok(`${name}: the camera sits beside the answer on each answer-type task (5), none for check_in`, count(out, 'data-answer-photo-row="true"') === 5 && count(out, 'data-answer-photo="true"') === 1, `rows=${count(out, 'data-answer-photo-row="true"')} photo=${count(out, 'data-answer-photo="true"')}`);
  const seg = out.split('data-answer-photo-row="true"').find((x) => x.includes(`${name.startsWith('card') ? 'mobile-task-' : 'task-'}no-t-yes_no"`)) || '';
  ok(`${name}: on the yes/no task the icon-only camera follows Yes/No in the same row`, /-yes-t-yes_no"[\s\S]*-no-t-yes_no"[\s\S]*<button type="button" data-answer-photo-add="true" aria-label="Add photo"[^>]*><svg[\s\S]*?<\/svg><\/button>/.test(seg) && !/data-answer-photo-row|data-answer-photo="true"/.test(seg.split('data-answer-photo-add')[0]), seg.slice(0, 300));
  ok(`${name}: "Add photo" on the 4 types without a photo, thumbnail on the one with`, count(out, 'data-answer-photo-add') === 5 && count(out, 'data-answer-photo-thumb') === 1);
  ok(`${name}: the answer controls are still there`, /Yes \(Verified\)/.test(out));
  const ro = html(h(View, { tasks, currentUser: viewer, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop }));
  ok(`${name}: read-only viewer sees only the saved thumbnail`, count(ro, 'data-answer-photo-thumb') === 1 && count(ro, 'data-answer-photo-add') === 0 && !ro.includes('Remove the photo'));
}

// Don (Oct 27, 10:15 PM): "just the camera logo without the text" — like the Log check camera
const iconOnly = (o) => /<button type="button" data-answer-photo-add="true" aria-label="(?:Add|Change) photo" title="[^"]+"[^>]*><svg[^>]*>[\s\S]*?<\/svg><\/button>/.test(o);
for (const t of types) {
  const o = html(h(TaskAnswerPhoto, { task: mk(t), canAttach: true }, h('i', null, 'ANSWER')));
  ok(`${t}: the camera is icon only (no "Add photo" text), named "Add photo" for screen readers`, iconOnly(o) && !/>\s*Add photo\s*</.test(o) && /aria-label="Add photo"/.test(o), o.slice(0, 500));
  ok(`${t}: the camera sits beside the answer, in the same row`, /^<div data-answer-photo-row="true" class="flex gap-2"><div class="min-w-0 flex-1 flex flex-col justify-center"><i>ANSWER<\/i><\/div><button type="button" data-answer-photo-add="true"/.test(o), o.slice(0, 300));
}
const logCheckLook = 'border transition cursor-pointer tactile-1 bg-sunken border-line text-ink-soft hover:bg-line/30';
ok('the camera has the Log check camera look (44 px, rounded, sunken, line border)', addOut.includes(logCheckLook) && /data-answer-photo-add="true"[^>]*class="[^"]*\bmin-h-11 px-3 rounded-xl\b/.test(addOut) && rd('src/components/TaskCardView.tsx').includes('px-3 flex items-center justify-center rounded-xl text-xs font-bold border transition cursor-pointer tactile-1 bg-sunken border-line text-ink-soft hover:bg-line/30'), addOut.slice(0, 500));
ok('saved photo: "Change photo" is the same icon-only camera', iconOnly(withPhoto) && /aria-label="Change photo"/.test(withPhoto) && !/>\s*Change photo\s*</.test(withPhoto));
ok('kiosk: icon only too, a 64 px square', iconOnly(kiosk) && !/>\s*Add photo\s*</.test(kiosk));
const besideWithPhoto = html(h(TaskAnswerPhoto, { task: mk('yes_no', { answerPhoto: photo }), canAttach: true }, h('i', null, 'ANSWER')));
ok('saved photo: the thumbnail line ("Photo by X · time", caption) stays under the answer row', /^<div data-answer-photo-row="true"[\s\S]*aria-label="Change photo"[\s\S]*<\/div><div data-answer-photo="true"[\s\S]*data-answer-photo-thumb[\s\S]*Seal on the walk-in[\s\S]*Photo by <span class="font-semibold text-ink">Dana Demo<\/span>/.test(besideWithPhoto) && count(besideWithPhoto, 'data-answer-photo-add') === 1, besideWithPhoto.slice(0, 600));
ok('read-only viewer, no photo: only the answer itself', html(h(TaskAnswerPhoto, { task: mk('yes_no'), canAttach: false }, h('i', null, 'ANSWER'))) === '<i>ANSWER</i>');
const deskOut = html(h(TaskAnswerPhoto, { task: mk('yes_no'), canAttach: true, size: 'desk' }, h('i', null, 'ANSWER')));
ok('desk table: a compact 32 px camera right after the answer (not pushed to the far edge)', /^<div data-answer-photo-row="true" class="flex items-start gap-3"><div class="min-w-0"><i>ANSWER<\/i><\/div><button type="button" data-answer-photo-add="true"[^>]*class="[^"]*\bw-8 h-8 rounded-lg\b/.test(deskOut) && iconOnly(deskOut), deskOut.slice(0, 400));
ok('desk table view uses the compact camera', /<TaskAnswerPhoto task=\{task\} canAttach=\{canFill\} size="desk">/.test(rd('src/components/TaskTableView.tsx')));
ok('check_in: only its own controls (no camera row)', html(h(TaskAnswerPhoto, { task: mk('check_in'), canAttach: true }, h('i', null, 'ANSWER'))) === '<i>ANSWER</i>');

const kp = rd('src/components/KioskTaskPanel.tsx');
ok('kiosk panel shows the photo row (kiosk size) for the answer types', /<TaskAnswerPhoto task=\{task\} canAttach=\{canFill\} size="kiosk" \/>/.test(kp));

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
