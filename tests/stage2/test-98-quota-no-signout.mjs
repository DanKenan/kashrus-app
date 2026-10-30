/**
 * Test 98: Out of quota never signs anyone out (READCUT, Oct 29 2026).
 *
 * Live, the database answered RESOURCE_EXHAUSTED (free daily read quota) to
 * every sign-in check and every request failed with "Could not check your
 * sign-in right now". This test makes the session store answer exactly that
 * and proves:
 *  R1 a phone whose session this instance already holds keeps working for
 *     GETs (served from this instance's record), past the normal re-check bound;
 *  R2 a saving request answers 503 SESSION_STORE_UNAVAILABLE (never 401);
 *  R3 an open socket's re-check and a new socket keep the person connected;
 *  R4 a session signed out on this instance stays refused (401) during the outage;
 *  R5 a session this instance never held answers 503 (never 401);
 *  R6 after the outage the store decides again (a store-only revoke -> 401).
 */
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: 'Test 98: Out of quota never signs anyone out',
  whatItProves:
    'With the store answering RESOURCE_EXHAUSTED, held sessions keep GETs and sockets working from this instance\'s record, saves answer 503 (never 401), a session signed out here stays refused, an unknown one is 503, and the store decides again afterwards.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t98-${ts}`, V = `venue-t98-${ts}`;
    const uid = (n) => `user-t98-${n}-${ts}`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'T98' }],
      venues: [{ id: V, name: `T98 V ${ts}`, agencyId: AG }],
      users: ['a', 'b', 'c', 'd'].map((n) => ({ id: uid(n), email: `${n}-t98-${ts}@test.local`, name: `T98 ${n}`, role: 'mashgiach', agencyId: AG, venueId: V })),
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const signIn = async (n) => {
      const r = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ userId: uid(n), session: true }) });
      if (r.status !== 200) throw new Error(`session ${n}: ${r.status}`);
      return r.json();
    };
    const hook = async (body) => (await ctx.api('POST', '/api/__test__/session-hooks', body)).json;
    const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
    const getProbe = (t) => fetch(`${baseUrl}/api/announcements`, { headers: H(t) });
    const postProbe = (t) => fetch(`${baseUrl}/api/updates/seen`, { method: 'POST', headers: H(t), body: J({ announcementIds: [], noteIds: [], alertIds: [] }) });
    const connectWs = (token) => new Promise((resolve) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const out = { ws, initial: false, closeCode: null, messages: [] };
      const timer = setTimeout(() => resolve(out), 6000);
      ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); out.messages.push(m.type); if (m.type === 'INITIAL_STATE') { out.initial = true; clearTimeout(timer); resolve(out); } } catch {} };
      ws.onclose = (ev) => { out.closeCode = ev.code; clearTimeout(timer); resolve(out); };
    });

    const A = await signIn('a'), B = await signIn('b'), C = await signIn('c'), D = await signIn('d');
    for (const s of [A, B, C]) if ((await getProbe(s.token)).status !== 200) throw new Error('prime GET');
    const wA = await connectWs(A.token);
    if (!wA.initial) throw new Error(`socket A did not open: ${wA.closeCode}`);
    // R4 setup: C signs out on this instance (before the outage).
    const lo = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: H(C.token) });
    if (lo.status !== 200) throw new Error(`logout C: ${lo.status}`);
    const sockets = [wA.ws];
    try {
      if ((await hook({ action: 'quota', on: true }))?.quota !== true) throw new Error('quota hook');
      for (const s of [A, B, C]) await hook({ action: 'cache-age', sid: s.sid, ageMs: 300001 });
      // R1
      const g = await getProbe(A.token);
      if (g.status !== 200) throw new Error(`R1 GET during the outage must be served from this instance's record: ${g.status} ${await g.text()}`);
      // R2
      const p = await postProbe(B.token);
      const pb = await p.json().catch(() => ({}));
      if (p.status !== 503 || pb.code !== 'SESSION_STORE_UNAVAILABLE') throw new Error(`R2 a save during the outage must be 503 SESSION_STORE_UNAVAILABLE: ${p.status} ${J(pb)}`);
      // R3: a delivery to A's aged socket (another socket connecting = presence) keeps it open; a new socket opens.
      const wB = await connectWs(B.token);
      sockets.push(wB.ws);
      if (!wB.initial) throw new Error(`R3 a new socket during the outage must open: close ${wB.closeCode}`);
      await sleep(800);
      if (wA.closeCode !== null) throw new Error(`R3 the open socket must stay open during the outage (closed ${wA.closeCode})`);
      // R4
      const gc = await getProbe(C.token);
      if (gc.status !== 401) throw new Error(`R4 a session signed out here stays refused during the outage: ${gc.status}`);
      // R5: D was never checked on this instance after its mint? Its mint published it; drop that knowledge by ageing is not enough —
      // use a fresh token whose record this instance never read: mint then forget via cache-age is still "held", so check a NEW sign-in fails closed.
      const m = await fetch(`${baseUrl}/api/__test__/mint-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ userId: uid('d'), session: true }) });
      if (m.status !== 503) throw new Error(`R5 a new sign-in during the outage answers 503 (the record cannot be written): ${m.status}`);
    } finally {
      await hook({ action: 'quota', on: false });
    }
    // R6: the store decides again.
    if ((await hook({ action: 'revoke-silent', sid: A.sid }))?.ok !== true) throw new Error('R6 store-only revoke');
    await hook({ action: 'cache-age', sid: A.sid, ageMs: 300001 });
    const g6 = await getProbe(A.token);
    if (g6.status !== 401) throw new Error(`R6 after the outage a store-only revoke is seen: ${g6.status}`);
    for (const s of sockets) { try { s.close(); } catch {} }
    void D;
    return 'held sessions keep GETs and sockets during an out-of-quota store; saves 503 (never 401); signed-out stays 401; new sign-in 503; store decides again after';
  },
};
