import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T18:00:00Z'])); }
  static now() { return new RealDate('2026-11-03T18:00:00Z').getTime(); }
};
try {
  const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /task-when-segment > button\[aria-pressed='true'\].*background: var\(--surface\)/);
  assert.match(css, /task-when-radio\[aria-pressed='true'\].*background: var\(--gold-wash\)/);
  assert.match(css, /task-when-repeat-pills button\[aria-pressed='true'\].*background: var\(--ink\)/);
  const calls = recordFetch({});
  const shifts = venueShifts([], 'v');
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave() {}, venueId: 'v', venueName: 'Kitchen', knownWorkers: [], shifts, timeZone: 'UTC' });
  await view.render(); await view.type('task-title-input', 'Check sink'); await view.submit();
  assert.match(view.html(), /Pick a shift, or a set time/);
  await view.click('A shift');
  assert.match(view.html(), /Which shift\?/);
  assert.match(view.html(), /task-when-shift is-picked/);
  assert.match(view.html(), /When during the shift\?/);
  assert.match(view.html(), /Done any time/);
  await view.click('By a set time');
  assert.match(view.html(), /Target time pin/);
  await view.click('A time');
  assert.match(view.html(), /At what time\?/);
  const hour = () => Number(view.html().match(/<option value="(\d+)" selected="">/)[1]);
  const before = hour();
  await view.click('Later time'); await view.click('Later time');
  assert.equal(hour(), before % 12 + 1);
  await view.click('Earlier time'); await view.click('Earlier time');
  assert.equal(hour(), before);
  assert.match(view.html(), /auto/);
  assert.equal(calls.length, 0);
  const bar = mount(ShiftHoursBar, { shift: shifts[0], pinMinutes: 600, readOnly: true, onSaved() { throw new Error('read-only bar saved'); } });
  await bar.render();
  assert.match(bar.html(), /is-readonly/);
  assert.match(bar.html(), /Target time pin/);
  assert.ok(bar.find((e) => e.type === 'label').every((e) => e.props.hidden));
  assert.equal(calls.length, 0);
  const overnight = mount(ShiftHoursBar, { shift: shifts.find((s) => s.name === 'Night'), onSaved() {} });
  await overnight.render();
  assert.equal(overnight.find((e) => e.props['aria-label'] === 'Shift end')[0].props.value, 1800, '6 AM end is the right edge of the displayed day');
  const crossing = mount(ShiftHoursBar, { shift: { ...shifts[0], startMinutes: 120, endMinutes: 600 }, onSaved() {} });
  await crossing.render();
  assert.equal(crossing.find((e) => e.props['data-shift-band']).length, 2, 'a shift crossing the 6 AM display boundary fills both ends');
  assert.equal(calls.length, 0);
  console.log('task form look: When controls, time adjustment, pin and read-only bar passed');
} finally { globalThis.Date = RealDate; }
