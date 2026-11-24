export type KioskDeviceFamily = 'ios' | 'samsung' | 'android' | 'fire' | 'windows' | 'mac' | 'chromebook';

export interface KioskDeviceEnv {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentDataPlatform?: string;
  userAgentDataMobile?: boolean;
}

export interface DetectedKioskDevice {
  family: KioskDeviceFamily;
  detectedLabel: string;
  switcherLabel: string;
  detected: boolean;
}

export const KIOSK_DEVICE_ORDER: KioskDeviceFamily[] = ['ios', 'samsung', 'android', 'fire', 'windows', 'mac', 'chromebook'];

export function detectKioskDevice(env?: KioskDeviceEnv): DetectedKioskDevice {
  if (env === undefined && typeof navigator !== 'undefined') {
    const { userAgent, platform, maxTouchPoints, userAgentData } = navigator as Navigator & {
      userAgentData?: { platform?: string; mobile?: boolean };
    };
    env = { userAgent, platform, maxTouchPoints, userAgentDataPlatform: userAgentData?.platform, userAgentDataMobile: userAgentData?.mobile };
  }
  const { userAgent = '', platform = '', maxTouchPoints = 0, userAgentDataPlatform = '' } = env ?? {};
  const signature = [userAgent, platform, userAgentDataPlatform].join(' ');
  const result = (family: KioskDeviceFamily, detectedLabel: string, detected = true): DetectedKioskDevice =>
    ({ family, detectedLabel, switcherLabel: KIOSK_LOCK_GUIDES[family].switcherLabel, detected });

  if (/Silk\/|Kindle|\bKF[A-Z0-9]{2,}\b/i.test(userAgent)) return result('fire', 'Amazon Fire');
  if (/SamsungBrowser|SAMSUNG|\b(?:SM-|GT-|SC-0|SHV-|SGH-)/i.test(userAgent)) return result('samsung', 'Samsung');
  if (/iPad/i.test(signature) || (/Macintosh|MacIntel/i.test(signature) && maxTouchPoints > 1)) return result('ios', 'iPad');
  if (/iPhone|iPod/i.test(signature)) return result('ios', 'iPhone');
  if (/\bCrOS\b|Chrome\s*OS/i.test(signature)) return result('chromebook', 'Chromebook');
  if (/Android/i.test(signature)) return result('android', 'Android');
  if (/\bWin(?:dows|32|64)?\b/i.test(signature)) return result('windows', 'Windows');
  if (/Mac/i.test(signature) && maxTouchPoints <= 1) return result('mac', 'Mac');
  return result('ios', 'iPhone / iPad', false);
}

type StepNumber = 1 | 2 | 3;
type DeviceVisual = 'settings' | 'shortcut' | 'confirm';
type OverviewVisual = 'install' | 'pair' | 'lock' | 'signin';

export interface KioskLockStep {
  stepNumber: StepNumber;
  title: string;
  description: string;
  mockupKind: DeviceVisual;
  settingsPath?: string;
  toggles?: string[];
  highlightLabel: string;
}

export interface KioskWalkthroughScene {
  id: string;
  stepNumber: StepNumber | 4;
  title: string;
  caption: string;
  durationMs: number;
  visualKey: DeviceVisual | OverviewVisual;
}

export interface KioskLockGuide {
  family: KioskDeviceFamily;
  switcherLabel: string;
  methodName: string;
  installTip: string;
  hubSummary: string;
  steps: [KioskLockStep, KioskLockStep, KioskLockStep];
  unlockTitle: 'How to unlock later';
  unlockText: string;
  walkthroughScenes: KioskWalkthroughScene[];
}

function step(stepNumber: StepNumber, mockupKind: DeviceVisual, title: string, description: string, highlightLabel: string, settingsPath?: string, toggles?: string[]): KioskLockStep {
  return { stepNumber, mockupKind, title, description, highlightLabel, settingsPath, toggles };
}

function guide(family: KioskDeviceFamily, data: Omit<KioskLockGuide, 'family' | 'unlockTitle' | 'walkthroughScenes'>): KioskLockGuide {
  return {
    family,
    ...data,
    unlockTitle: 'How to unlock later',
    walkthroughScenes: data.steps.map(({ stepNumber, title, description, mockupKind }) => ({
      id: `${family}-${stepNumber}`, stepNumber, title, caption: description, durationMs: 7000, visualKey: mockupKind,
    })),
  };
}

