/**
 * Test 65 (N3, item 12 follow-up): a kiosk socket receives AGENCY_UPDATED for
 * its own agency, cut to EXACTLY { agency: { id, logoRev, timeZone } }.
 *  1 positive twin: another admin's phone socket in the same agency gets the full
 *    admin view (brandName, adminEmail, ...), so the trim is real.
 *  2 the kiosk socket gets the same event with exactly those keys: logoRev
 *    null while unset, the stored string once set; timeZone the agency's.
 *  3 another agency's AGENCY_UPDATED never reaches the tablet.
 */
import { png } from './logo-fixtures.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function mintToken(baseUrl, userId) {
  const res = await fetch(`${baseUrl}/api/__test__/mint-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
  });
  if (res.status !== 200) throw new Error(`mint-token failed: ${res.status}`);
  return (await res.json()).token;
}

async function pairDevice(baseUrl, adminToken, venueId) {
  const start = await fetch(`${baseUrl}/api/kiosk/pairing/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  if (start.status !== 200) throw new Error(`pairing/start: ${start.status}`);
  const { pairingId, code, deviceSecret } = await start.json();
  const pair = await fetch(`${baseUrl}/api/kiosk/devices/pair`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({ code, venueId }),
  });
  if (pair.status !== 201) throw new Error(`devices/pair: ${pair.status}`);
  const claim = await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${pairingId}.${deviceSecret}` } });
  const claimed = await claim.json().catch(() => ({}));
  if (claim.status !== 200 || claimed.status !== 'approved') throw new Error(`pairing claim: ${claim.status}`);
  return { id: claimed.device.id, header: `${claimed.device.id}.${deviceSecret}` };
}

function connectWs(baseUrl, token, credential) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
    const messages = [];
    const conn = {
      ws, messages, closeCode: null,
      waitClose: async (ms = 4000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (conn.closeCode !== null) return conn.closeCode; await sleep(100); }
        return conn.closeCode;
      },
      waitFor: async (pred, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const hit = messages.find(pred); if (hit) return hit; await sleep(100); }
        return null;
      },
      close: () => { try { ws.close(); } catch {} },
    };
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.onopen = () => { if (credential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential })); } catch {} } };
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
      if (messages.some((m) => m.type === 'INITIAL_STATE')) { clearTimeout(timer); resolve(conn); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
    ws.onclose = (ev) => { clearTimeout(timer); conn.closeCode = ev.code; if (!messages.some((m) => m.type === 'INITIAL_STATE')) reject(new Error(`WS closed before INITIAL_STATE (${ev.code})`)); };
  });
}



export default {
  name: 'Test 65: kiosk gets AGENCY_UPDATED trimmed to {id, logoRev, timeZone} (N3)',
  whatItProves:
    'A paired tablet hears its own agency\'s logo / zone changes live with exactly { agency: { id, logoRev, timeZone } } (nothing else of the admin view), and never another agency\'s update.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t65-${ts}`, AG2 = `agency-t65b-${ts}`;
    const vA = `venue-t65a-${ts}`, vB2 = `venue-t65b-${ts}`;
    const adminId = `user-t65-admin-${ts}`, adminW = `user-t65-adminw-${ts}`, admin2 = `user-t65-admin2-${ts}`, mash = `user-t65-mash-${ts}`;
    const PIN = '4817';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'Test65 Agency', timeZone: 'America/New_York' }, { id: AG2, name: 'Test65 Other', timeZone: 'Asia/Jerusalem' }],
      venues: [{ id: vA, name: `T65 A ${ts}`, agencyId: AG }, { id: vB2, name: `T65 B ${ts}`, agencyId: AG2 }],
      users: [
        { id: adminId, email: `admin65-${ts}@test.local`, name: 'T65 Admin', role: 'admin', agencyId: AG, avatarColor: 'bg-gold' },
        { id: adminW, email: `admin65w-${ts}@test.local`, name: 'T65 Admin W', role: 'admin', agencyId: AG, avatarColor: 'bg-gold' },
        { id: admin2, email: `admin65b-${ts}@test.local`, name: 'T65 Admin 2', role: 'admin', agencyId: AG2, avatarColor: 'bg-gold' },
        { id: mash, email: `mash65-${ts}@test.local`, name: 'T65 Mash', role: 'mashgiach', agencyId: AG, venueId: vA, kioskPin: PIN, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, adminId);
    const tAdmin2 = await mintToken(baseUrl, admin2);
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const dev = await pairDevice(baseUrl, tAdmin, vA);
    const lr = await fetch(`${baseUrl}/api/kiosk/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header },
      body: JSON.stringify({ userId: mash, pin: PIN }),
    });
    const lb = await lr.json().catch(() => ({}));
    if (lr.status !== 200 || !lb.token) throw new Error(`kiosk login: ${lr.status}`);

    const kiosk = await connectWs(baseUrl, lb.token, dev.header);
    // positive twin: a SECOND admin of the same agency (the writer's own socket is skipped by broadcast)
    const phone = await connectWs(baseUrl, await mintToken(baseUrl, adminW));
    const put = async (token, body) => {
      const r = await fetch(`${baseUrl}/api/agencies/current`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ ...body, expectedVersion: await ctx.getVersion() }) });
      return r.status;
    };
    const exact = (m, label) => {
      if (!m) throw new Error(`${label}: the kiosk socket got no AGENCY_UPDATED`);
      const top = Object.keys(m.payload || {}).sort().join(',');
      if (top !== 'agency') throw new Error(`${label}: payload keys ${top}`);
      const ks = Object.keys(m.payload.agency).sort().join(',');
      if (ks !== 'id,logoRev,timeZone') throw new Error(`${label}: agency keys ${ks}`);
      return m.payload.agency;
    };
    try {
      // 1 + 2: brand change (logo unset)
      const brand = `Brand65 ${ts}`;
      if ((await put(tAdmin, { brandName: brand })) !== 200) throw new Error('brand update');
      const pm = await phone.waitFor((m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.brandName === brand);
      if (!pm || pm.payload.agency.name !== 'Test65 Agency' || Object.keys(pm.payload.agency).length <= 3) throw new Error(`positive twin: the staff socket did not get the full view (${JSON.stringify(pm && Object.keys(pm.payload.agency))})`);
      const km = await kiosk.waitFor((m) => m.type === 'AGENCY_UPDATED');
      const a1 = exact(km, 'brand change');
      if (a1.id !== AG || a1.logoRev !== null || a1.timeZone !== 'America/New_York') throw new Error(`brand change values ${JSON.stringify(a1)}`);
      if (JSON.stringify(km).includes(brand) || JSON.stringify(km).includes('Test65 Agency')) throw new Error('brand / name reached the tablet');
      console.log('  ✓ 1-2 kiosk gets {agency:{id, logoRev:null, timeZone}} only; the admin socket gets the full view');

      // 2b: a real logo upload (#97's PUT /api/agency/logo) -> the tablet hears the new logoRev
      kiosk.messages.length = 0;
      const up = await fetch(`${baseUrl}/api/agency/logo`, { method: 'PUT', headers: auth(tAdmin), body: JSON.stringify({ data: png(16, 16).toString('base64'), expectedVersion: await ctx.getVersion(), operationId: `op-t65-${ts}` }) });
      if (up.status !== 200) throw new Error(`logo upload: ${up.status} ${await up.text()}`);
      const rev = ((await ctx.getDoc()).agencies || []).find((a) => a.id === AG)?.logoRev;
      if (typeof rev !== 'string' || !rev) throw new Error('logo upload stored no logoRev');
      const kl = await kiosk.waitFor((m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.logoRev === rev);
      const al = exact(kl, 'logo upload');
      if (al.id !== AG || al.timeZone !== 'America/New_York') throw new Error(`logo upload values ${JSON.stringify(al)}`);
      // zone change keeps carrying the stored logoRev
      kiosk.messages.length = 0;
      if ((await put(tAdmin, { timeZone: 'America/Chicago' })) !== 200) throw new Error('zone update');
      const km2 = await kiosk.waitFor((m) => m.type === 'AGENCY_UPDATED' && m.payload?.agency?.timeZone === 'America/Chicago');
      const a2 = exact(km2, 'zone change');
      if (a2.id !== AG || a2.logoRev !== rev) throw new Error(`zone change values ${JSON.stringify(a2)}`);
      console.log('  ✓ 2b a logo upload reaches the tablet as the new logoRev; a zone change carries it too');

      // 3: another agency's update never reaches the tablet
      kiosk.messages.length = 0;
      if ((await put(tAdmin2, { brandName: `Other65 ${ts}` })) !== 200) throw new Error('other agency update');
      await sleep(1200);
      if (kiosk.messages.some((m) => m.type === 'AGENCY_UPDATED')) throw new Error('another agency\'s AGENCY_UPDATED reached the tablet');
      console.log('  ✓ 3 another agency\'s update is not delivered');
    } finally {
      kiosk.close(); phone.close();
    }
    return 'kiosk AGENCY_UPDATED = exactly {agency:{id, logoRev, timeZone}} for its own agency; full view only on staff sockets; other agencies never';
  },
};
