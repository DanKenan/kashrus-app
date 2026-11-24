import { createElement, useEffect, useRef, useState } from 'react';
import { AppWindow, ArrowRight, Check, Keyboard, Monitor, Pause, Play, QrCode, RotateCcw, Settings, ShieldCheck, Smartphone } from 'lucide-react';
import { KIOSK_LOCK_GUIDES, KIOSK_OVERVIEW_SCENES, type KioskDeviceFamily, type KioskLockStep, type KioskWalkthroughScene } from '../lib/kioskGuide';

interface WalkthroughProps {
  mode: 'device' | 'overview';
  device?: KioskDeviceFamily;
  onStepChange?: (stepIndex: number) => void;
}

function TapTarget({ label, pulse = false }: { label: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex max-w-full items-center gap-1.5 rounded-lg bg-gold-wash px-2.5 py-1.5 font-bold text-gold-ink ring-2 ring-gold">
      {label}
      <span className={`pointer-events-none absolute inset-0 rounded-lg ${pulse ? 'kiosk-button-pulse' : 'kiosk-tap-ripple'} motion-reduce:animate-none`} />
    </span>
  );
}

export function KioskDeviceMockup({ device, step }: { device: KioskDeviceFamily; step: KioskLockStep }) {
  const handheld = ['ios', 'samsung', 'android', 'fire'].includes(device);
  const pinning = handheld && device !== 'ios';
  const { switcherLabel } = KIOSK_LOCK_GUIDES[device];
  const isShortcut = step.mockupKind === 'shortcut';
  const isSettings = step.mockupKind === 'settings';
  const FrameIcon = handheld ? Smartphone : Monitor;
  const showDock = device === 'mac' && isShortcut;
  const showKioskScreen = (!handheld && !isSettings && !showDock) || (handheld && isShortcut);
  return (
    <div className={`mx-auto w-full rounded-2xl border-2 border-line-strong bg-paper p-2 text-xs text-ink ${handheld ? 'max-w-xs' : 'max-w-sm'}`}>
      <div className="flex items-center gap-2 border-b border-line px-2 pb-1.5 font-semibold text-ink-soft">
        <FrameIcon size={15} aria-hidden="true" />
        {switcherLabel}
        {!handheld && <span className="ml-auto flex gap-1" aria-hidden="true">
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
        </span>}
      </div>
      <div className="space-y-2 rounded-xl bg-surface p-2.5">
        {step.settingsPath && <p className="flex items-center gap-2 text-ink-soft">
          {isSettings ? <Settings size={15} className="shrink-0" aria-hidden="true" /> : <AppWindow size={15} className="shrink-0" aria-hidden="true" />}
          {step.settingsPath}
        </p>}
        {step.toggles ? step.toggles.map((toggle, index) => (
          <div key={toggle} className={`flex items-center justify-between gap-2 rounded-lg border bg-sunken px-2 py-1.5 font-semibold ${index === 0 ? 'border-gold' : 'border-line'}`}>
            {toggle}
            <span className="relative flex h-5 w-9 shrink-0 items-center justify-end rounded-full bg-ok px-0.5">
              <span className="kiosk-toggle-slide size-4 rounded-full bg-paper motion-reduce:animate-none" />
            </span>
            <span className="sr-only">On</span>
          </div>
        )) : (
          <>
            {showKioskScreen && <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-2 py-1.5 font-semibold">
              <AppWindow size={16} className="text-gold-deep" aria-hidden="true" />
              {device === 'fire' ? 'Silk · Shutfey' : 'Shutfey · Staff sign-in'}
            </div>}
            <div className={`flex flex-wrap items-center gap-2 ${showDock ? 'justify-center rounded-lg border border-line bg-sunken p-2' : 'justify-end'}`}>
              {showDock && <><AppWindow size={18} aria-hidden="true" /><Settings size={18} aria-hidden="true" /></>}
              {!handheld && (step.highlightLabel === 'F11' || step.highlightLabel.includes('F4') || step.highlightLabel.includes('Cmd')) &&
                <Keyboard size={19} aria-hidden="true" />}
              <TapTarget label={step.highlightLabel} pulse={device === 'ios' && isShortcut} />
            </div>
          </>
        )}
      </div>
      {pinning && !isSettings && <div className="mt-1 flex items-center justify-around pt-1 font-semibold text-ink-soft" aria-hidden="true">
        <span>◁</span><span>○</span><span className={isShortcut ? 'rounded-md px-2 text-gold-deep ring-2 ring-gold' : ''}>□</span>
      </div>}
      {device === 'ios' && <div className="mx-auto mt-1.5 h-1 w-12 rounded-full bg-line-strong" aria-hidden="true" />}
    </div>
  );
}

