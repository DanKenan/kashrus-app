/**
 * Phones with the browser's "Desktop site" setting on.
 *
 * What the browser does (Chromium content/browser/web_contents/web_contents_impl.cc):
 * with "Desktop site" on, Chrome for Android sends a desktop user agent and sets
 * `viewport_meta_enabled = false`, so our `<meta name="viewport" width=device-width>`
 * is ignored (a meta tag rewritten from JS is ignored the same way). The page is laid
 * out about 980 px wide and shrunk to fit the phone: tiny text, desktop columns.
 * The same happens inside the installed app, which has no menu to turn it off.
 *
 * What we do: when a phone-sized touch screen gets a layout much wider than the
 * screen, we zoom the page (CSS `zoom` on <html>) by layout width / screen width, so
 * everything is drawn at phone size again, and we point width media queries and
 * vh/vw lengths at the phone's width. Then we check the result; if it did not take,
 * we undo it and the app shows a short note on how to turn the setting off.
 */

/** Chrome's own phone/tablet line: a screen whose short side is 600 dp or more is a tablet. */
export const PHONE_MAX_SHORT_SIDE = 600;
/** The layout must be at least this many times wider than the screen. */
export const WIDE_LAYOUT_RATIO = 1.3;

export interface ViewEnv {
  maxTouchPoints: number;
  coarsePointer: boolean;
  screenWidth: number;
  screenHeight: number;
  /** Layout width in CSS px (document.documentElement.clientWidth). */
  layoutWidth: number;
}

/** True for a phone-sized touch screen that is drawing a desktop-width layout. */
export function isPhoneInDesktopMode(env: ViewEnv): boolean {
  const touch = (Number(env.maxTouchPoints) || 0) > 0 || !!env.coarsePointer;
  if (!touch) return false;
  const sw = Number(env.screenWidth) || 0;
  const sh = Number(env.screenHeight) || 0;
  const lw = Number(env.layoutWidth) || 0;
  if (sw <= 0 || sh <= 0 || lw <= 0) return false;
  if (Math.min(sw, sh) >= PHONE_MAX_SHORT_SIDE) return false;
  return lw > sw * WIDE_LAYOUT_RATIO;
}

/** Media query text with width features read from the screen width instead of the layout. */
export function toDeviceWidthMedia(text: string): string {
  return String(text).replace(/(?<![\w-])(min-|max-)?width(?=\s*[:<>=)])/g, (_m, p) => `${p || ''}device-width`);
}

const VIEWPORT_LENGTH = /(-?(?:\d+\.?\d*|\.\d+))((?:d|s|l)?v(?:h|w|min|max|i|b))\b/g;
/** A CSS value with viewport lengths divided by the page zoom (zoom multiplies them back). */
export function unzoomViewportLengths(value: string): string {
  return String(value).replace(VIEWPORT_LENGTH, (_m, n, u) => `calc(${n}${u} / var(--dm-zoom, 1))`);
}
export function hasViewportLength(value: string): boolean {
  VIEWPORT_LENGTH.lastIndex = 0;
  const yes = VIEWPORT_LENGTH.test(String(value));
  VIEWPORT_LENGTH.lastIndex = 0;
  return yes;
}

export type DesktopModeState = {
  /** A phone drawing a desktop-width layout was seen. */
  detected: boolean;
  /** The automatic fix is on and checked. */
  fixed: boolean;
  zoom: number;
};

