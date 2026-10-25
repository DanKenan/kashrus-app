/**
 * Kiosk QR sign-in (addendum v2 AGREED, Oct 24 2026): the pure helpers in
 * src/server/kiosk-qr.ts (code shape, hashing, link, state views, approve gate).
 */
import {
  KQR_CODE_RE, KQR_CODE_TTL_MS, KQR_CLAIM_WINDOW_MS, KQR_EXTRA_CODE_GAP_MS, KQR_PAGE_PATH_RE, KQR_TEXT,
  isKqrCode, kqrDeriveKey, kqrHash, kqrRandom, kqrEmitOrigin, kqrLink, kqrView, kqrApproveGate, kqrFirstName, asKqrDevice, emptyKqrDevice,
  KQR_PICKUP_WINDOW_MS,
} from '../../src/server/kiosk-qr.ts';
import { kqrPickupState, kqrPickupVerdict, keepKnownPickup, sessionBacksClaims } from '../../src/server/sessions.ts';

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
    for (const p of ['/k', '/k/', `/k/${c}`, `/k/${c}/`, '/k/a/b']) assert(KQR_PAGE_PATH_RE.test(p), `page path ${p}`);
    for (const p of ['/kk', '/api/k/x', '/ki', '/k.html']) assert(!KQR_PAGE_PATH_RE.test(p), `not the page ${p}`);

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

    // Kiosk QR cleanup (item 4): a QR tablet session must be picked up (used) by its tablet in time.
    assert(KQR_PICKUP_WINDOW_MS === 60000, 'pick-up window 60 s');
    const ks = { sid: 'S'.repeat(22), kind: 'kiosk', personId: 'p1', rowId: 'r1', agencyId: 'ag', epochAtIssue: 0, via: 'kiosk-qr', createdAt: 'x', createdAtMs: 1000,
      absoluteExpMs: 1000 + 3 * 3600 * 1000, userAgentHint: '', revokedAt: null, revokeReason: null, kioskDeviceId: 'd1', venueId: 'v', pvAtIssue: '1' };
    const kc = { kind: 'kiosk', userId: 'r1', agencyId: 'ag', venueId: 'v', pv: '1', dev: 'd1', sid: ks.sid };
    assert(kqrPickupState(ks, 1e9) === 'done' && sessionBacksClaims(ks, kc, 5000), 'a session without the field (made before this change, or a PIN session) is unaffected');
    const pend = { ...ks, qrPickupByMs: 61000 };
    assert(kqrPickupState(pend, 60999) === 'pending' && sessionBacksClaims(pend, kc, 60999), 'not used yet, inside the window: pending and usable');
    assert(kqrPickupState(pend, 61000) === 'missed' && !sessionBacksClaims(pend, kc, 61000), 'not used by exactly 60 s: missed and dead');
    const used = { ...pend, qrPickedUpAtMs: 5000 };
    assert(kqrPickupState(used, 1e7) === 'done' && sessionBacksClaims(used, kc, 1e7), 'picked up in time: done for its whole life');
    assert(!sessionBacksClaims({ ...used, revokedAt: 'now' }, kc, 6000), 'picked up does not beat a revocation');
    assert(kqrPickupState({ ...pend, qrPickedUpAtMs: 61001 }, 70000) === 'missed', 'a pick-up after the deadline does not count');
    for (const bad of [null, 'x', NaN, Infinity]) assert(kqrPickupState({ ...ks, qrPickupByMs: bad }, 0) === 'missed', `a malformed deadline fails closed: ${String(bad)}`);
    assert(kqrPickupState({ ...pend, qrPickedUpAtMs: 'x' }, 2000) === 'pending', 'a malformed pick-up moment is not a pick-up');
    // [KQRCLN-RV1] 1: after the record check, the deadline is checked again explicitly.
    assert(kqrPickupVerdict(ks, 1e9) === 'ok' && kqrPickupVerdict(used, 1e9) === 'ok', 'verdict: done -> ok');
    assert(kqrPickupVerdict(pend, 60999) === 'mark' && kqrPickupVerdict(pend, 61000) === 'refused', 'verdict: pending -> mark, deadline crossed -> refused');
    // [KQRCLN-RV1] 2: an older read never erases a pick-up this instance already knows; a revocation still wins.
    assert(keepKnownPickup(pend, used).qrPickedUpAtMs === 5000, 'an older pending read keeps the known pick-up');
    const revOld = keepKnownPickup({ ...pend, revokedAt: 'r' }, used);
    assert(revOld.revokedAt === 'r' && revOld.qrPickedUpAtMs === 5000 && !sessionBacksClaims(revOld, kc, 6000), 'a revocation in the newer read still wins');
    assert(keepKnownPickup(pend, { ...used, sid: 'T'.repeat(22) }) === pend && keepKnownPickup(pend, { ...used, qrPickupByMs: 99 }) === pend, 'only the same session and deadline');
    assert(keepKnownPickup(null, used) === null && keepKnownPickup(pend, null) === pend && keepKnownPickup(used, pend) === used, 'nothing to keep');
    assert(keepKnownPickup(pend, { ...pend, qrPickedUpAtMs: 'x' }) === pend, 'a malformed known pick-up is not kept');
    return { details: ['shape', 'hash', 'link', 'views', 'gate', 'pick-up'] };
  },
};
