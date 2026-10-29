import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { groupNotes, conversationMembers, threadNotice, addWarning, quoteLine, swipeIntent } from '../../src/lib/replyThread.ts';
import { HandoffNotes } from '../../src/components/HandoffNotes.tsx';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { setSessionToken } from '../../src/lib/api.ts';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const note = (id, hour, extra = {}) => ({ id, venueId: 'v', authorId: 'r', authorEmail: 'r@x', authorName: 'Rivka', content: 'Keys here', shift: 'Morning', createdAt: `2026-10-29T${hour}:00:00Z`, ...extra });
const root = note('root', '08', { private: true, mentions: [{ id: 'm', name: 'Moshe' }], members: [{ id: 'm', name: 'Duplicate' }, { id: 'd', name: 'Dov' }] });
const reply = note('reply', '12', { private: true, threadId: 'root', authorId: 'm', authorName: 'Moshe' });
const early = note('early', '09', { private: true, threadId: 'root' });
const pub = note('public', '11');
const grouped = groupNotes([pub, reply, root, early, note('old', '07')]);
check(grouped[0].kind === 'thread' && grouped[0].root.id === 'root', 'latest conversation floats above public');
check(grouped[0].lastAt === reply.createdAt, 'last activity');
assert.deepEqual(grouped[0].replies.map((n) => n.id), ['early', 'reply']); checks++;
assert.deepEqual(grouped.slice(1).map((g) => g.note.id), ['public', 'old']); checks++;
assert.deepEqual(conversationMembers(root).map((m) => m.name), ['Rivka', 'Moshe', 'Dov']); checks++;
check(groupNotes([root])[0].replies.length === 0, 'root without replies is a conversation');
check(groupNotes([reply])[0].kind === 'thread' && groupNotes([reply])[0].root.deleted, 'orphan stays in a locked conversation');
check(groupNotes([root, reply])[0].root === root, 'does not copy content');
check(groupNotes([{ ...root, deleted: true, content: '' }, reply])[0].replies.length === 1, 'tombstone keeps replies');
check(groupNotes([reply, { ...early, threadId: 'root' }])[0].replies.length === 2, 'orphans share one conversation');
check(groupNotes([]).length === 0, 'empty list');
assert.deepEqual(conversationMembers(note('no-tags', '08')).map((m) => m.id), ['r']); checks++;
assert.deepEqual(conversationMembers(note('legacy', '08', { authorId: undefined })).map((m) => m.id), ['r@x']); checks++;
check(threadNotice([]) === 'Only admins and coordinators can see this', 'missing-root notice');
check(threadNotice(['Rivka', 'Moshe']) === 'Only Rivka, Moshe, admins and coordinators can see this', 'notice');
check(addWarning(['Dov']) === 'Dov will be added and will see the whole conversation', 'one added name');
check(addWarning(['Dov', 'Sara']) === 'Dov and Sara will be added and will see the whole conversation', 'two added names');
check(addWarning([]) === '', 'no warning without additions');
check(quoteLine({ deleted: true, text: 'secret' }) === 'Message deleted', 'deleted quote never leaks text');
check(quoteLine(undefined) === 'Message deleted', 'missing quote');
check(quoteLine({ text: ' hi\n there  ' }) === 'hi there', 'one line');
check(quoteLine({ text: 'a'.repeat(141) }) === 'a'.repeat(139) + '…', 'quote cap');
check(quoteLine({ text: 'a'.repeat(140) }).length === 140, 'exact cap');
check(quoteLine({ text: '🎤 Voice note' }) === '🎤 Voice note', 'voice quote');
for (const [dx, dy, expected] of [[56, 0, 'reply'], [55, 0, 'none'], [60, 29, 'reply'], [60, 30, 'none'], [58, -29, 'none'], [59, -29, 'reply'], [-70, 0, 'none'], [100, 60, 'none']]) check(swipeIntent(dx, dy) === expected, `swipe ${dx},${dy}`);

