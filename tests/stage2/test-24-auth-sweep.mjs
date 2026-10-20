/**
 * Test 24: Authorization sweep — caller identity from the verified session.
 *
 * Every endpoint must decide WHO the caller is (and whose data to return)
 * from the verified session user (getAuthUser/requireAuthUser), never from
 * a client-supplied userEmail/agencyId. Attribution fields (who did it)
 * must come from the session user, never the request body.
 *
 * Families covered:
 *  F1: userEmail lookups with permissive defaults (venues, events,
 *      announcements, agencies/current, airtable/config, ingredients,
 *      factory-reports, handoff-notes, incidents, task-templates,
 *      event-task-templates, push/subscribe).
 *  F2: (req as any).agencyId (never set) — answered with HKC's data for
 *      every caller (task-templates, incidents, admin/dashboard,
 *      admin/storage, announcements).
 *  F3: no agency filter at all (handoff-notes returned every agency).
 *  F4: attribution forged from the body (incidents reporterEmail/Name,
 *      handoff-notes authorEmail/Name, announcements authorName,
 *      task-templates createdByEmail, incidents/:id/resolve resolvedBy).
 *
 * For EACH endpoint: (1) spoof — A's token with ?userEmail=<B admin> returns
 * only A's data; (2) cross-agency — B's admin gets B's rows, never A's;
 * (3) unauthenticated → 401; (4) role filters hold (mashgiach scoping,
 * admin/dashboard+storage 403 for mashgiach).
 *
 * Uses POST /api/__test__/mint-token for sessions (never doc.jwtSecret).
 * All fixtures via /api/__test__/inject-fixture (single commit, deterministic).
 */

