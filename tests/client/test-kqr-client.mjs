// Kiosk QR sign-in, client (server #154; Don Oct 24 7:58 PM: scan = the tablet opens; 9:14 PM: dark tablet screen, menu row only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let passed = 0, failures = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('PASS ' + n); } else { failures++; console.log('FAIL ' + n + (d ? ' :: ' + d : '')); } };

// sessionStorage for the pending code.
const store = new Map();
const lstore = new Map();
globalThis.localStorage = { getItem: (k) => (lstore.has(k) ? lstore.get(k) : null), setItem: (k, v) => lstore.set(k, String(v)), removeItem: (k) => lstore.delete(k) };
globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { makeQr, qrPath } = await import('../../src/lib/qrEncode.ts');
const K = await import('../../src/lib/kioskQr.ts');
const A = await import('../../src/lib/api.ts');

// Q: the QR maker. Structure always; decoded by a real reader when one is on this machine (zbarimg).
const code = 'Ab3_-xYz0123456789AbCd';
const link = `https://app.hartfordkashrut.org/k/${code}`;
const m = makeQr(link);
ok('Q a 55-character link is version 4 (33 modules)', m.length === 33 && m.every((r) => r.length === 33), String(m.length));
ok('Q finder pattern top-left', m[0].slice(0, 7).every(Boolean) && m[1][0] && !m[1][1] && m[3][3] && m[6].slice(0, 7).every(Boolean));
ok('Q timing row alternates', m[6].slice(8, m.length - 8).every((c, i) => c === ((i + 8) % 2 === 0)));
ok('Q dark module', m[m.length - 8][8] === true);
ok('Q svg path has one square per dark module', (qrPath(m).match(/M/g) || []).length === m.flat().filter(Boolean).length);
let threw = false; try { makeQr('x'.repeat(2000)); } catch { threw = true; }
ok('Q too long -> throws (never a wrong code)', threw);
const zbar = spawnSync('sh', ['-c', 'command -v zbarimg'], { encoding: 'utf8' }).stdout.trim();
if (zbar) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kqr-'));
  // One text per version 1-20 (the shortest that needs it), plus the real link shapes.
  const texts = [link, 'https://shutfey-abc123-uc.a.run.app/k/' + code, 'http://127.0.0.1:3490/k/' + code];
  const seen = new Set();
  for (let n = 1; n <= 700 && seen.size < 20; n++) {
    const t = (n < 20 ? '' : 'https://x.org/k/') + 'Ab3_-xYz09'.repeat(70).slice(0, n);
    let v;
    try { v = (makeQr(t).length - 17) / 4; } catch { break; }
    if (!seen.has(v)) { seen.add(v); texts.push(t); }
  }
  ok('Q every version 1-20 is used by some length', [...Array(20)].every((_, i) => seen.has(i + 1)), [...seen].join(','));
  for (const t of texts) {
    const mm = makeQr(t);
    const n = mm.length + 8, sc = 6;
    // A plain PGM picture (no image library needed).
    const w = n * sc;
    const px = Buffer.alloc(w * w, 255);
    mm.forEach((row, y) => row.forEach((dark, x) => { if (dark) for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) px[((y + 4) * sc + b) * w + (x + 4) * sc + a] = 0; }));
    const f = path.join(tmp, 'q.pgm');
    fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${w} ${w}\n255\n`), px]));
    const out = spawnSync(zbar, ['-q', '--raw', f], { encoding: 'utf8' }).stdout.replace(/\n$/, '');
    ok(`Q a real reader reads it back (${t.length} chars, version ${(mm.length - 17) / 4})`, out === t, JSON.stringify(out.slice(0, 60)));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
} else console.log('SKIP Q reader check (no zbarimg on this machine: install zbar-tools to decode all 20 versions)');

// P: the link page path and the code kept while signing in.
ok('P /k/<code> -> code', K.kqrCodeFromPath('/k/' + code) === code && K.kqrCodeFromPath('/k/' + code + '/') === code);
ok('P bad codes -> null', [ '/k/', '/k/short', '/k/' + code + 'x', '/k/' + code.slice(0, 21) + '!', '/kk/' + code, '/k/' + code + '/x'].every((p) => K.kqrCodeFromPath(p) === null));
ok('P isKqrPath', K.isKqrPath('/k') && K.isKqrPath('/k/') && K.isKqrPath('/k/' + code) && !K.isKqrPath('/kiosk') && !K.isKqrPath('/') && !K.isKqrPath('/invite'));
K.savePendingKqr(code, 1000);
ok('P pending kept', K.readPendingKqr(1000 + 60000) === code);
ok('P pending dropped after 15 min', K.readPendingKqr(1000 + K.KQR_PENDING_MAX_MS) === null && store.size === 0);
K.savePendingKqr('nope', 1000);
ok('P a bad code is never kept', store.size === 0);
K.savePendingKqr(code); K.clearPendingKqr();
ok('P clear', K.readPendingKqr() === null);

// S: the in-app scanner takes only <listed origin>/k/<code>.
const origins = K.parseAppOrigins({ appOrigins: ['https://shutfey.example.com', 'https://app.hartfordkashrut.org', 'javascript:alert(1)', 'https://x.org/path', 'http://evil.example', 'http://127.0.0.1:3490', 7, 'https://app.hartfordkashrut.org'] });
ok('S appOrigins validated (https origins, loopback http, no duplicates)', JSON.stringify(origins) === JSON.stringify(['https://shutfey.example.com', 'https://app.hartfordkashrut.org', 'http://127.0.0.1:3490']), JSON.stringify(origins));
ok('S on an http page (local test server) a listed http address is allowed', JSON.stringify(K.parseAppOrigins({ appOrigins: ['http://hkc.test:3490', 'https://a.example'] }, true)) === JSON.stringify(['http://hkc.test:3490', 'https://a.example']));
ok('S appOrigins missing -> []', K.parseAppOrigins({ site: 'shared' }).length === 0 && K.parseAppOrigins(null).length === 0);
const L = (t) => K.kqrLinkFromScan(t, origins);
ok('S listed origin accepted', JSON.stringify(L(link)) === JSON.stringify({ origin: 'https://app.hartfordkashrut.org', code }));
ok('S other origin refused', L('https://evil.example/k/' + code) === null && L('https://app.hartfordkashrut.org.evil.example/k/' + code) === null);
ok('S http of a listed https origin refused', L('http://app.hartfordkashrut.org/k/' + code) === null);
ok('S query / hash / user refused', L(link + '?x=1') === null && L(link + '#t') === null && L('https://u:p@app.hartfordkashrut.org/k/' + code) === null);
ok('S other paths refused', L('https://app.hartfordkashrut.org/invite#t=' + code) === null && L('https://app.hartfordkashrut.org/k/' + code + '/') === null && L('https://app.hartfordkashrut.org/k/abc') === null);
ok('S non-URL text refused', L('hello') === null && L(null) === null && L('x'.repeat(600)) === null);
ok('S nothing listed -> nothing accepted', K.kqrLinkFromScan(link, []) === null);

// E: the server's answers -> the screens (codes from src/server/kiosk-qr.ts KQR_TEXT / server.ts).
const E = (s, b) => K.kqrErrorFor(s, b);
ok('E expired', E(410, { code: 'KIOSK_QR_EXPIRED', error: 'This code has expired. Scan the new code on the tablet.' }).kind === 'expired' && E(410, {}).again === 'scan');
ok('E unusable', E(404, { code: 'KIOSK_QR_UNUSABLE' }).kind === 'unusable');
const nh = E(403, { code: 'KIOSK_QR_NOT_HERE', error: "You can't sign in on this tablet. Ask your administrator for a code at Hill Bakery." });
ok('E not here keeps the server words with the venue', nh.kind === 'notHere' && nh.title === "You can't sign in on this tablet" && nh.body === 'Ask your administrator for a code at Hill Bakery.' && nh.again === 'none', JSON.stringify(nh));
ok('E too many: the server words', E(429, { code: 'RATE_LIMITED', error: 'Too many tries. Wait a minute and scan again.' }).body === 'Too many tries. Wait a minute and scan again.');
ok('E sign in first', E(401, { code: 'SIGN_IN_FIRST' }).kind === 'signIn');
ok('E wrong address -> its own screen (scan with the camera app), never a sign-out', E(403, { code: 'WRONG_SITE' }).kind === 'site' && !!E(403, { code: 'WRONG_SITE' }).title && E(403, { code: 'SITE_NOT_SET_UP' }).kind === 'site');
// C: a cookie tablet opened by a phone is signed in on the cookie, like a sign-in moved there.
A.setSessionToken('tok-before'); lstore.set('shutfey_logout_pending', '1');
const keyBefore = A.sessionCredentialKey();
A.noteServerCookieSignIn();
ok('C cookie claim: no token, on the cookie (so sign-out ends the server session), old pending sign-out dropped, a new sign-in key', A.getSessionToken() === null && A.isCookieSession() && A.hasSessionCredential() && !lstore.get('shutfey_logout_pending') && A.sessionCredentialKey() !== keyBefore);
A.clearSession();
// C: the sign-in requests a sign-out retry and the PIN sign-in wait for.
let release; const pend = new Promise((r) => { release = r; });
A.trackCookieSignInRequest(pend);
const early = await A.cookieSignInsSettled(150);
setTimeout(() => release(), 50);
const later = await A.cookieSignInsSettled(2000);
ok('C a QR sign-in request on its way is waited for; settled once its answer is handled', early === false && later === true);
ok('E 503 -> try again', E(503, { code: 'KIOSK_QR_UNAVAILABLE' }).again === 'retry');
ok('E no Yes / number / Face ID words anywhere', !/face id|passkey|six-digit|6-digit|yes, that/i.test(JSON.stringify(K.KQR_UI_TEXT)));
ok('T countdown', K.countdownText(42000) === '0:42' && K.countdownText(60000) === '1:00' && K.countdownText(-5) === '0:00' && K.countdownText(100) === '0:01');
ok('T tablets parsed, bad rows dropped', JSON.stringify(K.parseTablets({ tablets: [{ ref: code, tabletName: 'Hill Bakery tablet', venueName: 'Hill Bakery', sinceMs: 1, endsAtMs: 2 }, { ref: 'bad' }, null] })) === JSON.stringify([{ ref: code, tabletName: 'Hill Bakery tablet', venueName: 'Hill Bakery', sinceMs: 1, endsAtMs: 2 }]));
K.markRefusedKqr(code, 5000);
ok('R a refused code is skipped by the scanner for a minute', K.wasJustRefused(code, 5000 + 59000) && !K.wasJustRefused(code, 5000 + 60000) && !K.wasJustRefused('Zz3_-xYz0123456789AbCd', 5001));
ok('T hi', K.KQR_UI_TEXT.hi('Yossi', 'Hill Bakery') === 'Hi Yossi – Hill Bakery');

// W: wiring (source).
const src = (p) => fs.readFileSync(new URL('../../src/' + p, import.meta.url), 'utf8');
const app = src('App.tsx'), hdr = src('components/Header.tsx'), lib = src('lib/kioskQr.ts'), phone = src('components/KioskQrPhone.tsx'), tab = src('components/KioskQrScreen.tsx'), sheet = src('components/TabletSignInSheet.tsx'), pin = src('components/KioskLogin.tsx');
ok('W menu row only when App passes the handler (both menus)', (hdr.match(/\{(currentUser && )?onOpenTabletSignIn && \(/g) || []).length === 2);
ok('W App passes it only when /api/auth/me said canUseTabletSignIn, never on a kiosk', app.includes("onOpenTabletSignIn={canTabletSignIn && !isKiosk ? () => setTabletSheet('scan') : undefined}") && lib.includes('body.canUseTabletSignIn === true'));
ok('W no main-screen button (Don 9:14 PM: menu only)', (app.match(/setTabletSheet\('scan'\)/g) || []).length === 2 && !/data-open-tablet-signin/.test(app));
ok('W phone calls: cookie only, no Authorization, never apiFetch (no sign-out from these answers)', /COOKIE_AUTH_HEADER\]: COOKIE_AUTH_VALUE/.test(lib) && !/Authorization/.test(lib.slice(lib.indexOf('export async function kqrPhoneFetch'), lib.indexOf('export async function readCanUseTabletSignIn'))) && !/apiFetch\('\/api\/kiosk\/qr/.test(phone + sheet));
ok('W approve is a POST sent by the page on open, no tap', /kqrPhoneFetch\('\/api\/kiosk\/qr\/approve', \{ method: 'POST', body: \{ code \} \}\)/.test(phone) && !/onClick=\{[^}]*approve/i.test(phone));
ok('W approve waits for the sign-in cookie', /isCookieSession\(\) && !getSessionToken\(\)/.test(phone));
ok('W the code leaves the address bar (/k only) and is kept for this tab', app.includes("window.history.replaceState(null, '', kioskMode ? '/' : '/k')") && app.includes('savePendingKqr(code)'));
ok('W signed out on /k -> the sign-in form, then back', /if \(kqrPage && !isKiosk\) \{[\s\S]*?<LoginPage[\s\S]*?onLoginSuccess=\{handleLoginSuccess\}/.test(app));
ok('W scanner: listed origins only; other address -> that address', sheet.includes('kqrLinkFromScan(f.rawValue, origins)') && sheet.includes('window.location.assign(`${link.origin}/k/${link.code}`)'));
ok('W scanner camera off -> camera-app tip', sheet.includes('T.scanNoCamera'));
ok('W tablet: start, poll, cancel on "Use your code instead"', tab.includes("'/api/kiosk/qr/start'") && tab.includes("'/api/kiosk/qr/poll'") && tab.includes("apiFetch('/api/kiosk/qr/cancel', { method: 'POST' })"));
ok('W tablet: a poll without the link while the code is live keeps the code on screen', tab.includes("if (lastLink && typeof d.codeIssuedAtMs === 'number' && d.codeIssuedAtMs === lastIssuedAt && d.retryInMs === undefined) return later(KQR_POLL_MS, false);"));
ok('W tablet: token only from a token answer; welcome 3 s', tab.includes("if (typeof d.token === 'string' && d.token) setSessionToken(d.token);") && tab.includes('KQR_WELCOME_MS = 3000'));
ok('W tablet: an older server (404 without a code) -> PIN screen as before', tab.includes("if (r.status === 404 && !d.code) { cb.current.onUnavailable(); return; }") && app.includes('onUnavailable={() => setKqrOnServer(false)}'));
ok('W PIN sign-in unchanged (same call, same token handling)', pin.includes("apiFetch('/api/kiosk/login'") && pin.includes('if (d.token) setSessionToken(d.token);'));
ok('W scanner skips a just-refused code', sheet.includes('wasJustRefused(link.code)') && phone.includes("if (error.again === 'scan') markRefusedKqr(code);"));
ok('W cookie tablet: the claim marks this device as signed in on the cookie (sign-out ends the server session, realtime uses the cookie)', tab.includes('else noteServerCookieSignIn();'));
ok('W tablet: a late cancel from "Use your code instead" is waited for before a new start', tab.includes('if (first && cancelInFlight)') && tab.includes('cancelInFlight = p;'));
ok('W tablet: a poll keeps the code on screen only while it names the same code', tab.includes('d.codeIssuedAtMs === lastIssuedAt') && tab.includes('return later(0, true);'));
ok('W phone: a QR answer never clears the session itself (no site-refusal sign-out); 401 / site refusal -> /api/auth/me', !lib.includes('noticeSiteRefusalFor') && !lib.includes('clearSession') && lib.includes('await confirmPhoneSession();'));
ok('W tablet: no start/poll while a sign-out is on its way (its answer would delete the new cookie)', tab.includes('if (!(await signOutsSettled(KQR_POLL_MS))) return later(KQR_POLL_MS, first);'));
ok('W tablet: a claim answer landing after the screen is gone is ended, and tracked until then', tab.includes('trackCookieSignInRequest(') && tab.includes("if (!live && res.ok && body?.state === 'signed-in') await endUnusedKioskSignIn("));
ok('W tablet: "Use your code instead" lets a poll on its way land first (a scan just now opens the tablet)', tab.includes('if (inflight.current) await Promise.race([inflight.current') && tab.includes('if (claimed.current) return;'));
ok('W PIN sign-in and the sign-out retry wait for a QR sign-in on its way, and send nothing while it still is', pin.includes('if (!(await cookieSignInsSettled())) {') && pin.includes('setError(KIOSK_FINISHING_SIGN_IN);') && src('lib/api.ts').includes('if (signInsInFlight.size > 0 && !(await cookieSignInsSettled())) return;'));
ok('W a reopened QR screen waits for an earlier screen\'s start/poll (and its cleanup) before its own', tab.includes('if (!(await cookieSignInsSettled(KQR_POLL_MS))) return later(KQR_POLL_MS, first);'));
ok('W tablet signs out -> QR screen again', app.includes("if (kioskMode) setKioskSignIn('qr');"));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
