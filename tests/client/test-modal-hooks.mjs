/**
 * D7-fix client test: modals keep the same hooks whether open or closed.
 *
 * React requires every render of a component to call the same hooks in the
 * same order. A hook placed after `if (!isOpen) return null` changes the count
 * the moment the modal opens, and React throws error #310 — the whole app goes
 * white. SubmitAuditReportModal did exactly that ("Submit Inspection Report").
 *
 * H*: for each modal, call the component once closed and once open under a
 *     counting dispatcher and compare the hook sequence (must be identical).
 * S*: the report modal still opens on the right default outcome:
 *     discrepancies -> "critical violation", everything verified -> "passed",
 *     otherwise "passed with notes".
 *
 * Run: npx tsx tests/client/test-modal-hooks.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubmitAuditReportModal } from '../../src/components/SubmitAuditReportModal.tsx';
import { AddDiscrepancyModal } from '../../src/components/AddDiscrepancyModal.tsx';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') {
  if (cond) passed++;
  else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); }
}

// ---- counting dispatcher (React 19 internals: the current dispatcher is `.H`)
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
function hookTrace(Component, props) {
  const trace = [];
  const rec = (name, ret) => (...args) => { trace.push(name); return typeof ret === 'function' ? ret(...args) : ret; };
  const dispatcher = {
    useState: rec('useState', (init) => [typeof init === 'function' ? init() : init, () => {}]),
    useReducer: rec('useReducer', (r, init) => [init, () => {}]),
    useRef: rec('useRef', (v) => ({ current: v })),
    useEffect: rec('useEffect'), useLayoutEffect: rec('useLayoutEffect'), useInsertionEffect: rec('useInsertionEffect'),
    useMemo: rec('useMemo', (f) => f()), useCallback: rec('useCallback', (f) => f),
    useContext: rec('useContext', (c) => c?._currentValue), useId: rec('useId', () => 'id'),
    useTransition: rec('useTransition', () => [false, (f) => f()]), useDeferredValue: rec('useDeferredValue', (v) => v),
    useSyncExternalStore: rec('useSyncExternalStore', (s, g) => g()), useImperativeHandle: rec('useImperativeHandle'),
    useDebugValue: rec('useDebugValue'), use: rec('use', (v) => v), useOptimistic: rec('useOptimistic', (v) => [v, () => {}]),
    useActionState: rec('useActionState', (f, s) => [s, () => {}, false]),
  };
  const prev = internals.H; internals.H = dispatcher;
  try { Component(props); } finally { internals.H = prev; }
  return trace;
}

const noop = () => {};
const venue = { id: 'v1', name: 'Northeast Ingredients Plant', category: 'Industrial Plant', createdAt: '' };
const user = { id: 'u1', name: 'Yossi Abramowitz-Goldberger', email: 'y@test.local', role: 'mashgiach' };
const ing = (id, v) => ({ id, venueId: 'v1', agencyId: 'a', name: 'Item ' + id, kosherStatus: 'Parve', approvalStatus: 'approved', verificationStatus: v });
const disc = { id: 'd1', name: 'Unmarked drum of glycerin', severity: 'critical', notes: 'Quarantined', reportedAt: new Date().toISOString(), reportedByName: 'Y', reportedByEmail: 'y@test.local' };

const modals = [
  ['SubmitAuditReportModal', SubmitAuditReportModal, { onClose: noop, venue, currentUser: user, ingredients: [ing('1', 'verified_present'), ing('2', 'unverified')], discrepancies: [disc], onSubmitSuccess: noop }],
  ['AddDiscrepancyModal', AddDiscrepancyModal, { onClose: noop, onAdd: noop, onSubmit: noop }],
];
for (const [name, C, props] of modals) {
  let closed, open, err = '';
  try { closed = hookTrace(C, { ...props, isOpen: false }); open = hookTrace(C, { ...props, isOpen: true }); } catch (e) { err = String(e).slice(0, 200); }
  ok(`H ${name}: same hooks closed and open`, !err && closed.join(',') === open.join(','), err || `closed=[${closed}] open=[${open}]`);
}

// ---- S: default outcome on open (the pressed/selected option carries aria-pressed or the selected styling)
function selectedOutcome(ingredients, discrepancies) {
  const html = renderToStaticMarkup(React.createElement(SubmitAuditReportModal, { isOpen: true, onClose: noop, venue, currentUser: user, ingredients, discrepancies, onSubmitSuccess: noop }));
  // each outcome is a button; find the one whose markup differs (selected) by aria-pressed="true" or by a data-selected flag
  const btns = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[0]);
  const pick = (re) => btns.find((b) => re.test(b.replace(/<[^>]+>/g, ' ')));
  return { html, passed: pick(/\bPass(ed)?\b(?![\s\S]*Notes)/i), notes: pick(/Notes/i), critical: pick(/Critical|Violation/i) };
}
function isSelected(btnHtml, others) {
  // selected option's class list differs from the unselected ones; compare class attr
  const cls = (b) => (b.match(/class="([^"]*)"/) || [, ''])[1];
  return btnHtml && others.every((o) => o && cls(o) !== cls(btnHtml)) && others.length && cls(others[0]) === cls(others[1] || others[0]);
}
try {
  const a = selectedOutcome([ing('1', 'verified_present'), ing('2', 'unverified')], [disc]);
  ok('S1 discrepancies -> critical violation selected', isSelected(a.critical, [a.passed, a.notes]));
  const b = selectedOutcome([ing('1', 'verified_present'), ing('2', 'verified_present')], []);
  ok('S2 all verified, none flagged -> passed selected', isSelected(b.passed, [b.notes, b.critical]));
  const c = selectedOutcome([ing('1', 'verified_present'), ing('2', 'unverified')], []);
  ok('S3 some unverified -> passed with notes selected', isSelected(c.notes, [c.passed, c.critical]));
} catch (e) { ok('S render', false, String(e).slice(0, 200)); }


// ---- S4: a tiny stateful renderer — the modal is mounted closed (as the hub does,
// before anything is loaded), then opened once a discrepancy exists. The default
// outcome must follow the data at the moment it opens, not the empty lists it was
// mounted with. Effects run after each render; setState re-renders.
function mount(Component) {
  const slots = []; const effDeps = []; let queue = []; let dirty = false;
  const disp = {
    useState: (() => { return (init) => { const i = disp._i++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { const nv = typeof v === 'function' ? v(slots[i]) : v; if (nv !== slots[i]) { slots[i] = nv; dirty = true; } }]; }; })(),
    useEffect: (fn, deps) => { const i = disp._i++; const prev = effDeps[i]; if (!deps || !prev || deps.some((d, k) => !Object.is(d, prev[k]))) { effDeps[i] = deps; queue.push(fn); } },
    useLayoutEffect: (fn, deps) => disp.useEffect(fn, deps),
    useRef: (v) => { const i = disp._i++; if (!(i in slots)) slots[i] = { current: v }; return slots[i]; },
    useMemo: (f) => { disp._i++; return f(); }, useCallback: (f) => { disp._i++; return f; },
    useContext: (c) => c?._currentValue, useId: () => 'id', _i: 0,
  };
  let out = null;
  const render = (props) => {
    for (let pass = 0; pass < 6; pass++) {
      dirty = false; disp._i = 0; queue = [];
      const prev = internals.H; internals.H = disp;
      try { out = Component(props); } finally { internals.H = prev; }
      for (const fn of queue) fn();
      if (!dirty) break;
    }
    return out ? renderToStaticMarkup(out) : '';
  };
  return { render };
}
try {
  const m = mount(SubmitAuditReportModal);
  const base = { onClose: noop, venue, currentUser: user, onSubmitSuccess: noop };
  m.render({ ...base, isOpen: false, ingredients: [], discrepancies: [] });
  const html = m.render({ ...base, isOpen: true, ingredients: [ing('1', 'verified_present'), ing('2', 'unverified')], discrepancies: [disc] });
  const btns = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((x) => x[0]);
  const pick = (re) => btns.find((b) => re.test(b.replace(/<[^>]+>/g, ' ')));
  const P = pick(/\bPass(ed)?\b(?![\s\S]*Notes)/i), N = pick(/Notes/i), C = pick(/Critical|Violation/i);
  ok('S4 mounted closed + empty, opened with a discrepancy -> critical violation selected', isSelected(C, [P, N]));
} catch (e) { ok('S4 mount', false, String(e).slice(0, 300)); }

console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
