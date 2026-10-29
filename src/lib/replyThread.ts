import type { HandoffNoteItem } from './updates';
import { joinNames } from './mentions';

export function conversationMembers(root: HandoffNoteItem): { id: string; name: string }[] {
  const people = new Map<string, { id: string; name: string }>();
  for (const person of [
    { id: root.authorId || root.authorEmail, name: root.authorName },
    ...(root.mentions || []), ...(root.members || []),
  ]) if (person.id && !people.has(person.id)) people.set(person.id, person);
  return [...people.values()];
}
export function threadNotice(names: string[]): string {
  const people = names.filter(Boolean).join(', ');
  return `Only ${people ? `${people}, ` : ''}admins and coordinators can see this`;
}
export function addWarning(newNames: string[]): string {
  return newNames.length ? `${joinNames(newNames)} will be added and will see the whole conversation` : '';
}
export function quoteLine(replyTo: HandoffNoteItem['replyTo']): string {
  if (!replyTo || replyTo.deleted) return 'Message deleted';
  const text = (replyTo.text || '').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}
export function swipeIntent(dx: number, dy: number): 'reply' | 'none' {
  return dx >= 56 && Math.abs(dy) < 30 && dx > 2 * Math.abs(dy) ? 'reply' : 'none';
}
export type NoteGroup = { kind: 'note'; note: HandoffNoteItem } | {
  kind: 'thread'; root: HandoffNoteItem; replies: HandoffNoteItem[]; lastAt: string; memberNames: string[];
};
/** Orphan replies stay locked together; never promote private content to a public note. */
export function groupNotes(notes: HandoffNoteItem[]): NoteGroup[] {
  const roots = new Map(notes.filter((n) => n.private && !n.threadId).map((n) => [n.id, n]));
  const replies = new Map<string, HandoffNoteItem[]>();
  for (const n of notes) if (n.threadId) replies.set(n.threadId, [...(replies.get(n.threadId) || []), n]);
  for (const [id, children] of replies) if (!roots.has(id)) {
    const child = children[0];
    roots.set(id, { id, venueId: child.venueId, authorEmail: '', authorName: '', content: '', shift: '', createdAt: child.createdAt, private: true, deleted: true });
  }
  const out: NoteGroup[] = notes.filter((n) => !n.private && !n.threadId).map((note) => ({ kind: 'note', note }));
  for (const root of roots.values()) {
    const children = [...(replies.get(root.id) || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = children.at(-1);
    out.push({ kind: 'thread', root, replies: children, lastAt: latest && latest.createdAt > root.createdAt ? latest.createdAt : root.createdAt, memberNames: conversationMembers(root).map((m) => m.name) });
  }
  return out.sort((a, b) => (b.kind === 'note' ? b.note.createdAt : b.lastAt).localeCompare(a.kind === 'note' ? a.note.createdAt : a.lastAt));
}
