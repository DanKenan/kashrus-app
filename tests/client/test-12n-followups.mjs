/** Item 12 follow-ups (Don, Oct 21): logo-only badge with no type picked, restored-session agency
 * refresh, and no "Active Venue" line in the phone admin menu. */
import React from 'react';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { CertificationBadge } from '../../src/components/CertificationBadge.tsx';
import { Header } from '../../src/components/Header.tsx';
import { isLogoFeatureOn, withFreshAgencyFields } from '../../src/lib/agencyLogo.ts';
let passed = 0;
function check(name, value, info = '') { assert.ok(value, name + (info ? ' :: ' + info : '')); passed++; }
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = {};
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const src = 'data:image/png;base64,YQ==';
const A = 'Hartford Kashrut Commission (HKC)';

// 1. Logo + no certification type picked: only the logo image, no text at all.
const badge = (p) => renderToStaticMarkup(React.createElement(CertificationBadge, { certification: A, agencyName: A, agencyShortCode: 'HKC', iconClassName: 'icon', ...p }));
const only = badge({ logoSrc: src });
check('logo + no type: exactly one <img alt=agencyName>, no text node', only === `<img src="${src}" alt="${A}" class="h-[20px] w-auto max-w-[80px] object-contain"/>`, only);
check('logo + no type: same with an empty / blank stored detail', badge({ logoSrc: src, certificationDetail: '' }) === only && badge({ logoSrc: src, certificationDetail: '  ' }) === only);
const strip = (h) => h.replace(/<[^>]*>/g, '');
check('logo + no type: no visible text', strip(only) === '' && !only.includes('<span') && !only.includes('<svg'));
const noLogo = badge({});
check('no logo + no type: unchanged (shield icon + stored name)', noLogo.includes('<svg') && strip(noLogo) === A && !noLogo.includes('<img'));
const typed = badge({ logoSrc: src, certification: `${A} — Glatt meat`, certificationDetail: 'Glatt meat' });
check('logo + type: unchanged (logo + detail)', typed.includes('<img') && strip(typed) === 'Glatt meat');
check('no logo + type: unchanged (short code wording)', strip(badge({ certification: `${A} — Glatt meat`, certificationDetail: 'Glatt meat' })) === 'HKC — Glatt meat');
const other = badge({ logoSrc: src, certification: 'Some other agency' });
check('logo + a label that is not the agency name: stays verbatim text', !other.includes('<img') && strip(other) === 'Some other agency');
check('logo + renamed agency (stored name differs): stays verbatim text', strip(badge({ logoSrc: src, agencyName: 'Renamed' })) === A);

// 2. Restored session from before #97 (no agencyLogoRev) is refreshed from the server's own row.
const stale = { id: 'u9', name: 'Yossi', role: 'admin', agencyId: 'a', agencyName: 'Old name', agencyShortCode: 'HKC' };
check('stale session: feature off before refresh', !isLogoFeatureOn(stale));
const rows = [{ id: 'u1', agencyLogoRev: 'zzz' }, { id: 'u9', name: 'Yossi', role: 'admin', agencyName: A, agencyShortCode: 'HKC', agencySeal: 'Certified Kosher', agencyLogoRev: 'abc123-def456' }];
const fresh = withFreshAgencyFields(stale, rows);
check('refresh copies agencyLogoRev from the user\'s own row', fresh.agencyLogoRev === 'abc123-def456' && isLogoFeatureOn(fresh));
check('refresh copies the other agency fields', fresh.agencyName === A && fresh.agencySeal === 'Certified Kosher');
check('refresh keeps everything else', fresh.id === 'u9' && fresh.role === 'admin' && fresh.agencyId === 'a' && fresh !== stale && !('agencyLogoRev' in stale));
const nullRow = withFreshAgencyFields(stale, [{ id: 'u9', agencyLogoRev: null }]);
check('server null rev (no logo yet) still turns the upload row on', nullRow.agencyLogoRev === null && isLogoFeatureOn(nullRow));
check('unchanged row returns the same object (no re-render / re-save loop)', withFreshAgencyFields(fresh, rows) === fresh);
check('no own row (e.g. kiosk roster) → unchanged', withFreshAgencyFields(stale, [{ id: 'u1', agencyLogoRev: 'x' }]) === stale);
check('kiosk-style row without agency fields → unchanged', withFreshAgencyFields(stale, [{ id: 'u9', name: 'Yossi', role: 'admin' }]) === stale);
check('bad rev type is ignored', !('agencyLogoRev' in withFreshAgencyFields(stale, [{ id: 'u9', agencyLogoRev: 7 }])));
check('null user / bad rows → unchanged', withFreshAgencyFields(null, rows) === null && withFreshAgencyFields(stale, null) === stale);
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const init = app.indexOf("if (msg.type === 'INITIAL_STATE' && msg.payload) {");
const block = app.slice(init, init + 4000).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const call = block.indexOf('setCurrentUser((prev) => withFreshAgencyFields(prev, msg.payload.users))');
const firstRet = block.search(/\breturn\b/);
check('App: INITIAL_STATE refreshes the restored user before any early return', init > 0 && call > 0 && firstRet > call, `call ${call} return ${firstRet}`);
check('App: USERS_UPDATED refreshes too', /USERS_UPDATED[\s\S]{0,200}setCurrentUser\(\(prev\) => withFreshAgencyFields\(prev, msg\.payload\.users\)\)/.test(app));
check('App: the refreshed user is persisted to current_user', /useEffect\(\(\) => \{\s*if \(typeof window !== 'undefined' && currentUser\) \{\s*localStorage\.setItem\('current_user', JSON\.stringify\(currentUser\)\)/.test(app));
check('App: no page reload added (same count as main)', (app.match(/location\.reload\(/g) || []).length === 1);

// 3. Phone admin menu: no "Active Venue" line; Venues Hub and New Venue stay.
const noop = () => {};
const V = { id: 'vA', name: 'Crown Market', agencyId: 'a' };
const admin = { id: 'u9', name: 'Yossi A', email: 'a@t.l', role: 'admin', agencyId: 'a', venueId: 'vA', agencyName: A, agencyShortCode: 'HKC' };
const hp = { allVenues: [V], currentVenue: V, currentUser: admin, onOpenCreateVenue: noop, onSelectVenue: noop, onLogout: noop, onOpenTaskModal: noop, onOpenHistoryModal: noop, onOpenEventsModal: noop, onOpenCreateEvent: noop, onOpenTeamModal: noop, onResetDailyBoard: noop, isRealtimeConnected: true, activeWorkersCount: 1, totalWorkersCount: 3, darkMode: false, onToggleDarkMode: noop, completionRate: 50, onOpenAgencyHome: noop, isAgencyHome: true };
const h = mount(Header, hp); await h.render();
const closed = h.html();
const toggle = h.find((e) => e.props?.id === 'mobile-header-menu-toggle')[0];
check('menu toggle exists', !!toggle);
await toggle.props.onClick(); await h.render();
const open = h.html();
check('menu opened', open.length > closed.length && open.includes('Venues Hub'));
check('"Active Venue" label is gone', !/Active Venue/i.test(open));
check('Venues Hub and New Venue buttons stay', open.includes('Venues Hub (1)') && open.includes('New Venue'));
check('header source has no "Active Venue:" label', !readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8').includes('Active Venue:'));
console.log(`${passed} passed, 0 failed.`);
