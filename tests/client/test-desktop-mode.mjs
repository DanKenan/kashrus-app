// Phones with the browser's "Desktop site" setting on (lib/desktopMode.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Import without browser globals first (module load must not touch window/document).
const saved = ['window', 'navigator', 'document'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
for (const [k] of saved) delete globalThis[k];
const D = await import('../../src/lib/desktopMode.ts');
for (const [k, d] of saved) if (d) Object.defineProperty(globalThis, k, d);

const phone = { maxTouchPoints: 5, coarsePointer: true, screenWidth: 412, screenHeight: 915 };
// Chrome Android with "Desktop site": 980 px layout on a 412 px phone (also inside the installed app).
assert.equal(D.isPhoneInDesktopMode({ ...phone, layoutWidth: 980 }), true, 'phone in desktop mode');
assert.equal(D.isPhoneInDesktopMode({ ...phone, screenWidth: 360, screenHeight: 780, layoutWidth: 980 }), true, 'small phone in desktop mode');
assert.equal(D.isPhoneInDesktopMode({ ...phone, coarsePointer: false, layoutWidth: 980 }), true, 'touch points alone count');
assert.equal(D.isPhoneInDesktopMode({ ...phone, maxTouchPoints: 0, layoutWidth: 980 }), true, 'coarse pointer alone counts');
// Not this case.
assert.equal(D.isPhoneInDesktopMode({ ...phone, layoutWidth: 412 }), false, 'normal phone');
assert.equal(D.isPhoneInDesktopMode({ ...phone, layoutWidth: 530 }), false, 'phone, layout a bit wider than the screen (under 1.3x)');
assert.equal(D.isPhoneInDesktopMode({ ...phone, screenWidth: 915, screenHeight: 412, layoutWidth: 980 }), false, 'phone turned sideways (980 vs 915)');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 5, coarsePointer: true, screenWidth: 800, screenHeight: 1280, layoutWidth: 800 }), false, 'Android tablet');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 5, coarsePointer: true, screenWidth: 800, screenHeight: 1280, layoutWidth: 1280 }), false, 'tablet with a wide layout (short side is tablet size)');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 5, coarsePointer: true, screenWidth: 1280, screenHeight: 800, layoutWidth: 1280 }), false, 'kiosk tablet, landscape');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 5, coarsePointer: true, screenWidth: 744, screenHeight: 1133, layoutWidth: 980 }), false, 'iPad mini desktop-class Safari (980 layout on 744)');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 5, coarsePointer: true, screenWidth: 1024, screenHeight: 1366, layoutWidth: 1024 }), false, 'iPad Pro');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 0, coarsePointer: false, screenWidth: 1920, screenHeight: 1080, layoutWidth: 1280 }), false, 'desktop');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 0, coarsePointer: false, screenWidth: 412, screenHeight: 915, layoutWidth: 980 }), false, 'no touch at all');
assert.equal(D.isPhoneInDesktopMode({ maxTouchPoints: 10, coarsePointer: false, screenWidth: 1920, screenHeight: 1080, layoutWidth: 1920 }), false, 'touch laptop');
for (const bad of [0, NaN, undefined, -1]) {
  assert.equal(D.isPhoneInDesktopMode({ ...phone, screenWidth: bad, layoutWidth: 980 }), false, `screen width ${bad}`);
  assert.equal(D.isPhoneInDesktopMode({ ...phone, layoutWidth: bad }), false, `layout width ${bad}`);
}

// Width media queries read the screen width while the fix is on.
assert.equal(D.toDeviceWidthMedia('(width >= 40rem)'), '(device-width >= 40rem)');
assert.equal(D.toDeviceWidthMedia('(width < 48rem)'), '(device-width < 48rem)');
assert.equal(D.toDeviceWidthMedia('(min-width: 760px)'), '(min-device-width: 760px)');
assert.equal(D.toDeviceWidthMedia('(max-width: 959px)'), '(max-device-width: 959px)');
assert.equal(D.toDeviceWidthMedia('(40rem <= width)'), '(40rem <= device-width)');
assert.equal(D.toDeviceWidthMedia('(hover: hover) and (min-width: 640px)'), '(hover: hover) and (min-device-width: 640px)');
assert.equal(D.toDeviceWidthMedia('(prefers-reduced-motion: reduce)'), '(prefers-reduced-motion: reduce)');
assert.equal(D.toDeviceWidthMedia('(min-device-width: 640px)'), '(min-device-width: 640px)', 'already device-width: unchanged');
assert.equal(D.toDeviceWidthMedia('(min-height: 600px)'), '(min-height: 600px)', 'height untouched');

