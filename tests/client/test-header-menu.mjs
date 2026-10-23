// Don 2026-10-22 header menu cleanup: general/account things in the menu; the venue's things on the venue screen.
import fs from 'node:fs';
import { venueTabsFor } from '../../src/components/VenueTabs.tsx';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + d : '')); } };
const hdr = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const mobile = hdr.slice(hdr.indexOf('{mobileMenuOpen && ('));
for (const gone of ['Create New Assignment', 'Ingredients audit', 'Kosher Events & Banquets', 'Mashgichim (', 'History Log', 'Reset Daily Board Now', 'onOpenTaskModal()', 'onOpenFactoryAudit()', 'onOpenEventsModal()', 'onOpenTeamModal()', 'onOpenHistoryModal()', 'onResetDailyBoard()'])
  ok(`M phone menu no longer has ${gone}`, !mobile.includes(gone));
for (const kept of ['Switch venue', 'Venues Hub', 'New Venue', 'Agency dashboard', 'Toggle Appearance', '<PushNotificationToggle', '<UpdateAppButton', 'Kiosk tablets', 'Change Password', 'Sign Out'])
  ok(`M phone menu keeps ${kept}`, mobile.includes(kept));
ok('K "Enter kiosk mode" only at >= 768 px (both menus)', (hdr.match(/\{isTabletWidth && \(\s*<button\s+onClick=\{enterKioskMode\}/g) || []).length === 2 && hdr.includes('useMinWidth(768)'));
ok('K "Kiosk tablets" admin only (both menus)', (hdr.match(/\{canManageKiosks && onOpenKioskDevices && \(/g) || []).length === 2 && /const canManageKiosks = currentUser\?\.role === 'admin';/.test(hdr));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok('T admin tabs', eq(venueTabsFor({ role: 'admin' }), ['board', 'events', 'team', 'history']));
ok('T coordinator tabs', eq(venueTabsFor({ role: 'coordinator' }), ['board', 'events', 'team', 'history']));
ok('T mashgiach tabs (no Team)', eq(venueTabsFor({ role: 'mashgiach' }), ['board', 'events', 'history']));
ok('T owner tabs (no Team)', eq(venueTabsFor({ role: 'owner' }), ['board', 'events', 'history']));
ok('T signed out -> none', eq(venueTabsFor(null), []));
{ const a = app.indexOf('<div className="mb-3 max-sm:order-first">'), v = app.indexOf('<VenueTabs'), d = app.indexOf('<AgencyDashboard'), l = app.indexOf('Live Progress Header / Owner Audit Banner'), f = app.indexOf('<TaskFilterBar');
  ok('A tabs at the top of the venue screen (after the agency dashboard branch, before the progress card and filter bar)', d < a && a < v && v < l && l < f && /\{!isKiosk && \(\s*<div className="mb-3 max-sm:order-first">/.test(app), JSON.stringify({ d, a, v, l, f })); }
ok('A Board actions wired: new assignment + reset board', /onNewAssignment=\{handleOpenCreateTask\}/.test(app) && /onResetBoard=\{handleResetDailyBoard\}/.test(app));
const vt = fs.readFileSync(new URL('../../src/components/VenueTabs.tsx', import.meta.url), 'utf8');
ok('A Reset board admin only; New assignment for assigners', vt.includes("const isAdmin = currentUser?.role === 'admin';") && /\{isAdmin && \(\s*<button[\s\S]{0,80}onClick=\{onResetBoard\}/.test(vt) && /\{canAssign && \(\s*<button[\s\S]{0,80}onClick=\{onNewAssignment\}/.test(vt));
ok('A tab row scrolls sideways on a narrow phone, 44px targets', vt.includes('overflow-x-auto') && vt.includes('min-w-max') && vt.includes('min-h-11'));
// Factory Audit hidden everywhere (Don 10:47Z)
const feat = fs.readFileSync(new URL('../../src/lib/features.ts', import.meta.url), 'utf8');
// The public home page (landing-on-app) replaced the old home-screen cards; it never mentions Factory Audit.
const land = fs.readFileSync(new URL('../../src/components/home/home.html', import.meta.url), 'utf8');
ok('F flag is off', /export const SHOW_FACTORY_AUDIT = false;/.test(feat));
ok('F header gets no factory handler while hidden', app.includes('onOpenFactoryAudit={SHOW_FACTORY_AUDIT ? () => setIsFactoryAuditOpen(true) : undefined}'));
ok('F industrial-venue banner hidden', app.includes('{SHOW_FACTORY_AUDIT && !isKiosk && (currentVenue?.category'));
ok('F landing card hidden', !/factory/i.test(land) && !/factory audits in one/.test(land));
ok('F the modal code stays', app.includes('<FactoryAuditHubModal'));
// agency events (Don 10:47Z)
const { sortAgencyEvents, isNewEvent, eventAssigneeText } = await import('../../src/lib/agencyEvents.ts');
const ev = (id, date, extra = {}) => ({ id, date, title: id, status: 'confirmed', mashgiachType: 'unassigned', createdAt: '2026-10-20T00:00:00Z', ...extra });
const sorted = sortAgencyEvents([ev('past1', '2026-10-01'), ev('soon', '2026-10-23'), ev('later', '2026-12-01'), ev('past2', '2026-10-15'), ev('today', '2026-10-22')], '2026-10-22').map((e) => e.id);
ok('E upcoming soonest first, then past newest first', JSON.stringify(sorted) === JSON.stringify(['today', 'soon', 'later', 'past2', 'past1']), JSON.stringify(sorted));
ok('E multi-day event still running counts as upcoming', sortAgencyEvents([ev('run', '2026-10-20', { endDate: '2026-10-24' }), ev('p', '2026-10-21')], '2026-10-22')[0].id === 'run');
ok('E New = created after the last visit; first visit shows none', isNewEvent({ createdAt: '2026-10-22T10:00:00Z' }, '2026-10-22T09:00:00Z') && !isNewEvent({ createdAt: '2026-10-22T08:00:00Z' }, '2026-10-22T09:00:00Z') && !isNewEvent({ createdAt: '2026-10-22T10:00:00Z' }, null));
ok('E assignee text', eventAssigneeText(ev('a', '2026-10-22', { mashgiachType: 'assigned_user', assignedMashgiachName: 'Moshe' })) === 'Moshe' && eventAssigneeText(ev('b', '2026-10-22')) === 'No mashgiach yet');
const dash = fs.readFileSync(new URL('../../src/components/AgencyDashboard.tsx', import.meta.url), 'utf8');
ok('E dashboard has an Events button (not inline list)', dash.includes('data-agency-events-btn') && /onOpenEvents && \(/.test(dash));
ok('E screen loads every agency event, admin only', app.includes("isOpen={isAgencyEventsOpen && currentUser?.role === 'admin'}") && fs.readFileSync(new URL('../../src/components/AgencyEventsScreen.tsx', import.meta.url), 'utf8').includes("apiFetch('/api/events?venueId=all')"));
ok('E New event picks the venue, then the normal form for that venue', app.includes('onCreateForVenue={(venueId) => { setCreateEventVenueId(venueId); setIsCreateEventModalOpen(true); }}') && app.includes('currentVenue={(createEventVenueId && venues.find((v) => v.id === createEventVenueId)) || currentVenue}'));

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