const source = readFileSync(new URL('../../src/components/HandoffNotes.tsx', import.meta.url), 'utf8');
check(source.includes('threadId: thread ? thread.root.id : undefined'), 'thread sends root id');
check(source.includes('mentionAll: thread ? false : tagAll'), 'thread never sends All');
check(source.includes('picker.all && !tagAll && !thread'), 'no All picker inside');
check(source.includes('{!thread && <div') && source.includes('data-private-toggle'), 'Private toggle gated outside thread');
for (const attr of ['data-reply-btn', 'data-quote', 'data-thread-card', 'data-thread-view', 'data-thread-back', 'data-add-warning', 'data-replying-to']) check(source.includes(attr), attr);

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { location: { origin: 'https://app.example', search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
setSessionToken('test');
const calls = recordFetch({
  '/api/handoff-notes/team': { team: [{ id: 'd', name: 'Dov', role: 'worker' }, { id: 's', name: 'Sara', role: 'worker' }] },
  '/api/handoff-notes/seen': { counts: [] },
  'POST /api/handoff-notes': (_, body) => ({ note: note('sent', '13', body) }),
});
const props = { items: [root, reply, pub], loading: false, readOnly: false, canDelete: () => false, unreadIds: new Set(['reply']), venueId: 'v', currentUserId: 'r', currentUserEmail: 'r@x', currentUserName: 'Rivka', active: true, onMark() {}, onPosted() {}, onDeleted() {} };
const m = mount(HandoffNotes, props);
await m.render();
check(m.find((e) => e.props['data-thread-card'] !== undefined).length === 1, 'one conversation card');
const unreadCard = m.find((e) => e.props['data-thread-card'] !== undefined)[0];
check(JSON.stringify(unreadCard.props.children).includes('New') && m.find((e) => e.props['aria-label'] === 'Unread').length === 1, 'unread conversation has New text and accessible label');
await m.render({ unreadIds: new Set() });
check(!m.text().includes('New') && !m.find((e) => e.props['aria-label'] === 'Unread').length, 'read conversation has no New marker');
await m.render({ unreadIds: props.unreadIds });
check(m.text().includes('1 reply · latest Moshe') && !m.text().includes('1 replies'), 'singular reply label');
await m.render({ items: [root, early, reply, pub] });
check(m.text().includes('2 replies · latest Moshe') && !m.text().includes('2 reply ·'), 'plural replies label');
await m.render({ items: [root, reply, pub] });
check(m.find((e) => e.props['data-note-id'] === 'reply').length === 0, 'private reply absent from main');
await m.click((e) => e.props['data-thread-card'] === undefined && e.type === 'button' && JSON.stringify(e.props.children).includes('Private conversation'));
check(m.find((e) => e.props['data-thread-view'] === 'root').length === 1, 'conversation opens');
check(!m.find((e) => e.props['data-private-label'] !== undefined).length && !m.text().includes('Private: only'), 'conversation has no stale per-message private labels');
check(m.text().includes('Only Rivka, Moshe, Dov, admins and coordinators can see this'), 'conversation keeps banner with all current members');
check(m.find((e) => e.props['data-private-toggle'] !== undefined).length === 0, 'no private toggle inside');
await m.type('Your reply stays private', '@');
check(!m.find((e) => e.props['data-mention-option'] === 'all').length, 'All absent inside');
await m.click((e) => e.props['data-mention-option'] === 'Sara');
check(m.text().includes('Sara will be added and will see the whole conversation'), 'addition warning');
await m.click((e) => e.props['data-reply-btn'] !== undefined);
check(m.find((e) => e.props['data-replying-to'] !== undefined).length === 1, 'reply mode');
await m.click('Add Sara and send');
const body = calls.filter((c) => c[0] === 'POST' && c[1] === '/api/handoff-notes').at(-1)[2];
check(body.threadId === 'root' && body.replyToId === 'root' && body.private && !body.mentionAll, 'private thread send contract');
await m.click((e) => e.props['data-thread-back'] !== undefined);
await m.click((e) => e.props['data-reply-btn'] !== undefined && !JSON.stringify(e.props.children).includes('Private conversation'), 1);
await m.type('type @ to tag', 'Public reply');
await m.click((e) => e.props['data-private-toggle'] !== undefined);
check(m.text().includes('Private: only Rivka, admins and coordinators will see this'), 'quoted writer included without explicit tag');
await m.click('Send privately');
const privateReply = calls.filter((c) => c[0] === 'POST' && c[1] === '/api/handoff-notes').at(-1)[2];
check(privateReply.replyToId === 'public' && !privateReply.threadId && privateReply.private, 'private reply starts new conversation');
// A conversation that disappears returns to the main list and drops its private draft.
await m.click((e) => e.type === 'button' && JSON.stringify(e.props.children).includes('Private conversation'));
await m.type('Your reply stays private', 'private draft');
await m.render({ items: [pub] });
check(!m.find((e) => e.props['data-thread-view'] === 'root').length, 'lost access leaves conversation');
check(m.find((e) => e.type === 'textarea')[0].props.value === '', 'lost access clears private draft');
await m.click((e) => e.props['data-reply-btn'] !== undefined);
await m.render({ venueId: 'other' });
check(!m.find((e) => e.props['data-replying-to'] !== undefined).length, 'venue switch clears reply');
await m.render({ readOnly: true });
check(!m.find((e) => e.props['data-thread-card'] !== undefined).length && !m.find((e) => e.props['data-reply-btn'] !== undefined).length, 'kiosk no threads or replies');
// Own messages retain the existing canDelete rule; tombstones have no controls,
// including a delete confirmation or seen-count response left open before deletion.
recordFetch({ '/api/handoff-notes/seen': { counts: [{ id: 'root', seen: 1, total: 1 }] } });
const owner = mount(HandoffNotes, { ...props, canDelete: (n) => n.authorEmail === 'r@x' });
await owner.render();
await owner.click((e) => e.type === 'button' && JSON.stringify(e.props.children).includes('Private conversation'));
await new Promise((resolve) => setTimeout(resolve, 350));
await owner.render();
const ownArticle = () => owner.find((e) => e.props['data-note-id'] === 'root')[0];
check(JSON.stringify(ownArticle().props.children).includes('Delete this note'), 'own root has delete control');
check(JSON.stringify(ownArticle().props.children).includes('data-seen-by'), 'root initially shows seen control');
await owner.click((e) => e.props['aria-label'] === 'Delete this note');
check(owner.text().includes('Delete this note?'), 'own root can request deletion');
await owner.render({ items: [{ ...root, deleted: true, content: '', voiceNoteData: undefined }, reply] });
const tombstone = JSON.stringify(ownArticle().props.children);
check(tombstone.includes('italic') && tombstone.includes('Message deleted'), 'tombstone is italic');
check(!tombstone.includes('Delete this note') && !tombstone.includes('data-reply-btn') && !tombstone.includes('data-seen-by'), 'tombstone has no delete, reply or seen controls');
await owner.render({ items: [root, { ...reply, authorEmail: 'r@x' }] });
check(JSON.stringify(owner.find((e) => e.props['data-note-id'] === 'reply')[0].props.children).includes('Delete this note'), 'own conversation reply has delete control');
await owner.render({ canDelete: () => false });
check(!JSON.stringify(owner.find((e) => e.props['data-note-id'] === 'reply')[0].props.children).includes('Delete this note'), 'reply respects canDelete');
// Drafts are independent across main and conversation roots, including async media/send completion.
const secondRoot = { ...root, id: 'root-two', authorName: 'Dov' };
const draftProps = { ...props, items: [root, secondRoot, reply, pub] };
recordFetch({
  '/api/handoff-notes/team': { team: [{ id: 's', name: 'Sara', role: 'worker' }] },
  '/api/handoff-notes/seen': { counts: [] },
});
const drafts = mount(HandoffNotes, draftProps);
const value = (m) => m.find((e) => e.type === 'textarea')[0].props.value;
const enterDraft = async (id) => {
  const cards = drafts.find((e) => e.props['data-thread-card'] !== undefined);
  const selected = cards.find((e) => JSON.stringify(e.props.children).includes(id === 'root' ? 'Rivka, Moshe' : 'Dov, Moshe'));
  await selected.props.children[0].props.onClick(); await drafts.render();
};
const leaveDraft = () => drafts.click((e) => e.props['data-thread-back'] !== undefined);
const replyTo = async (id) => {
  const article = drafts.find((e) => e.props['data-note-id'] === id)[0];
  const button = article.props.children.find((e) => e?.props?.['data-reply-btn'] !== undefined);
  await button.props.onClick(); await drafts.render();
};
await drafts.render();
await drafts.type('type @ to tag', '@Sa');
await drafts.click((e) => e.props['data-mention-option'] === 'Sara');
await drafts.type('type @ to tag', '@Sara main draft');
await replyTo('public');
await drafts.click((e) => e.props['data-private-toggle'] !== undefined);
await enterDraft('root');
check(value(drafts) === '' && !drafts.text().includes('main draft'), 'conversation starts without main draft');
await drafts.type('Your reply stays private', 'first conversation draft');
await replyTo('reply');
await leaveDraft();
check(value(drafts) === '@Sara main draft', 'main draft survives in and out');
check(drafts.find((e) => e.props['data-tag-chip'] === 'Sara').length === 1 && drafts.text().includes('will see this') && drafts.find((e) => e.props['data-replying-to'] !== undefined).length === 1, 'main restores tags, Private and reply target');
await enterDraft('root');
check(value(drafts) === 'first conversation draft' && drafts.find((e) => e.props['data-replying-to'] !== undefined).length === 1, 'conversation draft and reply target survive out and in');
await leaveDraft(); await enterDraft('root-two');
await drafts.type('Your reply stays private', 'second conversation draft');
await leaveDraft(); await enterDraft('root');
check(value(drafts) === 'first conversation draft', 'first of two conversation drafts stays separate');
await leaveDraft(); await enterDraft('root-two');
check(value(drafts) === 'second conversation draft', 'second conversation draft stays separate');
await leaveDraft();
await drafts.click((e) => e.props['data-tag-chip'] === 'Sara');
await drafts.type('type @ to tag', '@');
await drafts.click((e) => e.props['data-mention-option'] === 'all');
await enterDraft('root'); await leaveDraft();
check(drafts.find((e) => e.props['data-tag-chip'] === 'All').length === 1, 'main restores All without inheriting it into threads');

// Finished recordings restore; a running recorder stopped on leave completes
// later into its original draft, even if a different recorder has since started.
const readers = [], recorders = [];
const fakeStream = () => ({ getTracks: () => [{ stop() {} }] });
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => fakeStream() } });
globalThis.MediaRecorder = class {
  state = 'inactive';
  constructor() { recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state !== 'recording') throw new Error('inactive');
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.();
  }
};
globalThis.FileReader = class {
  readAsDataURL() { readers.push(this); }
};
const finishVoice = async (data) => { const reader = readers.shift(); reader.result = data; reader.onload(); await drafts.render(); };
const voice = (m) => m.find((e) => e.type === 'audio').map((e) => e.props.src);
await drafts.click('Voice note'); await drafts.click('Stop');
await finishVoice('data:audio/webm;base64,MAIN');
await enterDraft('root');
check(!voice(drafts).includes('data:audio/webm;base64,MAIN'), 'finished main recording never attaches to conversation');
await leaveDraft();
check(voice(drafts).includes('data:audio/webm;base64,MAIN'), 'finished recording survives in and out');
await drafts.click('Discard');
await enterDraft('root'); await drafts.click('Voice note');
await leaveDraft();
check(recorders.at(-1).state === 'inactive' && !drafts.buttons().some((b) => b.label.includes('Stop')), 'leaving stops the running recording');
await drafts.click('Voice note');
await finishVoice('data:audio/webm;base64,THREAD');
check(!voice(drafts).includes('data:audio/webm;base64,THREAD') && drafts.buttons().some((b) => b.label.includes('Stop')), 'old recording result cannot replace current context recorder');
await drafts.click('Stop'); await finishVoice('data:audio/webm;base64,MAIN2');
await enterDraft('root');
check(voice(drafts).includes('data:audio/webm;base64,THREAD') && !voice(drafts).includes('data:audio/webm;base64,MAIN2'), 'running recording result is retained in its originating draft');