export function KioskOverviewMockup({ visual }: { visual: KioskWalkthroughScene['visualKey'] }) {
  const tile = 'min-w-0 rounded-xl border border-line bg-paper p-3 text-center text-xs';
  switch (visual) {
    case 'install':
      return <div className={tile}>
        <p className="mb-2 text-ink-soft">Home Screen</p>
        <AppWindow className="mx-auto mb-2 size-9 rounded-xl bg-gold-wash p-2 text-gold-deep" aria-hidden="true" />
        <TapTarget label="Shutfey" />
      </div>;
    case 'pair':
      return <div className="mx-auto grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center gap-1.5 sm:gap-3">
        <div className={tile}>
          <Smartphone className="mx-auto mb-1" size={19} aria-hidden="true" />
          <p className="mb-2 font-semibold uppercase text-ink-soft">Kiosk device</p>
          <strong className="font-mono tracking-wide">K7M4P2</strong>
        </div>
        <ArrowRight className="text-gold-deep" size={16} aria-hidden="true" />
        <div className={tile}>
          <Monitor className="mx-auto mb-1" size={19} aria-hidden="true" />
          <p className="font-semibold uppercase text-ink-soft">Your phone / laptop</p>
          <p className="mb-2 mt-1">Kiosk tablets</p>
          <TapTarget label="Valley Kitchen" />
        </div>
      </div>;
    case 'lock':
      return <div className={`${tile} flex items-center gap-3`}>
        <Smartphone size={30} aria-hidden="true" />
        <ArrowRight size={17} aria-hidden="true" />
        <ShieldCheck size={30} className="kiosk-lock-reveal text-ok motion-reduce:animate-none" aria-hidden="true" />
        <TapTarget label="Shutfey locked" pulse />
      </div>;
    case 'signin':
      return <div className="w-full max-w-md space-y-2 text-center">
        <div className="grid grid-cols-2 gap-2">
          <div className={`${tile} flex flex-col items-center justify-center gap-2`}>
            <div className="relative rounded-lg border border-line bg-surface p-1.5">
              <QrCode size={38} aria-hidden="true" />
              <span className="kiosk-scan-line absolute inset-x-1 top-2 h-0.5 bg-gold-deep motion-reduce:animate-none" />
            </div>
            <span className="font-semibold">Scan QR code</span>
          </div>
          <div className={tile}>
            <div className="mx-auto mb-2 grid w-fit grid-cols-3 gap-1" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => <span key={index} className="grid size-5 place-items-center rounded-md bg-sunken">{index + 1}</span>)}
            </div>
            <TapTarget label="4–6 digit PIN" />
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-xs font-semibold text-ok">
          <Check size={14} aria-hidden="true" /> Auto sign-out after 5 min idle
        </span>
      </div>;
    default:
      return null;
  }
}

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function KioskVideoWalkthrough(props: WalkthroughProps) {
  return createElement(WalkthroughPlayer, { ...props, key: `${props.mode}-${props.device ?? 'ios'}` });
}