export const KIOSK_LOCK_GUIDES: Record<KioskDeviceFamily, KioskLockGuide> = {
  ios: guide('ios', {
    switcherLabel: 'iPhone / iPad',
    methodName: 'Guided Access',
    installTip: 'In Safari, tap Share → Add to Home Screen. Enable Open as Web App if offered, then launch Shutfey from its icon.',
    hubSummary: 'Guided Access keeps Shutfey in the foreground. Set a Guided Access passcode that only kiosk managers know.',
    steps: [
      step(1, 'settings', 'Enable Guided Access', 'In Settings, open Accessibility → Guided Access. Turn it on and set a passcode under Passcode Settings.', 'Guided Access', 'Settings → Accessibility', ['Guided Access']),
      step(2, 'shortcut', 'Open Shutfey and triple-click', 'Open the Shutfey kiosk. Triple-click the side button, or Home on devices that have one, and choose Guided Access if prompted.', 'Side / Home ×3'),
      step(3, 'confirm', 'Start Guided Access', 'Tap Start. Leave touch enabled so staff can use the kiosk.', 'Start', 'Guided Access'),
    ],
    unlockText: 'Triple-click the side or Home button, enter the Guided Access passcode, then tap End.',
  }),
  samsung: guide('samsung', {
    switcherLabel: 'Samsung',
    methodName: 'Pin app',
    installTip: 'In Chrome, open the menu and choose Install app or Add to Home screen, then launch Shutfey from its icon.',
    hubSummary: 'Samsung’s Pin app keeps Shutfey on screen. Require your screen lock to unpin it.',
    steps: [
      step(1, 'settings', 'Enable Pin app', 'In Settings, open Security and privacy → More security settings. Turn on Pin app and require your screen lock to unpin.', 'Pin app', 'Security and privacy → More security settings', ['Pin app', 'Require screen lock to unpin']),
      step(2, 'shortcut', 'Find Shutfey in Recents', 'Open Shutfey. Open Recents and tap the app icon above the Shutfey preview.', 'Recents'),
      step(3, 'confirm', 'Pin Shutfey', 'Choose Pin this app and confirm if prompted.', 'Pin this app', 'Shutfey app menu'),
    ],
    unlockText: 'With buttons, hold Recents and Back together. With gestures, swipe up and hold. Enter the device screen lock when prompted.',
  }),
  android: guide('android', {
    switcherLabel: 'Android',
    methodName: 'App pinning',
    installTip: 'In Chrome, open the menu and choose Install app or Add to Home screen, then launch Shutfey from its icon.',
    hubSummary: 'App pinning keeps Shutfey on screen. Require your device PIN, pattern, or password to unpin.',
    steps: [
      step(1, 'settings', 'Enable App pinning', 'Search Settings for App pinning (sometimes Screen pinning). Turn it on and enable the screen-lock requirement for unpinning.', 'App pinning', 'Security & privacy → More security settings', ['Use app pinning', 'Ask for PIN before unpinning']),
      step(2, 'shortcut', 'Open the app switcher', 'Open Shutfey, then swipe up and hold or tap Overview. Tap the app icon above the preview.', 'Overview / Recents'),
      step(3, 'confirm', 'Pin Shutfey', 'Choose Pin and confirm the prompt if one appears.', 'Pin', 'Shutfey app menu'),
    ],
    unlockText: 'With gestures, swipe up and hold. With three-button navigation, hold Back and Overview together. With two-button navigation, hold Back and Home. Enter your screen lock if prompted.',
  }),
  fire: guide('fire', {
    switcherLabel: 'Amazon Fire',
    methodName: 'App Pinning',
    installTip: 'In Silk, look in the menu for Add to Home Screen. If unavailable, bookmark Shutfey in Silk.',
    hubSummary: 'App Pinning holds Silk on screen on supported Fire OS versions. The browser controls may still be available.',
    steps: [
      step(1, 'settings', 'Enable App Pinning', 'In Settings, look under Security & Privacy for App Pinning. If available, turn it on and require the lock-screen PIN to unpin.', 'App Pinning', 'Settings → Security & Privacy', ['App Pinning', 'Require PIN to unpin']),
      step(2, 'shortcut', 'Find Silk in Recents', 'Open Shutfey in Silk, then tap the square Recents button to find the Silk preview.', 'Recents □'),
      step(3, 'confirm', 'Pin Silk', 'Tap the pin on the Silk preview or choose Pin this app from its menu, depending on your Fire OS version.', 'Pin this app', 'Silk app preview'),
    ],
    unlockText: 'Hold Back and Recents (the square button) together, then enter the Fire tablet’s lock-screen PIN if prompted.',
  }),
  windows: guide('windows', {
    switcherLabel: 'Windows',
    methodName: 'Assigned Access / Edge Kiosk',
    installTip: 'In Edge, choose Settings and more → Apps → Install this site as an app, if available.',
    hubSummary: 'Assigned Access can run Edge in a dedicated kiosk account on supported Windows editions. For temporary full-screen viewing, press F11 in Edge.',
    steps: [
      step(1, 'settings', 'Set up Assigned Access', 'As an administrator on a supported edition, open Settings → Accounts → Other users → Kiosk. Choose Get started to set up the kiosk account.', 'Get started', 'Accounts → Other users → Kiosk'),
      step(2, 'shortcut', 'Choose Microsoft Edge', 'Select Microsoft Edge, choose the digital sign or interactive display option, and enter your Shutfey kiosk URL.', 'Microsoft Edge', 'Choose a kiosk app'),
      step(3, 'confirm', 'Test the kiosk account', 'Sign in to the kiosk account and confirm Shutfey opens. For a temporary setup, open Shutfey in Edge and press F11.', 'F11', 'Edge full screen'),
    ],
    unlockText: 'In Assigned Access, press Ctrl+Alt+Delete and switch to an administrator account. In temporary Edge full screen, press F11 again.',
  }),
  mac: guide('mac', {
    switcherLabel: 'Mac',
    methodName: 'Full-Screen / Dedicated Account',
    installTip: 'In Safari on macOS Sonoma or later, choose File → Add to Dock and launch Shutfey from its Dock icon.',
    hubSummary: 'A dedicated standard account keeps kiosk use separate. Full screen hides browser controls but staff can still exit it.',
    steps: [
      step(1, 'settings', 'Create a dedicated account', 'In System Settings → Users & Groups, add a standard account for the kiosk, then sign in to that account.', 'Add User…', 'System Settings → Users & Groups'),
      step(2, 'shortcut', 'Open Shutfey from the Dock', 'In Safari, open Shutfey and choose File → Add to Dock if available. Open the Shutfey Dock icon, or use Safari directly.', 'Shutfey', 'Dock'),
      step(3, 'confirm', 'Enter full screen', 'Press Control+Command+F, or use the green window button, to show Shutfey full screen.', 'Ctrl+Cmd+F', 'Full Screen'),
    ],
    unlockText: 'Press Control+Command+F again or move the pointer to the top edge and use the green window button. To leave the kiosk account, choose Apple menu → Log Out.',
  }),
  chromebook: guide('chromebook', {
    switcherLabel: 'Chromebook',
    methodName: 'Full-Screen / ChromeOS Kiosk',
    installTip: 'In Chrome, use the install icon in the address bar or choose Install page as app from the menu if offered.',
    hubSummary: 'The full-screen key hides Chrome’s controls. For a locked kiosk, ask your ChromeOS administrator to configure a managed kiosk app.',
    steps: [
      step(1, 'settings', 'Open Shutfey in Chrome', 'Open Shutfey in Chrome and install it if prompted. On a managed Chromebook, ask your administrator to deploy Shutfey as a kiosk web app.', 'Shutfey', 'Chrome'),
      step(2, 'shortcut', 'Press the full-screen key', 'Press the full-screen key in the top row (usually in the F4 position). It has a rectangle or corner-bracket icon.', 'F4 · Full screen', 'Chrome window'),
      step(3, 'confirm', 'Check the kiosk screen', 'Confirm staff can reach QR and PIN sign-in. On a managed ChromeOS kiosk, launch the deployed app from the sign-in screen if it does not launch automatically.', 'Staff sign-in', 'Shutfey'),
    ],
    unlockText: 'Press the full-screen key again. On a managed kiosk, follow your ChromeOS administrator’s exit procedure. If auto-launch is enabled, Ctrl+Alt+S during startup can interrupt it when allowed.',
  }),
};

export const KIOSK_OVERVIEW_SCENES: KioskWalkthroughScene[] = [
  { id: 'install', stepNumber: 1, title: 'Install Shutfey full-screen', caption: 'Launch Shutfey from its installed icon to hide browser tabs and the address bar.', durationMs: 5200, visualKey: 'install' },
  { id: 'pair', stepNumber: 2, title: 'Enter kiosk mode & pair to a venue', caption: 'On another device, open Kiosk tablets, enter K7M4P2, and choose Valley Kitchen.', durationMs: 5800, visualKey: 'pair' },
  { id: 'lock', stepNumber: 3, title: 'Lock this device', caption: 'Follow the lock guide for your device so staff stay inside Shutfey.', durationMs: 5200, visualKey: 'lock' },
  { id: 'signin', stepNumber: 4, title: 'Staff sign-in', caption: 'Scan the QR code or enter a 4–6 digit PIN. Shutfey signs staff out after 5 minutes of inactivity.', durationMs: 6000, visualKey: 'signin' },
];
