import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { registerSW } from 'virtual:pwa-register';
import { initSwUpdates, onNewVersionActivated } from './lib/swUpdate';
import { installChunkReload } from './lib/chunkReload';
import App from './App.tsx';
import { UpdateBanner } from './components/UpdateBanner';
import { DesktopModeNote } from './components/DesktopModeNote';
import { startDesktopModeFix } from './lib/desktopMode';
import './index.css';
// The sign-in screen's look (dark home-page background; scoped to .shf-signin, small).
import './components/signin-look.css';

// Register the PWA service worker. When a new version takes over and when the
// page reloads is decided in one place, lib/swUpdate.ts: never on its own,
// only from a tap on the "Tap to update" bar (UpdateBanner) or the "Update
// app" button. Every update reload goes through its loop guard.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    initSwUpdates(registration);
  },
  onNeedReload() {
    // A new version became active (here or in another tab).
    onNewVersionActivated();
  },
});

// A tab still on an old version reloads once if a lazy-loaded file is gone (see chunkReload.ts).
installChunkReload();

// A phone with the browser's "Desktop site" setting on: draw at phone size again
// before the first paint (see lib/desktopMode.ts). Needs the CSS above to be loaded.
startDesktopModeFix();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <DesktopModeNote />
      <App />
      <UpdateBanner />
    </MotionConfig>
  </StrictMode>,
);

