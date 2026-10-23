/**
 * Agency welcome page (agency own addresses): the site answer's phone, the short name, call/text links,
 * slot filling (text only, never markup), scoped CSS, demo coverage, and the "no hard-coded agency /
 * no Adler / demo data only" rule.
 * Run: npx tsx tests/client/test-welc-agency-welcome.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; }

globalThis.window = { location: { hostname: 'app.valley.test' } };
const S = await import('../../src/lib/site.ts');

// ---- /api/site: contactPhone is optional and validated ----
const base = { site: 'agency', agency: { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null }, sharedOrigin: null };
const withPhone = (p) => S.parseSiteAnswer({ ...base, agency: { ...base.agency, contactPhone: p } });
check('no contactPhone (today\'s server): null', S.parseSiteAnswer(base).agency.contactPhone === null);
check('contactPhone E.164 kept as sent', withPhone('+15550100199').agency.contactPhone === '+15550100199');
check('contactPhone kept (trimmed)', withPhone('  (555) 010-0199 ').agency.contactPhone === '(555) 010-0199');
for (const bad of ['', '   ', 'call us', '<img src=x>', '12', '1'.repeat(16), 42, null, { a: 1 }, '+1 555 010 0199 ext 4', 'x'.repeat(41)]) {
  check(`bad contactPhone ${JSON.stringify(bad)}: null`, withPhone(bad).agency.contactPhone === null);
}
check('the rest of the answer unchanged', JSON.stringify({ ...withPhone('5550100199').agency, contactPhone: undefined }) === JSON.stringify({ name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null }));

// ---- call/text links ----
check('US 10 digits -> +1', JSON.stringify(S.phoneLinks('(555) 010-0199')) === JSON.stringify({ display: '(555) 010-0199', tel: 'tel:+15550100199', sms: 'sms:+15550100199' }));
check('11 digits starting 1 -> +1…', S.phoneLinks('1-555-010-0199').tel === 'tel:+15550100199');
check('E.164 +1 (how the server stores it) shown as (XXX) XXX-XXXX', JSON.stringify(S.phoneLinks('+13476700381')) === JSON.stringify({ display: '(347) 670-0381', tel: 'tel:+13476700381', sms: 'sms:+13476700381' }));
check('international with + kept', S.phoneLinks('+44 20 7946 0958').tel === 'tel:+442079460958');
check('7 digits: digits only', S.phoneLinks('555-0199').tel === 'tel:5550199');
check('letters / markup / too short / too long: null', [null, undefined, 'abc', '555-010-0199 x', '<b>1</b>', '123456', '1234567890123456'].every((x) => S.phoneLinks(x) === null));

// ---- short name ----
const ag = (o) => ({ name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null, ...o });
check('short code used', S.welcomeShortName(ag({})) === 'VV');
check('short code HKC-style', S.welcomeShortName(ag({ shortCode: 'HKC' })) === 'HKC');
check('empty / spaced / long / symbol short code -> display name', ['', 'x y', 'ABCDEFGHIJ', 'V&V', 'V'].every((c) => S.welcomeShortName(ag({ shortCode: c })) === 'Valley Vaad'));
check('brand name beats name', S.welcomeShortName(ag({ shortCode: '', brandName: 'Valley' })) === 'Valley');

// ---- slot filling: text only ----
const html = read('src/components/welcome/welcome.html');
function fakeRoot() {
  const els = new Map();
  const el = (sel) => ({ sel, textContent: '', hidden: false, attrs: {}, classList: { contains: (c) => sel.includes(c) }, setAttribute(k, v) { this.attrs[k] = v; }, set innerHTML(v) { throw new Error('innerHTML used'); } });
  const pick = (sel) => { if (!els.has(sel)) els.set(sel, [el(sel), el(sel + ' big-seal')]); return els.get(sel); };
  return { els, querySelectorAll: pick };
}
const { fillWelcome } = await import('../../src/components/welcome/welcomeFill.ts');
const r1 = fakeRoot();
fillWelcome(r1, ag({ name: '<b>Evil</b> & Co', shortCode: 'x y', contactPhone: null }), 'valley.test');
check('name as text', r1.els.get('[data-w-name]').every((e) => e.textContent === '<b>Evil</b> & Co'));
check('odd short code -> name as text', r1.els.get('[data-w-short]').every((e) => e.textContent === '<b>Evil</b> & Co'));
check('mockup title "<name> sign-in"', r1.els.get('[data-w-signin]')[0].textContent === '<b>Evil</b> & Co sign-in');
check('host as text', r1.els.get('[data-w-host]')[0].textContent === 'valley.test');
check('no phone: phone parts hidden, admin line shown', r1.els.get('[data-w-if-phone]').every((e) => e.hidden) && r1.els.get('[data-w-if-nophone]').every((e) => !e.hidden));
check('no phone: no tel/sms href set', !r1.els.has('a[data-w-tel]'));
const r2 = fakeRoot();
fillWelcome(r2, ag({ contactPhone: '+15550100199' }), 'valley.test');
check('phone: shown, links set', r2.els.get('[data-w-if-phone]').every((e) => !e.hidden) && r2.els.get('[data-w-if-nophone]').every((e) => e.hidden)
  && r2.els.get('a[data-w-tel]')[0].attrs.href === 'tel:+15550100199' && r2.els.get('a[data-w-sms]')[0].attrs.href === 'sms:+15550100199' && r2.els.get('a[data-w-tel]')[0].textContent === 'Call (555) 010-0199');
check('big logo labelled, others decorative', r2.els.get('[data-w-logo]')[1].attrs['aria-label'] === 'Valley Vaad logo' && r2.els.get('[data-w-logo]')[0].attrs['aria-hidden'] === 'true');
for (const slot of ['data-w-name', 'data-w-short', 'data-w-signin', 'data-w-host', 'data-w-logo', 'data-w-tel', 'data-w-sms', 'data-w-if-phone', 'data-w-if-nophone', 'data-w-toplabel']) {
  check(`markup has ${slot}`, html.includes(slot));
}
check('slots are empty in the markup (filled at run time)', !/data-w-(name|short|host|phone|signin)[^>]*>[^<]/.test(html));
check('three Sign in buttons go to the sign-in (data-signin)', (html.match(/data-signin/g) || []).length === 3);
check('no scripts / inline handlers in the markup', !/<script|\son\w+=/i.test(html));

// ---- general: no hard-coded agency, no Adler, demo data only ----
const files = ['src/components/welcome/welcome.html', 'src/components/welcome/welcome.css', 'src/components/welcome/AgencyWelcome.tsx', 'src/components/welcome/welcomeDemos.ts', 'src/components/welcome/welcomeFill.ts'];
for (const f of files) {
  const t = read(f);
  check(`${f}: no "Adler"`, !/adler/i.test(t));
  check(`${f}: no hard-coded agency (Hartford/HKC/phone/email)`, !/hartford|\bhkc\b|kenan|347|670-0381|@(?!example\.com)/i.test(t.replace(/@font-face|@media|@keyframes|@supports/g, '')));
}
const names = [...html.matchAll(/\b(Yossi|Moshe|Dovid|Leah|Sarah|David|Rivka|Chaim|Avi|Miriam|Shira|Eli|Daniel)\b/g)].map((m) => m[1]);
check('demo first names only', names.length > 0 && names.every((n) => ['Yossi', 'Moshe', 'Dovid', 'Leah', 'Sarah'].includes(n)));
check('demo venue Hill Bakery', html.includes('Hill Bakery'));
check('tablet code wording', html.includes('Your <span data-w-short></span> admin gives you your code.'));

// ---- every demo in the markup has a script, and the reverse ----
const { WELCOME_SCRIPTS } = await import('../../src/components/welcome/welcomeDemos.ts');
const demos = new Set([...html.matchAll(/data-demo="(\w+)"/g)].map((m) => m[1]));
check('demo scripts match the markup', [...demos].every((d) => WELCOME_SCRIPTS[d]) && Object.keys(WELCOME_SCRIPTS).every((k) => demos.has(k)));

// ---- CSS: every rule scoped under .shf-welc; keyframes namespaced ----
const css = postcss.parse(read('src/components/welcome/welcome.css'));
let rules = 0, unscoped = [];
css.walkRules((r) => { if (r.parent?.type === 'atrule' && /keyframes/.test(r.parent.name)) return; rules++; for (const s of r.selectors) if (!s.startsWith('.shf-welc')) unscoped.push(s); });
check(`all ${rules} welcome rules scoped (${unscoped.slice(0, 3).join(', ')})`, rules > 50 && unscoped.length === 0);
const kf = []; css.walkAtRules(/keyframes/, (a) => kf.push(a.params));
check('keyframes namespaced', kf.every((k) => k.startsWith('shf-welc-')));

// ---- sign-in look: scoped, small, visual only ----
const si = postcss.parse(read('src/components/signin-look.css'));
let siRules = 0; const siBad = [];
si.walkRules((r) => { siRules++; for (const s of r.selectors) if (!s.startsWith('.shf-signin')) siBad.push(s); });
check(`sign-in look: all ${siRules} rules scoped under .shf-signin (${siBad.slice(0, 3).join(', ')})`, siRules > 10 && siBad.length === 0);
check('sign-in submit: dark text on the light gold (home page button colours, contrast >= 4.5:1)', /button\[type=submit\]\{background:linear-gradient\(180deg,#f0be6b,#dd9d3e\);color:#22170d/.test(read('src/components/signin-look.css')));
check('sign-in look is small (< 4 KB)', read('src/components/signin-look.css').length < 4096);
const lp = read('src/components/LoginPage.tsx');
check('LoginPage root carries the look class; hooks on top bar, card, below-card, footer', ['shf-signin min-h-screen', 'shf-signin-top', 'shf-signin-card', 'shf-signin-below', 'shf-signin-foot'].every((c) => lp.includes(c)));
check('sign-in look loaded with the app styles (main.tsx), not from LoginPage', read('src/main.tsx').includes("import './components/signin-look.css';") && !lp.includes('signin-look.css'));
check('branded sign-in shows Back when the app passes it', lp.includes('{onBack && <LandingBackButton onBack={onBack} />}'));

// ---- App wiring ----
const app = read('src/App.tsx');
check('welcome is lazy', /const AgencyWelcome = lazy\(\(\) => import\('\.\/components\/welcome\/AgencyWelcome'\)\)/.test(app) && !/^import .*AgencyWelcome/m.test(app));
check('welcome only for a site agency on the landing view', app.includes("if (authView === 'landing' && siteAgency) {"));
check('branded Back only outside the installed app', app.includes("onBack={siteAgency && isInstalledApp() ? undefined : () => setAuthView('landing')}"));
check('welcome branch comes after the kiosk / site-wait guards', app.indexOf("if (authView === 'landing' && siteAgency)") > app.indexOf('if (isKiosk) {') && app.indexOf("if (authView === 'landing' && siteAgency)") > app.indexOf('data-site-loading'));

console.log(`welcome page: ${passed} checks passed`);
