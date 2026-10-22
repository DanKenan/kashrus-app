/**
 * Test 70 (kiosk 3 h, Don Oct 21 2026): a kiosk session lasts at most 3 hours
 * from the PIN sign-in, hard, with no idle timeout. Phone sessions keep 30 days.
 *  1 a fresh kiosk token carries exp - iat = 3 h and works.
 *  2 a kiosk token issued 2 h 58 min ago still works (HTTP and WS).
 *  3 a kiosk token issued 3 h 1 min ago is refused (401), INCLUDING one whose
 *    exp still says 12 h (a token minted before the cap); the WS refuses it (4401).
 *  4 a kiosk token with no numeric iat is refused.
 *  5 an open kiosk socket is closed (4401) when its 3 h end arrives.
 *  6 positive twin: a phone token issued 5 h ago (exp 30 d) still works.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const H3 = 3 * 3600;

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

/** Opens a socket and sends the kiosk device frame; never rejects on close. */
function openWs(baseUrl, token, credential) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`);
  const conn = { ws, initial: false, closeCode: null, closedAt: null };
  ws.onopen = () => { if (credential) { try { ws.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential })); } catch {} } };
  ws.onmessage = (ev) => { try { if (JSON.parse(String(ev.data)).type === 'INITIAL_STATE') conn.initial = true; } catch {} };
  ws.onclose = (ev) => { conn.closeCode = ev.code; conn.closedAt = Date.now(); };
  ws.onerror = () => {};
  conn.until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return pred(); };
  conn.close = () => { try { ws.close(); } catch {} };
  return conn;
}

const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8'));

export default {
  name: 'Test 70: kiosk session lasts at most 3 h from sign-in; phones keep 30 d',
  whatItProves:
    'A kiosk token is minted for 3 h and refused once 3 h have passed since iat (HTTP 401, WS 4401), even if its exp says 12 h; one under 3 h works; an open kiosk socket closes at its 3 h end; a 5 h old phone token still works.',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const AG = `agency-t70-${ts}`, vA = `venue-t70a-${ts}`;
    const adminId = `user-t70-admin-${ts}`, mash = `user-t70-mash-${ts}`;
    const PIN = '5826';
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      agencies: [{ id: AG, name: 'Test70 Agency', timeZone: 'America/New_York' }],
      venues: [{ id: vA, name: `T70 A ${ts}`, agencyId: AG }],
      users: [
        { id: adminId, email: `admin70-${ts}@test.local`, name: 'T70 Admin', role: 'admin', agencyId: AG, avatarColor: 'bg-gold' },
        { id: mash, email: `mash70-${ts}@test.local`, name: 'T70 Mash', role: 'mashgiach', agencyId: AG, venueId: vA, kioskPin: PIN, avatarColor: 'bg-gold' },
      ],
    });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const tAdmin = await mintToken(baseUrl, adminId);
    const clear = await fetch(`${baseUrl}/api/__test__/kiosk-clear-lockouts`, { method: 'POST', headers: auth(tAdmin) });
    if (clear.status !== 200) throw new Error(`clear lockouts: ${clear.status}`);
    const dev = await pairDevice(baseUrl, tAdmin, vA);
    const lr = await fetch(`${baseUrl}/api/kiosk/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev.header },
      body: JSON.stringify({ userId: mash, pin: PIN }),
    });
    const lb = await lr.json().catch(() => ({}));
    if (lr.status !== 200 || !lb.token) throw new Error(`kiosk login: ${lr.status}`);

    const authK = (t) => ({ ...auth(t), 'X-Kiosk-Device': dev.header });
    const tasks = async (headers) => (await fetch(`${baseUrl}/api/tasks`, { headers })).status;
    const sign = async (claims) => {
      const r = await ctx.api('POST', '/api/__test__/sign-claims', { claims });
      if (r.status !== 200 || !r.json?.token) throw new Error(`sign-claims ${r.status}`);
      return r.json.token;
    };

    // 1: fresh token = 3 h and works
    const real = decode(lb.token);
    if (real.kiosk !== true) throw new Error('kiosk login token has no kiosk claim');
    if (real.exp - real.iat !== H3) throw new Error(`kiosk token lifetime ${real.exp - real.iat} s, expected ${H3}`);
    if (await tasks(authK(lb.token)) !== 200) throw new Error('fresh kiosk token refused');
    console.log('  ✓ 1 a fresh kiosk token lasts exactly 3 h and works');

    const { iat: _i, exp: _e, ...base } = real;
    const now = () => Math.floor(Date.now() / 1000);

    // 2: 2 h 58 min old -> works on HTTP and WS
    const iYoung = now() - H3 + 120;
    const young = await sign({ ...base, iat: iYoung, exp: iYoung + H3 });
    if (await tasks(authK(young)) !== 200) throw new Error('a kiosk token issued 2 h 58 min ago was refused');
    const wy = openWs(baseUrl, young, dev.header);
    await wy.until(() => wy.initial || wy.closeCode !== null, 6000);
    if (!wy.initial) throw new Error(`WS refused a 2 h 58 min kiosk token (close ${wy.closeCode})`);
    wy.close();
    console.log('  ✓ 2 a kiosk token issued 2 h 58 min ago works (HTTP 200, WS INITIAL_STATE)');

    // 3: 3 h 1 min old -> refused, with exp 12 h (pre-cap token) and with exp = iat + 3 h
    const iOld = now() - H3 - 60;
    const old12 = await sign({ ...base, iat: iOld, exp: iOld + 12 * 3600 });
    const old3 = await sign({ ...base, iat: iOld, exp: iOld + H3 });
    if (await tasks(authK(old12)) !== 401) throw new Error('a 3 h 1 min old kiosk token with a 12 h exp was not refused');
    if (await tasks(authK(old3)) !== 401) throw new Error('an expired 3 h kiosk token was not refused');
    const wo = openWs(baseUrl, old12, dev.header);
    await wo.until(() => wo.initial || wo.closeCode !== null, 6000);
    if (wo.initial || wo.closeCode !== 4401) throw new Error(`WS with a 3 h 1 min old (12 h exp) kiosk token: initial=${wo.initial} close=${wo.closeCode}`);
    console.log('  ✓ 3 a kiosk token issued 3 h 1 min ago is refused (HTTP 401, WS 4401), even with a 12 h exp');

    // 4: no numeric iat -> refused
    const noIat = await sign({ ...base, iat: 'x', exp: now() + 3600 });
    if (await tasks(authK(noIat)) !== 401) throw new Error('a kiosk token without a numeric iat was not refused');
    console.log('  ✓ 4 a kiosk token without a numeric iat is refused');

    // 5: an open socket closes at its 3 h end (token ends 4 s from now)
    const iEdge = now() - H3 + 4;
    const edge = await sign({ ...base, iat: iEdge, exp: iEdge + H3 });
    const we = openWs(baseUrl, edge, dev.header);
    await we.until(() => we.initial || we.closeCode !== null, 3000);
    if (!we.initial) throw new Error(`edge socket did not open (close ${we.closeCode})`);
    await we.until(() => we.closeCode !== null, 9000);
    if (we.closeCode !== 4401) throw new Error(`the open kiosk socket was not closed at its 3 h end (close ${we.closeCode})`);
    if (we.closedAt < (iEdge + H3) * 1000 - 1500) throw new Error('the kiosk socket closed before its 3 h end');
    if (await tasks(authK(edge)) !== 401) throw new Error('the edge token still works after its 3 h end');
    console.log('  ✓ 5 an open kiosk socket is closed (4401) when its 3 h end arrives');

    // 6: positive twin, phone token issued 5 h ago (30 d exp) still works
    const phone = decode(tAdmin);
    const { iat: _pi, exp: _pe, ...pbase } = phone;
    const iPh = now() - 5 * 3600;
    const oldPhone = await sign({ ...pbase, iat: iPh, exp: iPh + 30 * 24 * 3600 });
    if (await tasks(auth(oldPhone)) !== 200) throw new Error('a 5 h old phone token was refused (phones must keep 30 d)');
    console.log('  ✓ 6 a phone token issued 5 h ago still works');

    return 'kiosk: 3 h from iat on HTTP and WS (pre-cap 12 h tokens included), open socket closed at the end; phone sessions unchanged';
  },
};
