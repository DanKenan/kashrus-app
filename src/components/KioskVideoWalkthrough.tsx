// FILE: src/components/KioskVideoWalkthrough.tsx
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import {
  AppWindow,
  Check,
  Download,
  Lock,
  Maximize,
  Pause,
  Play,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Wifi,
} from 'lucide-react';

import {
  KIOSK_LOCK_GUIDES,
  KIOSK_OVERVIEW_SCENES,
  KIOSK_SCENE_MS,
  type KioskDeviceFamily,
  type KioskLockStep,
  type KioskWalkthroughScene,
} from '../lib/kioskGuide';

interface WalkthroughProps {
  mode: 'device' | 'overview';
  device?: KioskDeviceFamily;
  onStepChange?: (stepIndex: number) => void;
}

interface DemoTimelineProps {
  sceneElapsedMs?: number;
  isPlaying?: boolean;
  reducedMotion?: boolean;
}

export interface DemoBeat {
  target: string;
  at: number;
}

interface Point {
  x: number;
  y: number;
}

interface PointerFrame {
  target: string;
  previousTarget: string | null;
  travel: number;
  tap: number;
  visible: boolean;
}

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const GLIDE_MS = 650;
const TAP_MS = 520;

const useBrowserLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

const clamp = (value: number) =>
  Math.min(1, Math.max(0, value));

const ease = (value: number) =>
  1 - Math.pow(1 - clamp(value), 3);

function ramp(
  elapsed: number,
  start: number,
  length = 420,
): number {
  return ease((elapsed - start) / length);
}

function cssVars(
  values: Record<string, string | number>,
): CSSProperties {
  return values as CSSProperties;
}

/**
 * The only source of truth for illustration state.
 *
 * Standalone step cards, reduced-motion playback and the initial
 * paused frame display a clean, completed illustration.
 *
 * Pausing at a nonzero time preserves the exact current state.
 */
export function resolveDemoTime(
  elapsed: number | undefined,
  isPlaying = false,
  reducedMotion = false,
): number {
  if (
    elapsed === undefined ||
    reducedMotion ||
    (!isPlaying && elapsed === 0)
  ) {
    return KIOSK_SCENE_MS;
  }

  return Math.max(0, Math.min(KIOSK_SCENE_MS, elapsed));
}

/**
 * Pointer movement is deterministic and independent of wall time.
 * A backwards seek produces exactly the same pointer position
 * as forward playback at that timestamp.
 */
export function getDemoPointerFrame(
  elapsed: number,
  beats: readonly DemoBeat[],
): PointerFrame | null {
  if (!beats.length || elapsed >= KIOSK_SCENE_MS) {
    return null;
  }

  const tapLength = (index: number): number => {
    const beat = beats[index];
    const next = beats[index + 1];

    if (!next) return TAP_MS;

    const gap = Math.max(1, next.at - beat.at);

    return Math.min(TAP_MS, gap * 0.45);
  };

  const index = beats.findIndex(
    (beat, i) => elapsed < beat.at + tapLength(i),
  );

  if (index < 0) return null;

  const beat = beats[index];

  const previous =
    index > 0 ? beats[index - 1] : null;

  const previousEnd = previous
    ? previous.at + tapLength(index - 1)
    : 0;

  const glideStart = Math.max(
    previousEnd,
    beat.at - GLIDE_MS,
  );

  if (elapsed < glideStart) {
    if (!previous) return null;

    return {
      target: previous.target,
      previousTarget: previous.target,
      travel: 1,
      tap: 0,
      visible: true,
    };
  }

  const travelLength = Math.max(
    1,
    beat.at - glideStart,
  );

  return {
    target: beat.target,
    previousTarget: previous?.target ?? null,
    travel: ease(
      (elapsed - glideStart) / travelLength,
    ),
    tap: elapsed >= beat.at
      ? clamp((elapsed - beat.at) / tapLength(index))
      : 0,
    visible: true,
  };
}

