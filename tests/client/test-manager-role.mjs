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

const AG = 'ag-demo';
const owner = { id: 'u-own', role: 'owner', agencyId: AG, venueId: 'v1', name: 'Olive Owner', email: 'o@demo.test' };
const manager = { id: 'u-mgr', role: 'manager', agencyId: AG, venueId: 'v1', name: 'Mia Manager', email: 'm@demo.test' };
const mash = { id: 'u-mash', role: 'mashgiach', agencyId: AG, venueId: 'v1', name: 'Moshe Mashgiach' };
const worker = { id: 'u-wrk', role: 'worker', agencyId: AG, venueId: 'v1', name: 'Wes Worker' };
const mashOther = { id: 'u-mash2', role: 'mashgiach', agencyId: AG, venueId: 'v2', name: 'Other Venue' };
const owner2 = { id: 'u-own2', role: 'owner', agencyId: AG, venueId: 'v1', name: 'Second Owner' };
const coord = { id: 'u-co', role: 'coordinator', agencyId: AG, venueId: 'v1', name: 'Coco Coordinator' };
const admin = { id: 'u-ad', role: 'admin', agencyId: AG, name: 'Ada Admin' };
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

// Owner adds managers; nobody else through this path
check('owner may add a manager', P.ownerMayAddManager?.(owner), true);
check('manager may NOT add a manager', P.ownerMayAddManager?.(manager), false);
check('coordinator may NOT add a manager (owner path)', P.ownerMayAddManager?.(coord), false);
check('mashgiach may NOT add a manager', P.ownerMayAddManager?.(mash), false);
check('owner without a home venue may NOT', P.ownerMayAddManager?.({ ...owner, venueId: undefined }), false);
check('owner in the Pool may NOT', P.ownerMayAddManager?.({ ...owner, noHomeVenue: true }), false);

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

const h = React.createElement;
const noop = async () => {};
if (OT.OwnerTeamSheet) {
  const html = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: owner, roster, venueName: 'Demo Bistro', onAddManager: noop, onSetRole: noop }));
  check('owner sheet: Add manager button', html.includes('data-owner-add-manager') && html.includes('Add manager'), true);
  check('owner sheet: Make manager on the mashgiach', /data-owner-team-row="u-mash"[\s\S]*?Make manager/.test(html), true);
  check('owner sheet: Make mashgiach on the manager', /data-owner-team-row="u-mgr"[\s\S]*?Make mashgiach/.test(html), true);
  check('owner sheet: Manager label shown', html.includes('>Manager<'), true);
  check('owner sheet: no owner/admin/coordinator/other-venue rows', ['u-own2', 'u-ad', 'u-co', 'u-mash2', 'u-f', 'u-pool', 'u-own"'].some((id) => html.includes(`data-owner-team-row="${id}`)), false);
  check('owner sheet: venue named', html.includes('Demo Bistro'), true);
  const mhtml = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: manager, roster, onAddManager: noop, onSetRole: noop }));
  check('manager: owner Team sheet renders nothing', mhtml, '');
  const chtml = renderToStaticMarkup(h(OT.OwnerTeamSheet, { isOpen: true, onClose: () => {}, currentUser: coord, roster, onAddManager: noop, onSetRole: noop }));
  check('coordinator: owner Team sheet renders nothing', chtml, '');
} else { console.error('FAIL OwnerTeamSheet missing'); failures++; }

// Where roles are chosen or shown
const types = src('src/types.ts');
check('UserRole has manager', /export type UserRole = [^;]*'manager'/.test(types), true);
const team = src('src/components/TeamModal.tsx');
check('admin add form offers Manager', /<option value="manager">Manager \(/.test(team), true);
check('admin add form sends manager', team.includes("role: role === 'coordinator' || role === 'manager' ? role : 'mashgiach'"), true);
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
check('Create event: manager venue fixed like owner', src('src/components/CreateEventModal.tsx').includes("currentUser?.role === 'owner' || currentUser?.role === 'manager'"), true);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
