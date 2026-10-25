/**
 * Kiosk QR sign-in (addendum v2 AGREED, Oct 24 2026): the pure helpers in
 * src/server/kiosk-qr.ts (code shape, hashing, link, state views, approve gate).
 */
import {
  KQR_CODE_RE, KQR_CODE_TTL_MS, KQR_CLAIM_WINDOW_MS, KQR_EXTRA_CODE_GAP_MS, KQR_PAGE_PATH_RE, KQR_TEXT,
  isKqrCode, kqrDeriveKey, kqrHash, kqrRandom, kqrEmitOrigin, kqrLink, kqrView, kqrApproveGate, kqrFirstName, asKqrDevice, emptyKqrDevice,
} from '../../src/server/kiosk-qr.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);

export default {
  name: 'Kiosk QR: kiosk-qr.ts pure helpers (unit)',
  whatItProves: 'Codes are 22-char 128-bit random values stored only as a keyed hash; the link origin is the configured one; the code states (live, approved, claimed, expired, dead) and the approve gate follow the agreed addendum, including the 30 s claim window and generation changes.',
  async run() {
    assert(KQR_CODE_TTL_MS === 60000 && KQR_CLAIM_WINDOW_MS === 30000 && KQR_EXTRA_CODE_GAP_MS === 20000, 'clocks 60 s / 30 s / 20 s');
    const seen = new Set();
    for (let i = 0; i < 200; i++) { const c = kqrRandom(); assert(KQR_CODE_RE.test(c) && isKqrCode(c), `code shape ${c}`); seen.add(c); }
    assert(seen.size === 200, 'codes are random');
    for (const bad of ['', 'a'.repeat(21), 'a'.repeat(23), 'a'.repeat(21) + '=', 'a'.repeat(21) + '/', null, 42]) assert(!isKqrCode(bad), `not a code: ${J(bad)}`);
    const k1 = kqrDeriveKey('secret-one'), k2 = kqrDeriveKey('secret-two');
    const c = kqrRandom();
    const h1 = kqrHash(k1, c);
    assert(/^[0-9a-f]{64}$/.test(h1) && h1 === kqrHash(kqrDeriveKey('secret-one'), c) && h1 !== kqrHash(k2, c) && !h1.includes(c), 'keyed hash, stable, secret-dependent');
    assert(kqrEmitOrigin('https://app.hartfordkashrut.org', 'https://shared.example') === 'https://app.hartfordkashrut.org', 'agency address wins');
    assert(kqrEmitOrigin(null, 'https://shared.example') === 'https://shared.example', 'else the shared address');
    assert(kqrLink('https://a.example', c) === `https://a.example/k/${c}`, 'link shape');
    let threw = false; try { kqrLink('https://a.example', 'nope'); } catch { threw = true; }
    assert(threw, 'kqrLink refuses a non-code');
    for (const p of ['/k', '/k/', `/k/${c}`, `/k/${c}/`]) assert(KQR_PAGE_PATH_RE.test(p), `page path ${p}`);
    for (const p of ['/kk', '/k/a/b', '/api/k/x', '/ki']) assert(!KQR_PAGE_PATH_RE.test(p), `not the page ${p}`);

    const dev = { ...emptyKqrDevice('d1'), g: 3, codeHash: 'a'.repeat(64) };
    const base = { hash: 'a'.repeat(64), state: 'live', deviceId: 'd1', agencyId: 'ag', venueId: 'v', deviceSecretHash: 'x', g: 3, createdAtMs: 1000, expiresAtMs: 61000 };
    assert(kqrView(base, dev, 'd1', 60999).kind === 'live' && kqrView(base, dev, 'd1', 61000).kind === 'expired', 'live until exactly 60 s');
    assert(kqrView(base, { ...dev, g: 4 }, 'd1', 2000).kind === 'dead', 'a generation bump kills a code');
    assert(kqrView(base, dev, 'd2', 2000).kind === 'none' && kqrView(base, { ...dev, codeHash: 'b'.repeat(64) }, 'd1', 2000).kind === 'none', 'another device / not the current code');
    const appr = { ...base, state: 'approved', approvedAtMs: 50000, claimDeadlineMs: 80000, approval: { id: 'i', personId: 'p1', rowId: 'r', sid: 's', epoch: 0, pv: '1' } };
    assert(kqrView(appr, dev, 'd1', 79999).kind === 'approved' && kqrView(appr, dev, 'd1', 80000).kind === 'approved-late', 'claim window: 29.999 s ok, 30 s late');
    assert(kqrView(appr, dev, 'd1', 70000).kind === 'approved', 'an approval outlives the code\'s own 60 s until its claim deadline');
    assert(kqrView({ ...appr, state: 'claimed' }, { ...dev, g: 9 }, 'd1', 1e9).kind === 'claimed', 'claimed stays claimed (retry is checked by the server)');
    assert(kqrView({ ...base, state: 'cancelled' }, dev, 'd1', 2000).kind === 'dead', 'cancelled is dead');

    assert(kqrApproveGate(base, dev, 'p1', 2000) === 'ok', 'gate ok');
    assert(kqrApproveGate(base, dev, 'p1', 61000) === 'expired', 'gate expired at 60 s');
    assert(kqrApproveGate(base, { ...dev, g: 4 }, 'p1', 2000) === 'unusable', 'gate: other generation');
    assert(kqrApproveGate(appr, dev, 'p1', 60000) === 'already' && kqrApproveGate(appr, dev, 'p2', 60000) === 'unusable', 'gate: same person already, anyone else unusable');
    assert(kqrApproveGate(appr, dev, 'p1', 80000) === 'unusable', 'gate: an approval past its claim window is not "already"');
    assert(kqrApproveGate({ ...appr, state: 'claimed' }, dev, 'p1', 60000) === 'unusable', 'gate: claimed');
    assert(kqrApproveGate(null, dev, 'p1', 1) === 'unusable' && kqrApproveGate(base, null, 'p1', 1) === 'unusable', 'gate: missing');

    assert(kqrFirstName('  Yossi  Cohen ') === 'Yossi' && kqrFirstName('') === '' && kqrFirstName(null) === '', 'first name');
    const d = asKqrDevice({ g: -1, codeHash: 'zz', lastSid: 5, lastExtraAtMs: 'x' }, 'd9');
    assert(J(d) === J(emptyKqrDevice('d9')), `malformed device doc reads as fresh: ${J(d)}`);
    assert(KQR_TEXT.expired === 'This code has expired. Scan the new code on the tablet.' && KQR_TEXT.unusable === "This code can't be used. Scan the code on the tablet again.", 'words');
    return { details: ['shape', 'hash', 'link', 'views', 'gate'] };
  },
};
