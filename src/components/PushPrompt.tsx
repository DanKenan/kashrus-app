import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BellRing } from 'lucide-react';
import { PUSH_PROMPT_TEXT, type PushPromptKind } from '../lib/pushPrompt';

export function PushPrompt({ kind, busy, failed, onTurnOn, onDismiss }: {
  kind: PushPromptKind;
  busy: boolean;
  failed: boolean;
  onTurnOn: () => void;
  onDismiss: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('root');
    const previousInert = appRoot?.getAttribute('inert') ?? null;
    appRoot?.setAttribute('inert', '');
    title.current?.focus();
    return () => {
      if (previousInert === null) appRoot?.removeAttribute('inert');
      else appRoot?.setAttribute('inert', previousInert);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  useEffect(() => { title.current?.focus(); }, [busy]);
  const primary = 'min-h-12 w-full rounded-xl bg-gold-deep text-paper text-base font-semibold pressable disabled:opacity-50';
  return createPortal(
    <div ref={root} data-push-prompt={kind} role="dialog" aria-modal="true" aria-labelledby="push-prompt-title"
      aria-describedby="push-prompt-body"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-scrim"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onDismiss(); }
        if (event.key === 'Tab') {
          const targets = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const first = targets[0] ?? title.current;
          const last = targets[targets.length - 1] ?? title.current;
          if (!first || !last) return;
          const active = document.activeElement;
          if (active === title.current || !root.current?.contains(active)) {
            event.preventDefault(); (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="w-full max-w-sm max-h-full overflow-y-auto rounded-2xl bg-surface border border-line p-6 e3 space-y-4 text-ink">
        <BellRing aria-hidden="true" className="w-6 h-6 text-ink-soft" />
        <h2 ref={title} id="push-prompt-title" tabIndex={-1} className="text-xl font-semibold outline-none">
          {kind === 'turn-on' ? 'Turn on notifications' : kind === 'blocked' ? 'Notifications are blocked' : 'Add to Home Screen'}
        </h2>
        <p id="push-prompt-body" className="text-base text-ink-soft">{PUSH_PROMPT_TEXT[kind]}</p>
        {kind === 'turn-on' ? <>
          <button type="button" onClick={onTurnOn} disabled={busy} className={primary}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
          <button type="button" onClick={onDismiss} className="min-h-11 w-full rounded-xl text-base text-ink-soft pressable">Not now</button>
        </> : <button type="button" onClick={onDismiss} className={primary}>OK</button>}
        {failed && <p role="alert" className="text-base text-bad">Couldn't turn them on. Try again.</p>}
      </div>
    </div>, document.body);
}
