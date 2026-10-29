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
 * Run: npx tsx tests/client/test-teamnotes-client.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mentionQueryAt, applyMention, filterTeam, joinNames, privateNotice, seenLabel, splitMentions } from '../../src/lib/mentions.ts';
import { HandoffNotes } from '../../src/components/HandoffNotes.tsx';
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

// F
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
try { setSessionToken('t'); } catch {}
const teams = { v1: [{ id: 'u-me', name: 'Rivka Levi', role: 'mashgiach' }, { id: 'u-moshe', name: 'Moshe Gold', role: 'mashgiach' }, { id: 'u-leah', name: 'Leah Katz', role: 'coordinator' }], v2: [{ id: 'u-me', name: 'Rivka Levi', role: 'mashgiach' }, { id: 'u-zev', name: 'Zev Adler', role: 'mashgiach' }] };
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

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
