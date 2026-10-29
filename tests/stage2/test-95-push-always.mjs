/**
 * Test 95: Alerts for tags and assignments even when notifications are off
 * (PUSHALWAYS, Don Oct 29 2026: "even if someone didn't press the button of
 * notification on, if it's something that he is tagged to or assigned to,
 * he'll get an alert anyway").
 *
 * A phone's "Off" is now a setting on its subscription (mode 'tagged'): the
 * phone stays subscribed, general pushes skip it, and pushes about the person
 * themselves still reach it. A subscription with no mode is 'all' — every
 * phone subscribed today keeps everything.
 *  S  subscribe takes mode 'all' | 'tagged' (anything else 400); stored only
 *     when 'tagged' (old records unchanged); a re-subscribe without a mode
 *     keeps the setting; another person taking the endpoint does not inherit
 *     it; POST /api/push/status tells a person about THEIR OWN endpoint only.
 *  G  general (announcement, overdue on an 'all' task): reaches 'all' phones,
 *     never a 'tagged' phone.
 *  P  personal: a tag, @All, a task assigned at create, overdue on a task
 *     naming the person, an alert routed to them, a reset code — reach a
 *     'tagged' phone.
 *  R  re-assign: a person ADDED to an existing task gets "📋 New task
 *     assigned to you" (even on a 'tagged' phone); people already on it, the
 *     editor, an 'all' assignment, an unchanged list and a title-only edit
 *     push nothing.
 *  M  switching a phone back to 'all' brings general pushes back.
 * Every positive check has its negative twin (rule G).
 */
