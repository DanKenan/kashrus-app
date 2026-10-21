/**
 * 6c client test: any-time tasks (no target time).
 *
 * Pins the shared helper (src/lib/anyTime.ts, also used by server.ts) and the
 * label every list and the kiosk use (formatTaskTimes). Old tasks keep their
 * labels exactly.
 *
 * Run: npx tsx tests/client/test-any-time.mjs
 */
import { ANY_TIME_LABEL, isAnyTimeText, isAnyTimeTask, normalizeAnyTimeTask } from '../../src/lib/anyTime.ts';
import { formatTaskTimes } from '../../src/lib/utils.ts';

let passed = 0;
let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: expected ${e}, got ${a}`);
    failures++;
  } else {
    passed++;
  }
}

// --- constant + text matcher ---
check('label', ANY_TIME_LABEL, 'Any time');
check('text exact', isAnyTimeText('Any time'), true);
check('text case/space', isAnyTimeText('  ANY TIME '), true);
check('text lower', isAnyTimeText('any time'), true);
check('text clock', isAnyTimeText('9:00 AM'), false);
check('text end of day', isAnyTimeText('End of Day'), false);
check('text end of shift', isAnyTimeText('End of Shift'), false);
check('text anytime (one word) is not reserved', isAnyTimeText('Anytime'), false);
check('text empty', isAnyTimeText(''), false);
check('text undefined', isAnyTimeText(undefined), false);
check('text null', isAnyTimeText(null), false);
check('text number', isAnyTimeText(540), false);

// --- task matcher ---
check('task any', isAnyTimeTask({ targetTime: 'Any time' }), true);
check('task timed', isAnyTimeTask({ targetTime: '10:00 AM', targetTimeMinutes: 600 }), false);
check('task no time (old)', isAnyTimeTask({}), false);
check('task null', isAnyTimeTask(null), false);
check('task undefined', isAnyTimeTask(undefined), false);

// --- normaliser ---
const stray = {
  id: 't1',
  title: 'Check fridge',
  targetTime: ' any time ',
  targetTimeMinutes: 540,
  targetTime2: '3:00 PM',
  targetTime2Minutes: 900,
  enableOverdueAlert: true,
  priority: 'high',
};
const n = normalizeAnyTimeTask(stray);
check('norm text canonical', n.targetTime, 'Any time');
check('norm minutes cleared', n.targetTimeMinutes, undefined);
check('norm time2 cleared', n.targetTime2, undefined);
check('norm time2 minutes cleared', n.targetTime2Minutes, undefined);
check('norm alert off', n.enableOverdueAlert, false);
check('norm keeps other fields', [n.id, n.title, n.priority], ['t1', 'Check fridge', 'high']);
check('norm does not mutate input', [stray.targetTime, stray.targetTimeMinutes, stray.enableOverdueAlert], [' any time ', 540, true]);
const timed = { id: 't2', targetTime: '10:00 AM', targetTimeMinutes: 600, targetTime2: '3:00 PM', targetTime2Minutes: 900, enableOverdueAlert: true };
check('norm timed task is the same object', normalizeAnyTimeTask(timed) === timed, true);
check('norm timed task unchanged', normalizeAnyTimeTask(timed), { id: 't2', targetTime: '10:00 AM', targetTimeMinutes: 600, targetTime2: '3:00 PM', targetTime2Minutes: 900, enableOverdueAlert: true });
const old = { id: 't3', title: 'Old task' };
check('norm old task (no time) is the same object', normalizeAnyTimeTask(old) === old, true);
const eod = { id: 't4', targetTime: 'End of Day', enableOverdueAlert: true };
check('norm End of Day is the same object', normalizeAnyTimeTask(eod) === eod, true);

// --- labels (lists and kiosk use formatTaskTimes) ---
check('label any', formatTaskTimes({ targetTime: 'Any time' }), 'Any time');
check('label any ignores stray time2', formatTaskTimes({ targetTime: 'any time', targetTime2: '3:00 PM' }), 'Any time');
check('label timed (unchanged)', formatTaskTimes({ targetTime: '9:00 AM' }), '9:00 AM');
check('label two times (unchanged)', formatTaskTimes({ targetTime: '9:00 AM', targetTime2: '3:00 PM' }), '9:00 AM · 3:00 PM');
check('label empty -> End of Shift (unchanged)', formatTaskTimes({}), 'End of Shift');
check('label End of Day (unchanged)', formatTaskTimes({ targetTime: 'End of Day' }), 'End of Day');
check('label custom text (unchanged)', formatTaskTimes({ targetTime: 'Before lunch' }), 'Before lunch');

console.log(`any-time: ${passed}/${passed + failures} passed`);
process.exit(failures === 0 ? 0 : 1);
