/**
 * 10M part 1 source checks (design files/shutfey-10M-design.txt P1.6, P1.12):
 * both agency-creating routes build their records through ONE builder, the new
 * route is public (password is the proof), and the creator field stays
 * server-only (never in a client view, stripped from client bodies).
 */
import fs from 'node:fs';
import { AGENCY_PUBLIC_FIELDS, AGENCY_ADMIN_EXTRA_FIELDS, SERVER_ONLY_AGENCY_FIELDS, agencyAdminView, stripServerOnlyAgencyFields } from '../../src/server/agency-fields.ts';
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ FAILED: ${name}`); } };
const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const handler = (sig) => { const at = src.indexOf(sig); return at < 0 ? '' : src.slice(at, src.indexOf('\napp.', at + 10)); };
const reg = handler("app.post('/api/agencies/register', async");
const rex = handler("app.post('/api/agencies/register-existing', async");
check('register handler found', reg.length > 0);
check('register-existing handler found', rex.length > 0);
check('register builds through buildNewAgencyRecords exactly once', (reg.match(/buildNewAgencyRecords\(/g) || []).length === 1);
check('register-existing builds through buildNewAgencyRecords exactly once', (rex.match(/buildNewAgencyRecords\(/g) || []).length === 1);
check('no other caller of buildNewAgencyRecords', (src.match(/buildNewAgencyRecords\(/g) || []).length === 3); // definition + 2 calls
check('register no longer builds a starter venue inline', !/const starterVenue: Venue = \{/.test(reg));
check('register-existing is a public route', /\{ method: 'POST', path: '\/agencies\/register-existing' \}/.test(src));
check('register-existing verifies the password before its commit', rex.indexOf('checkPassword(') > 0 && rex.indexOf('checkPassword(') < rex.indexOf('commitOrRespond('));
check('register-existing joins the person only through newMembership', /newMembership: \{ \[newRowId\]: pid \}/.test(rex));
check('register-existing never sets a password on the new row', !/password:\s*(newHash|await|bcrypt)/.test(rex));
check('createdByPersonId is server-only', SERVER_ONLY_AGENCY_FIELDS.includes('createdByPersonId'));
check('createdByPersonId is in no client view list', !AGENCY_PUBLIC_FIELDS.includes('createdByPersonId') && !AGENCY_ADMIN_EXTRA_FIELDS.includes('createdByPersonId'));
check('agencyAdminView drops createdByPersonId', !('createdByPersonId' in agencyAdminView({ id: 'a', name: 'n', createdByPersonId: 'p' })));
check('a client body cannot set createdByPersonId', !('createdByPersonId' in stripServerOnlyAgencyFields({ name: 'n', createdByPersonId: 'p' })));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log(`ALL ${pass} passed`);