let state: DesktopModeState = { detected: false, fixed: false, zoom: 1 };
const listeners = new Set<() => void>();
export function getDesktopModeState(): DesktopModeState { return state; }
export function subscribeDesktopMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function setState(next: DesktopModeState) {
  if (next.detected === state.detected && next.fixed === state.fixed && next.zoom === state.zoom) return;
  state = next;
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

/** The width the user actually sees, in CSS px (the screen width while the fix is on). */
export function effectiveViewportWidth(): number {
  if (typeof window === 'undefined') return 1024;
  if (state.fixed && window.screen?.width) return window.screen.width;
  return window.innerWidth;
}
/** A min-width media query that follows the fix. */
export function minWidthQuery(px: number): string {
  const q = `(min-width: ${px}px)`;
  return state.fixed ? toDeviceWidthMedia(q) : q;
}

// ---- applying the fix (browser only) ----

type MediaEdit = { list: MediaList; text: string };
type StyleEdit = { style: CSSStyleDeclaration; prop: string; value: string; priority: string };
let mediaEdits: MediaEdit[] = [];
let styleEdits: StyleEdit[] = [];
let seenSheets = new WeakSet<CSSStyleSheet>();
let rewriteUnits = true;

function walkRules(rules: CSSRuleList | undefined) {
  if (!rules) return;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i] as CSSRule & { media?: MediaList; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
    const isMedia = typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule;
    if (isMedia && rule.media) {
      const text = rule.media.mediaText;
      const next = toDeviceWidthMedia(text);
      if (next !== text) {
        try { rule.media.mediaText = next; mediaEdits.push({ list: rule.media, text }); } catch { /* ignore */ }
      }
    }
    if (rewriteUnits && rule.style && typeof rule.style.length === 'number') {
      const st = rule.style;
      for (let j = 0; j < st.length; j += 1) {
        const prop = st[j];
        const value = st.getPropertyValue(prop);
        if (!value || !hasViewportLength(value)) continue;
        const priority = st.getPropertyPriority(prop);
        try {
          st.setProperty(prop, unzoomViewportLengths(value), priority);
          styleEdits.push({ style: st, prop, value, priority });
        } catch { /* ignore */ }
      }
    }
    if (rule.cssRules) walkRules(rule.cssRules);
  }
}

function rewriteSheets() {
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    if (seenSheets.has(sheet)) continue;
    let rules: CSSRuleList | undefined;
    try { rules = sheet.cssRules; } catch { continue; } // another site's sheet: not ours to read
    seenSheets.add(sheet);
    walkRules(rules);
  }
}

function undoAll() {
  for (let i = mediaEdits.length - 1; i >= 0; i -= 1) {
    try { mediaEdits[i].list.mediaText = mediaEdits[i].text; } catch { /* ignore */ }
  }
  for (let i = styleEdits.length - 1; i >= 0; i -= 1) {
    const e = styleEdits[i];
    try { e.style.setProperty(e.prop, e.value, e.priority); } catch { /* ignore */ }
  }
  mediaEdits = [];
  styleEdits = [];
  seenSheets = new WeakSet<CSSStyleSheet>();
  const html = document.documentElement;
  html.style.removeProperty('zoom');
  html.style.removeProperty('--dm-zoom');
  html.style.removeProperty('transition');
  html.classList.remove('desktop-mode-fixed');
}

function readEnv(): ViewEnv {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return {
    maxTouchPoints: navigator.maxTouchPoints || 0,
    coarsePointer: coarse,
    screenWidth: window.screen?.width || 0,
    screenHeight: window.screen?.height || 0,
    layoutWidth: document.documentElement.clientWidth || window.innerWidth || 0,
  };
}

/** The page now draws at the screen's width (checked with a probe element). */
function looksRight(screenWidth: number, visibleHeight: number): boolean {
  const body = document.body;
  if (!body) return false;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100vh;visibility:hidden;pointer-events:none';
  body.appendChild(probe);
  // the probe's own vh height goes through the same rewrite as the app's CSS
  if (rewriteUnits) probe.style.height = unzoomViewportLengths('100vh');
  const w = probe.offsetWidth;
  const h = probe.offsetHeight;
  probe.remove();
  const near = (a: number, b: number, tol: number) => b > 0 && Math.abs(a - b) / b <= tol;
  return near(w, screenWidth, 0.08) && near(h, visibleHeight, 0.15);
}

let lastScreenWidth = -1;