function DemoStage({
  beats,
  time,
  cursor = false,
  hidePointer = false,
  children,
}: {
  beats: readonly DemoBeat[];
  time: number;
  cursor?: boolean;
  hidePointer?: boolean;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);

  const latest = useRef({
    beats,
    time,
    hidePointer,
  });

  latest.current = { beats, time, hidePointer };

  const measureRef = useRef<() => void>(() => {});

  measureRef.current = () => {
    const root = stage.current;
    const finger = pointer.current;

    if (!root || !finger) return;

    const {
      beats: currentBeats,
      time: currentTime,
      hidePointer: hidden,
    } = latest.current;

    const frame = hidden
      ? null
      : getDemoPointerFrame(currentTime, currentBeats);

    if (!frame || !frame.visible) {
      finger.style.setProperty('--finger-visible', '0');
      return;
    }

    const stageRect = root.getBoundingClientRect();

    const targets = new Map<string, Point>();

    root.querySelectorAll<HTMLElement>(
      '[data-demo-target]',
    ).forEach(element => {
      const name = element.dataset.demoTarget;
      if (!name) return;

      const rect = element.getBoundingClientRect();

      targets.set(name, {
        x: rect.left - stageRect.left + rect.width / 2,
        y: rect.top - stageRect.top + rect.height / 2,
      });
    });

    const destination = targets.get(frame.target);

    if (!destination) {
      finger.style.setProperty('--finger-visible', '0');
      return;
    }

    const origin =
      (frame.previousTarget
        ? targets.get(frame.previousTarget)
        : undefined) ??
      {
        x: stageRect.width * 0.84,
        y: stageRect.height * 0.88,
      };

    const x =
      origin.x + (destination.x - origin.x) * frame.travel;

    const y =
      origin.y + (destination.y - origin.y) * frame.travel;

    const ringOpacity =
      frame.tap > 0 && frame.tap < 1
        ? 1 - frame.tap
        : 0;

    const press =
      frame.tap > 0 && frame.tap < 0.24
        ? 0.88
        : 1;

    finger.style.setProperty('--fx', `${x}px`);
    finger.style.setProperty('--fy', `${y}px`);
    finger.style.setProperty('--finger-visible', '1');
    finger.style.setProperty('--finger-press', String(press));
    finger.style.setProperty(
      '--ring-scale',
      String(0.65 + frame.tap * 1.6),
    );
    finger.style.setProperty(
      '--ring-opacity',
      String(ringOpacity),
    );
  };

  // Re-measure immediately after every timeline render.
  // This also handles targets that move during OS transitions.
  useBrowserLayoutEffect(() => {
    measureRef.current();
  });

  useBrowserLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;

    const measure = () => measureRef.current();

    window.addEventListener('resize', measure);

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;

    observer?.observe(root);

    root.querySelectorAll<HTMLElement>(
      '[data-demo-target]',
    ).forEach(element => observer?.observe(element));

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div
      ref={stage}
      className="kiosk-demo-stage"
      aria-hidden="true"
    >
      {children}

      <div
        ref={pointer}
        className={`kiosk-demo-finger${cursor ? ' is-cursor' : ''}`}
        aria-hidden="true"
      >
        <span className="kiosk-demo-ring" />

        {cursor && (
          <svg
            className="kiosk-demo-cursor-svg"
            viewBox="0 0 24 32"
            aria-hidden="true"
          >
            <path
              d="M2 1 L2 26 L9 19 L15 30 L19 28 L13 17 L23 17 Z"
              className="kiosk-demo-cursor-path"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

function DemoTarget({
  id,
  children,
  className = '',
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-demo-target={id}
      className={`kiosk-demo-target ${className}`}
    >
      {children}
    </span>
  );
}

function DemoButton({
  id,
  children,
  secondary = false,
}: {
  id: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <DemoTarget
      id={id}
      className={
        secondary
          ? 'kiosk-demo-button is-secondary'
          : 'kiosk-demo-button'
      }
    >
      {children}
    </DemoTarget>
  );
}

function DemoBadge({
  children,
  visible = 1,
  neutral = false,
}: {
  children: ReactNode;
  visible?: number;
  neutral?: boolean;
}) {
  return (
    <div
      className={
        neutral
          ? 'kiosk-demo-badge is-neutral'
          : 'kiosk-demo-badge'
      }
      style={cssVars({
        '--reveal': clamp(visible),
      })}
      data-visible={visible > 0}
    >
      {neutral
        ? <ShieldCheck size={13} />
        : <Check size={13} />}

      <span>{children}</span>
    </div>
  );
}

function DemoLayer({
  amount,
  children,
  className = '',
}: {
  amount: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`kiosk-demo-layer ${className}`}
      data-visible={amount > 0}
      style={cssVars({
        '--reveal': clamp(amount),
      })}
    >
      {children}
    </div>
  );
}

function DemoToggle({
  id,
  label,
  amount,
}: {
  id: string;
  label: string;
  amount: number;
}) {
  return (
    <div className="kiosk-demo-settings-row">
      <span>{label}</span>

      <DemoTarget
        id={id}
        className="kiosk-demo-toggle-target"
      >
        <span
          className="kiosk-demo-toggle"
          data-on={amount >= 0.5}
          style={cssVars({
            '--toggle-position': clamp(amount),
          })}
        >
          <span className="kiosk-demo-toggle-thumb" />
        </span>
      </DemoTarget>

      <span className="sr-only">
        {amount >= 0.5 ? 'On' : 'Off'}
      </span>
    </div>
  );
}

function ShutfeyIcon({
  target,
  pressed = 0,
}: {
  target?: string;
  pressed?: number;
}) {
  return (
    <span
      data-demo-target={target}
      className="kiosk-demo-app-icon"
      style={cssVars({
        '--icon-press': clamp(pressed),
      })}
    >
      <span className="kiosk-demo-app-mark">
        <ShieldCheck size={27} strokeWidth={1.8} />
      </span>

      <span>Shutfey</span>
    </span>
  );
}

function KioskScreen({
  compact = false,
  signedIn = false,
  silk = false,
}: {
  compact?: boolean;
  signedIn?: boolean;
  silk?: boolean;
}) {
  return (
    <div
      className={`kiosk-demo-app-screen${compact ? ' is-compact' : ''}`}
    >
      {silk && (
        <div className="kiosk-demo-browser-bar">
          Silk · Shutfey
        </div>
      )}

      <div className="kiosk-demo-brand">
        <ShieldCheck size={21} />
        <strong>Shutfey</strong>
      </div>

      <span className="kiosk-demo-muted">
        Staff sign-in
      </span>

      <strong className="kiosk-demo-venue">
        Valley Kitchen
      </strong>

      {signedIn ? (
        <DemoBadge>Eli signed in ✓</DemoBadge>
      ) : (
        <>
          <div className="kiosk-demo-qr">
            <QrCode size={46} strokeWidth={1.7} />
          </div>

          <span className="kiosk-demo-muted">
            Scan with your phone
          </span>

          <span className="kiosk-demo-code-option">
            Use your code instead
          </span>
        </>
      )}
    </div>
  );
}

function DeviceFrame({
  family,
  children,
  hardware = false,
  recentsTarget,
  small = false,
  title,
}: {
  family: KioskDeviceFamily;
  children: ReactNode;
  hardware?: boolean;
  recentsTarget?: string;
  small?: boolean;
  title?: string;
}) {
  const laptop =
    family === 'windows' ||
    family === 'mac' ||
    family === 'chromebook';

  if (laptop) {
    return (
      <div
        className="kiosk-demo-laptop"
        data-family={family}
      >
        <div className="kiosk-demo-laptop-bezel">
          <span className="kiosk-demo-camera" />

          <div className="kiosk-demo-laptop-screen">
            <div className="kiosk-demo-windowbar">
              <span className="kiosk-demo-window-controls">
                <i />
                <i />
                <i />
              </span>

              <span>{title ?? 'Shutfey'}</span>

              <span className="kiosk-demo-window-end">
                ▫
              </span>
            </div>

            <div className="kiosk-demo-laptop-content">
              {children}
            </div>
          </div>
        </div>

        <div className="kiosk-demo-laptop-base">
          <span />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`kiosk-demo-handheld${small ? ' is-small' : ''}`}
      data-family={family}
    >
      {hardware && (
        <span
          data-demo-target="hardware"
          className="kiosk-demo-hardware"
        />
      )}

      <div className="kiosk-demo-handheld-screen">
        <div className="kiosk-demo-statusbar">
          <strong>9:41</strong>

          <span className="kiosk-demo-status-pill" />

          <span className="kiosk-demo-status-icons">
            <Wifi size={12} />
            <span className="kiosk-demo-battery" />
          </span>
        </div>

        <div className="kiosk-demo-handheld-content">
          {children}
        </div>

        {family === 'ios' ? (
          <div className="kiosk-demo-homebar">
            <span />
          </div>
        ) : (
          <div className="kiosk-demo-android-nav">
            <span>◁</span>
            <span>○</span>

            <span data-demo-target={recentsTarget}>
              {family === 'samsung' ? '|||' : '□'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsHeading({
  title,
  path,
}: {
  title: string;
  path?: string;
}) {
  return (
    <div className="kiosk-demo-settings-heading">
      {path && (
        <span className="kiosk-demo-muted">
          {path}
        </span>
      )}

      <strong>{title}</strong>
    </div>
  );
}

function DemoStack({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="kiosk-demo-stack">
      {children}
    </div>
  );
}

/* --------------------------------------------------------------
   Device-specific choreography
-------------------------------------------------------------- */

function IOSScene({
  step,
  time,
  hidePointer,
}: {
  step: KioskLockStep;
  time: number;
  hidePointer: boolean;
}) {
  if (step.stepNumber === 1) {
    const beats: DemoBeat[] = [
      { target: 'guided-toggle', at: 1250 },
      { target: 'passcode', at: 3650 },
    ];

    return (
      <DemoStage
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family="ios">
          <SettingsHeading
            title="Guided Access"
            path="Settings → Accessibility"
          />

          <DemoToggle
            id="guided-toggle"
            label="Guided Access"
            amount={ramp(time, 1250, 430)}
          />

          <DemoLayer amount={ramp(time, 1750)}>
            <div className="kiosk-demo-settings-row">
              <DemoTarget id="passcode">
                Passcode Settings
              </DemoTarget>
              <span>›</span>
            </div>
          </DemoLayer>

          <DemoLayer amount={ramp(time, 4000)}>
            <div className="kiosk-demo-passcode">
              <span>Guided Access passcode</span>
              <strong>● ● ● ● ● ●</strong>
            </div>
          </DemoLayer>

          <DemoBadge visible={ramp(time, 4650)}>
            PIN set ✓
          </DemoBadge>
        </DeviceFrame>
      </DemoStage>
    );
  }

  if (step.stepNumber === 2) {
    const beats: DemoBeat[] = [
      { target: 'shutfey-icon', at: 2350 },
    ];

    const opened = ramp(time, 2550, 650);

    return (
      <DemoStage
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family="ios">
          <DemoStack>
            <DemoLayer
              amount={1 - opened}
              className="kiosk-demo-home-screen"
            >
              <span className="kiosk-demo-muted">
                Home Screen
              </span>

              <ShutfeyIcon
                target="shutfey-icon"
                pressed={
                  time >= 2350 && time < 2550
                    ? 1
                    : 0
                }
              />

              <div className="kiosk-demo-home-dock">
                <AppWindow size={20} />
                <QrCode size={20} />
                <ShieldCheck size={20} />
              </div>
            </DemoLayer>

            <DemoLayer amount={opened}>
              <KioskScreen />

              <DemoBadge visible={ramp(time, 3400)}>
                Shutfey opened
              </DemoBadge>
            </DemoLayer>
          </DemoStack>
        </DeviceFrame>
      </DemoStage>
    );
  }

  const beats: DemoBeat[] = [
    { target: 'hardware', at: 1100 },
    { target: 'hardware', at: 1690 },
    { target: 'hardware', at: 2280 },
    { target: 'guided-start', at: 4750 },
  ];

  const clicks = [1100, 1690, 2280]
    .filter(at => time >= at).length;

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame family="ios" hardware>
        <div className="kiosk-demo-hardware-caption">
          Side / Top button

          <span className="kiosk-demo-count">
            {clicks === 3 ? '×3' : `${clicks} / 3`}
          </span>
        </div>

        <div className="kiosk-demo-pulse-count">
          {[1, 2, 3].map(number => (
            <span
              key={number}
              data-active={clicks >= number}
            >
              {number}
            </span>
          ))}
        </div>

        <KioskScreen />

        <DemoLayer amount={ramp(time, 2850)}>
          <div className="kiosk-demo-os-overlay">
            <span>
              <strong>Guided Access</strong>
              <small>Touch enabled</small>
            </span>

            <DemoButton id="guided-start">
              Start
            </DemoButton>
          </div>
        </DemoLayer>

        <DemoBadge visible={ramp(time, 5150)}>
          Guided Access Started ✓
        </DemoBadge>
      </DeviceFrame>
    </DemoStage>
  );
}

function AndroidScene({
  device,
  step,
  time,
  hidePointer,
}: {
  device: 'samsung' | 'android' | 'fire';
  step: KioskLockStep;
  time: number;
  hidePointer: boolean;
}) {
  const fire = device === 'fire';

  const pinLabel =
    device === 'android' ? 'Pin' : 'Pin this app';

  if (step.stepNumber === 1) {
    const beats: DemoBeat[] = [
      { target: 'pin-toggle', at: 1350 },
      { target: 'pin-protection', at: 3650 },
    ];

    return (
      <DemoStage
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family={device}>
          <SettingsHeading
            title={KIOSK_LOCK_GUIDES[device].methodName}
            path={step.settingsPath}
          />

          <DemoToggle
            id="pin-toggle"
            label={step.toggles?.[0] ?? 'App pinning'}
            amount={ramp(time, 1350, 430)}
          />

          <DemoLayer amount={ramp(time, 1850)}>
            <DemoToggle
              id="pin-protection"
              label={
                step.toggles?.[1] ??
                'Require screen lock to unpin'
              }
              amount={ramp(time, 3650, 430)}
            />
          </DemoLayer>

          <DemoBadge visible={ramp(time, 4250)}>
            Screen lock required
          </DemoBadge>

          {fire && (
            <p className="kiosk-demo-note">
              On supported Fire OS versions
            </p>
          )}
        </DeviceFrame>
      </DemoStage>
    );
  }

  if (step.stepNumber === 2) {
    const beats: DemoBeat[] = [
      { target: 'recents', at: 2250 },
    ];

    const recent = ramp(time, 2450, 650);

    return (
      <DemoStage
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame
          family={device}
          recentsTarget="recents"
        >
          <div
            className="kiosk-demo-recents-scene"
            style={cssVars({
              '--recents': recent,
            })}
          >
            <DemoLayer amount={recent}>
              <div className="kiosk-demo-recents-title">
                <ShutfeyIcon />
                <span>{fire ? 'Silk' : 'Shutfey'}</span>
              </div>
            </DemoLayer>

            <div className="kiosk-demo-recent-card">
              <KioskScreen silk={fire} compact />
            </div>

            <DemoLayer amount={recent}>
              <span className="kiosk-demo-muted">
                {device === 'samsung'
                  ? 'Recents'
                  : 'Overview / Recents'}
              </span>
            </DemoLayer>
          </div>
        </DeviceFrame>
      </DemoStage>
    );
  }

  const beats: DemoBeat[] = fire
    ? [{ target: 'pin-action', at: 3000 }]
    : [
        { target: 'recent-icon', at: 1350 },
        { target: 'pin-action', at: 3750 },
      ];

  const menu = fire ? 1 : ramp(time, 1550);

  const pinned = ramp(
    time,
    fire ? 3450 : 4200,
  );

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame family={device}>
        <div className="kiosk-demo-recents-title">
          <ShutfeyIcon target="recent-icon" />
          <span>{fire ? 'Silk' : 'Shutfey'}</span>
        </div>

        <div className="kiosk-demo-preview-card">
          <KioskScreen silk={fire} compact />

          <DemoLayer amount={menu}>
            <div className="kiosk-demo-floating-menu">
              {!fire && (
                <span className="kiosk-demo-muted">
                  App menu
                </span>
              )}

              <DemoButton id="pin-action">
                <Lock size={14} />
                {pinLabel}
              </DemoButton>
            </div>
          </DemoLayer>
        </div>

        <DemoBadge visible={pinned}>
          {fire ? 'Pinned ✓' : 'App pinned ✓'}
        </DemoBadge>

        {fire && (
          <p className="kiosk-demo-note">
            Silk controls may remain available.
          </p>
        )}
      </DeviceFrame>
    </DemoStage>
  );
}

function WindowsScene({
  step,
  time,
  hidePointer,
}: {
  step: KioskLockStep;
  time: number;
  hidePointer: boolean;
}) {
  if (step.stepNumber === 1) {
    const beats: DemoBeat[] = [
      { target: 'get-started', at: 1900 },
    ];

    const opened = ramp(time, 2150, 550);

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family="windows" title="Settings">
          <DemoStack>
            <DemoLayer amount={1 - opened}>
              <SettingsHeading
                title="Other users"
                path="Settings → Accounts"
              />

              <div className="kiosk-demo-settings-panel">
                <strong>Set up a kiosk</strong>

                <p className="kiosk-demo-muted">
                  Assigned Access
                </p>

                <DemoButton id="get-started">
                  Get started
                </DemoButton>
              </div>
            </DemoLayer>

            <DemoLayer amount={opened}>
              <SettingsHeading
                title="Set up a kiosk"
                path="Assigned Access"
              />

              <div className="kiosk-demo-settings-panel">
                <strong>Create kiosk account</strong>

                <div className="kiosk-demo-input">
                  Shutfey
                </div>

                <DemoBadge>
                  Wizard opened
                </DemoBadge>
              </div>
            </DemoLayer>
          </DemoStack>
        </DeviceFrame>
      </DemoStage>
    );
  }

  if (step.stepNumber === 2) {
    const beats: DemoBeat[] = [
      { target: 'edge', at: 1250 },
      { target: 'edge-fullscreen', at: 3550 },
    ];

    const selected = ramp(time, 1400);
    const opened = ramp(time, 3900, 650);

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame
          family="windows"
          title="Assigned Access"
        >
          <DemoStack>
            <DemoLayer amount={1 - opened}>
              <SettingsHeading title="Choose a kiosk app" />

              <DemoButton id="edge" secondary>
                <AppWindow size={15} />
                Microsoft Edge
              </DemoButton>

              <DemoLayer amount={selected}>
                <div className="kiosk-demo-settings-panel">
                  <span>Choose kiosk display mode</span>

                  <DemoButton id="edge-fullscreen">
                    Full-screen
                  </DemoButton>

                  <span className="kiosk-demo-muted">
                    Digital sign / interactive display
                  </span>
                </div>
              </DemoLayer>
            </DemoLayer>

            <DemoLayer amount={opened}>
              <KioskScreen />

              <DemoBadge>
                Kiosk display preview
              </DemoBadge>
            </DemoLayer>
          </DemoStack>
        </DeviceFrame>
      </DemoStage>
    );
  }

  const beats: DemoBeat[] = [
    { target: 'kiosk-account', at: 1650 },
  ];

  const opened = ramp(time, 1950, 600);

  return (
    <DemoStage
      cursor
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame
        family="windows"
        title="Dedicated kiosk account"
      >
        <DemoStack>
          <DemoLayer amount={1 - opened}>
            <div className="kiosk-demo-login-preview">
              <ShutfeyIcon />
              <strong>Dedicated kiosk account</strong>

              <DemoButton id="kiosk-account">
                Sign in
              </DemoButton>
            </div>
          </DemoLayer>

          <DemoLayer amount={opened}>
            <KioskScreen />

            <DemoBadge neutral>
              Test pairing after restart
            </DemoBadge>

            <div className="kiosk-demo-key-tip">
              Ctrl+Alt+Del
            </div>
          </DemoLayer>
        </DemoStack>
      </DeviceFrame>
    </DemoStage>
  );
}

function MacScene({
  step,
  time,
  hidePointer,
}: {
  step: KioskLockStep;
  time: number;
  hidePointer: boolean;
}) {
  if (step.stepNumber === 1) {
    const beats: DemoBeat[] = [
      { target: 'add-dock', at: 2050 },
    ];

    const added = ramp(time, 2250, 550);

    const bounce =
      time >= 2450 && time < 3250
        ? Math.abs(
            Math.sin(
              ((time - 2450) / 800) * Math.PI * 2,
            ),
          ) * (1 - (time - 2450) / 800)
        : 0;

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family="mac" title="Safari">
          <div className="kiosk-demo-browser-bar">
            File · Edit · View
          </div>

          <div className="kiosk-demo-settings-panel">
            <strong>File</strong>

            <DemoButton id="add-dock" secondary>
              Add to Dock
            </DemoButton>
          </div>

          <div className="kiosk-demo-desktop-dock">
            <AppWindow size={24} />

            <DemoLayer amount={added}>
              <div
                className="kiosk-demo-dock-icon"
                style={cssVars({
                  '--bounce': bounce,
                })}
              >
                <ShutfeyIcon />
              </div>
            </DemoLayer>

            <Download size={24} />
          </div>

          <DemoBadge visible={ramp(time, 3300)}>
            Added to Dock
          </DemoBadge>
        </DeviceFrame>
      </DemoStage>
    );
  }

  if (step.stepNumber === 2) {
    const beats: DemoBeat[] = [
      { target: 'mac-expand', at: 2300 },
    ];

    const opened = ramp(time, 2500, 650);

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame family="mac" title="Shutfey">
          <DemoStack>
            <DemoLayer amount={1 - opened}>
              <div className="kiosk-demo-browser-bar">
                <DemoTarget
                  id="mac-expand"
                  className="kiosk-demo-mac-expand"
                >
                  <Maximize size={12} />
                </DemoTarget>

                Shutfey
              </div>

              <KioskScreen compact />
            </DemoLayer>

            <DemoLayer amount={opened}>
              <KioskScreen />

              <div className="kiosk-demo-key-tip">
                Ctrl+Cmd+F
              </div>

              <DemoBadge neutral>
                Full screen only
              </DemoBadge>
            </DemoLayer>
          </DemoStack>
        </DeviceFrame>
      </DemoStage>
    );
  }

  const beats: DemoBeat[] = [
    { target: 'standard-account', at: 1500 },
    { target: 'screen-time', at: 3800 },
  ];

  return (
    <DemoStage
      cursor
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame
        family="mac"
        title="System Settings"
      >
        <SettingsHeading title="Users & Groups" />

        <div className="kiosk-demo-settings-panel">
          <DemoButton id="standard-account" secondary>
            Standard account
          </DemoButton>

          <DemoBadge visible={ramp(time, 1800)}>
            Non-admin account selected
          </DemoBadge>
        </div>

        <DemoLayer amount={ramp(time, 2350)}>
          <div className="kiosk-demo-settings-row">
            <DemoTarget id="screen-time">
              Screen Time
            </DemoTarget>
            <span>›</span>
          </div>
        </DemoLayer>

        <DemoBadge
          neutral
          visible={ramp(time, 4200)}
        >
          Review suitable restrictions
        </DemoBadge>

        <p className="kiosk-demo-note">
          Not a locked kiosk. Staff can exit full screen.
        </p>
      </DeviceFrame>
    </DemoStage>
  );
}

function ChromebookScene({
  step,
  time,
  hidePointer,
}: {
  step: KioskLockStep;
  time: number;
  hidePointer: boolean;
}) {
  if (step.stepNumber === 1) {
    const beats: DemoBeat[] = [
      { target: 'chrome-install', at: 1200 },
      { target: 'chrome-window', at: 3450 },
      { target: 'chrome-confirm', at: 4900 },
    ];

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame
          family="chromebook"
          title="Chrome"
        >
          <div className="kiosk-demo-browser-bar">
            <span>Shutfey</span>

            <DemoTarget id="chrome-install">
              <Download size={18} />
            </DemoTarget>
          </div>

          <DemoLayer amount={ramp(time, 1450)}>
            <div className="kiosk-demo-settings-panel">
              <strong>Install Shutfey</strong>

              <div className="kiosk-demo-settings-row">
                <span>Open as window, if offered</span>

                <DemoTarget id="chrome-window">
                  <span
                    className="kiosk-demo-checkbox"
                    data-checked={time >= 3450}
                  >
                    {time >= 3450 && <Check size={14} />}
                  </span>
                </DemoTarget>
              </div>

              <DemoButton id="chrome-confirm">
                Install
              </DemoButton>
            </div>
          </DemoLayer>

          <DemoBadge visible={ramp(time, 5300)}>
            Shutfey installed
          </DemoBadge>
        </DeviceFrame>
      </DemoStage>
    );
  }

  if (step.stepNumber === 2) {
    const beats: DemoBeat[] = [
      { target: 'chrome-fullscreen', at: 2200 },
    ];

    const expanded = ramp(time, 2450, 650);

    return (
      <DemoStage
        cursor
        beats={beats}
        time={time}
        hidePointer={hidePointer}
      >
        <DeviceFrame
          family="chromebook"
          title="Shutfey"
        >
          <DemoStack>
            <DemoLayer amount={1 - expanded}>
              <div className="kiosk-demo-browser-bar">
                Chrome · Shutfey
              </div>

              <KioskScreen compact />
            </DemoLayer>

            <DemoLayer amount={expanded}>
              <KioskScreen />

              <DemoBadge neutral>
                Full screen only
              </DemoBadge>
            </DemoLayer>
          </DemoStack>

          <DemoTarget
            id="chrome-fullscreen"
            className="kiosk-demo-key-tip"
          >
            ⤢ F4 · Full screen
          </DemoTarget>
        </DeviceFrame>
      </DemoStage>
    );
  }

  const beats: DemoBeat[] = [
    { target: 'managed-kiosk', at: 2100 },
  ];

  return (
    <DemoStage
      cursor
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame
        family="chromebook"
        title="ChromeOS"
      >
        <KioskScreen />

        <DemoTarget
          id="managed-kiosk"
          className="kiosk-demo-key-tip"
        >
          Staff sign-in
        </DemoTarget>

        <DemoBadge visible={ramp(time, 2500)}>
          Staff sign-in ready
        </DemoBadge>

        <DemoLayer amount={ramp(time, 3200)}>
          <p className="kiosk-demo-note">
            Managed kiosk required for enforced
            device restrictions.
          </p>
        </DemoLayer>
      </DeviceFrame>
    </DemoStage>
  );
}

