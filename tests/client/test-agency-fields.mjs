/**
 * 8a unit test: pure agency-field helpers (normalise, validate, uniqueness, projections).
 * Run: npx tsx tests/client/test-agency-fields.mjs
 */
import {
  normalizeSlug, validateSlug, slugBase, uniqueSlug, normalizeDomain, validateDomain,
  validateBrandName, validateLogoUrl, findSlugClash, findDomainClash, withCustomDomain,
  agencyPublicProfile, agencyAdminView, stripServerOnlyAgencyFields, agencyIdForVerifiedHost,
} from '../../src/server/agency-fields.ts';

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: expected ${e}, got ${a}`); failures++; } else console.log(`ok ${label}`);
}

// slugs
check('slug normalise', normalizeSlug('  HKC-Hartford '), 'hkc-hartford');
for (const s of ['abc', 'hkc', 'a1-b2', 'x'.repeat(40)]) check(`slug ok ${s.slice(0, 12)}`, validateSlug(s), null);
for (const s of ['ab', '-abc', 'abc-', 'a--b', 'a b', 'ABC', 'x'.repeat(41), 'api', 'www', 'shutfey', 'a_b', '']) check(`slug bad ${JSON.stringify(s.slice(0, 12))}`, validateSlug(s) !== null, true);
check('slugBase from short code', slugBase('HKC', 'Hartford'), 'hkc');
check('slugBase from name', slugBase('', 'Chicago Rabbinical Council (cRc)'), 'chicago-rabbinical-council-crc');
check('slugBase reserved', slugBase('API', ''), 'api-agency');
check('slugBase short', slugBase('K', ''), 'k-agency');
check('slugBase valid', validateSlug(slugBase('ÖU!!', '')), null);
const ags = [{ id: 'a', slug: 'hkc' }, { id: 'b', slug: 'hkc-2' }];
check('uniqueSlug suffix', uniqueSlug('hkc', ags), 'hkc-3');
check('uniqueSlug self ok', uniqueSlug('hkc', ags, 'a'), 'hkc');
check('slug clash case-insensitive', !!findSlugClash([{ id: 'a', slug: 'HKC' }], 'b', 'hkc'), true);
check('slug clash legacy spaces+case', !!findSlugClash([{ id: 'a', slug: '  My-Agency  ' }], 'b', 'my-agency'), true);
check('slug clash request normalised', !!findSlugClash([{ id: 'a', slug: 'my-agency' }], 'b', ' MY-AGENCY '), true);
check('slug clash empty never', findSlugClash([{ id: 'a', slug: '' }], 'b', ''), null);
check('slug clash self ignored', findSlugClash([{ id: 'a', slug: 'hkc' }], 'a', 'hkc'), null);

// domains
check('domain normalise', normalizeDomain('  App.Example.COM. '), 'app.example.com');
for (const d of ['app.hartfordkashrut.org', 'a.b', 'x-1.example.co.uk']) check(`domain ok ${d}`, validateDomain(d), null);
for (const d of ['', 'localhost', 'nodot', 'https://a.com', 'a.com/x', 'a.com:443', 'u@a.com', '1.2.3.4', 'svc.us-east1.run.app', 'run.app', 'shutfey.com', 'app.shutfey.com', '-a.com', 'a-.com', 'a..com', 'a b.com', 'x'.repeat(250) + '.com'])
  check(`domain bad ${JSON.stringify(d.slice(0, 20))}`, validateDomain(d) !== null, true);
check('domain clash legacy unnormalised', !!findDomainClash([{ id: 'a', customDomain: 'App.Example.com.' }], 'b', 'app.example.com'), true);
check('domain clash self ignored', findDomainClash([{ id: 'a', customDomain: 'app.example.com' }], 'a', 'app.example.com'), null);

// brand / logo
check('brand trim', validateBrandName('  Hi  ').value, 'Hi');
check('brand too long', !!validateBrandName('x'.repeat(81)).error, true);
check('logo https', validateLogoUrl('https://cdn.example.org/l.png').value, 'https://cdn.example.org/l.png');
check('logo empty clears', validateLogoUrl('  ').value, '');
for (const u of ['http://x.org/l.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@x.org/l.png', 'not a url', 'https://' + 'x'.repeat(2050) + '.org'])
  check(`logo bad ${u.slice(0, 16)}`, !!validateLogoUrl(u).error, true);

// domain lifecycle
let n = 0; const mk = () => `tok${++n}`;
const a0 = { id: 'a', name: 'A' };
const a1 = withCustomDomain(a0, 'app.a.org', mk);
check('new domain pending', [a1.customDomain, a1.domainStatus, a1.domainVerificationToken], ['app.a.org', 'pending', 'tok1']);
const a2 = withCustomDomain({ ...a1, domainVerifiedAt: 'x' }, 'app.a.org', mk);
check('same domain keeps token + fields', [a2.domainVerificationToken, a2.domainVerifiedAt], ['tok1', 'x']);
const a3 = withCustomDomain({ ...a1, domainVerifiedAt: 'x', domainLastCheckedAt: 'y' }, 'new.a.org', mk);
check('changed domain new token, cleared', [a3.domainStatus, a3.domainVerificationToken, 'domainVerifiedAt' in a3, 'domainLastCheckedAt' in a3], ['pending', 'tok2', false, false]);
const a4 = withCustomDomain(a3, '', mk);
check('cleared domain', [a4.domainStatus, 'customDomain' in a4, 'domainVerificationToken' in a4], ['none', false, false]);
const legacy = withCustomDomain({ id: 'l', customDomain: 'App.L.org.' }, 'app.l.org', mk);
check('legacy domain without status gets pending + token', [legacy.domainStatus, legacy.domainVerificationToken], ['pending', 'tok3']);

// projections
const full = { id: 'a', name: 'A', shortCode: 'A', certificationSeal: 'S', region: 'R', contactPhone: 'P', timeZone: 'America/New_York', slug: 'a-1', brandName: 'B', logoUrl: 'https://l', adminEmail: 'x@y', createdAt: 'c', customDomain: 'd.org', domainStatus: 'pending', domainVerificationToken: 'SECRET', domainVerifiedAt: 'v', domainLastCheckedAt: 'l', somethingNew: 1 };
check('public keys', Object.keys(agencyPublicProfile(full)).sort(), ['brandName', 'certificationSeal', 'contactPhone', 'id', 'logoUrl', 'name', 'region', 'shortCode', 'slug', 'timeZone']);
check('admin keys', Object.keys(agencyAdminView(full)).sort(), ['adminEmail', 'brandName', 'certificationSeal', 'contactPhone', 'createdAt', 'customDomain', 'domainLastCheckedAt', 'domainStatus', 'domainVerifiedAt', 'id', 'logoUrl', 'name', 'region', 'shortCode', 'slug', 'timeZone']);
check('no projection carries the token', JSON.stringify([agencyPublicProfile(full), agencyAdminView(full)]).includes('SECRET'), false);
check('strip server-only', Object.keys(stripServerOnlyAgencyFields({ slug: 's', domainStatus: 'verified', domainVerificationToken: 't', domainVerifiedAt: 'v', domainLastCheckedAt: 'l' })), ['slug']);

// verified-only host
const hostAgs = [
  { id: 'p', customDomain: 'pend.org', domainStatus: 'pending' },
  { id: 'v', customDomain: 'Ver.org.', domainStatus: 'verified' },
  { id: 'd1', customDomain: 'dup.org', domainStatus: 'verified' },
  { id: 'd2', customDomain: 'DUP.org', domainStatus: 'verified' },
  { id: 'n', customDomain: 'nostatus.org' },
];
check('host pending -> null', agencyIdForVerifiedHost(hostAgs, 'pend.org'), null);
check('host legacy no status -> null', agencyIdForVerifiedHost(hostAgs, 'nostatus.org'), null);
check('host verified (case, port)', agencyIdForVerifiedHost(hostAgs, 'VER.org:443'), 'v');
check('host ambiguous -> null', agencyIdForVerifiedHost(hostAgs, 'dup.org'), null);
check('host empty -> null', agencyIdForVerifiedHost(hostAgs, ''), null);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall agency-field checks passed');
