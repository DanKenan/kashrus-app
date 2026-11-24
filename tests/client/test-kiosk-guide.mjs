import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectKioskDevice, KIOSK_DEVICE_ORDER, KIOSK_LOCK_GUIDES, KIOSK_OVERVIEW_SCENES } from '../../src/lib/kioskGuide.ts';
import { KioskVideoWalkthrough } from '../../src/components/KioskVideoWalkthrough.tsx';
import { KioskLockGuideModal } from '../../src/components/KioskLockGuideModal.tsx';
import { KioskSetupGuideModal } from '../../src/components/KioskSetupGuideModal.tsx';
import { KioskPairing } from '../../src/components/KioskPairing.tsx';
import { KioskDevicesModal } from '../../src/components/KioskDevicesModal.tsx';

const cases = [
  [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)' }, 'ios', 'iPhone'],
  [{ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_7)' }, 'ios', 'iPhone'],
  [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X)' }, 'ios', 'iPad'],
  [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 }, 'ios', 'iPad'],
  [{ platform: 'MacIntel', maxTouchPoints: 5 }, 'ios', 'iPad'],
  [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 0 }, 'mac', 'Mac'],
  [{ userAgentDataPlatform: 'macOS' }, 'mac', 'Mac'],
  ...['SamsungBrowser/27.0', 'SM-X710', 'SAMSUNG', 'GT-P5110', 'SC-04E', 'SHV-E210', 'SGH-I747']
    .map(model => [{ userAgent: `Mozilla/5.0 (Linux; Android 14; ${model}) Chrome/131` }, 'samsung', 'Samsung']),
  ...['Silk/127.0', 'KFAPWI', 'KFTUWI', 'KFMUWI', 'KFTRWI', 'KFMAWI', 'Kindle', 'KFNEW9']
    .map(model => [{ userAgent: `Mozilla/5.0 (Linux; Android 11; ${model})` }, 'fire', 'Amazon Fire']),
  [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }, 'android', 'Android'],
  [{ userAgentDataPlatform: 'Android', userAgentDataMobile: false }, 'android', 'Android'],
  [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 15699)' }, 'chromebook', 'Chromebook'],
  [{ userAgentDataPlatform: 'Chrome OS' }, 'chromebook', 'Chromebook'],
  [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'windows', 'Windows'],
  [{ platform: 'Win32' }, 'windows', 'Windows'],
];
for (const [env, family, detectedLabel] of cases) {
  assert.deepEqual(detectKioskDevice(env), { family, detectedLabel, switcherLabel: KIOSK_LOCK_GUIDES[family].switcherLabel, detected: true });
}
for (const env of [{}, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }]) {
  assert.deepEqual(detectKioskDevice(env), { family: 'ios', detectedLabel: 'iPhone / iPad', switcherLabel: 'iPhone / iPad', detected: false });
}
assert.doesNotThrow(() => detectKioskDevice());

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};
const read = path => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const labels = ['iPhone / iPad', 'Samsung', 'Android', 'Amazon Fire', 'Windows', 'Mac', 'Chromebook'];
assert.deepEqual(KIOSK_DEVICE_ORDER, ['ios', 'samsung', 'android', 'fire', 'windows', 'mac', 'chromebook']);
assert.deepEqual(Object.keys(KIOSK_LOCK_GUIDES), KIOSK_DEVICE_ORDER);

function checkScenes(scenes, numbers) {
  assert.deepEqual(scenes.map(scene => scene.stepNumber), numbers);
  assert.equal(new Set(scenes.map(scene => scene.id)).size, numbers.length);
  for (const scene of scenes) {
    assert.ok(scene.title && scene.caption && scene.visualKey);
    assert.ok(Number.isFinite(scene.durationMs) && scene.durationMs > 0);
  }
}