/* --------------------------------------------------------------
   Public per-device mockup
-------------------------------------------------------------- */

export function KioskDeviceMockup({
  device,
  step,
  sceneElapsedMs,
  isPlaying = false,
  reducedMotion = false,
}: {
  device: KioskDeviceFamily;
  step: KioskLockStep;
} & DemoTimelineProps) {
  const time = resolveDemoTime(
    sceneElapsedMs,
    isPlaying,
    reducedMotion,
  );

  const hidePointer =
    sceneElapsedMs === undefined ||
    reducedMotion ||
    time >= KIOSK_SCENE_MS;

  let content: ReactNode;

  switch (device) {
    case 'ios':
      content = (
        <IOSScene
          step={step}
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'samsung':
    case 'android':
    case 'fire':
      content = (
        <AndroidScene
          device={device}
          step={step}
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'windows':
      content = (
        <WindowsScene
          step={step}
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'mac':
      content = (
        <MacScene
          step={step}
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'chromebook':
      content = (
        <ChromebookScene
          step={step}
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;
  }

  return (
    <div
      className="kiosk-demo-illustration"
      data-walkthrough-playing={isPlaying && !reducedMotion}
    >
      {content}

      <div className="kiosk-demo-illustration-label">
        {step.highlightLabel}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
   Overview choreography
-------------------------------------------------------------- */

function InstallOverview({
  time,
  hidePointer,
}: {
  time: number;
  hidePointer: boolean;
}) {
  const beats: DemoBeat[] = [
    { target: 'add-home', at: 1400 },
    { target: 'launch-home', at: 4100 },
  ];

  const installed = ramp(time, 1650, 500);
  const launched = ramp(time, 4350, 650);

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame family="ios">
        <DemoStack>
          <DemoLayer amount={1 - installed}>
            <div className="kiosk-demo-browser-bar">
              Safari · Shutfey
            </div>

            <KioskScreen compact />

            <DemoButton id="add-home">
              <Download size={15} />
              Add to Home Screen
            </DemoButton>
          </DemoLayer>

          <DemoLayer
            amount={installed * (1 - launched)}
            className="kiosk-demo-home-screen"
          >
            <span>Home Screen</span>

            <ShutfeyIcon target="launch-home" />

            <DemoBadge>
              App installed
            </DemoBadge>
          </DemoLayer>

          <DemoLayer amount={launched}>
            <KioskScreen />

            <DemoBadge>
              Full-screen app opened
            </DemoBadge>
          </DemoLayer>
        </DemoStack>
      </DeviceFrame>
    </DemoStage>
  );
}

export function getDemoPairingCode(time: number): string {
  const count = Math.max(
    0,
    Math.min(6, Math.floor((time - 1450) / 430) + 1),
  );

  return 'K7M4P2'.slice(0, count);
}

function PairOverview({
  time,
  hidePointer,
}: {
  time: number;
  hidePointer: boolean;
}) {
  const letters = ['K', '7', 'M', '4', 'P', '2'];

  const beats: DemoBeat[] = [
    { target: 'code-input', at: 800 },
    ...letters.map((_, index) => ({
      target: `code-key-${index}`,
      at: 1450 + index * 430,
    })),
    { target: 'venue', at: 4700 },
    { target: 'pair', at: 5900 },
  ];

  const typed = getDemoPairingCode(time);

  const selected = ramp(time, 4800);
  const paired = ramp(time, 6100);

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <div className="kiosk-demo-duo">
        <div className="kiosk-demo-duo-item">
          <span className="kiosk-demo-device-label">
            Kiosk device
          </span>

          <DeviceFrame family="ios" small>
            <div className="kiosk-demo-pair-screen">
              <ShutfeyIcon />

              <strong>Pair this device</strong>

              <span className="kiosk-demo-muted">
                Example code
              </span>

              <strong className="kiosk-demo-pair-code">
                K7M4P2
              </strong>

              <DemoBadge visible={paired}>
                Paired ✓
              </DemoBadge>
            </div>
          </DeviceFrame>
        </div>

        <div className="kiosk-demo-duo-item">
          <span className="kiosk-demo-device-label">
            Your phone
          </span>

          <DeviceFrame family="ios" small>
            <SettingsHeading title="Kiosk tablets" />

            <DemoTarget
              id="code-input"
              className="kiosk-demo-input kiosk-demo-typed"
            >
              {typed || 'Enter code'}
            </DemoTarget>

            <div className="kiosk-demo-keyboard">
              {letters.map((letter, index) => (
                <span
                  key={letter}
                  data-demo-target={`code-key-${index}`}
                  className="kiosk-demo-target kiosk-demo-key"
                >
                  {letter}
                </span>
              ))}
            </div>

            <DemoLayer amount={ramp(time, 3850)}>
              <DemoTarget
                id="venue"
                className="kiosk-demo-venue-option"
              >
                Valley Kitchen

                {selected >= 0.5 ? <Check size={14} /> : '⌄'}
              </DemoTarget>
            </DemoLayer>

            <DemoButton id="pair">
              Pair device
            </DemoButton>

            <DemoBadge visible={paired}>
              Paired ✓
            </DemoBadge>
          </DeviceFrame>
        </div>
      </div>
    </DemoStage>
  );
}

function LockOverview({
  time,
  hidePointer,
}: {
  time: number;
  hidePointer: boolean;
}) {
  const beats: DemoBeat[] = [
    { target: 'restriction', at: 1750 },
    { target: 'restriction-start', at: 4400 },
  ];

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <DeviceFrame family="ios">
        <SettingsHeading
          title="Device restrictions"
          path="Supported restriction example"
        />

        <DemoToggle
          id="restriction"
          label="Enable restriction"
          amount={ramp(time, 1750, 450)}
        />

        <DemoLayer amount={ramp(time, 2300)}>
          <div className="kiosk-demo-settings-panel">
            <KioskScreen compact />

            <DemoButton id="restriction-start">
              Start
            </DemoButton>
          </div>
        </DemoLayer>

        <DemoBadge visible={ramp(time, 4800)}>
          Restricted ✓
        </DemoBadge>

        <p className="kiosk-demo-note">
          Full screen alone is not a security lock.
        </p>
      </DeviceFrame>
    </DemoStage>
  );
}

export function getDemoPinCount(time: number): number {
  return Math.max(
    0,
    Math.min(4, Math.floor((time - 3300) / 460) + 1),
  );
}

function SignInOverview({
  time,
  hidePointer,
}: {
  time: number;
  hidePointer: boolean;
}) {
  const beats: DemoBeat[] = [
    { target: 'scan', at: 1000 },
    { target: 'pin-option', at: 2550 },
    ...[0, 1, 2, 3].map(index => ({
      target: `pin-key-${index}`,
      at: 3300 + index * 460,
    })),
    { target: 'signin', at: 5550 },
  ];

  const pinCount = getDemoPinCount(time);
  const signed = ramp(time, 5900);
  const scanned = ramp(time, 1300);

  return (
    <DemoStage
      beats={beats}
      time={time}
      hidePointer={hidePointer}
    >
      <div className="kiosk-demo-duo">
        <div className="kiosk-demo-duo-item">
          <span className="kiosk-demo-device-label">
            QR sign-in
          </span>

          <DeviceFrame family="ios" small>
            <div className="kiosk-demo-pair-screen">
              <strong>Staff sign-in</strong>

              <DemoTarget
                id="scan"
                className="kiosk-demo-qr"
              >
                <QrCode size={52} />

                <span
                  className="kiosk-demo-scan-line"
                  style={cssVars({
                    '--scan': ramp(time, 1000, 700),
                    '--scan-visible':
                      time >= 1000 && time < 2000 ? 1 : 0,
                  })}
                />
              </DemoTarget>

              <span className="kiosk-demo-muted">
                Scan with your phone
              </span>

              <DemoBadge visible={scanned}>
                QR recognized
              </DemoBadge>

              <DemoLayer amount={scanned}>
                <div className="kiosk-demo-brand">
                  <ShieldCheck size={18} />
                  Eli
                </div>
              </DemoLayer>
            </div>
          </DeviceFrame>
        </div>

        <div className="kiosk-demo-duo-item">
          <span className="kiosk-demo-device-label">
            Or use a PIN
          </span>

          <DeviceFrame family="ios" small>
            <SettingsHeading title="Eli" />

            <DemoTarget
              id="pin-option"
              className="kiosk-demo-code-option"
            >
              Use your code instead
            </DemoTarget>

            <div className="kiosk-demo-pin-dots">
              {[0, 1, 2, 3].map(index => (
                <span
                  key={index}
                  data-filled={index < pinCount}
                />
              ))}
            </div>

            <div className="kiosk-demo-pin-keypad">
              {Array.from({ length: 9 }, (_, index) => (
                <span
                  key={index}
                  data-demo-target={
                    index < 4
                      ? `pin-key-${index}`
                      : undefined
                  }
                  className="kiosk-demo-key"
                >
                  {index + 1}
                </span>
              ))}
            </div>

            <DemoButton id="signin">
              Sign in
            </DemoButton>

            <DemoBadge visible={signed}>
              Eli signed in ✓
            </DemoBadge>
          </DeviceFrame>
        </div>
      </div>

      <DemoBadge visible={signed} neutral>
        Auto sign-out after 5 min idle
      </DemoBadge>
    </DemoStage>
  );
}

/* --------------------------------------------------------------
   Public overview mockup
-------------------------------------------------------------- */

export function KioskOverviewMockup({
  visual,
  sceneElapsedMs,
  isPlaying = false,
  reducedMotion = false,
}: {
  visual: KioskWalkthroughScene['visualKey'];
} & DemoTimelineProps) {
  const time = resolveDemoTime(
    sceneElapsedMs,
    isPlaying,
    reducedMotion,
  );

  const hidePointer =
    sceneElapsedMs === undefined ||
    reducedMotion ||
    time >= KIOSK_SCENE_MS;

  let content: ReactNode;

  switch (visual) {
    case 'install':
      content = (
        <InstallOverview
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'pair':
      content = (
        <PairOverview
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'lock':
      content = (
        <LockOverview
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    case 'signin':
      content = (
        <SignInOverview
          time={time}
          hidePointer={hidePointer}
        />
      );
      break;

    default:
      return null;
  }

  return (
    <div
      className="kiosk-demo-illustration"
      data-walkthrough-playing={isPlaying && !reducedMotion}
    >
      {content}
    </div>
  );
}

/* --------------------------------------------------------------
   Accessible timeline player
-------------------------------------------------------------- */

export function KioskVideoWalkthrough(
  props: WalkthroughProps,
) {
  return createElement(WalkthroughPlayer, {
    ...props,
    key: `${props.mode}-${props.device ?? 'ios'}`,
  });
}

function WalkthroughPlayer({
  mode,
  device = 'ios',
  onStepChange,
}: WalkthroughProps) {
  const guide = KIOSK_LOCK_GUIDES[device];

  const scenes =
    mode === 'overview'
      ? KIOSK_OVERVIEW_SCENES
      : guide.walkthroughScenes;

  const starts = scenes.map((_, index) =>
    scenes.slice(0, index).reduce(
      (sum, scene) => sum + scene.durationMs,
      0,
    ),
  );

  const total =
    starts[starts.length - 1] +
    scenes[scenes.length - 1].durationMs;

  const [elapsed, setElapsed] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const position = useRef(0);
  const callback = useRef(onStepChange);

  const sceneIndex = starts.reduce(
    (active, start, index) =>
      elapsed >= start ? index : active,
    0,
  );

  const scene = scenes[sceneIndex];

  const sceneElapsedMs =
    elapsed - starts[sceneIndex];

  useEffect(() => {
    callback.current = onStepChange;
  }, [onStepChange]);

  useEffect(() => {
    callback.current?.(sceneIndex);
  }, [sceneIndex]);

  useEffect(() => {
    if (!window.matchMedia) {
      setIsPlaying(true);
      return;
    }

    const preference = window.matchMedia(MOTION_QUERY);

    setReducedMotion(preference.matches);
    setIsPlaying(!preference.matches);

    const onPreferenceChange = () => {
      setReducedMotion(preference.matches);

      if (preference.matches) {
        setIsPlaying(false);
      }
    };

    if (preference.addEventListener) {
      preference.addEventListener(
        'change',
        onPreferenceChange,
      );

      return () => {
        preference.removeEventListener(
          'change',
          onPreferenceChange,
        );
      };
    }

    // Compatibility with older Safari media-query listeners.
    preference.addListener?.(onPreferenceChange);

    return () => {
      preference.removeListener?.(onPreferenceChange);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying || reducedMotion) return;

    let last = performance.now();
    let frame = 0;
    let stopped = false;

    const tick = (now: number) => {
      if (stopped) return;

      const delta = Math.max(0, now - last);

      last = now;

      position.current = Math.min(
        total,
        position.current + delta,
      );

      setElapsed(position.current);

      if (position.current < total) {
        frame = requestAnimationFrame(tick);
      } else {
        setIsPlaying(false);
      }
    };

    const onVisibilityChange = () => {
      last = performance.now();
    };

    document.addEventListener(
      'visibilitychange',
      onVisibilityChange,
    );

    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;

      cancelAnimationFrame(frame);

      document.removeEventListener(
        'visibilitychange',
        onVisibilityChange,
      );
    };
  }, [isPlaying, total, reducedMotion]);

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(total, value));

    position.current = next;
    setElapsed(next);

    if (next >= total) {
      setIsPlaying(false);
    }
  };

  const replay = () => {
    seek(0);
    setIsPlaying(!reducedMotion);
  };

  const togglePlayback = () => {
    if (reducedMotion) {
      setIsPlaying(false);

      const nextIndex = sceneIndex + 1;

      seek(
        nextIndex < scenes.length
          ? starts[nextIndex]
          : 0,
      );

      return;
    }

    if (elapsed >= total) {
      replay();
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  const timeline = {
    sceneElapsedMs,
    isPlaying,
    reducedMotion,
  };

  return (
    <section
      aria-label="Kiosk walkthrough"
      className="overflow-hidden rounded-2xl border border-line bg-sunken"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gold-wash px-2 py-1 font-semibold text-gold-ink">
          <Play size={12} aria-hidden="true" />

          {mode === 'overview'
            ? '4-step overview'
            : 'Animated walkthrough'}
        </span>

        <span className="text-ink-soft">
          {mode === 'overview'
            ? scene.title
            : guide.methodName}
        </span>

        <span className="ml-auto font-semibold tabular-nums text-ink-soft">
          {sceneIndex + 1} / {scenes.length}
        </span>
      </header>

      <div
        key={scene.id}
        data-walkthrough-playing={
          isPlaying && !reducedMotion
        }
        className="kiosk-demo-player-stage"
      >
        {mode === 'device' && (
          <p className="text-center text-sm font-bold text-ink">
            {scene.title}
          </p>
        )}

        {mode === 'overview' ? (
          <KioskOverviewMockup
            visual={scene.visualKey}
            {...timeline}
          />
        ) : (
          <KioskDeviceMockup
            device={device}
            step={guide.steps[sceneIndex]}
            {...timeline}
          />
        )}
      </div>

      <p
        aria-live={isPlaying ? 'off' : 'polite'}
        aria-atomic="true"
        className="border-t border-line bg-surface px-4 py-2.5 text-xs font-semibold text-ink sm:text-sm"
      >
        {scene.caption}
      </p>

      <div className="space-y-1 border-t border-line bg-surface px-3 py-2.5">
        <input
          type="range"
          min={0}
          max={total}
          step={100}
          value={Math.round(elapsed / 100) * 100}
          onChange={event =>
            seek(Number(event.currentTarget.value))
          }
          aria-label="Walkthrough progress"
          aria-valuetext={
            `Chapter ${sceneIndex + 1} of ${scenes.length}, ` +
            `${Math.floor(elapsed / 1000)} seconds`
          }
          className="kiosk-walkthrough-progress block min-h-11 w-full cursor-pointer"
          style={cssVars({
            '--walkthrough-progress':
              `${elapsed / total * 100}%`,
          })}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label={
              reducedMotion
                ? 'Next walkthrough chapter'
                : isPlaying
                  ? 'Pause walkthrough'
                  : 'Play walkthrough'
            }
            onClick={togglePlayback}
            className="grid min-h-11 min-w-11 place-items-center rounded-xl border border-line-control bg-sunken text-ink"
          >
            {isPlaying
              ? <Pause size={17} aria-hidden="true" />
              : <Play size={17} aria-hidden="true" />}
          </button>

          <button
            type="button"
            aria-label="Replay walkthrough"
            onClick={replay}
            className="grid min-h-11 min-w-11 place-items-center rounded-xl border border-line-control bg-sunken text-ink"
          >
            <RotateCcw size={17} aria-hidden="true" />
          </button>

          <div
            className="ml-auto flex flex-wrap gap-1"
            role="group"
            aria-label="Walkthrough chapters"
          >
            {scenes.map((chapter, index) => (
              <button
                type="button"
                key={chapter.id}
                aria-label={
                  `Chapter ${index + 1}: ${chapter.title}`
                }
                aria-current={
                  index === sceneIndex ? 'step' : undefined
                }
                onClick={() => seek(starts[index])}
                className={`min-h-11 min-w-11 rounded-full text-xs font-bold ${
                  index === sceneIndex
                    ? 'bg-gold-deep text-paper'
                    : 'border border-line-control bg-sunken text-ink'
                }`}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>

        {reducedMotion && (
          <p className="px-1 pt-1 text-xs text-ink-soft">
            Reduced motion enabled. Completed illustrations
            are shown without decorative motion.
          </p>
        )}
      </div>
    </section>
  );
}
