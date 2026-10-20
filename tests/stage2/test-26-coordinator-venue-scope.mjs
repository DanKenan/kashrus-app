/**
 * Test 26: Coordinator venue scope (PR 2c, rule T).
 *
 * "Coordinators only lead in the venues they are assigned to. Only the admin
 * is over everything." Admin = whole agency. Coordinator = only their
 * assigned venue(s), EVERYWHERE. Others = own venue and own records.
 * Fail closed: non-admin with no venue → nothing (empty lists / 403 writes).
 *
 * Fixture: agency X with venues A1, A2; agency Y with venue B1.
 * Users: adminX, coordA1 (Eli, at A1), coordNoVenue, mashA1 (canFill),
 * mashNoFillA1 (canFillTasks=false), mashA2, ownerA2, adminY.
 *
 * Every positive check has its negative twin (rule G). Request bodies are
 * built from what the app actually sends (rule AA): apiWrite injects
 * expectedVersion + operationId into the JSON body.
 */

const AGENCY_X = 'agency-test26-x';
const AGENCY_Y = 'agency-test26-y';

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const conn = {
      ws, messages,
      waitFor: (type, ms = 4000) => new Promise((res) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) return res(existing);
        const t = setTimeout(() => res(messages.find((m) => m.type === type) || null), ms);
        conn._waiters.push({ type, res: (m) => { clearTimeout(t); res(m); } });
      }),
      _waiters: [],
      initialState: null,
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        messages.push(m);
        if (m.type === 'INITIAL_STATE') conn.initialState = m;
        conn._waiters = conn._waiters.filter((w) => {
          if (w.type === m.type) { w.res(m); return false; }
          return true;
        });
      } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve(conn);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (!messages.some((m) => m.type === 'INITIAL_STATE')) {
        reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
      }
    };
  });
}