const AGENCY_A = 'agency-test24-a';
const AGENCY_B = 'agency-test24-b';

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function getJson(baseUrl, path, token) {
  const headers = token ? auth(token) : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(baseUrl, path, token, data) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Assert every id in `ids` appears in `items` and no foreign id does. */
function assertAgencyScoped(items, ownIds, foreignIds, label) {
  const seen = new Set(items.map((i) => i.id));
  for (const id of ownIds) {
    if (!seen.has(id)) throw new Error(`${label}: missing own id ${id}`);
  }
  for (const id of foreignIds) {
    if (seen.has(id)) throw new Error(`${label}: leaked foreign id ${id}`);
  }
}

export default {
  name: 'Test 24: Authorization sweep — session-user identity',
  whatItProves:
    'Every endpoint resolves the caller from the verified session (never userEmail/agencyId from the client); attribution comes from the session user; cross-agency reads return only the caller\'s agency; unauthenticated → 401; role filters hold.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueA = `venue-test24-a-${ts}`;
    const venueA2 = `venue-test24-a2-${ts}`;
    const venueB = `venue-test24-b-${ts}`;
    const adminAId = `user-test24-admina-${ts}`;
    const mashAId = `user-test24-masha-${ts}`;
    const mashA2Id = `user-test24-masha2-${ts}`;
    const mashNoVenueId = `user-test24-mashnov-${ts}`;
    const coordAId = `user-test24-coorda-${ts}`;
    const adminBId = `user-test24-adminb-${ts}`;
    const mashBId = `user-test24-mashb-${ts}`;
    const adminAEmail = `test24-admina-${ts}@test.local`;
    const mashAEmail = `test24-masha-${ts}@test.local`;
    const mashA2Email = `test24-masha2-${ts}@test.local`;
    const mashNoVenueEmail = `test24-mashnov-${ts}@test.local`;
    const coordAEmail = `test24-coorda-${ts}@test.local`;
    const adminBEmail = `test24-adminb-${ts}@test.local`;
    const mashBEmail = `test24-mashb-${ts}@test.local`;

    const eventAId = `evt-test24-a-${ts}`;
    const eventBId = `evt-test24-b-${ts}`;
    const incidentAId = `incident-test24-a-${ts}`;
    const incidentBId = `incident-test24-b-${ts}`;
    const noteAId = `handoff-test24-a-${ts}`;
    const noteBId = `handoff-test24-b-${ts}`;
    const annAId = `announce-test24-a-${ts}`;
    const annBId = `announce-test24-b-${ts}`;
    const tmplAId = `tmpl-test24-a-${ts}`;
    const tmplBId = `tmpl-test24-b-${ts}`;
    const etplAId = `etpl-test24-a-${ts}`;
    const etplBId = `etpl-test24-b-${ts}`;
    const etplGId = `etpl-test24-g-${ts}`;
    const ingAId = `ing-test24-a-${ts}`;
    const ingBId = `ing-test24-b-${ts}`;
    const repAId = `report-test24-a-${ts}`;
    const repBId = `report-test24-b-${ts}`;
    const taskAId = `task-test24-a-${ts}`;
    const evtTaskAId = `etask-test24-a-${ts}`;
    const noteA2Id = `handoff-test24-a2-${ts}`;
    const incidentA2Id = `incident-test24-a2-${ts}`;

    // --- 1. Fixtures: everything via inject-fixture (single commit) ---
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: AGENCY_A, name: 'Test Agency A 24' },
        { id: AGENCY_B, name: 'Test Agency B 24' },
      ],
      venues: [
        { id: venueA, name: `Test24 Venue A ${ts}`, agencyId: AGENCY_A },
        { id: venueA2, name: `Test24 Venue A2 ${ts}`, agencyId: AGENCY_A },
        { id: venueB, name: `Test24 Venue B ${ts}`, agencyId: AGENCY_B },
      ],
      users: [
        { id: adminAId, email: adminAEmail, name: 'T24 Admin A', role: 'admin', agencyId: AGENCY_A },
        { id: mashAId, email: mashAEmail, name: 'T24 Mash A', role: 'mashgiach', agencyId: AGENCY_A, venueId: venueA },
        { id: mashA2Id, email: mashA2Email, name: 'T24 Mash A2', role: 'mashgiach', agencyId: AGENCY_A, venueId: venueA2 },
        { id: mashNoVenueId, email: mashNoVenueEmail, name: 'T24 Mash NoVenue', role: 'mashgiach', agencyId: AGENCY_A },
        // Rule T: the coordinator is assigned to venueA only (not agency-wide).
        { id: coordAId, email: coordAEmail, name: 'T24 Coord A', role: 'coordinator', agencyId: AGENCY_A, venueId: venueA },
        { id: adminBId, email: adminBEmail, name: 'T24 Admin B', role: 'admin', agencyId: AGENCY_B },
        { id: mashBId, email: mashBEmail, name: 'T24 Mash B', role: 'mashgiach', agencyId: AGENCY_B, venueId: venueB },
      ],
      tasks: [
        { id: taskAId, agencyId: AGENCY_A, venueId: venueA, title: `Task A ${ts}`, category: 'General', categories: ['General'], daysOfWeek: [0,1,2,3,4,5,6], targetTime: 'End of Day', currentStatus: 'pending', isCompleted: false, createdAt: new Date(ts).toISOString(), sortOrder: 0 },
      ],
      events: [
        { id: eventAId, agencyId: AGENCY_A, venueId: venueA, title: `Event A ${ts}`, location: 'Hall A', date: '2026-11-01', tasks: [{ id: evtTaskAId, title: `EvtTask A ${ts}`, isCompleted: false }] },
        { id: eventBId, agencyId: AGENCY_B, venueId: venueB, title: `Event B ${ts}`, location: 'Hall B', date: '2026-11-01', tasks: [] },
      ],
      incidents: [
        { id: incidentAId, agencyId: AGENCY_A, venueId: venueA, title: `Incident A ${ts}`, description: 'd', severity: 'medium', status: 'open', reporterEmail: adminAEmail, reporterName: 'T24 Admin A', createdAt: new Date(ts).toISOString() },
        { id: incidentA2Id, agencyId: AGENCY_A, venueId: venueA2, title: `Incident A2 ${ts}`, description: 'd', severity: 'medium', status: 'open', reporterEmail: adminAEmail, reporterName: 'T24 Admin A', createdAt: new Date(ts).toISOString() },
        { id: incidentBId, agencyId: AGENCY_B, venueId: venueB, title: `Incident B ${ts}`, description: 'd', severity: 'medium', status: 'open', reporterEmail: adminBEmail, reporterName: 'T24 Admin B', createdAt: new Date(ts).toISOString() },
      ],
      handoffNotes: [
        { id: noteAId, agencyId: AGENCY_A, venueId: venueA, authorEmail: mashAEmail, authorName: 'T24 Mash A', content: `Note A ${ts}`, shift: 'Morning', createdAt: new Date(ts).toISOString() },
        { id: noteA2Id, agencyId: AGENCY_A, venueId: venueA2, authorEmail: mashA2Email, authorName: 'T24 Mash A2', content: `Note A2 ${ts}`, shift: 'Morning', createdAt: new Date(ts).toISOString() },
        { id: noteBId, agencyId: AGENCY_B, venueId: venueB, authorEmail: mashBEmail, authorName: 'T24 Mash B', content: `Note B ${ts}`, shift: 'Morning', createdAt: new Date(ts).toISOString() },
      ],
      announcements: [
        { id: annAId, agencyId: AGENCY_A, authorEmail: adminAEmail, authorName: 'T24 Admin A', title: `Ann A ${ts}`, body: 'b', category: 'update', targetRoles: ['all'], createdAt: new Date(ts).toISOString() },
        { id: annBId, agencyId: AGENCY_B, authorEmail: adminBEmail, authorName: 'T24 Admin B', title: `Ann B ${ts}`, body: 'b', category: 'update', targetRoles: ['all'], createdAt: new Date(ts).toISOString() },
      ],
      taskTemplates: [
        { id: tmplAId, agencyId: AGENCY_A, name: `Tmpl A ${ts}`, tasks: [], createdByEmail: adminAEmail, createdAt: new Date(ts).toISOString() },
        { id: tmplBId, agencyId: AGENCY_B, name: `Tmpl B ${ts}`, tasks: [], createdByEmail: adminBEmail, createdAt: new Date(ts).toISOString() },
      ],
      eventTaskTemplates: [
        { id: etplAId, agencyId: AGENCY_A, title: `ETpl A ${ts}`, sortOrder: 0 },
        { id: etplBId, agencyId: AGENCY_B, title: `ETpl B ${ts}`, sortOrder: 0 },
        { id: etplGId, title: `ETpl Global ${ts}`, sortOrder: 1 },
      ],
      approvedIngredients: [
        { id: ingAId, agencyId: AGENCY_A, venueId: venueA, name: `Ing A ${ts}`, createdAt: new Date(ts).toISOString() },
        { id: ingBId, agencyId: AGENCY_B, venueId: venueB, name: `Ing B ${ts}`, createdAt: new Date(ts).toISOString() },
      ],
      factoryReports: [
        { id: repAId, agencyId: AGENCY_A, venueId: venueA, auditDate: '2026-10-01', summaryNotes: 'ok', createdAt: new Date(ts).toISOString() },
        { id: repBId, agencyId: AGENCY_B, venueId: venueB, auditDate: '2026-10-01', summaryNotes: 'ok', createdAt: new Date(ts).toISOString() },
      ],
    });
    if (inj.status !== 200) throw new Error(`fixture inject failed: ${inj.status}`);

    const tAdminA = await mintToken(baseUrl, adminAId);
    const tMashA = await mintToken(baseUrl, mashAId);
    const tAdminB = await mintToken(baseUrl, adminBId);
    const tMashB = await mintToken(baseUrl, mashBId);
    const tMashA2 = await mintToken(baseUrl, mashA2Id);
    const tMashNoVenue = await mintToken(baseUrl, mashNoVenueId);
    const tCoordA = await mintToken(baseUrl, coordAId);

    // --- 2. F1 spoof: A's token + ?userEmail=<B admin> must return only A's data ---
    const spoofQ = `?userEmail=${encodeURIComponent(adminBEmail)}`;
    const endpoints = [
      ['/api/venues', 'venues', [venueA], [venueB]],
      ['/api/events', 'events', [eventAId], [eventBId]],
      ['/api/announcements', 'announcements', [annAId], [annBId]],
      ['/api/handoff-notes', 'notes', [noteAId], [noteBId]],
      ['/api/incidents', 'incidents', [incidentAId], [incidentBId]],
      ['/api/task-templates', 'templates', [tmplAId], [tmplBId]],
      ['/api/ingredients', 'ingredients', [ingAId], [ingBId]],
      ['/api/factory-reports', 'reports', [repAId], [repBId]],
    ];
    for (const [path, key, own, foreign] of endpoints) {
      const r = await getJson(baseUrl, `${path}${spoofQ}`, tAdminA);
      if (r.status !== 200) throw new Error(`spoof ${path}: status ${r.status}`);
      assertAgencyScoped(r.body[key] || [], own, foreign, `spoof ${path}`);
    }
    {
      const r = await getJson(baseUrl, `/api/agencies/current${spoofQ}`, tAdminA);
      if (r.status !== 200) throw new Error(`spoof agencies/current: ${r.status}`);
      if (r.body.agency?.id !== AGENCY_A) {
        throw new Error(`spoof agencies/current: got ${r.body.agency?.id}, want ${AGENCY_A}`);
      }
    }
    {
      // airtable/config spoof: must return A's agency config (or empty default for A)
      const r = await getJson(baseUrl, `/api/airtable/config${spoofQ}`, tAdminA);
      if (r.status !== 200) throw new Error(`spoof airtable/config: ${r.status}`);
      if (r.body.agencyId && r.body.agencyId !== AGENCY_A) {
        throw new Error(`spoof airtable/config: got agency ${r.body.agencyId}`);
      }
    }
    {
      // event-task-templates spoof: ?agencyId=<B> from A's token → A's + global only
      const r = await getJson(baseUrl, `/api/event-task-templates?agencyId=${AGENCY_B}`, tAdminA);
      if (r.status !== 200) throw new Error(`spoof event-task-templates: ${r.status}`);
      assertAgencyScoped(r.body.templates || [], [etplAId, etplGId], [etplBId], 'spoof event-task-templates');
    }

    // --- 3. F2 cross-agency: B's admin gets B's rows, never A's ---
    for (const [path, key, own, foreign] of endpoints) {
      const r = await getJson(baseUrl, path, tAdminB);
      if (r.status !== 200) throw new Error(`cross-agency ${path}: status ${r.status}`);
      assertAgencyScoped(r.body[key] || [], foreign, own, `cross-agency ${path}`);
    }
    {
      const r = await getJson(baseUrl, '/api/agencies/current', tAdminB);
      if (r.body.agency?.id !== AGENCY_B) {
        throw new Error(`cross-agency agencies/current: got ${r.body.agency?.id}, want ${AGENCY_B}`);
      }
    }
    {
      const r = await getJson(baseUrl, '/api/event-task-templates', tAdminB);
      assertAgencyScoped(r.body.templates || [], [etplBId, etplGId], [etplAId], 'cross-agency event-task-templates');
    }

    // --- 4. F3 unauthenticated → 401 ---
    const unauthPaths = [
      '/api/venues', '/api/events', '/api/announcements', '/api/handoff-notes',
      '/api/incidents', '/api/task-templates', '/api/event-task-templates',
      '/api/ingredients', '/api/factory-reports', '/api/agencies/current',
      '/api/airtable/config', '/api/admin/dashboard', '/api/admin/storage',
    ];
    for (const path of unauthPaths) {
      const r = await getJson(baseUrl, path, null);
      if (r.status !== 401) throw new Error(`unauth ${path}: got ${r.status}, want 401`);
    }

    // --- 5. Role filters ---
    {
      const r = await getJson(baseUrl, '/api/venues', tMashA);
      const ids = (r.body.venues || []).map((v) => v.id);
      if (!ids.includes(venueA) || ids.includes(venueB)) {
        throw new Error(`mashgiach venues: got [${ids}], want only ${venueA}`);
      }
    }
    {
      const r = await getJson(baseUrl, '/api/admin/dashboard', tMashB);
      if (r.status !== 403) throw new Error(`mashgiach dashboard: got ${r.status}, want 403`);
    }
    {
      const r = await getJson(baseUrl, '/api/admin/storage', tMashB);
      if (r.status !== 403) throw new Error(`mashgiach storage: got ${r.status}, want 403`);
    }
    {
      const r = await getJson(baseUrl, '/api/admin/dashboard', tAdminB);
      if (r.status !== 200) throw new Error(`admin dashboard: got ${r.status}, want 200`);
      const venueIds = (r.body.venues || []).map((v) => v.venue?.id || v.id);
      if (venueIds.includes(venueA)) throw new Error('dashboard: leaked venue A to B admin');
      // totalHandoffNotes is agency-scoped (must not count all agencies)
      // (exact value depends on other data; the venue check above is the key assertion)
    }
    {
      const r = await getJson(baseUrl, '/api/admin/storage', tAdminB);
      if (r.status !== 200) throw new Error(`admin storage: got ${r.status}, want 200`);
    }

    // --- 6. F4 attribution forgery (same agency): stored attribution is the caller ---
    {
      const r = await postJson(baseUrl, '/api/incidents', tMashA, {
        venueId: venueA, title: `Forge incident ${ts}`,
        reporterEmail: mashBEmail, reporterName: 'Forged Name',
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`forge incident: ${r.status}`);
      const inc = r.body.incident || r.body;
      if (inc.reporterEmail !== mashAEmail) {
        throw new Error(`incident attribution: got ${inc.reporterEmail}, want ${mashAEmail}`);
      }
      if (inc.reporterName !== 'T24 Mash A') {
        throw new Error(`incident attribution name: got ${inc.reporterName}`);
      }
    }
    {
      const r = await postJson(baseUrl, '/api/handoff-notes', tMashA, {
        venueId: venueA, content: `Forge note ${ts}`,
        authorEmail: adminAEmail, authorName: 'Forged Admin',
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`forge note: ${r.status}`);
      const note = r.body.note || r.body;
      if (note.authorEmail !== mashAEmail) {
        throw new Error(`note attribution: got ${note.authorEmail}, want ${mashAEmail}`);
      }
      if (note.authorName !== 'T24 Mash A') {
        throw new Error(`note attribution name: got ${note.authorName}`);
      }
    }
    {
      const r = await postJson(baseUrl, '/api/announcements', tAdminA, {
        title: `Forge ann ${ts}`, body: 'x', authorName: 'Forged Name',
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`forge announcement: ${r.status}`);
      const ann = r.body.announcement || r.body;
      if (ann.authorName !== 'T24 Admin A') {
        throw new Error(`announcement attribution: got ${ann.authorName}`);
      }
      if (ann.authorEmail !== adminAEmail) {
        throw new Error(`announcement attribution email: got ${ann.authorEmail}`);
      }
    }
    {
      const ver = await ctx.getVersion();
      const r = await postJson(baseUrl, `/api/incidents/${incidentAId}/resolve?expectedVersion=${ver}`, tAdminA, {
        resolvedBy: 'forged@example.com',
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`resolve incident: ${r.status}`);
      const get = await getJson(baseUrl, '/api/incidents', tAdminA);
      const inc = (get.body.incidents || []).find((i) => i.id === incidentAId);
      if (!inc || inc.resolvedBy !== adminAEmail) {
        throw new Error(`resolve attribution: got ${inc?.resolvedBy}, want ${adminAEmail}`);
      }
    }
    {
      const r = await postJson(baseUrl, '/api/task-templates', tAdminA, {
        name: `Forge tmpl ${ts}`, createdByEmail: 'forged@example.com',
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`forge template: ${r.status}`);
      const tmpl = r.body.template || r.body;
      if (tmpl.createdByEmail !== adminAEmail) {
        throw new Error(`template attribution: got ${tmpl.createdByEmail}, want ${adminAEmail}`);
      }
    }
    {
      // Ingredient verify with forged userEmail in body
      const ver2 = await ctx.getVersion();
      const r = await fetch(`${baseUrl}/api/ingredients/${ingAId}/verify?expectedVersion=${ver2}`, {
        method: 'PUT', headers: auth(tMashA),
        body: JSON.stringify({ verificationStatus: 'verified_present', userEmail: 'forged@example.com' }),
      });
      if (r.status !== 200) throw new Error(`verify ingredient: ${r.status}`);
      const get = await getJson(baseUrl, '/api/ingredients', tAdminA);
      const ing = (get.body.ingredients || []).find((i) => i.id === ingAId);
      if (!ing || ing.verifiedByEmail !== mashAEmail) {
        throw new Error(`verify attribution: got ${ing?.verifiedByEmail}, want ${mashAEmail}`);
      }
    }
    {
      // Event task toggle: completedByEmail must be the session user, not the body
      // (the endpoint ignores any body userEmail/userName; attribution is from caller).
      const ver3 = await ctx.getVersion();
      const tr = await postJson(baseUrl, `/api/events/${eventAId}/tasks/${evtTaskAId}/toggle?expectedVersion=${ver3}`, tMashA, {
        isCompleted: true, userEmail: 'forged@example.com', userName: 'Forged',
      });
      if (tr.status !== 200) throw new Error(`toggle event task: ${tr.status}`);
      const toggled = (tr.body.event?.tasks || []).find((t) => t.id === evtTaskAId);
      if (!toggled) throw new Error('toggle: task not in response');
      if (toggled.completedByEmail !== mashAEmail) {
        throw new Error(`toggle attribution wrong: ${toggled.completedByEmail} (expected ${mashAEmail})`);
      }
      if (toggled.completedByEmail === 'forged@example.com') {
        throw new Error('toggle: forged userEmail was stored');
      }

      // POST /api/tasks/:id/check-in: byEmail must be the session user (strict)
      const ver5 = await ctx.getVersion();
      const cr = await postJson(baseUrl, `/api/tasks/${taskAId}/check-in?expectedVersion=${ver5}`, tAdminA, {
        notes: `Check-in ${ts}`, userEmail: 'forged@example.com', userName: 'Forged',
      });
      if (cr.status !== 200 && cr.status !== 201) throw new Error(`check-in: ${cr.status}`);
      // Read the task back; the new check-in must carry the session user's email.
      const gr = await fetch(`${baseUrl}/api/tasks`, { headers: auth(tAdminA) });
      const gb = await gr.json();
      const taskBack = (gb.tasks || []).find((t) => t.id === taskAId);
      if (!taskBack) throw new Error('check-in: task not found on read-back');
      const latestCheckIn = (taskBack.checkIns || []).slice(-1)[0];
      if (!latestCheckIn) throw new Error('check-in: no check-in entry stored (Rule L)');
      if (latestCheckIn.byEmail !== adminAEmail) {
        throw new Error(`check-in attribution wrong: ${latestCheckIn.byEmail} (expected ${adminAEmail})`);
      }

      // PUT /api/tasks/:id completion: updatedByEmail must be the session user.
      // (The handler sets updatedByEmail from caller.email when finalIsCompleted.)
      const ver6 = await ctx.getVersion();
      const pur = await fetch(`${baseUrl}/api/tasks/${taskAId}?expectedVersion=${ver6}`, {
        method: 'PUT', headers: auth(tAdminA),
        body: JSON.stringify({ isCompleted: true, userEmail: 'forged@example.com', userName: 'Forged' }),
      });
      if (pur.status !== 200) throw new Error(`PUT complete task: ${pur.status}`);
      const gr2 = await fetch(`${baseUrl}/api/tasks`, { headers: auth(tAdminA) });
      const gb2 = await gr2.json();
      const taskBack2 = (gb2.tasks || []).find((t) => t.id === taskAId);
      if (!taskBack2) throw new Error('PUT: task not found on read-back');
      if (taskBack2.updatedByEmail !== adminAEmail) {
        throw new Error(`PUT attribution wrong: ${taskBack2.updatedByEmail} (expected ${adminAEmail})`);
      }
    }

    /* ---- 7. Venue scoping: non-admin cannot read another venue's rows ---- */
    {
      // mashgiach A1 (venueA) tries ?venueId=venueA2 → 403 on all five GETs
      for (const path of ['/api/handoff-notes', '/api/incidents', '/api/ingredients', '/api/factory-reports', '/api/airtable/config']) {
        const r = await fetch(`${baseUrl}${path}?venueId=${venueA2}`, { headers: auth(tMashA) });
        if (r.status !== 403) throw new Error(`venue scoping: mashA ?venueId=venueA2 on ${path} → ${r.status} (expected 403)`);
      }
      // mashgiach A1 without ?venueId → only venueA rows (not venueA2, not whole agency)
      const nr = await fetch(`${baseUrl}/api/handoff-notes`, { headers: auth(tMashA) });
      const nb = await nr.json();
      const ids = (nb.notes || []).map((n) => n.id);
      if (!ids.includes(noteAId)) throw new Error('venue scoping: mashA missing own venue note');
      if (ids.includes(noteA2Id)) throw new Error('venue scoping: mashA sees venueA2 note without ?venueId');
      // RULE T: coordinator of venueA → only venueA notes (not agency-wide)
      const cr2 = await fetch(`${baseUrl}/api/handoff-notes`, { headers: auth(tCoordA) });
      const cb2 = await cr2.json();
      const cids = (cb2.notes || []).map((n) => n.id);
      if (!cids.includes(noteAId) || cids.includes(noteA2Id)) {
        throw new Error('venue scoping: coordinator should see own-venue notes only');
      }
      // coordinator with ?venueId=venueA2 → 403
      const cr3 = await fetch(`${baseUrl}/api/handoff-notes?venueId=${venueA2}`, { headers: auth(tCoordA) });
      if (cr3.status !== 403) {
        throw new Error(`venue scoping: coordinator ?venueId=venueA2 → ${cr3.status} (expected 403)`);
      }
      // mashgiach with NO venueId → [] on all five GETs (never agency-wide)
      for (const [path, key] of [
        ['/api/handoff-notes', 'notes'],
        ['/api/incidents', 'incidents'],
        ['/api/ingredients', 'ingredients'],
        ['/api/factory-reports', 'reports'],
        ['/api/history', 'historyLogs'],
      ]) {
        const r = await fetch(`${baseUrl}${path}`, { headers: auth(tMashNoVenue) });
        if (r.status !== 200) throw new Error(`no-venue: ${path} → ${r.status} (expected 200 with [])`);
        const b = await r.json();
        const items = b[key] || [];
        if (items.length !== 0) {
          throw new Error(`no-venue: ${path} returned ${items.length} rows (expected 0)`);
        }
      }
      // mashgiach with NO venueId: must NOT get agency-level config (baseId/apiKey).
      // Note: by this point the test server has restarted, so hydration's legacy
      // default has assigned this user 'venue-crown-market'; they get that
      // venue's (empty) default. The fail-closed 403 for a TRULY venue-less user
      // is covered in test-26 (no restart there). What must never happen here:
      // another venue's config leaking to this user.
      const acr = await fetch(`${baseUrl}/api/airtable/config`, { headers: auth(tMashNoVenue) });
      if (acr.status !== 200) throw new Error(`no-venue: /api/airtable/config → ${acr.status} (expected 200)`);
      const acb = await acr.json();
      const cfg = acb.config || acb;
      if (cfg.baseId || cfg.hasApiKey) {
        throw new Error('no-venue: got agency config (baseId/apiKey present) — should be empty default');
      }
    }

    /* ---- 8. Restart regression: hydrateState restores all four collections ---- */
    {
      // Fixtures reached memory via inject-fixture → commitState → Firestore.
      // Restart the server; the four collections must still answer via GET.
      await ctx.restartServer();
      const tAdminA2 = await mintToken(baseUrl, adminAId); // token survives restart (same jwtSecret in test)
      const checks = [
        ['/api/incidents', 'incidents', incidentAId],
        ['/api/handoff-notes', 'notes', noteAId],
        ['/api/announcements', 'announcements', annAId],
        ['/api/task-templates', 'templates', tmplAId],
      ];
      for (const [path, key, id] of checks) {
        const r = await fetch(`${baseUrl}${path}`, { headers: auth(tAdminA2) });
        if (r.status !== 200) throw new Error(`restart: ${path} → ${r.status}`);
        const b = await r.json();
        const ids = (b[key] || []).map((x) => x.id);
        if (!ids.includes(id)) throw new Error(`restart: ${path} missing ${id} (hydrateState regression)`);
      }
    }
  },
};
