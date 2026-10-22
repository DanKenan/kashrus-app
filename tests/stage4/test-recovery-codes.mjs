/**
 * Item 10f: recovery codes (unit, pure) + credentialMayLink (D1) + the
 * identity writer recoveryWriteById (credential row only) + backup scrub.
 */
import {
  generateRecoveryCodes, normalizeRecoveryCode, matchRecoveryCode, burnRecoveryCode, recoveryLocked,
  recordRecoveryFailure, isRecoveryCodeSet, hashRecoveryCode, CROCKFORD_ALPHABET, RECOVERY_LOCK_MS,
} from '../../src/server/recovery-codes.ts';
import { credentialMayLink } from '../../src/server/invites.ts';
import { enforceIdentityFields } from '../../src/server/identity.ts';
import { scrubSecrets } from '../../src/server/backup.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);

export default {
  name: 'Item 10f: recovery codes (unit)',
  whatItProves: '10 Crockford codes per set, salted sha256 only, normalize/match/burn, every hash compared, 5-failure 1 h lock per person, credentialMayLink only for self-registered/invite-new, recoveryWriteById only on the credential row, backups scrub both fields.',
  async run() {
    const now = '2026-10-22T00:00:00.000Z';
    const { codes, set } = generateRecoveryCodes(now);
    assert(codes.length === 10 && new Set(codes).size === 10, 'ten distinct codes');
    for (const c of codes) {
      assert(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(c), `format ${c}`);
      for (const ch of c.replace('-', '')) assert(CROCKFORD_ALPHABET.includes(ch), `alphabet ${ch}`);
    }
    assert(isRecoveryCodeSet(set) && set.hashes.length === 10 && set.salt.length === 32 && set.createdAt === now, 'set shape');
    assert(!J(set).includes(codes[0].replace('-', '')), 'no plaintext in the stored set');
    // uniqueness across many sets
    const seen = new Set();
    for (let i = 0; i < 1000; i++) for (const c of generateRecoveryCodes(now).codes) seen.add(c);
    assert(seen.size === 10000, `10000 distinct codes over 1000 sets (${seen.size})`);
    // salts differ per set
    assert(generateRecoveryCodes(now).set.salt !== generateRecoveryCodes(now).set.salt, 'salt per set');
    // normalize
    const raw = codes[3].replace('-', '');
    assert(normalizeRecoveryCode(codes[3]) === raw, 'hyphen form');
    assert(normalizeRecoveryCode(` ${raw.slice(0, 5).toLowerCase()} ${raw.slice(5)} `) === raw, 'spaces + lowercase');
    assert(normalizeRecoveryCode('O0IL1-ABCDE') === '00111ABCDE', 'Crockford O/I/L');
    assert(normalizeRecoveryCode('ABCDEFGHJK1') === null && normalizeRecoveryCode('ABCDEFGHJ') === null && normalizeRecoveryCode('ABCDEFGHJU') === null, 'bad length / U refused');
    assert(normalizeRecoveryCode(12345) === null, 'non-string refused');
    // match / burn
    for (let i = 0; i < 10; i++) assert(matchRecoveryCode(set, codes[i]) === i, `match ${i}`);
    assert(matchRecoveryCode(set, 'ZZZZZ-ZZZZZ') === -1 || codes.includes('ZZZZZ-ZZZZZ'), 'wrong code -1');
    assert(matchRecoveryCode(set, 'nope') === -1, 'malformed -1');
    assert(matchRecoveryCode({ ...set, v: 2 }, codes[0]) === -1 && matchRecoveryCode(null, codes[0]) === -1, 'bad set -1');
    // RV1 N1: malformed stored sets are refused
    assert(!isRecoveryCodeSet({ ...set, salt: 'abc' }) && !isRecoveryCodeSet({ ...set, salt: set.salt.toUpperCase() }), 'bad salt refused');
    assert(!isRecoveryCodeSet({ ...set, hashes: [...set.hashes, set.hashes[0]] }), 'more than 10 hashes refused');
    assert(!isRecoveryCodeSet({ ...set, createdAt: 'not-a-date' }) && !isRecoveryCodeSet({ ...set, hashes: ['x'] }), 'bad timestamp / hash refused');
    assert(isRecoveryCodeSet({ ...set, hashes: [] }), 'an exhausted set is still a valid set');
    const burned = burnRecoveryCode(set, 2);
    assert(burned.hashes.length === 9 && matchRecoveryCode(burned, codes[2]) === -1 && matchRecoveryCode(burned, codes[5]) === 4, 'burn removes exactly one');
    assert(hashRecoveryCode(set.salt, raw) === set.hashes[3], 'hash = sha256(salt:code)');
    // lock state machine
    const t0 = Date.parse(now);
    let f = undefined;
    for (let i = 1; i <= 4; i++) { f = recordRecoveryFailure(f, t0 + i); assert(f.count === i && f.lockedUntil === null, `fail ${i} not locked`); }
    assert(!recoveryLocked(f, t0 + 5), '4 fails: not locked');
    f = recordRecoveryFailure(f, t0 + 5);
    assert(f.lockedUntil !== null && recoveryLocked(f, t0 + 6) && Date.parse(f.lockedUntil) === t0 + 5 + RECOVERY_LOCK_MS, '5th locks for 1 h');
    assert(recoveryLocked(f, t0 + 5 + RECOVERY_LOCK_MS - 1) && !recoveryLocked(f, t0 + 5 + RECOVERY_LOCK_MS), 'lock expires after 1 h');
    const after = recordRecoveryFailure(f, t0 + 5 + RECOVERY_LOCK_MS + 1);
    assert(after.count === 1 && after.lockedUntil === null, 'after expiry the count starts over');
    assert(!recoveryLocked(undefined, t0) && !recoveryLocked({ count: 'x', lockedUntil: 'nope' }, t0), 'garbage reads unlocked');
    // D1 table
    const table = [['self-registered', true], ['invite-new', true], ['admin', false], ['agency-reset', false], [undefined, false], [null, false], ['', false], ['SELF-REGISTERED', false], ['self', false]];
    for (const [o, want] of table) assert(credentialMayLink(o) === want, `credentialMayLink(${J(o)}) = ${want}`);
    // identity writer: credential row only
    const before = [
      { id: 'p1', personId: 'p1', email: 'a@x', password: 'h', credentialOrigin: 'self-registered' },
      { id: 'q1', personId: 'q1', email: 'q@x', password: 'h', credentialOwner: true, credentialOrigin: 'self-registered', recoveryCodeHashes: set },
      { id: 'q2', personId: 'q1', email: 'q@x' },
    ];
    let violations = [];
    const enf = (after, rw) => { violations = []; return enforceIdentityFields(before, after, [], { recoveryWriteById: new Map(Object.entries(rw)), onViolation: (id, fld) => violations.push(`${id}:${fld}`) }); };
    let out = enf(before, { p1: { codes: set } });
    assert(J(out[0].recoveryCodeHashes) === J(set) && violations.length === 0, 'single-row credential row written');
    out = enf(before, { q1: { failures: { count: 1, lockedUntil: null } } });
    assert(out[1].recoveryFailures?.count === 1 && J(out[1].recoveryCodeHashes) === J(set), 'owner row: failures written, codes kept');
    out = enf(before, { q1: { codes: null } });
    assert(out[1].recoveryCodeHashes === undefined, 'null removes');
    out = enf(before, { q2: { codes: set } });
    assert(out[2].recoveryCodeHashes === undefined && violations.includes('q2:recoveryWrite'), 'non-owner row refused + reported');
    out = enf([...before, { id: 'n1', email: 'n@x' }], { n1: { codes: set } });
    assert(out[3].recoveryCodeHashes === undefined, 'new row refused');
    out = enforceIdentityFields(before, before.map((u) => (u.id === 'p1' ? { ...u, recoveryCodeHashes: set } : u)), [], {});
    assert(out[0].recoveryCodeHashes === undefined, 'a mutator cannot write the field without the writer');
    // backup scrub on the real users[] structure
    const scrubbed = scrubSecrets({ users: [{ id: 'q1', recoveryCodeHashes: set, recoveryFailures: { count: 2, lockedUntil: null } }] });
    assert(scrubbed.users[0].recoveryCodeHashes === '[REDACTED]' && scrubbed.users[0].recoveryFailures === '[REDACTED]', `backup scrub ${J(scrubbed.users[0])}`);
    assert(!J(scrubbed).includes(set.hashes[0]) && !J(scrubbed).includes(set.salt), 'no hash or salt in backup output');
  },
};