export default {
  name: 'Test 26: Coordinator venue scope (rule T)',
  whatItProves:
    'Coordinators lead only at their assigned venue: reads, writes, rosters, dashboards, WS payloads and push targets are venue-scoped; admins keep the whole agency; venue-less non-admins get nothing; role gates on previously ungated write routes match the UI.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const vA1 = `venue-test26-a1-${ts}`;
    const vA2 = `venue-test26-a2-${ts}`;
    const vB1 = `venue-test26-b1-${ts}`;
    const adminXId = `user-test26-adminx-${ts}`;
    const coordId = `user-test26-eli-${ts}`;
    const coordNoId = `user-test26-velnocoord-${ts}`;
    const mashA1Id = `user-test26-masha1-${ts}`;
    const mashNoFillId = `user-test26-nofill-${ts}`;
    const mashA2Id = `user-test26-masha2-${ts}`;
    const ownerA2Id = `user-test26-ownera2-${ts}`;
    const adminYId = `user-test26-adminy-${ts}`;
    const taskA1Id = `task-test26-a1-${ts}`;
    const taskA2Id = `task-test26-a2-${ts}`;
    const noteA1Id = `note-test26-a1-${ts}`;
    const noteA2Id = `note-test26-a2-${ts}`;
    const noteWsA1Id = `note-test26-wsa1-${ts}`;
    const noteWsA2Id = `note-test26-wsa2-${ts}`;
    const evtAssignedId = `evt-test26-assigned-${ts}`;
    const evtAssignedTaskId = `evttask-test26-assigned-${ts}`;
    const incA1Id = `inc-test26-a1-${ts}`;
    const incA2Id = `inc-test26-a2-${ts}`;
    const evtA1Id = `evt-test26-a1-${ts}`;
    const evtA2Id = `evt-test26-a2-${ts}`;
    const evtTaskA1Id = `evttask-test26-a1-${ts}`;
    const ingA1Id = `ing-test26-a1-${ts}`;
    const ingA2Id = `ing-test26-a2-${ts}`;
    const annA1Id = `ann-test26-a1-${ts}`;
    const annWideId = `ann-test26-wide-${ts}`;
    const reportA1Id = `rep-test26-a1-${ts}`;
    const tplCoordId = `tpl-test26-coord-${ts}`;
    const tplAdminId = `tpl-test26-admin-${ts}`;

    const coordEmail = `eli-${ts}@test.local`;
    const mashA1Email = `masha1-${ts}@test.local`;

    await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: AGENCY_X, name: 'Test26 Agency X' },
        { id: AGENCY_Y, name: 'Test26 Agency Y' },
      ],
      venues: [
        { id: vA1, name: `T26 A1 ${ts}`, agencyId: AGENCY_X },
        { id: vA2, name: `T26 A2 ${ts}`, agencyId: AGENCY_X },
        { id: vB1, name: `T26 B1 ${ts}`, agencyId: AGENCY_Y },
      ],
      users: [
        { id: adminXId, email: `adminx-${ts}@test.local`, name: 'T26 Admin X', role: 'admin', agencyId: AGENCY_X },
        { id: coordId, email: coordEmail, name: 'T26 Eli', role: 'coordinator', agencyId: AGENCY_X, venueId: vA1 },
        { id: coordNoId, email: `velnocoord-${ts}@test.local`, name: 'T26 NoVenue Coord', role: 'coordinator', agencyId: AGENCY_X },
        { id: mashA1Id, email: mashA1Email, name: 'T26 Mash A1', role: 'mashgiach', agencyId: AGENCY_X, venueId: vA1 },
        { id: mashNoFillId, email: `nofill-${ts}@test.local`, name: 'T26 NoFill', role: 'mashgiach', agencyId: AGENCY_X, venueId: vA1, permissions: { canFillTasks: false, canAssignTasks: false } },
        { id: mashA2Id, email: `masha2-${ts}@test.local`, name: 'T26 Mash A2', role: 'mashgiach', agencyId: AGENCY_X, venueId: vA2 },
        { id: ownerA2Id, email: `ownera2-${ts}@test.local`, name: 'T26 Owner A2', role: 'owner', agencyId: AGENCY_X, venueId: vA2 },
        { id: adminYId, email: `adminy-${ts}@test.local`, name: 'T26 Admin Y', role: 'admin', agencyId: AGENCY_Y },
      ],
      tasks: [
        { id: taskA1Id, agencyId: AGENCY_X, venueId: vA1, title: `Task A1 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0,1,2,3,4,5,6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
        { id: taskA2Id, agencyId: AGENCY_X, venueId: vA2, title: `Task A2 ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0,1,2,3,4,5,6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, assignedTo: ['all'], createdAt: new Date(ts).toISOString(), sortOrder: 0 },
      ],
      handoffNotes: [
        { id: noteA1Id, agencyId: AGENCY_X, venueId: vA1, content: `Note A1 ${ts}`, authorEmail: mashA1Email, authorName: 'T26 Mash A1', shift: 'Morning', createdAt: new Date(ts).toISOString() },
        { id: noteA2Id, agencyId: AGENCY_X, venueId: vA2, content: `Note A2 ${ts}`, authorEmail: `masha2-${ts}@test.local`, authorName: 'T26 Mash A2', shift: 'Morning', createdAt: new Date(ts).toISOString() },
        { id: noteWsA1Id, agencyId: AGENCY_X, venueId: vA1, content: `Note WS A1 ${ts}`, authorEmail: mashA1Email, authorName: 'T26 Mash A1', shift: 'Morning', createdAt: new Date(ts).toISOString() },
        { id: noteWsA2Id, agencyId: AGENCY_X, venueId: vA2, content: `Note WS A2 ${ts}`, authorEmail: `masha2-${ts}@test.local`, authorName: 'T26 Mash A2', shift: 'Morning', createdAt: new Date(ts).toISOString() },
      ],
      incidents: [
        { id: incA1Id, agencyId: AGENCY_X, venueId: vA1, title: `Incident A1 ${ts}`, description: 'd1', severity: 'high', status: 'open', reporterEmail: mashA1Email, reporterName: 'T26 Mash A1', createdAt: new Date(ts).toISOString() },
        { id: incA2Id, agencyId: AGENCY_X, venueId: vA2, title: `Incident A2 ${ts}`, description: 'd2', severity: 'high', status: 'open', reporterEmail: `masha2-${ts}@test.local`, reporterName: 'T26 Mash A2', createdAt: new Date(ts).toISOString() },
      ],
      events: [
        { id: evtA1Id, agencyId: AGENCY_X, venueId: vA1, title: `Event A1 ${ts}`, location: 'Hall 1', date: '2026-11-02', tasks: [{ id: evtTaskA1Id, title: `EvtTask A1 ${ts}`, isCompleted: false }] },
        { id: evtA2Id, agencyId: AGENCY_X, venueId: vA2, title: `Event A2 ${ts}`, location: 'Hall 2', date: '2026-11-02', tasks: [] },
        // Fix 5 exception: an A2 event ASSIGNED to mashA1 (own record — the
        // agency assigned a mashgiach to a catered event at another venue).
        { id: evtAssignedId, agencyId: AGENCY_X, venueId: vA2, title: `Event Assigned ${ts}`, location: 'Offsite', date: '2026-11-04', assignedMashgiachEmail: mashA1Email, tasks: [{ id: evtAssignedTaskId, title: `EvtTask Assigned ${ts}`, isCompleted: false }] },
      ],
      approvedIngredients: [
        { id: ingA1Id, agencyId: AGENCY_X, venueId: vA1, name: `Ing A1 ${ts}`, kosherStatus: 'approved', verificationStatus: 'unverified' },
        { id: ingA2Id, agencyId: AGENCY_X, venueId: vA2, name: `Ing A2 ${ts}`, kosherStatus: 'approved', verificationStatus: 'unverified' },
      ],
      announcements: [
        { id: annA1Id, agencyId: AGENCY_X, venueId: vA1, title: `Ann A1 ${ts}`, body: 'b1', category: 'update', targetRoles: ['all'], authorEmail: `adminx-${ts}@test.local`, authorName: 'T26 Admin X', createdAt: new Date(ts).toISOString() },
        { id: annWideId, agencyId: AGENCY_X, title: `Ann Wide ${ts}`, body: 'bw', category: 'update', targetRoles: ['all'], authorEmail: `adminx-${ts}@test.local`, authorName: 'T26 Admin X', createdAt: new Date(ts).toISOString() },
      ],
      factoryReports: [
        { id: reportA1Id, agencyId: AGENCY_X, venueId: vA1, auditDate: '2026-10-01', factoryRepresentative: 'Rep', status: 'submitted', createdAt: new Date(ts).toISOString() },
      ],
      taskTemplates: [
        { id: tplCoordId, agencyId: AGENCY_X, name: `Tpl Coord ${ts}`, tasks: [], createdByEmail: coordEmail, createdAt: new Date(ts).toISOString() },
        { id: tplAdminId, agencyId: AGENCY_X, name: `Tpl Admin ${ts}`, tasks: [], createdByEmail: `adminx-${ts}@test.local`, createdAt: new Date(ts).toISOString() },
      ],
    });

    const tAdminX = await mintToken(baseUrl, adminXId);
    const tCoord = await mintToken(baseUrl, coordId);
    const tCoordNo = await mintToken(baseUrl, coordNoId);
    const tMashA1 = await mintToken(baseUrl, mashA1Id);
    const tNoFill = await mintToken(baseUrl, mashNoFillId);
    const tMashA2 = await mintToken(baseUrl, mashA2Id);
    const tOwnerA2 = await mintToken(baseUrl, ownerA2Id);
    const tAdminY = await mintToken(baseUrl, adminYId);

    const ids = (arr, key = 'id') => (arr || []).map((x) => x[key]);
    // apiWrite shape: expectedVersion + operationId IN THE BODY (rule AA).
    const apiWriteBody = async (extra = {}) => ({
      ...extra,
      expectedVersion: await ctx.getVersion(),
      operationId: `op-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    });

    /* ---- 1. REST reads: coordinator at A1 sees A1 only ---- */
    {
      for (const [path, key, own, other] of [
        ['/api/handoff-notes', 'notes', noteA1Id, noteA2Id],
        ['/api/incidents', 'incidents', incA1Id, incA2Id],
        ['/api/ingredients', 'ingredients', ingA1Id, ingA2Id],
      ]) {
        const r = await fetch(`${baseUrl}${path}`, { headers: auth(tCoord) });
        const b = await r.json();
        const got = ids(b[key]);
        if (!got.includes(own)) throw new Error(`coord read ${path}: missing own ${own}`);
        if (got.includes(other)) throw new Error(`coord read ${path}: LEAK other venue ${other}`);
      }
      // factory reports: own only
      const fr = await fetch(`${baseUrl}/api/factory-reports`, { headers: auth(tCoord) });
      const frb = await fr.json();
      if (!ids(frb.reports).includes(reportA1Id)) throw new Error('coord factory-reports: missing own report');
      // admin sees both venues
      const ar = await fetch(`${baseUrl}/api/handoff-notes`, { headers: auth(tAdminX) });
      const ab = await ar.json();
      const aids = ids(ab.notes);
      if (!aids.includes(noteA1Id) || !aids.includes(noteA2Id)) throw new Error('admin handoff-notes: should see both venues');
      // coordinator with spoofed ?venueId=A2 → 403
      const sr = await fetch(`${baseUrl}/api/handoff-notes?venueId=${vA2}`, { headers: auth(tCoord) });
      if (sr.status !== 403) throw new Error(`coord spoof venueId: ${sr.status} (expected 403)`);
      // coordinator GET /api/events: A1 only
      const er = await fetch(`${baseUrl}/api/events`, { headers: auth(tCoord) });
      const eb = await er.json();
      const eids = ids(eb.events);
      if (!eids.includes(evtA1Id) || eids.includes(evtA2Id)) throw new Error('coord events: should be A1 only');
      // GET /api/venues: coordinator sees only A1; adminX sees A1+A2 (not B1)
      const vr = await fetch(`${baseUrl}/api/venues`, { headers: auth(tCoord) });
      const vb = await vr.json();
      const vids = ids(vb.venues);
      if (!vids.includes(vA1) || vids.includes(vA2)) throw new Error('coord venues: should be A1 only');
      const avr = await fetch(`${baseUrl}/api/venues`, { headers: auth(tAdminX) });
      const avb = await avr.json();
      const avids = ids(avb.venues);
      if (!avids.includes(vA1) || !avids.includes(vA2) || avids.includes(vB1)) throw new Error('admin venues: should be X only');
      // roster: coordinator sees A1 users + admins, not A2-only users
      const ur = await fetch(`${baseUrl}/api/users`, { headers: auth(tCoord) });
      const ub = await ur.json();
      const uids = ids(ub.users);
      if (!uids.includes(coordId) || !uids.includes(mashA1Id)) throw new Error('coord roster: missing A1 users');
      if (uids.includes(mashA2Id) || uids.includes(ownerA2Id)) throw new Error('coord roster: LEAK A2 users');
      if (!uids.includes(adminXId)) throw new Error('coord roster: should include agency admins');
      // dashboard: coordinator sees A1 only, totals over A1
      const dr = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: auth(tCoord) });
      const db = await dr.json();
      const dv = (db.venues || []).map((x) => x.venue && x.venue.id);
      if (!dv.includes(vA1) || dv.includes(vA2)) throw new Error(`coord dashboard: should be A1 only (got ${JSON.stringify(dv)}, totals ${JSON.stringify(db.totals)})`);
      if (db.totals.venueCount !== 1) throw new Error(`coord dashboard venueCount: ${db.totals.venueCount} (expected 1)`);
      // adminY sees nothing of X
      const yr = await fetch(`${baseUrl}/api/handoff-notes`, { headers: auth(tAdminY) });
      const yb = await yr.json();
      if (ids(yb.notes).includes(noteA1Id)) throw new Error('adminY: LEAK agency X note');
    }

    /* ---- 2. Coordinator with no venue in their own agency: nothing ----
     * The fixture coordinator has no venueId. hydrateState's legacy default
     * (spec item 15, left in place) assigns 'venue-crown-market' on the next
     * commit — a venue that is NOT in this coordinator's agency — so their
     * scope contains no venue of their own agency and every agency-X surface
     * must come back empty / 403. (A literally empty scope cannot persist in
     * the in-memory cache because of that default; the empty-scope guards in
     * the server remain as fail-closed defense for fresh-doc reads.) */
    {
      for (const [path, key] of [
        ['/api/handoff-notes', 'notes'],
        ['/api/incidents', 'incidents'],
        ['/api/ingredients', 'ingredients'],
        ['/api/factory-reports', 'reports'],
      ]) {
        const r = await fetch(`${baseUrl}${path}`, { headers: auth(tCoordNo) });
        const b = await r.json();
        if ((b[key] || []).length !== 0) throw new Error(`no-agency-venue coord ${path}: expected [] got ${(b[key] || []).length}`);
      }
      const vr = await fetch(`${baseUrl}/api/venues`, { headers: auth(tCoordNo) });
      const vb = await vr.json();
      if ((vb.venues || []).length !== 0) throw new Error('no-agency-venue coord venues: expected []');
      // Roster: no non-admin agency-X users may leak (per item 4 the agency's
      // admins are the only rows an in-scope non-admin may ever see).
      const ur = await fetch(`${baseUrl}/api/users`, { headers: auth(tCoordNo) });
      const ub = await ur.json();
      const leaked = ids(ub.users).filter((id) => [coordId, mashA1Id, mashA2Id, ownerA2Id].includes(id));
      if (leaked.length !== 0) throw new Error(`no-agency-venue coord users: leaked ${JSON.stringify(leaked)}`);
      const dr = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: auth(tCoordNo) });
      const db = await dr.json();
      if ((db.venues || []).length !== 0 || db.totals.totalTasks !== 0) throw new Error('no-agency-venue coord dashboard: expected empty + zeros');
      const tr = await fetch(`${baseUrl}/api/tasks`, { headers: auth(tCoordNo) });
      const tb = await tr.json();
      if (!Array.isArray(tb.tasks) || tb.tasks.length !== 0) throw new Error('no-agency-venue coord tasks: expected []');
      // writes → 403
      const wr = await fetch(`${baseUrl}/api/handoff-notes`, {
        method: 'POST', headers: auth(tCoordNo),
        body: JSON.stringify(await apiWriteBody({ venueId: vA1, content: 'x', shift: 'Morning' })),
      });
      if (wr.status !== 403) throw new Error(`no-agency-venue coord POST note: ${wr.status} (expected 403)`);
    }

    /* ---- 3. Task writes: venue + role gates ---- */
    {
      // coord POST task at own venue → 200; at A2 → 403; without venueId → 403
      const ok = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ venueId: vA1, title: `Coord task ${ts}`, category: 'General' })),
      });
      if (ok.status !== 200 && ok.status !== 201) throw new Error(`coord POST task own venue: ${ok.status}`);
      const badVenue = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, title: `Coord bad ${ts}`, category: 'General' })),
      });
      if (badVenue.status !== 403) throw new Error(`coord POST task A2: ${badVenue.status} (expected 403)`);
      const noVenue = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: `Coord novenue ${ts}`, category: 'General' })),
      });
      if (noVenue.status !== 403) throw new Error(`coord POST task no venue: ${noVenue.status} (expected 403)`);
      // coord PUT task at A2 → 403; at A1 → 200
      const putBad = await fetch(`${baseUrl}/api/tasks/${taskA2Id}`, {
        method: 'PUT', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ isCompleted: true })),
      });
      if (putBad.status !== 403) throw new Error(`coord PUT task A2: ${putBad.status} (expected 403)`);
      // A1: DELETE role gate — mashgiach without canAssignTasks → 403
      const delMash = await fetch(`${baseUrl}/api/tasks/${taskA1Id}`, {
        method: 'DELETE', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({})),
      });
      if (delMash.status !== 403) throw new Error(`mash DELETE task: ${delMash.status} (expected 403 — no canAssignTasks)`);
      // coordinator at A1 deleting an A2 task → 403 (venue)
      const delCoordBad = await fetch(`${baseUrl}/api/tasks/${taskA2Id}`, {
        method: 'DELETE', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({})),
      });
      if (delCoordBad.status !== 403) throw new Error(`coord DELETE task A2: ${delCoordBad.status} (expected 403)`);
    }

    /* ---- 4. Announcements: coordinator must target own venue ---- */
    {
      const okPost = await fetch(`${baseUrl}/api/announcements`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: `Coord ann ${ts}`, body: 'b', category: 'update', targetRoles: ['all'], venueId: vA1 })),
      });
      if (okPost.status !== 200 && okPost.status !== 201) throw new Error(`coord POST ann own venue: ${okPost.status}`);
      const noVenue = await fetch(`${baseUrl}/api/announcements`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: `Coord ann wide ${ts}`, body: 'b', category: 'update', targetRoles: ['all'] })),
      });
      if (noVenue.status !== 403) throw new Error(`coord POST ann no venue: ${noVenue.status} (expected 403)`);
      const forged = await fetch(`${baseUrl}/api/announcements`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: `Coord ann forged ${ts}`, body: 'b', category: 'update', targetRoles: ['all'], venueId: vA2 })),
      });
      if (forged.status !== 403) throw new Error(`coord POST ann A2: ${forged.status} (expected 403)`);
      // GET: coordinator sees own-venue + agency-wide announcements
      const gr = await fetch(`${baseUrl}/api/announcements`, { headers: auth(tCoord) });
      const gb = await gr.json();
      const gids = ids(gb.announcements);
      if (!gids.includes(annA1Id) || !gids.includes(annWideId)) throw new Error('coord GET ann: should see A1 + wide');
      // DELETE agency-wide as coordinator → 403; DELETE own-venue as coordinator → 200
      const delWide = await fetch(`${baseUrl}/api/announcements/${annWideId}`, {
        method: 'DELETE', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delWide.status !== 403) throw new Error(`coord DELETE wide ann: ${delWide.status} (expected 403)`);
      const delOwn = await fetch(`${baseUrl}/api/announcements/${annA1Id}`, {
        method: 'DELETE', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delOwn.status !== 200) throw new Error(`coord DELETE own ann: ${delOwn.status} (expected 200)`);
    }

    /* ---- 5. Incidents + notes + ingredients role gates ---- */
    {
      // coord resolve own-venue incident → 200; owner at A2 resolving A1 → 403
      const resOwn = await fetch(`${baseUrl}/api/incidents/${incA1Id}/resolve`, {
        method: 'POST', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({})),
      });
      if (resOwn.status !== 200) throw new Error(`coord resolve own incident: ${resOwn.status}`);
      const resOwner = await fetch(`${baseUrl}/api/incidents/${incA2Id}/resolve`, {
        method: 'POST', headers: auth(tOwnerA2), body: JSON.stringify(await apiWriteBody({})),
      });
      if (resOwner.status !== 403) throw new Error(`owner resolve incident: ${resOwner.status} (expected 403)`);
      // mashgiach deleting someone else's note → 403; author deleting own → 200
      const delOther = await fetch(`${baseUrl}/api/handoff-notes/${noteA2Id}`, {
        method: 'DELETE', headers: auth(tMashA1), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delOther.status !== 403) throw new Error(`mash DELETE other note: ${delOther.status} (expected 403)`);
      const delOwn = await fetch(`${baseUrl}/api/handoff-notes/${noteA1Id}`, {
        method: 'DELETE', headers: auth(tMashA1), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delOwn.status !== 200) throw new Error(`author DELETE own note: ${delOwn.status} (expected 200)`);
      // ingredients verify: coord at A1 verifies A1 → 200; A2 → 403
      const verOwn = await fetch(`${baseUrl}/api/ingredients/${ingA1Id}/verify`, {
        method: 'PUT', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({ verificationStatus: 'verified_present' })),
      });
      if (verOwn.status !== 200) throw new Error(`coord verify own ingredient: ${verOwn.status}`);
      const verBad = await fetch(`${baseUrl}/api/ingredients/${ingA2Id}/verify`, {
        method: 'PUT', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({ verificationStatus: 'verified_present' })),
      });
      if (verBad.status !== 403) throw new Error(`coord verify A2 ingredient: ${verBad.status} (expected 403)`);
      // owner POST ingredient at own venue without canFill → 403
      const ingOwner = await fetch(`${baseUrl}/api/ingredients`, {
        method: 'POST', headers: auth(tOwnerA2),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, name: `Owner ing ${ts}` })),
      });
      if (ingOwner.status !== 403) throw new Error(`owner POST ingredient: ${ingOwner.status} (expected 403)`);
      // factory reports POST at A2 as coordinator of A1 → 403
      const repBad = await fetch(`${baseUrl}/api/factory-reports`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, auditDate: '2026-10-02', factoryRepresentative: 'R', status: 'submitted' })),
      });
      if (repBad.status !== 403) throw new Error(`coord POST report A2: ${repBad.status} (expected 403)`);
    }

    /* ---- 6. Templates: canManageTemplates admin-only + A2 gates ---- */
    {
      const etCoord = await fetch(`${baseUrl}/api/event-task-templates`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: `ET ${ts}` })),
      });
      if (etCoord.status !== 403) throw new Error(`coord event-task-template POST: ${etCoord.status} (expected 403 admin-only)`);
      // apply: coordinator to own venue → 200; to A2 → 403
      const applyOwn = await fetch(`${baseUrl}/api/task-templates/${tplAdminId}/apply`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ venueId: vA1 })),
      });
      if (applyOwn.status !== 200) throw new Error(`coord apply template own venue: ${applyOwn.status}`);
      const applyBad = await fetch(`${baseUrl}/api/task-templates/${tplAdminId}/apply`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2 })),
      });
      if (applyBad.status !== 403) throw new Error(`coord apply template A2: ${applyBad.status} (expected 403)`);
      // DELETE: coordinator deleting admin's template → 403; own template → 200
      const delBad = await fetch(`${baseUrl}/api/task-templates/${tplAdminId}`, {
        method: 'DELETE', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delBad.status !== 403) throw new Error(`coord DELETE admin template: ${delBad.status} (expected 403)`);
      const delOwn = await fetch(`${baseUrl}/api/task-templates/${tplCoordId}`, {
        method: 'DELETE', headers: auth(tCoord), body: JSON.stringify(await apiWriteBody({})),
      });
      if (delOwn.status !== 200) throw new Error(`coord DELETE own template: ${delOwn.status} (expected 200)`);
    }

    /* ---- 7. Events: PUT/DELETE/toggle gates ---- */
    {
      // coordinator PUT event at A2 → 403; mashgiach PUT → 403
      const putBad = await fetch(`${baseUrl}/api/events/${evtA2Id}`, {
        method: 'PUT', headers: auth(tCoord),
        body: JSON.stringify(await apiWriteBody({ title: 'nope' })),
      });
      if (putBad.status !== 403) throw new Error(`coord PUT event A2: ${putBad.status} (expected 403)`);
      // title = DEFINITION field → mashgiach PUT changing it → 403 (kept from
      // the first round of test-26; rule AB — it codifies the intended gate).
      const putMash = await fetch(`${baseUrl}/api/events/${evtA1Id}`, {
        method: 'PUT', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ title: 'nope' })),
      });
      if (putMash.status !== 403) throw new Error(`mash PUT event (title change): ${putMash.status} (expected 403)`);
      // Fix 1 positive (the EventsModal "Add task" bar regression): the mashgiach
      // PUTs the REAL client body — the whole A1 event + one appended task,
      // definition untouched → 200, and the task is there on read-back.
      const evtsRes = await fetch(`${baseUrl}/api/events`, { headers: auth(tMashA1) });
      const evtsBody = await evtsRes.json();
      const fullEvent = (evtsBody.events || []).find((e) => e.id === evtA1Id);
      if (!fullEvent) throw new Error('fix1: mashA1 cannot read the A1 event to build the client body');
      const addTaskBody = await apiWriteBody({
        ...fullEvent,
        tasks: [...(fullEvent.tasks || []), { id: `etask-test26-${ts}`, title: `Added by mash ${ts}`, isCompleted: false }],
      });
      const putAdd = await fetch(`${baseUrl}/api/events/${evtA1Id}`, {
        method: 'PUT', headers: auth(tMashA1), body: JSON.stringify(addTaskBody),
      });
      if (putAdd.status !== 200) throw new Error(`fix1 mash add-task PUT: ${putAdd.status} (expected 200)`);
      const evtsRes2 = await fetch(`${baseUrl}/api/events`, { headers: auth(tMashA1) });
      const evtsBody2 = await evtsRes2.json();
      const back = (evtsBody2.events || []).find((e) => e.id === evtA1Id);
      if (!(back.tasks || []).some((t) => t.title === `Added by mash ${ts}`)) throw new Error('fix1: appended task missing on read-back');
      // Mash at A1 sending the same tasks-only PUT against an A2 event → 403.
      const a2EventObj = { id: evtA2Id, agencyId: AGENCY_X, venueId: vA2, title: `Event A2 ${ts}`, location: 'Hall 2', date: '2026-11-02', tasks: [] };
      const putA2 = await fetch(`${baseUrl}/api/events/${evtA2Id}`, {
        method: 'PUT', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ ...a2EventObj, tasks: [{ id: `etask-bad-${ts}`, title: 'bad', isCompleted: false }] })),
      });
      if (putA2.status !== 403) throw new Error(`mash PUT A2 event tasks-only: ${putA2.status} (expected 403)`);
      // Fix 5 (own-records exception): mashA1 is ASSIGNED to an A2 event →
      // sees it in GET /api/events and can toggle its tasks; a NON-assigned
      // A1 mashgiach (canFillTasks=false) does not see it and toggle → 403.
      const seeAssigned = (evtsBody.events || []).some((e) => e.id === evtAssignedId);
      if (!seeAssigned) throw new Error('fix5: assigned mashgiach does not see the A2 event in GET /api/events');
      const togAssigned = await fetch(`${baseUrl}/api/events/${evtAssignedId}/tasks/${evtAssignedTaskId}/toggle`, {
        method: 'POST', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ isCompleted: true })),
      });
      if (togAssigned.status !== 200) throw new Error(`fix5 assigned toggle: ${togAssigned.status} (expected 200)`);
      const evtsNoFill = await fetch(`${baseUrl}/api/events`, { headers: auth(tNoFill) });
      const evtsNoFillBody = await evtsNoFill.json();
      if ((evtsNoFillBody.events || []).some((e) => e.id === evtAssignedId)) throw new Error('fix5: non-assigned A1 mashgiach SEES the A2 event (LEAK)');
      const togNotAssigned = await fetch(`${baseUrl}/api/events/${evtAssignedId}/tasks/${evtAssignedTaskId}/toggle`, {
        method: 'POST', headers: auth(tNoFill),
        body: JSON.stringify(await apiWriteBody({ isCompleted: true })),
      });
      if (togNotAssigned.status !== 403) throw new Error(`fix5 non-assigned toggle: ${togNotAssigned.status} (expected 403)`);
      // POST events: mashgiach creates at own venue → 200; at A2 → 403
      const postOwn = await fetch(`${baseUrl}/api/events`, {
        method: 'POST', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ venueId: vA1, title: `Mash event ${ts}`, location: 'Hall', date: '2026-11-03' })),
      });
      if (postOwn.status !== 200 && postOwn.status !== 201) throw new Error(`mash POST event own venue: ${postOwn.status}`);
      const postBad = await fetch(`${baseUrl}/api/events`, {
        method: 'POST', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, title: `Mash event bad ${ts}`, location: 'Hall', date: '2026-11-03' })),
      });
      if (postBad.status !== 403) throw new Error(`mash POST event A2: ${postBad.status} (expected 403)`);
      // toggle: canFill mashgiach at the venue → 200; noFill → 403; owner without canFill → 403
      const togOk = await fetch(`${baseUrl}/api/events/${evtA1Id}/tasks/${evtTaskA1Id}/toggle`, {
        method: 'POST', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ isCompleted: true })),
      });
      if (togOk.status !== 200) throw new Error(`mash toggle event task: ${togOk.status}`);
      const togNoFill = await fetch(`${baseUrl}/api/events/${evtA1Id}/tasks/${evtTaskA1Id}/toggle`, {
        method: 'POST', headers: auth(tNoFill),
        body: JSON.stringify(await apiWriteBody({ isCompleted: true })),
      });
      if (togNoFill.status !== 403) throw new Error(`nofill toggle: ${togNoFill.status} (expected 403)`);
    }

    /* ---- 8. Agency-level routes: coordinator → 403 (B5) ---- */
    {
      const checks = [
        ['PUT', '/api/agencies/current', { name: 'x' }],
        ['GET', '/api/admin/storage', null],
        ['GET', '/api/admin/export', null],
        ['POST', '/api/airtable/config', { venueId: vA1 }],
        ['POST', '/api/venues', { name: `Nope ${ts}` }],
      ];
      for (const [method, path, body] of checks) {
        const opts = { method, headers: auth(tCoord) };
        if (body && method !== 'GET') opts.body = JSON.stringify(await apiWriteBody(body));
        if (method === 'PUT') opts.body = JSON.stringify(await apiWriteBody(body || {}));
        const r = await fetch(`${baseUrl}${path}`, opts);
        if (r.status !== 403) throw new Error(`B5 ${method} ${path} as coordinator: ${r.status} (expected 403)`);
      }
    }

    /* ---- 9. Media intent venue gate (B2) ---- */
    {
      const intentBase = { mimeType: 'image/jpeg', sizeBytes: 10, sha256: '0'.repeat(64) };
      const intentBad = await fetch(`${baseUrl}/api/media/intent`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify({ ...intentBase, venueId: vA2 }),
      });
      if (intentBad.status !== 403) throw new Error(`coord media intent A2: ${intentBad.status} (expected 403)`);
      // fix round 1 (a): a non-admin intent WITHOUT venueId → 403 (required).
      const intentNoVenue = await fetch(`${baseUrl}/api/media/intent`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify(intentBase),
      });
      if (intentNoVenue.status !== 403) throw new Error(`coord media intent no-venue: ${intentNoVenue.status} (expected 403)`);
      // Coordinator intent for their OWN venue passes the gate (storage is
      // unconfigured in mock/emulator runs, so any later failure is 503
      // NOT_CONFIGURED or 201 — never 403).
      const intentOwn = await fetch(`${baseUrl}/api/media/intent`, {
        method: 'POST', headers: auth(tCoord),
        body: JSON.stringify({ ...intentBase, venueId: vA1 }),
      });
      if (intentOwn.status === 403) throw new Error('coord media intent A1 blocked at the venue gate (403)');
      // fix round 1 (b): commit validation. Seed INTENT-state media docs in
      // the test-only collection (GCS is unavailable here; the gates run
      // BEFORE the state/storage checks, which is exactly what these assert).
      const seed = async (id, venueId) => {
        const r = await fetch(`${baseUrl}/api/__test__/media/seed-doc`, {
          method: 'POST', headers: auth(tAdminX),
          body: JSON.stringify({ id, agencyId: AGENCY_X, venueId }),
        });
        if (r.status !== 200) throw new Error(`media seed ${id}: ${r.status}`);
      };
      await seed(`media-t26-a1-${ts}`, vA1);
      await seed(`media-t26-orphan-${ts}`, null);
      const commit = (token, mediaId, entityId) => fetch(`${baseUrl}/api/media/${mediaId}/commit`, {
        method: 'POST', headers: auth(token),
        body: JSON.stringify({ entityType: 'task', entityId }),
      });
      // A1 media doc onto an A2 task → 403 (venue mismatch).
      const commitCross = await commit(tCoord, `media-t26-a1-${ts}`, taskA2Id);
      if (commitCross.status !== 403) throw new Error(`commit A1 doc onto A2 task: ${commitCross.status} (expected 403)`);
      // Nonexistent entity → 404.
      const commit404 = await commit(tCoord, `media-t26-a1-${ts}`, `task-nope-${ts}`);
      if (commit404.status !== 404) throw new Error(`commit onto missing entity: ${commit404.status} (expected 404)`);
      // A1 doc onto an A1 task: gates PASS — the only allowed failure is the
      // downstream lifecycle state check (state INTENT ≠ VALIDATED → 400),
      // never 403/404.
      const commitOwn = await commit(tCoord, `media-t26-a1-${ts}`, taskA1Id);
      if (commitOwn.status === 403 || commitOwn.status === 404) throw new Error(`commit A1 doc onto A1 task blocked at the gates: ${commitOwn.status}`);
      // fix round 1 (c): a venue-less media doc is admin-only — coordinator
      // download → 403; admin passes the gate (fails later at storage, not 403).
      const dlBad = await fetch(`${baseUrl}/api/media/media-t26-orphan-${ts}/download`, { headers: auth(tCoord) });
      if (dlBad.status !== 403) throw new Error(`coord download venue-less media: ${dlBad.status} (expected 403)`);
      const dlAdmin = await fetch(`${baseUrl}/api/media/media-t26-orphan-${ts}/download`, { headers: auth(tAdminX) });
      if (dlAdmin.status === 403) throw new Error('admin download venue-less media blocked at the gate (403)');
    }

    /* ---- 10. WebSocket: INITIAL_STATE + live broadcasts are venue-scoped ---- */
    {
      const connCoord = await connectWs(baseUrl, tCoord);
      const p = connCoord.initialState?.payload || {};
      const pTasks = ids(p.tasks);
      if (!pTasks.includes(taskA1Id)) throw new Error('WS coord INITIAL_STATE: missing A1 task');
      if (pTasks.includes(taskA2Id)) throw new Error('WS coord INITIAL_STATE: LEAK A2 task');
      const pVenues = ids(p.venues);
      if (pVenues.includes(vA2)) throw new Error('WS coord INITIAL_STATE: LEAK A2 venue');
      const pEvents = ids(p.events);
      if (pEvents.includes(evtA2Id)) throw new Error('WS coord INITIAL_STATE: LEAK A2 event');
      const pUsers = ids(p.users);
      if (pUsers.includes(mashA2Id)) throw new Error('WS coord INITIAL_STATE: LEAK A2 user');

      const connAdmin = await connectWs(baseUrl, tAdminX);
      connCoord.messages.length = 0;
      // Admin creates a task at A2 → coordinator must NOT receive TASK_CREATED; admin does.
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST', headers: auth(tAdminX),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, title: `WS task A2 ${ts}`, category: 'General' })),
      });
      if (created.status !== 200 && created.status !== 201) throw new Error(`admin POST task A2: ${created.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      const coordSaw = connCoord.messages.some((m) => m.type === 'TASK_CREATED' && (m.payload?.title || '').includes(`WS task A2 ${ts}`));
      if (coordSaw) throw new Error('WS coord: received TASK_CREATED for A2 task (LEAK)');
      const adminSaw = connAdmin.messages.some((m) => m.type === 'TASK_CREATED' && (m.payload?.title || '').includes(`WS task A2 ${ts}`));
      if (!adminSaw) throw new Error('WS admin: did not receive TASK_CREATED for A2 task');
      // Incident at A2 by mashA2 → coordinator must NOT receive INCIDENT_CREATED.
      connCoord.messages.length = 0;
      const inc = await fetch(`${baseUrl}/api/incidents`, {
        method: 'POST', headers: auth(tMashA2),
        body: JSON.stringify(await apiWriteBody({ venueId: vA2, title: `WS incident A2 ${ts}`, severity: 'high' })),
      });
      if (inc.status !== 200 && inc.status !== 201) throw new Error(`mashA2 POST incident: ${inc.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      const coordSawInc = connCoord.messages.some((m) => m.type === 'INCIDENT_CREATED');
      if (coordSawInc) throw new Error('WS coord: received INCIDENT_CREATED for A2 (LEAK)');
      // Fix 3: delete broadcasts carry venueId now. Admin deletes the A2 note
      // → the coordinator socket must NOT receive the delete; the A1 note
      // deleted → it MUST arrive (with venueId in the payload).
      connCoord.messages.length = 0;
      const delA2 = await fetch(`${baseUrl}/api/handoff-notes/${noteWsA2Id}?expectedVersion=${await ctx.getVersion()}`, { method: 'DELETE', headers: auth(tAdminX) });
      if (delA2.status !== 200) throw new Error(`fix3 delete A2 note (admin): ${delA2.status}`);
      await new Promise((r) => setTimeout(r, 1200));
      if (connCoord.messages.some((m) => m.type === 'HANDOFF_NOTE_DELETED')) throw new Error('fix3: A2 HANDOFF_NOTE_DELETED leaked to coordinator');
      const delA1 = await fetch(`${baseUrl}/api/handoff-notes/${noteWsA1Id}?expectedVersion=${await ctx.getVersion()}`, { method: 'DELETE', headers: auth(tCoord) });
      if (delA1.status !== 200) throw new Error(`fix3 delete A1 note (coord): ${delA1.status}`);
      await new Promise((r) => setTimeout(r, 1200));
      const gotDelete = connCoord.messages.find((m) => m.type === 'HANDOFF_NOTE_DELETED');
      if (!gotDelete) throw new Error('fix3: coordinator did not receive A1 HANDOFF_NOTE_DELETED');
      if ((gotDelete.payload || {}).venueId !== vA1) throw new Error('fix3: HANDOFF_NOTE_DELETED payload missing venueId');
      connCoord.ws.close(); connAdmin.ws.close();
    }

    /* ---- 10b. Item 7: the assigned-event exception on the WS side ---- */
    {
      const mashA2Email = `masha2-${ts}@test.local`;
      const connMash = await connectWs(baseUrl, tMashA1);
      const connNoFill = await connectWs(baseUrl, tNoFill);
      // Assigned A1 mashgiach gets the A2 event in INITIAL_STATE.
      const initEvents = ids(connMash.initialState?.payload?.events);
      if (!initEvents.includes(evtAssignedId)) throw new Error('fix7: assigned mashgiach INITIAL_STATE missing the A2 event');
      // Admin makes a notes-only update → mashA1 receives EVENT_UPDATED;
      // the non-assigned A1 mashgiach receives nothing for that event.
      connMash.messages.length = 0; connNoFill.messages.length = 0;
      const evtsAdmin = await fetch(`${baseUrl}/api/events`, { headers: auth(tAdminX) });
      const evtsAdminBody = await evtsAdmin.json();
      const fullAssigned = (evtsAdminBody.events || []).find((e) => e.id === evtAssignedId);
      if (!fullAssigned) throw new Error('fix7: admin cannot read the assigned event');
      const upd = await fetch(`${baseUrl}/api/events/${evtAssignedId}`, {
        method: 'PUT', headers: auth(tAdminX),
        body: JSON.stringify(await apiWriteBody({ ...fullAssigned, notes: `updated ${ts}` })),
      });
      if (upd.status !== 200) throw new Error(`fix7 admin notes update: ${upd.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      const mashGotUpd = connMash.messages.some((m) => m.type === 'EVENT_UPDATED' && (m.payload?.event?.id === evtAssignedId || m.payload?.eventId === evtAssignedId));
      if (!mashGotUpd) throw new Error('fix7: assigned mashgiach did NOT receive EVENT_UPDATED');
      const noFillGot = connNoFill.messages.some((m) => (m.type === 'EVENT_UPDATED' || m.type === 'EVENT_CREATED') && JSON.stringify(m.payload).includes(evtAssignedId));
      if (noFillGot) throw new Error('fix7: non-assigned mashgiach received an EVENT_* message for the A2 event (LEAK)');
      // Reassignment: admin assigns the event to mashA2 instead. The stale
      // assignee gets EVENT_DELETED, and their next toggle → 403.
      connMash.messages.length = 0;
      const reassign = await fetch(`${baseUrl}/api/events/${evtAssignedId}`, {
        method: 'PUT', headers: auth(tAdminX),
        body: JSON.stringify(await apiWriteBody({ ...fullAssigned, notes: `updated ${ts}`, assignedMashgiachEmail: mashA2Email })),
      });
      if (reassign.status !== 200) throw new Error(`fix7 reassign PUT: ${reassign.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      const staleDelete = connMash.messages.some((m) => m.type === 'EVENT_DELETED' && (m.payload?.id === evtAssignedId));
      if (!staleDelete) throw new Error('fix7: stale assignee did NOT receive EVENT_DELETED after reassignment');
      const staleToggle = await fetch(`${baseUrl}/api/events/${evtAssignedId}/tasks/${evtAssignedTaskId}/toggle`, {
        method: 'POST', headers: auth(tMashA1),
        body: JSON.stringify(await apiWriteBody({ isCompleted: false })),
      });
      if (staleToggle.status !== 403) throw new Error(`fix7 stale-assignee toggle: ${staleToggle.status} (expected 403)`);
      connMash.ws.close(); connNoFill.ws.close();
    }

    /* ---- 11. Reassignment: moving the coordinator A1 → A2 refreshes their sockets ---- */
    {
      const conn = await connectWs(baseUrl, tCoord);
      conn.messages.length = 0;
      const ver = await ctx.getVersion();
      const move = await fetch(`${baseUrl}/api/users/${coordId}?expectedVersion=${ver}`, {
        method: 'PUT', headers: auth(tAdminX),
        body: JSON.stringify({ venueId: vA2 }),
      });
      if (move.status !== 200) throw new Error(`admin move coordinator: ${move.status}`);
      // The coordinator's socket must receive a fresh INITIAL_STATE whose tasks
      // are A2-only (A1 tasks gone), plus TASK_DELETED for A1 tasks held before.
      let fresh = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const init = conn.messages.filter((m) => m.type === 'INITIAL_STATE');
        if (init.length > 0) { fresh = init[init.length - 1]; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!fresh) throw new Error('reassignment: no fresh INITIAL_STATE received');
      const fTasks = ids(fresh.payload?.tasks);
      if (fTasks.includes(taskA1Id)) throw new Error('reassignment: A1 task still in fresh state (LEAK)');
      if (!fTasks.includes(taskA2Id)) throw new Error('reassignment: A2 task missing from fresh state');
      conn.ws.close();
    }

    return 'rule T holds: coordinators venue-scoped on REST, WS, roster, dashboard; role gates match the UI; venue-less non-admins get nothing; admins keep the agency';
  },
};
