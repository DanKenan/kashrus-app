/**
 * QA2 batch C1 client test (Codex lane).
 *  D*  #18/#19 calendar dates read "Thu, Nov 5" (UTC, never shifts; year only when not this year; anything else unchanged).
 *  H*  #19 history: "Reset by hand by …", automatic resets, "Not done" for a task nobody did.
 *  S*  source checks: #11 #12 #13 #16 #20 #21 #23 #24 #28 #31 #33 wording/defaults, and the kiosk status line wraps (200 % text).
 * Run: npx tsx tests/client/test-qa2-batch-c1.mjs
 */
import fs from 'node:fs';
import { formatWorkDate } from '../../src/lib/dateText.ts';
import { resetByText } from '../../src/components/HistoryLogModal.tsx';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, a === b, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const src = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// D — dates
const now = new Date(2026, 9, 22, 12, 0, 0);
eq('D this year, no year', formatWorkDate('2026-11-05', now), 'Thu, Nov 5');
eq('D other year has year', formatWorkDate('2025-12-31', now), 'Wed, Dec 31, 2025');
eq('D first of year stays the same day', formatWorkDate('2026-01-01', now), 'Thu, Jan 1');
eq('D leap day', formatWorkDate('2028-02-29', now), 'Tue, Feb 29, 2028');
eq('D invalid day kept', formatWorkDate('2026-02-30', now), '2026-02-30');
eq('D non-ISO kept', formatWorkDate('Nov 5', now), 'Nov 5');
eq('D empty', formatWorkDate('', now), '');
eq('D non-string', formatWorkDate(undefined, now), '');
{ // the day never shifts with the device zone (formatted in UTC)
  const prev = process.env.TZ; process.env.TZ = 'Pacific/Honolulu';
  eq('D Honolulu same day', formatWorkDate('2026-11-05', now), 'Thu, Nov 5');
  process.env.TZ = 'Asia/Jerusalem';
  eq('D Jerusalem same day', formatWorkDate('2026-11-05', now), 'Thu, Nov 5');
  if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
}

// H — history wording
eq('H midnight', resetByText('scheduled_midnight_cron'), 'Reset by Automatic (midnight)');
eq('H system', resetByText('system'), 'Reset by Automatic');
eq('H default manual', resetByText('Admin Manual'), 'Reset by hand');
eq('H empty', resetByText(''), 'Reset by hand');
eq('H non-string', resetByText(null), 'Reset by hand');
eq('H named', resetByText(' Rivka Admin '), 'Reset by hand by Rivka Admin');
const hist = src('src/components/HistoryLogModal.tsx');
ok('H not-done wording', /entry\.isCompleted \? 'Unassigned' : 'Not done'/.test(hist));
ok('H no raw date in the day list', !/>\{snap\.date\}</.test(hist) && /formatWorkDate\(snap\.date\)/.test(hist));

// S — sources
const events = src('src/components/EventsModal.tsx');
ok('S #31 create label', events.includes('Create event') && !events.includes('Notify New Event'));
ok('S #18 event dates formatted', /formatWorkDate\(evt\.date\)/.test(events) && /formatWorkDate\(activeEvent\.date\)/.test(events));
const hub = src('src/components/FactoryAuditHubModal.tsx');
ok('S #11 no "Assigned Mashgiach" with the viewer\'s name', !hub.includes('Assigned Mashgiach'));
const all = ['src/components/FactoryAuditHubModal.tsx', 'src/components/Header.tsx'].map(src).join('\n');
ok('S #13 no vendor name / false Live badge', !/\(Airtable\)/.test(all) && !/>\s*Live\s*</.test(all));
const report = src('src/components/SubmitAuditReportModal.tsx');
ok('S #12 inspector not prefilled', !report.includes("'QA Plant Manager'"));
ok('S #12 certify not pre-ticked', /useState\(false\)/.test(report) && !/setMashgiachSigned\] = useState\(true\)/.test(report));
const forgot = src('src/components/ForgotPasswordModal.tsx');
ok('S #16 Back is a soft rounded button', /rounded-xl[^"]*"[\s\S]{0,40}← Back/.test(forgot) || /min-h-11 rounded-xl[\s\S]{0,200}← Back/.test(forgot));
const cpw = src('src/components/ChangePasswordModal.tsx');
ok('S #20 no "Update credentials"', !cpw.includes('Update credentials') && cpw.includes('Choose a new password'));
ok('S #14 change password asks for 8 characters (same as the server and reset)', /newPassword\.length < 8/.test(cpw) && cpw.includes('min 8 characters') && !cpw.includes('min 6 characters'));
ok('S #24 Show passwords rounded', /rounded-lg[^"]*"[\s\S]{0,200}Show passwords/.test(cpw));
const kcode = src('src/components/KioskCodeDialog.tsx');
ok('S #24 Remove code rounded', /rounded-lg[^"]*"[\s\S]{0,120}Remove code/.test(kcode));
const venue = src('src/components/CreateVenueModal.tsx');
ok('S #21 steps 1 and 2', venue.includes('1. Venue details') && venue.includes('2. Venue owner account') && !/\b3\. /.test(venue));
ok('S #21 default Restaurant', venue.includes("useState('Restaurant')"));
ok('S #21 no platform jargon', !/[Pp]latform|provisioned|Airtable/.test(venue));
const dir = src('src/components/VenuesDirectoryModal.tsx');
ok('S #21 hub wording', !/Switch to Platform|Active Platform|Venue Platform/.test(dir));
const team = src('src/components/TeamModal.tsx');
ok('S #23 role change waits for a confirm', /setRoleChange\(\{ user, newRole \}\)/.test(team) && /confirmText="Change role"/.test(team));
ok('S #23 new role starts from its own permissions', /canAssignTasks: defaults\.canAssignTasks/.test(team) && /canFillTasks: defaults\.canFillTasks/.test(team));
const app = src('src/App.tsx');
ok('S #28 kiosk code toast', app.includes('Kiosk code saved for') && !app.includes('Updated permissions for'));
ok('S #21 venue toast', !/successfully provisioned/.test(app));
const landing = src('src/components/LandingPage.tsx');
ok('S #33 neutral footer', !landing.includes('Hartford Kashrut Commission (HKC) •'));
const kiosk = src('src/components/KioskTaskPanel.tsx');
ok('S kiosk status line wraps (no truncate) and clamps at two lines while closed',
  /className=\{`min-w-0 max-w-full text-base text-ink-soft break-words \$\{isOpen \? '' : 'line-clamp-2'\}`\}/.test(kiosk));

console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
