// FILE: tests/client/test-kiosk-guide.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  detectKioskDevice,
  KIOSK_DEVICE_ORDER,
  KIOSK_LOCK_GUIDES,
  KIOSK_OVERVIEW_SCENES,
  KIOSK_SCENE_MS,
} from '../../src/lib/kioskGuide.ts';

import {
  KioskVideoWalkthrough,
  KioskDeviceMockup,
  KioskOverviewMockup,
  resolveDemoTime,
  getDemoPointerFrame,
  getDemoPairingCode,
  getDemoPinCount,
} from '../../src/components/KioskVideoWalkthrough.tsx';

import {
  KioskLockGuideModal,
} from '../../src/components/KioskLockGuideModal.tsx';

import {
  KioskSetupGuideModal,
} from '../../src/components/KioskSetupGuideModal.tsx';

import {
  KioskPairing,
} from '../../src/components/KioskPairing.tsx';

import {
  KioskDevicesModal,
} from '../../src/components/KioskDevicesModal.tsx';

/* ------------------------------------------------------------
   Device detection
   ------------------------------------------------------------ */

const cases = [
  [
    {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
    },
    'ios',
    'iPhone',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_7)',
    },
    'ios',
    'iPhone',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X)',
    },
    'ios',
    'iPad',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
      maxTouchPoints: 5,
    },
    'ios',
    'iPad',
  ],
  [
    { platform: 'MacIntel', maxTouchPoints: 5 },
    'ios',
    'iPad',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
      maxTouchPoints: 0,
    },
    'mac',
    'Mac',
  ],
  [
    { userAgentDataPlatform: 'macOS' },
    'mac',
    'Mac',
  ],

  ...[
    'SamsungBrowser/27.0 SM-X710',
    'SM-X710',
    'SAMSUNG',
    'GT-P5110',
    'SC-04E',
    'SHV-E210',
    'SGH-I747',
  ].map(model => [
    {
      userAgent:
        `Mozilla/5.0 (Linux; Android 14; ${model}) Chrome/131`,
    },
    'samsung',
    'Samsung',
  ]),

  ...[
    'Silk/127.0',
    'KFAPWI',
    'KFTUWI',
    'KFMUWI',
    'KFTRWI',
    'KFMAWI',
    'Kindle',
    'KFNEW9',
  ].map(model => [
    {
      userAgent:
        `Mozilla/5.0 (Linux; Android 11; ${model})`,
    },
    'fire',
    'Amazon Fire',
  ]),

  [
    {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    },
    'android',
    'Android',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) SamsungBrowser/27.0',
    },
    'android',
    'Android',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
      userAgentDataPlatform: 'Android',
    },
    'android',
    'Android',
  ],
  [
    {
      userAgentDataPlatform: 'Android',
      userAgentDataMobile: false,
    },
    'android',
    'Android',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (X11; CrOS x86_64 15699)',
    },
    'chromebook',
    'Chromebook',
  ],
  [
    { userAgentDataPlatform: 'Chrome OS' },
    'chromebook',
    'Chromebook',
  ],
  [
    {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    'windows',
    'Windows',
  ],
  [
    { platform: 'Win32' },
    'windows',
    'Windows',
  ],
];

for (const [env, family, detectedLabel] of cases) {
  assert.deepEqual(detectKioskDevice(env), {
    family,
    detectedLabel,
    switcherLabel:
      KIOSK_LOCK_GUIDES[family].switcherLabel,
    detected: true,
  });
}

for (const env of [
  {},
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
  },
]) {
  assert.deepEqual(detectKioskDevice(env), {
    family: 'ios',
    detectedLabel: 'iPhone / iPad',
    switcherLabel: 'iPhone / iPad',
    detected: false,
  });
}

assert.doesNotThrow(() => detectKioskDevice());

/* ------------------------------------------------------------
   Helpers and guide structure
   ------------------------------------------------------------ */

const render = (component, props) =>
  renderToStaticMarkup(
    createElement(component, props),
  );

const noop = () => {};

const read = path =>
  readFileSync(
    new URL(`../../src/${path}`, import.meta.url),
    'utf8',
  );

const labels = [
  'iPhone / iPad',
  'Samsung',
  'Android',
  'Amazon Fire',
  'Windows',
  'Mac',
  'Chromebook',
];

