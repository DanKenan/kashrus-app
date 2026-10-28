// CHECKINPHOTO (Don, Oct 28 "Sure do it"): check-in photos ("Log check with photo evidence") live in the
// photo store, not inline in the shared document. The check-in keeps only a photoId; the bytes come on demand.
// Old check-ins with an inline photo still show exactly as before. Same look: camera, count badge, viewer.
// Fails on main (no CheckInPhoto component; views render c.photoData inline only).
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + String(d).slice(0, 400) : '')); } };
const rd = (f) => { try { return fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8'); } catch { return ''; } };
const h = React.createElement;
const html = (el) => { try { return renderToStaticMarkup(el); } catch (e) { return 'RENDER ERROR ' + e; } };
let mod = {};
try { mod = await import('../../src/components/CheckInPhoto.tsx'); } catch (e) { ok('CheckInPhoto module exists', false, e.message); }
const {
  CheckInPhoto = () => null, rememberCheckInPhoto = () => {}, checkInPhotoCached = () => false, afterCheckInWithPhoto = () => 'x',
  checkInPhotoTooLarge = () => false, checkInPhotoUrl = () => '', CHECKIN_PHOTO_NOT_SAVED = '', CHECKIN_PHOTO_TOO_LARGE = '',
} = mod;

const OLD = 'data:image/jpeg;base64,/9j/OLDPHOTO';
const NEW = 'data:image/jpeg;base64,/9j/NEWPHOTO';
const cls = 'mt-1.5 w-full rounded-lg border border-line object-cover max-h-40 cursor-pointer';
const oldCi = { id: 'checkin-old', byName: 'Dana Demo', byEmail: 'dana@demo.test', at: '2026-10-28T08:00:00.000Z', photoData: OLD, photoCaption: 'Walk-in seal' };
const newCi = { id: 'checkin-new', byName: 'Dana Demo', byEmail: 'dana@demo.test', at: '2026-10-28T09:00:00.000Z', photoId: 'cph-1234abcd-0000' };
const plain = { id: 'checkin-plain', byName: 'Ben Demo', byEmail: 'ben@demo.test', at: '2026-10-28T10:00:00.000Z' };

// The component alone
const o = html(h(CheckInPhoto, { taskId: 't1', checkIn: oldCi, className: cls }));
ok('old check-in: the inline photo shows straight away, same <img> classes and caption', o.includes(`src="${OLD}"`) && o.includes(`class="${cls}"`) && o.includes('alt="Walk-in seal"') && o.includes('data-checkin-photo'), o);
const n0 = html(h(CheckInPhoto, { taskId: 't1', checkIn: newCi, className: cls }));
ok('new check-in, not loaded yet: a quiet placeholder, no <img> without bytes', n0.includes('data-checkin-photo-loading') && !n0.includes('<img'), n0);
rememberCheckInPhoto('cph-1234abcd-0000', NEW);
const n1 = html(h(CheckInPhoto, { taskId: 't1', checkIn: newCi, className: cls }));
ok('new check-in, bytes known: the same <img> as before, default alt', n1.includes(`src="${NEW}"`) && n1.includes(`class="${cls}"`) && n1.includes('alt="Check-in photo"'), n1);
ok('no photo: nothing at all', html(h(CheckInPhoto, { taskId: 't1', checkIn: plain, className: cls })) === '');
ok('bytes are read from the check-in photo route', checkInPhotoUrl('t 1', 'checkin-new') === '/api/tasks/t%201/check-in/checkin-new/photo');

// Size cap: the server's (400 000 base64 chars), checked before anything is sent
ok('photo cap: 400 000 ok, 400 001 too large, none = ok', !checkInPhotoTooLarge('a'.repeat(400000)) && checkInPhotoTooLarge('a'.repeat(400001)) && !checkInPhotoTooLarge(undefined));
ok('too-large message is plain', CHECKIN_PHOTO_TOO_LARGE === 'That photo is too large. Try another one.');

// After the save
const before = new Set(['checkin-a']);
const stored = { checkIns: [{ id: 'checkin-a', byEmail: 'x@demo.test' }, { id: 'checkin-b', byEmail: 'Dana@Demo.test', photoId: 'cph-feedface-0001' }] };
ok('stored photo: no message, and the bytes we sent are kept for its id (no reload)', afterCheckInWithPhoto(before, stored, 'dana@demo.test', NEW) === null && checkInPhotoCached('cph-feedface-0001'));
const lost = { checkIns: [{ id: 'checkin-a' }, { id: 'checkin-c', byEmail: 'dana@demo.test' }] };
ok('check logged without its photo: the person is told (check kept)', afterCheckInWithPhoto(before, lost, 'dana@demo.test', NEW) === CHECKIN_PHOTO_NOT_SAVED && CHECKIN_PHOTO_NOT_SAVED === 'Check logged, but the photo could not be saved.');
const inline = { checkIns: [{ id: 'checkin-d', byEmail: 'dana@demo.test', photoData: NEW }] };
ok('an older server that kept it inline: no message', afterCheckInWithPhoto(before, inline, 'dana@demo.test', NEW) === null);
const two = { checkIns: [{ id: 'checkin-e', byEmail: 'dana@demo.test', photoId: 'cph-aaaaaaaa-0001' }, { id: 'checkin-f', byEmail: 'dana@demo.test', photoId: 'cph-bbbbbbbb-0002' }] };
ok('two new check-ins (ambiguous): nothing guessed, nothing cached', afterCheckInWithPhoto(before, two, 'dana@demo.test', NEW) === null && !checkInPhotoCached('cph-aaaaaaaa-0001') && !checkInPhotoCached('cph-bbbbbbbb-0002'));
const others = { checkIns: [{ id: 'checkin-g', byEmail: 'ben@demo.test' }] };
ok("someone else's new check-in is never read as mine", afterCheckInWithPhoto(before, others, 'dana@demo.test', NEW) === null);

// Source: the views and App use it; capture still 800 px JPEG 0.7 first
const card = rd('src/components/TaskCardView.tsx');
const kiosk = rd('src/components/KioskTaskPanel.tsx');
const app = rd('src/App.tsx');
const types = rd('src/types.ts');
ok('phone card: CheckInPhoto with the same classes; no inline-only <img src={c.photoData}> left', /<CheckInPhoto\s+taskId=\{task\.id\}\s+checkIn=\{c\}\s+className="mt-1\.5 w-full rounded-lg border border-line object-cover max-h-40 cursor-pointer"/.test(card) && !/src=\{c\.photoData\}/.test(card));
ok('kiosk: CheckInPhoto with the same classes; no inline-only <img> left', /<CheckInPhoto\s+taskId=\{task\.id\}\s+checkIn=\{c\}\s+className="mt-2 w-full max-w-md rounded-lg border border-line object-cover max-h-60 cursor-pointer"/.test(kiosk) && !/src=\{c\.photoData\}/.test(kiosk));
ok('capture (phone + kiosk) uses the shared compression (800 px JPEG 0.7 first, under the cap)', /compressPhoto\(file\)\.then\(\(dataUrl\) => onCheckIn\(task\.id, dataUrl\)\)/.test(card) && /compressPhoto\(file\)\.then\(\(dataUrl\) => onCheckIn\(taskId, dataUrl\)\)/.test(kiosk));
ok('the camera button is unchanged ("Log check with photo evidence", camera or file, capture=environment)', /title="Log check with photo evidence"/.test(card) && /capture="environment"/.test(card));
ok('App: too-large photos are stopped before sending; after the save the photo is kept / the person is told', /if \(checkInPhotoTooLarge\(photoData\)\) \{\s*showToast\(CHECKIN_PHOTO_TOO_LARGE\);\s*return;/.test(app) && /afterCheckInWithPhoto\(beforeIds, result\.data, currentUser\.email, photoData\)/.test(app));
ok('App: a failed save still rolls back and shows the existing toast', /showToast\(result\.error \|\| 'Could not log the check\.'\)/.test(app));
ok('types: TaskCheckIn has photoId (and photoData for old ones)', /export interface TaskCheckIn \{[\s\S]*?photoData\?: string;[\s\S]*?photoId\?: string;[\s\S]*?\}/.test(types));
const src = rd('src/components/CheckInPhoto.tsx');
ok('no raw palette colours / no half-step spacing in the new component', src && !/\b(?:bg|text|border|from|to)-(?:white|black|red|green|blue|gray|slate|emerald|rose|amber)\b/.test(src) && !/\b(?:p|px|py|pt|pb|m|mt|mb|gap)-\d\.5\b/.test(src));
ok('tap-to-enlarge as before', /window\.open\(\)/.test(src) && /w\.document\.write\(`<img src="\$\{src\}" style="max-width:100%"\/>`\)/.test(src));

// On the real phone card: count badge counts old + new, both photos render the old way when known
const noop = () => {};
const filler = { id: 'u1', email: 'dana@demo.test', name: 'Dana Demo', role: 'mashgiach', venueId: 'v1' };
const task = { id: 't-ci', venueId: 'v1', title: 'Fridge temperature', description: '', category: 'Opening Procedures', categories: ['Opening Procedures'], inputType: 'check_in', assignedTo: ['all'], scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetTime: '8:00 AM', currentStatus: 'pending', isCompleted: false, notes: '', checkIns: [oldCi, newCi, plain] };
const out = html(h(TaskCardView, { tasks: [task], currentUser: filler, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onRemoveCheckIn: noop, onEditTask: noop, onDeleteTask: noop }));
ok('card renders with "Log check" and the camera', out.includes('Log check') && out.includes('Log check with photo evidence') && !out.startsWith('RENDER ERROR'), out.slice(0, 300));
ok('count badge = 3 (old, new, plain)', />3<\/span>/.test(out));
ok('card: old inline photo and new stored photo both show as <img> (2), never base64 for the plain one', (out.split('data-checkin-photo=').length - 1) === 2 && out.includes(`src="${OLD}"`) && out.includes(`src="${NEW}"`), `imgs=${out.split('data-checkin-photo=').length - 1}`);

// Server rules (pure helpers in src/server/checkin-photos.ts)
let sm = {};
try { sm = await import('../../src/server/checkin-photos.ts'); } catch (e) { ok('server module exists', false, e.message); }
const { classifyCheckInPhoto = () => '', checkInPhotoKeys = () => [], expireCheckInPhoto = (c) => c, checkInPhotoIdOf = () => null } = sm;
const RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
ok('server: no photo / ok / too large / not an image', classifyCheckInPhoto(undefined, 10, RE) === 'none' && classifyCheckInPhoto('', 10, RE) === 'none' && classifyCheckInPhoto('data:image/png;base64,AAAA', 30, RE) === 'ok' && classifyCheckInPhoto('data:image/png;base64,AAAAAAAAAAAA', 20, RE) === 'MEDIA_TOO_LARGE' && classifyCheckInPhoto('data:image/svg+xml;base64,AAAA', 99, RE) === 'BAD_MEDIA' && classifyCheckInPhoto(7, 99, RE) === 'BAD_MEDIA');
ok('server: the sweep keeps exactly the referenced check-in photos (old inline ones have no key)', JSON.stringify(checkInPhotoKeys({ id: 't1', checkIns: [{ id: 'a', photoId: 'cph-12345678-aaaa' }, { id: 'b', photoData: OLD }, { id: 'c' }, { id: 'd', photoId: '../x' }] })) === JSON.stringify(['t1__cph-12345678-aaaa']) && checkInPhotoKeys({ id: 't2' }).length === 0);
ok('server: only cph- ids are photo references', checkInPhotoIdOf({ photoId: 'cph-12345678-aaaa' }) === 'cph-12345678-aaaa' && checkInPhotoIdOf({ photoId: 'aph-12345678' }) === null && checkInPhotoIdOf(null) === null);
const oldOne = { id: 'x', at: '2026-01-01T00:00:00.000Z', photoId: 'cph-12345678-aaaa', photoData: OLD, byName: 'A' };
const exp = expireCheckInPhoto(oldOne, '2026-02-01T00:00:00.000Z');
ok('server: 30-day expiry drops the photo (inline or reference), keeps the check-in', exp !== oldOne && !('photoId' in exp) && !('photoData' in exp) && exp.byName === 'A' && exp.id === 'x');
const fresh = { id: 'y', at: '2026-03-01T00:00:00.000Z', photoId: 'cph-12345678-aaaa' };
ok('server: a recent photo is untouched (same object)', expireCheckInPhoto(fresh, '2026-02-01T00:00:00.000Z') === fresh && expireCheckInPhoto({ id: 'z', at: '2026-01-01' }, '2026-02-01') .id === 'z');

// RV2: a passing read problem never hides the photo for good — retry while it is on screen.
{
  const { readCheckInPhoto, createCheckInPhotoLoader, CHECKIN_PHOTO_RETRY_MS } = mod;
  ok('RV2: retry helpers exist', typeof readCheckInPhoto === 'function' && typeof createCheckInPhotoLoader === 'function' && Array.isArray(CHECKIN_PHOTO_RETRY_MS));
  if (typeof readCheckInPhoto === 'function' && typeof createCheckInPhotoLoader === 'function') {
    const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const kinds = [];
    for (const f of [
      async () => { throw new TypeError('Failed to fetch'); },
      async () => resp(503, { error: 'x' }), async () => resp(429, {}), async () => resp(401, {}),
      async () => resp(404, {}), async () => resp(403, {}), async () => resp(200, { photoData: NEW }), async () => resp(200, {}),
    ]) kinds.push((await readCheckInPhoto(f, '/u')).kind);
    ok('RV2: offline / 5xx / 429 / 401 → try again; 404 / 403 / no bytes → missing; bytes → ok', kinds.join(',') === 'retry,retry,retry,retry,missing,missing,ok,missing', kinds.join(','));

    // A mounted photo: the first read is rejected, the next ones succeed — the photo appears without a remount.
    const timers = []; const results = []; let calls = 0;
    const script = [{ kind: 'retry' }, { kind: 'retry' }, { kind: 'ok', data: NEW }];
    const L = createCheckInPhotoLoader({
      read: async () => script[Math.min(calls++, script.length - 1)],
      onResult: (r) => results.push(r.kind),
      setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (t) => { t.cleared = true; },
      delays: [2000, 5000],
    });
    await L.start();
    ok('RV2: a failed read keeps the placeholder and schedules another try (2 s)', results.join() === 'retry' && timers.length === 1 && timers[0].ms === 2000);
    await L.retryNow(); // back online: try at once, the pending timer is dropped
    ok('RV2: back online → tried at once, the pending wait cleared, the next wait backs off (5 s)', calls === 2 && timers[0].cleared && timers.length === 2 && timers[1].ms === 5000);
    timers[1].fn(); await new Promise((r) => setTimeout(r, 0));
    ok('RV2: the next try succeeds → the photo shows, no more tries', results.join() === 'retry,retry,ok' && timers.length === 2 && calls === 3);
    await L.retryNow();
    ok('RV2: once loaded, nothing reads again', calls === 3);

    const t2 = []; let c2 = 0; const r2 = [];
    const M = createCheckInPhotoLoader({ read: async () => { c2++; return { kind: 'missing' }; }, onResult: (r) => r2.push(r.kind), setTimer: (fn, ms) => { t2.push(ms); return {}; }, clearTimer: () => {} });
    await M.start(); await M.retryNow();
    ok('RV2: a confirmed-missing photo is not retried', c2 === 1 && t2.length === 0 && r2.join() === 'missing');

    const t3 = []; let c3 = 0;
    const S = createCheckInPhotoLoader({ read: async () => { c3++; return { kind: 'retry' }; }, onResult: () => {}, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; t3.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
    await S.start(); S.stop(); await S.retryNow();
    ok('RV2: off screen (unmounted) → the wait is cleared and nothing reads again', c3 === 1 && t3[0].cleared && t3[0].ms === CHECKIN_PHOTO_RETRY_MS[0]);
    const src = rd('src/components/CheckInPhoto.tsx');
    ok('RV2: the component retries when the device comes back online or the app is shown again', /addEventListener\('online'/.test(src) && /addEventListener\('visibilitychange'/.test(src) && /loader\.stop\(\)/.test(src));
  }
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
