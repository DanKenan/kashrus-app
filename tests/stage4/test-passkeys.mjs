/**
 * Item 11, 11b-s: passkey record rules (unit, pure):
 * the 5-minute recent proof, challenge matching, counters, names, the public
 * view, the index key, the passkey session marker and the choose token's pk.
 */
import {
  recentAuthValid, challengeMatches, counterAcceptable, cleanPasskeyName, defaultPasskeyName, publicPasskey,
  credentialIdHash, isPasskeyAuthMethod, asPersonCredentials, newPersonCredentials, findPasskey, RECENT_AUTH_MS, CHALLENGE_TTL_MS, PASSKEYS_MAX,
} from '../../src/server/passkeys.ts';
import { buildUserSession } from '../../src/server/sessions.ts';
import { classifySessionClaims as C, chooseClaimsFor } from '../../src/server/session-token.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);
const CID = 'AbCdEfGhIjKlMnOpQrStUv0123456789_-xyz';

export default {
  name: 'Item 11 (11b-s): passkey rules (unit)',
  whatItProves: 'A recent proof lasts under 5 minutes and dies when the person epoch moves; a challenge is usable only unexpired, unconsumed, for its purpose, origin and (register) person/row/session; a non-zero counter must grow; names are cleaned; the public view has no key; the choose token carries pk only well-formed.',
  async run() {
    const now = 1_000_000_000;
    assert(RECENT_AUTH_MS === 5 * 60 * 1000 && CHALLENGE_TTL_MS === 120 * 1000 && PASSKEYS_MAX === 10, 'constants');
    assert(recentAuthValid({ recentAuthAtMs: now - 1000, recentAuthEpoch: 2 }, 2, now), 'fresh proof valid');
    assert(recentAuthValid({ recentAuthAtMs: now - RECENT_AUTH_MS + 1, recentAuthEpoch: 0 }, 0, now), 'just under 5 min valid');
    assert(!recentAuthValid({ recentAuthAtMs: now - RECENT_AUTH_MS, recentAuthEpoch: 0 }, 0, now), 'exactly 5 min invalid');
    assert(!recentAuthValid({ recentAuthAtMs: now - 1000, recentAuthEpoch: 1 }, 2, now), 'epoch moved -> invalid');
    assert(!recentAuthValid({ recentAuthAtMs: now + 5000, recentAuthEpoch: 0 }, 0, now), 'future proof invalid');
    assert(!recentAuthValid({ recentAuthEpoch: 0 }, 0, now) && !recentAuthValid(null, 0, now) && !recentAuthValid({ recentAuthAtMs: now - 1, recentAuthEpoch: undefined }, 0, now), 'missing proof invalid');

    const base = { id: 'AAAAAAAAAAAAAAAAAAAAAA', challenge: 'ch', purpose: 'register', rpId: 'h', origin: 'https://h', personId: 'p', rowId: 'r', sid: 'SSSSSSSSSSSSSSSSSSSSSS', createdAtMs: now, expMs: now + 1000, consumedAt: null };
    const want = { id: base.id, purpose: 'register', origin: 'https://h', personId: 'p', rowId: 'r', sid: base.sid };
    assert(challengeMatches(base, want, now), 'register challenge matches');
    for (const [label, d, w] of [
      ['expired', { ...base, expMs: now }, want], ['consumed', { ...base, consumedAt: 'x' }, want], ['purpose', base, { ...want, purpose: 'login' }],
      ['origin', base, { ...want, origin: 'https://evil' }], ['person', base, { ...want, personId: 'q' }], ['row', base, { ...want, rowId: 'q' }],
      ['sid', base, { ...want, sid: 'TTTTTTTTTTTTTTTTTTTTTT' }], ['id', base, { ...want, id: 'BBBBBBBBBBBBBBBBBBBBBB' }], ['no rp', { ...base, rpId: '' }, want],
      ['no challenge', { ...base, challenge: '' }, want], ['null', null, want], ['no want person', base, { ...want, personId: null }],
    ]) assert(!challengeMatches(d, w, now), `challenge refused: ${label}`);
    const login = { ...base, purpose: 'login', personId: null, rowId: null, sid: null };
    assert(challengeMatches(login, { id: base.id, purpose: 'login', origin: 'https://h' }, now), 'login challenge matches without person');

    assert(counterAcceptable(0, 0) && counterAcceptable(0, 1) && counterAcceptable(5, 6), 'counter ok cases');
    assert(!counterAcceptable(5, 5) && !counterAcceptable(5, 4) && !counterAcceptable(5, 0) && !counterAcceptable(-1, 0) && !counterAcceptable(0, 1.5), 'counter refused cases');

    assert(cleanPasskeyName('  My\u0007 iPhone \u007f ', 'x') === 'My iPhone' && cleanPasskeyName('   ', 'fb') === 'fb' && cleanPasskeyName(5, 'fb') === 'fb' && cleanPasskeyName('a'.repeat(60), 'x').length === 40, 'names cleaned');
    assert(defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)') === 'iPhone' && defaultPasskeyName('Linux; Android 14') === 'Android phone' && defaultPasskeyName('') === 'Phone or computer', 'default names');
    const entry = { credentialId: CID, publicKey: 'KEY', counter: 3, transports: ['internal'], aaguid: 'g', name: 'n', createdAt: 'c', lastUsedAt: null, createdBySid: 's' };
    const pub = publicPasskey(entry);
    assert(J(Object.keys(pub).sort()) === J(['createdAt', 'id', 'lastUsedAt', 'name']) && !J(pub).includes('KEY'), 'public view: no key, counter, handle or sid');
    assert(credentialIdHash(CID) === credentialIdHash(CID) && credentialIdHash(CID) !== credentialIdHash(CID + 'a') && !credentialIdHash(CID).includes(CID), 'index key: stable, distinct, not the id');

    const pc = newPersonCredentials('p1', 'now');
    assert(pc.personId === 'p1' && Buffer.from(pc.passkeyUserHandle, 'base64url').length === 32 && pc.credVersion === 0 && pc.recentAuthEpoch === 0 && pc.passkeys.length === 0, 'new person credentials');
    assert(newPersonCredentials('p1', 'now').passkeyUserHandle !== pc.passkeyUserHandle, 'handles are random');
    assert(asPersonCredentials(pc, 'p1') && !asPersonCredentials(pc, 'p2') && !asPersonCredentials({ ...pc, passkeys: null }, 'p1') && !asPersonCredentials({ ...pc, credVersion: 1.5 }, 'p1') && !asPersonCredentials({ ...pc, passkeyUserHandle: '' }, 'p1'), 'stored doc validated');
    assert(findPasskey({ ...pc, passkeys: [entry] }, CID) && !findPasskey({ ...pc, passkeys: [entry] }, CID + 'x') && !findPasskey(null, CID), 'findPasskey');

    assert(isPasskeyAuthMethod({ type: 'passkey', personId: 'p', credentialId: CID }), 'auth method ok');
    for (const bad of [{ type: 'password', personId: 'p', credentialId: CID }, { type: 'passkey', personId: '', credentialId: CID }, { type: 'passkey', personId: 'p', credentialId: 'short' }, null]) assert(!isPasskeyAuthMethod(bad), `auth method refused ${J(bad)}`);
    const sd = buildUserSession({ sid: 'AAAAAAAAAAAAAAAAAAAAAA', row: { id: 'r', personId: 'p' }, epoch: 0, via: 'passkey', nowMs: now, authMethod: { type: 'passkey', personId: 'p', credentialId: CID }, recentAuth: { atMs: now, epoch: 3 } });
    assert(sd.authMethod?.credentialId === CID && sd.recentAuthAtMs === now && sd.recentAuthEpoch === 3 && sd.via === 'passkey', 'session carries authMethod + proof');
    const plain = buildUserSession({ sid: 'AAAAAAAAAAAAAAAAAAAAAA', row: { id: 'r', personId: 'p' }, epoch: 0, via: 'adopt', nowMs: now });
    assert(!('authMethod' in plain) && !('recentAuthAtMs' in plain), 'a session without them has neither');

    const ch = C(chooseClaimsFor({ id: 'r', personId: 'p', tokenEpoch: 1 }, CID));
    assert(ch && ch.kind === 'choose' && ch.passkeyCredentialId === CID, 'choose token with pk');
    const ch0 = C(chooseClaimsFor({ id: 'r', personId: 'p' }));
    assert(ch0 && ch0.kind === 'choose' && !('passkeyCredentialId' in ch0), 'choose token without pk');
    assert(C({ v: 3, sub: 'p', cr: 'r', ep: 0, pk: 'bad id!' }) === null && C({ v: 3, sub: 'p', cr: 'r', ep: 0, pk: 5 }) === null, 'malformed pk -> no token');
    return 'proof window + epoch, challenge matching, counters, names, public view, index key, session marker, choose pk';
  },
};
