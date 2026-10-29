// TEAMNOTES — @mentions in shift notes (Don, Oct 29 2026): pure helpers
// for the composer's WhatsApp-style picker, the private notice and the
// seen-by line. No React here; tests/client/test-teamnotes-client.mjs.

export interface TeamMember { id: string; name: string; role: string }

/** The "@query" being typed at the caret: an "@" at the start or after
 * whitespace, then non-space characters up to the caret ("@" alone is an
 * empty query). An "@" inside a word (an email, "a@b") is not a mention. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  if (typeof text !== 'string') return null;
  const end = Math.max(0, Math.min(Number.isFinite(caret) ? caret : text.length, text.length));
  const before = text.slice(0, end);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replace "@query" (from q.start to the caret) with "@label " and say where the caret goes. */
export function applyMention(text: string, caret: number, q: { start: number }, label: string): { text: string; caret: number } {
  const end = Math.max(q.start, Math.min(caret, text.length));
  const insert = `@${label} `;
  const rest = text.slice(end).replace(/^ /, '');
  return { text: text.slice(0, q.start) + insert + rest, caret: q.start + insert.length };
}

/** "All" first when it matches, then people whose name (or a word of it) starts with the query. */
export function filterTeam(team: TeamMember[], query: string): { all: boolean; people: TeamMember[] } {
  const q = (query || '').trim().toLocaleLowerCase();
  const all = q === '' || 'all'.startsWith(q);
  const people = (team || []).filter((m) => {
    if (!q) return true;
    const name = (m.name || '').toLocaleLowerCase();
    return name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q));
  });
  return { all, people };
}

/** "Moshe" / "Moshe and Rivka" / "Moshe, Rivka and Dov". */
export function joinNames(names: string[]): string {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The private notice — before sending ('compose') and on the posted note ('posted'). */
export function privateNotice(names: string[], when: 'compose' | 'posted'): string {
  const who = joinNames(names) || 'the tagged people';
  return when === 'compose'
    ? `Private: only ${who}, admins and coordinators will see this`
    : `Private: only ${who}, admins and coordinators can see this`;
}

/** TEAMNOTES2: the kiosk notice for the person signed in on the tablet — how
 * many private notes wait for them, never what they say. '' for none. */
export function kioskPrivateNotice(count: number): string {
  if (!Number.isInteger(count) || count <= 0) return '';
  return count === 1
    ? 'You have a private message. Open Shutfey on your phone to read it.'
    : `You have ${count} private messages. Open Shutfey on your phone to read them.`;
}

/** "Seen by 2 of 5" · "Seen by everyone" · "" when nobody else can see it yet. */
export function seenLabel(seen: number, total: number): string {
  if (!total || total <= 0) return seen > 0 ? `Seen by ${seen}` : '';
  if (seen >= total) return 'Seen by everyone';
  return `Seen by ${seen} of ${total}`;
}

/** Split note text into plain and "@Name" parts, for the names actually tagged. */
export function splitMentions(text: string, names: string[], all: boolean): Array<{ text: string; mention: boolean }> {
  const labels = [...new Set([...(names || []).filter(Boolean), ...(all ? ['All'] : [])])].sort((a, b) => b.length - a.length);
  if (!text || labels.length === 0) return text ? [{ text, mention: false }] : [];
  const out: Array<{ text: string; mention: boolean }> = [];
  let i = 0; let plain = '';
  while (i < text.length) {
    const ch = text[i];
    const boundaryBefore = i === 0 || /\s/.test(text[i - 1]);
    let hit = '';
    if (ch === '@' && boundaryBefore) {
      for (const l of labels) {
        const cand = text.slice(i + 1, i + 1 + l.length);
        const after = text[i + 1 + l.length];
        if (cand.toLocaleLowerCase() === l.toLocaleLowerCase() && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) { hit = text.slice(i, i + 1 + l.length); break; }
      }
    }
    if (hit) {
      if (plain) { out.push({ text: plain, mention: false }); plain = ''; }
      out.push({ text: hit, mention: true });
      i += hit.length;
    } else { plain += ch; i++; }
  }
  if (plain) out.push({ text: plain, mention: false });
  return out;
}

/** RV2/RV3 P3: removing a tag chip also takes EVERY whole-word "@Name" out of
 * the text (each with one following space), so the note never shows a tag
 * that notifies nobody. */
export function removeTagText(text: string, label: string): string {
  if (!text || !label) return text;
  const parts = splitMentions(text, [label], label === 'All');
  const target = `@${label}`.toLocaleLowerCase();
  const out: string[] = [];
  let dropSpace = false;
  for (const p of parts) {
    if (p.mention && p.text.toLocaleLowerCase() === target) { dropSpace = true; continue; }
    out.push(dropSpace && p.text.startsWith(' ') ? p.text.slice(1) : p.text);
    dropSpace = false;
  }
  return out.join('');
}
