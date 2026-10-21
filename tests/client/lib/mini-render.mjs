// Tiny stateful renderer for client tests (no DOM). Calls a function component under a
// home-made React dispatcher, runs effects, awaits async work, and lets a test click
// buttons / type into inputs by walking the returned element tree. Child components
// render through react-dom/server when html() is called.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const tick = () => new Promise((r) => setTimeout(r, 0));

export function mount(Component, initialProps) {
  const slots = []; const effDeps = []; let queue = []; let dirty = false; let props = initialProps; let out = null;
  const disp = {
    _i: 0,
    useState(init) { const i = disp._i++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { const nv = typeof v === 'function' ? v(slots[i]) : v; if (!Object.is(nv, slots[i])) { slots[i] = nv; dirty = true; } }]; },
    useReducer(r, init, f) { const i = disp._i++; if (!(i in slots)) slots[i] = f ? f(init) : init; return [slots[i], (a) => { const nv = r(slots[i], a); if (!Object.is(nv, slots[i])) { slots[i] = nv; dirty = true; } }]; },
    useEffect(fn, deps) { const i = disp._i++; const prev = effDeps[i]; if (!deps || !prev || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))) { effDeps[i] = deps || null; queue.push(fn); } },
    useLayoutEffect(fn, deps) { disp.useEffect(fn, deps); },
    useInsertionEffect() { disp._i++; },
    useRef(v) { const i = disp._i++; if (!(i in slots)) slots[i] = { current: v }; return slots[i]; },
    useMemo(f) { disp._i++; return f(); }, useCallback(f) { disp._i++; return f; },
    useContext(c) { return c?._currentValue; }, useId() { return ':r' + (disp._i++) + ':'; },
    useTransition() { disp._i++; return [false, (f) => f()]; }, useDeferredValue(v) { disp._i++; return v; },
    useSyncExternalStore(s, g) { disp._i++; return g(); }, useImperativeHandle() { disp._i++; }, useDebugValue() {},
  };
  function once() {
    dirty = false; disp._i = 0; queue = [];
    const prev = internals.H; internals.H = disp;
    try { out = Component(props); } finally { internals.H = prev; }
    const q = queue; queue = []; for (const fn of q) fn();
  }
  async function settle() {
    for (let n = 0; n < 25; n++) { once(); await tick(); await tick(); if (!dirty) { once(); return; } }
    throw new Error('render did not settle');
  }
  const textOf = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    if (React.isValidElement(node)) return textOf(node.props?.children);
    return '';
  };
  function* walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) yield* walk(c); return; }
    if (!React.isValidElement(node)) return;
    yield node; yield* walk(node.props?.children);
  }
  const find = (pred) => [...walk(out)].filter((e) => typeof e.type === 'string' && pred(e));
  const ev = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, target: { value: '', checked: false, files: [] }, currentTarget: {}, ...extra });
  return {
    async render(next) { if (next) props = { ...props, ...next }; await settle(); return this; },
    html() { return out ? renderToStaticMarkup(out) : ''; },
    text() { return textOf(out).replace(/\s+/g, ' ').trim(); },
    tree() { return out; },
    find,
    buttons() { return find((e) => (e.type === 'button' || e.props.role === 'button' || e.props.role === 'tab') ).map((e) => ({ label: (textOf(e.props.children) || e.props['aria-label'] || e.props.title || '').replace(/\s+/g, ' ').trim(), title: e.props.title || '', aria: e.props['aria-label'] || '', el: e })); },
    async click(match, nth = 0) {
      const m = typeof match === 'function' ? match : (e) => { const t = (textOf(e.props.children) + ' ' + (e.props['aria-label'] || '') + ' ' + (e.props.title || '')).replace(/\s+/g, ' '); return match instanceof RegExp ? match.test(t) : t.includes(match); };
      let hits = find((e) => typeof e.props.onClick === 'function' && m(e));
      // prefer real controls over wrappers that also carry onClick (e.g. a dialog's stopPropagation div)
      const ctl = hits.filter((e) => e.type === 'button' || e.type === 'a' || e.props.role === 'button' || e.props.role === 'tab');
      if (ctl.length) hits = ctl;
      if (!hits[nth]) throw new Error('no clickable match for ' + match + ' (' + hits.length + ')');
      await hits[nth].props.onClick(ev()); await settle(); return hits.length;
    },
    async type(match, value) {
      const hits = find((e) => (e.type === 'input' || e.type === 'textarea' || e.type === 'select') && typeof e.props.onChange === 'function' && (match instanceof RegExp ? match.test(e.props.placeholder || e.props.name || e.props.id || '') : (e.props.placeholder || e.props.name || e.props.id || '').includes(match)));
      if (!hits[0]) throw new Error('no input for ' + match);
      await hits[0].props.onChange(ev({ target: { value, checked: !!value } })); await settle();
    },
    async submit() { const f = find((e) => e.type === 'form' && typeof e.props.onSubmit === 'function'); if (!f[0]) throw new Error('no form'); await f[0].props.onSubmit(ev()); await settle(); },
  };
}

// fetch recorder: answers by URL prefix; records [method, path, body] for flow-parity checks.
export function recordFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const path = u.replace(/^https?:\/\/[^/]+/, '');
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    if (body && typeof body === 'object') { delete body.operationId; }
    calls.push([(opts.method || 'GET').toUpperCase(), path.split('?')[0], body ?? null]); // operationId is random per write; dropped
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k.split(' ').pop()) && (!k.includes(' ') || k.split(' ')[0] === (opts.method || 'GET').toUpperCase()));
    const data = hit ? (typeof hit[1] === 'function' ? hit[1](path, body) : hit[1]) : {};
    if (data === 'PENDING') return new Promise(() => {});
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return calls;
}