assert.deepEqual(KIOSK_DEVICE_ORDER, [
  'ios',
  'samsung',
  'android',
  'fire',
  'windows',
  'mac',
  'chromebook',
]);

assert.deepEqual(
  Object.keys(KIOSK_LOCK_GUIDES),
  KIOSK_DEVICE_ORDER,
);

assert.equal(KIOSK_SCENE_MS, 7000);

function checkScenes(scenes, numbers) {
  assert.deepEqual(
    scenes.map(scene => scene.stepNumber),
    numbers,
  );

  assert.equal(
    new Set(scenes.map(scene => scene.id)).size,
    numbers.length,
  );

  for (const scene of scenes) {
    assert.ok(
      scene.title &&
      scene.caption &&
      scene.visualKey,
    );

    assert.ok(
      Number.isFinite(scene.durationMs) &&
      scene.durationMs >= 6500 &&
      scene.durationMs <= 7500,
    );

    assert.equal(
      scene.durationMs,
      KIOSK_SCENE_MS,
    );
  }
}

function checkPlayer(html, chapterCount) {
  assert.match(
    html,
    /aria-label="Play walkthrough"/,
  );

  assert.match(
    html,
    /aria-label="Replay walkthrough"/,
  );

  assert.match(
    html,
    /type="range".*aria-label="Walkthrough progress"/,
  );

  assert.match(
    html,
    new RegExp(`1 / ${chapterCount}`),
  );

  assert.equal(
    [...html.matchAll(/aria-label="Chapter \d+:/g)]
      .length,
    chapterCount,
  );

  assert.match(
    html,
    /aria-current="step".*bg-gold-deep text-paper/,
  );

  assert.match(
    html,
    /min-h-11 min-w-11/,
  );

  assert.match(
    html,
    /kiosk-demo-stage/,
  );

  assert.match(
    html,
    /data-walkthrough-playing="false"/,
  );
}

/* ------------------------------------------------------------
   Pure timeline behavior
   ------------------------------------------------------------ */

// Static mockups and the initial paused frame are complete.
assert.equal(
  resolveDemoTime(undefined),
  KIOSK_SCENE_MS,
);

assert.equal(
  resolveDemoTime(0, false, false),
  KIOSK_SCENE_MS,
);

// Starting playback shows the first beat.
assert.equal(
  resolveDemoTime(0, true, false),
  0,
);

// Pause does not advance the current time.
assert.equal(
  resolveDemoTime(2350, false, false),
  2350,
);

assert.equal(
  resolveDemoTime(2350, true, false),
  2350,
);

// Reduced motion shows the completed illustration.
for (const time of [0, 800, 3500, 6999, 7000]) {
  assert.equal(
    resolveDemoTime(time, false, true),
    KIOSK_SCENE_MS,
  );

  assert.equal(
    resolveDemoTime(time, true, true),
    KIOSK_SCENE_MS,
  );
}

assert.equal(
  resolveDemoTime(-100, true),
  0,
);

assert.equal(
  resolveDemoTime(99999, true),
  KIOSK_SCENE_MS,
);

const sampleBeats = [
  { target: 'first', at: 1500 },
  { target: 'second', at: 3500 },
];

// No premature pointer.
assert.equal(
  getDemoPointerFrame(0, sampleBeats),
  null,
);

// The pointer reaches the target at the specified tap time.
const firstTap =
  getDemoPointerFrame(1500, sampleBeats);

assert.equal(firstTap.target, 'first');
assert.equal(firstTap.travel, 1);

const travelling =
  getDemoPointerFrame(3200, sampleBeats);

assert.equal(travelling.target, 'second');
assert.equal(travelling.previousTarget, 'first');

assert.ok(
  travelling.travel > 0 &&
  travelling.travel < 1,
);

// Gold ring expands during the tap interval.
const midTap =
  getDemoPointerFrame(3750, sampleBeats);

assert.equal(midTap.target, 'second');

assert.ok(
  midTap.tap > 0 &&
  midTap.tap < 1,
);

// Completed scenes hide the pointer.
assert.equal(
  getDemoPointerFrame(
    KIOSK_SCENE_MS,
    sampleBeats,
  ),
  null,
);

assert.equal(
  getDemoPointerFrame(2000, []),
  null,
);

// Seeking backward is deterministic.
const beforeSeek =
  getDemoPointerFrame(3200, sampleBeats);

getDemoPointerFrame(3750, sampleBeats);

const afterSeek =
  getDemoPointerFrame(3200, sampleBeats);

assert.deepEqual(beforeSeek, afterSeek);

/* ------------------------------------------------------------
   Pairing-code and PIN progression
   ------------------------------------------------------------ */

assert.equal(getDemoPairingCode(0), '');
assert.equal(getDemoPairingCode(1449), '');
assert.equal(getDemoPairingCode(1450), 'K');
assert.equal(getDemoPairingCode(1880), 'K7');
assert.equal(getDemoPairingCode(2310), 'K7M');
assert.equal(getDemoPairingCode(2740), 'K7M4');
assert.equal(getDemoPairingCode(3170), 'K7M4P');
assert.equal(getDemoPairingCode(3600), 'K7M4P2');
assert.equal(getDemoPairingCode(7000), 'K7M4P2');

// Backward scrubbing removes characters.
assert.equal(getDemoPairingCode(1880), 'K7');

assert.equal(getDemoPinCount(0), 0);
assert.equal(getDemoPinCount(3299), 0);
assert.equal(getDemoPinCount(3300), 1);
assert.equal(getDemoPinCount(3760), 2);
assert.equal(getDemoPinCount(4220), 3);
assert.equal(getDemoPinCount(4680), 4);
assert.equal(getDemoPinCount(7000), 4);

// Backward scrubbing removes PIN dots.
assert.equal(getDemoPinCount(3300), 1);

/* ------------------------------------------------------------
   All seven device families
   ------------------------------------------------------------ */

for (const [index, device]
  of KIOSK_DEVICE_ORDER.entries()) {
  const guide = KIOSK_LOCK_GUIDES[device];

  assert.equal(guide.family, device);

  assert.equal(
    guide.switcherLabel,
    labels[index],
  );

  assert.equal(
    guide.unlockTitle,
    'How to unlock later',
  );

  assert.ok(
    guide.methodName &&
    guide.installTip &&
    guide.hubSummary &&
    guide.unlockText,
  );

  assert.deepEqual(
    guide.steps.map(step => step.stepNumber),
    [1, 2, 3],
  );

  assert.ok(
    guide.steps.every(step =>
      step.title &&
      step.description &&
      step.mockupKind &&
      step.highlightLabel,
    ),
  );

  checkScenes(
    guide.walkthroughScenes,
    [1, 2, 3],
  );

  const player = render(
    KioskVideoWalkthrough,
    { mode: 'device', device },
  );

  checkPlayer(player, 3);

  assert.ok(
    player.includes(guide.methodName),
  );

  assert.ok(
    player.includes(guide.steps[0].title),
  );

  const laptop = [
    'windows',
    'mac',
    'chromebook',
  ].includes(device);

  for (const step of guide.steps) {
    const completed = render(
      KioskDeviceMockup,
      { device, step },
    );

    assert.match(
      completed,
      /kiosk-demo-stage/,
    );

    assert.match(
      completed,
      /kiosk-demo-finger/,
    );

    assert.match(
      completed,
      /data-walkthrough-playing="false"/,
    );

    assert.match(
      completed,
      laptop
        ? /kiosk-demo-laptop-bezel/
        : /kiosk-demo-handheld-screen/,
    );

    if (laptop) {
      assert.match(
        completed,
        /kiosk-demo-finger is-cursor/,
      );

      assert.match(
        completed,
        /kiosk-demo-laptop-base/,
      );
    }

    for (const time of [
      0,
      1200,
      2400,
      3500,
      4800,
      6200,
      7000,
    ]) {
      const animated = render(
        KioskDeviceMockup,
        {
          device,
          step,
          sceneElapsedMs: time,
          isPlaying: true,
        },
      );

      assert.match(
        animated,
        /data-walkthrough-playing="true"/,
      );

      assert.doesNotMatch(
        animated,
        /NaN|Infinity|undefinedpx/,
      );
    }

    const reduced = render(
      KioskDeviceMockup,
      {
        device,
        step,
        sceneElapsedMs: 1000,
        isPlaying: false,
        reducedMotion: true,
      },
    );

    assert.equal(
      reduced,
      completed,
      `${device} step ${step.stepNumber}: reduced-motion frame must equal the completed static frame`,
    );
  }

  const lock = render(
    KioskLockGuideModal,
    {
      isOpen: true,
      onClose: noop,
      initialDevice: device,
    },
  );

  assert.match(
    lock,
    /role="dialog" aria-modal="true" aria-labelledby="kiosk-lock-guide-title"/,
  );

  assert.match(
    lock,
    /How to unlock later/,
  );

  assert.match(
    lock,
    /aria-label="Close"/,
  );

  assert.match(
    lock,
    /Full screen alone is not a security lock/,
  );

  for (const step of guide.steps) {
    assert.ok(
      lock.includes(step.title),
    );

    assert.ok(
      lock.includes(
        step.highlightLabel.replace('&', '&amp;'),
      ),
    );
  }

  const setup = render(
    KioskSetupGuideModal,
    {
      isOpen: true,
      onClose: noop,
      onOpenLockGuide: noop,
      initialDevice: device,
    },
  );

  assert.match(
    setup,
    /role="dialog" aria-modal="true" aria-labelledby="kiosk-setup-guide-title"/,
  );

  assert.ok(
    setup.includes(
      `Lock this device (${guide.switcherLabel})`,
    ),
  );

  assert.match(
    setup,
    /Open visual lock &amp; unlock steps/,
  );
}

/* ------------------------------------------------------------
   Specific choreography assertions
   ------------------------------------------------------------ */

function renderStep(device, number, time, playing = true) {
  return render(KioskDeviceMockup, {
    device,
    step: KIOSK_LOCK_GUIDES[device].steps[number - 1],
    sceneElapsedMs: time,
    isPlaying: playing,
  });
}

function toggleCount(html, on) {
  const matches = html.matchAll(
    new RegExp(
      `class="kiosk-demo-toggle" data-on="${on}"`,
      'g',
    ),
  );

  return [...matches].length;
}

// Guided Access physically starts OFF.
assert.equal(
  toggleCount(renderStep('ios', 1, 0), false),
  1,
);

assert.equal(
  toggleCount(renderStep('ios', 1, 2000), true),
  1,
);

const iosComplete =
  renderStep('ios', 1, 7000, false);

assert.match(
  iosComplete,
  /PIN set/,
);

assert.equal(
  toggleCount(iosComplete, true),
  1,
);

// Samsung, Android and Fire require both switches.
for (const device of [
  'samsung',
  'android',
  'fire',
]) {
  assert.equal(
    toggleCount(
      renderStep(device, 1, 0),
      false,
    ),
    2,
  );

  assert.equal(
    toggleCount(
      renderStep(device, 1, 2500),
      true,
    ),
    1,
  );

  assert.equal(
    toggleCount(
      renderStep(device, 1, 7000, false),
      true,
    ),
    2,
  );

  const recents =
    renderStep(device, 2, 3000);

  assert.match(
    recents,
    /data-demo-target="recents"/,
  );

  assert.match(
    recents,
    /kiosk-demo-recent-card/,
  );

  const pin =
    renderStep(device, 3, 7000, false);

  assert.match(
    pin,
    /data-demo-target="pin-action"/,
  );

  assert.match(
    pin,
    /pinned|Pinned/,
  );
}

// iOS hardware button: three sequential presses.
const hardwareBeats = [
  { target: 'hardware', at: 1100 },
  { target: 'hardware', at: 1690 },
  { target: 'hardware', at: 2280 },
  { target: 'guided-start', at: 4750 },
];

for (const time of [1150, 1740, 2330]) {
  const frame =
    getDemoPointerFrame(time, hardwareBeats);

  assert.equal(frame.target, 'hardware');
  assert.ok(frame.tap > 0);
}

const iosHardware =
  renderStep('ios', 3, 7000, false);

assert.match(
  iosHardware,
  /data-demo-target="hardware"/,
);

assert.match(
  iosHardware,
  /×3/,
);

assert.match(
  iosHardware,
  /Guided Access Started/,
);

// Desktop-specific sequences.
assert.match(
  renderStep('windows', 1, 7000),
  /Wizard opened/,
);

assert.match(
  renderStep('windows', 2, 7000),
  /Microsoft Edge/,
);

assert.match(
  renderStep('windows', 3, 7000),
  /Assigned Access active/,
);

assert.match(
  renderStep('mac', 1, 7000),
  /Added to Dock/,
);

assert.match(
  renderStep('mac', 2, 7000),
  /Full screen only/,
);

assert.match(
  renderStep('mac', 3, 7000),
  /Not a locked kiosk/,
);

assert.match(
  renderStep('chromebook', 1, 7000),
  /data-checked="true"/,
);

assert.match(
  renderStep('chromebook', 2, 7000),
  /Full screen only/,
);

assert.match(
  renderStep('chromebook', 3, 7000),
  /Managed kiosk required/,
);

/* ------------------------------------------------------------
   Four overview scenes
   ------------------------------------------------------------ */

checkScenes(
  KIOSK_OVERVIEW_SCENES,
  [1, 2, 3, 4],
);

assert.deepEqual(
  KIOSK_OVERVIEW_SCENES.map(
    scene => scene.visualKey,
  ),
  ['install', 'pair', 'lock', 'signin'],
);

assert.match(
  KIOSK_OVERVIEW_SCENES[1].caption,
  /K7M4P2.*Valley Kitchen/,
);

assert.match(
  KIOSK_OVERVIEW_SCENES[2].caption,
  /Full screen alone is not a security lock/,
);

assert.match(
  KIOSK_OVERVIEW_SCENES[3].caption,
  /QR.*4–6 digit PIN.*5 minutes/,
);

checkPlayer(
  render(KioskVideoWalkthrough, {
    mode: 'overview',
  }),
  4,
);

for (const scene of KIOSK_OVERVIEW_SCENES) {
  const visual = scene.visualKey;

  const completed = render(
    KioskOverviewMockup,
    { visual },
  );

  assert.match(
    completed,
    /kiosk-demo-handheld-screen/,
  );

  assert.match(
    completed,
    /data-walkthrough-playing="false"/,
  );

  const reduced = render(
    KioskOverviewMockup,
    {
      visual,
      sceneElapsedMs: 2200,
      reducedMotion: true,
    },
  );

  assert.equal(
    reduced,
    completed,
    `${visual}: reduced motion must show the completed frame`,
  );

  for (const time of [
    0,
    1200,
    2400,
    3600,
    4800,
    6000,
    7000,
  ]) {
    const animated = render(
      KioskOverviewMockup,
      {
        visual,
        sceneElapsedMs: time,
        isPlaying: true,
      },
    );

    assert.doesNotMatch(
      animated,
      /NaN|Infinity|undefinedpx/,
    );
  }
}

const overviewInstall = render(
  KioskOverviewMockup,
  { visual: 'install' },
);

assert.match(
  overviewInstall,
  /Full-screen app opened/,
);

const overviewPair = render(
  KioskOverviewMockup,
  { visual: 'pair' },
);

assert.match(
  overviewPair,
  /kiosk-demo-duo/,
);

assert.match(
  overviewPair,
  /K7M4P2/,
);

assert.match(
  overviewPair,
  /Valley Kitchen/,
);

assert.match(
  overviewPair,
  /Paired/,
);

const overviewLock = render(
  KioskOverviewMockup,
  { visual: 'lock' },
);

assert.match(
  overviewLock,
  /Full screen alone is not a security lock/,
);

const overviewSignIn = render(
  KioskOverviewMockup,
  { visual: 'signin' },
);

assert.match(
  overviewSignIn,
  /Eli signed in/,
);

assert.match(
  overviewSignIn,
  /Auto sign-out after 5 min idle/,
);

assert.equal(
  [
    ...overviewSignIn.matchAll(
      /data-filled="true"/g,
    ),
  ].length,
  4,
);

/* ------------------------------------------------------------
   Existing post-pairing modal guarantees
   ------------------------------------------------------------ */

const lockProps = {
  isOpen: true,
  onClose: noop,
  onDoneToKiosk: noop,
};

const paired = render(
  KioskLockGuideModal,
  {
    ...lockProps,
    pairedVenueName: 'Valley Kitchen',
  },
);

assert.match(
  paired,
  /Paired to Valley Kitchen/,
);

assert.match(
  paired,
  /Done — Go to Kiosk Screen/,
);

assert.match(
  paired,
  /Skip for now/,
);

assert.match(
  render(KioskLockGuideModal, {
    ...lockProps,
    pairedVenueName: null,
  }),
  /Paired to this venue/,
);

assert.equal(
  render(KioskLockGuideModal, {
    ...lockProps,
    isOpen: false,
  }),
  '',
);

assert.equal(
  render(KioskSetupGuideModal, {
    isOpen: false,
    onClose: noop,
    onOpenLockGuide: noop,
  }),
  '',
);

assert.match(
  render(KioskSetupGuideModal, {
    isOpen: true,
    onClose: noop,
    onOpenLockGuide: noop,
  }),
  /K7M4P2.*Valley Kitchen/,
);

/* ------------------------------------------------------------
   Existing pairing and device-management entry points
   ------------------------------------------------------------ */

const pairingProps = {
  onPaired: noop,
  onExitKiosk: noop,
  darkMode: false,
};

assert.match(
  render(KioskPairing, {
    ...pairingProps,
    onOpenSetupGuide: noop,
  }),
  /How to set up &amp; lock this device/,
);

assert.doesNotMatch(
  render(KioskPairing, pairingProps),
  /How to set up/,
);

assert.match(
  read('components/KioskPairing.tsx'),
  /onPairedRef\.current\(storedDevice, device\.venueName \|\| null\)/,
);

assert.match(
  render(KioskDevicesModal, {
    isOpen: true,
    onClose: noop,
    onOpenSetupGuide: noop,
    currentUser: { role: 'admin' },
    venues: [],
  }),
  /Kiosk setup &amp; lock guide.*Pair a tablet/,
);

/* ------------------------------------------------------------
   Existing Header role and width restrictions
   ------------------------------------------------------------ */

const header = read('components/Header.tsx');

assert.ok(
  header.includes(
    "const canEnterKiosk = currentUser?.role === 'admin' || currentUser?.role === 'coordinator';",
  ),
);

assert.equal(
  header.split(
    '{canEnterKiosk && (isTabletWidth || canManageKiosks || !!onOpenKioskGuide) && (',
  ).length - 1,
  2,
);

assert.equal(
  header.split(
    '{onOpenKioskGuide && (',
  ).length - 1,
  2,
);

for (const menu of ['User', 'Mobile']) {
  assert.ok(
    header.includes(
      `set${menu}MenuOpen(false); onOpenKioskGuide();`,
    ),
  );
}

/* ------------------------------------------------------------
   Existing App wiring and one-shot pairing prompt
   ------------------------------------------------------------ */

const app = read('App.tsx');

assert.match(
  app,
  /\[postPairPrompt, setPostPairPrompt\] = useState<\{ venueName: string \| null \} \| null>\(null\)/,
);

assert.equal(
  [...app.matchAll(/setPostPairPrompt\((?!null)/g)]
    .length,
  1,
);

assert.match(
  app,
  /onPaired=\{\(device, venueName\) => \{\s*setKioskDeviceState\(device\);\s*setPostPairPrompt\(\{ venueName: venueName \?\? null \}\)/,
);

const kioskBranch = app.slice(
  app.indexOf('// Kiosk tablets pair once'),
  app.indexOf("// An agency's own address"),
);

assert.match(
  kioskBranch,
  /\{kioskGuideModals\}.*kioskDevice && postPairPrompt/s,
);

assert.match(
  kioskBranch,
  /<KioskPairing.*onOpenSetupGuide=\{openKioskSetupGuide\}/s,
);

assert.match(
  app,
  /const kioskGuideModals = .*<KioskSetupGuideModal.*<KioskLockGuideModal.*pairedVenueName=\{postPairPrompt\?\.venueName\}/s,
);

assert.match(
  app,
  /\{kioskGuideModals\}\s*<KioskDevicesModal/,
);

assert.match(
  app,
  /onOpenKioskGuide=\{openKioskSetupGuide\}/,
);

assert.match(
  read('components/KioskDevicesModal.tsx'),
  /onOpenLockGuide && \(\s*<button[^>]*onClick=\{onOpenLockGuide\}[\s\S]*?Lock guide/,
);

/* ------------------------------------------------------------
   Round 2 dialog accessibility guarantees
   ------------------------------------------------------------ */

const dialog = read(
  'components/KioskLockGuideModal.tsx',
);

assert.match(
  dialog,
  /onCloseRef\.current = onClose/,
);

assert.match(
  dialog,
  /onCloseRef\.current\(\)/,
);

assert.match(
  dialog,
  /document\.addEventListener\('keydown', onKeyDown, true\)/,
);

assert.match(
  dialog,
  /document\.removeEventListener\('keydown', onKeyDown, true\)/,
);

assert.match(
  dialog,
  /document\.addEventListener\('focusin', onFocusIn\)/,
);

assert.match(
  dialog,
  /document\.removeEventListener\('focusin', onFocusIn\)/,
);

/* ------------------------------------------------------------
   Zero backend access and no real venue data
   ------------------------------------------------------------ */

for (const path of [
  'lib/kioskGuide.ts',
  'components/KioskVideoWalkthrough.tsx',
  'components/KioskSetupGuideModal.tsx',
  'components/KioskLockGuideModal.tsx',
]) {
  const source = read(path);

  assert.doesNotMatch(
    source,
    /Adler|Valley Vaad|Beth El|Riverside Kitchen|apiFetch|firebase|firestore/i,
  );

  assert.doesNotMatch(
    source,
    /https?:\/\//i,
  );
}

/* ------------------------------------------------------------
   Walkthrough engineering and design guardrails
   ------------------------------------------------------------ */

const playerSource = read(
  'components/KioskVideoWalkthrough.tsx',
);

assert.match(
  playerSource,
  /useLayoutEffect/,
);

assert.match(
  playerSource,
  /getBoundingClientRect\(\)/,
);

assert.match(
  playerSource,
  /ResizeObserver/,
);

assert.match(
  playerSource,
  /observer\?\.disconnect\(\)/,
);

assert.match(
  playerSource,
  /requestAnimationFrame/,
);

assert.match(
  playerSource,
  /cancelAnimationFrame/,
);

assert.match(
  playerSource,
  /prefers-reduced-motion: reduce/,
);

assert.match(
  playerSource,
  /--fx/,
);

assert.match(
  playerSource,
  /--fy/,
);

assert.doesNotMatch(
  playerSource,
  /import\s+['"][^'"]+\.css['"]/,
);

assert.doesNotMatch(
  playerSource,
  /\b(?:bg|text|border|ring)-(?:emerald|green|blue|red|gray|grey|slate|amber|zinc|neutral|stone|white|black)(?:-\d+)?\b/,
);

assert.doesNotMatch(
  playerSource,
  /#[0-9a-f]{3,8}\b/i,
);

assert.doesNotMatch(
  playerSource,
  /text-\[(?:[0-9]|1[01])px\]/,
);

assert.doesNotMatch(
  playerSource,
  /duration-\[/,
);

const css = read('index.css');

const marker =
  '/* FILE: src/index.css (replace lines 931-end) */';

const alternativeMarker =
  'Kiosk walkthrough\n   Homepage-inspired hardware';

const start = css.includes(marker)
  ? css.indexOf(marker)
  : css.indexOf(alternativeMarker);

assert.ok(
  start >= 0,
  'Upgraded kiosk walkthrough CSS section missing',
);

const demoCss = css.slice(start);

assert.match(
  demoCss,
  /\.kiosk-demo-handheld/,
);

assert.match(
  demoCss,
  /\.kiosk-demo-laptop-bezel/,
);

assert.match(
  demoCss,
  /\.kiosk-demo-laptop-base/,
);

assert.match(
  demoCss,
  /\.kiosk-demo-finger\.is-cursor/,
);

assert.match(
  demoCss,
  /\.kiosk-demo-toggle-thumb/,
);

assert.match(
  demoCss,
  /@media \(prefers-reduced-motion: no-preference\)/,
);

assert.match(
  demoCss,
  /@media \(prefers-reduced-motion: reduce\)/,
);

assert.match(
  demoCss,
  /\[data-walkthrough-playing="true"\]/,
);

assert.doesNotMatch(
  demoCss,
  /\banimation\s*:[^;]*infinite/,
);

// The new timeline does not use independent CSS animation clocks.
assert.doesNotMatch(
  demoCss,
  /@keyframes\s+kiosk-/,
);

console.log(
  'Kiosk device detection, all 25 walkthrough scenes, ' +
  'deterministic timeline, static rendering, reduced motion, ' +
  'dialog guarantees and App wiring checks passed',
);