function WalkthroughPlayer({ mode, device = 'ios', onStepChange }: WalkthroughProps) {
  const guide = KIOSK_LOCK_GUIDES[device];
  const scenes = mode === 'overview' ? KIOSK_OVERVIEW_SCENES : guide.walkthroughScenes;
  const starts = scenes.map((_, i) => scenes.slice(0, i).reduce((sum, scene) => sum + scene.durationMs, 0));
  const total = starts[starts.length - 1] + scenes[scenes.length - 1].durationMs;
  const [elapsed, setElapsed] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const position = useRef(0);
  const callback = useRef(onStepChange);
  const sceneIndex = starts.reduce((active, start, i) => elapsed >= start ? i : active, 0);
  const scene = scenes[sceneIndex];

  useEffect(() => { callback.current = onStepChange; }, [onStepChange]);
  useEffect(() => { callback.current?.(sceneIndex); }, [sceneIndex]);

  useEffect(() => {
    if (!window.matchMedia) {
      setIsPlaying(true);
      return;
    }
    const preference = window.matchMedia(MOTION_QUERY);
    setIsPlaying(!preference.matches);
    const pauseForMotion = () => { if (preference.matches) setIsPlaying(false); };
    preference.addEventListener?.('change', pauseForMotion);
    return () => preference.removeEventListener?.('change', pauseForMotion);
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    let last = performance.now();
    let frame: number;
    const tick = (now: number) => {
      position.current = Math.min(total, position.current + Math.max(0, now - last));
      last = now;
      setElapsed(position.current);
      if (position.current < total) frame = requestAnimationFrame(tick);
      else setIsPlaying(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, total]);

  const seek = (time: number) => {
    position.current = time;
    setElapsed(time);
    if (time >= total) setIsPlaying(false);
  };

  const replay = () => {
    seek(0);
    setIsPlaying(true);
  };

  return (
    <section aria-label="Kiosk walkthrough" className="overflow-hidden rounded-2xl border border-line bg-sunken">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gold-wash px-2 py-1 font-semibold text-gold-ink">
          <Play size={12} aria-hidden="true" /> {mode === 'overview' ? '4-step overview' : 'Animated walkthrough'}
        </span>
        <span className="text-ink-soft">{mode === 'overview' ? scene.title : guide.methodName}</span>
        <span className="ml-auto font-semibold tabular-nums text-ink-soft">{sceneIndex + 1} / {scenes.length}</span>
      </header>
      <div key={scene.id} data-walkthrough-playing={isPlaying} className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-3 sm:min-h-[220px]">
        {mode === 'device' && <p className="text-center text-sm font-bold text-ink">{scene.title}</p>}
        {mode === 'overview' ? <KioskOverviewMockup visual={scene.visualKey} /> : <KioskDeviceMockup device={device} step={guide.steps[sceneIndex]} />}
      </div>
      <p className="border-t border-line bg-surface px-4 py-2.5 text-xs font-semibold text-ink sm:text-sm">{scene.caption}</p>
      <div className="space-y-1 border-t border-line bg-surface/95 px-3 py-2.5">
        <input type="range" min={0} max={total} value={Math.round(elapsed)} onChange={(event) => seek(Number(event.currentTarget.value))}
          aria-label="Walkthrough progress" aria-valuetext={`Chapter ${sceneIndex + 1} of ${scenes.length}, ${Math.floor(elapsed / 1000)} seconds`}
          className="kiosk-walkthrough-progress block h-8 w-full cursor-pointer"
          style={{ backgroundImage: `linear-gradient(to right, var(--gold-deep) ${elapsed / total * 100}%, var(--line-strong) 0)` }} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" aria-label={isPlaying ? 'Pause walkthrough' : 'Play walkthrough'}
            onClick={() => elapsed >= total ? replay() : setIsPlaying(!isPlaying)}
            className="grid min-h-11 min-w-11 place-items-center rounded-xl border border-line-control bg-sunken text-ink">
            {isPlaying ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
          </button>
          <button type="button" aria-label="Replay walkthrough" onClick={replay}
            className="grid min-h-11 min-w-11 place-items-center rounded-xl border border-line-control bg-sunken text-ink">
            <RotateCcw size={17} aria-hidden="true" />
          </button>
          <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Walkthrough chapters">
            {scenes.map((chapter, i) => <button type="button" key={chapter.id} aria-label={`Chapter ${i + 1}: ${chapter.title}`}
              aria-current={i === sceneIndex ? 'step' : undefined} onClick={() => seek(starts[i])}
              className={`min-h-11 min-w-11 rounded-full text-xs font-bold ${i === sceneIndex ? 'bg-gold-deep text-paper' : 'border border-line-control bg-sunken text-ink'}`}>
              {i + 1}
            </button>)}
          </div>
        </div>
      </div>
    </section>
  );
}
