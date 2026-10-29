/** REPLYTHREAD: replies, private conversation membership and every audience boundary.
 * Uses test-94's fixture, real HTTP/WS and captured push delivery pattern.
 * Positive recipients are checked alongside excluded recipients, including kiosks.
 */
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

export default {
  name: 'Test 96: Reply threads — quotes and private conversations',
  whatItProves: 'Reply quotes stay current; root membership governs REST, push, sockets, seen-by and kiosk counts; additions are atomic and deletion preserves conversations without retaining deleted text.',
  async run(baseUrl, ctx) {
    const ts = Date.now(), agencyId = `agency-t96-${ts}`, otherAgency = `agency-t96-other-${ts}`;
    const venueId = `venue-t96-${ts}`, otherVenue = `venue-t96-other-${ts}`;
    const people = {
      author: ['mashgiach', venueId], writer: ['mashgiach', venueId], outsider: ['mashgiach', venueId],
      added: ['mashgiach', venueId], admin: ['admin', venueId], readerAdmin: ['admin', venueId],
      coord: ['coordinator', venueId], otherCoord: ['coordinator', otherVenue], other: ['mashgiach', otherVenue],
      foreign: ['admin', `venue-t96-foreign-${ts}`],
    };
    const uid = (k) => `user-t96-${k}-${ts}`;
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: agencyId, name: 'Reply test' }, { id: otherAgency, name: 'Other agency' }],
      venues: [{ id: venueId, agencyId, name: 'Park Deli' }, { id: otherVenue, agencyId, name: 'Other venue' },
        { id: people.foreign[1], agencyId: otherAgency, name: 'Foreign venue' }],
      users: Object.entries(people).map(([k, [role, v]]) => ({ id: uid(k), name: k, role, venueId: v,
        agencyId: k === 'foreign' ? otherAgency : agencyId, email: `${uid(k)}@test.local` })),
    })).status, 200);
    const tokens = {}, sockets = {};
    let device;
    const request = async (who, method, path, body, kiosk = false) => {
      const r = await fetch(baseUrl + path, { method, headers: { ...auth(tokens[who] || who),
        ...(kiosk ? { 'X-Kiosk-Device': device } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      let data; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    };
    const create = async (who, body) => {
      const r = await request(who, 'POST', '/api/handoff-notes', { venueId, content: 'reply text', ...body });
      assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.note;
    };
    const rejected = async (who, body, statuses = [400]) => {
      const r = await request(who, 'POST', '/api/handoff-notes', { venueId, content: 'invalid', ...body });
      assert.ok(statuses.includes(r.status), `expected ${statuses}, got ${r.status}: ${JSON.stringify(r.data)}`);
    };
    const list = async (who, kiosk = false) => (await request(who, 'GET', '/api/handoff-notes', undefined, kiosk)).data;
    const find = async (who, id) => (await list(who)).notes.find((n) => n.id === id);
    const clearPush = () => ctx.api('POST', '/api/__test__/push-log/clear', {});
    const endpoint = (k) => `https://push.example/t96-${k}-${ts}`;
    const pushes = async () => {
      await sleep(180);
      return ((await ctx.api('GET', '/api/__test__/push-log')).json.log || [])
        .filter((p) => Object.keys(people).some((k) => p.endpoint === endpoint(k)));
    };
    const expectPush = async (expected, title, body = 'reply text') => {
      const ps = await pushes();
      assert.deepEqual(ps.map((p) => Object.keys(people).find((k) => p.endpoint === endpoint(k))).sort(), [...expected].sort());
      for (const p of ps) { assert.match(p.title, title); assert.equal(p.body, body); }
      return ps;
    };
    const connect = async (key, token = tokens[key], kiosk = false) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const messages = [];
      sockets[key] = { ws, messages };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WS timeout ${key}`)), 10000);
        ws.onopen = () => { if (kiosk) ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: device })); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error(`WS error ${key}`)); };
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data)); messages.push(m);
          if (m.type === 'INITIAL_STATE') { clearTimeout(timer); resolve(); }
        };
      });
    };
    const clearSockets = () => Object.values(sockets).forEach((s) => { s.messages.length = 0; });
    const socketAudience = async (id, type, allowed) => {
      await sleep(350);
      for (const [k, s] of Object.entries(sockets)) {
        const received = s.messages.some((m) => m.type === type && (m.payload?.note?.id || m.payload?.id) === id);
        assert.equal(received, allowed.includes(k), `${type} ${id}: ${k}`);
      }
    };
    const audience = async (id, allowed) => {
      for (const k of Object.keys(people)) assert.equal(!!await find(k, id), allowed.includes(k), `REST ${id}: ${k}`);
      assert.ok(!(await list(tokens.kiosk, true)).notes.some((n) => n.id === id), 'kiosk private list');
    };
    const remove = async (who, id) => {
      const r = await request(who, 'DELETE', `/api/handoff-notes/${id}?expectedVersion=${await ctx.getVersion()}`);
      assert.equal(r.status, 200, JSON.stringify(r.data));
    };
    const mark = async (who, noteIds) => request(who, 'POST', '/api/updates/seen', { venueId, noteIds });
    try {
      for (const k of Object.keys(people)) {
        const r = await fetch(baseUrl + '/api/__test__/mint-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid(k) }) });
        assert.equal(r.status, 200); tokens[k] = (await r.json()).token;
        assert.equal((await request(k, 'POST', '/api/push/subscribe', { subscription: { endpoint: endpoint(k), keys: { p256dh: 'p', auth: 'a' } } })).status, 200);
        await connect(k);
      }
      // K: paired kiosk, with member and non-member identities on the same tablet.
      for (const [k, pin] of [['writer', '9611'], ['outsider', '9612']]) {
        const expectedVersion = await ctx.getVersion();
        assert.equal((await request('admin', 'PUT', `/api/users/${uid(k)}?expectedVersion=${expectedVersion}`, { kioskPin: pin, expectedVersion })).status, 200);
      }
      const start = await (await fetch(baseUrl + '/api/kiosk/pairing/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      assert.equal((await request('admin', 'POST', '/api/kiosk/devices/pair', { code: start.code, venueId })).status, 201);
      const pairing = await (await fetch(baseUrl + '/api/kiosk/pairing/status', { headers: { 'X-Kiosk-Pairing': `${start.pairingId}.${start.deviceSecret}` } })).json();
      device = `${pairing.device.id}.${start.deviceSecret}`;
      for (const [k, pin] of [['writer', '9611'], ['outsider', '9612']]) {
        const r = await fetch(baseUrl + '/api/kiosk/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': device }, body: JSON.stringify({ userId: uid(k), pin }) });
        assert.equal(r.status, 200); tokens[k === 'writer' ? 'kiosk' : 'kioskOther'] = (await r.json()).token;
      }
      await connect('kiosk', tokens.kiosk, true);
      // R/Q: public reply is personal, deduplicated with a tag; @All never inherited.
      const publicNote = await create('writer', { content: '  original\n  words ' + 'x'.repeat(180), mentionAll: true });
      await clearPush(); clearSockets();
      const replyBody = { replyToId: publicNote.id, mentions: [uid('writer')], operationId: `reply-t96-${ts}` };
      const reply = await create('author', replyBody);
      assert.equal(reply.replyTo.id, publicNote.id); assert.equal(reply.replyTo.text.length, 140);
      assert.ok(reply.replyTo.text.endsWith('…')); assert.ok(!/\s{2}|\n/.test(reply.replyTo.text));
      await expectPush(['writer'], /^💬 author replied to you · Park Deli$/);
      const retry = await create('author', replyBody);
      assert.equal(retry.id, reply.id); assert.equal(retry.replyTo.text, reply.replyTo.text);
      await expectPush(['writer'], /^💬 author replied to you · Park Deli$/);
      assert.equal((await find('outsider', reply.id)).replyTo.text, reply.replyTo.text);
      const publicAudience = ['author', 'writer', 'outsider', 'added', 'admin', 'readerAdmin', 'coord', 'kiosk'];
      await socketAudience(reply.id, 'HANDOFF_NOTE', publicAudience);
      for (const k of publicAudience) {
        const s = sockets[k];
        const n = s.messages.find((m) => m.type === 'HANDOFF_NOTE' && m.payload?.note?.id === reply.id)?.payload.note;
        assert.equal(n.replyTo.text, reply.replyTo.text);
      }
      await clearPush();
      await create('author', { replyToId: publicNote.id });
      await expectPush(['writer'], /^💬 author replied to you · Park Deli$/);
      const stored = (await ctx.getDoc()).handoffNotes.find((n) => n.id === reply.id);
      assert.ok(!('text' in stored.replyTo) && !('deleted' in stored.replyTo), 'quote text must not persist');
      const voice = await create('writer', { content: '', voiceNoteData: 'data:audio/webm;base64,AA==' });
      assert.equal((await create('author', { replyToId: voice.id })).replyTo.text, '🎤 Voice note');
      await rejected('author', { replyToId: 'x'.repeat(201) });
      await rejected('author', { threadId: publicNote.id });
      await rejected('author', { replyToId: publicNote.id, venueId: otherVenue }, [403]);
      const otherNote = await create('other', { venueId: otherVenue });
      await rejected('author', { replyToId: otherNote.id });
      await remove('writer', publicNote.id);
      const gone = (await find('author', reply.id)).replyTo;
      assert.equal(gone.deleted, true); assert.ok(!('text' in gone));
      // P: private reply creates a root, automatically admitting the public writer.
      const source = await create('writer', { content: 'public anchor' });
      await clearPush(); clearSockets();
      const root = await create('author', { replyToId: source.id, private: true, content: 'private original secret', voiceNoteData: 'data:audio/webm;base64,AA==' });
      assert.equal(root.private, true); assert.ok(!root.threadId);
      assert.ok(root.mentions.some((m) => m.id === uid('writer')));
      assert.equal(root.replyTo.text, 'public anchor');
      const originalAudience = ['author', 'writer', 'admin', 'readerAdmin', 'coord'];
      await audience(root.id, originalAudience);
      await socketAudience(root.id, 'HANDOFF_NOTE', originalAudience);
      await expectPush(['writer'], /^🔒 author replied to you \(private\) · Park Deli$/, root.content);
      await rejected('writer', { replyToId: root.id });
      await rejected('writer', { replyToId: root.id, private: true });
      await rejected('author', { threadId: root.id, mentionAll: true });
      await rejected('outsider', { threadId: root.id }, [403, 404]);
      await rejected('author', { threadId: root.id, replyToId: source.id });
      for (const body of [{ replyToId: source.id }, { threadId: root.id }]) {
        const r = await request(tokens.kiosk, 'POST', '/api/handoff-notes', { venueId, content: 'kiosk', ...body }, true);
        assert.ok([400, 403].includes(r.status));
      }
      // T: forced private, root-bound quotes, only members alerted.
      await clearPush(); clearSockets();
      const first = await create('author', { threadId: root.id, replyToId: root.id, private: false });
      assert.equal(first.private, true); assert.equal(first.threadId, root.id);
      assert.equal(first.replyTo.text, root.content);
      await audience(first.id, originalAudience);
      await socketAudience(first.id, 'HANDOFF_NOTE', originalAudience);
      await expectPush(['writer'], /^🔒 author replied \(private\) · Park Deli$/);
      const mediaId = `media-t96-${ts}`;
      const media = await ctx.api('POST', '/api/__test__/media/seed-doc', { id: mediaId, agencyId, venueId,
        state: 'COMMITTED', attachedTo: { entityType: 'handoff-note', entityId: first.id } });
      if (media.status === 200) {
        assert.equal((await request('outsider', 'GET', `/api/media/${mediaId}/download`)).status, 404);
        const memberMedia = await request('writer', 'GET', `/api/media/${mediaId}/download`);
        assert.ok(![403, 404].includes(memberMedia.status));
      } else console.log(`  (media seed unavailable here: ${media.status})`);
      await rejected('writer', { replyToId: first.id });
      await rejected('author', { threadId: root.id, mentions: [uid('other')] });
      await rejected('author', { threadId: root.id, mentions: [uid('foreign')] });
      const unrelated = await create('writer', { private: true, mentions: [uid('author')] });
      await rejected('author', { threadId: root.id, replyToId: unrelated.id });
      // Privileged readers get no alerts until they write and become members.
      await find('readerAdmin', root.id);
      await create('admin', { threadId: root.id });
      await create('coord', { threadId: root.id });
      await clearPush();
      await create('author', { threadId: root.id });
      await expectPush(['writer', 'admin', 'coord'], /^🔒 author replied \(private\) · Park Deli$/);
      const joined = await find('author', root.id);
      assert.ok(joined.members.some((m) => m.id === uid('admin')));
      assert.ok(joined.members.some((m) => m.id === uid('coord')));
      assert.ok(!joined.members.some((m) => m.id === uid('readerAdmin')));
      // A: additions reveal the whole history; updated root broadcast reaches new member.
      await clearPush(); clearSockets();
      const addReply = await create('author', { threadId: root.id, mentions: [uid('added')], replyToId: first.id });
      await audience(addReply.id, [...originalAudience, 'added']);
      for (const id of [root.id, first.id]) assert.ok(await find('added', id), `added sees history ${id}`);
      await socketAudience(root.id, 'HANDOFF_NOTE', [...originalAudience, 'added']);
      const addedPushes = await pushes();
      assert.deepEqual(addedPushes.map((p) => p.endpoint).sort(), ['writer', 'admin', 'coord', 'added'].map(endpoint).sort());
      assert.equal(addedPushes.find((p) => p.endpoint === endpoint('added')).title, '🔒 author added you to a private conversation · Park Deli');
      assert.ok(addedPushes.every((p) => p.body === 'reply text'));
      // K/S: one unread reply after all older notes read, then zero; invisible marks refused.
      const before = (await list('writer')).notes.filter((n) => n.private).map((n) => n.id);
      assert.equal((await mark('writer', before)).status, 200);
      await clearPush();
      const unread = await create('author', { threadId: root.id });
      await expectPush(['writer', 'admin', 'coord', 'added'], /^🔒 author replied \(private\) · Park Deli$/);
      assert.equal((await list(tokens.kiosk, true)).privateForYou, 1);
      assert.equal((await list(tokens.kioskOther, true)).privateForYou, 0);
      assert.ok(!('privateForYou' in await list('writer')));
      assert.equal((await mark('outsider', [unread.id])).data.recorded, 0);
      const seenPath = `/api/handoff-notes/${unread.id}/seen?venueId=${venueId}`;
      assert.equal((await request('outsider', 'GET', seenPath)).status, 404);
      assert.equal((await mark('writer', [unread.id])).data.recorded, 1);
      assert.equal((await list(tokens.kiosk, true)).privateForYou, 0);
      const seen = await request('added', 'GET', seenPath);
      assert.equal(seen.status, 200); assert.equal(seen.data.total, 4);
      assert.deepEqual(seen.data.seen.map((p) => p.name), ['writer']);
      assert.deepEqual(seen.data.notYet.map((p) => p.name).sort(), ['added', 'admin', 'coord']);
      // Quotes on root broadcasts also reflect a public source removed meanwhile.
      await remove('writer', source.id); clearSockets();
      await create('author', { threadId: root.id });
      await socketAudience(root.id, 'HANDOFF_NOTE', [...originalAudience, 'added']);
      for (const k of [...originalAudience, 'added']) {
        const q = sockets[k].messages.find((m) => m.type === 'HANDOFF_NOTE' && m.payload?.note?.id === root.id).payload.note.replyTo;
        assert.equal(q.deleted, true); assert.ok(!('text' in q));
      }
      // D/Q: root tombstone retains replies and audience, erases text/voice and current quotes.
      clearSockets();
      await remove('author', root.id);
      await audience(root.id, [...originalAudience, 'added']);
      await socketAudience(root.id, 'HANDOFF_NOTE', [...originalAudience, 'added']);
      const tombstone = await find('added', root.id);
      assert.equal(tombstone.deleted, true); assert.equal(tombstone.content, ''); assert.ok(!tombstone.voiceNoteData);
      assert.ok(tombstone.deletedAt); assert.ok(await find('writer', first.id));
      const deadQuote = (await find('added', first.id)).replyTo;
      assert.equal(deadQuote.deleted, true); assert.ok(!('text' in deadQuote));
      assert.ok(!JSON.stringify(await list('added')).includes('private original secret'));
      assert.ok(!JSON.stringify((await ctx.getDoc()).handoffNotes).includes('private original secret'));
      await rejected('author', { threadId: root.id, replyToId: root.id }, [409]);
      // A tombstone is still a conversation: writing without quoting it remains possible.
      assert.equal((await create('writer', { threadId: root.id })).threadId, root.id);
      assert.equal((await request('outsider', 'DELETE', `/api/handoff-notes/${first.id}`)).status, 403);
      clearSockets(); await remove('author', first.id);
      await socketAudience(first.id, 'HANDOFF_NOTE_DELETED', [...originalAudience, 'added']);
      assert.ok(!await find('writer', first.id));
      const replyQuote = (await find('added', addReply.id)).replyTo;
      assert.equal(replyQuote.deleted, true); assert.ok(!('text' in replyQuote));
      for (const k of originalAudience) {
        const event = sockets[k].messages.find((m) => m.type === 'HANDOFF_NOTE_DELETED' && m.payload.id === first.id);
        assert.equal(event.payload.threadId, root.id);
      }
      assert.ok(!JSON.stringify(sockets.kiosk.messages).includes(root.id));
      // Roots without replies still disappear; ordinary public delete keeps its response.
      const emptyRoot = await create('author', { private: true, mentions: [uid('writer')] });
      await remove('author', emptyRoot.id);
      assert.ok(!await find('writer', emptyRoot.id));
      // Missing roots fail closed even when the orphan claims a mention/author.
      const orphanId = `orphan-t96-${ts}`;
      assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { handoffNotes: [{
        id: orphanId, agencyId, venueId, authorId: uid('writer'), authorEmail: `${uid('writer')}@test.local`,
        authorName: 'writer', mentions: [{ id: uid('outsider'), name: 'outsider' }], private: true,
        threadId: 'missing-root', content: 'orphan secret', shift: 'General', createdAt: new Date().toISOString(),
      }] })).status, 200);
      await audience(orphanId, ['admin', 'readerAdmin', 'coord']);
      assert.equal((await list(tokens.kioskOther, true)).privateForYou, 0);
      assert.equal((await request('writer', 'GET', `/api/handoff-notes/${orphanId}/seen?venueId=${venueId}`)).status, 404);
      // The quoted writer must still be taggable when starting a new private root.
      const departed = await create('added', { content: 'before moving' });
      const expectedVersion = await ctx.getVersion();
      assert.equal((await request('admin', 'PUT', `/api/users/${uid('added')}?expectedVersion=${expectedVersion}`,
        { venueId: otherVenue, expectedVersion })).status, 200);
      await rejected('author', { replyToId: departed.id, private: true });
      return 'R/Q/P/T/A/D/K/S: quote freshness, membership, personal pushes, REST/socket isolation, tombstones, kiosk unread and seen-by passed';
    } finally {
      for (const s of Object.values(sockets)) s.ws.close();
    }
  },
};
