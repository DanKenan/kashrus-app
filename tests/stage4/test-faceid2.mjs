/**
 * FACEID2 (unit, pure): a person in two agencies.
 *  - the choose token carries the sign-in proof (ra/re) only as a well-formed pair;
 *  - chosenRecentAuth copies it unchanged inside 5 minutes and never extends it;
 *  - passkeyWorksHere: a passkey works only on the host name it was made for.
 */
import { chosenRecentAuth, recentAuthValid, RECENT_AUTH_MS } from '../../src/server/passkeys.ts';
import { classifySessionClaims as C, chooseClaimsFor } from '../../src/server/session-token.ts';
import { passkeyWorksHere, classifyHost, parseAppSites, SHARED_RUN_APP_HOSTS } from '../../src/server/sites.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);
const CID = 'AbCdEfGhIjKlMnOpQrStUv0123456789_-xyz';

export default {
  name: 'FACEID2: Face ID for people in two agencies (unit)',
  whatItProves: 'The choose token carries the sign-in proof only as a well-formed ra/re pair; the chosen session gets it unchanged and only inside its 5 minutes; a passkey counts as "here" only on the host name it was made for (earlier entries: shared hosts only; unknown host: never).',
  async run() {
    const now = 1_800_000_000_000;
    // ---- choose token ra/re ----
    const base = { v: 3, sub: 'p', cr: 'r', ep: 0 };
    const ok = C({ ...base, ra: now, re: 2 });
    assert(ok && ok.kind === 'choose' && ok.recentAuth?.atMs === now && ok.recentAuth?.epoch === 2, `ra/re pair accepted ${J(ok)}`);
    const okPk = C({ ...base, pk: CID, ra: now, re: 0 });
    assert(okPk && okPk.passkeyCredentialId === CID && okPk.recentAuth?.atMs === now, 'pk + ra/re');
    const none = C(base);
    assert(none && none.kind === 'choose' && !('recentAuth' in none), 'an old choose token without ra/re is still a choose token, with no proof');
    for (const bad of [{ ra: now }, { re: 0 }, { ra: -1, re: 0 }, { ra: now + 0.5, re: 0 }, { ra: String(now), re: 0 }, { ra: now, re: -1 }, { ra: now, re: 1.5 }, { ra: 2 ** 60, re: 0 }, { ra: null, re: 0 }, { ra: now, re: '0' }]) {
      assert(C({ ...base, ...bad }) === null, `malformed proof refuses the token ${J(bad)}`);
      assert(C({ ...base, pk: CID, ...bad }) === null, `malformed proof refuses the token (with pk) ${J(bad)}`);
    }
    const signed = chooseClaimsFor({ id: 'r', personId: 'p', tokenEpoch: 1 }, undefined, { atMs: now, epoch: 4 });
    assert(signed.ra === now && signed.re === 4 && signed.ep === 1 && !('pk' in signed), `chooseClaimsFor with proof ${J(signed)}`);
    assert(J(chooseClaimsFor({ id: 'r', personId: 'p' })) === J({ v: 3, sub: 'p', cr: 'r', ep: 0 }), 'chooseClaimsFor without proof unchanged');
    assert(!('ra' in chooseClaimsFor({ id: 'r', personId: 'p' }, CID, { atMs: -5, epoch: 0 })), 'a bad proof is never signed');

    // ---- chosenRecentAuth: copied unchanged, never extended ----
    const cp = chosenRecentAuth({ atMs: now, epoch: 3 }, now + 1000);
    assert(cp && cp.atMs === now && cp.epoch === 3, 'copied with its own moment');
    assert(chosenRecentAuth({ atMs: now, epoch: 3 }, now + RECENT_AUTH_MS - 1)?.atMs === now, 'last millisecond: copied');
    assert(chosenRecentAuth({ atMs: now, epoch: 3 }, now + RECENT_AUTH_MS) === undefined, 'exactly 5 minutes: not copied');
    assert(chosenRecentAuth({ atMs: now + 1, epoch: 3 }, now) === undefined, 'future: not copied');
    for (const bad of [undefined, null, {}, { atMs: now }, { epoch: 0 }, { atMs: now, epoch: -1 }, { atMs: -1, epoch: 0 }, { atMs: now + 0.5, epoch: 0 }, { atMs: String(now), epoch: 0 }]) {
      assert(chosenRecentAuth(bad, now + 10) === undefined, `no proof from ${J(bad)}`);
    }
    // the copied proof is exactly as valid as the original: same end, same epoch rule
    const sess = { recentAuthAtMs: cp.atMs, recentAuthEpoch: cp.epoch };
    assert(recentAuthValid(sess, 3, now + RECENT_AUTH_MS - 1) && !recentAuthValid(sess, 3, now + RECENT_AUTH_MS), 'ends 5 minutes after the sign-in');
    assert(!recentAuthValid(sess, 4, now + 1000), 'dies when the person epoch moves');

    // ---- passkeyWorksHere ----
    const local = { local: true }, prod = { local: false };
    const sites = parseAppSites('site-a.test:3470=agency-a;app.example.org=agency-b', local).sites;
    const prodSites = parseAppSites('app.example.org=agency-b', prod).sites;
    const cls = (host, cfg, sm) => classifyHost(['Host', host], { sites: sm, local: cfg.local, agencyExists: () => true });
    const sharedLocal = cls('127.0.0.1:3470', local, sites);
    const siteLocal = cls('site-a.test:3470', local, sites);
    const unk = cls('nobody.test:3470', local, sites);
    assert(sharedLocal.kind === 'shared' && siteLocal.kind === 'site' && unk.kind === 'unknown', `classes ${J([sharedLocal, siteLocal, unk])}`);
    assert(passkeyWorksHere('127.0.0.1', sharedLocal) && !passkeyWorksHere('127.0.0.1', siteLocal), 'shared-made passkey: here on shared, not on the site');
    assert(passkeyWorksHere('site-a.test', siteLocal) && !passkeyWorksHere('site-a.test', sharedLocal), 'site-made passkey: here on the site (port ignored), not on shared');
    assert(passkeyWorksHere(undefined, sharedLocal) && passkeyWorksHere('', sharedLocal) && !passkeyWorksHere(undefined, siteLocal), 'earlier entry: shared only (compatibility rule)');
    assert(!passkeyWorksHere('nobody.test', unk) && !passkeyWorksHere(undefined, unk), 'unknown host: never, even with a matching rpId');
    assert(!passkeyWorksHere('nobody.test', { kind: 'unknown', host: null }), 'no host: never');
    const mixed = cls('SITE-A.test:3470', local, sites);
    assert(mixed.kind === 'site' && passkeyWorksHere('site-a.test', mixed), 'mixed-case Host is the same host');
    const [h1, h2] = SHARED_RUN_APP_HOSTS;
    const p1 = cls(h1, prod, prodSites), p2 = cls(h2, prod, prodSites), tag = cls(`sites---${h2}`, prod, prodSites), pSite = cls('app.example.org', prod, prodSites);
    assert(p1.kind === 'shared' && p2.kind === 'shared' && tag.kind === 'shared' && pSite.kind === 'site', 'prod classes');
    assert(passkeyWorksHere(h1, p1) && !passkeyWorksHere(h1, p2) && !passkeyWorksHere(h2, p1), 'the two run.app hosts are different addresses');
    assert(!passkeyWorksHere(h2, tag) && passkeyWorksHere(`sites---${h2}`, tag), 'a tagged revision host is its own address');
    assert(passkeyWorksHere('app.example.org', pSite) && !passkeyWorksHere(h1, pSite), 'prod site');
    assert(!passkeyWorksHere('app.example.org.', pSite) && !passkeyWorksHere('APP.example.org', pSite), 'rpId compared exactly (as stored, lower-case)');
    return 'choose ra/re shape, copy window (exact 5 min), here per host';
  },
};
