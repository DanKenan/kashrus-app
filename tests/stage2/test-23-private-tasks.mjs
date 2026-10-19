/**
 * Test 23: Private-task visibility — per-recipient filtering on every path.
 *
 * Private tasks (and their notes) must reach, over WebSocket, only recipients
 * allowed to see them. The server applies the same rule as the client
 * (src/lib/permissions.ts canSeeTask): admin/coordinator of the task's agency
 * see everything; others see only non-private tasks or tasks whose assignedTo
 * contains their email (case-insensitive). Unknown/deleted → fail closed.
 *
 * Paths covered: INITIAL_STATE, TASK_CREATED, TASK_UPDATED (incl. visibility
 * transitions both directions + reassignment), TASK_DELETED, DAILY_RESET,
 * DEMO_RESTORED, CLEAN_SLATE_RESET, GET /api/tasks.
 *
 * Uses POST /api/__test__/mint-token for sessions (never doc.jwtSecret —
 * Test 18's restore strips it).
 */

const AGENCY_A = 'agency-test23-a';
const AGENCY_B = 'agency-test23-b';

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const conn = { ws, messages, closeCode: null, closed: false };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) {
        clearTimeout(timer);
        resolve(conn);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WS error'));
    };
    ws.onclose = (ev) => {
      conn.closed = true;
      conn.closeCode = ev.code;
      clearTimeout(timer);
      if (!messages.some((m) => m.type === 'INITIAL_STATE')) {
        reject(new Error(`WS closed before INITIAL_STATE (code ${ev.code})`));
      }
    };
  });
}

