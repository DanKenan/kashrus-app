/**
 * Domains PR A (plan v4 2a-2d): host classification, APP_SITES parsing and the
 * trusted-origin rule (unit, pure).
 */
import {
  SHARED_RUN_APP_HOSTS, SHARED_ORIGIN, normalizeHostValue, rawHostHeader, isSharedHost, parseAppSites,
  classifyHost, originsWithSites, siteOrigin, passkeyAddressKind, SITE_NOT_SET_UP_BODY, WRONG_SITE_BODY,
} from '../../src/server/sites.ts';
import { trustedOrigins, DEFAULT_APP_ORIGINS } from '../../src/server/session-cookie.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (o) => JSON.stringify(o);
const H = (...pairs) => pairs.flatMap((v) => ['Host', v]);
const DET = 'workers-collaborative-dashboard-1080260390009.us-east1.run.app';
const HASH = 'workers-collaborative-dashboard-je3qe44lta-ue.a.run.app';

export default {
  name: 'Domains PR A: sites.ts host classification + APP_SITES + origins (unit)',
  whatItProves: 'Only the two pinned run.app hosts (and exactly "<tag>---"+pinned) are SHARED in production, loopback only off Cloud Run; the Host comes from exactly one raw Host header, strict; APP_SITES duplicates/shared hosts/malformed entries/missing agencies are refused as the plan says; with APP_SITES unset the trusted-origin list is byte-identical to today.',
  async run() {
    // Pinned shared hosts (E0, Don's D0 output).
    assert(J(SHARED_RUN_APP_HOSTS) === J([DET, HASH]), `pinned hosts: ${J(SHARED_RUN_APP_HOSTS)}`);
    assert(SHARED_ORIGIN === 'https://' + DET && SHARED_ORIGIN === DEFAULT_APP_ORIGINS[0], 'shared origin = today\'s default origin');
    const prod = { local: false };
    const local = { local: true };
    for (const h of [DET, HASH, 'stage2-staged---' + DET, 'sites---' + HASH, 'a-1---' + DET]) assert(isSharedHost(h, prod), `shared: ${h}`);
    for (const h of ['evil.run.app', 'x.us-east1.run.app', 'workers-collaborative-dashboard-other-ue.a.run.app', 'stage2---evil.run.app',
      'a.b---' + DET, '---' + DET, DET + '.evil.com', 'localhost', '127.0.0.1', 'app.hartfordkashrut.org']) {
      assert(!isSharedHost(h, prod), `not shared in production: ${h}`);
    }
    for (const h of ['localhost:3470', '127.0.0.1:3470', '[::1]:3470', 'localhost']) assert(isSharedHost(h, local), `shared off Cloud Run: ${h}`);

    // Host value: strict DNS name; lower-cased; port only off Cloud Run.
    assert(normalizeHostValue(DET, { allowPort: false }) === DET, 'plain host');
    assert(normalizeHostValue(DET.toUpperCase(), { allowPort: false }) === DET, 'DNS names compare case-insensitively');
    for (const bad of [DET + '.', DET + ':443', 'user@' + DET, ' ' + DET, DET + ' ', '', 'a', '-a.com', 'a-.com', 'a..com', 'a_b.com', '127.0.0.1', 'localhost', DET + '/x', 'a.com:99999', 'a.com:0', 'a.com:080']) {
      assert(normalizeHostValue(bad, { allowPort: false }) === null, `refused in production: ${J(bad)}`);
    }
    assert(normalizeHostValue('site-a.test:3470', { allowPort: true }) === 'site-a.test:3470', 'port off Cloud Run');
    assert(normalizeHostValue('127.0.0.1:3470', { allowPort: true }) === '127.0.0.1:3470', 'loopback off Cloud Run');

    // Exactly one raw Host header.
    assert(rawHostHeader(H(DET)) === DET, 'one Host');
    assert(rawHostHeader(['host', DET, 'X-Forwarded-Host', 'app.evil.org']) === DET, 'X-Forwarded-Host never counts');
    assert(rawHostHeader(H(DET, DET)) === null, 'two Host headers: none');
    assert(rawHostHeader([]) === null && rawHostHeader(undefined) === null, 'no Host: none');

    // APP_SITES parsing.
    const none = parseAppSites(undefined, prod);
    assert(none.sites.size === 0 && none.entries.length === 0, 'unset: no sites');
    assert(parseAppSites('  ', prod).sites.size === 0, 'blank: no sites');
    const p = parseAppSites('app.hartfordkashrut.org=agency-hkc; app.newhavenvaad.com=agency-nhk;' +
      'dup.example.org=agency-a;dup.example.org=agency-a;' + DET + '=agency-x;stage2---' + HASH + '=agency-x;' +
      'nohost;=agency-y;bad host.org=a;ok.example.org=bad id!;port.example.org:8443=agency-p', prod);
    assert(J([...p.sites]) === J([['app.hartfordkashrut.org', 'agency-hkc'], ['app.newhavenvaad.com', 'agency-nhk']]), `sites: ${J([...p.sites])}`);
    assert(p.entries.filter((e) => e.host === 'dup.example.org').length === 2 && p.entries.filter((e) => e.host === 'dup.example.org').every((e) => !e.ok), 'a host listed twice: all its entries rejected');
    assert(p.entries.some((e) => e.host === DET && !e.ok) && p.entries.some((e) => e.host === 'stage2---' + HASH && !e.ok), 'shared hosts cannot be sites');
    assert(p.malformed.length === 5, `malformed ignored: ${J(p.malformed)}`);
    assert(parseAppSites('site-a.test:3470=agency-a', local).sites.get('site-a.test:3470') === 'agency-a', 'port allowed off Cloud Run');

    // Classification.
    const exists = (id) => id === 'agency-hkc';
    const cfg = { sites: p.sites, local: false, agencyExists: exists };
    assert(J(classifyHost(H(DET), cfg)) === J({ kind: 'shared', host: DET }), 'shared');
    assert(classifyHost(H('dup.example.org'), cfg).kind === 'unknown', 'duplicate host is UNKNOWN');
    assert(classifyHost(H(DET), cfg).kind === 'shared', 'an entry naming a shared host leaves it SHARED');
    const s = classifyHost(H('app.hartfordkashrut.org'), cfg);
    assert(s.kind === 'site' && s.agencyId === 'agency-hkc' && s.origin === 'https://app.hartfordkashrut.org', `site: ${J(s)}`);
    assert(classifyHost(H('APP.HARTFORDKASHRUT.ORG'), cfg).kind === 'site', 'upper-case Host still selects the site');
    assert(classifyHost(H('app.newhavenvaad.com'), cfg).kind === 'unknown', 'missing agency: UNKNOWN');
    assert(classifyHost(H('app.hartfordkashrut.org', 'app.hartfordkashrut.org'), cfg).kind === 'unknown', 'two Host headers: UNKNOWN');
    assert(classifyHost(['Host', 'unmapped.example.org', 'X-Forwarded-Host', 'app.hartfordkashrut.org'], cfg).kind === 'unknown', 'X-Forwarded-Host cannot select a site');
    assert(classifyHost(['Host', 'app.hartfordkashrut.org', 'X-Forwarded-Host', DET], cfg).kind === 'site', 'X-Forwarded-Host cannot make a site shared');
    assert(classifyHost(H('127.0.0.1:3470'), cfg).kind === 'unknown', 'loopback is UNKNOWN on Cloud Run');
    assert(classifyHost(H('127.0.0.1:3470'), { ...cfg, local: true }).kind === 'shared', 'loopback is SHARED off Cloud Run');
    assert(siteOrigin('site-a.test:3470', local) === 'http://site-a.test:3470' && siteOrigin('app.x.org', prod) === 'https://app.x.org', 'site origins');

    // Origins: unset = byte-identical; set = default kept + site origins.
    for (const appOrigins of [undefined, '', 'https://a.example.org,https://b.example.org']) {
      const shared = trustedOrigins({ appOrigins, testMode: false, port: 8080 });
      assert(J(originsWithSites(shared, none.sites, prod)) === J(shared), `unset APP_SITES leaves the list unchanged (${J(appOrigins)})`);
    }
    const withSites = originsWithSites(trustedOrigins({ appOrigins: 'https://a.example.org', testMode: false, port: 8080 }), p.sites, prod);
    assert(J(withSites) === J(['https://a.example.org', SHARED_ORIGIN, 'https://app.hartfordkashrut.org', 'https://app.newhavenvaad.com']), `with sites: ${J(withSites)}`);

    // Passkey address kinds (2d).
    assert(passkeyAddressKind(undefined, p.sites, prod).kind === 'earlier', 'no rpId: earlier address');
    assert(passkeyAddressKind(DET, p.sites, prod).kind === 'shared', 'run.app rpId: shared');
    assert(J(passkeyAddressKind('app.hartfordkashrut.org', p.sites, prod)) === J({ kind: 'site', agencyId: 'agency-hkc' }), 'site rpId');
    assert(passkeyAddressKind('gone.example.org', p.sites, prod).kind === 'other', 'unconfigured rpId: other');
    assert(passkeyAddressKind('site-a.test', parseAppSites('site-a.test:3470=agency-a', local).sites, local).kind === 'site', 'rpId matches a site host without its port');

    // Refusal bodies name the shared origin and never an agency.
    assert(SITE_NOT_SET_UP_BODY.code === 'SITE_NOT_SET_UP' && SITE_NOT_SET_UP_BODY.sharedOrigin === SHARED_ORIGIN, 'SITE_NOT_SET_UP body');
    assert(WRONG_SITE_BODY.code === 'WRONG_SITE' && WRONG_SITE_BODY.sharedOrigin === SHARED_ORIGIN, 'WRONG_SITE body');
  },
};