// vh/vw lengths are divided by the zoom (zoom multiplies them back).
assert.equal(D.unzoomViewportLengths('100vh'), 'calc(100vh / var(--dm-zoom, 1))');
assert.equal(D.unzoomViewportLengths('90vh'), 'calc(90vh / var(--dm-zoom, 1))');
assert.equal(D.unzoomViewportLengths('85dvh'), 'calc(85dvh / var(--dm-zoom, 1))');
assert.equal(D.unzoomViewportLengths('min(100%, 52vw)'), 'min(100%, calc(52vw / var(--dm-zoom, 1)))');
assert.equal(D.unzoomViewportLengths('16px'), '16px');
assert.equal(D.hasViewportLength('calc(100vh - 2rem)'), true);
assert.equal(D.hasViewportLength('12px 1rem'), false);
assert.equal(D.hasViewportLength('url(a.svg)'), false);

// The note: only when the fix did not take, never on a kiosk, dismiss holds 7 days.
const now = Date.UTC(2026, 9, 27, 12);
const notFixed = { detected: true, fixed: false, zoom: 1 };
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: false, dismissedAt: null, now }), true);
assert.equal(D.shouldShowDesktopNote({ detected: true, fixed: true, zoom: 2.38 }, { kiosk: false, dismissedAt: null, now }), false, 'fix took');
assert.equal(D.shouldShowDesktopNote({ detected: false, fixed: false, zoom: 1 }, { kiosk: false, dismissedAt: null, now }), false, 'normal device');
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: true, dismissedAt: null, now }), false, 'kiosk');
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: false, dismissedAt: String(now - 6 * 864e5), now }), false, 'dismissed 6 days ago');
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: false, dismissedAt: String(now - 8 * 864e5), now }), true, 'dismissed 8 days ago');
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: false, dismissedAt: 'junk', now }), true, 'junk value');
assert.equal(D.shouldShowDesktopNote(notFixed, { kiosk: false, dismissedAt: String(now + 30 * 864e5), now }), true, 'a date in the future does not hide it forever');

// Words: in the installed app there is no browser menu.
const desk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const samsung = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36';
const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
assert.equal(D.noteBrowserFromUa(desk), 'chrome');
assert.equal(D.noteBrowserFromUa(samsung), 'samsung');
assert.equal(D.noteBrowserFromUa(macSafari), 'safari');
assert.equal(D.noteBrowserFromUa(''), 'chrome');
assert.equal(D.desktopNoteText('chrome', false), 'This phone is showing the desktop version. In Chrome tap ⋮ and uncheck “Desktop site”.');
assert.equal(D.desktopNoteText('chrome', true), 'This phone is set to show the desktop version. To fix: open the Chrome app → ⋮ → Settings → Site settings → Desktop site → turn off. Then close and reopen this app.');
assert.equal(D.desktopNoteText('samsung', false), 'This phone is showing the desktop version. Tap ☰ and turn off Desktop version.');
assert.match(D.desktopNoteText('samsung', true), /open the Samsung Internet app → ☰ → turn off Desktop version\. Then close and reopen this app\./);

// Before any fix runs: widths are the window's.
assert.deepEqual(D.getDesktopModeState(), { detected: false, fixed: false, zoom: 1 });
assert.equal(D.minWidthQuery(768), '(min-width: 768px)');

// Wiring (source): the fix runs before the first render, the note sits above the app,
// width readers follow the fix.
const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8');
assert.ok(main.indexOf('startDesktopModeFix();') > main.indexOf("import './index.css'"), 'fix runs after the CSS import');
assert.ok(main.indexOf('startDesktopModeFix();') < main.indexOf('createRoot('), 'fix runs before the first render');
assert.ok(main.indexOf('<DesktopModeNote />') < main.indexOf('<App />'), 'note above the app');
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
assert.ok(!/initialTaskView\(typeof window !== 'undefined' \? window\.innerWidth/.test(app), 'task view reads the width the user sees');
const umw = readFileSync(new URL('../../src/lib/useMinWidth.ts', import.meta.url), 'utf8');
assert.ok(umw.includes('minWidthQuery(px)'), 'useMinWidth follows the fix');
const note = readFileSync(new URL('../../src/components/DesktopModeNote.tsx', import.meta.url), 'utf8');
assert.ok(note.includes('shouldShowDesktopNote(') && note.includes('onKiosk()'), 'note uses the shared rule and the kiosk check');
console.log('test-desktop-mode OK');
