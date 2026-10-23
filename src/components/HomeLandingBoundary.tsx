import React from 'react';

/**
 * Around the lazily loaded home page: if its file cannot load (offline, or a
 * very old tab after a deploy once the reload-once guard in lib/chunkReload.ts
 * has been used), show a plain screen with "Sign in" and "Try again" instead
 * of a blank page.
 */
interface Props {
  onSignIn: () => void;
  children: React.ReactNode;
}

export class HomeLandingBoundary extends React.Component<Props, { failed: boolean }> {
  declare readonly props: Readonly<Props>;
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('Home page failed to load', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-home-failed className="min-h-screen bg-paper text-ink flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-ink-soft">The home page could not load.</p>
        <button
          type="button"
          onClick={this.props.onSignIn}
          className="px-6 py-3 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white font-bold text-sm tactile-2 cursor-pointer"
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-xs font-semibold text-ink-faint hover:text-ink cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }
}