let releaseSend;
recordFetch({
  '/api/handoff-notes/team': { team: [] }, '/api/handoff-notes/seen': { counts: [] },
  'POST /api/handoff-notes': (_, body) => new Promise((resolve) => { releaseSend = () => resolve({ note: note('sent-draft', '13', body) }); }),
});
const sendDraft = () => drafts.find((e) => e.type === 'button' && e.props.onClick && JSON.stringify(e.props.children).includes('Send privately'))[0].props.onClick();
let inFlight = sendDraft();
await untilSend();
async function untilSend() { for (let n = 0; n < 40 && !releaseSend; n++) await new Promise((resolve) => setTimeout(resolve, 5)); check(!!releaseSend, 'send reached server'); }
await leaveDraft(); const mainBefore = value(drafts);
releaseSend(); await inFlight; await drafts.render();
check(value(drafts) === mainBefore && voice(drafts).includes('data:audio/webm;base64,MAIN2'), 'conversation send finishing on main preserves main text and voice');
await enterDraft('root');
check(value(drafts) === '' && !voice(drafts).includes('data:audio/webm;base64,THREAD') && !drafts.find((e) => e.props['data-replying-to'] !== undefined).length, 'successful parked send clears only its originating draft');
await drafts.type('Your reply stays private', 'sending then editing');
releaseSend = null; inFlight = sendDraft(); await untilSend();
await leaveDraft(); await enterDraft('root');
await drafts.type('Your reply stays private', 'edited during send');
releaseSend(); await inFlight; await drafts.render();
check(value(drafts) === 'edited during send', 'context revisited and edited during send keeps its newer draft');
await leaveDraft(); await enterDraft('root-two');
check(value(drafts) === 'second conversation draft', 'other conversation survives a successful send');
await drafts.render({ items: [root, reply, pub] });
await drafts.render({ items: [root, secondRoot, reply, pub] });
await enterDraft('root-two');
check(value(drafts) === '', 'disappeared conversation draft is dropped even if access returns');
await drafts.render({ venueId: 'next-venue' });
check(value(drafts) === '' && !voice(drafts).length && !drafts.find((e) => e.props['data-tag-chip'] || e.props['data-replying-to'] !== undefined).length, 'venue switch clears active and main drafts');
await drafts.render({ venueId: 'v' }); await enterDraft('root');
check(value(drafts) === '' && !voice(drafts).length, 'venue round trip cannot restore a prior conversation draft');
await leaveDraft();
check(value(drafts) === '' && !voice(drafts).length, 'venue round trip cannot restore the main draft');
// Late media work is invalidated on a venue change, and a delayed permission
// prompt must not start a recorder after its original context has been left.
await enterDraft('root'); await drafts.click('Voice note'); await leaveDraft();
await drafts.render({ venueId: 'other-venue' });
await finishVoice('data:audio/webm;base64,OLDVENUE');
check(!voice(drafts).length, 'late old-venue recording never attaches to the new main draft');
await enterDraft('root');
check(!voice(drafts).length, 'late old-venue recording cannot recreate a cleared thread draft');
await leaveDraft();
let grantMic, stoppedTracks = 0;
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise((resolve) => { grantMic = () => resolve({ getTracks: () => [{ stop() { stoppedTracks++; } }] }); }) } });
const countBefore = recorders.length;
const pendingMic = drafts.find((e) => e.type === 'button' && JSON.stringify(e.props.children).includes('Voice note'))[0].props.onClick();
await enterDraft('root'); grantMic(); await pendingMic; await drafts.render();
check(recorders.length === countBefore && stoppedTracks > 0, 'permission granted after leaving stops its stream without starting in another context');
await drafts.type('Your reply stays private', 'identical draft');
releaseSend = null; inFlight = sendDraft(); await untilSend();
await drafts.render({ venueId: 'new-venue' });
await drafts.render({ venueId: 'other-venue' });
await enterDraft('root'); await drafts.type('Your reply stays private', 'identical draft');
releaseSend(); await inFlight; await drafts.render();
check(value(drafts) === 'identical draft', 'old send cannot clear identical draft after venue round trip');
console.log(`REPLYTHREAD CLIENT: ${checks} checks passed`);