const AX = 'agency-test95-x';

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: 'Test 95: Alerts for tags and assignments even when notifications are off',
  whatItProves:
    "A phone set to Off ('tagged') stays subscribed: announcements and overdue on 'all' tasks skip it, while tags, @All, tasks assigned or re-assigned to the person, overdue on their task, their alerts and reset codes still reach it; phones subscribed before keep every push; re-assigning an existing task pushes only the people added.",
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const V1 = `venue-t95-v1-${ts}`;
    const U = (n) => `user-t95-${n}-${ts}`;
    const E = (n) => `${n}-t95-${ts}@test.local`;
    const people = {
      adm: ['admin', 'Ada Admin'], coord: ['coordinator', 'Cora Coord'], mashT: ['mashgiach', 'Tova TaggedOnly'],
      mashA: ['mashgiach', 'Avi AllPushes'], mash2: ['mashgiach', 'Rina Reassigned'], mashN: ['mashgiach', 'Noa NoPhone'],
    };
    const id = (k) => U(k.toLowerCase());
    const em = (k) => E(k.toLowerCase());
    const task = (k, extra) => ({
      id: `task-t95-${k}-${ts}`, agencyId: AX, venueId: V1, title: `T95 ${k} ${ts}`, category: 'General',
      targetTime: '10:00 AM', targetTimeMinutes: 600, enableOverdueAlert: true, isCompleted: false,
      priority: 'medium', status: 'pending', ...extra,
    });
    const doc0 = await ctx.getDoc();
    const savedDates = { ...(doc0.venueWorkDates || {}) };
    const park = {};
    for (const v of doc0.venues || []) if (v && v.id) park[v.id] = '2099-12-31';
    park[V1] = '2099-12-31';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AX, name: 'T95 X' }],
      venues: [{ id: V1, name: `T95 V1 ${ts}`, agencyId: AX }],
      users: Object.entries(people).map(([k, [role, name]]) => ({ id: id(k), email: em(k), name, role, agencyId: AX, venueId: V1 })),
      tasks: [task('ovall', { assignedTo: ['all'] }), task('ovnamed', { assignedTo: [em('mashT')] })],
      venueWorkDates: park,
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const T = {};
    for (const k of Object.keys(people)) T[k] = await mintToken(baseUrl, id(k));
    const ep = (k) => `https://push.example/t95-${k}-${ts}`;
    const subscribe = async (k, mode, endpoint = ep(k)) => {
      const body = { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } };
      if (mode !== undefined) body.mode = mode;
      const r = await fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: auth(T[k]), body: JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, body: j };
    };
    const status = async (k, endpoint) => {
      const r = await fetch(`${baseUrl}/api/push/status`, { method: 'POST', headers: auth(T[k]), body: JSON.stringify(endpoint === undefined ? {} : { endpoint }) });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, body: j };
    };
    const stored = async (endpoint) => ((await ctx.getDoc()).pushSubscriptions || []).find((s) => s.endpoint === endpoint);
    const byEp = () => Object.fromEntries(Object.keys(people).map((k) => [ep(k), k]));
    const clearPush = () => ctx.api('POST', '/api/__test__/push-log/clear', {});
    const pushed = async (titleRe) => {
      await sleep(150);
      const m = byEp();
      return ((await ctx.api('GET', '/api/__test__/push-log')).json?.log || [])
        .filter((e) => m[e.endpoint] && (!titleRe || titleRe.test(e.title)))
        .map((e) => m[e.endpoint]).sort();
    };
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const must = (cond, msg) => { if (!cond) throw new Error(msg); };

    try {
      // ---- S: the setting on the subscription ----
      {
        const bad = await subscribe('mashT', 'none');
        must(bad.status === 400, `S1 an unknown setting must be 400 (got ${bad.status})`);
        must(!(await stored(ep('mashT'))), 'S1 a refused subscribe stores nothing');
        const t = await subscribe('mashT', 'tagged');
        must(t.status === 200 && t.body?.mode === 'tagged', `S2 subscribe tagged: ${t.status} ${JSON.stringify(t.body)}`);
        must((await stored(ep('mashT')))?.mode === 'tagged', 'S2 the tagged setting is stored');
        for (const k of ['adm', 'coord', 'mash2']) must((await subscribe(k, 'tagged')).status === 200, `S2 subscribe ${k}`);
        const a = await subscribe('mashA');
        must(a.status === 200 && a.body?.mode === 'all', `S3 subscribe with no setting = all: ${JSON.stringify(a.body)}`);
        const recA = await stored(ep('mashA'));
        must(recA && !('mode' in recA), `S3 an 'all' record keeps the old shape (no mode field): ${JSON.stringify(recA)}`);
        const again = await subscribe('mashT');
        must(again.body?.mode === 'tagged' && (await stored(ep('mashT')))?.mode === 'tagged', 'S4 a re-subscribe without a setting keeps tagged');
        const s1 = await status('mashT', ep('mashT'));
        must(s1.status === 200 && s1.body?.registered === true && s1.body?.mode === 'tagged', `S5 own status: ${JSON.stringify(s1.body)}`);
        const s2 = await status('mashA', ep('mashT'));
        must(s2.status === 200 && s2.body?.registered === false && s2.body?.mode === 'all', `S5 another person's endpoint reads as not registered: ${JSON.stringify(s2.body)}`);
        const s3 = await status('mashA', ep('mashA'));
        must(s3.body?.registered === true && s3.body?.mode === 'all', `S5 all status: ${JSON.stringify(s3.body)}`);
        must((await status('mashA')).status === 400, 'S5 status without an endpoint is 400');
        const shared = `https://push.example/t95-shared-${ts}`;
        must((await subscribe('mashN', 'tagged', shared)).status === 200, 'S6 mashN subscribes the shared endpoint');
        const takeover = await subscribe('mash2', undefined, shared);
        const recS = await stored(shared);
        must(takeover.body?.mode === 'all' && recS?.userId === id('mash2') && !('mode' in recS), `S6 another person taking an endpoint does not inherit its setting: ${JSON.stringify(recS)}`);
        const un = await fetch(`${baseUrl}/api/push/unsubscribe`, { method: 'POST', headers: auth(T.mash2), body: JSON.stringify({ endpoint: shared }) });
        must(un.status === 200, `S6 cleanup unsubscribe: ${un.status}`);
      }

      // ---- G: general pushes skip a tagged phone ----
      {
        await clearPush();
        const r = await fetch(`${baseUrl}/api/announcements`, { method: 'POST', headers: auth(T.adm), body: JSON.stringify({ title: `T95 ann ${ts}`, body: 'Staff meeting at 5', venueId: V1, targetRoles: ['all'] }) });
        must(r.status === 200 || r.status === 201, `G1 announcement: ${r.status}`);
        const p = await pushed(/T95 ann/);
        must(p.includes('mashA'), `G1 an 'all' phone gets the announcement: ${JSON.stringify(p)}`);
        for (const k of ['mashT', 'coord', 'mash2']) must(!p.includes(k), `G1 a tagged phone (${k}) must NOT get an announcement: ${JSON.stringify(p)}`);
      }

      // ---- overdue: named (personal) vs 'all' (general) ----
      {
        await clearPush();
        const ck = await ctx.api('POST', '/api/__test__/clock', { iso: '2026-11-10T20:00:00Z' });
        must(ck.status === 200, `clock: ${ck.status}`);
        const ov = await ctx.api('POST', '/api/__test__/overdue-check', { clear: true });
        must(ov.status === 200, `overdue-check: ${ov.status}`);
        const all = await pushed(new RegExp(`^Overdue: T95 ovall ${ts}$`));
        must(all.includes('mashA'), `G2 overdue on an 'all' task reaches an 'all' phone: ${JSON.stringify(all)}`);
        must(!all.includes('mashT') && !all.includes('mash2'), `G2 overdue on an 'all' task must NOT reach a tagged phone: ${JSON.stringify(all)}`);
        const named = await pushed(new RegExp(`^Overdue: T95 ovnamed ${ts}$`));
        must(same(named, ['mashT']), `P4 overdue on a task naming mashT reaches her tagged phone (only her): ${JSON.stringify(named)}`);
        await ctx.api('POST', '/api/__test__/clock', { iso: null });
      }

      // ---- P: personal pushes reach a tagged phone ----
      {
        await clearPush();
        const n1 = await fetch(`${baseUrl}/api/handoff-notes`, { method: 'POST', headers: auth(T.mashA), body: JSON.stringify({ venueId: V1, content: 'please check the fridge', shift: 'Morning', mentions: [id('mashT')] }) });
        must(n1.status === 200, `P1 note: ${n1.status}`);
        const p1 = await pushed(/tagged you/);
        must(same(p1, ['mashT']), `P1 a tag reaches the tagged phone: ${JSON.stringify(p1)}`);
        await clearPush();
        const n2 = await fetch(`${baseUrl}/api/handoff-notes`, { method: 'POST', headers: auth(T.mashA), body: JSON.stringify({ venueId: V1, content: 'everyone: inspection at 4', shift: 'Morning', mentionAll: true }) });
        must(n2.status === 200, `P2 note: ${n2.status} ${await n2.clone().text()}`);
        const p2 = await pushed(/@All/);
        must(p2.includes('mashT') && p2.includes('mash2') && p2.includes('coord'), `P2 @All reaches tagged phones: ${JSON.stringify(p2)}`);
        must(!p2.includes('mashA'), 'P2 not the author');
        await clearPush();
        const c = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: auth(T.adm), body: JSON.stringify({ venueId: V1, title: `T95 new ${ts}`, assignedTo: [em('mashT')], category: 'General' }) });
        must(c.status === 201 || c.status === 200, `P3 task create: ${c.status}`);
        const p3 = await pushed(/New task assigned to you/);
        must(same(p3, ['mashT']), `P3 a task assigned at create reaches the tagged phone: ${JSON.stringify(p3)}`);
        await clearPush();
        const inc = await fetch(`${baseUrl}/api/incidents`, { method: 'POST', headers: auth(T.mashA), body: JSON.stringify({ venueId: V1, title: `T95 leak ${ts}`, severity: 'high', clientRef: `t95-${ts}` }) });
        must(inc.status === 200 || inc.status === 201, `P5 incident: ${inc.status}`);
        const p5 = await pushed(/T95 leak/);
        must(p5.includes('coord') || p5.includes('adm'), `P5 an alert reaches the tagged phones it is routed to: ${JSON.stringify(p5)}`);
        must(!p5.includes('mashT'), `P5 an alert is not sent to people it is not routed to: ${JSON.stringify(p5)}`);
        await clearPush();
        const fp = await fetch(`${baseUrl}/api/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.95.${ts % 200}.7` }, body: JSON.stringify({ email: em('mashN') }) });
        must(fp.status === 200, `P6 forgot-password: ${fp.status}`);
        const p6 = await pushed(/Password reset code/);
        must(p6.includes('adm') && p6.includes('coord'), `P6 the reset code reaches tagged admin/coordinator phones: ${JSON.stringify(p6)}`);
        must(!p6.includes('mashA') && !p6.includes('mashT'), `P6 not to mashgichim: ${JSON.stringify(p6)}`);
      }

      // ---- R: re-assigning an existing task ----
      {
        const c = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: auth(T.adm), body: JSON.stringify({ venueId: V1, title: `T95 re ${ts}`, assignedTo: [em('mashT')], category: 'General' }) });
        const tk = await c.json();
        const tid = (tk.task || tk).id;
        const put = async (tok, body) => {
          const r = await fetch(`${baseUrl}/api/tasks/${tid}`, { method: 'PUT', headers: auth(tok), body: JSON.stringify({ ...body, expectedVersion: await ctx.getVersion() }) });
          must(r.status === 200, `PUT ${JSON.stringify(body)}: ${r.status} ${await r.clone().text()}`);
        };
        await clearPush();
        await put(T.adm, { assignedTo: [em('mashT'), em('mash2')] });
        const r1 = await pushed(/New task assigned to you/);
        must(same(r1, ['mash2']), `R1 only the person ADDED (mash2, tagged phone) is pushed: ${JSON.stringify(r1)}`);
        await clearPush();
        await put(T.adm, { assignedTo: [em('mash2'), em('mashT')] });
        must((await pushed(/New task assigned/)).length === 0, 'R2 the same people in another order push nothing');
        await clearPush();
        await put(T.adm, { title: `T95 re renamed ${ts}` });
        must((await pushed(/New task assigned/)).length === 0, 'R3 a title-only edit pushes nothing');
        await clearPush();
        await put(T.adm, { assignedTo: [em('mash2'), em('mashT'), em('adm')] });
        must((await pushed(/New task assigned/)).length === 0, 'R4 the editor adding themselves is not pushed');
        await clearPush();
        await put(T.adm, { assignedTo: ['all'] });
        must((await pushed(/New task assigned/)).length === 0, "R5 switching to 'all' pushes nobody");
        await clearPush();
        await put(T.adm, { assignedTo: [em('mashA')] });
        const r6 = await pushed(/New task assigned to you/);
        must(same(r6, ['mashA']), `R6 from 'all' to a named person pushes that person: ${JSON.stringify(r6)}`);
      }

      // ---- M: back to all ----
      {
        const m = await subscribe('mashT', 'all');
        must(m.body?.mode === 'all' && !('mode' in (await stored(ep('mashT')))), 'M1 switching to all clears the setting');
        await clearPush();
        const r = await fetch(`${baseUrl}/api/announcements`, { method: 'POST', headers: auth(T.adm), body: JSON.stringify({ title: `T95 ann2 ${ts}`, body: 'Second notice', venueId: V1, targetRoles: ['all'] }) });
        must(r.status === 200 || r.status === 201, `M1 announcement: ${r.status}`);
        const p = await pushed(/T95 ann2/);
        must(p.includes('mashT') && p.includes('mashA'), `M1 back on all, announcements reach mashT again: ${JSON.stringify(p)}`);
        must(!p.includes('coord'), 'M1 coord is still tagged-only');
      }

      // ---- O: the newest tap wins on the server, across tabs (review PARV8) ----
      {
        const sub = (k, extra, endpoint = ep(k)) => fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: auth(T[k]), body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, ...extra }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
        const t2 = Date.now(), t1 = t2 - 5000, t3 = t2 + 5000;
        const o1 = await sub('mashT', { mode: 'tagged', choiceAt: t2 });
        must(o1.status === 200 && o1.body.mode === 'tagged' && !o1.body.superseded && (await stored(ep('mashT')))?.modeAt === t2, `O1 a tap is stored with its time: ${JSON.stringify(o1.body)}`);
        const o2 = await sub('mashT', { mode: 'all', choiceAt: t1 });
        must(o2.status === 200 && o2.body.superseded === true && o2.body.mode === 'tagged' && (await stored(ep('mashT')))?.mode === 'tagged', `O2 an OLDER tap (another tab's late write) is ignored: ${JSON.stringify(o2.body)}`);
        const o3 = await sub('mashT', { mode: 'all' });
        must(o3.body?.superseded === true && (await stored(ep('mashT')))?.mode === 'tagged', `O3 a write with no tap time never replaces a chosen setting: ${JSON.stringify(o3.body)}`);
        const o4 = await sub('mashT', { mode: 'all', choiceAt: t3 });
        const r4 = await stored(ep('mashT'));
        must(o4.body?.mode === 'all' && !o4.body.superseded && !('mode' in r4) && r4.modeAt === t3, `O4 a newer tap applies: ${JSON.stringify(r4)}`);
        const o4b = await sub('mashT', {});
        must(o4b.body?.mode === 'all' && (await stored(ep('mashT')))?.modeAt === t3, 'O4b a re-sync keeps the setting and its time');
        for (const bad of [{ mode: 'all', choiceAt: 'x' }, { mode: 'all', choiceAt: -1 }, { choiceAt: t3 + 1 }]) {
          must((await sub('mashT', bad)).status === 400, `O5 invalid tap time ${JSON.stringify(bad)} -> 400`);
        }
        const o6 = await sub('mash2', { mode: 'tagged', choiceAt: t1 }, ep('mashT'));
        const r6 = await stored(ep('mashT'));
        must(o6.body?.mode === 'tagged' && !o6.body.superseded && r6.userId === id('mash2') && r6.modeAt === t1, `O6 another person taking the endpoint is not blocked by the first person's tap time: ${JSON.stringify(r6)}`);
      }
    } finally {
      await ctx.api('POST', '/api/__test__/clock', { iso: null }).catch(() => {});
      try {
        const now = (await ctx.getDoc()).venueWorkDates || {};
        const patch = { ...savedDates };
        for (const k of Object.keys(now)) if (!(k in patch)) patch[k] = null;
        await ctx.api('POST', '/api/__test__/inject-fixture', { venueWorkDates: patch });
      } catch {}
    }
  },
};
