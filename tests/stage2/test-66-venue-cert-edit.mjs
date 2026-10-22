/**
 * Test 66 (venue cert edit): PUT /api/venues/:id accepts an optional
 * certificationDetail, validated like POST /api/venues.
 *  1 admin sets a detail: certification = "<agency name> — <detail>" built by
 *    the server (client-sent certification text in the same request ignored);
 *    VENUE_UPDATED reaches another admin of the agency.
 *  2 '' and null clear it: no certificationDetail, certification = agency name.
 *  3 an invalid detail (too long, markup, non-string) is 400 and writes nothing.
 *  4 a non-admin (coordinator, mashgiach) is 403; another agency's admin is 403;
 *    nothing written.
 *  5 a legacy "Name - Name" venue normalises to the agency name after an edit.
 *  6 absent detail = unchanged behaviour (certification text stored as typed,
 *    stored detail kept).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

function connectWs(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      ws, messages,
      waitFor: async (pred, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); }
        return null;
      },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
    ws.onclose = (ev) => { clearTimeout(timer); if (!messages.some((m) => m.type === 'INITIAL_STATE')) reject(new Error(`WS closed before INITIAL_STATE (${ev.code})`)); };
  });
}

export default {
  name: 'Test 66: edit an existing venue\'s certification detail (PUT /api/venues/:id)',
  whatItProves:
    'An admin can set or clear a venue\'s certification type; the server validates it like venue creation and builds the label from the agency name itself; non-admins and other agencies are refused; legacy "Name - Name" labels normalise on edit; requests without the field behave as before.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t66-${ts}`, AG2 = `agency-t66b-${ts}`;
    const AGN = 'Test66 Agency';
    const v1 = `venue-t66a-${ts}`, vLegacy = `venue-t66l-${ts}`, vKeep = `venue-t66k-${ts}`;
    const admin = `user-t66-admin-${ts}`, adminW = `user-t66-adminw-${ts}`, coord = `user-t66-coord-${ts}`, mash = `user-t66-mash-${ts}`, admin2 = `user-t66-admin2-${ts}`;
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: AGN, timeZone: 'America/New_York' }, { id: AG2, name: 'Test66 Other', timeZone: 'America/New_York' }],
      venues: [
        { id: v1, name: `T66 A ${ts}`, agencyId: AG, certification: AGN },
        { id: vLegacy, name: `T66 L ${ts}`, agencyId: AG, certification: `${AGN} - ${AGN}` },
        { id: vKeep, name: `T66 K ${ts}`, agencyId: AG, certification: `${AGN} — Pareve`, certificationDetail: 'Pareve' },
      ],
      users: [
        { id: admin, email: `admin66-${ts}@test.local`, name: 'T66 Admin', role: 'admin', agencyId: AG, avatarColor: 'bg-gold' },
        { id: adminW, email: `admin66w-${ts}@test.local`, name: 'T66 Admin W', role: 'admin', agencyId: AG, avatarColor: 'bg-gold' },
        { id: coord, email: `coord66-${ts}@test.local`, name: 'T66 Coord', role: 'coordinator', agencyId: AG, avatarColor: 'bg-gold' },
        { id: mash, email: `mash66-${ts}@test.local`, name: 'T66 Mash', role: 'mashgiach', agencyId: AG, venueId: v1, avatarColor: 'bg-gold' },
        { id: admin2, email: `admin66b-${ts}@test.local`, name: 'T66 Admin 2', role: 'admin', agencyId: AG2, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, admin);
    const put = async (token, id, body) => {
      const r = await fetch(`${baseUrl}/api/venues/${id}`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ ...body, expectedVersion: await ctx.getVersion() }) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const stored = async (id) => ((await ctx.getDoc()).venues || []).find((v) => v.id === id);

    const phone = await connectWs(baseUrl, await mintToken(baseUrl, adminW));
    try {
      // 1: set a detail; the client's certification text is ignored
      let r = await put(tAdmin, v1, { certificationDetail: '  Glatt meat ', certification: 'Client Text — Wrong' });
      if (r.status !== 200) throw new Error(`1 set detail: ${r.status} ${r.text.slice(0, 200)}`);
      let s = await stored(v1);
      if (s.certificationDetail !== 'Glatt meat' || s.certification !== `${AGN} — Glatt meat`) throw new Error(`1 stored ${JSON.stringify({ c: s.certification, d: s.certificationDetail })}`);
      if (r.json?.venue?.certification !== `${AGN} — Glatt meat`) throw new Error('1 response venue label');
      const vu = await phone.waitFor((m) => m.type === 'VENUE_UPDATED' && m.payload?.venue?.id === v1 && m.payload.venue.certificationDetail === 'Glatt meat');
      if (!vu) throw new Error('1 VENUE_UPDATED not delivered to the other admin');
      console.log('  ✓ 1 admin sets a detail; label built by the server; client text ignored; VENUE_UPDATED broadcast');

      // 2: '' clears, then set again and null clears
      r = await put(tAdmin, v1, { certificationDetail: '' });
      s = await stored(v1);
      if (r.status !== 200 || 'certificationDetail' in s || s.certification !== AGN) throw new Error(`2 '' clear: ${r.status} ${JSON.stringify({ c: s.certification, d: s.certificationDetail })}`);
      r = await put(tAdmin, v1, { certificationDetail: 'Dairy' });
      if (r.status !== 200 || (await stored(v1)).certification !== `${AGN} — Dairy`) throw new Error(`2 re-set: ${r.status}`);
      r = await put(tAdmin, v1, { certificationDetail: null });
      s = await stored(v1);
      if (r.status !== 200 || 'certificationDetail' in s || s.certification !== AGN) throw new Error(`2 null clear: ${r.status} ${JSON.stringify({ c: s.certification, d: s.certificationDetail })}`);
      console.log("  ✓ 2 '' and null clear the detail; certification = agency name");

      // 3: invalid detail -> 400, nothing written
      await put(tAdmin, v1, { certificationDetail: 'Meat' });
      const before = JSON.stringify(await stored(v1));
      const v0 = await ctx.getVersion();
      for (const bad of ['x'.repeat(61), 'Me\u0007at', 42, { a: 1 }, ['Meat']]) {
        r = await put(tAdmin, v1, { certificationDetail: bad });
        if (r.status !== 400 || r.json?.code !== 'CERT_DETAIL_INVALID') throw new Error(`3 invalid ${JSON.stringify(bad).slice(0, 30)}: ${r.status} ${r.text.slice(0, 120)}`);
      }
      if (JSON.stringify(await stored(v1)) !== before || (await ctx.getVersion()) !== v0) throw new Error('3 an invalid detail wrote something');
      console.log('  ✓ 3 invalid details are 400 CERT_DETAIL_INVALID, nothing written');

      // 4: non-admin and another agency -> 403, nothing written
      for (const [who, id] of [['coordinator', coord], ['mashgiach', mash], ['other agency admin', admin2]]) {
        r = await put(await mintToken(baseUrl, id), v1, { certificationDetail: 'Pareve' });
        if (r.status !== 403) throw new Error(`4 ${who}: ${r.status} ${r.text.slice(0, 120)}`);
      }
      if (JSON.stringify(await stored(v1)) !== before || (await ctx.getVersion()) !== v0) throw new Error('4 a refused edit wrote something');
      console.log('  ✓ 4 coordinator, mashgiach and another agency\'s admin get 403; nothing written');

      // 5: legacy "Name - Name" normalises after an edit
      r = await put(tAdmin, vLegacy, { certificationDetail: '' });
      s = await stored(vLegacy);
      if (r.status !== 200 || s.certification !== AGN || 'certificationDetail' in s) throw new Error(`5 legacy clear: ${r.status} ${JSON.stringify(s.certification)}`);
      console.log('  ✓ 5 a legacy "Name - Name" label normalises to the agency name on edit');

      // 6: absent detail = unchanged behaviour
      r = await put(tAdmin, vKeep, { name: `T66 K2 ${ts}` });
      s = await stored(vKeep);
      if (r.status !== 200 || s.certification !== `${AGN} — Pareve` || s.certificationDetail !== 'Pareve') throw new Error(`6 name-only edit touched the cert: ${JSON.stringify({ c: s.certification, d: s.certificationDetail })}`);
      r = await put(tAdmin, vKeep, { certification: '  Typed Label ' });
      s = await stored(vKeep);
      if (r.status !== 200 || s.certification !== 'Typed Label' || s.certificationDetail !== 'Pareve') throw new Error(`6 text-only edit: ${JSON.stringify({ c: s.certification, d: s.certificationDetail })}`);
      console.log('  ✓ 6 without certificationDetail: name edit leaves the cert alone; certification text stored as typed, detail kept');
    } finally {
      phone.close();
    }
    return 'PUT /api/venues/:id certificationDetail: set (server-built label, client text ignored, broadcast), clear via \'\'/null, invalid 400, non-admin/other agency 403, legacy label normalised, absent = unchanged';
  },
};
