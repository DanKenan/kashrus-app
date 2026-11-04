import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';
const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
assert.match(css, /\.shift-hours-well \{ height: auto; min-height: 72px; padding-top: 28px; \}/);
assert.match(css, /\.task-change-shift > \.shift-hours-visual \{ margin-top: 8px; \}/);
const calls = recordFetch({});
for (const readOnly of [false, true]) {
  const view = mount(ShiftHoursBar, { shift: venueShifts([], 'v').find((shift) => shift.name === 'Afternoon'), pinMinutes: 1110, readOnly, onSaved() {} });
  await view.render();
  const well = view.find((e) => e.props.className === 'shift-hours-well space-y-2')[0];
  assert.ok(well);
  assert.ok(well.props.children[1].props['data-shift-track']);
  assert.match(well.props.children[2].props.className, /h-4/);
  assert.equal(well.props.children[2].props.children.length, 7);
  assert.match(view.html(), /Target time pin/);
}
assert.equal(calls.length, 0);
console.log('task form review: editable and read-only bars reserve the track and all ticks without requests');