function checkPlayer(html, chapterCount) {
  assert.match(html, /aria-label="Play walkthrough"/);
  assert.match(html, /aria-label="Replay walkthrough"/);
  assert.match(html, /type="range".*aria-label="Walkthrough progress"/);
  assert.match(html, new RegExp(`1 / ${chapterCount}`));
  assert.equal([...html.matchAll(/aria-label="Chapter \d+:/g)].length, chapterCount);
  assert.match(html, /aria-current="step".*bg-gold-deep text-paper/);
}

for (const [index, device] of KIOSK_DEVICE_ORDER.entries()) {
  const guide = KIOSK_LOCK_GUIDES[device];
  assert.equal(guide.family, device);
  assert.equal(guide.switcherLabel, labels[index]);
  assert.equal(guide.unlockTitle, 'How to unlock later');
  assert.ok(guide.methodName && guide.installTip && guide.hubSummary && guide.unlockText);
  assert.deepEqual(guide.steps.map(step => step.stepNumber), [1, 2, 3]);
  assert.ok(guide.steps.every(step => step.title && step.description && step.mockupKind && step.highlightLabel));
  checkScenes(guide.walkthroughScenes, [1, 2, 3]);

  const player = render(KioskVideoWalkthrough, { mode: 'device', device });
  checkPlayer(player, 3);
  assert.ok(player.includes(guide.methodName));
  assert.ok(player.includes(guide.steps[0].title));

  const lock = render(KioskLockGuideModal, { isOpen: true, onClose: noop, initialDevice: device });
  assert.match(lock, /role="dialog" aria-modal="true" aria-labelledby="kiosk-lock-guide-title"/);
  assert.match(lock, /How to unlock later/);
  assert.match(lock, /aria-label="Close"/);
  for (const step of guide.steps) {
    assert.ok(lock.includes(step.title));
    assert.ok(lock.includes(step.highlightLabel.replace('&', '&amp;')));
  }

  const setup = render(KioskSetupGuideModal, { isOpen: true, onClose: noop, onOpenLockGuide: noop, initialDevice: device });
  assert.match(setup, /role="dialog" aria-modal="true" aria-labelledby="kiosk-setup-guide-title"/);
  assert.ok(setup.includes(`Lock this device (${guide.switcherLabel})`));
  assert.match(setup, /Open visual lock &amp; unlock steps/);
}
checkScenes(KIOSK_OVERVIEW_SCENES, [1, 2, 3, 4]);
assert.deepEqual(KIOSK_OVERVIEW_SCENES.map(scene => scene.visualKey), ['install', 'pair', 'lock', 'signin']);
assert.match(KIOSK_OVERVIEW_SCENES[1].caption, /K7M4P2.*Valley Kitchen/);
assert.match(KIOSK_OVERVIEW_SCENES[3].caption, /QR.*4–6 digit PIN.*5 minutes/);
checkPlayer(render(KioskVideoWalkthrough, { mode: 'overview' }), 4);

const lockProps = { isOpen: true, onClose: noop, onDoneToKiosk: noop };
const paired = render(KioskLockGuideModal, { ...lockProps, pairedVenueName: 'Valley Kitchen' });
assert.match(paired, /Paired to Valley Kitchen/);
assert.match(paired, /Done — Go to Kiosk Screen/);
assert.match(paired, /Skip for now/);
assert.match(render(KioskLockGuideModal, { ...lockProps, pairedVenueName: null }), /Paired to this venue/);
assert.equal(render(KioskLockGuideModal, { ...lockProps, isOpen: false }), '');
assert.equal(render(KioskSetupGuideModal, { isOpen: false, onClose: noop, onOpenLockGuide: noop }), '');
assert.match(render(KioskSetupGuideModal, { isOpen: true, onClose: noop, onOpenLockGuide: noop }), /K7M4P2.*Valley Kitchen/);

const pairingProps = { onPaired: noop, onExitKiosk: noop, darkMode: false };
assert.match(render(KioskPairing, { ...pairingProps, onOpenSetupGuide: noop }), /How to set up &amp; lock this device/);
assert.doesNotMatch(render(KioskPairing, pairingProps), /How to set up/);
assert.match(read('components/KioskPairing.tsx'), /onPairedRef\.current\(storedDevice, device\.venueName \|\| null\)/);
assert.match(render(KioskDevicesModal, { isOpen: true, onClose: noop, onOpenSetupGuide: noop, currentUser: { role: 'admin' }, venues: [] }), /Kiosk setup &amp; lock guide.*Pair a tablet/);

const header = read('components/Header.tsx');
assert.ok(header.includes("const canEnterKiosk = currentUser?.role === 'admin' || currentUser?.role === 'coordinator';"));
assert.equal(header.split('{canEnterKiosk && (isTabletWidth || canManageKiosks || !!onOpenKioskGuide) && (').length - 1, 2);
assert.equal(header.split('{onOpenKioskGuide && (').length - 1, 2);
for (const menu of ['User', 'Mobile']) assert.ok(header.includes(`set${menu}MenuOpen(false); onOpenKioskGuide();`));

const app = read('App.tsx');
assert.match(app, /\[postPairPrompt, setPostPairPrompt\] = useState<\{ venueName: string \| null \} \| null>\(null\)/);
assert.equal([...app.matchAll(/setPostPairPrompt\((?!null)/g)].length, 1);
assert.match(app, /onPaired=\{\(device, venueName\) => \{\s*setKioskDeviceState\(device\);\s*setPostPairPrompt\(\{ venueName: venueName \?\? null \}\)/);
const kioskBranch = app.slice(app.indexOf('// Kiosk tablets pair once'), app.indexOf("// An agency's own address"));
assert.match(kioskBranch, /\{kioskGuideModals\}.*kioskDevice && postPairPrompt/s);
assert.match(kioskBranch, /<KioskPairing.*onOpenSetupGuide=\{openKioskSetupGuide\}/s);
assert.match(app, /const kioskGuideModals = .*<KioskSetupGuideModal.*<KioskLockGuideModal.*pairedVenueName=\{postPairPrompt\?\.venueName\}/s);
assert.match(app, /\{kioskGuideModals\}\s*<KioskDevicesModal/);
assert.match(app, /onOpenKioskGuide=\{openKioskSetupGuide\}/);
assert.match(read('components/KioskDevicesModal.tsx'), /onOpenLockGuide && \(\s*<button[^>]*onClick=\{onOpenLockGuide\}[\s\S]*?Lock guide/);

for (const path of ['lib/kioskGuide.ts', 'components/KioskVideoWalkthrough.tsx', 'components/KioskSetupGuideModal.tsx', 'components/KioskLockGuideModal.tsx']) {
  const source = read(path);
  assert.doesNotMatch(source, /Valley Vaad|Beth El|Riverside Kitchen|apiFetch|firebase|firestore/i);
}
console.log('Kiosk detection, guide data, static rendering, and App wiring checks passed');
