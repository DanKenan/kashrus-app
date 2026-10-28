/**
 * MANAGERC client test (Don 2026-10-27, "same style as the owner"; server #169):
 * the Manager role in the app. A manager sees and does what an owner does, at
 * their own home venue only; a manager never adds a manager and never touches
 * an owner. An OWNER may add a manager for their own venue and switch a
 * mashgiach at that venue to manager (or back) — nothing else, matching the
 * server's ownerAddsManager / ownerMayChangeRole. Unknown roles stay safe.
 * Run: npx tsx tests/client/test-manager-role.mjs
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';

let failures = 0; let passes = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: expected ${e}, got ${a}`); failures++; }
  else { console.log(`ok ${label}`); passes++; }
}
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const load = async (p) => { try { return await import(p); } catch (e) { console.error(`FAIL import ${p}: ${String(e.message).split('\n')[0]}`); failures++; return {}; } };

const P = await load('../../src/lib/permissions.ts');
const E = await load('../../src/lib/eventPermissions.ts');
const POOL = await load('../../src/lib/pool.ts');
const R = await load('../../src/lib/resetLinks.ts');
const NAV = await load('../../src/components/PhoneNav.tsx');
const OT = await load('../../src/components/OwnerTeamSheet.tsx');
const AF = await load('../../src/components/AddMemberForm.tsx');
const TM = await load('../../src/components/TeamModal.tsx');

const AG = 'ag-demo';
const owner = { id: 'u-own', role: 'owner', agencyId: AG, venueId: 'v1', name: 'Olive Owner', email: 'o@demo.test' };
const manager = { id: 'u-mgr', role: 'manager', agencyId: AG, venueId: 'v1', name: 'Mia Manager', email: 'm@demo.test' };
const mash = { id: 'u-mash', role: 'mashgiach', agencyId: AG, venueId: 'v1', name: 'Moshe Mashgiach', email: 'mm@demo.test' };
const worker = { id: 'u-wrk', role: 'worker', agencyId: AG, venueId: 'v1', name: 'Wes Worker' };
const mashOther = { id: 'u-mash2', role: 'mashgiach', agencyId: AG, venueId: 'v2', name: 'Other Venue' };
const owner2 = { id: 'u-own2', role: 'owner', agencyId: AG, venueId: 'v1', name: 'Second Owner' };
const coord = { id: 'u-co', role: 'coordinator', agencyId: AG, venueId: 'v1', name: 'Coco Coordinator', email: 'co@demo.test' };
const admin = { id: 'u-ad', role: 'admin', agencyId: AG, name: 'Ada Admin', email: 'ad@demo.test' };
const foreign = { id: 'u-f', role: 'mashgiach', agencyId: 'ag-other', venueId: 'v1', name: 'Foreign' };
const poolMash = { id: 'u-pool', role: 'mashgiach', agencyId: AG, noHomeVenue: true, name: 'Pool Person' };
const venues = [{ id: 'v1', agencyId: AG }, { id: 'v2', agencyId: AG }];

// Labels and defaults
check('label manager = Manager', P.getRoleLabel?.('manager'), 'Manager');
check('label owner unchanged', P.getRoleLabel?.('owner'), 'Venue Owner');
check('unknown role renders as plain text (no crash)', P.getRoleLabel?.('janitor'), 'janitor');
check('default manager permissions = owner defaults', P.DEFAULT_ROLE_PERMISSIONS?.manager, { canFillTasks: false, canAssignTasks: false });
check('isVenueOwnerLike manager', P.isVenueOwnerLike?.(manager), true);
check('isVenueOwnerLike owner', P.isVenueOwnerLike?.(owner), true);
check('isVenueOwnerLike mashgiach', P.isVenueOwnerLike?.(mash), false);
check('isVenueOwnerLike unknown', P.isVenueOwnerLike?.({ role: 'janitor' }), false);

// Manager = owner, scoped to the home venue
check('manager fill default false (like owner)', P.canUserFillTasks?.(manager), false);
check('manager fill when granted', P.canUserFillTasks?.({ ...manager, permissions: { canFillTasks: true } }), true);
check('manager assign default false', P.canUserAssignTasks?.(manager), false);
check('manager assign when granted', P.canUserAssignTasks?.({ ...manager, permissions: { canAssignTasks: true } }), true);
check('unknown role cannot fill', P.canUserFillTasks?.({ role: 'janitor', permissions: { canFillTasks: true } }), false);
check('manager may manage events at home', E.mayManageEventAt?.(manager, 'v1', venues), true);
check('manager may NOT manage events at another venue', E.mayManageEventAt?.(manager, 'v2', venues), false);
check('manager may open the Pool (like owner)', POOL.mayOpenPool?.(manager), true);
check('manager Pool on kiosk: no', POOL.mayOpenPool?.(manager, true), false);
check('manager Pool venues = home only', (POOL.ownVenuesForPool?.({ ...manager, venueIds: ['v1', 'v2'] }, venues) || []).map((v) => v.id), ['v1']);
check('manager phone nav = owner (no bottom bar)', NAV.getPhoneNavState?.(manager, true)?.showBar, false);
check('owner phone nav unchanged', NAV.getPhoneNavState?.(owner, true)?.showBar, false);
check('unknown role phone nav: nothing', NAV.getPhoneNavState?.({ role: 'janitor' }, true), { showBar: false, showGold: false });
check('admin reset link for a manager', R.canMakeResetLink?.(admin, manager), true);
check('coordinator (same venue) reset link for a manager', R.canMakeResetLink?.(coord, manager), true);
check('manager makes no reset links', R.canMakeResetLink?.(manager, mash), false);

// Owner adds team members (mashgiach or manager); nobody else through this path
check('owner may add a manager', P.ownerMayAddManager?.(owner), true);
check('manager may NOT add a manager', P.ownerMayAddManager?.(manager), false);
check('coordinator may NOT add a manager (owner path)', P.ownerMayAddManager?.(coord), false);
check('mashgiach may NOT add a manager', P.ownerMayAddManager?.(mash), false);
check('owner without a home venue may NOT', P.ownerMayAddManager?.({ ...owner, venueId: undefined }), false);
check('owner in the Pool may NOT', P.ownerMayAddManager?.({ ...owner, noHomeVenue: true }), false);

// Team adds (Don 2026-10-27 11:30 PM): owners at home, coordinators in their scope; Mashgiach or Manager only
check('staff add roles = Mashgiach, Manager', P.STAFF_ADD_ROLES ? [...P.STAFF_ADD_ROLES] : 'missing', ['mashgiach', 'manager']);
const may = (c, v) => (P.staffMayAddMemberAt ? P.staffMayAddMemberAt(c, v) : 'missing');
check('add: owner at home', may(owner, 'v1'), true);
check('add: owner at another venue', may(owner, 'v2'), false);
check('add: owner without a venue id', may(owner, ''), false);
check('add: owner in the Pool', may({ ...owner, noHomeVenue: true }, 'v1'), false);
check('add: coordinator at home', may(coord, 'v1'), true);
check('add: coordinator at another venue', may(coord, 'v2'), false);
check('add: coordinator with server scope [v1, v2] at v2', may({ ...coord, myVenueIds: ['v1', 'v2'] }, 'v2'), true);
check('add: coordinator with server scope [v1] at v2', may({ ...coord, myVenueIds: ['v1'] }, 'v2'), false);
check('add: Pool coordinator, no scope', may({ ...coord, venueId: undefined, noHomeVenue: true }, 'v1'), false);
check('add: manager never', may(manager, 'v1'), false);
check('add: mashgiach never', may(mash, 'v1'), false);
check('add: admin uses the admin form (not this rule)', may(admin, 'v1'), false);
check('add: unknown role never', may({ id: 'x', role: 'janitor', agencyId: AG, venueId: 'v1' }, 'v1'), false);

// Owner role switch: mashgiach <-> manager at the owner's own venue only
const sw = (c, t) => (P.ownerRoleSwitchFor ? P.ownerRoleSwitchFor(c, t) : 'missing');
check('owner: mashgiach -> manager', sw(owner, mash), 'manager');
check('owner: worker -> manager', sw(owner, worker), 'manager');
check('owner: manager -> mashgiach', sw(owner, manager), 'mashgiach');
check('owner: mashgiach at another venue: none', sw(owner, mashOther), null);
check('owner: another owner: none', sw(owner, owner2), null);
check('owner: admin: none', sw(owner, admin), null);
check('owner: coordinator: none', sw(owner, coord), null);
check('owner: self: none', sw(owner, owner), null);
check('owner: other agency: none', sw(owner, foreign), null);
check('owner: Pool person: none', sw(owner, poolMash), null);
check('owner: unknown role: none', sw(owner, { id: 'x', role: 'janitor', agencyId: AG, venueId: 'v1' }), null);
check('manager: may switch nobody (mashgiach)', sw(manager, mash), null);
check('manager: may not touch an owner', sw(manager, owner), null);
check('coordinator: no owner-path switch', sw(coord, mash), null);
check('admin: no owner-path switch (uses Team)', sw(admin, mash), null);

// The owner's Team sheet lists exactly the people it may act on
const roster = [owner, manager, mash, worker, mashOther, owner2, coord, admin, foreign, poolMash];
const rows = (OT.ownerTeamRows?.(owner, roster) || []).map((r) => [r.user.id, r.switchTo]);
check('owner team rows = mashgichim/managers at home, sorted', rows, [['u-mgr', 'mashgiach'], ['u-mash', 'manager'], ['u-wrk', 'manager']]);
check('manager sees no owner team rows', OT.ownerTeamRows ? OT.ownerTeamRows(manager, roster) : 'missing', []);

// A dropdown pick becomes a request only for the one switch the server allows (fail closed)
const pick = OT.ownerRolePick || (() => 'missing');
check('pick: mashgiach -> Manager', pick('manager', mash, 'manager'), 'manager');
check('pick: worker -> Manager', pick('manager', worker, 'manager'), 'manager');
check('pick: manager -> Mashgiach', pick('mashgiach', manager, 'mashgiach'), 'mashgiach');
check('pick: same role is no change', pick('manager', mash, 'mashgiach'), null);
check('pick: worker -> Mashgiach is no change', pick('manager', worker, 'mashgiach'), null);
check('pick: owner never', pick('manager', mash, 'owner'), null);
check('pick: admin never', pick('manager', mash, 'admin'), null);
check('pick: coordinator never', pick('mashgiach', manager, 'coordinator'), null);
check('owner role options', OT.OWNER_ROLE_OPTIONS ? [...OT.OWNER_ROLE_OPTIONS] : 'missing', ['mashgiach', 'manager']);

const h = React.createElement;
const noop = async () => {};
if (OT.OwnerTeamSheet) {
  const html = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: owner, roster, venueName: 'Demo Bistro', onAddMember: noop, onSetRole: noop }));
  // Don 11:01 PM Oct 27: no special "Add manager" button — the same "Add team member" as the admin, Manager is one more role.
  check('owner sheet: Add team member button', html.includes('data-owner-add-member') && html.includes('Add team member'), true);
  check('owner sheet: no "Add manager" button', /Add manager|data-owner-add-manager/.test(html), false);
  // Don 10:15 PM Oct 27: the role is a dropdown option (like the admin Team screen), not a "Make manager" button per person.
  check('owner sheet: no per-person Make manager / Make mashgiach buttons', /Make manager|Make mashgiach|data-owner-switch=/.test(html), false);
  const selects = [...html.matchAll(/<select[^>]*data-owner-role-select="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)];
  check('owner sheet: one role dropdown per listed person', selects.map((m) => m[1]), ['u-mgr', 'u-mash', 'u-wrk']);
  const optsOf = (inner) => [...inner.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map((o) => `${o[1]}:${o[2]}`);
  check('owner dropdowns offer only Mashgiach and Manager', selects.map((m) => optsOf(m[2]).join(',')), Array(3).fill('mashgiach:Mashgiach,manager:Manager'));
  check('owner dropdowns never offer owner/admin/coordinator', /<option value="(owner|admin|coordinator)"/.test(html), false);
  const selected = (inner) => (inner.match(/<option value="([^"]+)" selected/) || [])[1];
  check('owner dropdown shows the saved role (worker shows as Mashgiach)', selects.map((m) => selected(m[2])), ['manager', 'mashgiach', 'mashgiach']);
  check('owner dropdown: same look as the admin role picker', /<select[^>]*data-owner-role-select="u-mash"[^>]*class="[^"]*uppercase tracking-wider[^"]*border-line-control/.test(html) || /<select[^>]*class="[^"]*uppercase tracking-wider[^"]*border-line-control[^"]*"[^>]*data-owner-role-select/.test(html), true);
  check('owner sheet: no owner/admin/coordinator/other-venue rows', ['u-own2', 'u-ad', 'u-co', 'u-mash2', 'u-f', 'u-pool', 'u-own"'].some((id) => html.includes(`data-owner-team-row="${id}`)), false);
  check('owner sheet: venue named', html.includes('Demo Bistro'), true);
  const mhtml = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: manager, roster, onAddMember: noop, onSetRole: noop }));
  check('manager: owner Team sheet renders nothing', mhtml, '');
  const chtml = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: coord, roster, onAddMember: noop, onSetRole: noop }));
  check('coordinator: owner Team sheet renders nothing', chtml, '');
} else { console.error('FAIL OwnerTeamSheet missing'); failures++; }

// The ONE add form (admin, coordinator, owner): same card, labels, ids; roles differ
const optsIn = (html, sel) => {
  const m = html.match(new RegExp(`<select[^>]*${sel}[^>]*>([\\s\\S]*?)</select>`));
  return m ? [...m[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map((o) => `${o[1]}:${o[2]}`) : 'no select';
};
if (AF.AddMemberForm) {
  const staff = renderToStaticMarkup(h(AF.AddMemberForm, { roles: P.STAFF_ADD_ROLES, showPermissions: false, venueId: 'v1', venueNote: AF.STAFF_ADD_NOTE?.('Demo Bistro'), existingEmails: [], onAddUser: noop, onCancel: () => {}, idPrefix: 'owner-' }));
  check('staff form: Mashgiach (default) and Manager only', optsIn(staff, 'data-add-member-role'), ['mashgiach:Mashgiach (Field Inspector)', 'manager:Manager (Runs this venue)']);
  check('staff form: Mashgiach selected first', /<option value="mashgiach" selected/.test(staff), true);
  check('staff form: never owner/admin/coordinator/worker', /<option value="(owner|admin|coordinator|worker)"/.test(staff), false);
  check('staff form: no rights checkboxes (role defaults)', /type="checkbox"/.test(staff), false);
  check('staff form: same card title as the admin', staff.includes('Add New Team Member') && staff.includes('Create invite link') && staff.includes('Full Name') && staff.includes('Phone (optional)'), true);
  check('staff form: says where they join and that admins are notified', staff.includes('They join Demo Bistro. Your agency admins are notified, and it shows in Announcements.'), true);
  check('staff form: Cancel when given', staff.includes('data-add-member-cancel'), true);
  check('staff form: ids prefixed (no clash with the admin form)', staff.includes('id="owner-new-member-name-input"') && !staff.includes('id="new-member-name-input"'), true);
  const adminForm = renderToStaticMarkup(h(AF.AddMemberForm, { roles: AF.ADMIN_ADD_ROLES, showPermissions: true, venueId: 'v1', existingEmails: [], onAddUser: noop }));
  check('admin form: unchanged roles and labels', optsIn(adminForm, 'data-add-member-role'), ['mashgiach:Mashgiach (Field Inspector)', 'coordinator:Coordinator (Can Add Tasks)', 'manager:Manager (Runs this venue)']);
  check('admin form: rights checkboxes kept', (adminForm.match(/type="checkbox"/g) || []).length, 2);
  check('admin form: unchanged ids', adminForm.includes('id="new-member-name-input"') && adminForm.includes('id="add-member-submit-btn"') && adminForm.includes('id="new-member-role-select"'), true);
  check('admin form: no Cancel', adminForm.includes('data-add-member-cancel'), false);
} else { console.error('FAIL AddMemberForm missing'); failures++; }
if (TM.TeamModal) {
  const tmProps = (cu, venue, users) => ({ isOpen: true, onClose: () => {}, users, tasks: [], currentUser: cu, currentVenue: venue, venues: [{ id: 'v1', name: 'Demo Bistro', agencyId: AG }, { id: 'v2', name: 'Demo Deli', agencyId: AG }], onAddUser: noop, onUpdateUser: noop, onDeleteUser: noop });
  const tmRender = (cu, venue) => { try { return renderToStaticMarkup(h(TM.TeamModal, tmProps(cu, venue, [cu, mash]))); } catch (e) { return `RENDER ERROR ${e.message}`; } };
  const cHome = tmRender(coord, { id: 'v1', name: 'Demo Bistro', agencyId: AG });
  check('Team renders', cHome.startsWith('RENDER ERROR') ? cHome.slice(0, 200) : 'ok', 'ok');
  check('coordinator Team: add form at their own venue', cHome.includes('data-add-member-form'), true);
  check('coordinator Team: Mashgiach and Manager only', optsIn(cHome, 'data-add-member-role'), ['mashgiach:Mashgiach (Field Inspector)', 'manager:Manager (Runs this venue)']);
  check('coordinator Team: no rights checkboxes in the add form', /data-add-member-form[\s\S]*type="checkbox"[\s\S]*<\/form>/.test(cHome), false);
  check('coordinator Team: names the venue', cHome.includes('They join Demo Bistro.'), true);
  const cOther = tmRender(coord, { id: 'v2', name: 'Demo Deli', agencyId: AG });
  check('coordinator Team: no add form at a venue outside their scope', cOther.includes('data-add-member-form'), false);
  const aHtml = tmRender(admin, { id: 'v1', name: 'Demo Bistro', agencyId: AG });
  check('admin Team: add form with Mashgiach, Coordinator, Manager', optsIn(aHtml, 'data-add-member-role'), ['mashgiach:Mashgiach (Field Inspector)', 'coordinator:Coordinator (Can Add Tasks)', 'manager:Manager (Runs this venue)']);
  check('admin Team: no staff note', aHtml.includes('data-add-member-venue-note'), false);
  // RV1 P2: the add form stays mounted (hidden) while the Pool tab shows, so a shown link / an add in flight survives.
  try {
    const tmm = mount(TM.TeamModal, tmProps(admin, { id: 'v1', name: 'Demo Bistro', agencyId: AG }, [admin, mash]));
    await tmm.render();
    const walkEls = function* (n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walkEls(c); return; } if (!React.isValidElement(n)) return; yield n; yield* walkEls(n.props?.children); };
    const formEl = () => [...walkEls(tmm.tree())].find((e) => e.type === AF.AddMemberForm);
    const slot = () => [...walkEls(tmm.tree())].find((e) => e.props && e.props['data-add-member-slot'] !== undefined);
    check('Team tab: add form shown', !!formEl() && slot()?.props.hidden === false, true);
    await tmm.click((e) => e.props['data-team-tab'] === 'pool');
    check('Pool tab: the add form stays mounted, hidden', !!formEl() && slot()?.props.hidden === true && /\bhidden\b/.test(slot()?.props.className || ''), true);
    await tmm.click((e) => e.props['data-team-tab'] === 'team');
    check('back on Team: the same form, shown', !!formEl() && slot()?.props.hidden === false, true);
  } catch (e) { console.error(`FAIL pool-tab keeps the form: ${String(e.message).split('\n')[0]}`); failures++; }
} else { console.error('FAIL TeamModal missing'); failures++; }

// Where roles are chosen or shown
const types = src('src/types.ts');
check('UserRole has manager', /export type UserRole = [^;]*'manager'/.test(types), true);
const team = src('src/components/TeamModal.tsx');
const addForm = src('src/components/AddMemberForm.tsx');
check('admin add form offers Manager', /manager: 'Manager \(Runs this venue\)'/.test(addForm) && /ADMIN_ADD_ROLES[^=]*= \['mashgiach', 'coordinator', 'manager'\]/.test(addForm), true);
check('add form only ever sends a role it offers (fail closed)', addForm.includes('role: pickRole(role),') && addForm.includes("(roles as readonly string[]).includes(r)"), true);
check('add form sends rights only for the admin', addForm.includes('...(showPermissions ? { permissions:'), true);
check('admin and coordinator Team use the shared form', team.includes('<AddMemberForm roles={ADMIN_ADD_ROLES} showPermissions') && team.includes('<AddMemberForm roles={STAFF_ADD_ROLES} showPermissions={false}'), true);
check('admin row picker offers Manager', team.includes('<option value="manager">Manager</option>'), true);
check('row picker only for known roles (unknown: badge)', team.includes('TEAM_ROLE_CHOICES.includes(user.role)'), true);
check('Announcements: Managers', /manager:\s*'Managers'/.test(src('src/components/Announcements.tsx')), true);
check('Receipts: Manager', /manager:\s*'Manager'/.test(src('src/components/Receipts.tsx')), true);
const app = src('src/App.tsx');
check('App: owner Team only for owners, never kiosk', app.includes('onOpenOwnerTeam={ownerMayAddManager(currentUser) && !isKiosk ?'), true);
check('App: role switch sends exactly { role }', app.includes('onSetRole={(userId, role) => handleUpdateUser(userId, { role })}'), true);
check('App: manager gets the owner banner', app.includes('{isKiosk ? null : isVenueOwnerLike(currentUser) ? ('), true);
check('App: manager gets the Pool like an owner', app.includes('onOpenPool={isVenueOwnerLike(currentUser) && !isKiosk ?'), true);
const header = src('src/components/Header.tsx');
check('Header: owner Team row (desk + phone menus)', header.includes('data-open-owner-team') && header.includes('data-open-owner-team-mobile'), true);
const ots = src('src/components/OwnerTeamSheet.tsx');
check('owner sheet: a late answer after close is dropped (generation guard, RV1 P3)', /generation\.current \+= 1/.test(ots) && (ots.match(/gen !== generation\.current|gen === generation\.current/g) || []).length >= 3, true);
check('add form: a late answer after it is gone is dropped', /if \(!alive\.current\) return;/.test(addForm) && /alive\.current = false/.test(addForm), true);
check('App: owner add sends the shared add', app.includes('onAddMember={handleAddUser}'), true);
check('owner sheet: a failed save puts the dropdown back and shows the error', /catch \(err: any\) \{[\s\S]{0,160}setAsking\(null\); setError\(/.test(ots), true);
check('owner sheet: a pick the refreshed roster no longer allows shows no confirm and is cleared (RV P3)', ots.includes('const open = asking?.id === user.id && asking.to === switchTo;') && /useEffect\(\(\) => \{ if \(!pendingStillAllowed\) setAsking\(null\); \}/.test(ots), true);
check('Create event: manager venue fixed like owner', src('src/components/CreateEventModal.tsx').includes("currentUser?.role === 'owner' || currentUser?.role === 'manager'"), true);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