function evaluate() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  undoAll();
  const env = readEnv();
  lastScreenWidth = env.screenWidth;
  if (!isPhoneInDesktopMode(env)) { setState({ detected: false, fixed: false, zoom: 1 }); return; }
  const zoom = env.layoutWidth / env.screenWidth;
  const supportsZoom = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '2');
  if (!supportsZoom) { setState({ detected: true, fixed: false, zoom: 1 }); return; }
  const visibleHeight = (document.documentElement.clientHeight || window.innerHeight) / zoom;
  // Older engines did not multiply vh/vw by zoom; try with the vh/vw rewrite first, then without.
  for (const units of [true, false]) {
    rewriteUnits = units;
    const html = document.documentElement;
    html.style.setProperty('--dm-zoom', String(zoom));
    // No transition on <html>: with "reduce motion" on, index.css gives every element a 0.01 ms
    // transition, so a zoom change would only land on the next frame (the check would read the old size).
    html.style.setProperty('transition', 'none', 'important');
    html.style.setProperty('zoom', String(zoom));
    html.classList.add('desktop-mode-fixed');
    rewriteSheets();
    if (looksRight(env.screenWidth, visibleHeight)) { setState({ detected: true, fixed: true, zoom }); return; }
    undoAll();
  }
  rewriteUnits = true;
  setState({ detected: true, fixed: false, zoom: 1 });
}

let started = false;
/** Run once before the app renders. Safe to call again. */
export function startDesktopModeFix(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return;
  started = true;
  try { evaluate(); } catch { try { undoAll(); } catch { /* ignore */ } }
  // Stylesheets that load later (lazy screens) get the same rewrite.
  try {
    new MutationObserver(() => {
      if (!state.fixed) return;
      try { rewriteSheets(); } catch { /* ignore */ }
    }).observe(document.head, { childList: true, subtree: true });
    document.addEventListener('load', (e) => {
      if (state.fixed && (e.target as Element | null)?.tagName === 'LINK') { try { rewriteSheets(); } catch { /* ignore */ } }
    }, true);
  } catch { /* ignore */ }
  // Turning the phone changes the screen width: check again.
  const again = () => { if ((window.screen?.width || 0) !== lastScreenWidth) { try { evaluate(); } catch { /* ignore */ } } };
  window.addEventListener('resize', again);
  window.addEventListener('orientationchange', again);
}

// ---- the note ----

export const DESKTOP_NOTE_DISMISS_KEY = 'shutfey_desktop_note_dismissed_at';
export const DESKTOP_NOTE_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

export function noteDismissedRecently(saved: string | null | undefined, now: number): boolean {
  const at = Number(saved);
  return Number.isFinite(at) && at > 0 && now - at < DESKTOP_NOTE_DISMISS_MS && at <= now + 60_000;
}

export type NoteBrowser = 'chrome' | 'samsung' | 'safari';
export function noteBrowserFromUa(ua: string): NoteBrowser {
  const s = String(ua || '');
  if (/SamsungBrowser/i.test(s)) return 'samsung';
  if (/Macintosh|iPhone|iPad/.test(s) && !/Chrome|CriOS|Android/.test(s)) return 'safari';
  return 'chrome';
}

/** Short plain words: inside the installed app there is no browser menu. */
export function desktopNoteText(browser: NoteBrowser, standalone: boolean): string {
  if (browser === 'samsung') {
    return standalone
      ? 'This phone is set to show the desktop version. To fix: open the Samsung Internet app → ☰ → turn off Desktop version. Then close and reopen this app.'
      : 'This phone is showing the desktop version. Tap ☰ and turn off Desktop version.';
  }
  if (browser === 'safari') {
    return standalone
      ? 'This phone is set to show the desktop version. To fix: open Settings → Safari → Request Desktop Website → turn off. Then close and reopen this app.'
      : 'This phone is showing the desktop version. Tap ᴀA in the address bar, then Request Mobile Website.';
  }
  return standalone
    ? 'This phone is set to show the desktop version. To fix: open the Chrome app → ⋮ → Settings → Site settings → Desktop site → turn off. Then close and reopen this app.'
    : 'This phone is showing the desktop version. In Chrome tap ⋮ and uncheck “Desktop site”.';
}

/** Show the note: the phone draws a desktop layout, the fix did not take, not a kiosk, not dismissed lately. */
export function shouldShowDesktopNote(s: DesktopModeState, opts: { kiosk: boolean; dismissedAt: string | null | undefined; now: number }): boolean {
  if (!s.detected || s.fixed || opts.kiosk) return false;
  return !noteDismissedRecently(opts.dismissedAt, opts.now);
}