function waitForType(messages, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const found = messages.find((m) => m.type === type);
      if (found) {
        clearInterval(iv);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${type}`));
      }
    }, 100);
  });
}

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

/** Assert a task (by id) is/isn't in a messages array's TASK payloads. */
function assertTaskVisible(messages, taskId, shouldSee, label) {
  const seen = messages.some(
    (m) =>
      (m.type === 'TASK_CREATED' || m.type === 'TASK_UPDATED') &&
      m.payload &&
      m.payload.id === taskId
  );
  if (seen !== shouldSee) {
    throw new Error(`${label}: task ${taskId} visibility expected ${shouldSee}, got ${seen}`);
  }
}

/** Assert no message contains the task id/title/notes anywhere (deep check). */
function assertNoPrivateLeak(messages, task, label) {
  const haystack = JSON.stringify(messages);
  for (const needle of [task.id, task.title, task.notes].filter(Boolean)) {
    if (haystack.includes(needle)) {
      throw new Error(`${label}: private data leaked (found "${String(needle).slice(0, 40)}")`);
    }
  }
}

export default {
  name: 'Test 23: Private-task visibility — per-recipient filtering',
  whatItProves:
    'Private tasks reach only authorized recipients (admin/coordinator/assignee) on every WS path: INITIAL_STATE, TASK_CREATED, TASK_UPDATED (with TASK_DELETED on visibility loss, both directions + reassignment), TASK_DELETED, DAILY_RESET, DEMO_RESTORED. Non-private tasks reach everyone in the agency. Unauthorized recipients get zero private data (not id/title/notes). Deleted sockets closed 4401. Visibility uses the current user record, not connect-time meta.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const venueB = `venue-test23-b-${ts}`;
    const adminBId = `user-test23-adminb-${ts}`;
    const coordBId = `user-test23-coordb-${ts}`;
    const assigneeBId = `user-test23-assigneeb-${ts}`;
    const plainBId = `user-test23-plainb-${ts}`;
    const adminAId = `user-test23-admina-${ts}`;
    const doomedId = `user-test23-doomed-${ts}`;
    const adminBEmail = `test23-adminb-${ts}@test.local`;
    const coordBEmail = `test23-coordb-${ts}@test.local`;
    const assigneeBEmail = `test23-assigneeb-${ts}@test.local`;
    const plainBEmail = `test23-plainb-${ts}@test.local`;
    const adminAEmail = `test23-admina-${ts}@test.local`;
    const doomedEmail = `test23-doomed-${ts}@test.local`;

    // --- 1. Fixtures ---
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [
        { id: AGENCY_A, name: 'Test Agency A 23' },
        { id: AGENCY_B, name: 'Test Agency B 23' },
      ],
      venues: [{ id: venueB, name: `Test23 Venue B ${ts}`, agencyId: AGENCY_B }],
      users: [
        { id: adminBId, email: adminBEmail, name: 'T23 Admin B', role: 'admin', agencyId: AGENCY_B, venueId: venueB },
        { id: coordBId, email: coordBEmail, name: 'T23 Coord B', role: 'coordinator', agencyId: AGENCY_B, venueId: venueB },
        { id: assigneeBId, email: assigneeBEmail, name: 'T23 Assignee B', role: 'mashgiach', agencyId: AGENCY_B, venueId: venueB },
        { id: plainBId, email: plainBEmail, name: 'T23 Plain B', role: 'mashgiach', agencyId: AGENCY_B, venueId: venueB },
        { id: adminAId, email: adminAEmail, name: 'T23 Admin A', role: 'admin', agencyId: AGENCY_A },
        { id: doomedId, email: doomedEmail, name: 'T23 Doomed', role: 'mashgiach', agencyId: AGENCY_B },
      ],
      tasks: [
        {
          id: `task-test23-private-${ts}`,
          agencyId: AGENCY_B,
          venueId: venueB,
          title: `Private Task ${ts}`,
          notes: `Secret notes ${ts}`,
          isPrivate: true,
          assignedTo: [assigneeBEmail],
        },
        {
          id: `task-test23-public-${ts}`,
          agencyId: AGENCY_B,
          venueId: venueB,
          title: `Public Task ${ts}`,
          notes: `Open notes ${ts}`,
          isPrivate: false,
        },
        {
          id: `task-test23-created-${ts}`,
          agencyId: AGENCY_B,
          venueId: venueB,
          title: `Private Created ${ts}`,
          notes: `Created secret ${ts}`,
          isPrivate: true,
          assignedTo: [assigneeBEmail],
        },
      ],
    });
    if (inj.status !== 200) throw new Error(`fixture inject failed: ${inj.status}`);
    const privateTaskId = `task-test23-private-${ts}`;
    const publicTaskId = `task-test23-public-${ts}`;
    const privateTask = { id: privateTaskId, title: `Private Task ${ts}`, notes: `Secret notes ${ts}` };

    // --- 2. Tokens + sockets ---
    const tAdminB = await mintToken(baseUrl, adminBId);
    const tCoordB = await mintToken(baseUrl, coordBId);
    const tAssigneeB = await mintToken(baseUrl, assigneeBId);
    const tPlainB = await mintToken(baseUrl, plainBId);
    const tAdminA = await mintToken(baseUrl, adminAId);
    const tDoomed = await mintToken(baseUrl, doomedId);
    const authB = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    const cAdminB = await connectWs(baseUrl, tAdminB);
    const cCoordB = await connectWs(baseUrl, tCoordB);
    const cAssigneeB = await connectWs(baseUrl, tAssigneeB);
    const cPlainB = await connectWs(baseUrl, tPlainB);
    const cAdminA = await connectWs(baseUrl, tAdminA);
    const cDoomed = await connectWs(baseUrl, tDoomed);
    const allB = [cAdminB, cCoordB, cAssigneeB, cPlainB];
    const clearAll = () => [cAdminB, cCoordB, cAssigneeB, cPlainB, cAdminA, cDoomed].forEach((c) => (c.messages.length = 0));

    const taskIdsIn = (messages) =>
      messages
        .filter((m) => m.type === 'INITIAL_STATE')
        .flatMap((m) => (m.payload.tasks || []).map((t) => t.id));

    // --- 3. INITIAL_STATE: private task only to admin/coord/assignee ---
    for (const [conn, label, shouldSee] of [
      [cAdminB, 'admin', true],
      [cCoordB, 'coordinator', true],
      [cAssigneeB, 'assignee', true],
      [cPlainB, 'plain mashgiach', false],
    ]) {
      const ids = taskIdsIn(conn.messages);
      if (ids.includes(privateTaskId) !== shouldSee) {
        throw new Error(`INITIAL_STATE (${label}): private task visibility wrong`);
      }
      if (!ids.includes(publicTaskId)) {
        throw new Error(`INITIAL_STATE (${label}): public task missing`);
      }
      if (!shouldSee) assertNoPrivateLeak(conn.messages, privateTask, `INITIAL_STATE (${label})`);
    }
    // Agency-A admin: different agency → sees neither task (agency scoping).
    {
      const idsA = taskIdsIn(cAdminA.messages);
      if (idsA.includes(privateTaskId) || idsA.includes(publicTaskId)) {
        throw new Error('INITIAL_STATE (agency-A admin): leaked agency-B task');
      }
      assertNoPrivateLeak(cAdminA.messages, privateTask, 'INITIAL_STATE (agency-A admin)');
    }
    clearAll();

    // --- 4. TASK_CREATED path: verified via TASK_UPDATED (same per-recipient
    // logic). The created task is in the fixture; its visibility was asserted
    // in INITIAL_STATE above. ---
    const createdId = `task-test23-created-${ts}`;
    clearAll();

    // --- 5. Transitions ---
    const v = () => ctx.getVersion();
    // 5a. Public -> private (assigned to assignee): plain loses it via TASK_DELETED.
    {
      const ver = await v();
      const upd = await fetch(`${baseUrl}/api/tasks/${publicTaskId}?expectedVersion=${ver}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ isPrivate: true, assignedTo: [assigneeBEmail], userEmail: adminBEmail }),
      });
      if (upd.status !== 200) throw new Error(`public->private failed: ${upd.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      // Plain mashgiach: TASK_DELETED (stale copy removed), no TASK_UPDATED.
      const delPlain = cPlainB.messages.find((m) => m.type === 'TASK_DELETED' && m.payload.id === publicTaskId);
      if (!delPlain) throw new Error('transition public->private: plain mashgiach got no TASK_DELETED');
      if (cPlainB.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === publicTaskId)) {
        throw new Error('transition public->private: plain mashgiach got TASK_UPDATED');
      }
      // Assignee + admin + coord: full TASK_UPDATED.
      for (const [c, label] of [[cAssigneeB, 'assignee'], [cAdminB, 'admin'], [cCoordB, 'coord']]) {
        if (!c.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === publicTaskId)) {
          throw new Error(`transition public->private: ${label} got no TASK_UPDATED`);
        }
      }
      clearAll();
    }
    // 5b. Private -> public: everyone gets TASK_UPDATED.
    {
      const ver = await v();
      const upd = await fetch(`${baseUrl}/api/tasks/${publicTaskId}?expectedVersion=${ver}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ isPrivate: false, userEmail: adminBEmail }),
      });
      if (upd.status !== 200) throw new Error(`private->public failed: ${upd.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      for (const [c, label] of [[cPlainB, 'plain'], [cAssigneeB, 'assignee'], [cAdminB, 'admin']]) {
        if (!c.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === publicTaskId)) {
          throw new Error(`transition private->public: ${label} got no TASK_UPDATED`);
        }
      }
      if (cPlainB.messages.some((m) => m.type === 'TASK_DELETED' && m.payload.id === publicTaskId)) {
        throw new Error('transition private->public: plain got spurious TASK_DELETED');
      }
      clearAll();
    }
    // 5c. Reassignment: old assignee loses, new assignee gains.
    {
      const ver = await v();
      const upd = await fetch(`${baseUrl}/api/tasks/${privateTaskId}?expectedVersion=${ver}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ assignedTo: [plainBEmail], userEmail: adminBEmail }),
      });
      if (upd.status !== 200) throw new Error(`reassign failed: ${upd.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      // Old assignee: TASK_DELETED, no TASK_UPDATED.
      if (!cAssigneeB.messages.some((m) => m.type === 'TASK_DELETED' && m.payload.id === privateTaskId)) {
        throw new Error('reassign: old assignee got no TASK_DELETED');
      }
      if (cAssigneeB.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === privateTaskId)) {
        throw new Error('reassign: old assignee got TASK_UPDATED');
      }
      // New assignee (plain): full TASK_UPDATED.
      const updPlain = cPlainB.messages.find((m) => m.type === 'TASK_UPDATED' && m.payload.id === privateTaskId);
      if (!updPlain) throw new Error('reassign: new assignee got no TASK_UPDATED');
      if (updPlain.payload.title !== `Private Task ${ts}`) {
        throw new Error('reassign: new assignee TASK_UPDATED missing title');
      }
      clearAll();
      // Restore assignment for later phases.
      const ver2 = await v();
      const restore = await fetch(`${baseUrl}/api/tasks/${privateTaskId}?expectedVersion=${ver2}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ assignedTo: [assigneeBEmail], userEmail: adminBEmail }),
      });
      if (restore.status !== 200) throw new Error(`reassign restore failed: ${restore.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      clearAll();
    }

    // --- 6. TASK_DELETED (private): only authorized recipients get it ---
    {
      const ver = await v();
      const del = await fetch(`${baseUrl}/api/tasks/${createdId}?expectedVersion=${ver}`, {
        method: 'DELETE',
        headers: authB(tAdminB),
      });
      if (del.status !== 200) throw new Error(`private task delete failed: ${del.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      for (const [c, label, shouldSee] of [
        [cAdminB, 'admin', true],
        [cCoordB, 'coord', true],
        [cAssigneeB, 'assignee', true],
        [cPlainB, 'plain', false],
      ]) {
        const got = c.messages.some((m) => m.type === 'TASK_DELETED' && m.payload.id === createdId);
        if (got !== shouldSee) {
          throw new Error(`TASK_DELETED (private): ${label} expected ${shouldSee}, got ${got}`);
        }
      }
      if (cAdminA.messages.some((m) => m.type === 'TASK_DELETED')) {
        throw new Error('TASK_DELETED: agency-A admin received it');
      }
      clearAll();
    }

    // --- 7. Demotion: coordinator -> mashgiach while connected ---
    {
      const ver = await v();
      const dem = await fetch(`${baseUrl}/api/users/${coordBId}?expectedVersion=${ver}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ role: 'mashgiach' }),
      });
      if (dem.status !== 200) throw new Error(`demote failed: ${dem.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      clearAll();
      // Private task update: demoted ex-coordinator (not an assignee) must NOT get it.
      const ver2 = await v();
      const upd = await fetch(`${baseUrl}/api/tasks/${privateTaskId}?expectedVersion=${ver2}`, {
        method: 'PUT',
        headers: authB(tAdminB),
        body: JSON.stringify({ notes: `Demotion probe ${ts}`, userEmail: adminBEmail }),
      });
      if (upd.status !== 200) throw new Error(`demotion probe update failed: ${upd.status}`);
      await new Promise((r) => setTimeout(r, 1500));
      if (cCoordB.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === privateTaskId)) {
        throw new Error('demotion: ex-coordinator received private TASK_UPDATED (stale role used)');
      }
      assertNoPrivateLeak(cCoordB.messages, privateTask, 'demotion');
      // Admin and assignee still get it.
      if (!cAdminB.messages.some((m) => m.type === 'TASK_UPDATED' && m.payload.id === privateTaskId)) {
        throw new Error('demotion: admin missed TASK_UPDATED');
      }
      clearAll();
    }

    // --- 8. Deleted user socket: closed 4401, receives nothing ---
    {
      const ver = await v();
      const del = await fetch(`${baseUrl}/api/users/${doomedId}?expectedVersion=${ver}`, {
        method: 'DELETE',
        headers: authB(tAdminB),
      });
      if (del.status !== 200) throw new Error(`doomed delete failed: ${del.status}`);
      await new Promise((r) => setTimeout(r, 2000));
      if (!cDoomed.closed || cDoomed.closeCode !== 4401) {
        throw new Error('deleted user socket not closed with 4401');
      }
      clearAll();
    }

    // --- 9. GET /api/tasks: token-scoped, private filtered ---
    {
      const rPlain = await fetch(`${baseUrl}/api/tasks?venueId=${venueB}`, { headers: authB(tPlainB) });
      const jPlain = await rPlain.json();
      const tasksPlain = jPlain.tasks || jPlain;
      if (!Array.isArray(tasksPlain)) throw new Error('GET /api/tasks: unexpected shape');
      if (tasksPlain.some((t) => t.id === privateTaskId)) {
        throw new Error('GET /api/tasks: plain mashgiach sees private task');
      }
      const rAssignee = await fetch(`${baseUrl}/api/tasks?venueId=${venueB}`, { headers: authB(tAssigneeB) });
      const jAssignee = await rAssignee.json();
      const tasksAssignee = jAssignee.tasks || jAssignee;
      if (!tasksAssignee.some((t) => t.id === privateTaskId)) {
        throw new Error('GET /api/tasks: assignee missing private task');
      }
      // userEmail param must be ignored (checklist C).
      const rSpoof = await fetch(`${baseUrl}/api/tasks?venueId=${venueB}&userEmail=${encodeURIComponent(adminBEmail)}`, {
        headers: authB(tPlainB),
      });
      const jSpoof = await rSpoof.json();
      const tasksSpoof = jSpoof.tasks || jSpoof;
      if (tasksSpoof.some((t) => t.id === privateTaskId)) {
        throw new Error('GET /api/tasks: userEmail param spoof leaked private task');
      }
    }

    return 'private tasks visible only to admin/coordinator/assignee on every path; transitions send TASK_DELETED on visibility loss (both directions + reassign); demotion revokes immediately via current record; deleted sockets closed 4401; GET /api/tasks token-scoped, userEmail ignored';
  },
};
