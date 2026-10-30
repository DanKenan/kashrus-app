/**
 * Test 99: the kiosk QR memo never hides a newer state (READCUT, Oct 30 2026).
 *
 * READCUT answers a QR tablet's 2 s poll from this instance's memo while its
 * code is simply live. This test proves the memo can never hide a newer state:
 *  M1 [READCUT-RV1 P2] a code issued by a slow request whose memo would be kept
 *     AFTER a newer request (Cancel) replaced it: the next poll does not answer
 *     with the older code;
 *  M2 an approval on the phone is seen by the very next poll (the memo answered
 *     the polls before it);
 *  M3 an approval landing while a read-only poll is between its read and
 *     keeping its memo: the next poll still sees the approval.
 *  M4 [READCUT-RV3 P2] a slow request whose transaction SETTLES after a newer
 *     request (Cancel) wrote and finished: it cannot take back the last-writer
 *     title, so the next poll does not answer with the older code.
 */
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: 'Test 99: the kiosk QR memo never hides a newer state',
  whatItProves:
    'A slow QR request (late memo or late settlement) cannot keep an older code after a newer request replaced it; a phone approval is seen by the next poll even when the polls before it were answered from memory, and even when it lands while a poll is keeping its memo.',
  async run(baseUrl, ctx) {
    const ts = Date.now();
    const port = Number(new URL(baseUrl).port);
    const ORIGIN = `http://127.0.0.1:${port}`;
    const reg = await fetch(`${baseUrl}/api/agencies/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: J({ agencyName: `T99 ${ts}`, adminEmail: `admin-t99-${ts}@test.local`, adminPassword: `t99-admin-${ts}`, adminName: 'T99 Admin' }) });
    const rj = await reg.json().catch(() => ({}));
    if (reg.status !== 201 || !rj.token) throw new Error(`register: ${reg.status} ${J(rj)}`);
    const admin = rj.token, AG = rj.user.agencyId;
    const V = `venue-t99-${ts}`;
    const M = { id: `user-t99-m-${ts}`, personId: `user-t99-m-${ts}`, email: `m-t99-${ts}@test.local`, name: 'Moshe T99', role: 'mashgiach', agencyId: AG, venueId: V, password: `t99-m-${ts}` };
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', { venues: [{ id: V, name: `T99 V ${ts}`, agencyId: AG }], users: [M] });
    if (inj.status !== 200) throw new Error(`inject-fixture: ${inj.status}`);
    const pin = await fetch(`${baseUrl}/api/users/${M.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', Origin: ORIGIN }, body: J({ kioskPin: '2469', expectedVersion: await ctx.getVersion() }) });
    if (pin.status !== 200) throw new Error(`set PIN: ${pin.status} ${await pin.text()}`);
    // The phone: a cookie session (opt-in + Origin), as a real phone approves.
    const lg = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Shutfey-Auth': 'cookie' }, body: J({ email: M.email, password: M.password }) });
    const u = (lg.headers.getSetCookie ? lg.headers.getSetCookie() : []).map((c) => c.split(';')[0]).find((c) => c.startsWith('shutfey_s='));
    if (lg.status !== 200 || !u) throw new Error(`phone sign-in: ${lg.status} ${await lg.text()}`);
    const hook = async (body) => (await ctx.api('POST', '/api/__test__/session-hooks', body)).json;
    const pairTablet = async () => {
      const s = await (await fetch(`${baseUrl}/api/kiosk/pairing/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      const pr = await fetch(`${baseUrl}/api/kiosk/devices/pair`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', Origin: ORIGIN }, body: J({ code: s.code, venueId: V }) });
      if (pr.status !== 201) throw new Error(`pair: ${pr.status} ${await pr.text()}`);
      const sb = await (await fetch(`${baseUrl}/api/kiosk/pairing/status`, { headers: { 'X-Kiosk-Pairing': `${s.pairingId}.${s.deviceSecret}` } })).json();
      return `${sb.device.id}.${s.deviceSecret}`;
    };
    const qr = async (dev, mode) => {
      const r = await fetch(`${baseUrl}/api/kiosk/qr/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Device': dev }, body: '{}' });
      const b = await r.json().catch(() => ({}));
      if (r.status !== 200) throw new Error(`${mode}: ${r.status} ${J(b)}`);
      return b;
    };
    const codeOf = (b) => { const l = b?.link || ''; return l.slice(l.lastIndexOf('/') + 1); };
    const approve = async (code) => {
      const r = await fetch(`${baseUrl}/api/kiosk/qr/approve`, { method: 'POST', headers: { Cookie: u, Origin: ORIGIN, 'X-Shutfey-Auth': 'cookie', 'Content-Type': 'application/json' }, body: J({ code }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const details = [];

    // ---- M1: a slow 'start' keeps its memo only if nothing replaced its code meanwhile
    {
      const dev = await pairTablet();
      if ((await hook({ action: 'kqr-memo-publish-delay-once', ms: 1500 }))?.ok !== true) throw new Error('M1 delay hook');
      const slow = qr(dev, 'start');
      await sleep(500);
      const cancel = await qr(dev, 'cancel');
      const a = await slow;
      if (!a.link || typeof a.codeIssuedAtMs !== 'number') throw new Error(`M1 start issued no code: ${J(a)}`);
      const p = await qr(dev, 'poll');
      if (p.state !== 'waiting') throw new Error(`M1 poll state: ${J(p)}`);
      if (p.codeIssuedAtMs === a.codeIssuedAtMs) throw new Error(`M1 the poll answered with the code Cancel replaced (memo kept by the slower start): ${J(p)} start ${J(a)} cancel ${J(cancel)}`);
      if (cancel.link && p.codeIssuedAtMs !== cancel.codeIssuedAtMs) throw new Error(`M1 the poll must show the code Cancel issued: ${J(p)} cancel ${J(cancel)}`);
      details.push('M1 slow start + Cancel -> the poll never shows the replaced code');
    }

    // ---- M2: polls answered from memory, then an approval: the next poll sees it
    {
      const dev = await pairTablet();
      const st = await qr(dev, 'start');
      const code = codeOf(st);
      for (let i = 0; i < 3; i++) {
        const p = await qr(dev, 'poll');
        if (p.state !== 'waiting' || p.codeIssuedAtMs !== st.codeIssuedAtMs) throw new Error(`M2 poll ${i}: ${J(p)}`);
      }
      const ap = await approve(code);
      if (ap.status !== 200) throw new Error(`M2 approve: ${ap.status} ${J(ap.body)}`);
      const p = await qr(dev, 'poll');
      if (p.state !== 'signed-in') throw new Error(`M2 the poll right after the approval must sign the tablet in: ${J(p)}`);
      details.push('M2 memo-answered polls, approve -> the very next poll signs in');
    }

    // ---- M3: an approval landing while a poll is keeping its memo
    {
      const dev = await pairTablet();
      const st = await qr(dev, 'start');
      const code = codeOf(st);
      if ((await hook({ action: 'kqr-memo-publish-delay-once', ms: 1500 }))?.ok !== true) throw new Error('M3 delay hook');
      const slow = qr(dev, 'poll');
      await sleep(400);
      const ap = await approve(code);
      if (ap.status !== 200) throw new Error(`M3 approve: ${ap.status} ${J(ap.body)}`);
      const a = await slow;
      if (a.state !== 'waiting') throw new Error(`M3 slow poll: ${J(a)}`);
      const p = await qr(dev, 'poll');
      if (p.state !== 'signed-in') throw new Error(`M3 the next poll must sign the tablet in: ${J(p)}`);
      details.push('M3 approve during a poll keeping its memo -> the next poll signs in');
    }
    // ---- M4: a slow 'start' whose transaction settles after Cancel's
    {
      const dev = await pairTablet();
      if ((await hook({ action: 'pk-settle-delay-once', ms: 1500 }))?.ok !== true) throw new Error('M4 settle-delay hook');
      const slow = qr(dev, 'start');
      await sleep(500);
      const cancel = await qr(dev, 'cancel');
      const a = await slow;
      if (!a.link || typeof a.codeIssuedAtMs !== 'number') throw new Error(`M4 start issued no code: ${J(a)}`);
      const p = await qr(dev, 'poll');
      if (p.state !== 'waiting') throw new Error(`M4 poll state: ${J(p)}`);
      if (p.codeIssuedAtMs === a.codeIssuedAtMs) throw new Error(`M4 the poll answered with the code Cancel replaced (the slower start settled last and kept its memo): ${J(p)} start ${J(a)} cancel ${J(cancel)}`);
      if (cancel.link && p.codeIssuedAtMs !== cancel.codeIssuedAtMs) throw new Error(`M4 the poll must show the code Cancel issued: ${J(p)} cancel ${J(cancel)}`);
      details.push('M4 slow start settling after Cancel -> the poll never shows the replaced code');
    }
    return details.join('; ');
  },
};
