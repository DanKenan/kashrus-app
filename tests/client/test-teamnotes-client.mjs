/**
 * TEAMNOTES CLIENT (Don, Oct 29 2026: "when you press @ you can choose someone to tag (like whatsapp
 * groups style) ... @All should also be an option. Everyone can see who saw it ... send it private, so only
 * the one being tagged, admin and coordinators can see it. Make sure that they get that it is visible to
 * admin and coordinators as well.")
 *  Q  mentionQueryAt: "@" at the start / after a space opens the picker; inside a word (a@b) it does not.
 *  A  applyMention inserts "@Name " and moves the caret; filterTeam ("All" + name/word prefix, Hebrew).
 *  P  privateNotice names the tagged people AND admins and coordinators (compose + posted wording).
 *  S  seenLabel; splitMentions bolds only real tags.
 *  R  HandoffNotes renders the private label on a private note, "Tagged you", tagged names, the composer
 *     with "type @ to tag" and the Private toggle (disabled with no tag); kiosk (readOnly) has no composer.
 *  F  flow (mini-render): "@" opens the picker (@All + team minus me), picking a person makes a chip, Private
 *     turns on, the banner names admins and coordinators, Send posts {mentions, private}; a venue change drops
 *     the team, the tags and Private at once (RV1 P2) and a send then carries no stale tag.
 *  K  (TEAMNOTES2) the kiosk notice: "You have a private message. Open Shutfey on your phone to read it."
 *     (count only; nothing for 0); shown only on the read-only kiosk list and the kiosk banner.
 *  V  (TEAMNOTES2, RV4 P3, RV1 P2) a send that finishes after a venue switch (even to an identical draft),
 *     more typing, an undone edit, or a Private/tag change never wipes the newer draft; an untouched sent
 *     draft is still cleared.
 * Run: npx tsx tests/client/test-teamnotes-client.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mentionQueryAt, applyMention, filterTeam, joinNames, privateNotice, seenLabel, splitMentions, removeTagText, kioskPrivateNotice } from '../../src/lib/mentions.ts';
import { HandoffNotes } from '../../src/components/HandoffNotes.tsx';
import { KioskPrivateNotice } from '../../src/components/KioskPrivateNotice.tsx';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { setSessionToken } from '../../src/lib/api.ts';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Q
ok('Q1 @ at start', eq(mentionQueryAt('@', 1), { start: 0, query: '' }));
ok('Q2 @ after space with query', eq(mentionQueryAt('hi @Mo', 6), { start: 3, query: 'Mo' }));
ok('Q3 email-like a@b is not a mention', mentionQueryAt('mail a@b', 8) === null);
ok('Q4 space after query closes', mentionQueryAt('hi @Mo ', 7) === null);
ok('Q5 caret before the @', mentionQueryAt('hi @Mo', 2) === null);
ok('Q6 Hebrew query', eq(mentionQueryAt('שלום @מש', 8), { start: 5, query: 'מש' }));
ok('Q7 newline before @', eq(mentionQueryAt('line\n@a', 7), { start: 5, query: 'a' }));
ok('Q8 non-string', mentionQueryAt(undefined, 0) === null);

// A
const a1 = applyMention('hi @Mo', 6, { start: 3 }, 'Moshe Cohen');
ok('A1 insert', a1.text === 'hi @Moshe Cohen ' && a1.caret === 16, JSON.stringify(a1));
const a2 = applyMention('@ the delivery', 1, { start: 0 }, 'All');
ok('A2 insert before existing text, single space', a2.text === '@All the delivery' && a2.caret === 5, JSON.stringify(a2));
const team = [{ id: '1', name: 'Moshe Cohen', role: 'mashgiach' }, { id: '2', name: 'Rivka Levi', role: 'owner' }, { id: '3', name: 'משה כהן', role: 'mashgiach' }, { id: '4', name: 'Alon Dar', role: 'coordinator' }];
const f1 = filterTeam(team, '');
ok('A3 empty query: All + everyone', f1.all && f1.people.length === 4);
const f2 = filterTeam(team, 'co');
ok('A4 word prefix (Cohen)', !f2.all && eq(f2.people.map((p) => p.id), ['1']));
const f3 = filterTeam(team, 'al');
ok('A5 "al" matches All and Alon', f3.all && eq(f3.people.map((p) => p.id), ['4']));
ok('A6 Hebrew prefix', eq(filterTeam(team, 'כה').people.map((p) => p.id), ['3']));
ok('A7 no match', !filterTeam(team, 'zz').all && filterTeam(team, 'zz').people.length === 0);

// P
ok('P1 compose one name', privateNotice(['Moshe'], 'compose') === 'Private: only Moshe, admins and coordinators will see this');
ok('P2 posted one name', privateNotice(['Moshe'], 'posted') === 'Private: only Moshe, admins and coordinators can see this');
ok('P3 two names', privateNotice(['Moshe', 'Rivka'], 'compose') === 'Private: only Moshe and Rivka, admins and coordinators will see this');
ok('P4 three names', joinNames(['Moshe', 'Rivka', 'Dov']) === 'Moshe, Rivka and Dov');
ok('P5 no names still says admins and coordinators', /admins and coordinators/.test(privateNotice([], 'posted')));

// S
ok('S1 seen of total', seenLabel(2, 5) === 'Seen by 2 of 5');
ok('S2 everyone', seenLabel(5, 5) === 'Seen by everyone');
ok('S3 nobody else', seenLabel(0, 0) === '');
ok('S4 none yet', seenLabel(0, 3) === 'Seen by 0 of 3');
const sp = splitMentions('@Moshe Cohen the delivery came, @All too, mail a@Moshe', ['Moshe Cohen'], true);
ok('S5 split tags', eq(sp.filter((p) => p.mention).map((p) => p.text), ['@Moshe Cohen', '@All']), JSON.stringify(sp));
ok('S6 split keeps all text', sp.map((p) => p.text).join('') === '@Moshe Cohen the delivery came, @All too, mail a@Moshe');
ok('S7 untagged @name stays plain', splitMentions('@Rivka hi', ['Moshe'], false).every((p) => !p.mention));
ok('S8 no partial-word tag', splitMentions('@Moshes', ['Moshe'], false).every((p) => !p.mention));

ok('S9 removeTagText drops the tag and one space', removeTagText('@Moshe Gold keys here', 'Moshe Gold') === 'keys here');
ok('S10 removeTagText keeps other text and email-like words', removeTagText('call a@Moshe Gold then @Moshe Gold now', 'Moshe Gold') === 'call a@Moshe Gold then now');
ok('S10b removeTagText removes every occurrence', removeTagText('@Moshe Gold hi @Moshe Gold bye', 'Moshe Gold') === 'hi bye');
ok('S11 removeTagText All', removeTagText('hi @All fridge', 'All') === 'hi fridge');
ok('S12 removeTagText no match', removeTagText('hello', 'Moshe') === 'hello');
// R
const notes = [
  { id: 'n1', venueId: 'v1', authorEmail: 'a@x', authorName: 'Avi', content: '@Moshe Cohen keys in office', shift: 'Morning', createdAt: '2026-10-29T10:00:00.000Z', mentions: [{ id: 'u-moshe', name: 'Moshe Cohen' }], private: true },
  { id: 'n2', venueId: 'v1', authorEmail: 'a@x', authorName: 'Avi', content: '@All fridge fixed', shift: 'Evening', createdAt: '2026-10-29T09:00:00.000Z', mentionAll: true },
];
const props = (extra = {}) => ({ items: notes, loading: false, readOnly: false, canDelete: () => false, unreadIds: new Set(), venueId: 'v1', currentUserEmail: 'm@x', currentUserName: 'Moshe Cohen', currentUserId: 'u-moshe', active: false, onMark() {}, onPosted() {}, onDeleted() {}, ...extra });
const html = renderToStaticMarkup(React.createElement(HandoffNotes, props()));
ok('R1 private label on the private note', html.includes('Private: only Moshe Cohen, admins and coordinators can see this'));
ok('R2 tagged-you marker', (html.match(/data-tagged-you/g) || []).length === 2);
ok('R3 tagged names line', html.includes('Tagged: Moshe Cohen') && html.includes('Tagged: All (everyone at this venue)'));
ok('R4 composer hint', html.includes('type @ to tag'));
ok('R5 private toggle disabled with no tag', /data-private-toggle[^>]*disabled/.test(html) || /disabled[^>]*data-private-toggle/.test(html));
ok('R6 private hint', html.includes('Tag someone with @ to send privately'));
ok('R7 one private card', (html.match(/data-note-private/g) || []).length === 1);
ok('R8 tag bolded', html.includes('font-bold text-gold-deep">@Moshe Cohen</span>'));
const kiosk = renderToStaticMarkup(React.createElement(HandoffNotes, props({ readOnly: true })));
ok('R9 kiosk: no composer, no toggle, no seen-by', !kiosk.includes('data-private-toggle') && !kiosk.includes('type @ to tag') && !kiosk.includes('data-seen-by'));
const other = renderToStaticMarkup(React.createElement(HandoffNotes, props({ currentUserId: 'u-other', currentUserEmail: 'o@x' })));
ok('R10 tagged-you only for @All when not tagged by name', (other.match(/data-tagged-you/g) || []).length === 1);

// K (TEAMNOTES2)
ok('K1 one private message', kioskPrivateNotice(1) === 'You have a private message. Open Shutfey on your phone to read it.');
ok('K2 several', kioskPrivateNotice(3) === 'You have 3 private messages. Open Shutfey on your phone to read them.');
ok('K3 none / bad input says nothing', kioskPrivateNotice(0) === '' && kioskPrivateNotice(-1) === '' && kioskPrivateNotice(undefined) === '' && kioskPrivateNotice(1.5) === '');
const kn = renderToStaticMarkup(React.createElement(HandoffNotes, props({ readOnly: true, privateForYou: 1, items: [notes[1]] })));
ok('K4 kiosk list shows the notice', kn.includes('data-kiosk-private-notice') && kn.includes('You have a private message. Open Shutfey on your phone to read it.'));
ok('K5 kiosk notice carries no note text', !kn.includes('keys in office'));
ok('K6 no notice for 0', !renderToStaticMarkup(React.createElement(HandoffNotes, props({ readOnly: true, privateForYou: 0 }))).includes('data-kiosk-private-notice'));
ok('K7 never on a phone (not read-only)', !renderToStaticMarkup(React.createElement(HandoffNotes, props({ readOnly: false, privateForYou: 2 }))).includes('data-kiosk-private-notice'));
const kb = renderToStaticMarkup(React.createElement(KioskPrivateNotice, { count: 2 }));
ok('K8 kiosk banner text', kb.includes('data-kiosk-private-banner') && kb.includes('You have 2 private messages. Open Shutfey on your phone to read them.'));
ok('K9 kiosk banner empty for 0', renderToStaticMarkup(React.createElement(KioskPrivateNotice, { count: 0 })) === '');

// F
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
try { setSessionToken('t'); } catch {}
const teams = { v1: [{ id: 'u-me', name: 'Rivka Levi', role: 'mashgiach' }, { id: 'u-moshe', name: 'Moshe Gold', role: 'mashgiach' }, { id: 'u-leah', name: 'Leah Katz', role: 'coordinator' }], v2: [{ id: 'u-me', name: 'Rivka Levi', role: 'mashgiach' }, { id: 'u-zev', name: 'Zev Adler', role: 'mashgiach' }] };
// team fetch failure -> retry offer
recordFetch({ '/api/handoff-notes/team': () => { throw new Error('offline'); }, '/api/handoff-notes/seen': { counts: [] } });
const ff = mount(HandoffNotes, props({ items: [], active: true, currentUserId: 'u-me' }));
await ff.render();
await ff.type('type @ to tag', '@');
ok('F0 a failed team load offers Retry instead of a silent empty picker', ff.text().includes("Couldn't load the team.") && ff.buttons().some((b) => b.label === 'Retry'));
const calls2 = recordFetch({ '/api/handoff-notes/team': (path) => ({ team: teams[new URLSearchParams(path.split('?')[1]).get('venueId')] || [] }), '/api/handoff-notes/seen': { counts: [] } });
await ff.click('Retry');
ok('F0b Retry loads the team', ff.find((e) => e.props['data-mention-option']).length === 3 && !ff.text().includes("Couldn't load"), ff.text().slice(0, 200));
void calls2;
const calls = recordFetch({
  '/api/handoff-notes/team': (path) => ({ team: teams[new URLSearchParams(path.split('?')[1]).get('venueId')] || [] }),
  '/api/handoff-notes/seen': { counts: [] },
  'POST /api/handoff-notes': (path, body) => ({ note: { id: 'n9', venueId: body.venueId, authorEmail: 'r@x', authorName: 'Rivka Levi', content: body.content, shift: 'Morning', createdAt: '2026-10-29T10:00:00.000Z' } }),
  '/api/health': { ok: true },
});
const posted = [];
const fm = mount(HandoffNotes, props({ items: [], active: true, currentUserId: 'u-me', currentUserEmail: 'r@x', currentUserName: 'Rivka Levi', onPosted: (n) => posted.push(n) }));
await fm.render();
await fm.type('type @ to tag', '@');
const optNames = fm.find((e) => e.props['data-mention-option']).map((e) => e.props['data-mention-option']);
ok('F1 "@" opens the picker: @All first, team minus me', JSON.stringify(optNames) === JSON.stringify(['all', 'Moshe Gold', 'Leah Katz']), JSON.stringify(optNames));
await fm.type('type @ to tag', '@Mo');
await fm.click((e) => e.props['data-mention-option'] === 'Moshe Gold');
ok('F2 the chip is made', fm.find((e) => e.props['data-tag-chip'] === 'Moshe Gold').length === 1);
ok('F2b the text holds the tag', fm.find((e) => e.type === 'textarea')[0].props.value === '@Moshe Gold ');
await fm.type('type @ to tag', '@Moshe Gold keys in the office');
await fm.click((e) => e.props['data-private-toggle'] !== undefined);
ok('F3 Private banner names admins and coordinators', fm.text().includes('Private: only Moshe Gold, admins and coordinators will see this'));
ok('F3b the button says Send privately', fm.buttons().some((b) => b.label === 'Send privately'));
await fm.click('Send privately');
const post1 = calls.filter((c) => c[0] === 'POST' && c[1] === '/api/handoff-notes').pop();
ok('F4 send carries the tag and private', post1 && JSON.stringify(post1[2].mentions) === JSON.stringify(['u-moshe']) && post1[2].private === true && post1[2].mentionAll === false, JSON.stringify(post1));
ok('F4b composer is cleared after a send', fm.find((e) => e.props['data-tag-chip']).length === 0 && !fm.text().includes('will see this'));
// venue switch with a private draft
await fm.type('type @ to tag', '@Mo');
await fm.click((e) => e.props['data-mention-option'] === 'Moshe Gold');
await fm.click((e) => e.props['data-private-toggle'] !== undefined);
ok('F5 private draft is on before the switch', fm.text().includes('will see this'));
await fm.click((e) => e.props['data-tag-chip'] === 'Moshe Gold');
ok('F5b removing the chip removes "@Moshe Gold" from the text and turns Private off', fm.find((e) => e.type === 'textarea')[0].props.value === '' && !fm.text().includes('will see this'), fm.find((e) => e.type === 'textarea')[0].props.value);
await fm.type('type @ to tag', '@Mo');
await fm.click((e) => e.props['data-mention-option'] === 'Moshe Gold');
await fm.click((e) => e.props['data-private-toggle'] !== undefined);
await fm.render({ venueId: 'v2' });
ok('F6 venue change drops tags and Private', fm.find((e) => e.props['data-tag-chip']).length === 0 && !fm.text().includes('will see this'));
await fm.type('type @ to tag', '@ hello');
await fm.type('type @ to tag', '@');
const opt2 = fm.find((e) => e.props['data-mention-option']).map((e) => e.props['data-mention-option']);
ok('F7 the picker now shows the new venue team only', JSON.stringify(opt2) === JSON.stringify(['all', 'Zev Adler']), JSON.stringify(opt2));
await fm.type('type @ to tag', 'plain note');
await fm.click('Send note');
const post2 = calls.filter((c) => c[0] === 'POST' && c[1] === '/api/handoff-notes').pop();
ok('F8 a send after the switch carries no stale tag', post2 && post2[2].venueId === 'v2' && JSON.stringify(post2[2].mentions) === '[]' && post2[2].private === false, JSON.stringify(post2));

// V (RV4 P3, RV1 P2/P3): an in-flight send never wipes a newer draft — the composer is ONE draft (venue, text,
// recording, tags, @All, Private) and is cleared only when it is still exactly the draft that was sent.
{
  let release = null;
  const bodies = [];
  recordFetch({
    '/api/handoff-notes/team': (path) => ({ team: teams[new URLSearchParams(path.split('?')[1]).get('venueId')] || [] }),
    '/api/handoff-notes/seen': { counts: [] },
    'POST /api/handoff-notes': (path, body) => { bodies.push(body); return new Promise((r) => { release = () => r({ note: { id: 'nv', venueId: body.venueId, authorEmail: 'r@x', authorName: 'Rivka Levi', content: body.content, shift: 'Morning', createdAt: '2026-10-29T10:00:00.000Z' } }); }); },
    '/api/health': { ok: true },
  });
  const sendBtn = (m) => m.find((e) => e.type === 'button' && typeof e.props.onClick === 'function' && /Send/.test(JSON.stringify(e.props.children ?? '')))[0];
  const box = (m) => m.find((e) => e.type === 'textarea')[0].props.value;
  const startSend = async (m) => { release = null; const p = sendBtn(m).props.onClick({ preventDefault() {}, stopPropagation() {} }); for (let i = 0; i < 40 && !release; i++) await new Promise((r) => setTimeout(r, 5)); return { p }; };
  const finish = async (m, h) => { if (release) { release(); await h.p; } await m.render(); };
  const vm = mount(HandoffNotes, props({ items: [], active: true, currentUserId: 'u-me', currentUserEmail: 'r@x', currentUserName: 'Rivka Levi' }));
  await vm.render();
  // V1: switch venue, type a DIFFERENT draft there
  await vm.type('type @ to tag', 'note for venue one');
  let p = await startSend(vm);
  await vm.render({ venueId: 'v2' });
  await vm.type('type @ to tag', 'new draft for venue two');
  await finish(vm, p);
  ok('V1 a send finishing after a venue switch keeps the new draft', box(vm) === 'new draft for venue two', box(vm));
  // V1b: switch venue, the new venue's draft is IDENTICAL text -> still kept (RV1 P2)
  await vm.type('type @ to tag', 'Check refrigerator');
  p = await startSend(vm);
  await vm.render({ venueId: 'v1' });
  await vm.type('type @ to tag', 'Check refrigerator');
  await finish(vm, p);
  ok('V1b an identical draft in the new venue is kept', box(vm) === 'Check refrigerator', box(vm));
  // V2: more typing during the send is kept
  await vm.type('type @ to tag', 'same venue');
  p = await startSend(vm);
  await vm.type('type @ to tag', 'same venue and more typed');
  await finish(vm, p);
  ok('V2 text typed during the send is kept', box(vm) === 'same venue and more typed');
  // V3: edit then restore the same text during the send -> still a newer draft, kept
  await vm.type('type @ to tag', 'restore me');
  p = await startSend(vm);
  await vm.type('type @ to tag', 'restore me!');
  await vm.type('type @ to tag', 'restore me');
  await finish(vm, p);
  ok('V3 an edit that is undone during the send still keeps the draft', box(vm) === 'restore me', box(vm));
  // V4: tags/Private changed during the send (same text) -> kept (RV1 P2)
  await vm.type('type @ to tag', '');
  await vm.type('type @ to tag', '@Mo');
  await vm.click((e) => e.props['data-mention-option'] === 'Moshe Gold');
  await vm.type('type @ to tag', '@Moshe Gold keys');
  p = await startSend(vm);
  ok('V4 setup: the send carried Moshe, not private', JSON.stringify(bodies[bodies.length - 1]?.mentions) === '["u-moshe"]' && bodies[bodies.length - 1]?.private === false, JSON.stringify(bodies[bodies.length - 1]));
  await vm.click((e) => e.props['data-private-toggle'] !== undefined);
  await finish(vm, p);
  ok('V4 a Private switched on during the send is kept, with its tag and text', vm.text().includes('will see this') && vm.find((e) => e.props['data-tag-chip'] === 'Moshe Gold').length === 1 && box(vm) === '@Moshe Gold keys', box(vm));
  // V5: untouched -> cleared (text, tag, Private)
  p = await startSend(vm);
  await finish(vm, p);
  ok('V5 an untouched sent draft is cleared (text, tags, Private)', box(vm) === '' && vm.find((e) => e.props['data-tag-chip']).length === 0 && !vm.text().includes('will see this'), box(vm));
  // V7 (RV3 P2): changing the Shift during the send (or changing it and back) keeps the draft.
  const shiftSel = () => vm.find((e) => e.type === 'select' && e.props['aria-label'] === 'Shift')[0];
  const setShiftTo = async (v) => { await shiftSel().props.onChange({ target: { value: v } }); await vm.render(); };
  const shifts = shiftSel().props.children.map((o) => o.key);
  const s0 = shiftSel().props.value; const s1 = shifts.find((x) => x !== s0);
  await vm.type('type @ to tag', 'shift note');
  p = await startSend(vm);
  await setShiftTo(s1);
  await finish(vm, p);
  ok('V7a a Shift change during the send keeps the draft', box(vm) === 'shift note' && shiftSel().props.value === s1, box(vm));
  p = await startSend(vm);
  await setShiftTo(s0); await setShiftTo(s1);
  await finish(vm, p);
  ok('V7b a Shift changed and changed back during the send still keeps the draft', box(vm) === 'shift note', box(vm));
  p = await startSend(vm);
  await finish(vm, p);
  ok('V7c untouched again -> cleared', box(vm) === '');
  // V6 (RV2 P2): a recording started while a text-only send is pending keeps its Stop control and the draft.
  let grant = null;
  const fakeStream = { getTracks: () => [{ stop() {} }] };
  const md = { getUserMedia: () => new Promise((r) => { grant = () => r(fakeStream); }) };
  try { Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true }); } catch { globalThis.navigator = { mediaDevices: md }; }
  class FakeRecorder {
    state = 'inactive';
    onstop = null;
    ondataavailable = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  }
  globalThis.MediaRecorder = FakeRecorder;
  await vm.type('type @ to tag', 'text only');
  p = await startSend(vm);
  const mic = vm.find((e) => e.type === 'button' && /Voice note/.test(JSON.stringify(e.props.children ?? '')))[0];
  const recP = mic.props.onClick({ preventDefault() {}, stopPropagation() {} });
  await finish(vm, p); // the send lands while the microphone permission is still open
  ok('V6a a send landing during the mic permission prompt keeps the draft', box(vm) === 'text only', box(vm));
  grant(); await recP; await vm.render();
  ok('V6b the recording then runs with its Stop control', vm.buttons().some((b) => /Stop/.test(b.label)), vm.buttons().map((b) => b.label).join('|'));
  p = await startSend(vm);
  await finish(vm, p);
  ok('V6c a send during a live recording never detaches it (Stop stays, text stays)', vm.buttons().some((b) => /Stop/.test(b.label)) && box(vm) === 'text only', box(vm));
}

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
